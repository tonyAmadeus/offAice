import Foundation

/// One-shot, read-only CLI bridge. Does not depend on Electron, Node, a shell, or CLI internals.
/// It intentionally does not claim equivalence to AIROOM's original persistent sessions.
private final class ProtectedBytes {
    private let lock = NSLock()
    private var data = Data()
    func store(_ next: Data) { lock.lock(); data = next; lock.unlock() }
    func snapshot() -> Data { lock.lock(); defer { lock.unlock() }; return data }
}

/// Set once when a prompt actually reaches the CLI.
final class DeliveryFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    var isSet: Bool { lock.lock(); defer { lock.unlock() }; return value }
    /// Returns true only for the first call.
    func set() -> Bool { lock.lock(); defer { lock.unlock() }; let first = !value; value = true; return first }
}

public final class CLIProcessRunner {
    private let lock = NSLock()
    private var active: [UUID: Process] = [:]
    private let codexServer = CodexAppServerRunner()
    /// Receives one attempt, at most one delivered, then completed / notSent /
    /// unknown for every request. Called from background threads.
    public var observer: (@Sendable (AgentKind, CallEvent) -> Void)?

    /// Each member's default model and effort, used where a call doesn't choose.
    private var memberDefaults: [AgentKind: (model: String, effort: String)] = [:]

    public init() {}

    public func setDefaults(_ agent: AgentKind, model: String, effort: String) {
        lock.lock(); memberDefaults[agent] = (model, effort); lock.unlock()
    }

    private func defaults(for agent: AgentKind) -> (model: String, effort: String) {
        lock.lock(); defer { lock.unlock() }
        return memberDefaults[agent] ?? ("", "")
    }

    public func run(
        id: UUID = UUID(), agent: AgentKind, prompt: String, settings: NativeSettings,
        fallbackWorkspace: URL, access: ExecutionAccess = .readOnly, onUpdate: @escaping (String) -> Void
    ) async throws -> String {
        try await runDetailed(id: id, agent: agent, prompt: prompt, settings: settings,
                              fallbackWorkspace: fallbackWorkspace, access: access, onUpdate: onUpdate).text
    }

    /// Like `run`, with per-topic model/effort, image/PDF attachments, and the
    /// model the CLI reported back.
    public func runDetailed(
        id: UUID = UUID(), agent: AgentKind, prompt: String, settings: NativeSettings,
        fallbackWorkspace: URL, access: ExecutionAccess = .readOnly, options: CLIRunOptions = CLIRunOptions(),
        onUpdate: @escaping (String) -> Void
    ) async throws -> CLIRunResult {
        guard !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, prompt.count <= 30_000 else {
            throw NativeCLIError.invalidPrompt
        }
        try PrivacyGuard.validatePrompt(prompt)
        let member = defaults(for: agent)
        let options = options.inheriting(model: member.model, effort: member.effort)
        do {
            return try await runObserved(id: id, agent: agent, prompt: prompt, settings: settings,
                                         fallbackWorkspace: fallbackWorkspace, access: access, options: options, onUpdate: onUpdate)
        } catch is SessionUnavailable {
            // The earlier conversation is gone and the model was never reached:
            // start a new one with the full prompt. Any other error is not retried.
            guard let plan = options.session else { throw SessionUnavailable() }
            var fresh = options
            fresh.session = SessionPlan(resumeID: nil, fallbackPrompt: plan.fallbackPrompt)
            return try await runDetailed(id: id, agent: agent, prompt: plan.fallbackPrompt, settings: settings,
                                         fallbackWorkspace: fallbackWorkspace, access: access, options: fresh, onUpdate: onUpdate)
        }
    }

    private func runObserved(id: UUID, agent: AgentKind, prompt: String, settings: NativeSettings,
                             fallbackWorkspace: URL, access: ExecutionAccess, options: CLIRunOptions,
                             onUpdate: @escaping (String) -> Void) async throws -> CLIRunResult {
        let observer = self.observer
        let flag = DeliveryFlag()
        observer?(agent, .attempt)
        let delivered: @Sendable () -> Void = { if flag.set() { observer?(agent, .delivered) } }
        do {
            var result = try await perform(id: id, agent: agent, prompt: prompt, settings: settings,
                                           fallbackWorkspace: fallbackWorkspace, access: access, options: options,
                                           delivered: delivered, onUpdate: onUpdate)
            result.resumed = options.session?.resumeID != nil
            observer?(agent, .completed)
            return result
        } catch is SessionUnavailable {
            observer?(agent, flag.isSet ? .notReached : .notSent) // the model was not reached
            throw SessionUnavailable()
        } catch {
            // Sent but unconfirmed is "unknown": it may have been processed.
            observer?(agent, flag.isSet ? .unknown : .notSent)
            throw error
        }
    }

    private func perform(id: UUID, agent: AgentKind, prompt: String, settings: NativeSettings,
                         fallbackWorkspace: URL, access: ExecutionAccess, options: CLIRunOptions,
                         delivered: @escaping @Sendable () -> Void,
                         onUpdate: @escaping (String) -> Void) async throws -> CLIRunResult {
        let binary = try CommandPlan.resolveExecutable(agent: agent, settings: settings)
        let cwd = try CommandPlan.workingDirectory(settings: settings, fallback: fallbackWorkspace)
        if agent == .codex {
            if let pdf = options.attachments.first(where: { $0.attachment.kind == .pdf }) {
                throw AttachmentError.pdfNotSupported(pdf.attachment.fileName)
            }
            return try await codexServer.runDetailed(id: id, binary: binary, cwd: cwd, prompt: prompt,
                                                     access: access, options: options, delivered: delivered,
                                                     onUpdate: onUpdate)
        }
        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    let result = try self.runBlocking(id: id, agent: agent, binary: binary, cwd: cwd, prompt: prompt,
                                                      access: access, options: options, delivered: delivered,
                                                      onUpdate: onUpdate)
                    continuation.resume(returning: result)
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    private func runBlocking(id: UUID, agent: AgentKind, binary: URL, cwd: URL, prompt: String,
                             access: ExecutionAccess, options: CLIRunOptions, delivered: () -> Void,
                             onUpdate: (String) -> Void) throws -> CLIRunResult {
        let process = Process()
        // Read-only prompts execute against a temporary sanitised work copy.
        // This reduces accidental inclusion of .env/SSH/cloud files; it is
        // NOT an OS sandbox and cannot prevent a CLI reading other home paths.
        var actualCWD = cwd
        var scratch: URL?
        if access != .stagedWrite {
            let temporary = FileManager.default.temporaryDirectory
                .appendingPathComponent("airoom-readonly-\(UUID().uuidString)", isDirectory: true)
            let copy = try WorkspaceStaging(storage: temporary)
            scratch = temporary
            do { actualCWD = try copy.prepare(id: UUID(), source: cwd) }
            catch { try? FileManager.default.removeItem(at: temporary); throw error }
        }
        defer { if let scratch { try? FileManager.default.removeItem(at: scratch) } }
        process.executableURL = binary
        process.arguments = CommandPlan.arguments(for: agent, access: access, options: options)
        let input = options.attachments.isEmpty ? Data(prompt.utf8)
            : try ClaudeStreamInput.userMessage(prompt: prompt, attachments: options.attachments)
        process.currentDirectoryURL = actualCWD
        let environment = PrivacyGuard.cliEnvironment(
            from: ProcessInfo.processInfo.environment, executable: binary)
        process.environment = environment
        let stdout = Pipe(), stderr = Pipe(), stdin = Pipe()
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = stderr
        try process.run()
        lock.lock(); active[id] = process; lock.unlock()
        defer {
            lock.lock(); active.removeValue(forKey: id); lock.unlock()
            try? stdin.fileHandleForWriting.close()
            try? stdout.fileHandleForReading.close()
            try? stderr.fileHandleForReading.close()
        }
        // Prompt is transmitted through stdin, not as an argument visible to other processes.
        stdin.fileHandleForWriting.write(input)
        delivered()
        try? stdin.fileHandleForWriting.close()

        let errorGroup = DispatchGroup()
        let errorOutput = ProtectedBytes()
        errorGroup.enter()
        DispatchQueue.global(qos: .utility).async {
            let data = stderr.fileHandleForReading.readDataToEndOfFile()
            errorOutput.store(Data(data.prefix(32_768)))
            errorGroup.leave()
        }

        var parser = CLIEventAccumulator(agent: agent)
        var buffer = Data()
        var stdoutReadError: Error?
        do {
            while let chunk = try stdout.fileHandleForReading.read(upToCount: 8_192), !chunk.isEmpty {
                buffer.append(chunk)
                while let idx = buffer.firstIndex(of: 0x0A) {
                    let bytes = buffer.prefix(upTo: idx)
                    buffer.removeSubrange(...idx)
                    let line = String(decoding: bytes, as: UTF8.self)
                    if let text = parser.consume(line: line) { onUpdate(PrivacyGuard.redact(text)) }
                }
                // Bound untrusted output if a program never emits a newline.
                if buffer.count > 4 * 1_024 * 1_024 {
                    stdoutReadError = NativeCLIError.processFailed("CLI 輸出單行過長，已停止執行")
                    process.terminate()
                    break
                }
            }
            if !buffer.isEmpty, let text = parser.consume(line: String(decoding: buffer, as: UTF8.self)) {
                onUpdate(PrivacyGuard.redact(text))
            }
        } catch {
            stdoutReadError = error
            if process.isRunning { process.terminate() }
        }
        process.waitUntilExit()
        errorGroup.wait()
        if let stdoutReadError { throw stdoutReadError }
        if process.terminationStatus != 0 || parser.failure != nil {
            let stderrText = String(decoding: errorOutput.snapshot(), as: UTF8.self)
            if options.session?.resumeID != nil
                && (stderrText.contains("No conversation found") || parser.endedBeforeModel && parser.text.isEmpty) {
                throw SessionUnavailable()
            }
            let message = parser.failure ?? stderrText.trimmingCharacters(in: .whitespacesAndNewlines)
            throw NativeCLIError.processFailed("\(agent.rawValue) 執行失敗（exit \(process.terminationStatus)）：\(String(PrivacyGuard.redact(message).prefix(2_000)))")
        }
        if parser.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw NativeCLIError.noResponse(agent.rawValue)
        }
        return CLIRunResult(text: PrivacyGuard.redact(parser.text), model: parser.model, sessionID: parser.sessionID)
    }

    public func codexModels(settings: NativeSettings) async throws -> [ModelChoice] {
        try await codexServer.listModels(binary: CommandPlan.resolveExecutable(agent: .codex, settings: settings))
    }

    /// Asks Claude Code for its model catalog through the SDK `initialize`
    /// control request. No user message is sent and no tokens are spent.
    public func claudeModels(settings: NativeSettings, timeout: TimeInterval = 10) async throws -> [ModelChoice] {
        let binary = try CommandPlan.resolveExecutable(agent: .claude, settings: settings)
        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .utility).async {
                do { continuation.resume(returning: try Self.claudeModelsBlocking(binary: binary, timeout: timeout)) }
                catch { continuation.resume(throwing: error) }
            }
        }
    }

    private static func claudeModelsBlocking(binary: URL, timeout: TimeInterval) throws -> [ModelChoice] {
        let process = Process()
        process.executableURL = binary
        process.arguments = ["-p", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json",
                             "--tools", "", "--strict-mcp-config", "--mcp-config", #"{"mcpServers":{}}"#]
        process.currentDirectoryURL = FileManager.default.temporaryDirectory
        process.environment = PrivacyGuard.cliEnvironment(from: ProcessInfo.processInfo.environment, executable: binary)
        let input = Pipe(), output = Pipe()
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        try process.run()
        defer {
            try? input.fileHandleForWriting.close()
            if process.isRunning { process.terminate() }
            output.fileHandleForReading.readabilityHandler = nil
        }
        let lines = LineCollector()
        output.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            if chunk.isEmpty { handle.readabilityHandler = nil }
            lines.append(chunk)
        }
        let requestID = UUID().uuidString
        let request: [String: Any] = ["type": "control_request", "request_id": requestID, "request": ["subtype": "initialize"]]
        var line = try JSONSerialization.data(withJSONObject: request)
        line.append(0x0a)
        try input.fileHandleForWriting.write(contentsOf: line)
        let frame = try lines.waitFor(timeout: timeout) {
            $0["type"] as? String == "control_response"
                && ($0["response"] as? [String: Any])?["request_id"] as? String == requestID
        }
        let response = (frame["response"] as? [String: Any])?["response"] as? [String: Any]
        return ModelCatalog.claudeModels(from: response?["models"] as? [[String: Any]] ?? [])
    }

    /// Stops the direct CLI process. Descendant process cleanup is NOT yet guaranteed in this MVP.
    @discardableResult public func cancel(id: UUID) -> Bool {
        if codexServer.cancel(id: id) { return true }
        lock.lock(); let process = active[id]; lock.unlock()
        guard let process, process.isRunning else { return false }
        process.terminate()
        return true
    }
}
