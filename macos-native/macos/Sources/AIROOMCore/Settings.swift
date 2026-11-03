import Foundation

public enum InterfaceLanguage: String, Codable, CaseIterable, Identifiable, Sendable {
    case zhTW = "zh-Hant"
    case english = "en"
    public var id: String { rawValue }
    public var title: String { self == .zhTW ? "繁體中文" : "English" }
}

public struct NativeSettings: Codable, Equatable, Sendable {
    public var claudePath: String
    public var codexPath: String
    public var workspacePath: String
    public var language: InterfaceLanguage
    /// How members address the user (設定 → 個人資料). Empty = a neutral default.
    public var userName: String

    public init(claudePath: String = "", codexPath: String = "", workspacePath: String = "",
                language: InterfaceLanguage = .zhTW, userName: String = "") {
        self.claudePath = claudePath
        self.codexPath = codexPath
        self.workspacePath = workspacePath
        self.language = language
        self.userName = String(userName.prefix(40))
    }

    private enum CodingKeys: String, CodingKey { case claudePath, codexPath, workspacePath, language, userName }

    public init(from decoder: Decoder) throws {
        let box = try decoder.container(keyedBy: CodingKeys.self)
        claudePath = try box.decodeIfPresent(String.self, forKey: .claudePath) ?? ""
        codexPath = try box.decodeIfPresent(String.self, forKey: .codexPath) ?? ""
        workspacePath = try box.decodeIfPresent(String.self, forKey: .workspacePath) ?? ""
        language = try box.decodeIfPresent(InterfaceLanguage.self, forKey: .language) ?? .zhTW
        userName = try box.decodeIfPresent(String.self, forKey: .userName) ?? ""
    }

    /// Name used in prompts for the human owner.
    public var ownerName: String {
        let name = userName.trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? (language == .english ? "the user" : "使用者") : name
    }

    public func configuredPath(for agent: AgentKind) -> String {
        agent == .claude ? claudePath : codexPath
    }
}

public enum NativeCLIError: Error, LocalizedError {
    case executableMissing(String)
    case invalidWorkspace(String)
    case invalidPrompt
    case processFailed(String)
    case noResponse(String)

    public var errorDescription: String? {
        switch self {
        case .executableMissing(let name):
            if name == "claude" {
                return "找不到 Claude Code。請先在 Claude Desktop 開啟 Code 分頁安裝內附執行端，或在設定指定 claude 的完整執行檔路徑。"
            }
            return "找不到可執行的 \(name)。可使用 ChatGPT.app / Codex.app 內附的 codex-cli，或在設定指定完整執行檔路徑。"
        case .invalidWorkspace(let directory): return "工作資料夾不存在：\(directory)"
        case .invalidPrompt: return "請輸入內容（最多 30,000 字）。"
        case .processFailed(let message): return message
        case .noResponse(let name): return "\(name) 未輸出可辨識的回覆，沒有自動重送請求。"
        }
    }
}

/// readOnly: no tools. readFiles: may read the (copied) working folder. stagedWrite: may edit it.
public enum ExecutionAccess: Sendable { case readOnly, readFiles, stagedWrite }

public enum CommandPlan {
    public static let fallbackPATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/opt/local/bin"]

    /// The desktop product moved from Codex.app to ChatGPT.app, and newer
    /// macOS builds package the command inside CodexCLI.app. Prefer the vendor's
    /// launcher (which resolves its own resources) over the nested Mach-O.
    /// Do not scan arbitrary user directories or start the GUI application.
    public static func bundledCodexPaths(home: String = NSHomeDirectory()) -> [String] {
        let apps = ["/Applications/ChatGPT.app", "\(home)/Applications/ChatGPT.app",
                    "/Applications/Codex.app", "\(home)/Applications/Codex.app"]
        return apps.flatMap { app in
            ["\(app)/Contents/Resources/codex-cli/bin/codex",
             "\(app)/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
             "\(app)/Contents/Resources/codex"]
        }
    }

    /// Claude Desktop installs an independent, versioned Claude Code executable
    /// after its Code tab has been used. The location is intentionally distinct
    /// from /Applications/Claude.app, which is the Electron GUI, not a CLI.
    /// Use the latest numeric version and re-resolve on each invocation, because
    /// the desktop updater can replace/remove a version directory.
    public static func bundledClaudePaths(home: String = NSHomeDirectory(),
                                           fileManager: FileManager = .default) -> [String] {
        let parent = (home as NSString).appendingPathComponent("Library/Application Support/Claude/claude-code")
        guard let entries = try? fileManager.contentsOfDirectory(atPath: parent) else { return [] }
        func version(_ name: String) -> [Int]? {
            let pieces = name.split(separator: ".", omittingEmptySubsequences: false)
            guard pieces.count >= 2, pieces.count <= 4,
                  pieces.allSatisfy({ !$0.isEmpty && $0.allSatisfy(\.isNumber) }) else { return nil }
            let nums = pieces.compactMap { Int($0) }
            return nums.count == pieces.count ? nums : nil
        }
        let ordered = entries.compactMap { name -> (String, [Int])? in
            guard let parsed = version(name) else { return nil }
            var isDirectory: ObjCBool = false
            guard fileManager.fileExists(atPath: (parent as NSString).appendingPathComponent(name),
                                         isDirectory: &isDirectory), isDirectory.boolValue else { return nil }
            return (name, parsed)
        }.sorted { a, b in
            for index in 0..<max(a.1.count, b.1.count) {
                let left = index < a.1.count ? a.1[index] : 0
                let right = index < b.1.count ? b.1[index] : 0
                if left != right { return left > right }
            }
            return a.0 > b.0
        }
        return ordered.flatMap { name, _ in
            let base = (parent as NSString).appendingPathComponent(name)
            // Newer desktop builds add a content-hash level:
            // <version>/<hash>/claude.app. Prefer hashes the updater marked `.verified`.
            let hashes = ((try? fileManager.contentsOfDirectory(atPath: base)) ?? []).filter { hash in
                var isDirectory: ObjCBool = false
                return !hash.isEmpty && hash.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) })
                    && fileManager.fileExists(atPath: (base as NSString).appendingPathComponent(hash),
                                              isDirectory: &isDirectory) && isDirectory.boolValue
            }.sorted { a, b in
                let verifiedA = fileManager.fileExists(atPath: "\(base)/\(a)/.verified")
                let verifiedB = fileManager.fileExists(atPath: "\(base)/\(b)/.verified")
                return verifiedA != verifiedB ? verifiedA : a < b
            }
            return hashes.map { "\(base)/\($0)/claude.app/Contents/MacOS/claude" }
                + ["\(base)/claude.app/Contents/MacOS/claude", "\(base)/claude"]
        }
    }

    public static func resolveExecutable(agent: AgentKind, settings: NativeSettings,
                                         environment: [String: String] = ProcessInfo.processInfo.environment,
                                         home: String = NSHomeDirectory()) throws -> URL {
        let configured = settings.configuredPath(for: agent).trimmingCharacters(in: .whitespacesAndNewlines)
        let candidates: [String]
        if !configured.isEmpty {
            let expanded = (configured as NSString).expandingTildeInPath
            // A Finder path to CodexCLI.app is a bundle directory, not executable.
            // Resolve only this known official CLI bundle naming convention.
            if agent == .codex && expanded.hasSuffix("/CodexCLI.app") {
                candidates = [expanded + "/Contents/MacOS/codex"]
            } else if agent == .claude && (expanded.hasSuffix("/claude.app") || expanded.hasSuffix("/ClaudeCode.app")) {
                candidates = [expanded + "/Contents/MacOS/claude"]
            } else {
                candidates = [expanded]
            }
        } else {
            let path = (environment["PATH"] ?? "").split(separator: ":").map(String.init)
            let homeDirs = ["\(home)/.local/bin", "\(home)/bin", "\(home)/.npm-global/bin", "\(home)/.bun/bin"]
            let bundled = agent == .codex ? bundledCodexPaths(home: home) : bundledClaudePaths(home: home)
            candidates = bundled + (path + fallbackPATH + homeDirs).map {
                ($0 as NSString).appendingPathComponent(agent.executableName)
            }
        }
        for candidate in candidates {
            let expanded = (candidate as NSString).expandingTildeInPath
            let absolute = URL(fileURLWithPath: expanded).standardizedFileURL
            if FileManager.default.isExecutableFile(atPath: absolute.path) &&
                !((try? absolute.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? true) {
                let resolved = absolute.resolvingSymlinksInPath()
                try ArchitectureGuard.verifyDirectExecutable(resolved)
                return resolved
            }
        }
        throw NativeCLIError.executableMissing(agent.executableName)
    }

    public static func arguments(for agent: AgentKind, access: ExecutionAccess = .readOnly,
                                 options: CLIRunOptions = CLIRunOptions()) -> [String] {
        switch agent {
        case .codex:
            // Explicitly read-only. No --full-auto / --dangerously-bypass flags.
            return ["exec", "--json", "--sandbox", access == .stagedWrite ? "workspace-write" : "read-only", "--skip-git-repo-check", "-"]
        case .claude:
            // Print mode via stdin; empty tools list disables tool execution for MVP.
            // Read-only runs get no tools. Writing runs (member desk folders) get
            // file tools only — no Bash or network — and edits are auto-accepted
            // inside the working directory; anything outside it is denied.
            var claude = ["--print", "--output-format", "stream-json", "--include-partial-messages", "--verbose"]
                + (access == .readOnly ? ["--tools", ""]
                   : access == .readFiles ? ["--tools", "Read,Glob,Grep"]
                   : ["--tools", "Read,Edit,Write,Glob,Grep", "--permission-mode", "acceptEdits"])
            if !options.model.isEmpty { claude += ["--model", options.model] }
            if !options.effort.isEmpty { claude += ["--effort", options.effort] }
            if let resume = options.session?.resumeID { claude += ["--resume", resume] }
            // Images and PDFs travel as content blocks in one stream-json user message.
            if !options.attachments.isEmpty { claude += ["--input-format", "stream-json"] }
            return claude
        }
    }

    public static func workingDirectory(settings: NativeSettings, fallback: URL) throws -> URL {
        let value = settings.workspacePath.trimmingCharacters(in: .whitespacesAndNewlines)
        let path = value.isEmpty ? fallback.path : (value as NSString).expandingTildeInPath
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory), isDirectory.boolValue else {
            throw NativeCLIError.invalidWorkspace(path)
        }
        return URL(fileURLWithPath: path).standardizedFileURL
    }
}
