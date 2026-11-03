import Foundation

public enum AgentKind: String, Codable, CaseIterable, Identifiable, Hashable, Sendable {
    case claude = "Claude Code"
    case codex = "Codex"

    public var id: String { rawValue }
    public var executableName: String { self == .claude ? "claude" : "codex" }
    public var symbol: String { self == .claude ? "brain.head.profile" : "chevron.left.forwardslash.chevron.right" }
}

public enum MessageRole: String, Codable, Sendable { case user, assistant }

public struct ChatMessage: Identifiable, Codable, Equatable, Sendable {
    public var id: UUID
    public var role: MessageRole
    public var body: String
    public var createdAt: Date
    public var attachments: [ChatAttachment]
    /// The model the CLI actually reported for this reply.
    public var modelUsed: String?

    public init(id: UUID = UUID(), role: MessageRole, body: String, createdAt: Date = .now,
                attachments: [ChatAttachment] = [], modelUsed: String? = nil) {
        self.id = id
        self.role = role
        self.body = body
        self.createdAt = createdAt
        self.attachments = attachments
        self.modelUsed = modelUsed
    }

    private enum CodingKeys: String, CodingKey { case id, role, body, createdAt, attachments, modelUsed }
    public init(from decoder: Decoder) throws {
        let box = try decoder.container(keyedBy: CodingKeys.self)
        id = try box.decode(UUID.self, forKey: .id)
        role = try box.decode(MessageRole.self, forKey: .role)
        body = try box.decode(String.self, forKey: .body)
        createdAt = try box.decode(Date.self, forKey: .createdAt)
        attachments = try box.decodeIfPresent([ChatAttachment].self, forKey: .attachments) ?? []
        modelUsed = try box.decodeIfPresent(String.self, forKey: .modelUsed)
    }
}

/// One member-desk topic. Each member has one open topic; "new topic"
/// archives it, and any archived topic can be reopened later.
public struct Conversation: Identifiable, Codable, Equatable, Sendable {
    public var id: UUID
    public var agent: AgentKind
    public var title: String
    public var messages: [ChatMessage]
    public var updatedAt: Date
    public var archived: Bool
    /// True once the user typed a title; auto-naming then leaves it alone.
    public var titleLocked: Bool
    /// Empty means the CLI's default model / effort.
    public var model: String
    public var effort: String
    public var draft: String
    public var draftAttachments: [ChatAttachment]
    /// Folder this topic works on. Empty = the member's personal folder
    /// (edited in place); otherwise a task copy of this folder is edited.
    public var workFolder: String
    /// The CLI conversation this topic continues, and the last reply it already contains.
    public var sessionID: String?
    public var sessionThrough: UUID?
    /// Things the CLI conversation must be told before the next message (e.g. an undone round).
    public var sessionNotes: [String]
    /// Fingerprint of the persona and memory that conversation was last given.
    public var sessionProfile: String?

    public init(id: UUID = UUID(), agent: AgentKind, title: String = TopicNaming.defaultTitle,
                messages: [ChatMessage] = [], updatedAt: Date = .now, archived: Bool = false,
                titleLocked: Bool = false, model: String = "", effort: String = "",
                draft: String = "", draftAttachments: [ChatAttachment] = [], workFolder: String = "") {
        self.id = id
        self.agent = agent
        self.title = title
        self.messages = messages
        self.updatedAt = updatedAt
        self.archived = archived
        self.titleLocked = titleLocked
        self.model = model
        self.effort = effort
        self.draft = draft
        self.draftAttachments = draftAttachments
        self.workFolder = workFolder
        self.sessionID = nil
        self.sessionThrough = nil
        self.sessionNotes = []
        self.sessionProfile = nil
    }

    private enum CodingKeys: String, CodingKey {
        case id, agent, title, messages, updatedAt, archived, titleLocked, model, effort, draft, draftAttachments, workFolder,
             sessionID, sessionThrough, sessionNotes, sessionProfile
    }
    public init(from decoder: Decoder) throws {
        let box = try decoder.container(keyedBy: CodingKeys.self)
        id = try box.decode(UUID.self, forKey: .id)
        agent = try box.decode(AgentKind.self, forKey: .agent)
        title = try box.decode(String.self, forKey: .title)
        messages = try box.decode([ChatMessage].self, forKey: .messages)
        updatedAt = try box.decode(Date.self, forKey: .updatedAt)
        archived = try box.decodeIfPresent(Bool.self, forKey: .archived) ?? false
        titleLocked = try box.decodeIfPresent(Bool.self, forKey: .titleLocked) ?? false
        model = try box.decodeIfPresent(String.self, forKey: .model) ?? ""
        effort = try box.decodeIfPresent(String.self, forKey: .effort) ?? ""
        draft = try box.decodeIfPresent(String.self, forKey: .draft) ?? ""
        draftAttachments = try box.decodeIfPresent([ChatAttachment].self, forKey: .draftAttachments) ?? []
        workFolder = try box.decodeIfPresent(String.self, forKey: .workFolder) ?? ""
        sessionID = try box.decodeIfPresent(String.self, forKey: .sessionID)
        sessionThrough = try box.decodeIfPresent(UUID.self, forKey: .sessionThrough)
        sessionNotes = try box.decodeIfPresent([String].self, forKey: .sessionNotes) ?? []
        sessionProfile = try box.decodeIfPresent(String.self, forKey: .sessionProfile)
    }

    /// Continue the CLI conversation only when nothing happened since its last reply.
    public var canContinueSession: Bool {
        sessionID != nil && sessionThrough != nil && messages.last?.id == sessionThrough
    }
}

public struct RoundtableResult: Identifiable, Codable, Equatable, Sendable {
    public var id: UUID
    public var agent: AgentKind
    public var text: String
    public var error: String?

    public init(id: UUID = UUID(), agent: AgentKind, text: String = "", error: String? = nil) {
        self.id = id
        self.agent = agent
        self.text = text
        self.error = error
    }
}

public enum PromptBuilder {
    /// MVP uses fresh read-only CLI executions, so explicit prior turns preserve conversational context.
    /// This is not a native CLI session resume and can consume more tokens.
    public static func build(history: [ChatMessage], newQuestion: String, maxTurns: Int = 8,
                             language: InterfaceLanguage = .zhTW, canWrite: Bool = false, userName: String = "",
                             persona: String = "", profile: String = "") -> String {
        let tail = Array(history.suffix(max(0, maxTurns * 2)))
        let access = canWrite
            ? (language == .english
               ? "You may read and edit files in the current working folder when the request calls for it. Only change files inside this folder; never touch other paths. Summarise what you changed."
               : "需要時可以讀取並修改目前工作資料夾裡的檔案。只修改這個資料夾內的檔案，絕對不要動其他路徑。完成後簡述改了什麼。")
            : (language == .english ? "This is a read-only conversation. Do not modify files or execute changes."
               : "本次是唯讀對話，不要修改檔案或執行變更。")
        var lines = language == .english
            ? ["You are the selected AI assistant. Here is recent conversation history. Reply in English unless the user asks otherwise.", access]
            : ["你是使用者選擇的 AI 助手。以下是本工作台保存的近期對話。請使用繁體中文回覆，除非使用者另有要求。", access]
        let name = userName.trimmingCharacters(in: .whitespacesAndNewlines)
        if !name.isEmpty {
            lines.append(language == .english ? "Address the user as \(name)." : "請稱呼使用者為「\(name)」。")
        }
        let persona = persona.trimmingCharacters(in: .whitespacesAndNewlines)
        if !persona.isEmpty {
            lines.append((language == .english ? "Your persona: " : "你的人物設定：") + String(persona.prefix(1_500)))
        }
        if !profile.isEmpty { lines.append(profile) }
        for message in tail where !message.body.isEmpty {
            let name = language == .english
                ? (message.role == .user ? "User" : "Assistant")
                : (message.role == .user ? "使用者" : "助理")
            let files = message.attachments.isEmpty ? "" : " [附件：\(message.attachments.map(\.fileName).joined(separator: "、"))]"
            lines.append("\(name): \(message.body)\(files)")
        }
        lines.append("\(language == .english ? "User" : "使用者")：\(newQuestion)")
        return lines.joined(separator: "\n\n")
    }
}
