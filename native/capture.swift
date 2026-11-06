import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit
import Speech

enum CaptureStop: Sendable {
    case requested
    case failed(String)
}

final class StopEvents: @unchecked Sendable {
    let stream: AsyncStream<CaptureStop>
    private let continuation: AsyncStream<CaptureStop>.Continuation
    private let lock = NSLock()
    private var stopped = false
    private var failure: String?

    init() {
        (stream, continuation) = AsyncStream.makeStream(of: CaptureStop.self, bufferingPolicy: .bufferingOldest(1))
    }

    var isStopped: Bool {
        lock.lock()
        defer { lock.unlock() }
        return stopped
    }

    var errorMessage: String? {
        lock.lock()
        defer { lock.unlock() }
        return failure
    }

    func stop(_ reason: CaptureStop) {
        lock.lock()
        defer { lock.unlock() }
        if case .failed(let message) = reason, failure == nil { failure = message }
        guard !stopped else { return }
        stopped = true
        continuation.yield(reason)
        continuation.finish()
    }
}

final class SystemAudioReceiver: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let input: SpeechInput
    let events: StopEvents

    init(input: SpeechInput, events: StopEvents) {
        self.input = input
        self.events = events
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        events.stop(.failed("Macの再生音の取得が停止しました: \(error.localizedDescription)"))
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.isValid, sampleBuffer.numSamples > 0,
              let description = sampleBuffer.formatDescription,
              var streamDescription = description.audioStreamBasicDescription,
              let format = AVAudioFormat(streamDescription: &streamDescription) else { return }
        do {
            try sampleBuffer.withAudioBufferList { list, _ in
                guard let buffer = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: list.unsafePointer) else {
                    throw CaptureFailure(message: "Macの再生音を読み取れません")
                }
                let presentationTime = sampleBuffer.presentationTimeStamp.seconds
                guard presentationTime.isFinite else { throw CaptureFailure(message: "再生音の時刻を取得できません") }
                input.append(buffer, hostSeconds: presentationTime)
            }
        } catch { events.stop(.failed(error.localizedDescription)) }
    }
}

@MainActor
final class LiveAudioCapture {
    let events: StopEvents
    let writer = CaptionWriter()
    private var engine = AVAudioEngine()
    private var microphone: SpeechInput?
    private var system: SpeechInput?
    private var receiver: SystemAudioReceiver?
    private var systemStream: SCStream?
    private var resultTasks: [Task<Void, Error>] = []
    private var diagnosticTask: Task<Void, Never>?
    private var tapInstalled = false
    private var routeObserver: NSObjectProtocol?
    private var recoveryTask: Task<Void, Never>?
    private var pendingRecovery: (engineID: ObjectIdentifier, status: CaptureAudioStatus)?
    private var ending = false

    init(events: StopEvents) { self.events = events }

    func run(locale: Locale) async throws {
        do {
            try await prepare(locale: locale)
            if !events.isStopped {
                try await startAudio()
            }
            var iterator = events.stream.makeAsyncIterator()
            let reason = await iterator.next() ?? .requested
            try await finishAudio()
            if case .failed(let message) = reason { throw CaptureFailure(message: message) }
            if let message = events.errorMessage { throw CaptureFailure(message: message) }
        } catch {
            await cancelAudio()
            throw error
        }
    }

    private func prepare(locale: Locale) async throws {
        guard SpeechTranscriber.isAvailable,
              let supportedLocale = await SpeechTranscriber.supportedLocale(equivalentTo: locale) else {
            throw CaptureFailure(message: "このMacで\(locale.identifier)の音声認識を利用できません")
        }
        if events.isStopped { return }
        let micTranscriber = SpeechTranscriber(locale: supportedLocale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [.audioTimeRange])
        let sysTranscriber = SpeechTranscriber(locale: supportedLocale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [.audioTimeRange])
        try await AssetInventory.reserve(locale: supportedLocale)
        if let installation = try await AssetInventory.assetInstallationRequest(supporting: [micTranscriber, sysTranscriber]) {
            FileHandle.standardError.write(Data("Appleの音声認識データを準備しています。\n".utf8))
            try await installation.downloadAndInstall()
        }
        if events.isStopped { return }
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [micTranscriber, sysTranscriber]) else {
            throw CaptureFailure(message: "音声認識に対応する入力形式がありません")
        }
        let origin = CMClockGetTime(CMClockGetHostTimeClock()).seconds
        let events = self.events
        let fail: @Sendable (String) -> Void = { events.stop(.failed($0)) }
        microphone = SpeechInput(source: .microphone, transcriber: micTranscriber, format: format, origin: origin, reportFailure: fail)
        system = SpeechInput(source: .system, transcriber: sysTranscriber, format: format, origin: origin, reportFailure: fail)
        for input in [microphone, system].compactMap({ $0 }) {
            try await input.analyzer.start(inputSequence: input.stream)
            let writer = self.writer
            resultTasks.append(Task {
                do {
                    for try await result in input.transcriber.results {
                        input.recordResult()
                        try await writer.write(text: String(result.text.characters), range: result.range, source: input.source)
                        input.recordCaptionWritten()
                    }
                } catch {
                    events.stop(.failed("音声認識が停止しました: \(error.localizedDescription)"))
                    throw error
                }
            })
        }
    }

    private func startAudio() async throws {
        guard let microphone, let system else { return }
        let permission = AVCaptureDevice.authorizationStatus(for: .audio)
        var microphoneAllowed = permission == .authorized
        if permission == .notDetermined { microphoneAllowed = await AVCaptureDevice.requestAccess(for: .audio) }
        guard microphoneAllowed else {
            throw CaptureFailure(message: "システム設定の「プライバシーとセキュリティ → マイク」でターミナルを許可してください")
        }
        if events.isStopped { return }
        let content: SCShareableContent
        do { content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true) }
        catch { throw CaptureFailure(message: "Macの再生音を取得できません。「プライバシーとセキュリティ → 画面とシステムオーディオの収録」でターミナルを許可してください: \(error.localizedDescription)") }
        guard let display = content.displays.first else { throw CaptureFailure(message: "再生音を取得する画面がありません") }
        if events.isStopped { return }
        try configureMicrophone(microphone)

        let configuration = SCStreamConfiguration()
        configuration.capturesAudio = true
        configuration.excludesCurrentProcessAudio = true
        configuration.sampleRate = 48_000
        configuration.channelCount = 2
        configuration.width = 2
        configuration.height = 2
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        let audioReceiver = SystemAudioReceiver(input: system, events: events)
        receiver = audioReceiver
        let stream = SCStream(filter: SCContentFilter(display: display, excludingWindows: []), configuration: configuration, delegate: audioReceiver)
        systemStream = stream
        try stream.addStreamOutput(audioReceiver, type: .audio, sampleHandlerQueue: DispatchQueue(label: "voice-notes.system-audio"))
        let origin = CMClockGetTime(CMClockGetHostTimeClock()).seconds
        microphone.setOrigin(origin)
        system.setOrigin(origin)
        try await stream.startCapture()
        if events.isStopped { return }
        try engine.start()
        let initialAudioStatus = CaptureAudioStatus(engine: engine)
        CaptureDiagnostic(event: "recording_started", before: nil, after: initialAudioStatus).write()
        observeAudioConfiguration(initialStatus: initialAudioStatus)
        try await writer.begin()
        diagnosticTask = Task {
            while !Task.isCancelled {
                microphone.writeDiagnostic()
                system.writeDiagnostic()
                do { try await Task.sleep(for: .seconds(5)) }
                catch { return }
            }
        }
    }

    private func configureMicrophone(_ microphone: SpeechInput) throws {
        let input = engine.inputNode
        let hardware = input.inputFormat(forBus: 0)
        guard hardware.sampleRate > 0, hardware.channelCount > 0 else {
            throw CaptureFailure(message: "マイクを利用できません")
        }
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw CaptureFailure(message: "マイクの入力形式を取得できません") }
        input.installTap(onBus: 0, bufferSize: 4096, format: nil) { buffer, time in
            let seconds = time.isHostTimeValid ? AVAudioTime.seconds(forHostTime: time.hostTime)
                : CMClockGetTime(CMClockGetHostTimeClock()).seconds - Double(buffer.frameLength) / buffer.format.sampleRate
            microphone.append(buffer, hostSeconds: seconds)
        }
        tapInstalled = true
    }

    private func observeAudioConfiguration(initialStatus: CaptureAudioStatus) {
        routeObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] notification in
            if let changedEngine = notification.object as? AVAudioEngine {
                let changedStatus = CaptureAudioStatus(engine: changedEngine)
                CaptureDiagnostic(event: "audio_configuration_changed", before: initialStatus, after: changedStatus).write()
                // 通知元の処理中にエンジンを破棄すると停止するため、処理の場所を移す。
                Task { @MainActor [weak self, weak changedEngine] in
                    guard let self, let changedEngine, self.engine === changedEngine else { return }
                    self.scheduleMicrophoneRecovery(before: changedStatus)
                }
            }
        }
    }

    private func scheduleMicrophoneRecovery(before: CaptureAudioStatus) {
        guard !ending, !events.isStopped else { return }
        if recoveryTask != nil { pendingRecovery = (ObjectIdentifier(engine), before); return }
        recoveryTask = Task { [weak self] in
            guard let self else { return }
            defer {
                recoveryTask = nil
                if let pending = pendingRecovery {
                    pendingRecovery = nil
                    if pending.engineID == ObjectIdentifier(engine) {
                        scheduleMicrophoneRecovery(before: pending.status)
                    }
                }
            }
            do {
                let resumed = try await retryMicrophoneRestart(
                    shouldStop: { self.ending || self.events.isStopped },
                    restart: { try self.restartMicrophone() }
                )
                if resumed && engine.isRunning {
                    CaptureDiagnostic(event: "microphone_resumed", before: before, after: CaptureAudioStatus(engine: engine)).write()
                }
            } catch is CancellationError {
                return
            } catch {
                if ending || events.isStopped { return }
                CaptureDiagnostic(event: "microphone_resume_failed", before: before, after: CaptureAudioStatus(engine: engine)).write()
                events.stop(.failed("音声機器の切替後に録音を再開できませんでした: \(error.localizedDescription)"))
            }
        }
    }

    private func stopMicrophoneEngine() {
        if let observer = routeObserver { NotificationCenter.default.removeObserver(observer); routeObserver = nil }
        engine.stop()
        if tapInstalled { engine.inputNode.removeTap(onBus: 0); tapInstalled = false }
    }

    private func restartMicrophone() throws {
        guard let microphone else { throw CaptureFailure(message: "マイクの音声認識がありません") }
        stopMicrophoneEngine()
        try microphone.beginNewSegment()
        engine = AVAudioEngine()
        try configureMicrophone(microphone)
        guard !ending, !events.isStopped else { throw CancellationError() }
        try engine.start()
        observeAudioConfiguration(initialStatus: CaptureAudioStatus(engine: engine))
    }

    private func stopInputs() async throws {
        ending = true
        pendingRecovery = nil
        recoveryTask?.cancel()
        await recoveryTask?.value
        recoveryTask = nil
        stopMicrophoneEngine()
        microphone?.finishInput()
        defer { system?.finishInput() }
        if let stream = systemStream {
            systemStream = nil
            try await stream.stopCapture()
        }
    }

    private func finishAudio() async throws {
        defer {
            diagnosticTask?.cancel()
            diagnosticTask = nil
        }
        try await stopInputs()
        async let micFinish: Void = microphone?.analyzer.finalizeAndFinishThroughEndOfInput() ?? ()
        async let sysFinish: Void = system?.analyzer.finalizeAndFinishThroughEndOfInput() ?? ()
        _ = try await (micFinish, sysFinish)
        for task in resultTasks { try await task.value }
    }

    private func cancelAudio() async {
        diagnosticTask?.cancel()
        diagnosticTask = nil
        try? await stopInputs()
        await microphone?.analyzer.cancelAndFinishNow()
        await system?.analyzer.cancelAndFinishNow()
        for task in resultTasks { task.cancel() }
        for task in resultTasks { _ = try? await task.value }
    }
}

@main
struct NativeCapture {
    @MainActor static func main() async {
        umask(0o077)
        let arguments = Array(CommandLine.arguments.dropFirst())
        if arguments == ["--help"] {
            print("Voice Notes recording helper: --locale ja-JP|en-US")
            return
        }
        guard let settings = CaptureSettings(arguments: arguments) else {
            FileHandle.standardError.write(Data("録音設定の指定が不正です\n".utf8))
            exit(2)
        }
        let events = StopEvents()
        var signals: [DispatchSourceSignal] = []
        for number in [SIGINT, SIGTERM] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .global())
            source.setEventHandler { events.stop(.requested) }
            source.resume()
            signals.append(source)
        }
        defer { for source in signals { source.cancel() } }
        do {
            try await LiveAudioCapture(events: events)
                .run(locale: Locale(identifier: settings.localeIdentifier))
        }
        catch {
            FileHandle.standardError.write(Data(("録音に失敗しました: \(error.localizedDescription)\n").utf8))
            exit(1)
        }
    }
}
