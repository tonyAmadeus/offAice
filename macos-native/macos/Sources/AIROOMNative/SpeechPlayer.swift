import AVFoundation
import AIROOMCore

/// Synthesises each line to PCM first so the mouth follows real loudness, then
/// plays it on the default output device (OBS picks it up as desktop audio).
@MainActor
final class SpeechPlayer {
    static let mouthFrameRate = 30.0

    private let synthesizer = AVSpeechSynthesizer()
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private var connectedFormat: AVAudioFormat?
    private var generation = 0
    /// Ends whichever phase (synthesis or playback) is waiting, exactly once.
    private var interrupt: (() -> Void)?

    init() { engine.attach(player) }

    static func voices() -> [AVSpeechSynthesisVoice] {
        AVSpeechSynthesisVoice.speechVoices()
            .filter { ["zh", "en", "ja"].contains(where: $0.language.hasPrefix) }
            .sorted { ($0.language, $0.name) < ($1.language, $1.name) }
    }

    func stop() {
        generation += 1
        synthesizer.stopSpeaking(at: .immediate)
        player.stop()
        interrupt?(); interrupt = nil
    }

    /// Returns once playback finishes or `stop()` is called. `onMouth` receives
    /// 0...1 openness at ~30 Hz and a final 0.
    func speak(_ text: String, character: LiveCharacterStage, language: InterfaceLanguage,
               onMouth: @escaping (Double) async -> Void) async {
        let spoken = LiveSpeechText.speakable(text)
        guard !spoken.isEmpty else { return }
        generation += 1
        let token = generation
        let utterance = AVSpeechUtterance(string: spoken)
        utterance.voice = AVSpeechSynthesisVoice(identifier: character.voiceIdentifier)
            ?? AVSpeechSynthesisVoice(language: language == .english ? "en-US" : "zh-TW")
        utterance.rate = Float(character.speechRate)
        utterance.pitchMultiplier = Float(character.pitch)

        guard let buffer = Self.mixdown(await synthesize(utterance)), token == generation else { return }
        let window = max(1, Int(buffer.format.sampleRate / Self.mouthFrameRate))
        let curve = LipSync.mouthCurve(rms: Self.rms(buffer, window: window))
        if connectedFormat != buffer.format {
            engine.disconnectNodeOutput(player)
            engine.connect(player, to: engine.mainMixerNode, format: buffer.format)
            connectedFormat = buffer.format
        }
        do { if !engine.isRunning { try engine.start() } } catch { return }

        let done = OnceFlag()
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let finish = { done.run { continuation.resume() } }
            interrupt = finish
            player.scheduleBuffer(buffer, at: nil, options: .interrupts,
                                  completionCallbackType: .dataPlayedBack) { _ in finish() }
            player.play()
            Task { @MainActor [player] in
                while !done.isDone && token == self.generation {
                    if let now = player.lastRenderTime, let time = player.playerTime(forNodeTime: now) {
                        let index = Int(time.sampleTime) / window
                        await onMouth(curve.indices.contains(index) ? curve[index] : 0)
                    }
                    try? await Task.sleep(nanoseconds: UInt64(1_000_000_000 / Self.mouthFrameRate))
                }
                await onMouth(0)
            }
        }
        interrupt = nil
    }

    private func synthesize(_ utterance: AVSpeechUtterance) async -> [AVAudioPCMBuffer] {
        let collected = BufferBox()
        let done = OnceFlag()
        return await withCheckedContinuation { continuation in
            let finish = { done.run { continuation.resume(returning: collected.all) } }
            interrupt = finish
            synthesizer.write(utterance) { buffer in
                guard let pcm = buffer as? AVAudioPCMBuffer else { return }
                if pcm.frameLength == 0 { finish() } else { collected.append(pcm) }
            }
            // Some voices never deliver the empty end-of-stream buffer.
            Task { try? await Task.sleep(nanoseconds: 30_000_000_000); finish() }
        }
    }

    /// Mono float32 copy of every synthesized chunk (Int16 or Float32 input).
    private static func mixdown(_ buffers: [AVAudioPCMBuffer]) -> AVAudioPCMBuffer? {
        guard let rate = buffers.first?.format.sampleRate,
              let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false) else { return nil }
        let total = buffers.reduce(0) { $0 + Int($1.frameLength) }
        guard total > 0, let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(total)),
              let target = output.floatChannelData?[0] else { return nil }
        var offset = 0
        for buffer in buffers where buffer.format.sampleRate == rate {
            let frames = Int(buffer.frameLength)
            let stride = buffer.format.isInterleaved ? Int(buffer.format.channelCount) : 1
            if let samples = buffer.floatChannelData?[0] {
                for index in 0..<frames { target[offset + index] = samples[index * stride] }
            } else if let samples = buffer.int16ChannelData?[0] {
                for index in 0..<frames { target[offset + index] = Float(samples[index * stride]) / 32_768 }
            } else { continue }
            offset += frames
        }
        output.frameLength = AVAudioFrameCount(offset)
        return offset > 0 ? output : nil
    }

    private static func rms(_ buffer: AVAudioPCMBuffer, window: Int) -> [Float] {
        guard let samples = buffer.floatChannelData?[0] else { return [] }
        let frames = Int(buffer.frameLength)
        return stride(from: 0, to: frames, by: window).map { start in
            let end = min(frames, start + window)
            var sum: Float = 0
            for index in start..<end { sum += samples[index] * samples[index] }
            return (sum / Float(end - start)).squareRoot()
        }
    }
}

private final class BufferBox: @unchecked Sendable {
    private let lock = NSLock()
    private var buffers: [AVAudioPCMBuffer] = []
    func append(_ buffer: AVAudioPCMBuffer) { lock.lock(); buffers.append(buffer); lock.unlock() }
    var all: [AVAudioPCMBuffer] { lock.lock(); defer { lock.unlock() }; return buffers }
}

private final class OnceFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var fired = false
    var isDone: Bool { lock.lock(); defer { lock.unlock() }; return fired }
    func run(_ action: () -> Void) {
        lock.lock()
        guard !fired else { lock.unlock(); return }
        fired = true
        lock.unlock()
        action()
    }
}
