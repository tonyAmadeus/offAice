import Foundation

// MARK: Live stage — typed performance events for TTS and VTube Studio.
// A model may only *propose* an emotion with an inline tag such as `[happy]`.
// Tags are matched against a fixed whitelist; anything else is dropped and is
// never forwarded to VTube Studio, the shell or any other executor.

public enum LiveEmotion: String, Codable, CaseIterable, Identifiable, Sendable {
    case neutral, happy, excited, thinking, surprised, sad, angry, shy
    public var id: String { rawValue }

    public var zhTitle: String {
        switch self {
        case .neutral: return "平靜"
        case .happy: return "開心"
        case .excited: return "興奮"
        case .thinking: return "思考"
        case .surprised: return "驚訝"
        case .sad: return "難過"
        case .angry: return "生氣"
        case .shy: return "害羞"
        }
    }

    /// Accepts the English tag or a Traditional Chinese alias.
    public init?(tag: String) {
        let key = tag.trimmingCharacters(in: .whitespaces).lowercased()
        if let direct = LiveEmotion(rawValue: key) { self = direct; return }
        let aliases: [String: LiveEmotion] = [
            "平靜": .neutral, "中性": .neutral, "開心": .happy, "高興": .happy,
            "興奮": .excited, "思考": .thinking, "驚訝": .surprised, "難過": .sad,
            "傷心": .sad, "生氣": .angry, "害羞": .shy
        ]
        guard let alias = aliases[key] else { return nil }
        self = alias
    }
}

/// One spoken segment. A reply becomes 1...`LiveCueParser.maxSegments` events,
/// played strictly in `sequence` order before the next speaker starts.
public struct LiveEvent: Identifiable, Codable, Equatable, Sendable {
    public var id: UUID
    public var turnID: UUID
    public var sequence: Int
    public var speaker: AgentKind
    public var utterance: String
    public var emotion: LiveEmotion
    public var timestamp: Date

    public init(id: UUID = UUID(), turnID: UUID, sequence: Int, speaker: AgentKind,
                utterance: String, emotion: LiveEmotion, timestamp: Date = .now) {
        self.id = id; self.turnID = turnID; self.sequence = sequence; self.speaker = speaker
        self.utterance = utterance; self.emotion = emotion; self.timestamp = timestamp
    }
}

public struct ParsedLiveReply: Equatable, Sendable {
    public struct Segment: Equatable, Sendable {
        public var emotion: LiveEmotion
        public var text: String
    }
    /// Subtitle / transcript text with every recognised or invented tag removed.
    public var cleanText: String
    public var segments: [Segment]
}

public enum LiveCueParser {
    public static let maxSegments = 8
    public static let maxSegmentCharacters = 600

    // `[happy]`, `[ Happy ]`, `【開心】`. ASCII words are treated as cue attempts;
    // short Han words are cues only when they match an alias.
    private static let pattern = try! NSRegularExpression(
        pattern: #"[\[【]\s*([A-Za-z]{1,16}|\p{Han}{1,4})\s*[\]】]"#)

    public static func parse(_ reply: String) -> ParsedLiveReply {
        let source = reply as NSString
        var segments: [ParsedLiveReply.Segment] = []
        var clean = ""
        var pending = ""
        var emotion = LiveEmotion.neutral
        var cursor = 0

        func flush() {
            let text = pending.trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { segments.append(.init(emotion: emotion, text: text)) }
            pending = ""
        }

        for match in pattern.matches(in: reply, range: NSRange(location: 0, length: source.length)) {
            let before = source.substring(with: NSRange(location: cursor, length: match.range.location - cursor))
            pending += before; clean += before
            cursor = match.range.location + match.range.length
            let word = source.substring(with: match.range(at: 1))
            if let cue = LiveEmotion(tag: word) {
                flush(); emotion = cue
            } else if word.unicodeScalars.allSatisfy({ $0.isASCII }) {
                continue // invented ASCII tag: drop silently
            } else {
                let literal = source.substring(with: match.range) // e.g. 【注意】 is ordinary text
                pending += literal; clean += literal
            }
        }
        let tail = source.substring(from: cursor)
        pending += tail; clean += tail
        flush()

        if segments.count > maxSegments {
            let overflow = segments[(maxSegments - 1)...].map(\.text).joined(separator: " ")
            segments = Array(segments.prefix(maxSegments - 1))
                + [.init(emotion: segments[maxSegments - 1].emotion, text: overflow)]
        }
        segments = segments.map { .init(emotion: $0.emotion, text: String($0.text.prefix(maxSegmentCharacters))) }
        return ParsedLiveReply(cleanText: normalizeSpacing(clean), segments: segments)
    }

    public static func events(from parsed: ParsedLiveReply, speaker: AgentKind,
                              turnID: UUID = UUID(), now: Date = .now) -> [LiveEvent] {
        parsed.segments.enumerated().map { index, segment in
            LiveEvent(turnID: turnID, sequence: index, speaker: speaker,
                      utterance: segment.text, emotion: segment.emotion, timestamp: now)
        }
    }

    private static func normalizeSpacing(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.split(whereSeparator: { $0 == " " || $0 == "\t" }).joined(separator: " ") }
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// Text sent to the speech synthesizer: no markdown symbols, URLs or code.
public enum LiveSpeechText {
    private static let url = try! NSRegularExpression(pattern: #"https?://\S+"#)
    private static let code = try! NSRegularExpression(pattern: #"```[\s\S]*?```|`[^`]*`"#)

    public static func speakable(_ text: String, limit: Int = LiveCueParser.maxSegmentCharacters) -> String {
        var value = text
        for expression in [code, url] {
            value = expression.stringByReplacingMatches(
                in: value, range: NSRange(location: 0, length: (value as NSString).length), withTemplate: " ")
        }
        value = value.filter { !"*#_>|~".contains($0) }
        // Emoji are read out as their names ("smiling face") or render as tofu.
        value.unicodeScalars.removeAll { $0.properties.isEmojiPresentation || $0.value == 0xFE0F || $0.value == 0x200D }
        return String(value.split(whereSeparator: \.isWhitespace).joined(separator: " ").prefix(limit))
    }
}

// MARK: Persisted stage configuration (inside the encrypted state file)

public struct LiveCharacterStage: Codable, Equatable, Sendable {
    public var agent: AgentKind
    /// AVSpeechSynthesisVoice identifier; empty means the system voice for the UI language.
    public var voiceIdentifier: String
    /// AVSpeechUtterance rate (0.3–0.65; 0.5 is the system default).
    public var speechRate: Double
    public var pitch: Double
    /// Whether this co-host has its own VTube Studio instance to drive.
    public var drivesAvatar: Bool
    /// Each co-host has a separate VTS instance (a second one is started with
    /// `start_without_steam` and takes the next free port).
    public var vtsPort: Int
    /// Plugin token issued by that VTS instance after the user clicks Allow.
    /// It only grants control of local VTS; stored with the encrypted state.
    public var vtsToken: String
    public var mouthParameter: String
    /// LiveEmotion.rawValue → VTube Studio hotkeyID. Only IDs reported by the
    /// currently loaded model are ever triggered.
    public var emotionHotkeys: [String: String]

    public init(agent: AgentKind, voiceIdentifier: String = "", speechRate: Double = 0.5,
                pitch: Double = 1.0, drivesAvatar: Bool = false, vtsPort: Int? = nil, vtsToken: String = "",
                mouthParameter: String = "MouthOpen", emotionHotkeys: [String: String] = [:]) {
        self.agent = agent
        self.voiceIdentifier = String(voiceIdentifier.prefix(200))
        self.speechRate = min(0.65, max(0.3, speechRate))
        self.pitch = min(2.0, max(0.5, pitch))
        self.drivesAvatar = drivesAvatar
        self.vtsPort = min(65_535, max(1_024, vtsPort ?? Self.defaultPort(agent)))
        self.vtsToken = String(vtsToken.prefix(512))
        let mouth = mouthParameter.filter { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_") }
        self.mouthParameter = mouth.isEmpty ? "MouthOpen" : String(mouth.prefix(32))
        self.emotionHotkeys = emotionHotkeys.filter { LiveEmotion(rawValue: $0.key) != nil && $0.value.count <= 128 }
    }

    private enum CodingKeys: String, CodingKey {
        case agent, voiceIdentifier, speechRate, pitch, drivesAvatar, vtsPort, vtsToken, mouthParameter, emotionHotkeys
    }

    /// GPT's model went live first, so its VTS instance usually owns 8001.
    public static func defaultPort(_ agent: AgentKind) -> Int { agent == .codex ? 8001 : 8002 }
    public init(from decoder: Decoder) throws {
        let box = try decoder.container(keyedBy: CodingKeys.self)
        self.init(agent: try box.decode(AgentKind.self, forKey: .agent),
                  voiceIdentifier: try box.decodeIfPresent(String.self, forKey: .voiceIdentifier) ?? "",
                  speechRate: try box.decodeIfPresent(Double.self, forKey: .speechRate) ?? 0.5,
                  pitch: try box.decodeIfPresent(Double.self, forKey: .pitch) ?? 1.0,
                  drivesAvatar: try box.decodeIfPresent(Bool.self, forKey: .drivesAvatar) ?? false,
                  vtsPort: try box.decodeIfPresent(Int.self, forKey: .vtsPort),
                  vtsToken: try box.decodeIfPresent(String.self, forKey: .vtsToken) ?? "",
                  mouthParameter: try box.decodeIfPresent(String.self, forKey: .mouthParameter) ?? "MouthOpen",
                  emotionHotkeys: try box.decodeIfPresent([String: String].self, forKey: .emotionHotkeys) ?? [:])
    }
}

public struct LiveStageSettings: Codable, Equatable, Sendable {
    public var speechEnabled: Bool
    public var vtsEnabled: Bool
    public var characters: [LiveCharacterStage]

    public init(speechEnabled: Bool = false, vtsEnabled: Bool = false, characters: [LiveCharacterStage] = []) {
        self.speechEnabled = speechEnabled
        self.vtsEnabled = vtsEnabled
        var unique: [LiveCharacterStage] = []
        for item in characters where !unique.contains(where: { $0.agent == item.agent }) { unique.append(item) }
        for agent in AgentKind.allCases where !unique.contains(where: { $0.agent == agent }) {
            unique.append(LiveCharacterStage(agent: agent, drivesAvatar: true))
        }
        self.characters = unique
    }

    private enum CodingKeys: String, CodingKey { case speechEnabled, vtsEnabled, characters }
    public init(from decoder: Decoder) throws {
        let box = try decoder.container(keyedBy: CodingKeys.self)
        self.init(speechEnabled: try box.decodeIfPresent(Bool.self, forKey: .speechEnabled) ?? false,
                  vtsEnabled: try box.decodeIfPresent(Bool.self, forKey: .vtsEnabled) ?? false,
                  characters: try box.decodeIfPresent([LiveCharacterStage].self, forKey: .characters) ?? [])
    }

    public var performs: Bool { speechEnabled || vtsEnabled }

    public func character(_ agent: AgentKind) -> LiveCharacterStage {
        characters.first(where: { $0.agent == agent }) ?? LiveCharacterStage(agent: agent)
    }

    public mutating func updateCharacter(_ agent: AgentKind, _ change: (inout LiveCharacterStage) -> Void) {
        guard let index = characters.firstIndex(where: { $0.agent == agent }) else { return }
        change(&characters[index])
        let edited = characters[index]
        characters[index] = LiveCharacterStage(agent: edited.agent, voiceIdentifier: edited.voiceIdentifier,
            speechRate: edited.speechRate, pitch: edited.pitch, drivesAvatar: edited.drivesAvatar,
            vtsPort: edited.vtsPort, vtsToken: edited.vtsToken, mouthParameter: edited.mouthParameter, emotionHotkeys: edited.emotionHotkeys)
    }
}

// MARK: Lip sync envelope

public enum LipSync {
    /// Converts per-window RMS loudness into 0...1 mouth openness. Normalised to
    /// the utterance's own peak so quiet and loud voices animate similarly.
    public static func mouthCurve(rms: [Float], gate: Float = 0.08) -> [Double] {
        guard let peak = rms.max(), peak > 0 else { return rms.map { _ in 0 } }
        return rms.map { value in
            let level = value / peak
            return level < gate ? 0 : Double(min(1, pow(level, 0.6)))
        }
    }
}
