import XCTest
@testable import AIROOMCore

final class MemberCardDetailsTests: XCTestCase {
    func testOldCardsDecodeWithEmptyDetails() throws {
        let old = #"{"id":"\#(UUID().uuidString)","agent":"Codex","name":"GPT娘","persona":"溫柔","enabled":true}"#
        let card = try JSONDecoder().decode(MemberCard.self, from: Data(old.utf8))
        XCTAssertEqual(card.userTitle, "")
        XCTAssertEqual(card.defaultModel, "")
        XCTAssertNil(card.portrait)
        XCTAssertFalse(card.cardHidden)
        var edited = card
        edited.userTitle = "老大"; edited.color = "#3c66d9"; edited.portraitOffset = PortraitOffset(x: 0.1, y: -0.2)
        XCTAssertEqual(try JSONDecoder().decode(MemberCard.self, from: JSONEncoder().encode(edited)), edited)
    }

    func testNormalizedKeepsDetailsInBounds() {
        var card = MemberCard(agent: .claude)
        card.userTitle = "老\n大" + String(repeating: "x", count: 60)
        card.motto = String(repeating: "句", count: 100)
        card.color = "red"
        card.defaultModel = "--dangerous"
        card.defaultEffort = "high"
        card.portraitScale = 5
        card.portraitOffset = PortraitOffset(x: 3, y: -.infinity)
        let fixed = card.normalized()
        XCTAssertEqual(fixed.userTitle.count, MemberCard.userTitleLimit)
        XCTAssertFalse(fixed.userTitle.contains("\n"))
        XCTAssertEqual(fixed.motto.count, MemberCard.mottoLimit)
        XCTAssertEqual(fixed.color, "", "an invalid color falls back to the built-in one")
        XCTAssertEqual(fixed.defaultModel, "", "a flag-like model name never reaches the CLI")
        XCTAssertEqual(fixed.defaultEffort, "high")
        XCTAssertEqual(fixed.portraitScale, MemberCard.portraitScaleRange.upperBound)
        XCTAssertEqual(fixed.portraitOffset, PortraitOffset(x: 1, y: 0))
        card.color = "#A35BDB"
        XCTAssertEqual(card.normalized().color, "#A35BDB")
    }

    func testAddressReachesThePersonaOnlyWhenSet() {
        var card = MemberCard(agent: .codex, name: "GPT娘")
        XCTAssertEqual(card.address(ownerName: "小明"), "小明")
        XCTAssertFalse(card.profile(team: [card], ownerName: "小明").contains("【稱呼】"))
        card.userTitle = " 老大 "
        XCTAssertEqual(card.address(ownerName: "小明"), "老大")
        XCTAssertTrue(card.profile(team: [card], ownerName: "小明").contains("【稱呼】稱呼小明為「老大」。"))
    }

    func testRunsInheritTheMemberDefaults() {
        let open = CLIRunOptions().inheriting(model: "opus", effort: "high")
        XCTAssertEqual([open.model, open.effort], ["opus", "high"])
        let picked = CLIRunOptions(model: "sonnet").inheriting(model: "opus", effort: "max")
        XCTAssertEqual([picked.model, picked.effort], ["sonnet", ""], "the member's effort may not exist on the topic's model")
        let effortOnly = CLIRunOptions(effort: "low").inheriting(model: "opus", effort: "max")
        XCTAssertEqual([effortOnly.model, effortOnly.effort], ["opus", "low"])
        let image = CLIRunOptions(imageGeneration: true).inheriting(model: "gpt-x", effort: "high")
        XCTAssertEqual([image.model, image.effort], ["", ""], "image requests keep the CLI's defaults")
        XCTAssertEqual(CLIRunOptions().inheriting(model: "-x", effort: "").model, "")
    }

    func testPersonaFileIsReadOnlyFromTheCLIsOwnPlace() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("persona-\(UUID())")
        defer { try? FileManager.default.removeItem(at: home) }
        XCTAssertNil(PersonaFile.read(for: .claude, home: home))
        try FileManager.default.createDirectory(at: home.appendingPathComponent(".claude"), withIntermediateDirectories: true)
        try "  你是沉穩的審稿人。\n".write(to: home.appendingPathComponent(".claude/CLAUDE.md"), atomically: true, encoding: .utf8)
        let file = try XCTUnwrap(PersonaFile.read(for: .claude, home: home))
        XCTAssertEqual(file.text, "你是沉穩的審稿人。")
        XCTAssertFalse(file.truncated)
        XCTAssertTrue(file.path.hasSuffix(".claude/CLAUDE.md"))
        XCTAssertEqual(PersonaFile.location(for: .codex, home: home).path, home.appendingPathComponent(".codex/AGENTS.md").path)

        try FileManager.default.createDirectory(at: home.appendingPathComponent(".codex"), withIntermediateDirectories: true)
        try String(repeating: "長", count: MemberCard.personaLimit + 5).write(to: home.appendingPathComponent(".codex/AGENTS.md"), atomically: true, encoding: .utf8)
        let long = try XCTUnwrap(PersonaFile.read(for: .codex, home: home))
        XCTAssertTrue(long.truncated)
        XCTAssertEqual(long.text.count, MemberCard.personaLimit)
    }
}
