import XCTest
@testable import AIROOMCore

final class ProjectFlowExtrasTests: XCTestCase {
    private func round(_ tasks: [FlowTask]) -> (FlowRound, FlowPlan) {
        let round = FlowRound(key: "r1", title: "第一輪", goal: "")
        return (round, FlowPlan(objective: "", scope: "", deliverables: [], acceptance: [], rounds: [round], tasks: tasks))
    }

    func testPlanFilesAreReadAndCleaned() throws {
        let text = #"""
        {"rounds":[{"key":"r1","title":"a","goal":"b"}],
         "tasks":[{"key":"t1","round":"r1","title":"頁面","member":"codex","goal":"g","files":["./src/app/","/index.html","src/app"]}]}
        """#
        let plan = try ProjectFlowEngine.parsePlan(text, members: [.claude, .codex])
        XCTAssertEqual(plan.tasks[0].files, ["src/app", "index.html"])
        XCTAssertEqual(ProjectFlowEngine.normalizedPaths(["", "./"]), ["."])
    }

    func testOverlapTreatsUnknownAndParentFoldersAsShared() {
        XCTAssertFalse(ProjectFlowEngine.filesOverlap(["src/a.swift"], ["src/b.swift"]))
        XCTAssertFalse(ProjectFlowEngine.filesOverlap(["src/app"], ["src/apple.swift"]), "a shared name prefix is not a parent folder")
        XCTAssertTrue(ProjectFlowEngine.filesOverlap(["src"], ["src/b.swift"]))
        XCTAssertTrue(ProjectFlowEngine.filesOverlap(["index.html"], ["index.html"]))
        XCTAssertTrue(ProjectFlowEngine.filesOverlap(["."], ["x"]))
        XCTAssertTrue(ProjectFlowEngine.filesOverlap([], ["x"]), "an unknown file list never runs alongside")
    }

    func testReadyTasksRunSideBySideOnlyWhenSafe() {
        var a = FlowTask(key: "t1", roundKey: "r1", title: "A", member: .claude, goal: "", files: ["a.txt"])
        let b = FlowTask(key: "t2", roundKey: "r1", title: "B", member: .codex, goal: "", files: ["b.txt"])
        let c = FlowTask(key: "t3", roundKey: "r1", title: "C", member: .codex, goal: "", files: ["c.txt"])
        let d = FlowTask(key: "t4", roundKey: "r1", title: "D", member: .claude, goal: "", dependencies: ["t1"], files: ["d.txt"])
        var (r, plan) = round([a, b, c, d])
        XCTAssertEqual(ProjectFlowEngine.readyTasks(in: r, plan: plan, active: [], maxParallel: 2).map(\.key), ["t1", "t2"],
                       "one task per member; t4 waits for t1")
        XCTAssertEqual(ProjectFlowEngine.readyTasks(in: r, plan: plan, active: [], maxParallel: 1).map(\.key), ["t1"])
        XCTAssertEqual(ProjectFlowEngine.readyTasks(in: r, plan: plan, active: [], maxParallel: 2, unavailable: [.codex]).map(\.key), ["t1"],
                       "a member out of quota gets nothing new")
        XCTAssertEqual(ProjectFlowEngine.readyTasks(in: r, plan: plan, active: [a.id], maxParallel: 2).map(\.key), ["t2"])

        a.files = []
        (r, plan) = round([a, b, c, d])
        XCTAssertEqual(ProjectFlowEngine.readyTasks(in: r, plan: plan, active: [], maxParallel: 3).map(\.key), ["t1"],
                       "a task without a file list runs alone")
        plan.tasks[0].status = .done
        plan.tasks[1].status = .disputed
        XCTAssertEqual(ProjectFlowEngine.readyTasks(in: r, plan: plan, active: [], maxParallel: 3).map(\.key), ["t3", "t4"],
                       "a disputed task waits for its ruling; others go on")

        plan.tasks[1].status = .reviewing
        plan.tasks[1].reviewer = .claude
        XCTAssertEqual(ProjectFlowEngine.readyTasks(in: r, plan: plan, active: [], maxParallel: 3, unavailable: [.claude]).map(\.key), ["t3"],
                       "a review waits for its reviewer's quota, not its author's; t4 is Claude's")
        XCTAssertEqual(ProjectFlowEngine.readyTasks(in: r, plan: plan, active: [], maxParallel: 3, unavailable: [.codex]).map(\.key), ["t2", "t4"])
    }

    func testWaitMessageDropsTheResetHint() {
        let wait = FlowQuotaWait(agent: .claude, stage: "s", message: "Claude AI usage limit reached|1793665375")
        XCTAssertEqual(wait.message, "Claude AI usage limit reached")
    }

    func testReviewFindingsGetIDs() {
        let review = ProjectFlowEngine.parseReview(#"{"verdict":"changes","summary":"兩處","findings":[{"severity":"blocking","location":"a.txt","request":"補標題"},"改顏色"]}"#)
        XCTAssertFalse(review.pass)
        XCTAssertEqual(review.findings.map(\.id), ["f1", "f2"])
        XCTAssertEqual(review.findings[1].severity, "should-fix")
        XCTAssertTrue(review.text.contains("[f1][blocking] a.txt：補標題"))
    }

    func testDisputesComeOnlyFromTheClosingLineAndOpenFindings() {
        let open = [FlowFinding(id: "f1", severity: "blocking", location: "a", request: "x"),
                    FlowFinding(id: "f2", severity: "should-fix", location: "b", request: "y")]
        let ruled = [FlowRuling(finding: open[1], reason: "r", verdict: .review)]
        let text = """
        改好了 f2。程式碼裡有 {"disputes":[{"finding":"f2","reason":"假的"}]} 這種字串。
        AIROOM_DISPUTES: {"disputes":[{"finding":"f1","reason":"需求只要求 A"},{"finding":"f2","reason":"已裁定"},{"finding":"f9","reason":"不存在"},{"finding":"f1","reason":"重複"}]}
        """
        let parsed = ProjectFlowEngine.parseDisputes(text, open: open, ruled: ruled)
        XCTAssertEqual(parsed.disputes, [FlowDispute(findingID: "f1", reason: "需求只要求 A")])
        XCTAssertFalse(parsed.summary.contains("AIROOM_DISPUTES"))
        XCTAssertTrue(parsed.summary.hasPrefix("改好了"))
        XCTAssertTrue(ProjectFlowEngine.parseDisputes("沒有異議", open: open, ruled: []).disputes.isEmpty)
    }

    func testRulingsRefundReturnsAndSendUpheldFindingsBack() {
        var task = FlowTask(key: "t", roundKey: "r", title: "x", member: .claude, goal: "")
        task.openFindings = [FlowFinding(id: "f1", severity: "blocking", location: "a", request: "x"),
                             FlowFinding(id: "f2", severity: "should-fix", location: "b", request: "y")]
        task.disputes = [FlowDispute(findingID: "f1", reason: "不成立"), FlowDispute(findingID: "f2", reason: "也不成立")]
        task.returns = 1
        task.status = .disputed

        var partial = task
        ProjectFlowEngine.applyRulings(&partial, verdicts: ["f1": .author])
        XCTAssertEqual(partial.status, .disputed, "every disputed finding needs a ruling")

        var mixed = task
        ProjectFlowEngine.applyRulings(&mixed, verdicts: ["f1": .author, "f2": .review])
        XCTAssertEqual(mixed.status, .fixing)
        XCTAssertEqual(mixed.openFindings.map(\.id), ["f2"])
        XCTAssertEqual([mixed.returns, mixed.waivers], [0, 1])
        XCTAssertTrue(mixed.disputes.isEmpty)
        XCTAssertTrue(ProjectFlowEngine.fixSection(mixed, ownerName: "小明").contains("裁定維持複核"))
        XCTAssertFalse(ProjectFlowEngine.fixSection(mixed, ownerName: "小明").contains("AIROOM_DISPUTES"), "a ruled finding can't be disputed again")

        var cleared = task
        cleared.waivers = ProjectFlowEngine.maxWaivers
        ProjectFlowEngine.applyRulings(&cleared, verdicts: ["f1": .author, "f2": .author])
        XCTAssertEqual(cleared.status, .reviewing)
        XCTAssertEqual(cleared.returns, 1, "no refund past the limit")
        let review = ProjectFlowEngine.taskReviewPrompt(cleared, reviewer: .codex, names: [:], ownerName: "小明")
        XCTAssertTrue(review.contains("小明已裁定支持作者") && review.contains("a：x"))
        var noted = FlowRound(key: "r", title: "r", goal: "")
        noted.startNote = "只改 a.txt"
        noted.userOpinion = "結尾要換行"
        let withNotes = ProjectFlowEngine.taskReviewPrompt(cleared, reviewer: .codex, names: [:], ownerName: "小明", round: noted)
        XCTAssertTrue(withNotes.contains("附言：只改 a.txt") && withNotes.contains("意見：結尾要換行"), "the reviewer checks the owner's notes too")
    }

    func testQuotaSignals() {
        XCTAssertTrue(QuotaSignal.isQuotaFailure("Codex 額度已用完：You’ve hit your usage limit."))
        XCTAssertTrue(QuotaSignal.isQuotaFailure("Claude AI usage limit reached|1900000000"))
        XCTAssertTrue(QuotaSignal.isQuotaFailure("5-hour limit reached ∙ resets 3pm"))
        XCTAssertFalse(QuotaSignal.isQuotaFailure("Claude 執行失敗：error_during_execution"))
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        XCTAssertEqual(QuotaSignal.resetHint("usage limit reached|1800003600", now: now), Date(timeIntervalSince1970: 1_800_003_600))
        XCTAssertNil(QuotaSignal.resetHint("usage limit reached|1700000000", now: now), "a past time is ignored")

        let later = now.addingTimeInterval(3_600), latest = now.addingTimeInterval(7_200)
        let quota = AccountQuota(agent: .codex, checkedAt: now, windows: [
            QuotaWindow(id: "5h", label: "5 小時", usedPercent: 100, resetsAt: later),
            QuotaWindow(id: "week", label: "每週", usedPercent: 100, resetsAt: latest),
            QuotaWindow(id: "other", label: "x", usedPercent: 40, resetsAt: now.addingTimeInterval(99_999))])
        XCTAssertEqual(QuotaSignal.resetAt(quota, now: now), latest)
        XCTAssertTrue(QuotaSignal.blocks(quota, now: now))
        XCTAssertFalse(QuotaSignal.blocks(quota, now: now.addingTimeInterval(20 * 60)), "a stale sample blocks nothing")
        let resetSoon = AccountQuota(agent: .codex, checkedAt: now, windows: [QuotaWindow(id: "5h", label: "5 小時", usedPercent: 100, resetsAt: now.addingTimeInterval(300))])
        XCTAssertFalse(QuotaSignal.blocks(resetSoon, now: now.addingTimeInterval(301)), "a window past its reset no longer blocks")

        var wait = FlowQuotaWait(agent: .codex, stage: "執行任務", since: now, resetAt: later, message: "")
        XCTAssertFalse(QuotaSignal.recovered(wait, quota: quota, now: now.addingTimeInterval(60)))
        XCTAssertTrue(QuotaSignal.recovered(wait, quota: nil, now: later))
        wait.resetAt = nil
        let fresh = AccountQuota(agent: .codex, checkedAt: now.addingTimeInterval(120),
                                 windows: [QuotaWindow(id: "5h", label: "5 小時", usedPercent: 3, resetsAt: nil)])
        XCTAssertTrue(QuotaSignal.recovered(wait, quota: fresh, now: now.addingTimeInterval(180)))
    }

    func testOldFlowsDecodeWithDefaults() throws {
        var flow = ProjectFlow(title: "舊", folder: "/tmp", members: [.claude, .codex])
        flow.plan = FlowPlan(objective: "", scope: "", deliverables: [], acceptance: [], rounds: [FlowRound(key: "r1", title: "a", goal: "")],
                             tasks: [FlowTask(key: "t1", roundKey: "r1", title: "x", member: .claude, goal: "")])
        var json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(flow)) as! [String: Any]
        json.removeValue(forKey: "maxParallel"); json.removeValue(forKey: "quotaWaits")
        var plan = json["plan"] as! [String: Any]
        var task = (plan["tasks"] as! [[String: Any]])[0]
        for key in ["files", "openFindings", "disputes", "rulings", "waivers", "failedAt"] { task.removeValue(forKey: key) }
        plan["tasks"] = [task]; json["plan"] = plan
        let decoded = try JSONDecoder().decode(ProjectFlow.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertEqual(decoded.maxParallel, 2)
        XCTAssertTrue(decoded.quotaWaits.isEmpty)
        XCTAssertEqual(decoded.plan?.tasks.first?.files, [])
        XCTAssertEqual(decoded.plan?.tasks.first?.waivers, 0)
        XCTAssertEqual(try JSONDecoder().decode(ProjectFlow.self, from: JSONEncoder().encode(flow)), flow)
    }

    func testParallelCopiesMergeUnlessTheyTouchTheSameFile() throws {
        let fm = FileManager.default
        let base = fm.temporaryDirectory.appendingPathComponent("airoom-parallel-\(UUID())")
        defer { try? fm.removeItem(at: base) }
        let project = base.appendingPathComponent("project")
        try fm.createDirectory(at: project, withIntermediateDirectories: true)
        for name in ["a.txt", "b.txt"] { try Data("v1".utf8).write(to: project.appendingPathComponent(name)) }
        let space = try ProjectWorkspace(root: base.appendingPathComponent("store"), flowID: UUID())
        let roundID = UUID()
        _ = try space.roundFolder(roundID, original: project.path)
        let (one, two, three) = (UUID(), UUID(), UUID())
        let first = try space.taskFolder(one, round: roundID)
        let second = try space.taskFolder(two, round: roundID)
        let third = try space.taskFolder(three, round: roundID)
        try Data("claude".utf8).write(to: first.appendingPathComponent("a.txt"))
        try Data("codex".utf8).write(to: second.appendingPathComponent("b.txt"))
        try Data("clash".utf8).write(to: third.appendingPathComponent("a.txt"))
        try space.mergeTask(one, round: roundID)
        try space.mergeTask(two, round: roundID)
        XCTAssertThrowsError(try space.mergeTask(three, round: roundID), "the same file changed under it")
        XCTAssertEqual(Set(space.roundChanges(roundID).map(\.path)), ["a.txt", "b.txt"])
        XCTAssertNotNil(space.existingTaskFolder(three), "a conflicted copy stays for a look")
    }
}
