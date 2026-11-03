import Foundation

public enum WorkspaceError: Error, LocalizedError {
    case unsafeFile(String)
    case exceedsLimit(String)
    case missing(String)
    case conflict([String])
    case invalidPhase
    public var errorDescription: String? {
        switch self {
        case .unsafeFile(let name): return "不允許符號連結、特殊檔案或不安全路徑：\(name)"
        case .exceedsLimit(let name): return "專案超出安全複製限制：\(name)"
        case .missing(let name): return "找不到工作區：\(name)"
        case .conflict(let files): return "原資料夾已有異動，未寫入：\(files.joined(separator: ", "))"
        case .invalidPhase: return "目前狀態不允許此操作"
        }
    }
}

public enum ChangeKind: String, Codable, Sendable { case added, modified, deleted }
public struct FileChange: Identifiable, Codable, Equatable, Sendable {
    public var path: String
    public var kind: ChangeKind
    public var id: String { path }
    public init(path: String, kind: ChangeKind) { self.path = path; self.kind = kind }
}

/// A copy-on-write *workflow* layer, not an OS sandbox. Vendor CLIs can access other paths
/// with their user's privileges. Never use it as a security boundary for untrusted prompts.
public final class WorkspaceStaging {
    public let storage: URL
    public let maximumFiles: Int
    public let maximumBytes: Int64
    private let fm = FileManager.default

    public init(storage: URL, maximumFiles: Int = 2000, maximumBytes: Int64 = 256 * 1024 * 1024) throws {
        self.storage = storage.standardizedFileURL
        self.maximumFiles = maximumFiles
        self.maximumBytes = maximumBytes
        try fm.createDirectory(at: self.storage, withIntermediateDirectories: true)
        try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: self.storage.path)
    }

    public func stageDirectory(_ id: UUID) -> URL { storage.appendingPathComponent(id.uuidString, isDirectory: true) }
    public func workingDirectory(_ id: UUID) -> URL { stageDirectory(id).appendingPathComponent("work", isDirectory: true) }
    public func baselineDirectory(_ id: UUID) -> URL { stageDirectory(id).appendingPathComponent("baseline", isDirectory: true) }

    /// Rejects links before copying, so copying cannot dereference a link outside the project.
    private func inventory(_ directory: URL, ignoreSensitive: Bool = false) throws -> [String: URL] {
        var files: [String: URL] = [:]
        var total: Int64 = 0
        let root = directory.standardizedFileURL
        var queue: [URL] = [root]
        while !queue.isEmpty {
            let next = queue.removeFirst()
            let items = try fm.contentsOfDirectory(at: next, includingPropertiesForKeys: [.isSymbolicLinkKey, .isRegularFileKey, .isDirectoryKey, .fileSizeKey], options: [])
            for file in items {
                let path = file.standardizedFileURL.path
                guard path.hasPrefix(root.path + "/") else { throw WorkspaceError.unsafeFile(path) }
                let relative = String(path.dropFirst(root.path.count + 1))
                // Sensitive files are never copied into a CLI-accessible work directory.
                // A newly created sensitive file in a working copy is a hard error, not
                // silently omitted from the review or accepted on writeback.
                if PrivacyGuard.blocked(relativePath: relative) {
                    if ignoreSensitive { continue }
                    throw PrivacyError.blockedPath(relative)
                }
                let values = try file.resourceValues(forKeys: [.isSymbolicLinkKey, .isRegularFileKey, .isDirectoryKey, .fileSizeKey])
                if values.isSymbolicLink == true { throw WorkspaceError.unsafeFile(relative) }
                if values.isDirectory == true { queue.append(file); continue }
                guard values.isRegularFile == true else { throw WorkspaceError.unsafeFile(relative) }
                if PrivacyGuard.unsafeContent(of: file, size: values.fileSize ?? 0) {
                    if ignoreSensitive { continue }
                    throw PrivacyError.blockedPath(relative)
                }
                total += Int64(values.fileSize ?? 0)
                files[relative] = file
                if files.count > maximumFiles || total > maximumBytes { throw WorkspaceError.exceedsLimit(relative) }
            }
        }
        return files
    }

    private func requireDirectory(_ directory: URL) throws {
        var isDirectory: ObjCBool = false
        guard fm.fileExists(atPath: directory.path, isDirectory: &isDirectory), isDirectory.boolValue else {
            throw WorkspaceError.missing(directory.path)
        }
        if (try? directory.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) == true {
            throw WorkspaceError.unsafeFile(directory.path)
        }
    }

    public func prepare(id: UUID, source: URL) throws -> URL {
        let folder = source.standardizedFileURL
        if folder.path == storage.path || folder.path.hasPrefix(storage.path + "/") || storage.path.hasPrefix(folder.path + "/") {
            throw WorkspaceError.unsafeFile("專案與工作副本存放位置不能互相包含")
        }
        try requireDirectory(folder)
        let approved = try inventory(folder, ignoreSensitive: true)
        let stage = stageDirectory(id)
        if fm.fileExists(atPath: stage.path) { throw WorkspaceError.unsafeFile("已有同一工作區，拒絕覆寫") }
        try fm.createDirectory(at: stage, withIntermediateDirectories: true)
        try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: stage.path)
        do {
            let baseline = baselineDirectory(id), work = workingDirectory(id)
            try fm.createDirectory(at: baseline, withIntermediateDirectories: true)
            try fm.createDirectory(at: work, withIntermediateDirectories: true)
            // Never call copyItem() on the source root: it would copy .env,
            // credentials, cloud profiles and hidden VCS internals as well.
            for path in approved.keys.sorted() {
                let sourceFile = approved[path]!
                for destinationRoot in [baseline, work] {
                    let destination = destinationRoot.appendingPathComponent(path)
                    try fm.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try fm.copyItem(at: sourceFile, to: destination)
                }
            }
            return work
        } catch {
            try? fm.removeItem(at: stage)
            throw error
        }
    }

    private func equalFiles(_ a: URL, _ b: URL) throws -> Bool {
        let x = try a.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? -1
        let y = try b.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? -1
        guard x == y else { return false }
        let f1 = try FileHandle(forReadingFrom: a), f2 = try FileHandle(forReadingFrom: b)
        defer { try? f1.close(); try? f2.close() }
        while true {
            let left = try f1.read(upToCount: 65536) ?? Data()
            let right = try f2.read(upToCount: 65536) ?? Data()
            if left != right { return false }
            if left.isEmpty { return true }
        }
    }

    public func changes(id: UUID) throws -> [FileChange] {
        let baseline = baselineDirectory(id), work = workingDirectory(id)
        try requireDirectory(baseline); try requireDirectory(work)
        let before = try inventory(baseline), after = try inventory(work)
        return try Set(before.keys).union(after.keys).sorted().compactMap { path in
            if before[path] == nil { return FileChange(path: path, kind: .added) }
            if after[path] == nil { return FileChange(path: path, kind: .deleted) }
            if try equalFiles(before[path]!, after[path]!) { return nil }
            return FileChange(path: path, kind: .modified)
        }
    }

    /// Human-readable preview only. Binary files are identified but not emitted.
    public func preview(id: UUID, file path: String, limit: Int = 12_000) throws -> (before: String, after: String) {
        let changes = try changes(id: id)
        guard !PrivacyGuard.blocked(relativePath: path), changes.contains(where: { $0.path == path }) else { throw WorkspaceError.unsafeFile(path) }
        func read(_ root: URL) -> String {
            let url = root.appendingPathComponent(path)
            // A missing side means the file was added (no "before") or deleted (no "after").
            guard FileManager.default.fileExists(atPath: url.path) else { return "（這一側沒有這個檔案：新增或已刪除）" }
            guard let data = try? Data(contentsOf: url), data.count <= limit, !data.contains(0),
                  let text = String(data: data, encoding: .utf8) else { return "（二進位或內容過長，不顯示）" }
            return PrivacyGuard.redact(text)
        }
        return (read(baselineDirectory(id)), read(workingDirectory(id)))
    }

    /// Refuses every changed path if the original differs from the preserved baseline.
    /// Applies a verified, user-approved changeset. On error, restores pre-apply files.
    public func apply(id: UUID, original: URL) throws -> [FileChange] {
        let folder = original.standardizedFileURL
        try requireDirectory(folder)
        if folder.path == storage.path || folder.path.hasPrefix(storage.path + "/") || storage.path.hasPrefix(folder.path + "/") {
            throw WorkspaceError.unsafeFile("來源與工作副本路徑互相包含")
        }
        let changed = try changes(id: id)
        let initial = try inventory(baselineDirectory(id)), current = try inventory(folder, ignoreSensitive: true)
        let modified = changed.map(\.path)
        let conflicts = try modified.filter { path in
            // A directory at an expected file path must never be replaced/deleted.
            let target = folder.appendingPathComponent(path)
            var isDirectory: ObjCBool = false
            if fm.fileExists(atPath: target.path, isDirectory: &isDirectory) && isDirectory.boolValue { return true }
            switch (initial[path], current[path]) {
            case (nil, nil): return false
            case (let old?, let now?): return try !equalFiles(old, now)
            default: return true
            }
        }
        if !conflicts.isEmpty { throw WorkspaceError.conflict(conflicts) }
        // Capture each changed file before writing, to permit rollback on I/O errors.
        let rollback = stageDirectory(id).appendingPathComponent("rollback", isDirectory: true)
        if fm.fileExists(atPath: rollback.path) { throw WorkspaceError.unsafeFile("回復暫存目錄已存在") }
        try fm.createDirectory(at: rollback, withIntermediateDirectories: true)
        let originalExists = Set(current.keys)
        for path in modified where originalExists.contains(path) {
            let dest = rollback.appendingPathComponent(path)
            try fm.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
            try fm.copyItem(at: folder.appendingPathComponent(path), to: dest)
        }
        var applied: [String] = []
        do {
            for change in changed {
                let destination = folder.appendingPathComponent(change.path)
                applied.append(change.path)
                if fm.fileExists(atPath: destination.path) { try fm.removeItem(at: destination) }
                if change.kind != .deleted {
                    try fm.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try fm.copyItem(at: workingDirectory(id).appendingPathComponent(change.path), to: destination)
                }
            }
        } catch {
            for path in applied.reversed() {
                let destination = folder.appendingPathComponent(path)
                if fm.fileExists(atPath: destination.path) { try? fm.removeItem(at: destination) }
                if originalExists.contains(path) {
                    try? fm.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try? fm.copyItem(at: rollback.appendingPathComponent(path), to: destination)
                }
            }
            throw error
        }
        try? fm.removeItem(at: rollback)
        return changed
    }

    /// After a write-back, the written state becomes the new baseline.
    public func rebaseline(id: UUID) throws {
        let baseline = baselineDirectory(id), work = workingDirectory(id)
        try requireDirectory(work)
        _ = try inventory(work) // refuse links / sensitive files before copying
        let fresh = stageDirectory(id).appendingPathComponent("baseline-next", isDirectory: true)
        if fm.fileExists(atPath: fresh.path) { try fm.removeItem(at: fresh) }
        try fm.copyItem(at: work, to: fresh)
        if fm.fileExists(atPath: baseline.path) { try fm.removeItem(at: baseline) }
        try fm.moveItem(at: fresh, to: baseline)
    }

    public func discard(id: UUID) throws {
        let directory = stageDirectory(id)
        guard directory.deletingLastPathComponent().standardizedFileURL == storage else { throw WorkspaceError.unsafeFile(directory.path) }
        if fm.fileExists(atPath: directory.path) { try fm.removeItem(at: directory) }
    }
}
