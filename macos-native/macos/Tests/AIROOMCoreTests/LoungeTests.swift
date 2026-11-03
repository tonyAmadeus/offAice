import XCTest
@testable import AIROOMCore

final class LoungeTests: XCTestCase {
    let both: [AgentKind] = [.claude, .codex]
    let cards = [MemberCard(agent: .claude, name: "克勞蒂亞"), MemberCard(agent: .codex, name: "GPT娘")]

    private func reply(_ action: LoungeAction, _ body: String = "", emoji: String? = nil) -> LoungeReply {
        LoungeReply(action: action, body: body, emoji: emoji, next: nil, questions: [], unstructured: false)
    }

    func testMentionsMatchDisplayAndShortNamesInOrder() {
        XCTAssertEqual(LoungeEngine.mentions(in: "@GPT娘 你先說，然後 @claude", members: cards), [.codex, .claude])
        XCTAssertEqual(LoungeEngine.mentions(in: "大家好", members: cards), [])
    }

    func testChatNeverRepeatsSpeakerAndHonoursMentions() {
        var state = LoungeState(style: .chat)
        LoungeEngine.humanSpoke(&state, mentions: [.codex], present: both, entryID: UUID())
        XCTAssertEqual(LoungeEngine.nextSpeaker(state, present: both, random: { 0 }), .codex)
        _ = LoungeEngine.apply(reply(.speak, "嗨"), from: .codex, present: both, state: &state, entryID: UUID())
        for draw in [0.0, 0.5, 0.99] {
            XCTAssertEqual(LoungeEngine.nextSpeaker(state, present: both, random: { draw }), .claude)
        }
    }

    func testChatEndsWhenEveryonePasses() {
        var state = LoungeState(style: .chat)
        LoungeEngine.humanSpoke(&state, mentions: [], present: both, entryID: UUID())
        XCTAssertEqual(LoungeEngine.apply(reply(.pass), from: .claude, present: both, state: &state, entryID: UUID()), .silent)
        guard case .ended = LoungeEngine.apply(reply(.pass), from: .codex, present: both, state: &state, entryID: UUID()) else {
            return XCTFail("chat should end")
        }
        XCTAssertEqual(state.phase, .idle)
    }

    func testProposalNeedsEnoughTalkThenEveryoneAccepting() {
        var state = LoungeState(style: .chat)
        LoungeEngine.humanSpoke(&state, mentions: [], present: both, entryID: UUID())
        _ = LoungeEngine.apply(reply(.propose, "先這樣吧"), from: .claude, present: both, state: &state, entryID: UUID())
        XCTAssertEqual(state.phase, .talking, "too early: treated as a remark")
        for speaker in [AgentKind.codex, .claude, .codex] {
            _ = LoungeEngine.apply(reply(.speak, "嗯"), from: speaker, present: both, state: &state, entryID: UUID())
        }
        _ = LoungeEngine.apply(reply(.propose, "今天聊得差不多了"), from: .claude, present: both, state: &state, entryID: UUID())
        XCTAssertEqual(state.phase, .closing)
        XCTAssertEqual(LoungeEngine.nextSpeaker(state, present: both), .codex)
        guard case .ended = LoungeEngine.apply(reply(.accept), from: .codex, present: both, state: &state, entryID: UUID()) else {
            return XCTFail("everyone accepted")
        }
    }

    func testRejectReopensTheChat() {
        var state = LoungeState(style: .chat)
        state.phase = .closing; state.proposalFrom = .claude; state.calls = 6
        XCTAssertEqual(LoungeEngine.apply(reply(.reject, "等等，還有一點"), from: .codex, present: both, state: &state, entryID: UUID()),
                       .show("等等，還有一點"))
        XCTAssertEqual(state.phase, .talking)
        XCTAssertNil(state.proposalFrom)
    }

    func testAskUserLeavesAPendingQuestionUntilAnswered() {
        var state = LoungeState(style: .chat)
        LoungeEngine.humanSpoke(&state, mentions: [], present: both, entryID: UUID())
        _ = LoungeEngine.apply(reply(.askUser, "你週末想去哪？"), from: .claude, present: both, state: &state, entryID: UUID())
        XCTAssertEqual(state.pendingQuestions.map(\.text), ["你週末想去哪？"])
        XCTAssertEqual(state.phase, .talking, "others keep chatting")
        let id = state.pendingQuestions[0].id
        LoungeEngine.humanSpoke(&state, mentions: [.claude], present: both, entryID: UUID(), answering: id)
        XCTAssertTrue(state.pendingQuestions.isEmpty)
    }

    func testMeetingGoesRoundTheTableThenHands() {
        var state = LoungeState(style: .meeting)
        let start = UUID()
        LoungeEngine.humanSpoke(&state, mentions: [], present: both, entryID: start)
        XCTAssertEqual(state.meetingStartEntryID, start)
        XCTAssertEqual(LoungeEngine.nextSpeaker(state, present: both), .claude)
        // A meeting reply can't be silent.
        XCTAssertEqual(LoungeEngine.apply(reply(.pass), from: .claude, present: both, state: &state, entryID: UUID()), .show("（沒有補充）"))
        XCTAssertEqual(LoungeEngine.nextSpeaker(state, present: both), .codex)
        _ = LoungeEngine.apply(reply(.speak, "同意"), from: .codex, present: both, state: &state, entryID: UUID())
        XCTAssertNil(LoungeEngine.nextSpeaker(state, present: both))
        let votes = ["Claude Code": HandVote(want: 1, why: "小補充"), "Codex": HandVote(want: 3, why: "有風險")]
        XCTAssertEqual(LoungeEngine.chooseHand(votes, state: state, present: both), .codex)
        state.supplemented = [.codex]
        XCTAssertEqual(LoungeEngine.chooseHand(votes, state: state, present: both), .claude)
    }

    func testMeetingMentionOnlyAsksThoseNamed() {
        var state = LoungeState(style: .meeting)
        LoungeEngine.humanSpoke(&state, mentions: [.codex], present: both, entryID: UUID())
        XCTAssertEqual(state.meetingPending, [.codex])
        XCTAssertTrue(state.mentionedOnly)
    }

    func testMentionedMemberIsToldToAnswerInWords() {
        var state = LoungeState(style: .chat)
        LoungeEngine.humanSpoke(&state, mentions: [.codex], present: both, entryID: UUID())
        let room = TeamRoom(entries: [RoomEntry(speaker: .user, displayName: "你", body: "@GPT娘 你還好嗎")])
        let asked = LoungeEngine.turnPrompt(room: room, member: cards[1], present: cards, state: state, ownerName: "使用者", language: .zhTW)
        let other = LoungeEngine.turnPrompt(room: room, member: cards[0], present: cards, state: state, ownerName: "使用者", language: .zhTW)
        XCTAssertTrue(asked.contains("你剛被點名"))
        XCTAssertFalse(other.contains("你剛被點名"))
    }

    func testParseReplyHandlesJSONFencesAndProse() {
        let json = LoungeEngine.parseReply(#"{"action":"speak","body":"哈哈","emoji":"😄","questions":[{"to":"user","text":"你呢？"}]}"#)
        XCTAssertEqual(json.action, .speak); XCTAssertEqual(json.emoji, "😄"); XCTAssertEqual(json.questions, ["你呢？"])
        let fenced = LoungeEngine.parseReply("```json\n{\"action\":\"pass\",\"body\":\"\"}\n```")
        XCTAssertEqual(fenced.action, .pass)
        let prose = LoungeEngine.parseReply("我覺得可以。")
        XCTAssertTrue(prose.unstructured); XCTAssertEqual(prose.body, "我覺得可以。")
        XCTAssertNil(LoungeEngine.parseReply(#"{"action":"react","body":"","emoji":"💣"}"#).emoji)
        XCTAssertEqual(LoungeEngine.parseReply(#"{"action":"speak","body":"  "}"#).action, .pass)
        XCTAssertEqual(LoungeEngine.parseHand(#"{"want":7,"why":"x"}"#)?.want, 3)
        XCTAssertNil(LoungeEngine.parseHand("我想說話"))
    }

    func testPromptsUseSummaryAndOnlyNewerMessages() {
        let old = RoomEntry(speaker: .user, displayName: "你", body: "很久以前的話")
        let new = RoomEntry(speaker: .user, displayName: "你", body: "最新的話")
        let room = TeamRoom(entries: [old, new], summary: "之前聊過旅行", summaryThroughEntryID: old.id)
        let (summary, transcript) = LoungeEngine.context(room: room, language: .zhTW)
        XCTAssertEqual(summary, "之前聊過旅行")
        XCTAssertFalse(transcript.contains("很久以前的話"))
        XCTAssertTrue(transcript.contains("最新的話"))
    }

    func testMarkdownExportAndLegacyRoomDecoding() throws {
        let room = TeamRoom(title: "週末", entries: [
            RoomEntry(speaker: .user, displayName: "你", body: "去哪玩？"),
            RoomEntry(speaker: .assistant, agent: .claude, displayName: "克勞蒂亞", body: "👍", isReaction: true),
            RoomEntry(speaker: .assistant, agent: .codex, displayName: "GPT娘", body: "結論：去海邊", isMinutes: true)])
        let markdown = LoungeEngine.markdown(room: room)
        XCTAssertTrue(markdown.hasPrefix("# 週末"))
        XCTAssertTrue(markdown.contains("克勞蒂亞 回應了 👍"))
        XCTAssertTrue(markdown.contains("GPT娘**（會議紀要）"))

        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(room)) as? [String: Any])
        for key in ["lounge", "summary", "summaryThroughEntryID", "carriedSummary"] { json.removeValue(forKey: key) }
        let legacy = try JSONDecoder().decode(TeamRoom.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertEqual(legacy.lounge.style, .chat)
        XCTAssertEqual(legacy.entries.count, 3)
    }
}
