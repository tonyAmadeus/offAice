import Foundation
import XCTest
@testable import AIROOMCore

final class CoreTests: XCTestCase {
    func testCodexMessage() {
        var parser = CLIEventAccumulator(agent: .codex)
        XCTAssertNil(parser.consume(line: #"{"type":"thread.started","thread_id":"abc"}"#))
        XCTAssertEqual(parser.consume(line: #"{"type":"item.completed","item":{"type":"agent_message","text":"您好"}}"#), "您好")
        XCTAssertEqual(parser.text, "您好")
    }

    func testClaudeMessage() {
        var parser = CLIEventAccumulator(agent: .claude)
        XCTAssertEqual(parser.consume(line: #"{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]}}"#), "Hello")
        XCTAssertEqual(parser.consume(line: #"{"type":"result","result":"完成"}"#), "完成")
        XCTAssertEqual(parser.text, "完成")
    }

    func testClaudePartialDelta() {
        var parser = CLIEventAccumulator(agent: .claude)
        let one = #"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"你"}}}"#
        let two = #"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"好"}}}"#
        XCTAssertEqual(parser.consume(line: one), "你")
        XCTAssertEqual(parser.consume(line: two), "你好")
    }

    func testNoRawJSONLeak() {
        var parser = CLIEventAccumulator(agent: .codex)
        XCTAssertNil(parser.consume(line: #"{"type":"item.completed","item":{"type":"command_execution","command":"pwd"}}"#))
        XCTAssertEqual(parser.text, "")
    }

    func testPromptBuildAndCap() {
        let messages = [ChatMessage(role: .user, body: "問題 A"), ChatMessage(role: .assistant, body: "回答 A")]
        let text = PromptBuilder.build(history: messages, newQuestion: "問題 B")
        XCTAssertTrue(text.contains("回答 A"))
        XCTAssertTrue(text.contains("問題 B"))
        XCTAssertFalse(PromptBuilder.build(history: messages, newQuestion: "問題 B", maxTurns: 0).contains("回答 A"))
    }

    func testReadOnlyArguments() {
        XCTAssertEqual(CommandPlan.arguments(for: .codex).prefix(2), ["exec", "--json"])
        XCTAssertTrue(CommandPlan.arguments(for: .codex).contains("read-only"))
        XCTAssertFalse(CommandPlan.arguments(for: .codex).contains("--full-auto"))
        XCTAssertTrue(CommandPlan.arguments(for: .claude).contains("--tools"))
    }

    func testStateRoundTrip() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: url) }
        let store = try LocalStateStore(root: url)
        let value = SavedState(settings: NativeSettings(workspacePath: "/tmp"), conversations: [Conversation(agent: .claude, title: "示範")])
        try store.save(value)
        XCTAssertEqual(try store.load(), value)
    }

    func testDesktopCodexPathsIncludeUserChatGPTBundle() {
        let paths = CommandPlan.bundledCodexPaths(home: "/Users/example")
        XCTAssertEqual(paths.first,
                       "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex")
        XCTAssertTrue(paths.contains(
            "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"))
        XCTAssertTrue(paths.contains(
            "/Users/example/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex"))
    }

    func testClaudeDesktopBundledVersionSelectionAndExecution() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: home) }
        let base = home.appendingPathComponent("Library/Application Support/Claude/claude-code")
        for version in ["2.1.78", "2.1.247", "2.1.9"] {
            let executable = base.appendingPathComponent("\(version)/claude.app/Contents/MacOS/claude")
            try FileManager.default.createDirectory(at: executable.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data("#!/bin/sh\nexit 0\n".utf8).write(to: executable)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
        }
        // Do not treat other folders as versioned Claude Code installations.
        let unrelated = base.appendingPathComponent("malicious/claude.app/Contents/MacOS")
        try FileManager.default.createDirectory(at: unrelated, withIntermediateDirectories: true)
        let matches = CommandPlan.bundledClaudePaths(home: home.path)
        XCTAssertEqual(matches.count, 6)
        XCTAssertTrue(matches.first!.contains("2.1.247/claude.app/Contents/MacOS/claude"))
        let selected = try CommandPlan.resolveExecutable(agent: .claude,
            settings: NativeSettings(), environment: ["PATH": "/nonexistent"], home: home.path)
        XCTAssertEqual(selected.path, matches.first!)
    }

    func testClaudeDesktopLegacyBinaryAndCLIPathFallback() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: home) }
        let legacy = home.appendingPathComponent("Library/Application Support/Claude/claude-code/2.1.76/claude")
        try FileManager.default.createDirectory(at: legacy.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("#!/bin/sh\nexit 0\n".utf8).write(to: legacy)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: legacy.path)
        let selected = try CommandPlan.resolveExecutable(agent: .claude,
            settings: NativeSettings(), environment: ["PATH": "/nonexistent"], home: home.path)
        XCTAssertEqual(selected.path, legacy.path)
    }

    func testConfiguredClaudeAppFolderResolvesToExecutable() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: home) }
        let bundle = home.appendingPathComponent("claude.app")
        let executable = bundle.appendingPathComponent("Contents/MacOS/claude")
        try FileManager.default.createDirectory(at: executable.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("#!/bin/sh\nexit 0\n".utf8).write(to: executable)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
        XCTAssertEqual(try CommandPlan.resolveExecutable(agent: .claude,
            settings: NativeSettings(claudePath: bundle.path)), executable)
    }

    func testConfiguredCodexBundleFolderResolvesToExecutable() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let bundle = root.appendingPathComponent("CodexCLI.app")
        let executable = bundle.appendingPathComponent("Contents/MacOS/codex")
        try FileManager.default.createDirectory(at: executable.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("#!/bin/sh\nexit 0\n".utf8).write(to: executable)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
        XCTAssertEqual(try CommandPlan.resolveExecutable(agent: .codex,
               settings: NativeSettings(codexPath: bundle.path)), executable)
    }

    func testAppServerUnresponsiveProcessTimesOut() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let script = root.appendingPathComponent("fake-silent-codex")
        try Data("#!/bin/sh\nwhile IFS= read -r x; do :; done\n".utf8).write(to: script)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        let server = CodexAppServerRunner()
        do {
            _ = try await server.run(id: UUID(), binary: script, cwd: root, prompt: "Hello",
                                     access: .readOnly, timeoutSeconds: 1.2) { _ in }
            XCTFail("Silent server must time out")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("timed out"))
        }
    }

    func testMissingCommandRejected() {
        XCTAssertThrowsError(try CommandPlan.resolveExecutable(agent: .codex, settings: NativeSettings(codexPath: "/definitely/not/a/binary")))
    }

    func testRunnerReadsExternalCLIJSONL() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let script = dir.appendingPathComponent("fake-codex")
        let source = Self.mockAppServer(reply: "原生 App Server 回覆")
        try source.data(using: .utf8)!.write(to: script)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        let runner = CLIProcessRunner()
        let output = try await runner.run(agent: .codex, prompt: "測試", settings: NativeSettings(codexPath: script.path, workspacePath: dir.path), fallbackWorkspace: dir) { _ in }
        XCTAssertEqual(output, "原生 App Server 回覆")
    }

    static func mockAppServer(reply: String) -> String {
        """
        #!/bin/sh
        while IFS= read -r msg; do
          case "$msg" in
            *'"method":"initialize"'*) echo '{"id":1,"result":{"userAgent":"mock"}}' ;;
            *'"method":"thread/start"'*) echo '{"id":2,"result":{"thread":{"id":"t-1"}}}' ;;
            *'"method":"turn/start"'*)
              echo '{"id":3,"result":{"turn":{"id":"r-1"}}}'
              echo '{"method":"item/agentMessage/delta","params":{"delta":"\(reply)"}}'
              echo '{"method":"turn/completed","params":{"turn":{"status":"completed"}}}'
              exit 0 ;;
          esac
        done
        """
    }

    func testAppServerWireRejectsMcpElicitation() throws {
        let result = String(decoding: try CodexServerWire.rejectServerRequest(id: 5,
                                      method: "mcpServer/elicitation/request"), as: UTF8.self)
        XCTAssertTrue(result.contains("\"action\":\"decline\""))
    }

    func testAppServerWireDeniesUnknownServerMethods() throws {
        let result = String(decoding: try CodexServerWire.rejectServerRequest(id: 6,
                                      method: "some/unknown/request"), as: UTF8.self)
        XCTAssertTrue(result.contains("-32601"))
        XCTAssertFalse(result.contains("accept"))
    }

    func testAppServerWireDeniesServerApprovals() throws {
        let text = String(decoding: try CodexServerWire.rejectServerRequest(id: 42), as: UTF8.self)
        XCTAssertTrue(text.contains("\"decision\":\"decline\""))
        XCTAssertFalse(text.contains("accept"))
    }

    func testAppServerWireNeverAcceptsUnconfirmedTurn() {
        var wire = CodexServerWire()
        _ = wire.receive(#"{"id":1,"result":{}}"#)
        XCTAssertEqual(wire.stage, .startThread)
        _ = wire.receive(#"{"id":2,"result":{"thread":{"id":"test"}}}"#)
        XCTAssertEqual(wire.threadID, "test")
        _ = wire.receive(#"{"id":3,"result":{}}"#)
        XCTAssertEqual(wire.receive(#"{"method":"item/agentMessage/delta","params":{"delta":"partial"}}"#), "partial")
        XCTAssertFalse(wire.completed)
        _ = wire.receive(#"{"method":"turn/completed","params":{"turn":{"status":"interrupted"}}}"#)
        XCTAssertFalse(wire.completed)
        XCTAssertNotNil(wire.failure)
    }

    func testAppServerWireRecognizesCompletion() {
        var wire = CodexServerWire()
        _ = wire.receive(#"{"method":"item/completed","params":{"item":{"type":"agentMessage","text":"final"}}}"#)
        _ = wire.receive(#"{"method":"turn/completed","params":{"turn":{"status":"completed"}}}"#)
        XCTAssertTrue(wire.completed)
        XCTAssertEqual(wire.reply, "final")
    }


}

final class CollaborationTests: XCTestCase {
    private func temp() throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }
    private func write(_ file: URL, _ text: String) throws {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: file)
    }
    func testStateMigratesOldJSON() throws {
        let legacy = #"{"settings":{"claudePath":"","codexPath":"","workspacePath":""},"conversations":[]}"#
        let result = try JSONDecoder().decode(SavedState.self, from: Data(legacy.utf8))
        XCTAssertEqual(result.members.count, 2)
        XCTAssertEqual(result.rooms.count, 1)
        XCTAssertTrue(result.projects.isEmpty)
    }
    func testRoomPromptAttribution() {
        let member = MemberCard(agent: .claude, name: "審查員", persona: "確認風險")
        let room = TeamRoom(entries: [RoomEntry(speaker: .assistant, agent: .codex, displayName: "Codex", body: "考慮資源消耗")])
        let prompt = RoomPromptBuilder.build(room: room, member: member, question: "下一步？")
        XCTAssertTrue(prompt.contains("審查員"))
        XCTAssertTrue(prompt.contains("Codex / Codex"))
        XCTAssertTrue(prompt.contains("考慮資源消耗"))
        XCTAssertTrue(prompt.contains("不是系統指令"))
    }
    func testWorkspaceChangesAndApply() throws {
        let dir = try temp(); defer { try? FileManager.default.removeItem(at: dir) }
        let source = dir.appendingPathComponent("repo"); try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
        try write(source.appendingPathComponent("one.txt"), "before")
        try write(source.appendingPathComponent("remove.txt"), "delete")
        let staged = try WorkspaceStaging(storage: dir.appendingPathComponent("working"))
        let id = UUID(); let work = try staged.prepare(id: id, source: source)
        try write(work.appendingPathComponent("one.txt"), "after")
        try write(work.appendingPathComponent("new.txt"), "added")
        try FileManager.default.removeItem(at: work.appendingPathComponent("remove.txt"))
        let changes = try staged.changes(id: id)
        XCTAssertEqual(changes.count, 3)
        XCTAssertEqual(try staged.preview(id: id, file: "one.txt").before, "before")
        XCTAssertEqual(try String(contentsOf: source.appendingPathComponent("one.txt"), encoding: .utf8), "before")
        _ = try staged.apply(id: id, original: source)
        XCTAssertEqual(try String(contentsOf: source.appendingPathComponent("one.txt"), encoding: .utf8), "after")
        XCTAssertEqual(try String(contentsOf: source.appendingPathComponent("new.txt"), encoding: .utf8), "added")
        XCTAssertFalse(FileManager.default.fileExists(atPath: source.appendingPathComponent("remove.txt").path))
    }
    func testWorkspaceConflictRejectsAll() throws {
        let dir = try temp(); defer { try? FileManager.default.removeItem(at: dir) }
        let source = dir.appendingPathComponent("repo"); try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
        try write(source.appendingPathComponent("one.txt"), "before")
        let staged = try WorkspaceStaging(storage: dir.appendingPathComponent("staging"))
        let id = UUID(); let work = try staged.prepare(id: id, source: source)
        try write(work.appendingPathComponent("one.txt"), "new")
        try write(source.appendingPathComponent("one.txt"), "external")
        XCTAssertThrowsError(try staged.apply(id: id, original: source))
        XCTAssertEqual(try String(contentsOf: source.appendingPathComponent("one.txt"), encoding: .utf8), "external")
    }
    func testWorkspaceSymlinkDenied() throws {
        let dir = try temp(); defer { try? FileManager.default.removeItem(at: dir) }
        let source = dir.appendingPathComponent("repo"); try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(atPath: source.appendingPathComponent("escape").path, withDestinationPath: "/tmp")
        let staged = try WorkspaceStaging(storage: dir.appendingPathComponent("staging"))
        XCTAssertThrowsError(try staged.prepare(id: UUID(), source: source))
    }
    func testBackupAndRestore() throws {
        let dir = try temp(); defer { try? FileManager.default.removeItem(at: dir) }
        let store = try LocalStateStore(root: dir)
        try store.save(SavedState(rooms: [TeamRoom(title: "討論室 A")]))
        let backup = try store.backup()
        try store.save(SavedState(rooms: [TeamRoom(title: "討論室 B")]))
        XCTAssertEqual(try store.restore(from: backup).rooms.first?.title, "討論室 A")
        XCTAssertEqual(try store.load().rooms.first?.title, "討論室 A")
    }
    func testStagedWriteArguments() {
        XCTAssertEqual(CommandPlan.arguments(for: .codex, access: .stagedWrite)[3], "workspace-write")
        XCTAssertEqual(CommandPlan.arguments(for: .codex)[3], "read-only")
    }
}

final class InterfaceLanguageTests: XCTestCase {
    func testDefaultsToTraditionalChineseForExistingSettings() throws {
        let old = #"{"claudePath":"","codexPath":"","workspacePath":""}"#
        let settings = try JSONDecoder().decode(NativeSettings.self, from: Data(old.utf8))
        XCTAssertEqual(settings.language, .zhTW)
    }

    func testEnglishLanguageRoundTrip() throws {
        let settings = NativeSettings(language: .english)
        let restored = try JSONDecoder().decode(NativeSettings.self, from: JSONEncoder().encode(settings))
        XCTAssertEqual(restored.language, .english)
        XCTAssertEqual(LocalizedUI.text("茶歇室", language: restored.language), "Lounge")
        XCTAssertEqual(LocalizedUI.text("茶歇室", language: .zhTW), "茶歇室")
    }

    func testEnglishPromptsAndProjectStatuses() {
        let prompt = PromptBuilder.build(history: [], newQuestion: "Hello", language: .english)
        XCTAssertTrue(prompt.contains("Reply in English"))
        XCTAssertFalse(prompt.contains("使用者選擇"))
        XCTAssertEqual(LocalizedUI.phase(.reviewing, language: .english), "Review")
        XCTAssertEqual(LocalizedUI.change(.deleted, language: .zhTW), "刪除")
    }

    func testPreviouslySavedProjectRemainsDecodable() throws {
        let project = ProjectRecord(title: "Test", originalFolder: "/tmp/test")
        let encoded = try JSONEncoder().encode(project)
        var json = try JSONSerialization.jsonObject(with: encoded) as! [String: Any]
        json.removeValue(forKey: "reviewNotes")
        let restored = try JSONDecoder().decode(ProjectRecord.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertNil(restored.reviewNotes)
    }
}


private struct TestOnlyProtector: StateProtector {
    func seal(_ plaintext: Data) throws -> Data { Data([0xA5]) + Data(plaintext.reversed()) }
    func open(_ ciphertext: Data) throws -> Data {
        guard ciphertext.first == 0xA5 else { throw StateProtectionError.invalidCiphertext }
        return Data(ciphertext.dropFirst().reversed())
    }
}

final class SecurityTests: XCTestCase {
    private func folder() throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("airoom-test-\(UUID())")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }
    private func put(_ text: String, to file: URL) throws {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: file)
    }

    func testSensitivePathsAndText() {
        for name in [".env", "folder/.env.production", ".git/config", ".ssh/id_ed25519", "secrets/x.txt", "config/auth.json", "prod.p12", "state.sqlite"] {
            XCTAssertTrue(PrivacyGuard.blocked(relativePath: name), name)
        }
        for name in ["main.swift", "src/hello.py", "README.md", "public/logo.png"] {
            XCTAssertFalse(PrivacyGuard.blocked(relativePath: name), name)
        }
        let secret = "sk-ant-abcdefghijklmnopqrstuvwxyz0123456789"
        XCTAssertTrue(PrivacyGuard.containsSecrets("token=\(secret)"))
        XCTAssertFalse(PrivacyGuard.containsSecrets("regular conversation"))
        XCTAssertThrowsError(try PrivacyGuard.validatePrompt("My key: \(secret)"))
        XCTAssertFalse(PrivacyGuard.redact("Hello \(secret)").contains(secret))
    }

    func testEnvironmentIsAllowlisted() {
        let env = PrivacyGuard.cliEnvironment(from: [
            "PATH": "/tmp/untrusted", "HOME": "/Users/test", "LANG": "en_US.UTF-8",
            "ANTHROPIC_API_KEY": "secret", "OPENAI_API_KEY": "secret", "AWS_SECRET_ACCESS_KEY": "secret",
            "NODE_OPTIONS": "--require ./evil.js", "DYLD_INSERT_LIBRARIES": "/tmp/evil.dylib",
            "SSH_AUTH_SOCK": "/tmp/agent", "HTTPS_PROXY": "http://proxy"
        ], executable: URL(fileURLWithPath: "/opt/homebrew/bin/codex"))
        XCTAssertEqual(env["HOME"], "/Users/test")
        XCTAssertNil(env["ANTHROPIC_API_KEY"])
        XCTAssertNil(env["OPENAI_API_KEY"])
        XCTAssertNil(env["AWS_SECRET_ACCESS_KEY"])
        XCTAssertNil(env["NODE_OPTIONS"])
        XCTAssertNil(env["DYLD_INSERT_LIBRARIES"])
        XCTAssertNil(env["SSH_AUTH_SOCK"])
        XCTAssertNil(env["HTTPS_PROXY"])
        XCTAssertFalse(env["PATH"]!.contains("/tmp/untrusted"))
        XCTAssertEqual(env["AIROOM_CLAUDE_DEBUG"], "0")
    }

    func testStagingExcludesSecretsButTracksAllowedFiles() throws {
        let dir = try folder(); defer { try? FileManager.default.removeItem(at: dir) }
        let repo = dir.appendingPathComponent("source")
        try put("print('Hello')", to: repo.appendingPathComponent("hello.py"))
        try put("OPENAI_API_KEY=example-long-secret-key", to: repo.appendingPathComponent(".env"))
        try put("secret github credentials", to: repo.appendingPathComponent(".git/config"))
        try put("sk-ant-abcdefghijklmnopqrstuvwxyz0123456789", to: repo.appendingPathComponent("src/config.txt"))
        let stage = try WorkspaceStaging(storage: dir.appendingPathComponent("staged"))
        let id = UUID(), working = try stage.prepare(id: id, source: repo)
        XCTAssertTrue(FileManager.default.fileExists(atPath: working.appendingPathComponent("hello.py").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: working.appendingPathComponent(".env").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: working.appendingPathComponent(".git").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: working.appendingPathComponent("src/config.txt").path))
        XCTAssertTrue(try stage.changes(id: id).isEmpty)
    }

    func testStagingRejectsNewSecretsOnWriteback() throws {
        let dir = try folder(); defer { try? FileManager.default.removeItem(at: dir) }
        let repo = dir.appendingPathComponent("repo")
        try put("ok", to: repo.appendingPathComponent("safe.txt"))
        let stage = try WorkspaceStaging(storage: dir.appendingPathComponent("stage"))
        let id = UUID(), working = try stage.prepare(id: id, source: repo)
        try put("private", to: working.appendingPathComponent("auth.json"))
        XCTAssertThrowsError(try stage.changes(id: id))
        XCTAssertThrowsError(try stage.apply(id: id, original: repo))
        XCTAssertFalse(FileManager.default.fileExists(atPath: repo.appendingPathComponent("auth.json").path))
    }

    func testEncryptedStoreAndLegacyMigrationWithoutDroppingData() throws {
        let dir = try folder(); defer { try? FileManager.default.removeItem(at: dir) }
        let plaintext = SavedState(rooms: [TeamRoom(title: "private discussion")])
        let legacy = try LocalStateStore(root: dir)
        // Linux test stores plaintext; on macOS the production default is protected.
        try put(String(decoding: try JSONEncoder().encode(plaintext), as: UTF8.self), to: dir.appendingPathComponent("state.json"))
        _ = legacy
        let secure = try LocalStateStore(root: dir, protector: TestOnlyProtector())
        XCTAssertEqual(try secure.load(), plaintext)
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("state.json").path))
        let bytes = try Data(contentsOf: dir.appendingPathComponent("state.aesgcm"))
        XCTAssertFalse(String(decoding: bytes, as: UTF8.self).contains("private discussion"))
        XCTAssertEqual(try secure.load(), plaintext)
        let backup = try secure.backup()
        XCTAssertEqual(backup.pathExtension, "airoombackup")
        XCTAssertFalse(String(decoding: try Data(contentsOf: backup), as: UTF8.self).contains("private discussion"))
        try put("tampered", to: dir.appendingPathComponent("state.aesgcm"))
        XCTAssertThrowsError(try secure.load())
        XCTAssertThrowsError(try secure.restore(from: dir.appendingPathComponent("state.aesgcm")))
    }

    func testRunnerSeesSanitizedWorkingCopy() async throws {
        let dir = try folder(); defer { try? FileManager.default.removeItem(at: dir) }
        let repo = dir.appendingPathComponent("repo")
        try put("secret", to: repo.appendingPathComponent(".env"))
        try put("hello", to: repo.appendingPathComponent("readme.txt"))
        let executable = dir.appendingPathComponent("fake-codex")
        let mock = CoreTests.mockAppServer(reply: "SAFE_MARKER")
            .replacingOccurrences(of: "SAFE_MARKER", with: "safe")
        try put(mock, to: executable)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
        let output = try await CLIProcessRunner().run(agent: .codex, prompt: "ordinary task", settings: NativeSettings(codexPath: executable.path, workspacePath: repo.path), fallbackWorkspace: repo) { _ in }
        XCTAssertEqual(output, "safe")
    }
}


final class SharedRoomContextTests: XCTestCase {
    private func sampleRoom() -> TeamRoom {
        TeamRoom(title: "Architecture", entries: [
            RoomEntry(speaker: .user, displayName: "Me", body: "Design a system"),
            RoomEntry(speaker: .assistant, agent: .claude, displayName: "Claudia", body: "Use message queues"),
            RoomEntry(speaker: .assistant, agent: .codex, displayName: "GPTIA", body: "Use a durable event log"),
            RoomEntry(speaker: .user, displayName: "Me", body: "Can we combine them?")
        ])
    }

    func testAllCompletedAgentsShareOneOrderedTranscript() {
        let room = sampleRoom()
        let snapshot = RoomPromptBuilder.snapshot(room: room, language: .english)
        XCTAssertEqual(snapshot.includedCount, 4)
        let transcript = snapshot.transcript
        let ordered = ["Design a system", "Use message queues", "Use a durable event log", "Can we combine them?"]
        let offsets = ordered.compactMap { transcript.range(of: $0)?.lowerBound }
        XCTAssertEqual(offsets.count, ordered.count)
        XCTAssertEqual(offsets, offsets.sorted())
        for agent in AgentKind.allCases {
            let member = MemberCard(agent: agent)
            let prompt = RoomPromptBuilder.build(room: room, member: member, question: "Can we combine them?", language: .english)
            for item in ordered { XCTAssertTrue(prompt.contains(item), "Missing \(item) for \(agent)") }
            XCTAssertEqual(prompt.components(separatedBy: "Can we combine them?").count - 1, 1)
        }
    }

    func testInProgressAndFailedRepliesNeverPoisonSharedContext() {
        var room = sampleRoom()
        room.entries.append(RoomEntry(speaker: .assistant, agent: .claude, displayName: "Claudia",
                                      body: "partial output 123", delivery: .inProgress))
        room.entries.append(RoomEntry(speaker: .assistant, agent: .codex, displayName: "GPTIA",
                                      body: "API request failed", delivery: .failed))
        room.entries.append(RoomEntry(speaker: .assistant, agent: .codex, displayName: "GPTIA",
                                      body: "cancelled", delivery: .interrupted))
        let prompt = RoomPromptBuilder.build(room: room, member: MemberCard(agent: .codex), question: "Can we combine them?")
        for excluded in ["partial output 123", "API request failed", "cancelled"] {
            XCTAssertFalse(prompt.contains(excluded))
        }
        XCTAssertEqual(RoomPromptBuilder.snapshot(room: room).includedCount, 4)
    }

    func testTranscriptBoundsPreserveRecentContinuity() {
        var room = TeamRoom()
        for i in 0..<50 { room.entries.append(RoomEntry(speaker: .user, displayName: "User", body: "turn-\(i) " + String(repeating: "z", count: 100))) }
        let snapshot = RoomPromptBuilder.snapshot(room: room, maxEntries: 10, maxCharacters: 650, perEntryLimit: 160)
        XCTAssertLessThanOrEqual(snapshot.transcript.count, 650)
        XCTAssertTrue(snapshot.transcript.contains("turn-49"))
        XCTAssertFalse(snapshot.transcript.contains("turn-0 "))
        XCTAssertGreaterThan(snapshot.omittedEntries, 0)
    }

    func testNewRoomHasNoOldRoomContext() {
        let old = sampleRoom()
        let new = TeamRoom(title: "Another topic", entries: [
            RoomEntry(speaker: .user, displayName: "User", body: "Completely separate")
        ])
        let member = MemberCard(agent: .claude)
        XCTAssertTrue(RoomPromptBuilder.build(room: old, member: member, question: "Can we combine them?").contains("message queues"))
        XCTAssertFalse(RoomPromptBuilder.build(room: new, member: member, question: "Completely separate").contains("message queues"))
    }

    func testLegacyEntriesDefaultToCompletedAndNewStatusesRoundTrip() throws {
        let old = RoomEntry(speaker: .assistant, agent: .codex, displayName: "Codex", body: "historic")
        let encoded = try JSONEncoder().encode(old)
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        json.removeValue(forKey: "delivery")
        let legacy = try JSONSerialization.data(withJSONObject: json)
        let restored = try JSONDecoder().decode(RoomEntry.self, from: legacy)
        XCTAssertEqual(restored.delivery, .completed)
        var next = restored
        next.delivery = .interrupted
        XCTAssertEqual(try JSONDecoder().decode(RoomEntry.self, from: JSONEncoder().encode(next)).delivery, .interrupted)
    }

    func testLegacyUnfinishedMessagesDoNotGetShared() throws {
        for raw in ["執行中……", "結果待核對： CLI failed", "Running…", "Result needs verification"] {
            let item = RoomEntry(speaker: .assistant, agent: .codex, displayName: "Codex", body: raw)
            var json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(item)) as? [String: Any])
            json.removeValue(forKey: "delivery")
            let migrated = try JSONDecoder().decode(RoomEntry.self, from: JSONSerialization.data(withJSONObject: json))
            XCTAssertEqual(migrated.delivery, .interrupted)
            let room = TeamRoom(entries: [migrated])
            XCTAssertTrue(RoomPromptBuilder.snapshot(room: room).entries.isEmpty)
        }
    }

    func testDesktopAppLinksContainNoConversationOrToken() throws {
        let folder = FileManager.default.temporaryDirectory
        for agent in AgentKind.allCases {
            let link = try DesktopAppHandoff.newCodeSession(agent: agent, selectedWorkspace: folder.path)
            XCTAssertTrue(["codex", "claude"].contains(link.scheme ?? ""))
            XCTAssertFalse(link.absoluteString.contains("transcript"))
            XCTAssertFalse(link.absoluteString.contains("secret"))
            XCTAssertTrue(link.absoluteString.contains("folder=") || link.absoluteString.contains("path="))
        }
    }

    func testLargeSingleEntryIsSafelyBounded() {
        let room = TeamRoom(entries: [RoomEntry(speaker: .user, displayName: "User", body: String(repeating: "z", count: 100_000))])
        let snapshot = RoomPromptBuilder.snapshot(room: room, maxCharacters: 20_000)
        XCTAssertLessThanOrEqual(snapshot.totalCharacters, 20_000)
        let prompt = RoomPromptBuilder.build(room: room, member: MemberCard(agent: .codex), question: "?", language: .english)
        XCTAssertLessThan(prompt.count, 30_000)
    }
}

final class QuotaTests: XCTestCase {
    func testCodexQuotaBucketsAndRemaining() {
        let sample: [String: Any] = ["rateLimitsByLimitId": [
            "standard": ["limitName": "Codex", "primary": ["usedPercent": 32.4, "windowDurationMins": 300, "resetsAt": 1_800_000_000],
                         "secondary": ["usedPercent": 67.5, "windowDurationMins": 10080]]]]
        let windows = QuotaProjection.codex(sample)
        XCTAssertEqual(windows.count, 2)
        XCTAssertEqual(windows.first?.label, "5 小時")
        XCTAssertEqual(windows.first?.remainingPercent ?? -1, 67.6, accuracy: 0.001)
        XCTAssertNotNil(windows.first?.resetsAt)
        XCTAssertEqual(windows.last?.remainingPercent ?? -1, 32.5, accuracy: 0.001)
    }
    func testQuotaRejectsMalformedValuesAndNeverAssumesZero() {
        let sample: [String: Any] = ["rateLimits": ["primary": ["usedPercent": 120], "secondary": ["usedPercent": "0"]]]
        XCTAssertTrue(QuotaProjection.codex(sample).isEmpty)
        let quota = AccountQuota(agent: .codex, windows: [])
        XCTAssertEqual(quota.status, .unavailable)
        XCTAssertFalse(quota.isFresh(at: quota.checkedAt.addingTimeInterval(16 * 60)))
    }
    func testCodexProtocolExtractsRateLimitResponse() {
        var wire = QuotaWire(agent: .codex)
        let line = #"{"id":2,"result":{"rateLimits":{"primary":{"usedPercent":80,"windowDurationMins":300}}}}"#
        XCTAssertTrue(wire.receive(line).isEmpty)
        XCTAssertTrue(wire.finished)
        XCTAssertEqual(wire.windows.first?.remainingPercent, 20)
    }
    func testClaudeUsageRequiresBuiltinVerification() {
        var wire = QuotaWire(agent: .claude, requestID: "check")
        let invalid = #"{"type":"control_response","response":{"request_id":"check","subtype":"success","response":{"commands":[{"name":"usage","builtin":false}]}}}"#
        XCTAssertTrue(wire.receive(invalid).isEmpty)
        XCTAssertTrue(wire.failed)
        XCTAssertFalse(wire.sentQuery)
    }
    func testClaudeUsageNativeReport() {
        var wire = QuotaWire(agent: .claude, requestID: "check")
        let ready = #"{"type":"control_response","response":{"request_id":"check","subtype":"success","response":{"commands":[{"name":"usage","builtin":true}]}}}"#
        let commands = wire.receive(ready)
        XCTAssertEqual((commands.first?["message"] as? [String: Any])?["content"] as? String, "/usage")
        XCTAssertTrue(wire.sentQuery)
        _ = wire.receive(#"{"type":"assistant","usage_report":{"rate_limits":{"limits":[{"kind":"session","percent":30,"resets_at":"2030-01-01T00:00:00Z"},{"kind":"weekly_all","percent":55}]}}}"#)
        _ = wire.receive(#"{"type":"result","subtype":"success","is_error":false,"local_command":"usage","num_turns":0}"#)
        XCTAssertTrue(wire.finished)
        XCTAssertEqual(wire.windows.count, 2)
        XCTAssertEqual(wire.windows[0].remainingPercent, 70)
        XCTAssertEqual(wire.windows[1].remainingPercent, 45)
    }
    func testClaudeRejectsToolRequestsAndNonUsageResult() {
        var wire = QuotaWire(agent: .claude, requestID: "check")
        let denied = wire.receive(#"{"type":"control_request","request_id":"extra","request":{"subtype":"doSomething"}}"#)
        XCTAssertTrue(wire.failed)
        XCTAssertEqual((denied.first?["response"] as? [String: Any])?["subtype"] as? String, "error")
        var second = QuotaWire(agent: .claude, requestID: "check")
        _ = second.receive(#"{"type":"control_response","response":{"request_id":"check","subtype":"success","response":{"commands":[{"name":"usage","builtin":true}]}}}"#)
        _ = second.receive(#"{"type":"result","subtype":"success","local_command":"other","num_turns":0}"#)
        XCTAssertFalse(second.finished)
        XCTAssertTrue(second.failed)
    }
}

final class QuotaProcessTests: XCTestCase {
    private func script(_ body: String) throws -> (URL, URL) {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let executable = folder.appendingPathComponent("fake-vendor")
        try Data(body.utf8).write(to: executable)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
        return (folder, executable)
    }

    func testCodexQuotaProcessQueriesOfficialMethod() async throws {
        let (dir, executable) = try script("""
        #!/bin/sh
        while IFS= read -r msg; do
          case "$msg" in
            *'"method":"initialize"'*) echo '{"id":1,"result":{}}' ;;
            *'"method":"account/rateLimits/read"'*)
              echo '{"id":2,"result":{"rateLimits":{"primary":{"usedPercent":42,"windowDurationMins":300,"resetsAt":1800000000}}}}'
              exit 0 ;;
          esac
        done
        """)
        defer { try? FileManager.default.removeItem(at: dir) }
        let result = await AccountQuotaReader().query(agent: .codex, settings: NativeSettings(codexPath: executable.path), timeout: 3)
        XCTAssertEqual(result.status, .ready)
        XCTAssertEqual(result.windows.first?.remainingPercent, 58)
    }

    func testClaudeQuotaProcessVerifiesUsageCommand() async throws {
        let (dir, executable) = try script("""
        #!/bin/sh
        while IFS= read -r msg; do
          case "$msg" in
            *'"subtype":"initialize"'*)
              id=$(printf '%s' "$msg" | sed -n 's/.*"request_id":"\\([^"]*\\)".*/\\1/p')
              printf '{"type":"control_response","response":{"request_id":"%s","subtype":"success","response":{"commands":[{"name":"usage","builtin":true}]}}}\n' "$id" ;;
            *'/usage'*)
              echo '{"type":"assistant","usage_report":{"rate_limits":{"limits":[{"kind":"session","percent":13}]}}}'
              echo '{"type":"result","subtype":"success","local_command":"usage","num_turns":0}'
              exit 0 ;;
          esac
        done
        """)
        defer { try? FileManager.default.removeItem(at: dir) }
        let result = await AccountQuotaReader().query(agent: .claude, settings: NativeSettings(claudePath: executable.path), timeout: 3)
        XCTAssertEqual(result.status, .ready)
        XCTAssertEqual(result.windows.first?.remainingPercent, 87)
    }

    func testQuotaProbeTimesOutWithoutGuessingRemaining() async throws {
        let (dir, executable) = try script("#!/bin/sh\nwhile IFS= read -r msg; do :; done\n")
        defer { try? FileManager.default.removeItem(at: dir) }
        let result = await AccountQuotaReader().query(agent: .codex, settings: NativeSettings(codexPath: executable.path), timeout: 1)
        XCTAssertEqual(result.status, .unavailable)
        XCTAssertTrue(result.windows.isEmpty)
    }
}

final class ClaudeDesktopLayoutTests: XCTestCase {
    func testHashedDesktopLayoutIsPreferred() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: home) }
        let version = home.appendingPathComponent("Library/Application Support/Claude/claude-code/2.1.309")
        for hash in ["0000stale", "5af865b9901c"] {
            let executable = version.appendingPathComponent("\(hash)/claude.app/Contents/MacOS/claude")
            try FileManager.default.createDirectory(at: executable.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data("#!/bin/sh\nexit 0\n".utf8).write(to: executable)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
        }
        try Data().write(to: version.appendingPathComponent("5af865b9901c/.verified"))
        let selected = try CommandPlan.resolveExecutable(agent: .claude,
            settings: NativeSettings(), environment: ["PATH": "/nonexistent"], home: home.path)
        XCTAssertTrue(selected.path.hasSuffix("2.1.309/5af865b9901c/claude.app/Contents/MacOS/claude"))
    }

    func testAuthStatusReportDistinguishesSignedOut() {
        let signedOut = Data(#"{"loggedIn": false, "authMethod": "none"}"#.utf8)
        XCTAssertEqual(OfficialCLIProbe.interpret(exitCode: 1, output: signedOut), .notLoggedIn)
        let signedIn = Data(#"{"loggedIn": true, "authMethod": "claude.ai"}"#.utf8)
        XCTAssertEqual(OfficialCLIProbe.interpret(exitCode: 0, output: signedIn), .authenticated)
        XCTAssertEqual(OfficialCLIProbe.interpret(exitCode: 1, output: Data("Not logged in\n".utf8)), .notLoggedIn)
        XCTAssertEqual(OfficialCLIProbe.interpret(exitCode: 2, output: Data()), .notConfirmed)
    }
}
