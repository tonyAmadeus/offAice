import Foundation

/// Official, documented desktop deep links. These are *handoffs*, not an SDK and
/// not access to the desktop application's private state or credentials.
public enum DesktopAppHandoff {
    public enum LinkError: Error, LocalizedError {
        case invalidDirectory(String)

        public var errorDescription: String? {
            switch self {
            case .invalidDirectory(let path):
                return "請先選取存在的本機工作資料夾：\(path) / Choose an existing local folder."
            }
        }
    }

    /// No prompt, transcript, API key, session token, or account identifier is
    /// ever added to these URLs. Workspace handoff only happens after the user
    /// explicitly chooses a folder and presses the corresponding button.
    public static func newCodeSession(agent: AgentKind, selectedWorkspace: String = "") throws -> URL {
        let destination = agent == .codex ? "codex://threads/new" : "claude://code/new"
        guard var components = URLComponents(string: destination) else {
            preconditionFailure("Invalid hardcoded official application URL")
        }
        let workspace = selectedWorkspace.trimmingCharacters(in: .whitespacesAndNewlines)
        if !workspace.isEmpty {
            let expanded = (workspace as NSString).expandingTildeInPath
            guard expanded.hasPrefix("/"), !expanded.contains("\0") else { throw LinkError.invalidDirectory(workspace) }
            let resolved = URL(fileURLWithPath: expanded, isDirectory: true).standardizedFileURL.resolvingSymlinksInPath()
            var directory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: resolved.path, isDirectory: &directory), directory.boolValue else {
                throw LinkError.invalidDirectory(workspace)
            }
            components.queryItems = [URLQueryItem(name: agent == .codex ? "path" : "folder", value: resolved.path)]
        }
        guard let url = components.url else { preconditionFailure("Invalid desktop app URL encoding") }
        return url
    }
}

public enum OfficialCLIStatus: String, Equatable, Sendable {
    case checking, authenticated, notLoggedIn, notConfirmed, missingExecutable, timedOut
}

/// Read-only status probes use the vendor's own public CLI commands. The app
/// never opens ~/.codex/auth.json, Claude credentials, browser cookies or the
/// Keychain. A successful CLI check does not prove the desktop GUI is signed
/// into the same account or that GUI threads are shared with AIROOM.
public enum OfficialCLIProbe {
    public static func check(
        agent: AgentKind, settings: NativeSettings,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        home: String = NSHomeDirectory(), timeout: TimeInterval = 8
    ) -> OfficialCLIStatus {
        let executable: URL
        do { executable = try CommandPlan.resolveExecutable(agent: agent, settings: settings, environment: environment, home: home) }
        catch { return .missingExecutable }
        let child = Process()
        child.executableURL = executable
        child.arguments = agent == .codex ? ["login", "status"] : ["auth", "status"]
        child.environment = PrivacyGuard.cliEnvironment(from: environment, executable: executable, home: home)
        child.standardInput = FileHandle.nullDevice
        // `claude auth status` prints a small JSON report (no token values).
        let output = Pipe()
        child.standardOutput = output
        child.standardError = FileHandle.nullDevice
        let finished = DispatchSemaphore(value: 0)
        child.terminationHandler = { _ in finished.signal() }
        do { try child.run() }
        catch { return .notConfirmed }
        if finished.wait(timeout: .now() + max(0.2, timeout)) == .timedOut {
            if child.isRunning { child.terminate() }
            return .timedOut
        }
        let report = output.fileHandleForReading.readDataToEndOfFile()
        return interpret(exitCode: child.terminationStatus, output: report)
    }

    /// Claude Desktop authenticates its own Code tab by passing credentials to
    /// the child it launches; a standalone invocation of the same executable
    /// reports `"loggedIn": false` until `claude auth login` has been run once.
    public static func interpret(exitCode: Int32, output: Data) -> OfficialCLIStatus {
        if let report = try? JSONSerialization.jsonObject(with: output.prefix(64_000)) as? [String: Any],
           let loggedIn = report["loggedIn"] as? Bool {
            return loggedIn ? .authenticated : .notLoggedIn
        }
        let text = String(decoding: output.prefix(4_000), as: UTF8.self).lowercased()
        if text.contains("not logged in") { return .notLoggedIn }
        return exitCode == 0 ? .authenticated : .notConfirmed
    }
}
