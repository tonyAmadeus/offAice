import Foundation
import CoreFoundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

/// Account subscription limits reported by the official executables, not inferred from token usage.
/// A missing or expired sample MUST NOT be presented as zero quota.
public struct QuotaWindow: Equatable, Sendable, Identifiable {
    public let id: String
    public let label: String
    public let usedPercent: Double
    public let resetsAt: Date?
    public var remainingPercent: Double { max(0, 100 - usedPercent) }
    public var exhausted: Bool { usedPercent >= 100 }
}

public struct AccountQuota: Equatable, Sendable {
    public enum Status: String, Equatable, Sendable { case ready, unavailable }
    public let agent: AgentKind
    public let checkedAt: Date
    public let status: Status
    public let windows: [QuotaWindow]
    public init(agent: AgentKind, checkedAt: Date = .now, windows: [QuotaWindow]) {
        self.agent = agent
        self.checkedAt = checkedAt
        self.windows = windows
        self.status = windows.isEmpty ? .unavailable : .ready
    }
    public func isFresh(at date: Date = .now) -> Bool {
        let elapsed = date.timeIntervalSince(checkedAt)
        return elapsed >= 0 && elapsed <= 15 * 60
    }
}

public enum QuotaProjection {
    private static func dictionary(_ value: Any?) -> [String: Any] { value as? [String: Any] ?? [:] }
    private static func validPercent(_ value: Any?) -> Double? {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        let result = n.doubleValue
        return result.isFinite && (0...100).contains(result) ? result : nil
    }
    private static func resetTimestamp(_ value: Any?) -> Date? {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue > 0, n.doubleValue.isFinite else { return nil }
        return Date(timeIntervalSince1970: n.doubleValue)
    }
    public static func codex(_ source: Any?) -> [QuotaWindow] {
        let result = dictionary(source)
        let data = dictionary(result["accountRateLimits"] ?? source)
        let byID = dictionary(data["rateLimitsByLimitId"])
        let rows: [(String, [String: Any])] = byID.isEmpty
            ? (data["rateLimits"] == nil ? [] : [("codex", dictionary(data["rateLimits"]))])
            : byID.keys.sorted().map { ($0, dictionary(byID[$0])) }
        var output: [QuotaWindow] = []
        for (identifier, row) in rows.prefix(40) {
            for key in ["primary", "secondary"] {
                let item = dictionary(row[key])
                guard let used = validPercent(item["usedPercent"]) else { continue }
                let minutes = (item["windowDurationMins"] as? NSNumber)?.intValue
                let duration = minutes == 300 ? "5 小時" : minutes == 10080 ? "每週" : minutes.map { "\($0) 分鐘" } ?? key
                let name = (row["limitName"] as? String).flatMap { $0.count <= 80 ? $0 : nil }
                let title = rows.count > 1 ? "\(name ?? identifier) · \(duration)" : duration
                output.append(QuotaWindow(id: "\(identifier):\(key)", label: title, usedPercent: used,
                                          resetsAt: resetTimestamp(item["resetsAt"])))
            }
        }
        return output
    }
    public static func claude(_ source: Any?) -> [QuotaWindow] {
        let report = dictionary(source)
        let limits = dictionary(report["rate_limits"])["limits"] as? [Any] ?? []
        guard limits.count <= 40 else { return [] }
        return limits.compactMap { entry -> QuotaWindow? in
            let row = dictionary(entry)
            guard let kind = row["kind"] as? String,
                  ["session", "weekly_all", "weekly_scoped"].contains(kind),
                  let used = validPercent(row["percent"]) else { return nil }
            let scopedName = dictionary(dictionary(row["scope"])["model"])["display_name"] as? String
            let name = kind == "session" ? "5 小時" : kind == "weekly_all" ? "每週" : "每週 \(String((scopedName ?? "模型").prefix(60)))"
            let iso = row["resets_at"] as? String
            let reset = iso.flatMap { ISO8601DateFormatter().date(from: $0) }
            return QuotaWindow(id: kind + ":" + (kind == "weekly_scoped" ? (scopedName ?? "") : ""), label: name, usedPercent: used, resetsAt: reset)
        }
    }
}

/// A small, read-only protocol state machine. It explicitly verifies Claude's
/// built-in /usage command before sending it, and refuses tool requests.
public struct QuotaWire {
    public let agent: AgentKind
    public private(set) var windows: [QuotaWindow] = []
    public private(set) var finished = false
    public private(set) var failed = false
    public private(set) var sentQuery = false
    public let requestID: String

    public init(agent: AgentKind, requestID: String = UUID().uuidString) {
        self.agent = agent
        self.requestID = requestID
    }

    public mutating func receive(_ line: String) -> [[String: Any]] {
        guard let data = line.data(using: .utf8),
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [] }
        if agent == .codex {
            if let id = value["id"] as? Int, id == 2 {
                if value["error"] != nil { failed = true }
                else { windows = QuotaProjection.codex(value["result"]); finished = true }
            }
            if value["method"] != nil && value["id"] != nil {
                return [["id": value["id"]!, "error": ["code": -32601, "message": "Read-only usage query"]]]
            }
            return []
        }
        let kind = value["type"] as? String
        if kind == "control_response", let response = value["response"] as? [String: Any],
           response["request_id"] as? String == requestID && !sentQuery {
            let supported = (response["response"] as? [String: Any])?["commands"] as? [[String: Any]] ?? []
            guard response["subtype"] as? String == "success",
                  supported.contains(where: { $0["name"] as? String == "usage" && $0["builtin"] as? Bool == true }) else {
                failed = true; return []
            }
            sentQuery = true
            return [["type": "user", "uuid": UUID().uuidString, "parent_tool_use_id": NSNull(), "session_id": "",
                     "message": ["role": "user", "content": "/usage"]]]
        }
        if kind == "control_request" {
            failed = true
            return [["type": "control_response", "response": ["subtype": "error", "request_id": value["request_id"] ?? "", "error": "Usage query does not permit tools"]]]
        }
        if sentQuery && kind == "assistant" {
            let message = value["message"] as? [String: Any] ?? [:]
            let content = message["content"] as? [[String: Any]] ?? []
            if content.contains(where: { $0["type"] as? String == "tool_use" }) { failed = true; return [] }
            if let report = value["usage_report"] { windows = QuotaProjection.claude(report) }
        }
        if sentQuery && kind == "result" {
            let ok = value["subtype"] as? String == "success" && value["is_error"] as? Bool != true &&
                value["local_command"] as? String == "usage" && (value["num_turns"] as? Int) == 0
            if ok { finished = true } else { failed = true }
        }
        return []
    }
}

public final class AccountQuotaReader {
    public init() { _ = signal(SIGPIPE, SIG_IGN) }

    public func query(agent: AgentKind, settings: NativeSettings,
                      timeout: TimeInterval = 15) async -> AccountQuota {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .utility).async {
                let windows = (try? self.queryBlocking(agent: agent, settings: settings, timeout: timeout)) ?? []
                continuation.resume(returning: AccountQuota(agent: agent, windows: windows))
            }
        }
    }

    private func queryBlocking(agent: AgentKind, settings: NativeSettings, timeout: TimeInterval) throws -> [QuotaWindow] {
        let binary = try CommandPlan.resolveExecutable(agent: agent, settings: settings)
        let task = Process()
        task.executableURL = binary
        task.arguments = agent == .codex ? ["app-server", "--listen", "stdio://"] : [
            "--restricted", "-p", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json",
            "--no-session-persistence", "--tools", "", "--strict-mcp-config", "--mcp-config", "{\"mcpServers\":{}}"
        ]
        task.environment = PrivacyGuard.cliEnvironment(from: ProcessInfo.processInfo.environment, executable: binary)
        task.currentDirectoryURL = FileManager.default.temporaryDirectory
        let stdin = Pipe(), stdout = Pipe(), stderr = Pipe()
        task.standardInput = stdin; task.standardOutput = stdout; task.standardError = stderr
        try task.run()
        try? stdin.fileHandleForReading.close()
        try? stdout.fileHandleForWriting.close()
        try? stderr.fileHandleForWriting.close()
        defer {
            if task.isRunning {
                _ = kill(task.processIdentifier, SIGTERM)
                for _ in 0..<10 where task.isRunning { Thread.sleep(forTimeInterval: 0.05) }
                if task.isRunning { _ = kill(task.processIdentifier, SIGKILL) }
            }
            task.waitUntilExit()
            try? stdin.fileHandleForWriting.close()
            try? stdout.fileHandleForReading.close()
            try? stderr.fileHandleForReading.close()
        }
        func send(_ value: [String: Any]) throws {
            var data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes])
            data.append(0x0a)
            try stdin.fileHandleForWriting.write(contentsOf: data)
        }
        var wire = QuotaWire(agent: agent)
        if agent == .codex {
            try send(["id": 1, "method": "initialize", "params": ["clientInfo": ["name": "airoom_native", "title": "AIROOM Native", "version": "0.3.0"]]])
        } else {
            try send(["type": "control_request", "request_id": wire.requestID, "request": ["subtype": "initialize"]])
        }
        let outFD = stdout.fileHandleForReading.fileDescriptor
        let errFD = stderr.fileHandleForReading.fileDescriptor
        var stderrEnded = false, buffer = Data(), initialized = false
        let deadline = ProcessInfo.processInfo.systemUptime + max(1, timeout)
        while ProcessInfo.processInfo.systemUptime < deadline {
            var fds = [pollfd(fd: outFD, events: Int16(POLLIN | POLLHUP), revents: 0),
                       pollfd(fd: stderrEnded ? -1 : errFD, events: Int16(POLLIN | POLLHUP), revents: 0)]
            let count = fds.withUnsafeMutableBufferPointer { poll($0.baseAddress, nfds_t($0.count), 200) }
            if count < 0 { if errno == EINTR { continue }; return [] }
            if count == 0 { continue }
            if fds[1].revents != 0 && !stderrEnded {
                var bytes = [UInt8](repeating: 0, count: 8192)
                let n = read(errFD, &bytes, bytes.count)
                if n <= 0 { stderrEnded = true }
            }
            if fds[0].revents == 0 { continue }
            var bytes = [UInt8](repeating: 0, count: 8192)
            let n = read(outFD, &bytes, bytes.count)
            if n == 0 { return [] }
            if n < 0 { if errno == EINTR { continue }; return [] }
            buffer.append(contentsOf: bytes.prefix(n))
            if buffer.count > 2 * 1_024 * 1_024 { return [] }
            while let end = buffer.firstIndex(of: 0x0a) {
                let line = String(decoding: buffer[..<end], as: UTF8.self)
                buffer.removeSubrange(...end)
                if agent == .codex, !initialized,
                   let data = line.data(using: .utf8),
                   let packet = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   packet["id"] as? Int == 1 {
                    guard packet["error"] == nil else { return [] }
                    initialized = true
                    try send(["method": "initialized"])
                    try send(["id": 2, "method": "account/rateLimits/read", "params": [:]])
                    continue
                }
                for response in wire.receive(line) { try send(response) }
                if wire.failed { return [] }
                if wire.finished { return wire.windows }
            }
        }
        return []
    }
}
