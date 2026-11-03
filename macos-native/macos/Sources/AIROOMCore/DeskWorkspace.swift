import Foundation

/// Member-desk working folders, as upstream AIROOM defines them:
/// - the member's **personal folder** is edited in place;
/// - **any other folder** is edited in a per-topic task copy, written back
///   only on request (conflict-checked by WorkspaceStaging).
/// Each round that may write is preceded by a snapshot, so "undo last round"
/// restores the working folder and, if that round was already written back,
/// the original files too.
public final class DeskWorkspace {
    public let root: URL
    public let staging: WorkspaceStaging
    private let fm = FileManager.default

    public init(root: URL) throws {
        self.root = root.standardizedFileURL
        try fm.createDirectory(at: self.root, withIntermediateDirectories: true)
        try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: self.root.path)
        staging = try WorkspaceStaging(storage: self.root.appendingPathComponent("copies", isDirectory: true))
    }

    public func personalFolder(_ agent: AgentKind) throws -> URL {
        let folder = root.appendingPathComponent("members/\(agent.executableName)/home", isDirectory: true)
        try fm.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }

    public func hasCopy(topic: UUID) -> Bool { fm.fileExists(atPath: staging.workingDirectory(topic).path) }

    /// The folder the CLI works in for this topic (creating the task copy on first use).
    public func workingFolder(topic: UUID, agent: AgentKind, original: String) throws -> URL {
        guard !original.isEmpty else { return try personalFolder(agent) }
        if hasCopy(topic: topic) { return staging.workingDirectory(topic) }
        return try staging.prepare(id: topic, source: URL(fileURLWithPath: original))
    }

    public func changes(topic: UUID) throws -> [FileChange] {
        hasCopy(topic: topic) ? try staging.changes(id: topic) : []
    }

    // MARK: Rounds and undo

    private func roundDirectory(_ topic: UUID) -> URL {
        root.appendingPathComponent("rounds/\(topic.uuidString)", isDirectory: true)
    }
    private var manifestName: String { "applied.json" }

    public func canUndo(topic: UUID) -> Bool { fm.fileExists(atPath: roundDirectory(topic).path) }

    /// Snapshot before a writing round; replaces the previous round's snapshot.
    public func beginRound(topic: UUID, agent: AgentKind, original: String) throws {
        let round = roundDirectory(topic)
        if fm.fileExists(atPath: round.path) { try fm.removeItem(at: round) }
        try fm.createDirectory(at: round, withIntermediateDirectories: true)
        if original.isEmpty {
            try fm.copyItem(at: try personalFolder(agent), to: round.appendingPathComponent("work"))
        } else {
            _ = try workingFolder(topic: topic, agent: agent, original: original)
            try fm.copyItem(at: staging.workingDirectory(topic), to: round.appendingPathComponent("work"))
            try fm.copyItem(at: staging.baselineDirectory(topic), to: round.appendingPathComponent("baseline"))
        }
    }

    /// Writes the copy's changes back to the original folder, then treats the
    /// written state as the new baseline so later rounds diff from here.
    @discardableResult
    public func apply(topic: UUID, original: String) throws -> [FileChange] {
        let folder = URL(fileURLWithPath: original)
        let changed = try staging.changes(id: topic)
        guard !changed.isEmpty else { return [] }
        // Keep the originals of this write-back so undo can restore them.
        let round = roundDirectory(topic)
        let saved = round.appendingPathComponent("applied-originals", isDirectory: true)
        if canUndo(topic: topic) {
            if fm.fileExists(atPath: saved.path) { try fm.removeItem(at: saved) }
            try fm.createDirectory(at: saved, withIntermediateDirectories: true)
            for change in changed where change.kind != .added {
                let source = folder.appendingPathComponent(change.path)
                guard fm.fileExists(atPath: source.path) else { continue }
                let target = saved.appendingPathComponent(change.path)
                try fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
                try fm.copyItem(at: source, to: target)
            }
        }
        let applied = try staging.apply(id: topic, original: folder)
        try staging.rebaseline(id: topic)
        if canUndo(topic: topic) {
            try JSONEncoder().encode(applied).write(to: round.appendingPathComponent(manifestName))
        }
        return applied
    }

    /// Restores the state from before the last writing round. If that round
    /// was written back, the original files are restored as well — but only
    /// when they still hold exactly what AIROOM wrote.
    public func undoRound(topic: UUID, agent: AgentKind, original: String) throws {
        let round = roundDirectory(topic)
        guard fm.fileExists(atPath: round.path) else { throw WorkspaceError.invalidPhase }
        let manifest = round.appendingPathComponent(manifestName)
        if !original.isEmpty, let data = try? Data(contentsOf: manifest) {
            let applied = try JSONDecoder().decode([FileChange].self, from: data)
            let folder = URL(fileURLWithPath: original)
            let written = staging.workingDirectory(topic)
            let conflicts = applied.filter { change in
                let current = folder.appendingPathComponent(change.path)
                if change.kind == .deleted { return fm.fileExists(atPath: current.path) }
                return !fm.contentsEqual(atPath: current.path, andPath: written.appendingPathComponent(change.path).path)
            }
            guard conflicts.isEmpty else { throw WorkspaceError.conflict(conflicts.map(\.path)) }
            let saved = round.appendingPathComponent("applied-originals")
            for change in applied {
                let current = folder.appendingPathComponent(change.path)
                if fm.fileExists(atPath: current.path) { try fm.removeItem(at: current) }
                if change.kind != .added {
                    try fm.createDirectory(at: current.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try fm.copyItem(at: saved.appendingPathComponent(change.path), to: current)
                }
            }
        }
        if original.isEmpty {
            try replace(try personalFolder(agent), with: round.appendingPathComponent("work"))
        } else {
            try replace(staging.workingDirectory(topic), with: round.appendingPathComponent("work"))
            try replace(staging.baselineDirectory(topic), with: round.appendingPathComponent("baseline"))
        }
        try fm.removeItem(at: round)
    }

    /// Drops the task copy (and any undo snapshot). The original is untouched.
    public func discard(topic: UUID) throws {
        try staging.discard(id: topic)
        let round = roundDirectory(topic)
        if fm.fileExists(atPath: round.path) { try fm.removeItem(at: round) }
    }

    private func replace(_ folder: URL, with snapshot: URL) throws {
        if fm.fileExists(atPath: folder.path) { try fm.removeItem(at: folder) }
        try fm.copyItem(at: snapshot, to: folder)
    }
}
