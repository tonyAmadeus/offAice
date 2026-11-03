import Foundation
import XCTest
@testable import AIROOMCore

final class WorkflowFeatureTests: XCTestCase {
    func testLiveNextSpeakerAlternatesAndDeduplicates() {
        let roster: [AgentKind] = [.claude, .codex, .claude]
        XCTAssertEqual(LiveShowPolicy.nextSpeaker(participants: roster, last: nil), .claude)
        XCTAssertEqual(LiveShowPolicy.nextSpeaker(participants: roster, last: .claude), .codex)
        XCTAssertEqual(LiveShowPolicy.nextSpeaker(participants: roster, last: .codex), .claude)
    }

    func testLiveCannotStartWithoutBothMembers() {
        let config = LiveShowSettings()
        XCTAssertFalse(LiveShowPolicy.canStart(participants: [.claude], enabled: [.claude, .codex], config: config))
        XCTAssertFalse(LiveShowPolicy.canStart(participants: [.claude, .codex], enabled: [.claude], config: config))
        XCTAssertTrue(LiveShowPolicy.canStart(participants: [.claude, .codex], enabled: [.claude, .codex], config: config))
    }

    func testLiveCannotContinueAfterDeadlineOrUserStop() {
        let config = LiveShowSettings(maxTurns: 12, maxDurationMinutes: 30)
        let start = Date(timeIntervalSince1970: 1000)
        XCTAssertTrue(LiveShowPolicy.shouldContinue(turns: 11, started: start, now: start.addingTimeInterval(29*60), config: config, hasTwoAgents: true, userStopped: false))
        XCTAssertFalse(LiveShowPolicy.shouldContinue(turns: 12, started: start, now: start, config: config, hasTwoAgents: true, userStopped: false))
        XCTAssertFalse(LiveShowPolicy.shouldContinue(turns: 2, started: start, now: start.addingTimeInterval(30*60), config: config, hasTwoAgents: true, userStopped: false))
        XCTAssertFalse(LiveShowPolicy.shouldContinue(turns: 2, started: start, now: start, config: config, hasTwoAgents: true, userStopped: true))
    }

    func testLiveSettingsBoundResourceUse() {
        let config = LiveShowSettings(topic: String(repeating: "x", count: 3000), turnDelaySeconds: 0, maxTurns: 10_000, maxDurationMinutes: 1000, summary: String(repeating: "y", count: 6000))
        XCTAssertEqual(config.topic.count, 2000)
        XCTAssertEqual(config.turnDelaySeconds, 15)
        XCTAssertEqual(config.maxTurns, 300)
        XCTAssertEqual(config.maxDurationMinutes, 240)
        XCTAssertEqual(config.summary.count, 5000)
    }

    func testLivePromptIncludesConfirmedHistoryButNotInProgress() {
        let room = TeamRoom(entries: [
            RoomEntry(speaker: .user, displayName: "觀眾 · 阿明", body: "最喜歡什麼遊戲？"),
            RoomEntry(speaker: .assistant, agent: .claude, displayName: "Claude", body: "我喜歡策略遊戲。"),
            RoomEntry(speaker: .assistant, agent: .codex, displayName: "Codex", body: "secret unfinished", delivery: .inProgress)
        ])
        let prompt = LiveShowPolicy.prompt(room: room, speaker: .codex, topic: "遊戲", summary: "目前聊遊戲", language: .zhTW)
        XCTAssertTrue(prompt.contains("阿明"))
        XCTAssertTrue(prompt.contains("我喜歡策略遊戲"))
        XCTAssertTrue(prompt.contains("目前聊遊戲"))
        XCTAssertFalse(prompt.contains("secret unfinished"))
    }

    func testSavedStateOldFilesDecodeNewFeaturesWithDefaults() throws {
        let data = try JSONSerialization.data(withJSONObject: ["members": [], "rooms": [], "projects": []])
        let restored = try JSONDecoder().decode(SavedState.self, from: data)
        XCTAssertEqual(restored.liveShow.maxTurns, 80)
        XCTAssertTrue(restored.schedules.isEmpty)
        XCTAssertFalse(restored.autoChat.enabled)
        XCTAssertTrue(restored.teamWorkflows.isEmpty)
    }

    func testLiveSettingsAndWorkflowPersist() throws {
        let roomID = UUID()
        let projectID = UUID()
        let data = SavedState(schedules: [ScheduledActivity(name: "中午", action: .reminder, text: "休息", hour: 12, minute: 0)],
            teamWorkflows: [TeamProjectWorkflow(id: projectID)],
            liveShow: LiveShowSettings(roomID: roomID, topic: "遊戲直播", summary: "角色關係"))
        let saved = try JSONEncoder().encode(data)
        let restored = try JSONDecoder().decode(SavedState.self, from: saved)
        XCTAssertEqual(restored.liveShow.roomID, roomID)
        XCTAssertEqual(restored.liveShow.summary, "角色關係")
        XCTAssertEqual(restored.schedules.count, 1)
        XCTAssertEqual(restored.teamWorkflows.first?.id, projectID)
    }

    func testScheduleOncePerDayAndWeekday() {
        let cal = Calendar(identifier: .gregorian)
        var item = ScheduledActivity(name: "Noon", action: .reminder, text: "Hello", hour: 12, minute: 5)
        let now = cal.date(from: DateComponents(year: 2026, month: 11, day: 2, hour: 12, minute: 5))!
        XCTAssertTrue(LocalAutomation.shouldFire(item, now: now, calendar: cal))
        item.lastFiredDay = LocalAutomation.dayKey(now, calendar: cal)
        XCTAssertFalse(LocalAutomation.shouldFire(item, now: now, calendar: cal))
        item.lastFiredDay = nil; item.weekdays = [7] // Nov 2, 2026 Monday
        XCTAssertFalse(LocalAutomation.shouldFire(item, now: now, calendar: cal))
        item.weekdays = [1]
        XCTAssertTrue(LocalAutomation.shouldFire(item, now: now, calendar: cal))
    }

    func testOccasionalChatDailyLimitAndInterval() {
        let now = Date(timeIntervalSince1970: 5000)
        var rule = AutoChatSettings(enabled: true, intervalMinutes: 60, dailyLimit: 2)
        XCTAssertTrue(LocalAutomation.shouldAutoChat(rule, now: now, roomExists: true, quotaAvailable: true))
        rule.lastFiredAt = now.addingTimeInterval(-30 * 60)
        XCTAssertFalse(LocalAutomation.shouldAutoChat(rule, now: now, roomExists: true, quotaAvailable: true))
        rule.lastFiredAt = now.addingTimeInterval(-70 * 60)
        rule.firedDays[LocalAutomation.dayKey(now)] = 2
        XCTAssertFalse(LocalAutomation.shouldAutoChat(rule, now: now, roomExists: true, quotaAvailable: true))
        rule.firedDays[LocalAutomation.dayKey(now)] = 1
        XCTAssertFalse(LocalAutomation.shouldAutoChat(rule, now: now, roomExists: true, quotaAvailable: false))
    }

    func testRoundtableVotesAreAdvisoryAndRequireExactFirstLine() {
        XCTAssertEqual(RoundtableDecision.parseVote("Vote: codex\nReasons"), .codex)
        XCTAssertEqual(RoundtableDecision.parseVote("vote: CLAUDE\nReasons"), .claude)
        XCTAssertNil(RoundtableDecision.parseVote("I would vote: codex"))
        XCTAssertNil(RoundtableDecision.parseVote("Vote: someone else"))
        let results = [RoundtableResult(agent: .codex, text: "candidate"), RoundtableResult(agent: .claude, text: "", error: "failed")]
        XCTAssertTrue(RoundtableDecision.eligible(results, agent: .codex))
        XCTAssertFalse(RoundtableDecision.eligible(results, agent: .claude))
    }

    func testProjectCannotExecuteUntilHumanApprovesProposal() throws {
        var workflow = TeamProjectWorkflow(id: UUID())
        XCTAssertThrowsError(try TeamProjectCoordinator.approve(&workflow))
        try TeamProjectCoordinator.chooseLeader(&workflow, agent: .claude)
        XCTAssertThrowsError(try TeamProjectCoordinator.recordProposal(&workflow, text: "  "))
        try TeamProjectCoordinator.recordProposal(&workflow, text: "Implement A and test B")
        XCTAssertThrowsError(try TeamProjectCoordinator.readyForReview(&workflow))
        try TeamProjectCoordinator.approve(&workflow)
        XCTAssertEqual(workflow.step, .execution)
        try TeamProjectCoordinator.readyForReview(&workflow)
        XCTAssertEqual(workflow.step, .review)
        try TeamProjectCoordinator.finish(&workflow, accepted: false)
        XCTAssertEqual(workflow.step, .proposal)
        XCTAssertFalse(workflow.approved)
        try TeamProjectCoordinator.approve(&workflow)
        try TeamProjectCoordinator.readyForReview(&workflow)
        try TeamProjectCoordinator.finish(&workflow, accepted: true)
        XCTAssertEqual(workflow.step, .completed)
    }
}
