import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

/// A bounded, fail-closed adapter for Codex's documented stdio JSONL app-server API.
/// AIROOM owns the cross-agent history; a fresh *ephemeral* Codex thread is used
/// for each call so a previous Codex-only thread cannot silently double-inject
/// history shared with Claude. Native persistent Codex threads are a later feature.
public struct CodexServerWire {
    public private(set) var stage: Stage = .initialize
    public private(set) var threadID: String?
    public private(set) var reply = ""
    public private(set) var completed = false
    public private(set) var failure: String?
    /// Model reported in the thread/start response.
    public private(set) var model: String?
    /// thread/resume was refused (the thread is gone); the model was not reached.
    public private(set) var resumeRefused = false
    /// Images from completed `imageGeneration` items, in order.
    public private(set) var images: [GeneratedImagePayload] = []

    public enum Stage: Equatable { case initialize, startThread, startTurn, waiting, finished }

    public init() {}

    public static func request(id: Int, method: String, params: [String: Any]) throws -> Data {
        try jsonLine(["id": id, "method": method, "params": params])
    }

    public static func notification(method: String) throws -> Data {
        try jsonLine(["method": method])
    }

    public static func rejectServerRequest(id: Any, method: String = "item/commandExecution/requestApproval") throws -> Data {
        // Never auto-accept shell commands, file patches, network access or MCP prompts.
        if method == "mcpServer/elicitation/request" {
            return try jsonLine(["id": id, "result": ["action": "decline"]])
        }
        if method.contains("requestApproval") {
            return try jsonLine(["id": id, "result": ["decision": "decline"]])
        }
        return try jsonLine(["id": id, "error": ["code": -32601, "message": "Unsupported request in AIROOM Native"]])
    }

    private static func jsonLine(_ obj: [String: Any]) throws -> Data {
        let data = try JSONSerialization.data(withJSONObject: obj, options: [.fragmentsAllowed, .sortedKeys, .withoutEscapingSlashes])
        var line = data
        line.append(0x0a)
        return line
    }

    /// Handles one server JSONL frame; returns the updated display text, if any.
    /// An 'item completed' frame is NOT a successful turn; only turn/completed
    /// with status=completed can commit shared context to other AI agents.
    @discardableResult public mutating func receive(_ line: String) -> String? {
        guard let data = line.data(using: .utf8),
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        if let id = value["id"] as? Int, let error = value["error"] as? [String: Any] {
            let message = error["message"] as? String ?? "Unknown JSON-RPC error"
            if id >= 1 && id <= 3 { failure = "Codex App Server: \(message)" }
            if id == 2 { resumeRefused = true }
            return nil
        }
        if let id = value["id"] as? Int, let result = value["result"] as? [String: Any] {
            switch (stage, id) {
            case (.initialize, 1): stage = .startThread
            case (.startThread, 2):
                model = result["model"] as? String
                guard let thread = result["thread"] as? [String: Any],
                      let value = thread["id"] as? String, !value.isEmpty else {
                    failure = "Codex App Server did not return a thread ID"
                    return nil
                }
                threadID = value
                stage = .startTurn
            case (.startTurn, 3): stage = .waiting
            default: break
            }
            return nil
        }
        guard let method = value["method"] as? String,
              let params = value["params"] as? [String: Any] else { return nil }
        if method == "item/agentMessage/delta", let delta = params["delta"] as? String {
            reply += delta
            // Bound untrusted model output that might otherwise exhaust RAM.
            if reply.utf8.count > 1_000_000 { failure = "Codex output exceeds 1 MB" }
            return reply
        }
        if method == "item/completed", let item = params["item"] as? [String: Any],
           let image = GeneratedImagePayload.parse(item) {
            switch image {
            case .success(let payload): if !images.contains(where: { $0.itemID == payload.itemID }) { images.append(payload) }
            case .failure(let error): failure = error.localizedDescription
            }
            return nil
        }
        if method == "item/completed", let item = params["item"] as? [String: Any],
           item["type"] as? String == "agentMessage", let final = item["text"] as? String {
            reply = final
            return reply
        }
        if method == "turn/completed" {
            let turn = params["turn"] as? [String: Any] ?? [:]
            let status = turn["status"] as? String ?? "unknown"
            if status == "completed" { completed = true }
            else {
                let error = turn["error"] as? [String: Any]
                failure = error?["codexErrorInfo"] as? String == "usageLimitExceeded"
                    ? (error?["message"] as? String).map { "Codex 額度已用完：\($0)" } ?? ImageGenerationError.quota.localizedDescription
                    : error?["message"] as? String ?? "Codex turn ended: \(status)"
            }
            stage = .finished
            return nil
        }
        if method == "error" {
            // Some notifications are recoverable. Terminal turn status still controls success.
            return nil
        }
        return nil
    }
}

/// Starts an official Codex app-server process per AIROOM request. Does not
/// scrape Codex Desktop sessions, cookies or passwords, and needs no GUI process.
/// Shell and patch approval requests are denied, not silently accepted.
public final class CodexAppServerRunner {
    private let lock = NSLock()
    private var active: [UUID: Process] = [:]

    public init() {
        // A vendor binary may exit between a response and the next write.
        // Convert EPIPE to an error instead of allowing SIGPIPE to terminate AIROOM.
        _ = signal(SIGPIPE, SIG_IGN)
    }

    public func run(id: UUID, binary: URL, cwd: URL, prompt: String,
                    access: ExecutionAccess, timeoutSeconds: TimeInterval = 300,
                    onUpdate: @escaping (String) -> Void) async throws -> String {
        try await runDetailed(id: id, binary: binary, cwd: cwd, prompt: prompt, access: access,
                              timeoutSeconds: timeoutSeconds, onUpdate: onUpdate).text
    }

    public func runDetailed(id: UUID, binary: URL, cwd: URL, prompt: String,
                            access: ExecutionAccess, options: CLIRunOptions = CLIRunOptions(),
                            timeoutSeconds: TimeInterval = 300, delivered: @escaping @Sendable () -> Void = {},
                            onUpdate: @escaping (String) -> Void) async throws -> CLIRunResult {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    let value = try self.runBlocking(id: id, binary: binary, cwd: cwd,
                                                     prompt: prompt, access: access, options: options,
                                                     timeoutSeconds: timeoutSeconds, delivered: delivered,
                                                     onUpdate: onUpdate)
                    continuation.resume(returning: value)
                } catch { continuation.resume(throwing: error) }
            }
        }
    }

    private func runBlocking(id: UUID, binary: URL, cwd: URL, prompt: String,
                             access: ExecutionAccess, options: CLIRunOptions, timeoutSeconds: TimeInterval,
                             delivered: () -> Void, onUpdate: (String) -> Void) throws -> CLIRunResult {
        var actualCWD = cwd
        var scratch: URL?
        if access != .stagedWrite {
            let temp = FileManager.default.temporaryDirectory
                .appendingPathComponent("airoom-server-readonly-\(UUID().uuidString)", isDirectory: true)
            let copy = try WorkspaceStaging(storage: temp)
            scratch = temp
            do { actualCWD = try copy.prepare(id: UUID(), source: cwd) }
            catch { try? FileManager.default.removeItem(at: temp); throw error }
        }
        defer { if let scratch { try? FileManager.default.removeItem(at: scratch) } }

        let process = Process()
        process.executableURL = binary
        process.arguments = ["app-server", "--listen", "stdio://"]
        process.currentDirectoryURL = actualCWD
        process.environment = PrivacyGuard.cliEnvironment(from: ProcessInfo.processInfo.environment, executable: binary)
        let input = Pipe(), output = Pipe(), errors = Pipe()
        process.standardInput = input
        process.standardOutput = output
        process.standardError = errors
        try process.run()
        // Close the parent copies of child-only pipe endpoints immediately.
        // Without this, stderr never reaches EOF and timeout/cancellation can
        // deadlock while waiting for the bounded stderr reader to finish.
        try? input.fileHandleForReading.close()
        try? output.fileHandleForWriting.close()
        try? errors.fileHandleForWriting.close()
        lock.lock(); active[id] = process; lock.unlock()
        defer {
            lock.lock(); active.removeValue(forKey: id); lock.unlock()
            if process.isRunning {
                _ = kill(process.processIdentifier, SIGTERM)
                // Some wrapped CLI launchers ignore or defer SIGTERM while
                // blocked reading stdin. Never leave AIROOM waiting forever.
                for _ in 0..<10 where process.isRunning { Thread.sleep(forTimeInterval: 0.05) }
                if process.isRunning { _ = kill(process.processIdentifier, SIGKILL) }
            }
            process.waitUntilExit()
            try? input.fileHandleForWriting.close()
            try? output.fileHandleForReading.close()
            try? errors.fileHandleForReading.close()
        }
        // Drain stdout and stderr in the same poll loop. A background
        // FileHandle reader waiting for stderr EOF can deadlock on process
        // cancellation, even after Process.terminate() on some platforms.
        var stderrData = Data()
        let stderrFD = errors.fileHandleForReading.fileDescriptor
        var stderrEOF = false

        var wire = CodexServerWire()
        try input.fileHandleForWriting.write(contentsOf: CodexServerWire.request(
            id: 1, method: "initialize", params: [
                "clientInfo": ["name": "airoom_native", "title": "AIROOM Native", "version": "0.2.0"]
            ]))
        var buffer = Data()
        var sentThread = false, sentTurn = false
        let deadline = ProcessInfo.processInfo.systemUptime + max(1, timeoutSeconds)
        let outputFD = output.fileHandleForReading.fileDescriptor
        // poll + POSIX read avoids Foundation FileHandle buffering indefinitely
        // when a JSON-RPC server emits a short line without exiting. Also permits
        // a bounded timeout for an unresponsive or broken vendor process.
        while true {
            if ProcessInfo.processInfo.systemUptime >= deadline {
                throw NativeCLIError.processFailed("Codex App Server timed out; the turn was not confirmed and will not be retried")
            }
            var fds = [
                pollfd(fd: outputFD, events: Int16(POLLIN | POLLHUP), revents: 0),
                pollfd(fd: stderrEOF ? -1 : stderrFD, events: Int16(POLLIN | POLLHUP), revents: 0)
            ]
            let ready = fds.withUnsafeMutableBufferPointer { poll($0.baseAddress, nfds_t($0.count), 250) }
            if ready == 0 { continue }
            if ready < 0 {
                if errno == EINTR { continue }
                throw NativeCLIError.processFailed("Codex App Server pipe polling failed")
            }
            // Always drain stderr, including when it is too large to retain.
            if fds[1].revents != 0, !stderrEOF {
                var errorChunk = [UInt8](repeating: 0, count: 8192)
                let count = read(stderrFD, &errorChunk, errorChunk.count)
                if count == 0 { stderrEOF = true }
                else if count > 0, stderrData.count < 32_768 {
                    stderrData.append(contentsOf: errorChunk.prefix(min(count, 32_768 - stderrData.count)))
                } else if count < 0 && errno != EINTR {
                    stderrEOF = true
                }
            }
            if fds[0].revents == 0 { continue }
            var chunk = [UInt8](repeating: 0, count: 8192)
            let bytesRead = read(outputFD, &chunk, chunk.count)
            if bytesRead == 0 { break }
            if bytesRead < 0 {
                if errno == EINTR { continue }
                throw NativeCLIError.processFailed("Codex App Server stdout read failed")
            }
            buffer.append(contentsOf: chunk.prefix(bytesRead))
            // An image item carries the picture inline (base64), so allow for a 20 MB image.
            if buffer.count > (options.imageGeneration ? 32 * 1_048_576 : 4_194_304) {
                throw NativeCLIError.processFailed("Codex App Server event exceeds \(options.imageGeneration ? 32 : 4) MB")
            }
            while let boundary = buffer.firstIndex(of: 0x0a) {
                let line = String(decoding: buffer[..<boundary], as: UTF8.self)
                buffer.removeSubrange(...boundary)
                guard let data = line.data(using: .utf8),
                      let frame = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
                if let method = frame["method"] as? String, frame["id"] != nil {
                    // Never auto-approve a side effect or spend tokens on elicitation.
                    if let requestID = frame["id"] {
                        try input.fileHandleForWriting.write(contentsOf: CodexServerWire.rejectServerRequest(id: requestID, method: method))
                    }
                    _ = method
                    continue
                }
                if let text = wire.receive(line) { onUpdate(PrivacyGuard.redact(text)) }
                if let failure = wire.failure {
                    if wire.resumeRefused && options.session?.resumeID != nil { throw SessionUnavailable() }
                    throw NativeCLIError.processFailed(PrivacyGuard.redact(failure))
                }
                if wire.completed {
                    if options.imageGeneration {
                        guard !wire.images.isEmpty else { throw ImageGenerationError.empty }
                    } else if wire.reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        throw NativeCLIError.noResponse("Codex App Server")
                    }
                    // thread/start reports the thread's default; a model passed to turn/start replaces it
                    // and Codex sends no notice of that, so the requested model is the one that ran.
                    return CLIRunResult(text: PrivacyGuard.redact(wire.reply), model: options.model.isEmpty ? wire.model : options.model,
                                        sessionID: wire.threadID, images: wire.images)
                }
                if wire.stage == .startThread && !sentThread {
                    sentThread = true
                    try input.fileHandleForWriting.write(contentsOf: CodexServerWire.notification(method: "initialized"))
                    var thread: [String: Any] = [
                        "cwd": actualCWD.path,
                        "approvalPolicy": "never",
                        "sandbox": access == .stagedWrite ? "workspace-write" : "read-only"
                    ]
                    // A session plan keeps the thread so the next run can continue it.
                    if let resume = options.session?.resumeID { thread["threadId"] = resume }
                    else { thread["ephemeral"] = options.session == nil }
                    // An image request turns on only the hosted image tool; commands and web stay off.
                    if options.imageGeneration {
                        thread["config"] = ["features.image_generation": true, "features.shell_tool": false,
                                            "features.unified_exec": false, "features.multi_agent": false,
                                            "features.apps": false, "features.browser_use": false,
                                            "features.in_app_browser": false, "web_search": "disabled"] as [String: Any]
                    }
                    try input.fileHandleForWriting.write(contentsOf: CodexServerWire.request(
                        id: 2, method: options.session?.resumeID != nil ? "thread/resume" : "thread/start", params: thread))
                }
                if wire.stage == .startTurn && !sentTurn, let threadID = wire.threadID {
                    sentTurn = true
                    var params: [String: Any] = [
                        "threadId": threadID,
                        "input": [["type": "text", "text": prompt]]
                            + options.attachments.map { ["type": "localImage", "path": $0.file.path] }
                    ]
                    if !options.model.isEmpty { params["model"] = options.model }
                    if !options.effort.isEmpty { params["effort"] = options.effort }
                    try input.fileHandleForWriting.write(contentsOf: CodexServerWire.request(
                        id: 3, method: "turn/start", params: params))
                    delivered()
                }
            }
        }
        let stderr = PrivacyGuard.redact(String(decoding: stderrData, as: UTF8.self))
        throw NativeCLIError.processFailed("Codex App Server ended without a confirmed turn. \(String(stderr.prefix(900)))")
    }

    /// Reads the official model catalog (`model/list`) for the topic picker.
    public func listModels(binary: URL, timeoutSeconds: TimeInterval = 15) async throws -> [ModelChoice] {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .utility).async {
                do { continuation.resume(returning: try self.listModelsBlocking(binary: binary, timeout: timeoutSeconds)) }
                catch { continuation.resume(throwing: error) }
            }
        }
    }

    private func listModelsBlocking(binary: URL, timeout: TimeInterval) throws -> [ModelChoice] {
        let process = Process()
        process.executableURL = binary
        process.arguments = ["app-server", "--listen", "stdio://"]
        process.currentDirectoryURL = FileManager.default.temporaryDirectory
        process.environment = PrivacyGuard.cliEnvironment(from: ProcessInfo.processInfo.environment, executable: binary)
        let input = Pipe(), output = Pipe()
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        try process.run()
        defer {
            if process.isRunning { process.terminate() }
            try? input.fileHandleForWriting.close()
        }
        let lines = LineCollector()
        output.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            if chunk.isEmpty { handle.readabilityHandler = nil }
            lines.append(chunk)
        }
        defer { output.fileHandleForReading.readabilityHandler = nil }
        try input.fileHandleForWriting.write(contentsOf: CodexServerWire.request(id: 1, method: "initialize", params: [
            "clientInfo": ["name": "airoom_native", "title": "AIROOM Native", "version": "0.2.0"]]))
        _ = try lines.waitForResponse(id: 1, timeout: timeout)
        try input.fileHandleForWriting.write(contentsOf: CodexServerWire.notification(method: "initialized"))
        try input.fileHandleForWriting.write(contentsOf: CodexServerWire.request(id: 2, method: "model/list", params: [:]))
        let result = try lines.waitForResponse(id: 2, timeout: timeout)
        return (result["data"] as? [[String: Any]] ?? []).compactMap { item in
            guard item["hidden"] as? Bool != true,
                  let id = (item["model"] as? String) ?? (item["id"] as? String), !id.isEmpty else { return nil }
            let efforts = (item["supportedReasoningEfforts"] as? [[String: Any]] ?? [])
                .compactMap { $0["reasoningEffort"] as? String }
            return ModelChoice(id: id, title: item["displayName"] as? String ?? id, efforts: efforts,
                               isDefault: item["isDefault"] as? Bool == true)
        }
    }

    @discardableResult public func cancel(id: UUID) -> Bool {
        lock.lock(); let process = active[id]; lock.unlock()
        guard let process, process.isRunning else { return false }
        process.terminate()
        return true
    }
}


/// Collects JSONL frames from a background reader and waits for one response.
final class LineCollector: @unchecked Sendable {
    private let condition = NSCondition()
    private var buffer = Data()
    private var frames: [[String: Any]] = []
    private var closed = false

    func append(_ chunk: Data) {
        condition.lock()
        if chunk.isEmpty { closed = true }
        buffer.append(chunk)
        while let boundary = buffer.firstIndex(of: 0x0a) {
            let line = buffer[..<boundary]
            buffer.removeSubrange(...boundary)
            if let frame = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any] { frames.append(frame) }
        }
        if buffer.count > 4_194_304 { buffer.removeAll(); closed = true }
        condition.broadcast()
        condition.unlock()
    }

    func waitForResponse(id: Int, timeout: TimeInterval) throws -> [String: Any] {
        let frame = try waitFor(timeout: timeout) { $0["id"] as? Int == id }
        if let error = frame["error"] as? [String: Any] {
            throw NativeCLIError.processFailed("Codex App Server: \(error["message"] as? String ?? "error")")
        }
        return frame["result"] as? [String: Any] ?? [:]
    }

    func waitFor(timeout: TimeInterval, _ matches: ([String: Any]) -> Bool) throws -> [String: Any] {
        let deadline = Date().addingTimeInterval(timeout)
        condition.lock()
        defer { condition.unlock() }
        while true {
            if let index = frames.firstIndex(where: matches) { return frames.remove(at: index) }
            if closed { throw NativeCLIError.processFailed("CLI exited before answering") }
            guard condition.wait(until: deadline) else { throw NativeCLIError.processFailed("CLI timed out") }
        }
    }
}
