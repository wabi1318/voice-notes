import AVFoundation
import CoreMedia
import Foundation
import Speech

func check(_ condition: Bool, _ message: String = "check failed", line: Int = #line) {
    if !condition {
        FileHandle.standardError.write(Data("line \(line): \(message)\n".utf8))
        exit(1)
    }
}

@MainActor
func checkLongDelayedInput() async throws {
    let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: false)!
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 320)!
    buffer.frameLength = 320
    for index in 0..<320 { buffer.int16ChannelData![0][index] = 0 }
    let queue = AudioInputQueue(sampleRate: 16_000, source: .system)
    var iterator = queue.stream.makeAsyncIterator()
    let packetsPerMinute = 3000
    let minutes = 90
    for minute in 0..<minutes {
        for packet in 0..<packetsPerMinute {
            let sequence = minute * packetsPerMinute + packet
            buffer.int16ChannelData![0][0] = Int16(sequence % 30_000)
            try queue.append(ConvertedAudio(buffer: buffer, startTime: CMTime(value: Int64(sequence), timescale: 50)))
        }
        check(abs(queue.status.queuedSeconds - 60) < 0.001)
        check(queue.status.memorySeconds <= 30 && queue.status.diskSeconds > 0)
        for packet in 0..<packetsPerMinute {
            let sequence = minute * packetsPerMinute + packet
            guard let input = try await iterator.next() else { check(false, "Long recording ended early"); return }
            check(abs(input.bufferStartTime!.seconds - Double(sequence) / 50) < 0.0001)
            let copied = input.buffer
            withExtendedLifetime(copied) {
                check(copied.int16ChannelData![0][0] == Int16(sequence % 30_000), "Long recording lost or reordered audio")
            }
        }
        check(queue.status.queuedSeconds == 0 && queue.status.diskSeconds == 0)
    }
    queue.finish()
    check(try await iterator.next() == nil)
    check(queue.status.consumedFrames == minutes * 60 * 16_000)
    print("90 minutes of 20ms input with repeated 60-second consumer delays: all samples and timestamps retained")
}

@main
struct CaptureCoreChecks {
    @MainActor static func main() async throws {
        check(CaptureSettings(arguments: ["--locale", "ja-JP"])?.localeIdentifier == "ja-JP")
        check(CaptureSettings(arguments: ["--locale", "en-US"])?.localeIdentifier == "en-US")
        for arguments in [[], ["--locale"], ["--locale", "invalid"], ["--locale", "ja-JP", "extra"],
                          ["--locale", "ja-JP", "--unknown", "off"]] {
            check(CaptureSettings(arguments: arguments) == nil, "Invalid recording settings were accepted")
        }
        let range = CMTimeRange(start: CMTime(seconds: 2.5, preferredTimescale: 1000), duration: CMTime(seconds: 1.25, preferredTimescale: 1000))
        check(formatCaption(text: "Hello.\n<test>", range: range, source: .system) == "00:00:02.500 --> 00:00:03.750\n<v System>Hello. ＜test＞\n\n")
        check(formatCaption(text: " ", range: range, source: .microphone) == nil)
        check(formatTimestamp(3661.9996) == "01:01:02.000")
        let source = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 2)!
        let target = AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1)!
        let converter = AudioInputConverter(target: target, origin: 100, channel: .microphone)
        let buffer = AVAudioPCMBuffer(pcmFormat: source, frameCapacity: 4800)!
        buffer.frameLength = 4800
        for sample in 0..<4800 {
            buffer.floatChannelData![0][sample] = 0.1
            buffer.floatChannelData![1][sample] = 0.9
        }
        var inputs: [ConvertedAudio] = []
        for index in 0..<10 {
            if let input = try converter.convert(buffer, hostSeconds: 102 + Double(index) / 10) { inputs.append(input) }
        }
        inputs += try converter.flush()
        let frameCount = inputs.reduce(0) { $0 + Int($1.buffer.frameLength) }
        check(abs(frameCount - 16_000) < 64, "Conversion lost audio frames: \(frameCount)")
        check(abs(inputs[0].startTime.seconds - 2) < 0.001)
        var sum = 0.0
        var count = 0
        for input in inputs {
            check(input.buffer.format.channelCount == 1)
            for index in 0..<Int(input.buffer.frameLength) {
                sum += Double(input.buffer.floatChannelData![0][index])
                count += 1
            }
        }
        check(abs(sum / Double(count) - 0.1) < 0.01, "Microphone channels were mixed")
        for pair in zip(inputs, inputs.dropFirst()) {
            let expected = pair.0.startTime.seconds + Double(pair.0.buffer.frameLength) / target.sampleRate
            check(pair.1.startTime.seconds >= expected - 0.0001)
        }
        let int16 = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: false)!
        check(abs((measureAudioPeak(buffer) ?? 0) - 0.9) < 0.0001, "Missed second channel's volume")
        for interleaved in [false, true] {
            let stereo = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 2, interleaved: interleaved)!
            let measured = AVAudioPCMBuffer(pcmFormat: stereo, frameCapacity: 2)!
            check(measureAudioPeak(measured) == nil, "Empty buffer reported a volume")
            measured.frameLength = 2
            for channel in 0..<2 {
                for frame in 0..<2 {
                    measured.floatChannelData![interleaved ? 0 : channel][frame * measured.stride + (interleaved ? channel : 0)] = channel == 0 ? 0 : -0.5
                }
            }
            check(measureAudioPeak(measured) == 0.5, "Interleaved volume measurement failed")
        }
        let speechBuffer = AVAudioPCMBuffer(pcmFormat: int16, frameCapacity: 160)!
        speechBuffer.frameLength = 160
        for index in 0..<160 { speechBuffer.int16ChannelData![0][index] = 0 }
        check(measureAudioPeak(speechBuffer) == 0, "Silence reported a nonzero volume")
        speechBuffer.int16ChannelData![0][0] = .min
        check(measureAudioPeak(speechBuffer) == 1, "Int16 volume was not normalized")
        speechBuffer.int16ChannelData![0][0] = 0
        let speechInput = AnalyzerInput(buffer: speechBuffer, bufferStartTime: .zero)
        check(speechInput.bufferStartTime == .zero)
        let queue = AudioInputQueue(sampleRate: 16_000, source: .system)
        // 旧上限では2.57秒で停止する細かい入力を、6秒分まとめて待たせる。
        for index in 0..<600 {
            try queue.append(ConvertedAudio(buffer: speechBuffer, startTime: CMTime(value: Int64(index), timescale: 100)))
        }
        queue.finish()
        var received = 0
        for try await item in queue.stream {
            check(abs(item.bufferStartTime!.seconds - Double(received) / 100) < 0.0001, "Audio reordered or lost")
            received += 1
        }
        check(received == 600, "Last queued audio was lost")

        let delayed = AudioInputQueue(sampleRate: 16_000, source: .system)
        // 認識側が35秒分の入力を待たせても、録音を止めず原文の順序・音声を保つ。
        for index in 0..<3500 {
            speechBuffer.int16ChannelData![0][0] = Int16(index)
            try delayed.append(ConvertedAudio(buffer: speechBuffer, startTime: CMTime(value: Int64(index), timescale: 100)))
        }
        check(abs(delayed.status.queuedSeconds - 35) < 0.001)
        check(abs(delayed.status.memorySeconds - 30) < 0.001, "Pending audio exceeded its memory budget")
        check(abs(delayed.status.diskSeconds - 5) < 0.001, "Overflow audio was not retained")
        delayed.finish()
        var delayedCount = 0
        for try await input in delayed.stream {
            check(abs(input.bufferStartTime!.seconds - Double(delayedCount) / 100) < 0.0001, "Delayed audio lost its time")
            let copiedAudio = input.buffer
            withExtendedLifetime(copiedAudio) {
                check(copiedAudio.int16ChannelData![0][0] == Int16(delayedCount), "Delayed audio was lost or changed")
            }
            delayedCount += 1
        }
        check(delayedCount == 3500, "Delayed audio tail was lost")
        check(delayed.status.queuedSeconds == 0 && delayed.status.diskSeconds == 0 && delayed.status.memorySeconds == 0)
        check(delayed.status.consumedFrames == 560_000)

        // 認識用の音声を、末尾の短い断片や確保容量より小さい断片も含めて復元する。
        for frameCount in [40, 160, 4096] {
            let format = int16
            let original = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frameCount * 2))!
            original.frameLength = AVAudioFrameCount(frameCount)
            let regions = UnsafeMutableAudioBufferListPointer(original.mutableAudioBufferList)
            var expected: [Data] = []
            for (index, region) in regions.enumerated() {
                let bytes = UnsafeMutableRawBufferPointer(start: region.mData!, count: Int(region.mDataByteSize))
                for offset in bytes.indices { bytes[offset] = UInt8((index + offset) % 127) }
                expected.append(Data(bytes))
            }
            let disk = AudioInputQueue(sampleRate: 16_000, source: .system, maximumSeconds: 0)
            try disk.append(ConvertedAudio(buffer: original, startTime: CMTime(value: 17, timescale: 1)))
            disk.finish()
            var restoredCount = 0
            for try await input in disk.stream {
                let restored = input.buffer
                check(restored.frameLength == AVAudioFrameCount(frameCount) && restored.format == format)
                check(input.bufferStartTime!.seconds == 17)
                for (index, region) in UnsafeMutableAudioBufferListPointer(restored.mutableAudioBufferList).enumerated() {
                    check(Data(bytes: region.mData!, count: Int(region.mDataByteSize)) == expected[index], "Disk buffering changed audio bytes")
                }
                restoredCount += 1
            }
            check(restoredCount == 1 && disk.status.diskSeconds == 0)
        }

        // 退避中にメモリが空いても、後続の音声が先に認識へ渡らないことを確認する。
        let mixed = AudioInputQueue(sampleRate: 16_000, source: .system, maximumSeconds: 0.01)
        for index in 0..<3 {
            speechBuffer.int16ChannelData![0][0] = Int16(index)
            try mixed.append(ConvertedAudio(buffer: speechBuffer, startTime: CMTime(value: Int64(index), timescale: 100)))
        }
        var mixedIterator = mixed.stream.makeAsyncIterator()
        let firstAudio = try await mixedIterator.next()!.buffer
        withExtendedLifetime(firstAudio) { check(firstAudio.int16ChannelData![0][0] == 0) }
        speechBuffer.int16ChannelData![0][0] = 3
        try mixed.append(ConvertedAudio(buffer: speechBuffer, startTime: CMTime(value: 3, timescale: 100)))
        mixed.finish()
        for expected in 1...3 {
            let nextAudio = try await mixedIterator.next()!.buffer
            withExtendedLifetime(nextAudio) { check(nextAudio.int16ChannelData![0][0] == Int16(expected)) }
        }
        check(try await mixedIterator.next() == nil)
        check(mixed.status.queuedSeconds == 0)
        try await checkLongDelayedInput()

        let changing = AudioInputConverter(target: target, origin: 100, channel: .microphone)
        let firstSegment = try changing.convert(buffer, hostSeconds: 102)
        let oldTail = try changing.beginNewSegment()
        let oldFrames = Int(firstSegment?.buffer.frameLength ?? 0) + oldTail.reduce(0) { $0 + Int($1.buffer.frameLength) }
        check(abs(oldFrames - 1600) < 64, "Old device's last samples were lost")
        let newFormat = AVAudioFormat(standardFormatWithSampleRate: 44_100, channels: 1)!
        let newBuffer = AVAudioPCMBuffer(pcmFormat: newFormat, frameCapacity: 4410)!
        newBuffer.frameLength = 4410
        for index in 0..<4410 { newBuffer.floatChannelData![0][index] = 0.2 }
        let newSegment = try changing.convert(newBuffer, hostSeconds: 105)
        check(abs((newSegment?.startTime.seconds ?? 0) - 5) < 0.001, "Device switch reset the recording clock")
        let newTail = try changing.flush()
        let newFrames = Int(newSegment?.buffer.frameLength ?? 0) + newTail.reduce(0) { $0 + Int($1.buffer.frameLength) }
        check(abs(newFrames - 1600) < 64, "New device's samples were lost")

        var attempts = 0
        let resumed = try await retryMicrophoneRestart(shouldStop: { false }, restart: {
            attempts += 1
            if attempts < 3 { throw CaptureFailure(message: "device not ready") }
        }, waitForDevice: {})
        check(resumed && attempts == 3, "Transient device change did not recover")
        attempts = 0
        do {
            _ = try await retryMicrophoneRestart(shouldStop: { false }, restart: {
                attempts += 1
                throw CaptureFailure(message: "device unavailable")
            }, waitForDevice: {})
            check(false, "Persistent device failure was hidden")
        } catch { check(attempts == 3 && error.localizedDescription == "device unavailable") }
        attempts = 0
        let alreadyStopped = try await retryMicrophoneRestart(shouldStop: { true }, restart: { attempts += 1 }, waitForDevice: {})
        check(!alreadyStopped && attempts == 0, "Restarted after stop")
        var stopping = false
        let stoppedDuringWait = try await retryMicrophoneRestart(shouldStop: { stopping }, restart: { attempts += 1 }, waitForDevice: { stopping = true })
        check(!stoppedDuringWait && attempts == 0, "Stop during recovery was ignored")
        print("caption, audio conversion, queue duration, device-change timing and restart lifecycle checks passed")
    }
}
