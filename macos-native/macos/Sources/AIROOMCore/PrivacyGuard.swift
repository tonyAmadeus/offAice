import Foundation

public enum PrivacyError: Error, LocalizedError {
    case sensitivePrompt
    case blockedPath(String)
    case unsafeExecutable(String)

    public var errorDescription: String? {
        switch self {
        case .sensitivePrompt: return "偵測到疑似 API Key、Token 或私鑰。請先移除機密資訊再送出。 / Possible credential detected in prompt."
        case .blockedPath(let name): return "禁止存取機密檔案：\(name) / Sensitive path blocked"
        case .unsafeExecutable(let name): return "執行檔來源無法驗證，拒絕執行：\(name)"
        }
    }
}

/// A defense-in-depth guard, NOT a replacement for sandboxing or vendor CLI privacy controls.
public enum PrivacyGuard {
    private static let blockedDirectories: Set<String> = [
        ".git", ".ssh", ".gnupg", ".aws", ".azure", ".config/gcloud", ".kube", ".docker",
        ".npm", ".claude", ".codex", ".cursor", ".vscode", "secrets", "private", "credentials",
        "node_modules", ".env", ".venv", "venv", "__pycache__", ".idea"
    ]
    private static let blockedNames: Set<String> = [
        ".env", ".env.local", ".env.production", ".env.development", ".npmrc", ".netrc",
        ".pypirc", "id_rsa", "id_ed25519", "id_ecdsa", "known_hosts", "authorized_keys",
        "credentials.json", "auth.json", "secrets.json", "service-account.json", "service_account.json",
        "terraform.tfstate", "terraform.tfstate.backup", "keychain", "login.keychain-db"
    ]
    private static let blockedExtensions: Set<String> = ["pem", "p12", "pfx", "key", "jks", "keystore", "mobileprovision", "tfstate", "db", "sqlite", "sqlite3", "kdbx", "asc", "gpg"]
    private static let secretPatterns: [NSRegularExpression] = [
        #"(?i)\b(?:sk-(?:ant-|proj-)?[a-z0-9_-]{16,}|gh[opurs]_[a-z0-9_]{20,}|github_pat_[a-z0-9_]{20,}|xox[baprs]-[a-z0-9-]{15,}|AKIA[0-9A-Z]{16})\b"#,
        #"(?i)\b(?:Bearer|Basic)\s+[a-z0-9._~+/=-]{12,}"#,
        #"(?i)\b(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET|PASSWORD|AUTH_TOKEN)\s*[:=]\s*['\"]?\S{8,}"#,
        #"-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----"#
    ].compactMap { try? NSRegularExpression(pattern: $0) }

    public static func blocked(relativePath: String) -> Bool {
        let normalized = relativePath.replacingOccurrences(of: "\\", with: "/").lowercased()
        let components = normalized.split(separator: "/").map(String.init)
        guard !components.isEmpty else { return false }
        for (index, part) in components.enumerated() {
            if blockedNames.contains(part) || blockedDirectories.contains(part) { return true }
            if part.hasPrefix(".env.") || part.hasSuffix(".secret") || part.hasSuffix(".secrets") { return true }
            if blockedExtensions.contains((part as NSString).pathExtension) { return true }
            if index > 0 && part == "config" && components[index - 1] == ".config" && index + 1 < components.count && components[index + 1] == "gcloud" { return true }
        }
        return false
    }

    private static let scannableText: Set<String> = ["txt", "md", "json", "yaml", "yml", "toml", "ini", "xml", "swift", "ts", "tsx", "js", "jsx", "py", "rb", "rs", "go", "c", "h", "cpp", "hpp", "java", "kt", "sh", "zsh", "env", "sql", "css", "html", "gradle", "properties", "conf"]

    /// Scan text inputs before putting them in a vendor CLI work copy. Unknown large
    /// blobs are not considered safe just because the filename looks innocent.
    public static func unsafeContent(of file: URL, size: Int) -> Bool {
        if size > 1_048_576 { return scannableText.contains(file.pathExtension.lowercased()) }
        guard let data = try? Data(contentsOf: file), !data.contains(0),
              let text = String(data: data, encoding: .utf8) else { return false }
        return containsSecrets(text)
    }

    public static func containsSecrets(_ text: String) -> Bool {
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        return secretPatterns.contains { $0.firstMatch(in: text, range: range) != nil }
    }

    public static func validatePrompt(_ text: String) throws {
        if containsSecrets(text) { throw PrivacyError.sensitivePrompt }
    }

    public static func redact(_ text: String) -> String {
        var value = text
        for expression in secretPatterns {
            value = expression.stringByReplacingMatches(in: value, range: NSRange(value.startIndex..<value.endIndex, in: value), withTemplate: "[REDACTED]")
        }
        return value
    }

    /// Explicit allowlist: do not inherit API keys, cookies, cloud credentials, SSH agents,
    /// DYLD injections, NODE_OPTIONS or host-app session tokens into agent processes.
    public static func cliEnvironment(
        from source: [String: String], executable: URL, home: String = NSHomeDirectory()
    ) -> [String: String] {
        let allowed = ["HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TERM", "NO_COLOR"]
        var env = source.filter { allowed.contains($0.key) }
        env["HOME"] = source["HOME"] ?? home
        env["PATH"] = ([executable.deletingLastPathComponent().path] + CommandPlan.fallbackPATH).joined(separator: ":")
        env["AIROOM_CLAUDE_DEBUG"] = "0" // Native app never enables upstream debug capture.
        return env
    }
}
