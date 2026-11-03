import XCTest
@testable import AIROOMCore

final class WorkstationTests: XCTestCase {
    func testLedgerCountsPerDayAndPrunesOldDays() {
        var ledger = CallLedger()
        for event in [CallEvent.attempt, .delivered, .completed] { ledger.record(event, agent: .claude, day: "2026-11-02") }
        ledger.record(.attempt, agent: .claude, day: "2026-11-01")
        ledger.record(.notSent, agent: .claude, day: "2026-11-01")
        XCTAssertEqual(ledger.usage(.claude, day: "2026-11-02").completed, 1)
        XCTAssertEqual(ledger.usage(.claude).total, 2)
        XCTAssertEqual(ledger.usage(.codex).total, 0)
        XCTAssertEqual(ledger.usage(.claude).label(.zhTW), "累計嘗試 2 次 · 已發出 1 次 · 已完成 1 次 · 未發出失敗 1 次")
        for day in 1...70 { ledger.record(.attempt, agent: .codex, day: String(format: "2026-01-%02d", day), keepDays: 60) }
        XCTAssertEqual(ledger.days["Codex"]?.count, 60)
        XCTAssertNil(ledger.days["Codex"]?["2026-01-01"], "oldest days are dropped")
    }

    func testAttentionListsWhatNeedsTheUser() {
        var state = SavedState()
        var room = TeamRoom(title: "週會")
        let asked = UUID()
        room.lounge.questions = [LoungeQuestion(from: .claude, text: "要選哪個？", entryID: asked)]
        room.lounge.phase = .awaitingHost
        room.entries = [RoomEntry(speaker: .assistant, agent: .codex, displayName: "Codex", body: "x", delivery: .failed)]
        state.rooms = [room]
        state.projects = [ProjectRecord(title: "網站", originalFolder: "/tmp", phase: .reviewing)]
        let items = AttentionBuilder.items(state: state, cli: [.claude: .notLoggedIn, .codex: .authenticated])
        XCTAssertEqual(Set(items.map(\.kind)), [.login, .question, .decision, .unknown, .acceptance])
        XCTAssertEqual(items.first(where: { $0.kind == .question })?.target, .room(room.id))
        XCTAssertEqual(items.first(where: { $0.kind == .login })?.target, .settings)
    }

    func testAnsweredQuestionsAndOlderFailuresDoNotNag() {
        var room = TeamRoom()
        room.lounge.questions = [LoungeQuestion(from: .claude, text: "?", entryID: UUID(), answered: true)]
        room.entries = [RoomEntry(speaker: .assistant, agent: .codex, displayName: "Codex", body: "x", delivery: .failed),
                        RoomEntry(speaker: .assistant, agent: .codex, displayName: "Codex", body: "ok")]
        var state = SavedState(); state.rooms = [room]
        XCTAssertTrue(AttentionBuilder.items(state: state, cli: [:]).isEmpty)
    }

    func testLoginScriptQuotesThePathAndRunsOnlyTheLoginCommand() {
        let script = LoginScript.contents(agent: .claude, executable: URL(fileURLWithPath: "/Apps/it's here/claude"))
        XCTAssertTrue(script.contains(#"'/Apps/it'\''s here/claude' auth login"#))
        XCTAssertTrue(LoginScript.contents(agent: .codex, executable: URL(fileURLWithPath: "/bin/codex")).contains("'/bin/codex' login"))
    }

    func testUserNameIsOptionalAndUsedInPrompts() throws {
        let legacy = try JSONDecoder().decode(NativeSettings.self, from: Data(#"{"claudePath":"","codexPath":"","workspacePath":""}"#.utf8))
        XCTAssertEqual(legacy.userName, "")
        XCTAssertEqual(legacy.ownerName, "使用者")
        XCTAssertEqual(NativeSettings(userName: "小明").ownerName, "小明")
        XCTAssertTrue(PromptBuilder.build(history: [], newQuestion: "hi", userName: "小明").contains("請稱呼使用者為「小明」"))
        XCTAssertFalse(PromptBuilder.build(history: [], newQuestion: "hi").contains("請稱呼"))
    }
}

/// The runner reports one attempt, at most one delivery, then one outcome.
final class CallEventTests: XCTestCase {
    private final class Recorder: @unchecked Sendable {
        private let lock = NSLock()
        private var events: [CallEvent] = []
        func add(_ event: CallEvent) { lock.lock(); events.append(event); lock.unlock() }
        var all: [String] { lock.lock(); defer { lock.unlock() }; return events.map { "\($0)" } }
    }

    private func fakeClaude(_ body: String) throws -> (URL, URL) {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("airoom-fake-\(UUID())")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let script = folder.appendingPathComponent("claude")
        try Data("#!/bin/sh\ncat >/dev/null\n\(body)\n".utf8).write(to: script)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        return (folder, script)
    }

    private func run(_ script: URL?, folder: URL) async -> [String] {
        let recorder = Recorder()
        let runner = CLIProcessRunner()
        runner.observer = { _, event in recorder.add(event) }
        let settings = NativeSettings(claudePath: script?.path ?? folder.appendingPathComponent("missing").path,
                                      workspacePath: folder.path)
        _ = try? await runner.run(agent: .claude, prompt: "hi", settings: settings, fallbackWorkspace: folder, onUpdate: { _ in })
        return recorder.all
    }

    func testSuccessfulRun() async throws {
        let (folder, script) = try fakeClaude(#"echo '{"type":"result","result":"ok"}'"#)
        defer { try? FileManager.default.removeItem(at: folder) }
        let events = await run(script, folder: folder)
        XCTAssertEqual(events, ["attempt", "delivered", "completed"])
    }

    func testFailureAfterSendingIsUnknown() async throws {
        let (folder, script) = try fakeClaude("exit 3")
        defer { try? FileManager.default.removeItem(at: folder) }
        let events = await run(script, folder: folder)
        XCTAssertEqual(events, ["attempt", "delivered", "unknown"])
    }

    func testMissingProgramIsNotSent() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("airoom-fake-\(UUID())")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let events = await run(nil, folder: folder)
        XCTAssertEqual(events, ["attempt", "notSent"])
    }
}
