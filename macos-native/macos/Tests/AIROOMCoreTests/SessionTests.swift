import XCTest
@testable import AIROOMCore

final class SessionTests: XCTestCase {
    private final class Recorder: @unchecked Sendable {
        private let lock = NSLock(); private var events: [String] = []
        func add(_ e: CallEvent) { lock.lock(); events.append("\(e)"); lock.unlock() }
        var all: [String] { lock.lock(); defer { lock.unlock() }; return events }
    }

    /// A fake `claude`: --resume of "gone" reports a missing session; anything else answers.
    private func fakeClaude() throws -> (URL, URL) {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("airoom-session-\(UUID())")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let script = folder.appendingPathComponent("claude")
        try Data("""
        #!/bin/sh
        cat > "\(folder.path)/last-input.txt"
        case "$*" in *"--resume gone"*)
          echo "No conversation found with session ID: gone" >&2
          echo '{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":0,"duration_api_ms":0}'
          exit 1;;
        esac
        case "$*" in *"--resume kept"*) SID=kept;; *) SID=new-session-1;; esac
        echo "{\\"type\\":\\"system\\",\\"subtype\\":\\"init\\",\\"model\\":\\"m\\",\\"session_id\\":\\"$SID\\"}"
        echo "{\\"type\\":\\"result\\",\\"is_error\\":false,\\"result\\":\\"ok\\",\\"session_id\\":\\"$SID\\"}"
        """.utf8).write(to: script)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        return (folder, script)
    }

    private func run(_ resume: String?, folder: URL, script: URL, recorder: Recorder) async throws -> CLIRunResult {
        let runner = CLIProcessRunner()
        runner.observer = { _, event in recorder.add(event) }
        return try await runner.runDetailed(agent: .claude, prompt: "DELTA",
            settings: NativeSettings(claudePath: script.path, workspacePath: folder.path), fallbackWorkspace: folder,
            options: CLIRunOptions(session: SessionPlan(resumeID: resume, fallbackPrompt: "FULL HISTORY")), onUpdate: { _ in })
    }

    func testMissingSessionFallsBackToFullPromptOnce() async throws {
        let (folder, script) = try fakeClaude()
        defer { try? FileManager.default.removeItem(at: folder) }
        let recorder = Recorder()
        let result = try await run("gone", folder: folder, script: script, recorder: recorder)
        XCTAssertEqual(result.sessionID, "new-session-1")
        XCTAssertFalse(result.resumed)
        XCTAssertEqual(try String(contentsOf: folder.appendingPathComponent("last-input.txt")), "FULL HISTORY")
        XCTAssertEqual(recorder.all, ["attempt", "delivered", "notReached", "attempt", "delivered", "completed"])
        var usage = CallUsage()
        for event in [CallEvent.attempt, .delivered, .notReached, .attempt, .delivered, .completed] { usage.record(event) }
        XCTAssertEqual([usage.total, usage.delivered, usage.completed, usage.notSent], [2, 1, 1, 1])
    }

    func testResumedSessionSendsOnlyTheDelta() async throws {
        let (folder, script) = try fakeClaude()
        defer { try? FileManager.default.removeItem(at: folder) }
        let result = try await run("kept", folder: folder, script: script, recorder: Recorder())
        XCTAssertTrue(result.resumed)
        XCTAssertEqual(result.sessionID, "kept")
        XCTAssertEqual(try String(contentsOf: folder.appendingPathComponent("last-input.txt")), "DELTA")
    }

    func testResumeArgumentsAndUnsafeIDs() {
        let args = CommandPlan.arguments(for: .claude, options: CLIRunOptions(session: SessionPlan(resumeID: "abc-123", fallbackPrompt: "")))
        XCTAssertEqual(Array(args.suffix(2)), ["--resume", "abc-123"])
        XCTAssertNil(SessionPlan(resumeID: "--dangerously-skip-permissions", fallbackPrompt: "").resumeID)
        XCTAssertNil(SessionPlan(resumeID: "a b; rm", fallbackPrompt: "").resumeID)
    }

    func testCodexRefusedResumeIsDetected() {
        var wire = CodexServerWire()
        wire.receive(#"{"id":1,"result":{}}"#)
        wire.receive(#"{"id":2,"error":{"message":"no rollout found for thread id x"}}"#)
        XCTAssertTrue(wire.resumeRefused)
        XCTAssertNotNil(wire.failure)
    }
}

final class SessionPromptTests: XCTestCase {
    func testLoungeDeltaHasOnlyNewEntriesFromOthers() {
        let claude = MemberCard(agent: .claude, name: "克勞蒂亞")
        let seen = RoomEntry(speaker: .user, displayName: "你", body: "OLD_MESSAGE")
        let mine = RoomEntry(speaker: .assistant, agent: .claude, displayName: "克勞蒂亞", body: "MY_OWN_REPLY")
        let theirs = RoomEntry(speaker: .assistant, agent: .codex, displayName: "GPT娘", body: "NEW_FROM_CODEX")
        let room = TeamRoom(entries: [seen, mine, theirs])
        var state = LoungeState(style: .chat)
        state.priority = [.claude]
        let delta = LoungeEngine.turnDelta(room: room, member: claude, state: state, since: seen.id, ownerName: "小明", language: .zhTW)
        XCTAssertTrue(delta.contains("NEW_FROM_CODEX"))
        XCTAssertFalse(delta.contains("OLD_MESSAGE"))
        XCTAssertFalse(delta.contains("MY_OWN_REPLY"), "its own reply is already in its conversation")
        XCTAssertTrue(delta.contains("你剛被點名"))
    }

    func testDeskContinuesOnlyRightAfterItsOwnReply() {
        var topic = Conversation(agent: .claude)
        let question = ChatMessage(role: .user, body: "q"), reply = ChatMessage(role: .assistant, body: "a")
        topic.messages = [question, reply]
        topic.sessionID = "s1"; topic.sessionThrough = reply.id
        XCTAssertTrue(topic.canContinueSession)
        topic.messages.append(ChatMessage(role: .user, body: "unanswered"))
        XCTAssertFalse(topic.canContinueSession)
    }

    func testOlderTopicsAndRoomsDecodeWithoutSessions() throws {
        let topic = try JSONDecoder().decode(Conversation.self, from: JSONEncoder().encode(Conversation(agent: .codex)))
        XCTAssertNil(topic.sessionID)
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(TeamRoom())) as? [String: Any])
        json.removeValue(forKey: "sessions")
        XCTAssertEqual(try JSONDecoder().decode(TeamRoom.self, from: JSONSerialization.data(withJSONObject: json)).sessions, [:])
    }
}
