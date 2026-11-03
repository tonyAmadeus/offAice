import Foundation

public struct SavedState: Codable, Equatable, Sendable {
    public var settings: NativeSettings
    public var conversations: [Conversation]
    public var members: [MemberCard]
    public var rooms: [TeamRoom]
    public var projects: [ProjectRecord]
    public var roundtables: [StoredRoundtable]
    public var schedules: [ScheduledActivity]
    public var autoChat: AutoChatSettings
    public var teamWorkflows: [TeamProjectWorkflow]
    public var liveShow: LiveShowSettings
    public var liveStage: LiveStageSettings
    public var calls: CallLedger
    public var roundtableTopics: [RoundtableTopic]
    public var projectFlows: [ProjectFlow]
    public var dailyOpening: DailyOpeningSettings
    /// Needs-attention items the owner ignored, by id, with the version ignored.
    public var attentionDismissals: [String: String]
    public init(settings: NativeSettings = NativeSettings(), conversations: [Conversation] = [],
                members: [MemberCard] = MemberCard.defaults, rooms: [TeamRoom] = [TeamRoom()],
                projects: [ProjectRecord] = [], roundtables: [StoredRoundtable] = [],
                schedules: [ScheduledActivity] = [], autoChat: AutoChatSettings = AutoChatSettings(),
                teamWorkflows: [TeamProjectWorkflow] = [], liveShow: LiveShowSettings = LiveShowSettings(),
                liveStage: LiveStageSettings = LiveStageSettings(), calls: CallLedger = CallLedger(),
                roundtableTopics: [RoundtableTopic] = [], projectFlows: [ProjectFlow] = [],
                dailyOpening: DailyOpeningSettings = DailyOpeningSettings()) {
        self.settings = settings
        self.conversations = conversations
        self.members = members
        self.rooms = rooms
        self.projects = projects
        self.roundtables = roundtables
        self.schedules = schedules
        self.autoChat = autoChat
        self.teamWorkflows = teamWorkflows
        self.liveShow = liveShow
        self.liveStage = liveStage
        self.calls = calls
        self.roundtableTopics = roundtableTopics
        self.projectFlows = projectFlows
        self.dailyOpening = dailyOpening
        attentionDismissals = [:]
    }
    private enum CodingKeys: String, CodingKey { case settings, conversations, members, rooms, projects, roundtables, schedules, autoChat, teamWorkflows, liveShow, liveStage, calls, roundtableTopics, projectFlows, dailyOpening, attentionDismissals }
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        settings = try container.decodeIfPresent(NativeSettings.self, forKey: .settings) ?? NativeSettings()
        conversations = try container.decodeIfPresent([Conversation].self, forKey: .conversations) ?? []
        members = try container.decodeIfPresent([MemberCard].self, forKey: .members) ?? MemberCard.defaults
        rooms = try container.decodeIfPresent([TeamRoom].self, forKey: .rooms) ?? [TeamRoom()]
        projects = try container.decodeIfPresent([ProjectRecord].self, forKey: .projects) ?? []
        roundtables = try container.decodeIfPresent([StoredRoundtable].self, forKey: .roundtables) ?? []
        schedules = try container.decodeIfPresent([ScheduledActivity].self, forKey: .schedules) ?? []
        autoChat = try container.decodeIfPresent(AutoChatSettings.self, forKey: .autoChat) ?? AutoChatSettings()
        teamWorkflows = try container.decodeIfPresent([TeamProjectWorkflow].self, forKey: .teamWorkflows) ?? []
        liveShow = try container.decodeIfPresent(LiveShowSettings.self, forKey: .liveShow) ?? LiveShowSettings()
        liveStage = try container.decodeIfPresent(LiveStageSettings.self, forKey: .liveStage) ?? LiveStageSettings()
        calls = (try? container.decodeIfPresent(CallLedger.self, forKey: .calls)) ?? CallLedger()
        roundtableTopics = (try? container.decodeIfPresent([RoundtableTopic].self, forKey: .roundtableTopics)) ?? []
        projectFlows = (try? container.decodeIfPresent([ProjectFlow].self, forKey: .projectFlows)) ?? []
        dailyOpening = (try? container.decodeIfPresent(DailyOpeningSettings.self, forKey: .dailyOpening)) ?? DailyOpeningSettings()
        attentionDismissals = (try? container.decodeIfPresent([String: String].self, forKey: .attentionDismissals)) ?? [:]
    }
}

public final class LocalStateStore {
    public let root: URL
    private let protector: (any StateProtector)?
    private let magic = Data("AIROOM1\n".utf8)
    private var protectedState: URL { root.appendingPathComponent("state.aesgcm") }
    private var legacyState: URL { root.appendingPathComponent("state.json") }

    public init(root: URL? = nil, protector customProtector: (any StateProtector)? = nil) throws {
        if let root { self.root = root }
        else {
            let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            self.root = base.appendingPathComponent("AIROOMNative", isDirectory: true)
        }
        #if os(macOS)
        self.protector = customProtector ?? KeychainStateProtector()
        #else
        self.protector = customProtector // Foundation tests only; shipping app is macOS-only.
        #endif
        try FileManager.default.createDirectory(at: self.root, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: self.root.path)
    }

    private func decode(_ data: Data) throws -> SavedState {
        if data.starts(with: magic) {
            guard let protector else { throw StateProtectionError.encryptionUnavailable }
            return try JSONDecoder().decode(SavedState.self, from: protector.open(Data(data.dropFirst(magic.count))))
        }
        guard protector == nil else { throw StateProtectionError.invalidCiphertext }
        return try JSONDecoder().decode(SavedState.self, from: data)
    }

    private func encode(_ state: SavedState) throws -> Data {
        let plaintext = try JSONEncoder().encode(state)
        guard let protector else { return plaintext }
        return magic + (try protector.seal(plaintext))
    }

    private func protectedWrite(_ data: Data, to file: URL) throws {
        try data.write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }

    public func load() throws -> SavedState {
        let fm = FileManager.default
        if fm.fileExists(atPath: protectedState.path) {
            return try decode(Data(contentsOf: protectedState))
        }
        if fm.fileExists(atPath: legacyState.path) {
            let value = try JSONDecoder().decode(SavedState.self, from: Data(contentsOf: legacyState))
            if protector != nil {
                try save(value) // Fail closed: never erase legacy data before verifying encrypted write.
                _ = try decode(Data(contentsOf: protectedState))
                try fm.removeItem(at: legacyState)
            }
            return value
        }
        return SavedState()
    }

    public func save(_ state: SavedState) throws {
        try protectedWrite(try encode(state), to: protector == nil ? legacyState : protectedState)
    }

    // MARK: Attachments — sealed like the state file, one file per attachment.
    private var attachmentDirectory: URL { root.appendingPathComponent("attachments", isDirectory: true) }

    public func storeAttachment(_ data: Data, id: UUID) throws {
        try FileManager.default.createDirectory(at: attachmentDirectory, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: attachmentDirectory.path)
        let sealed = try protector.map { magic + (try $0.seal(data)) } ?? data
        try protectedWrite(sealed, to: attachmentDirectory.appendingPathComponent("\(id.uuidString).aesgcm"))
    }

    public func loadAttachment(id: UUID) throws -> Data {
        let data = try Data(contentsOf: attachmentDirectory.appendingPathComponent("\(id.uuidString).aesgcm"))
        guard data.starts(with: magic) else {
            guard protector == nil else { throw StateProtectionError.invalidCiphertext }
            return data
        }
        guard let protector else { throw StateProtectionError.encryptionUnavailable }
        return try protector.open(Data(data.dropFirst(magic.count)))
    }

    /// Backups contain conversations and metadata, never official CLI credentials.
    /// On macOS they are encrypted with the device-bound Keychain key and cannot be
    /// restored on another Mac without an explicit export/rewrapping design.
    public var backupDirectory: URL { root.appendingPathComponent("backups", isDirectory: true) }
    static let beforeRestoreTag = "-before-restore"

    public func backup(beforeRestore: Bool = false) throws -> URL {
        let target = backupDirectory
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: target.path)
        let date = ISO8601DateFormatter().string(from: .now).replacingOccurrences(of: ":", with: "-")
        let name = "AIROOM-backup-\(date)\(beforeRestore ? Self.beforeRestoreTag : "")"
        let file = target.appendingPathComponent(name + (protector == nil ? ".json" : ".airoombackup"))
        try protectedWrite(try encode(load()), to: file)
        return file
    }

    /// Backups in the backup folder, newest first.
    public func backups() -> [BackupFile] {
        let keys: [URLResourceKey] = [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey, .creationDateKey, .contentModificationDateKey]
        let files = (try? FileManager.default.contentsOfDirectory(at: backupDirectory, includingPropertiesForKeys: keys)) ?? []
        return files.compactMap { url -> BackupFile? in
            guard ["airoombackup", "json"].contains(url.pathExtension), url.lastPathComponent.hasPrefix("AIROOM-backup-"),
                  let values = try? url.resourceValues(forKeys: Set(keys)), values.isRegularFile == true, values.isSymbolicLink != true else { return nil }
            return BackupFile(url: url, createdAt: values.creationDate ?? values.contentModificationDate ?? .distantPast,
                              bytes: values.fileSize ?? 0,
                              beforeRestore: url.deletingPathExtension().lastPathComponent.hasSuffix(Self.beforeRestoreTag))
        }
        .sorted { $0.createdAt > $1.createdAt }
    }

    /// Opens a backup without changing anything. Decrypting it is the integrity check:
    /// a damaged or altered file, or one sealed with another Mac's key, fails here.
    public func preview(_ file: URL) throws -> BackupSummary {
        BackupSummary(try decodeBackup(file))
    }

    public func restore(from file: URL) throws -> SavedState {
        let restored = try decodeBackup(file)
        _ = try backup(beforeRestore: true)
        try save(restored)
        return restored
    }

    /// Only a plain file directly inside the backup folder can be deleted.
    public func deleteBackup(_ file: URL) throws {
        let values = try file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
        guard file.deletingLastPathComponent().standardizedFileURL.path == backupDirectory.standardizedFileURL.path,
              values.isRegularFile == true, values.isSymbolicLink != true,
              backups().contains(where: { $0.url.standardizedFileURL == file.standardizedFileURL }) else {
            throw WorkspaceError.unsafeFile(file.lastPathComponent)
        }
        try FileManager.default.removeItem(at: file)
    }

    private func decodeBackup(_ file: URL) throws -> SavedState {
        let data = try Data(contentsOf: file)
        guard data.count <= 50 * 1024 * 1024 else { throw WorkspaceError.exceedsLimit(file.lastPathComponent) }
        return try decode(data)
    }
}

public struct BackupFile: Identifiable, Equatable, Sendable {
    public var id: String { url.path }
    public var url: URL
    public var createdAt: Date
    public var bytes: Int
    /// Made automatically just before a restore replaced the data.
    public var beforeRestore: Bool
}

/// What a backup holds, to look at before restoring it.
public struct BackupSummary: Equatable, Sendable {
    public var deskTopics: Int
    public var deskMessages: Int
    public var loungeTopics: Int
    public var loungeMessages: Int
    public var memberNames: [String]
    public var memories: Int
    public var roundtables: Int
    public var projects: Int
    public var schedules: Int
    public var ownerName: String

    public init(_ state: SavedState) {
        deskTopics = state.conversations.count
        deskMessages = state.conversations.reduce(0) { $0 + $1.messages.count }
        let lounges = state.rooms.filter(\.isLounge)
        loungeTopics = lounges.count
        loungeMessages = lounges.reduce(0) { $0 + $1.entries.count }
        memberNames = state.members.map(\.name)
        memories = state.members.reduce(0) { $0 + $1.memories.count }
        roundtables = state.roundtableTopics.count
        projects = state.projectFlows.count + state.projects.count
        schedules = state.schedules.count
        ownerName = state.settings.userName
    }
}
