import XCTest
@testable import AIROOMCore

final class RoundtableTests: XCTestCase {
    let claude = MemberCard(agent: .claude, name: "克勞蒂亞")
    let codex = MemberCard(agent: .codex, name: "GPT娘")
    let names: [AgentKind: String] = [.claude: "克勞蒂亞", .codex: "GPT娘"]

    private func topic() -> RoundtableTopic {
        var topic = RoundtableTopic(title: "第一集", kind: .proposals, material: "直播第一集要做什麼？",
                                    members: [.claude, .codex], lead: .claude)
        topic.submissions = [RoundtableSubmission(agent: .claude, text: "CLAUDE_PLAN"),
                             RoundtableSubmission(agent: .codex, text: "CODEX_PLAN")]
        return topic
    }

    func testPreparationIsIndependent() {
        var draft = topic()
        draft.submissions = [RoundtableSubmission(agent: .claude, text: "CLAUDE_PLAN")]
        let prompt = RoundtableFlow.preparePrompt(draft, member: codex, ownerName: "小明")
        XCTAssertFalse(prompt.contains("CLAUDE_PLAN"))
        XCTAssertTrue(prompt.contains("直播第一集要做什麼？"))
        XCTAssertTrue(prompt.contains("看不到"))
    }

    func testPeerReviewShowsOnlyTheOthers() {
        let prompt = RoundtableFlow.peerReviewPrompt(topic(), reviewer: claude, names: names)
        XCTAssertTrue(prompt.contains("CODEX_PLAN"))
        XCTAssertFalse(prompt.contains("CLAUDE_PLAN"))
    }

    func testFindingsAndBriefingCarryEveryVersion() {
        var t = topic()
        t.peerReviews = [RoundtableSubmission(agent: .codex, text: "REVIEW_X")]
        let findings = RoundtableFlow.findingsPrompt(t, lead: claude, names: names)
        XCTAssertTrue(findings.contains("CLAUDE_PLAN") && findings.contains("CODEX_PLAN") && findings.contains("REVIEW_X"))
        t.findings = "- 高：時間太緊（GPT娘）\n- 低：缺少片頭\n說明文字\n2. 第三個問題"
        XCTAssertEqual(t.findingCount, 3)
        let brief = RoundtableFlow.briefing(t, names: names)
        XCTAssertTrue(brief.contains("【問題清單】"))
        let room = TeamRoom(entries: [RoomEntry(speaker: .user, displayName: "你", body: "請審議")], briefing: brief)
        let prompt = LoungeEngine.turnPrompt(room: room, member: codex, present: [claude, codex],
                                             state: LoungeState(style: .meeting), ownerName: "小明", language: .zhTW)
        XCTAssertTrue(prompt.contains("CLAUDE_PLAN"), "deliberation sees the revealed versions")
    }

    func testFailedSubmissionsDoNotCountAndStatesDecode() throws {
        var t = topic()
        t.submissions[1] = RoundtableSubmission(agent: .codex, error: "timeout")
        XCTAssertEqual(t.completed, 1)
        XCTAssertTrue(t.allPrepared)
        XCTAssertFalse(RoundtableFlow.briefing(t, names: names).contains("timeout"))
        let restored = try JSONDecoder().decode(RoundtableTopic.self, from: JSONEncoder().encode(t))
        XCTAssertEqual(restored, t)
        let minimal = #"{"id":"6F9619FF-8B86-D011-B42D-00C04FC964FF","title":"舊"}"#
        XCTAssertEqual(try JSONDecoder().decode(RoundtableTopic.self, from: Data(minimal.utf8)).kind, .proposals)
    }

    func testHandoffCarriesConclusionAndAdoptedVersion() {
        var t = topic()
        t.conclusion = "結論：先做小需求"
        t.adopted = .codex
        let text = RoundtableFlow.handoff(t, names: names)
        XCTAssertTrue(text.contains("結論：先做小需求"))
        XCTAssertTrue(text.contains("採用的候選（GPT娘）"))
        XCTAssertTrue(text.contains("CODEX_PLAN"))
        XCTAssertFalse(RoundtableKind.review.hasCandidates)
    }

    func testAttentionRoutesToTheRoundtable() {
        var state = SavedState()
        var t = topic(); t.status = .conclusion
        var room = TeamRoom(roundtableID: t.id)
        room.lounge.phase = .awaitingHost
        state.rooms = [room]
        state.roundtableTopics = [t]
        let items = AttentionBuilder.items(state: state, cli: [:])
        XCTAssertTrue(items.contains { $0.target == .roundtable(t.id) && $0.kind == .acceptance })
        XCTAssertTrue(items.contains { $0.target == .roundtable(t.id) && $0.kind == .decision })
    }
}
