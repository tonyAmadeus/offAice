import Foundation
import AIROOMCore

/// Plays LiveEvents one at a time: emotion hotkey → TTS with lip sync → next.
/// Each co-host drives its own VTube Studio instance (own port, own model).
/// The live loop awaits `perform`, so two co-hosts never talk over each other.
@MainActor
final class LiveStageController: ObservableObject {
    enum Connection: Equatable {
        case off, connecting, connected(model: String), failed(String)
    }

    @Published private(set) var connections: [AgentKind: Connection] = [:]
    @Published private(set) var hotkeys: [AgentKind: [VTSHotkey]] = [:]
    @Published private(set) var speaking: AgentKind?
    @Published private(set) var subtitle = ""
    @Published private(set) var lastWarning: String?

    private var clients: [AgentKind: VTubeStudioClient] = [:]
    private let speech = SpeechPlayer()
    /// Expression hotkey currently switched on per model (VTS expressions toggle).
    private var activeExpression: [AgentKind: String] = [:]
    private var stopped = false

    func connection(_ agent: AgentKind) -> Connection { connections[agent] ?? .off }
    func hotkeys(_ agent: AgentKind) -> [VTSHotkey] { hotkeys[agent] ?? [] }
    func isConnected(_ agent: AgentKind) -> Bool {
        if case .connected = connection(agent) { return true } else { return false }
    }

    // MARK: VTube Studio

    func connect(_ agent: AgentKind, port: Int, token: String, onNewToken: @escaping (String) -> Void) {
        let client = clients[agent] ?? VTubeStudioClient()
        clients[agent] = client
        activeExpression[agent] = nil
        connections[agent] = .connecting
        Task {
            do {
                let result = try await client.connect(port: port, token: token)
                if result.token != token { onNewToken(result.token) }
                connections[agent] = .connected(model: result.model.loaded ? result.model.name : "")
                await refreshHotkeys(agent)
            } catch {
                connections[agent] = .failed(error.localizedDescription)
            }
        }
    }

    func disconnect(_ agent: AgentKind) {
        activeExpression[agent] = nil
        hotkeys[agent] = nil
        connections[agent] = .off
        if let client = clients[agent] { Task { await client.disconnect() } }
    }

    func refreshHotkeys(_ agent: AgentKind) async {
        guard let client = clients[agent] else { return }
        do { hotkeys[agent] = try await client.hotkeys() }
        catch { lastWarning = error.localizedDescription }
    }

    // MARK: Performance

    func stop() {
        stopped = true
        speech.stop()
    }

    func perform(_ events: [LiveEvent], stage: LiveStageSettings, language: InterfaceLanguage) async {
        stopped = false
        lastWarning = nil
        for event in events.sorted(by: { $0.sequence < $1.sequence }) {
            guard !stopped else { break }
            let character = stage.character(event.speaker)
            let client = stage.vtsEnabled && character.drivesAvatar && isConnected(event.speaker)
                ? clients[event.speaker] : nil
            if let client { await show(event.emotion, for: character, on: client) }
            speaking = event.speaker
            subtitle = event.utterance
            guard stage.speechEnabled else { continue }
            let mouth = character.mouthParameter
            await speech.speak(event.utterance, character: character, language: language) { value in
                await client?.inject([(mouth, value)])
            }
        }
        speaking = nil
    }

    /// Clears any expression left on by the previous show.
    func resetAvatars() async {
        for (agent, active) in activeExpression {
            activeExpression[agent] = nil
            try? await clients[agent]?.trigger(hotkeyID: active)
        }
    }

    func rehearse(_ agent: AgentKind, name: String, stage: LiveStageSettings, language: InterfaceLanguage) {
        let line = language == .english
            ? "[happy] Hi everyone, I'm \(name)! [thinking] This is a voice and expression test. [surprised] Can you see my mouth move?"
            : "[happy] 大家好，我是\(name)！[thinking] 這是聲音和表情的測試。[surprised] 有看到我的嘴巴在動嗎？"
        Task {
            await perform(LiveCueParser.events(from: LiveCueParser.parse(line), speaker: agent),
                          stage: stage, language: language)
            await resetAvatars()
        }
    }

    private func show(_ emotion: LiveEmotion, for character: LiveCharacterStage, on client: VTubeStudioClient) async {
        let agent = character.agent
        let target = emotion == .neutral ? nil : character.emotionHotkeys[emotion.rawValue]
        guard target != activeExpression[agent] else { return }
        let toggles = { (id: String) in self.hotkeys(agent).first(where: { $0.id == id })?.toggles == true }
        do {
            if let active = activeExpression[agent], toggles(active) {
                try await client.trigger(hotkeyID: active) // switch the old expression off
            }
            activeExpression[agent] = nil
            if let target {
                try await client.trigger(hotkeyID: target)
                if toggles(target) { activeExpression[agent] = target }
            }
        } catch {
            lastWarning = error.localizedDescription
            if case VTSError.disconnected = error { connections[agent] = .failed(error.localizedDescription) }
        }
    }
}
