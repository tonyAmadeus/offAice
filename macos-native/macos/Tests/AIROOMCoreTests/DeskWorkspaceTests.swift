import XCTest
@testable import AIROOMCore

final class DeskWorkspaceTests: XCTestCase {
    private var base: URL!
    private var desk: DeskWorkspace!
    private var original: URL!
    private let fm = FileManager.default

    override func setUpWithError() throws {
        base = fm.temporaryDirectory.appendingPathComponent("airoom-desk-\(UUID())")
        desk = try DeskWorkspace(root: base.appendingPathComponent("desk"))
        original = base.appendingPathComponent("project")
        try fm.createDirectory(at: original, withIntermediateDirectories: true)
        try write("v1", to: original.appendingPathComponent("a.txt"))
    }
    override func tearDownWithError() throws { try? fm.removeItem(at: base) }

    private func write(_ text: String, to url: URL) throws {
        try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: url)
    }
    private func read(_ url: URL) -> String? { (try? Data(contentsOf: url)).map { String(decoding: $0, as: UTF8.self) } }

    func testPersonalFolderRoundCanBeUndone() throws {
        let topic = UUID()
        let home = try desk.personalFolder(.claude)
        try write("keep", to: home.appendingPathComponent("notes.md"))
        try desk.beginRound(topic: topic, agent: .claude, original: "")
        try write("changed", to: home.appendingPathComponent("notes.md"))
        try write("new", to: home.appendingPathComponent("extra.md"))
        XCTAssertTrue(desk.canUndo(topic: topic))
        try desk.undoRound(topic: topic, agent: .claude, original: "")
        XCTAssertEqual(read(home.appendingPathComponent("notes.md")), "keep")
        XCTAssertFalse(fm.fileExists(atPath: home.appendingPathComponent("extra.md").path))
        XCTAssertFalse(desk.canUndo(topic: topic))
    }

    func testCopyEditsStayOffOriginalUntilApplied() throws {
        let topic = UUID()
        let work = try desk.workingFolder(topic: topic, agent: .codex, original: original.path)
        XCTAssertNotEqual(work.path, original.path)
        try desk.beginRound(topic: topic, agent: .codex, original: original.path)
        try write("v2", to: work.appendingPathComponent("a.txt"))
        XCTAssertEqual(read(original.appendingPathComponent("a.txt")), "v1")
        XCTAssertEqual(try desk.changes(topic: topic).map(\.path), ["a.txt"])
        XCTAssertEqual(try desk.apply(topic: topic, original: original.path).count, 1)
        XCTAssertEqual(read(original.appendingPathComponent("a.txt")), "v2")
        XCTAssertEqual(try desk.changes(topic: topic), [], "applied state becomes the new baseline")
    }

    func testUndoAfterApplyRestoresOriginalFilesToo() throws {
        let topic = UUID()
        let work = try desk.workingFolder(topic: topic, agent: .codex, original: original.path)
        try desk.beginRound(topic: topic, agent: .codex, original: original.path)
        try write("v2", to: work.appendingPathComponent("a.txt"))
        try write("added", to: work.appendingPathComponent("b.txt"))
        try desk.apply(topic: topic, original: original.path)
        try desk.undoRound(topic: topic, agent: .codex, original: original.path)
        XCTAssertEqual(read(original.appendingPathComponent("a.txt")), "v1")
        XCTAssertFalse(fm.fileExists(atPath: original.appendingPathComponent("b.txt").path))
        XCTAssertEqual(read(work.appendingPathComponent("a.txt")), "v1")
        XCTAssertEqual(try desk.changes(topic: topic), [])
    }

    func testUndoRefusesWhenOriginalChangedAfterApply() throws {
        let topic = UUID()
        let work = try desk.workingFolder(topic: topic, agent: .codex, original: original.path)
        try desk.beginRound(topic: topic, agent: .codex, original: original.path)
        try write("v2", to: work.appendingPathComponent("a.txt"))
        try desk.apply(topic: topic, original: original.path)
        try write("edited by hand", to: original.appendingPathComponent("a.txt"))
        XCTAssertThrowsError(try desk.undoRound(topic: topic, agent: .codex, original: original.path))
        XCTAssertEqual(read(original.appendingPathComponent("a.txt")), "edited by hand")
    }

    func testDiscardDropsCopyAndLeavesOriginal() throws {
        let topic = UUID()
        let work = try desk.workingFolder(topic: topic, agent: .codex, original: original.path)
        try write("v2", to: work.appendingPathComponent("a.txt"))
        try desk.discard(topic: topic)
        XCTAssertFalse(desk.hasCopy(topic: topic))
        XCTAssertEqual(read(original.appendingPathComponent("a.txt")), "v1")
    }

    func testWritingRoundsGetFileToolsOnly() {
        let args = CommandPlan.arguments(for: .claude, access: .stagedWrite)
        XCTAssertTrue(args.contains("Read,Edit,Write,Glob,Grep"))
        XCTAssertTrue(args.contains("acceptEdits"))
        XCTAssertFalse(args.joined(separator: " ").contains("Bash"))
        XCTAssertFalse(args.contains("bypassPermissions"))
        let readOnly = CommandPlan.arguments(for: .claude)
        XCTAssertEqual(readOnly[readOnly.firstIndex(of: "--tools")! + 1], "")
    }
}
