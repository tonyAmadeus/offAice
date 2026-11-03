import XCTest
@testable import AIROOMCore

final class ProjectFlowTests: XCTestCase {
    let both: [AgentKind] = [.claude, .codex]
    let plan = #"""
    ```json
    {"objective":"做開場白頁","scope":"只改 index.html","deliverables":["index.html"],"acceptance":["打開能看到開場白"],
     "rounds":[{"key":"r1","title":"草稿","goal":"寫出頁面"},{"key":"r2","title":"潤飾","goal":"調整樣式"},{"key":"r3","title":"空輪","goal":"x"}],
     "tasks":[{"key":"t1","round":"r1","title":"寫 HTML","member":"codex","goal":"建立頁面","criteria":["有標題"],"dependencies":[]},
              {"key":"t2","round":"r1","title":"寫文案","member":"Claude Code","goal":"台詞","dependencies":["t1","t9"]},
              {"key":"t3","round":"r2","title":"樣式","member":"claude","goal":"CSS","dependencies":["t2"]}]}
    ```
    """#

    func testParsesPlanAndDropsEmptyRoundsAndUnknownDependencies() throws {
        let parsed = try ProjectFlowEngine.parsePlan(plan, members: both)
        XCTAssertEqual(parsed.rounds.map(\.key), ["r1", "r2"])
        XCTAssertEqual(parsed.tasks.map(\.member), [.codex, .claude, .claude])
        XCTAssertEqual(parsed.tasks[1].dependencies, ["t1"], "t9 does not exist earlier")
        XCTAssertEqual(parsed.acceptance, ["打開能看到開場白"])
    }

    func testRejectsAbsentMembersAndUnreadablePlans() {
        XCTAssertThrowsError(try ProjectFlowEngine.parsePlan(plan, members: [.claude])) { error in
            XCTAssertEqual(error as? FlowPlanError, .unknownMember("codex"))
        }
        XCTAssertThrowsError(try ProjectFlowEngine.parsePlan("好的，我來規劃", members: both))
    }

    func testDependenciesGateTheNextTask() throws {
        var parsed = try ProjectFlowEngine.parsePlan(plan, members: both)
        let first = parsed.rounds[0]
        XCTAssertEqual(ProjectFlowEngine.nextTask(in: first, plan: parsed)?.key, "t1")
        parsed.tasks[0].status = .running
        XCTAssertNil(ProjectFlowEngine.nextTask(in: first, plan: parsed), "t2 waits for t1")
        parsed.tasks[0].status = .done
        XCTAssertEqual(ProjectFlowEngine.nextTask(in: first, plan: parsed)?.key, "t2")
    }

    func testReviewerIsAnotherMemberAndVerdictsParse() {
        let task = FlowTask(key: "t", roundKey: "r", title: "x", member: .claude, goal: "")
        XCTAssertEqual(ProjectFlowEngine.reviewer(for: task, lead: .claude, members: both), .codex)
        XCTAssertEqual(ProjectFlowEngine.reviewer(for: task, lead: .codex, members: both), .codex)
        let changes = ProjectFlowEngine.parseVerdict(#"{"verdict":"changes","findings":[{"severity":"blocking","location":"index.html","request":"補標題"}]}"#)
        XCTAssertFalse(changes.pass)
        XCTAssertTrue(changes.findings.contains("補標題"))
        XCTAssertTrue(ProjectFlowEngine.parseVerdict(#"{"verdict":"pass","summary":"ok"}"#).pass)
    }
}

final class ProjectWorkspaceTests: XCTestCase {
    func testTaskEditsReachTheProjectOnlyThroughMergeAndAcceptance() throws {
        let fm = FileManager.default
        let base = fm.temporaryDirectory.appendingPathComponent("airoom-flow-\(UUID())")
        defer { try? fm.removeItem(at: base) }
        let project = base.appendingPathComponent("project")
        try fm.createDirectory(at: project, withIntermediateDirectories: true)
        try Data("v1".utf8).write(to: project.appendingPathComponent("a.txt"))
        let space = try ProjectWorkspace(root: base.appendingPathComponent("store"), flowID: UUID())
        let round = UUID(), task = UUID()
        _ = try space.roundFolder(round, original: project.path)
        let taskFolder = try space.taskFolder(task, round: round)
        try Data("v2".utf8).write(to: taskFolder.appendingPathComponent("a.txt"))
        try Data("new".utf8).write(to: taskFolder.appendingPathComponent("b.txt"))
        XCTAssertEqual(space.taskChanges(task).map(\.path), ["a.txt", "b.txt"])
        XCTAssertEqual(space.roundChanges(round), [], "nothing merged yet")
        try space.mergeTask(task, round: round)
        XCTAssertEqual(space.roundChanges(round).count, 2)
        XCTAssertEqual(String(decoding: try Data(contentsOf: project.appendingPathComponent("a.txt")), as: UTF8.self), "v1")
        try space.acceptRound(round, original: project.path)
        XCTAssertEqual(String(decoding: try Data(contentsOf: project.appendingPathComponent("a.txt")), as: UTF8.self), "v2")
        XCTAssertTrue(fm.fileExists(atPath: project.appendingPathComponent("b.txt").path))
    }

    func testReadFilesModeGivesClaudeReadToolsOnly() {
        let args = CommandPlan.arguments(for: .claude, access: .readFiles)
        XCTAssertEqual(args[args.firstIndex(of: "--tools")! + 1], "Read,Glob,Grep")
        XCTAssertFalse(args.contains("acceptEdits"))
        XCTAssertTrue(CommandPlan.arguments(for: .codex, access: .readFiles).contains("read-only"))
    }

    func testAttentionAsksForPlanAndAcceptance() throws {
        var flow = ProjectFlow(title: "網站", folder: "/tmp", members: [.claude, .codex])
        flow.plan = try ProjectFlowEngine.parsePlan(#"{"rounds":[{"key":"r1","title":"一","goal":"g"}],"tasks":[{"key":"t1","round":"r1","title":"x","member":"claude","goal":"g"}]}"#, members: flow.members)
        flow.step = .plan
        var state = SavedState(); state.projectFlows = [flow]
        XCTAssertEqual(AttentionBuilder.items(state: state, cli: [:]).first?.kind, .decision)
        state.projectFlows[0].step = .acceptance
        state.projectFlows[0].plan!.rounds[0].status = .awaitingAcceptance
        let item = try XCTUnwrap(AttentionBuilder.items(state: state, cli: [:]).first)
        XCTAssertEqual(item.kind, .acceptance)
        XCTAssertEqual(item.target, .project(flow.id))
    }
}

final class PlanRevisionTests: XCTestCase {
    func testRevisionPromptMarksAcceptedRoundsAsDone() throws {
        var flow = ProjectFlow(title: "網站", folder: "/tmp", members: [.claude, .codex])
        flow.lead = .claude
        var plan = try ProjectFlowEngine.parsePlan(#"{"rounds":[{"key":"r1","title":"建立頁面","goal":"g"},{"key":"r2","title":"加樣式","goal":"g"}],"tasks":[{"key":"t1","round":"r1","title":"寫頁面","member":"codex","goal":"g"},{"key":"t2","round":"r2","title":"寫CSS","member":"claude","goal":"g"}]}"#, members: flow.members)
        plan.rounds[0].status = .accepted
        plan.rounds[0].report = "page.html 已完成"
        flow.plan = plan
        flow.planRequests = ["加 footer"]
        let prompt = ProjectFlowEngine.planPrompt(flow, discussion: "", names: [:], ownerName: "小明")
        XCTAssertTrue(prompt.contains("已完成並通過驗收的輪次"))
        XCTAssertTrue(prompt.contains("建立頁面：page.html 已完成"))
        XCTAssertFalse(prompt.contains("\"寫頁面\""), "the accepted round's tasks are not offered for re-planning")
        XCTAssertTrue(prompt.contains("寫CSS"))
    }
}
