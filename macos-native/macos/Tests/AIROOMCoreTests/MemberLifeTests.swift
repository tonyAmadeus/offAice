import XCTest
@testable import AIROOMCore

final class MemberLifeTests: XCTestCase {
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Taipei")!
        return calendar
    }
    private func date(_ day: Int, _ hour: Int, _ minute: Int = 0) -> Date {
        calendar.date(from: DateComponents(year: 2026, month: 11, day: day, hour: hour, minute: minute))!
    }

    func testRoutinePeriodsCoverTheDayAndWrapAtNight() {
        XCTAssertEqual(RoutinePeriod.at(hour: 6), .morning)
        XCTAssertEqual(RoutinePeriod.at(hour: 10), .morning)
        XCTAssertEqual(RoutinePeriod.at(hour: 11), .day)
        XCTAssertEqual(RoutinePeriod.at(hour: 17), .evening)
        XCTAssertEqual(RoutinePeriod.at(hour: 22), .night)
        XCTAssertEqual(RoutinePeriod.at(hour: 0), .night)
        XCTAssertEqual(RoutinePeriod.at(hour: 5), .night)
    }

    func testLimitsAreRefusedNotCut() throws {
        XCTAssertThrowsError(try MemberLife.validate([MemoryEntry(text: String(repeating: "a", count: 2_001))])) {
            XCTAssertEqual($0 as? MemoryLimitError, .entryTooLong)
        }
        let big = (0..<5).map { _ in MemoryEntry(text: String(repeating: "b", count: 1_800)) }
        XCTAssertThrowsError(try MemberLife.validate(big)) { XCTAssertEqual($0 as? MemoryLimitError, .activeTooLong) }
        var off = big
        off[4].off = true
        XCTAssertNoThrow(try MemberLife.validate(off), "entries that are off don't count")
        XCTAssertThrowsError(try MemberLife.validate((0...200).map { MemoryEntry(text: "\($0)") })) {
            XCTAssertEqual($0 as? MemoryLimitError, .tooMany)
        }
    }

    func testImportPastTheActiveLimitIsKeptSwitchedOff() throws {
        var entries = (0..<4).map { MemoryEntry(text: String(repeating: "\($0)", count: 1_749)) }
        let off = try MemberLife.add([MemoryCandidate(text: "short", origin: "a"),
                                      MemoryCandidate(text: String(repeating: "y", count: 1_500), origin: "b"),
                                      MemoryCandidate(text: "short", origin: "dup")], source: .imported, to: &entries)
        XCTAssertEqual(off, 1)
        XCTAssertEqual(entries.count, 6, "duplicates are skipped")
        XCTAssertFalse(entries[4].off)
        XCTAssertTrue(entries[5].off)
        XCTAssertEqual(entries[5].source, .imported)
        XCTAssertNoThrow(try MemberLife.validate(entries))
    }

    func testProfileCarriesActiveMemoryAndMarksLifeAsSettings() {
        var claude = MemberCard(agent: .claude, name: "小克")
        let codex = MemberCard(agent: .codex, name: "GPT娘")
        claude.memories = [MemoryEntry(text: "喜歡先看結論"), MemoryEntry(text: "舊的偏好", off: true)]
        claude.routine = [RoutinePeriod.morning.rawValue: "  泡茶   看新聞 "]
        claude.quirks = ["轉筆"]
        claude.relations = [MemberRelation(agent: .codex, text: "老搭檔"), MemberRelation(agent: .claude, text: "自己")]
        let text = claude.profile(team: [claude, codex], ownerName: "小明")
        XCTAssertTrue(text.contains("- 喜歡先看結論"))
        XCTAssertFalse(text.contains("舊的偏好"))
        XCTAssertTrue(text.contains("早上：泡茶 看新聞"))
        XCTAssertTrue(text.contains("小習慣：轉筆"))
        XCTAssertTrue(text.contains("- GPT娘：老搭檔"))
        XCTAssertFalse(text.contains("自己"))
        XCTAssertTrue(text.contains("不是真實發生的事"))
        XCTAssertEqual(MemberCard(agent: .codex).profile(team: [], ownerName: "x"), "")
    }

    func testProfileReachesLoungeDeskRoundtableAndProjectPrompts() {
        var member = MemberCard(agent: .claude, name: "小克", persona: "冷靜")
        member.memories = [MemoryEntry(text: "MEMO-42")]
        let room = TeamRoom()
        XCTAssertTrue(LoungeEngine.turnPrompt(room: room, member: member, present: [member], state: LoungeState(),
                                              ownerName: "小明", language: .zhTW).contains("MEMO-42"))
        let desk = PromptBuilder.build(history: [], newQuestion: "hi", persona: member.persona,
                                       profile: member.profile(team: [member], ownerName: "小明"))
        XCTAssertTrue(desk.contains("冷靜") && desk.contains("MEMO-42"))
        let topic = RoundtableTopic(title: "t", kind: .review, material: "m", members: [.claude], lead: .claude)
        XCTAssertTrue(RoundtableFlow.preparePrompt(topic, member: member, ownerName: "小明", team: [member]).contains("MEMO-42"))
    }

    func testStatusPrefersRoutineThenAStableQuirk() {
        var member = MemberCard(agent: .codex)
        XCTAssertNil(MemberLife.status(member, at: date(2, 9), calendar: calendar))
        member.quirks = ["轉筆", "哼歌"]
        let quirk = MemberLife.status(member, at: date(2, 9, 5), calendar: calendar)
        XCTAssertNotNil(quirk)
        XCTAssertEqual(MemberLife.status(member, at: date(2, 9, 6), calendar: calendar), quirk, "stable within the hour")
        member.routine = [RoutinePeriod.morning.rawValue: "看新聞"]
        XCTAssertEqual(MemberLife.status(member, at: date(2, 9), calendar: calendar), "看新聞")
    }

    func testOldCardsDecodeWithoutLifeFields() throws {
        let json = #"{"id":"\#(UUID().uuidString)","agent":"\#(AgentKind.claude.rawValue)","name":"C","persona":"p","enabled":true}"#
        let card = try JSONDecoder().decode(MemberCard.self, from: Data(json.utf8))
        XCTAssertTrue(card.memories.isEmpty && card.quirks.isEmpty && card.routine.isEmpty)
        XCTAssertEqual(card.talkativeness, .normal)
        var full = card
        full.memories = [MemoryEntry(text: "m", source: .proposed, origin: "o", off: true)]
        full.talkativeness = .chatty
        full.relations = [MemberRelation(agent: .codex, text: "r")]
        let round = try JSONDecoder().decode(MemberCard.self, from: JSONEncoder().encode(full))
        XCTAssertEqual(round, full)
    }

    func testProposalsAreParsedBoundedAndScreenedForSecrets() {
        let text = #"好的 {"memories":["喜歡深色主題","喜歡深色主題","api key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","","a","b","c","d","e"]}"#
        let items = MemberLife.parseProposals(text)
        XCTAssertEqual(items.first, "喜歡深色主題")
        XCTAssertEqual(items.count, 5)
        XCTAssertFalse(items.contains { $0.contains("sk-ant") })
        XCTAssertEqual(MemberLife.parseProposals("沒有 JSON"), [])
    }

    func testTalkativenessShiftsTheChatDraw() {
        var state = LoungeState(style: .chat)
        state.phase = .talking
        // With equal waiting, a draw of 0.55 lands on the second member unless the first is chatty.
        let plain = LoungeEngine.nextSpeaker(state, present: [.claude, .codex], random: { 0.55 })
        let chatty = LoungeEngine.nextSpeaker(state, present: [.claude, .codex],
                                              talkativeness: [.claude: .chatty, .codex: .quiet], random: { 0.55 })
        XCTAssertEqual(plain, .codex)
        XCTAssertEqual(chatty, .claude)
    }

    func testDailyOpeningOncePerDayAndNeverReplayedByEnabling() {
        var settings = DailyOpeningSettings(enabled: false)
        XCTAssertFalse(settings.opened(now: date(2, 9), calendar: calendar))
        settings.enabled = true
        XCTAssertFalse(settings.opened(now: date(2, 15), calendar: calendar), "switching on today waits for tomorrow")
        XCTAssertTrue(settings.opened(now: date(3, 8), calendar: calendar))
        XCTAssertFalse(settings.opened(now: date(3, 20), calendar: calendar))
        XCTAssertFalse(settings.opened(now: date(2, 20), calendar: calendar), "a clock rollback doesn't replay")
        XCTAssertEqual(MemberLife.nextGreeter([.claude, .codex], last: .claude), .codex)
        XCTAssertEqual(MemberLife.nextGreeter([.claude, .codex], last: .codex), .claude)
        XCTAssertEqual(MemberLife.nextGreeter([.claude, .codex], last: nil), .claude)
    }

    func testOpeningUsesOnlyYesterdaysFinishedLines() {
        var room = TeamRoom()
        room.entries = [
            RoomEntry(speaker: .user, displayName: "你", body: "前天的事", createdAt: date(1, 12)),
            RoomEntry(speaker: .user, displayName: "你", body: "昨天想做直播", createdAt: date(2, 12)),
            RoomEntry(speaker: .assistant, agent: .codex, displayName: "GPT娘", body: "失敗", createdAt: date(2, 13), delivery: .failed),
            RoomEntry(speaker: .system, displayName: "AIROOM", body: "系統", createdAt: date(2, 14)),
        ]
        let facts = MemberLife.yesterdayFacts(room, now: date(3, 9), calendar: calendar)
        XCTAssertEqual(facts.map(\.text), ["昨天想做直播"])
        let member = MemberCard(agent: .claude, name: "小克")
        XCTAssertTrue(MemberLife.openingPrompt(member: member, team: [member], room: room, ownerName: "小明",
                                               now: date(3, 9), calendar: calendar).contains("昨天想做直播"))
        XCTAssertTrue(MemberLife.openingPrompt(member: member, team: [member], room: TeamRoom(), ownerName: "小明",
                                               now: date(3, 9), calendar: calendar).contains("不要編造"))
    }

    func testChatPromptUsesRoutinesAndMarksThemAsSettings() {
        var a = MemberCard(agent: .claude, name: "小克")
        let b = MemberCard(agent: .codex, name: "GPT娘")
        a.routine = [RoutinePeriod.evening.rawValue: "整理筆記"]
        a.relations = [MemberRelation(agent: .codex, text: "老搭檔")]
        let opener = MemberLife.chatPrompt(member: a, other: b, team: [a, b], ownerName: "小明", now: date(2, 19), calendar: calendar)
        XCTAssertTrue(opener.contains("整理筆記") && opener.contains("老搭檔") && opener.contains("不是真實發生的事"))
        XCTAssertTrue(opener.contains("你先開口"))
        let reply = MemberLife.chatPrompt(member: b, other: a, team: [a, b], ownerName: "小明", reply: "今天好累", now: date(2, 19), calendar: calendar)
        XCTAssertTrue(reply.contains("今天好累") && reply.contains("自然收尾"))
    }

    func testContinuedConversationsGetPersonaAndMemoryEdits() {
        let seen = MemberLife.fingerprint(persona: "冷靜", profile: "【長期記憶】- A")
        XCTAssertFalse(MemberLife.needsRefresh(seen: seen, persona: "冷靜", profile: "【長期記憶】- A"))
        XCTAssertTrue(MemberLife.needsRefresh(seen: seen, persona: "冷靜", profile: "【長期記憶】- B"))
        XCTAssertTrue(MemberLife.needsRefresh(seen: seen, persona: "熱情", profile: "【長期記憶】- A"))
        XCTAssertTrue(MemberLife.needsRefresh(seen: nil, persona: "", profile: "【長期記憶】- A"), "older sessions never had it")
        XCTAssertFalse(MemberLife.needsRefresh(seen: nil, persona: " ", profile: ""))
        let note = MemberLife.refreshNote(persona: "", profile: "", ownerName: "小明")
        XCTAssertTrue(note.contains("取代") && note.contains("（沒有）"))
        let decoded = try? JSONDecoder().decode(RoomSession.self, from: Data(#"{"id":"s","through":"\#(UUID().uuidString)"}"#.utf8))
        XCTAssertNil(decoded?.profile)
        XCTAssertEqual(decoded?.id, "s")
    }

    // MARK: Import

    private func fakeHome() throws -> URL {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("airoom-memory-\(UUID())")
        try FileManager.default.createDirectory(at: home.appendingPathComponent(".codex/memories"), withIntermediateDirectories: true)
        try """
        # Memory summary
        ## User Profile
        - Prefers Traditional Chinese
        - Builds a macOS app
        ## Project notes
        - secret project detail
        ## 偏好
        喜歡簡短回覆，
        先給結論。

        不喜歡反覆重啟。
        """.write(to: home.appendingPathComponent(".codex/memories/memory_summary.md"), atomically: true, encoding: .utf8)
        let memory = home.appendingPathComponent(".claude/projects/-Users-me-app/memory")
        try FileManager.default.createDirectory(at: memory, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: home.appendingPathComponent(".claude/projects/-Users-me-empty/memory"),
                                                withIntermediateDirectories: true)
        try "- [x](x.md) index".write(to: memory.appendingPathComponent("MEMORY.md"), atomically: true, encoding: .utf8)
        try """
        ---
        name: install-routine
        description: d
        ---

        Only one copy in /Applications; see [[other-note]].
        """.write(to: memory.appendingPathComponent("install.md"), atomically: true, encoding: .utf8)
        return home
    }

    func testImportReadsOnlyUserSectionsAndMemoryFiles() throws {
        let home = try fakeHome()
        defer { try? FileManager.default.removeItem(at: home) }
        XCTAssertEqual(MemoryImport.sources(for: .codex, home: home).map(\.id), ["codex-summary"])
        let codex = try MemoryImport.candidates(for: .codex, source: "codex-summary", home: home)
        XCTAssertEqual(codex.map(\.text), ["Prefers Traditional Chinese", "Builds a macOS app", "喜歡簡短回覆， 先給結論。", "不喜歡反覆重啟。"])
        XCTAssertEqual(codex.first?.origin, "Codex 記憶 · User Profile")

        let sources = MemoryImport.sources(for: .claude, home: home)
        XCTAssertEqual(sources.map(\.id), ["claude:-Users-me-app"], "empty memory folders and MEMORY.md are skipped")
        XCTAssertEqual(sources.first?.label, "Claude 專案記憶：/Users/me/app")
        let claude = try MemoryImport.candidates(for: .claude, source: "claude:-Users-me-app", home: home)
        XCTAssertEqual(claude, [MemoryCandidate(text: "Only one copy in /Applications; see other-note.", origin: "Claude 記憶 · install-routine")])
        XCTAssertThrowsError(try MemoryImport.candidates(for: .claude, source: "claude:..", home: home))
        XCTAssertThrowsError(try MemoryImport.candidates(for: .claude, source: "claude:../../etc", home: home))
        XCTAssertThrowsError(try MemoryImport.candidates(for: .codex, source: "claude:-Users-me-app", home: home))
    }
}
