import AVFoundation
import AudioToolbox
import CoreAudio
import CoreMedia
import Darwin
import Foundation
import Speech

struct CaptureSettings {
    let localeIdentifier: String

    init?(arguments: [String]) {
        guard arguments.count == 2,
              arguments[0] == "--locale", ["ja-JP", "en-US"].contains(arguments[1]) else { return nil }
        localeIdentifier = arguments[1]
    }
}

struct CaptureDeviceStatus: Encodable, Sendable {
    let id: AudioDeviceID
    let status: OSStatus

    static func current(_ node: AVAudioIONode) -> Self {
        var device = AudioDeviceID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        guard let unit = node.audioUnit else { return Self(id: device, status: kAudio_ParamError) }
        let status = AudioUnitGetProperty(unit, kAudioOutputUnitProperty_CurrentDevice,
                                         kAudioUnitScope_Global, 0, &device, &size)
        return Self(id: device, status: status)
    }

    static func systemDefault(_ selector: AudioObjectPropertySelector) -> Self {
        var device = AudioDeviceID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal,
                                                mElement: kAudioObjectPropertyElementMain)
        let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device)
        return Self(id: device, status: status)
    }
}

struct CaptureAudioStatus: Encodable, Sendable {
    let running: Bool
    let voiceProcessing: Bool
    let inputDevice: CaptureDeviceStatus
    let defaultInputDevice: CaptureDeviceStatus
    let defaultOutputDevice: CaptureDeviceStatus
    let inputFormat: String
    let microphoneFormat: String

    init(engine: AVAudioEngine) {
        running = engine.isRunning
        voiceProcessing = engine.inputNode.isVoiceProcessingEnabled
        inputDevice = .current(engine.inputNode)
        // 出力側への参照は新しい機構を作るため、入力専用の録音の診断では触らない。
        defaultInputDevice = .systemDefault(kAudioHardwarePropertyDefaultInputDevice)
        defaultOutputDevice = .systemDefault(kAudioHardwarePropertyDefaultOutputDevice)
        inputFormat = engine.inputNode.inputFormat(forBus: 0).description
        microphoneFormat = engine.inputNode.outputFormat(forBus: 0).description
    }
}

struct CaptureDiagnostic: Encodable {
    let event: String
    let timestamp = ISO8601DateFormatter().string(from: Date())
    let pid = ProcessInfo.processInfo.processIdentifier
    let before: CaptureAudioStatus?
    let after: CaptureAudioStatus

    func write() {
        do {
            let data = try JSONEncoder().encode(self)
            // 字幕の出力先へ混ぜず、既存の診断ログへ一行で追記する。
            try FileHandle.standardError.write(contentsOf: Data("[capture-diagnostic] ".utf8) + data + Data("\n".utf8))
        } catch {
            FileHandle.standardError.write(Data("[capture-diagnostic] 診断ログを書き込めませんでした\n".utf8))
        }
    }
}

struct CaptureFailure: Error, LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

@MainActor
func retryMicrophoneRestart(
    shouldStop: () -> Bool,
    restart: () throws -> Void,
    waitForDevice: () async throws -> Void = { try await Task.sleep(for: .milliseconds(500)) }
) async throws -> Bool {
    let maximumAttempts = 3
    for attempt in 1...maximumAttempts {
        if shouldStop() || Task.isCancelled { return false }
        try await waitForDevice()
        if shouldStop() || Task.isCancelled { return false }
        do {
            try restart()
            return true
        } catch {
            if attempt == maximumAttempts { throw error }
        }
    }
    return false
}

enum AudioSource: String, Sendable {
    case microphone = "Mic"
    case system = "System"
}

func formatTimestamp(_ seconds: Double) -> String {
    let milliseconds = Int64((max(0, seconds) * 1_000).rounded())
    return String(format: "%02lld:%02lld:%02lld.%03lld", milliseconds / 3_600_000,
                  milliseconds / 60_000 % 60, milliseconds / 1_000 % 60, milliseconds % 1_000)
}

func formatCaption(text: String, range: CMTimeRange, source: AudioSource) -> String? {
    let start = range.start.seconds
    let end = range.end.seconds
    let cleanText = text.components(separatedBy: .newlines).joined(separator: " ")
        .replacingOccurrences(of: "<", with: "＜").replacingOccurrences(of: ">", with: "＞")
        .trimmingCharacters(in: .whitespacesAndNewlines)
    guard start.isFinite, end.isFinite, end >= start, !cleanText.isEmpty else { return nil }
    return "\(formatTimestamp(start)) --> \(formatTimestamp(end))\n<v \(source.rawValue)>\(cleanText)\n\n"
}

actor CaptionWriter {
    private var ready = false
    private var pending: [String] = []

    func begin() throws {
        try FileHandle.standardOutput.write(contentsOf: Data("WEBVTT\n\n".utf8))
        ready = true
        for caption in pending { try FileHandle.standardOutput.write(contentsOf: Data(caption.utf8)) }
        pending.removeAll()
    }

    func write(text: String, range: CMTimeRange, source: AudioSource) throws {
        guard let caption = formatCaption(text: text, range: range, source: source) else { return }
        if ready { try FileHandle.standardOutput.write(contentsOf: Data(caption.utf8)) }
        else { pending.append(caption) }
    }
}

// 音声取得の各経路をそれぞれ直列に呼び出し、変換器の状態と入力順序を保つ。
struct ConvertedAudio {
    let buffer: AVAudioPCMBuffer
    let startTime: CMTime
}

struct StoredAudioInput: @unchecked Sendable {
    let format: AVAudioFormat
    let frameCount: AVAudioFrameCount
    let startTime: CMTime
    let offset: UInt64
    let byteCounts: [Int]
}

enum QueuedAudioInput: Sendable {
    case memory(AnalyzerInput, frames: Int)
    case file(StoredAudioInput)

    var frameCount: Int {
        switch self {
        case .memory(_, let frames): return frames
        case .file(let stored): return Int(stored.frameCount)
        }
    }
}

struct AudioQueueStatus: Encodable {
    let queuedSeconds: Double
    let memorySeconds: Double
    let diskSeconds: Double
    let peakQueuedSeconds: Double
    let consumedFrames: Int
    let secondsSinceLastConsumption: Double?
    let maximumConsumerLockWaitMilliseconds: Double
}

final class AudioInputQueue: @unchecked Sendable {
    private let pending: AsyncStream<QueuedAudioInput>
    private let continuation: AsyncStream<QueuedAudioInput>.Continuation
    private let lock = NSLock()
    private let maximumFrames: Int
    private let source: AudioSource
    private let sampleRate: Double
    private var queuedFrames = 0
    private var memoryFrames = 0
    private var peakQueuedFrames = 0
    private var consumedFrames = 0
    private var lastConsumptionTime: UInt64?
    private var maximumConsumerLockWaitMilliseconds = 0.0
    private var storedInputCount = 0
    private var audioFile: FileHandle?
    private var writeOffset: UInt64 = 0

    init(sampleRate: Double, source: AudioSource, maximumSeconds: Double = 30) {
        self.source = source
        self.sampleRate = sampleRate
        maximumFrames = Int(sampleRate * maximumSeconds)
        (pending, continuation) = AsyncStream.makeStream(of: QueuedAudioInput.self)
    }

    var stream: AsyncThrowingMapSequence<AsyncStream<QueuedAudioInput>, AnalyzerInput> {
        pending.map { queued in try self.consume(queued) }
    }

    func append(_ audio: ConvertedAudio) throws {
        let frames = Int(audio.buffer.frameLength)
        guard frames > 0 else { return }
        lock.lock()
        defer { lock.unlock() }
        let queued: QueuedAudioInput
        if memoryFrames + frames <= maximumFrames {
            queued = .memory(AnalyzerInput(buffer: audio.buffer, bufferStartTime: audio.startTime), frames: frames)
            memoryFrames += frames
        } else {
            // 認識の一時的な遅れで録音を止めず、メモリ上限を超えた音声も順番に渡す。
            queued = .file(try store(audio))
            storedInputCount += 1
        }
        queuedFrames += frames
        peakQueuedFrames = max(peakQueuedFrames, queuedFrames)
        if case .terminated = continuation.yield(queued) { release(queued) }
    }

    var status: AudioQueueStatus {
        lock.withLock {
            let now = DispatchTime.now().uptimeNanoseconds
            return AudioQueueStatus(queuedSeconds: Double(queuedFrames) / sampleRate,
                memorySeconds: Double(memoryFrames) / sampleRate,
                diskSeconds: Double(queuedFrames - memoryFrames) / sampleRate,
                peakQueuedSeconds: Double(peakQueuedFrames) / sampleRate, consumedFrames: consumedFrames,
                secondsSinceLastConsumption: lastConsumptionTime.map { Double(now - $0) / 1_000_000_000 },
                maximumConsumerLockWaitMilliseconds: maximumConsumerLockWaitMilliseconds)
        }
    }

    private func store(_ audio: ConvertedAudio) throws -> StoredAudioInput {
        if audioFile == nil {
            var path = Array(FileManager.default.temporaryDirectory.appendingPathComponent("voice-note-pending-XXXXXX").path.utf8CString)
            let descriptor = mkstemp(&path)
            guard descriptor >= 0 else {
                let label = source == .microphone ? "マイク" : "再生音"
                throw CaptureFailure(message: "\(label)の待機音声の一時領域を作成できません")
            }
            // 作成時の権限は600。名前を直ちに外し、異常終了しても音声ファイルを残さない。
            guard unlink(path) == 0 else {
                close(descriptor)
                throw CaptureFailure(message: "待機音声の一時領域を保護できません")
            }
            audioFile = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        }
        guard let audioFile else { throw CaptureFailure(message: "待機音声の一時領域がありません") }
        try audioFile.seek(toOffset: writeOffset)
        let offset = writeOffset
        var byteCounts: [Int] = []
        for buffer in UnsafeMutableAudioBufferListPointer(audio.buffer.mutableAudioBufferList) {
            guard let data = buffer.mData else { throw CaptureFailure(message: "待機音声を読み取れません") }
            let count = Int(buffer.mDataByteSize)
            try audioFile.write(contentsOf: Data(bytes: data, count: count))
            byteCounts.append(count)
            writeOffset += UInt64(count)
        }
        return StoredAudioInput(format: audio.buffer.format, frameCount: audio.buffer.frameLength,
            startTime: audio.startTime, offset: offset, byteCounts: byteCounts)
    }

    private func consume(_ queued: QueuedAudioInput) throws -> AnalyzerInput {
        let waitingSince = DispatchTime.now().uptimeNanoseconds
        lock.lock()
        defer { lock.unlock() }
        maximumConsumerLockWaitMilliseconds = max(maximumConsumerLockWaitMilliseconds,
            Double(DispatchTime.now().uptimeNanoseconds - waitingSince) / 1_000_000)
        let input: AnalyzerInput
        switch queued {
        case .memory(let audio, _): input = audio
        case .file(let stored):
            guard let audioFile,
                  let buffer = AVAudioPCMBuffer(pcmFormat: stored.format, frameCapacity: stored.frameCount) else {
                throw CaptureFailure(message: "待機音声を復元できません")
            }
            buffer.frameLength = stored.frameCount
            let buffers = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
            guard buffers.count == stored.byteCounts.count else { throw CaptureFailure(message: "待機音声の形式が一致しません") }
            try audioFile.seek(toOffset: stored.offset)
            for (index, destination) in buffers.enumerated() {
                let count = stored.byteCounts[index]
                guard let pointer = destination.mData, count == Int(destination.mDataByteSize),
                      let data = try audioFile.read(upToCount: count), data.count == count else {
                    throw CaptureFailure(message: "待機音声が不完全です")
                }
                data.copyBytes(to: UnsafeMutableRawBufferPointer(start: pointer, count: count))
            }
            input = AnalyzerInput(buffer: buffer, bufferStartTime: stored.startTime)
        }
        consumedFrames += queued.frameCount
        lastConsumptionTime = DispatchTime.now().uptimeNanoseconds
        release(queued)
        return input
    }

    private func release(_ queued: QueuedAudioInput) {
        queuedFrames -= queued.frameCount
        switch queued {
        case .memory(_, let frames): memoryFrames -= frames
        case .file: storedInputCount -= 1
        }
        if storedInputCount == 0 {
            try? audioFile?.close()
            audioFile = nil
            writeOffset = 0
        }
    }

    func finish() { continuation.finish() }

    deinit { try? audioFile?.close() }
}

final class AudioInputConverter {
    private let target: AVAudioFormat
    private var origin: Double
    private let channel: AudioSource
    private var converter: AVAudioConverter?
    private var nextTime: Double?

    init(target: AVAudioFormat, origin: Double, channel: AudioSource) {
        self.target = target
        self.origin = origin
        self.channel = channel
    }

    func setOrigin(_ seconds: Double) { origin = seconds }

    func beginNewSegment() throws -> [ConvertedAudio] {
        let remaining = try flush()
        if let last = remaining.last {
            nextTime = last.startTime.seconds + Double(last.buffer.frameLength) / target.sampleRate
        }
        converter = nil
        return remaining
    }

    func flush() throws -> [ConvertedAudio] {
        guard let converter, var time = nextTime else { return [] }
        var inputs: [ConvertedAudio] = []
        while true {
            guard let buffer = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: 4096) else {
                throw CaptureFailure(message: "音声変換用のメモリを確保できません")
            }
            var error: NSError?
            let result = converter.convert(to: buffer, error: &error) { _, status in
                status.pointee = .endOfStream
                return nil
            }
            if let error { throw error }
            if result == .error { throw CaptureFailure(message: "最後の音声を変換できません") }
            if buffer.frameLength > 0 {
                inputs.append(ConvertedAudio(buffer: buffer, startTime: CMTime(seconds: time, preferredTimescale: 48_000)))
                time += Double(buffer.frameLength) / target.sampleRate
            }
            if result == .endOfStream || buffer.frameLength == 0 { return inputs }
        }
    }

    func convert(_ buffer: AVAudioPCMBuffer, hostSeconds: Double) throws -> ConvertedAudio? {
        guard buffer.frameLength > 0 else { return nil }
        if converter?.inputFormat != buffer.format {
            guard let replacement = AVAudioConverter(from: buffer.format, to: target) else {
                throw CaptureFailure(message: "\(channel.rawValue)の音声形式を変換できません")
            }
            // 処理済みマイクの複数チャネルを足し合わせて音量を変えない。
            if channel == .microphone && target.channelCount == 1 { replacement.channelMap = [0] }
            converter = replacement
        }
        guard let converter else { return nil }
        let capacity = AVAudioFrameCount(ceil(Double(buffer.frameLength) * target.sampleRate / buffer.format.sampleRate)) + 32
        guard let converted = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else {
            throw CaptureFailure(message: "音声変換用のメモリを確保できません")
        }
        var error: NSError?
        var consumed = false
        let result = converter.convert(to: converted, error: &error) { _, status in
            if consumed { status.pointee = .noDataNow; return nil }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        if let error { throw error }
        guard result != .error else { throw CaptureFailure(message: "音声の変換に失敗しました") }
        guard converted.frameLength > 0 else { return nil }
        let capturedTime = max(0, hostSeconds - origin)
        // 両音源の基準をそろえ、処理の到着順による時刻のずれを避ける。
        let start = max(nextTime ?? capturedTime, capturedTime)
        nextTime = start + Double(converted.frameLength) / target.sampleRate
        return ConvertedAudio(buffer: converted, startTime: CMTime(seconds: start, preferredTimescale: 48_000))
    }
}

struct AudioStageTiming: Encodable {
    var totalMilliseconds = 0.0
    var maximumMilliseconds = 0.0

    mutating func record(since start: UInt64) {
        let elapsed = Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
        totalMilliseconds += elapsed
        maximumMilliseconds = max(maximumMilliseconds, elapsed)
    }
}

struct SpeechProcessingTiming: Encodable {
    var inputLock = AudioStageTiming()
    var peakMeasurement = AudioStageTiming()
    var conversion = AudioStageTiming()
    var enqueue = AudioStageTiming()
    var captionWrite = AudioStageTiming()
    var maximumCaptureLagSeconds = 0.0
    var maximumSourceGapSeconds = 0.0
}

@available(macOS 26.0, *)
final class SpeechInput: @unchecked Sendable {
    let source: AudioSource
    let transcriber: SpeechTranscriber
    let analyzer: SpeechAnalyzer
    private let inputQueue: AudioInputQueue
    var stream: AsyncThrowingMapSequence<AsyncStream<QueuedAudioInput>, AnalyzerInput> { inputQueue.stream }
    private let lock = NSLock()
    private let converter: AudioInputConverter
    private let reportFailure: @Sendable (String) -> Void
    private var ended = false
    private var receivedBuffers = 0
    private var convertedFrames = 0
    private var resultCount = 0
    private var inputPeak: Double?
    private var convertedPeak: Double?
    private var timing = SpeechProcessingTiming()
    private var lastInputEnd: Double?
    private var captionWriteStarted: UInt64?
    private var inputFormat: String?
    private var lastInputFormat: AVAudioFormat?

    init(source: AudioSource, transcriber: SpeechTranscriber, format: AVAudioFormat, origin: Double,
         reportFailure: @escaping @Sendable (String) -> Void) {
        self.source = source
        self.transcriber = transcriber
        analyzer = SpeechAnalyzer(modules: [transcriber])
        inputQueue = AudioInputQueue(sampleRate: format.sampleRate, source: source)
        converter = AudioInputConverter(target: format, origin: origin, channel: source)
        self.reportFailure = reportFailure
    }

    func append(_ buffer: AVAudioPCMBuffer, hostSeconds: Double) {
        let waitingSince = DispatchTime.now().uptimeNanoseconds
        lock.lock()
        defer { lock.unlock() }
        guard !ended else { return }
        timing.inputLock.record(since: waitingSince)
        let hostNow = CMClockGetTime(CMClockGetHostTimeClock()).seconds
        timing.maximumCaptureLagSeconds = max(timing.maximumCaptureLagSeconds, hostNow - hostSeconds)
        if let lastInputEnd { timing.maximumSourceGapSeconds = max(timing.maximumSourceGapSeconds, hostSeconds - lastInputEnd) }
        lastInputEnd = hostSeconds + Double(buffer.frameLength) / buffer.format.sampleRate
        if lastInputFormat != buffer.format {
            lastInputFormat = buffer.format
            inputFormat = "\(buffer.format.sampleRate) Hz, \(buffer.format.channelCount) ch, PCM \(buffer.format.commonFormat.rawValue)"
        }
        receivedBuffers += 1
        var started = DispatchTime.now().uptimeNanoseconds
        if let peak = measureAudioPeak(buffer) { inputPeak = max(inputPeak ?? 0, peak) }
        timing.peakMeasurement.record(since: started)
        do {
            started = DispatchTime.now().uptimeNanoseconds
            let input = try converter.convert(buffer, hostSeconds: hostSeconds)
            timing.conversion.record(since: started)
            if let input {
                convertedFrames += Int(input.buffer.frameLength)
                started = DispatchTime.now().uptimeNanoseconds
                if let peak = measureAudioPeak(input.buffer) { convertedPeak = max(convertedPeak ?? 0, peak) }
                timing.peakMeasurement.record(since: started)
                started = DispatchTime.now().uptimeNanoseconds
                try inputQueue.append(input)
                timing.enqueue.record(since: started)
            }
        } catch {
            ended = true
            inputQueue.finish()
            reportFailure(error.localizedDescription)
        }
    }

    func recordResult() {
        lock.withLock {
            resultCount += 1
            captionWriteStarted = DispatchTime.now().uptimeNanoseconds
        }
    }

    func recordCaptionWritten() {
        lock.withLock {
            if let captionWriteStarted { timing.captionWrite.record(since: captionWriteStarted) }
            captionWriteStarted = nil
        }
    }

    func writeDiagnostic() {
        let snapshot = lock.withLock {
            let captionWait = captionWriteStarted.map { Double(DispatchTime.now().uptimeNanoseconds - $0) / 1_000_000_000 }
            let snapshot = SpeechInputDiagnostic(source: source.rawValue, receivedBuffers: receivedBuffers,
                convertedFrames: convertedFrames, inputPeak: inputPeak, convertedPeak: convertedPeak, resultCount: resultCount,
                queue: inputQueue.status, inputFormat: inputFormat, timing: timing, pendingCaptionWriteSeconds: captionWait)
            inputPeak = nil
            convertedPeak = nil
            timing = SpeechProcessingTiming()
            return snapshot
        }
        if let data = try? JSONEncoder().encode(snapshot) {
            try? FileHandle.standardError.write(contentsOf: Data("[capture-diagnostic] ".utf8) + data + Data("\n".utf8))
        }
    }

    func setOrigin(_ seconds: Double) {
        lock.lock()
        defer { lock.unlock() }
        converter.setOrigin(seconds)
    }

    func beginNewSegment() throws {
        lock.lock()
        defer { lock.unlock() }
        guard !ended else { throw CaptureFailure(message: "マイクの音声認識は停止済みです") }
        for input in try converter.beginNewSegment() { try inputQueue.append(input) }
    }

    func finishInput() {
        lock.lock()
        defer { lock.unlock() }
        guard !ended else { return }
        do {
            for input in try converter.flush() {
                try inputQueue.append(input)
            }
        } catch { reportFailure(error.localizedDescription) }
        ended = true
        inputQueue.finish()
    }
}

private struct SpeechInputDiagnostic: Encodable {
    let event = "speech_input"
    let timestamp = ISO8601DateFormatter().string(from: Date())
    let pid = ProcessInfo.processInfo.processIdentifier
    let source: String
    let receivedBuffers: Int
    let convertedFrames: Int
    let inputPeak: Double?
    let convertedPeak: Double?
    let resultCount: Int
    let queue: AudioQueueStatus
    let inputFormat: String?
    let timing: SpeechProcessingTiming
    let pendingCaptionWriteSeconds: Double?
}

// 内容は保存せず、無音の入力と認識結果待ちを区別するための音量だけを求める。
func measureAudioPeak(_ buffer: AVAudioPCMBuffer) -> Double? {
    guard buffer.frameLength > 0 else { return nil }
    var peak = 0.0
    for channel in 0..<Int(buffer.format.channelCount) {
        for frame in 0..<Int(buffer.frameLength) {
            let channelIndex = buffer.format.isInterleaved ? 0 : channel
            let index = frame * buffer.stride + (buffer.format.isInterleaved ? channel : 0)
            let value: Double
            if let samples = buffer.floatChannelData { value = Double(samples[channelIndex][index]) }
            else if let samples = buffer.int16ChannelData { value = Double(samples[channelIndex][index]) / 32768 }
            else { return nil }
            if value.isFinite { peak = max(peak, abs(value)) }
        }
    }
    return peak
}
