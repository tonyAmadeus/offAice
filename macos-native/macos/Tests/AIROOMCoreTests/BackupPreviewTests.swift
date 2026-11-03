import XCTest
@testable import AIROOMCore

/// Stands in for the Keychain key; another instance with a different byte can't open its files.
private struct XORProtector: StateProtector {
    var key: UInt8 = 0x5A
    func seal(_ plaintext: Data) throws -> Data { Data([key]) + Data(plaintext.map { $0 ^ key }) }
    func open(_ ciphertext: Data) throws -> Data {
        guard ciphertext.first == key else { throw StateProtectionError.invalidCiphertext }
        return Data(ciphertext.dropFirst().map { $0 ^ key })
    }
}

final class BackupPreviewTests: XCTestCase {
    private func store(_ protector: XORProtector = XORProtector()) throws -> (LocalStateStore, URL) {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("airoom-backup-\(UUID())")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        return (try LocalStateStore(root: dir, protector: protector), dir)
    }

    private func sample() -> SavedState {
        var state = SavedState()
        state.settings.userName = "小明"
        state.members[0].name = "克勞迪婭"
        state.members[0].memories = [MemoryEntry(text: "喜歡烏龍茶", source: .manual)]
        state.conversations = [Conversation(agent: .claude, title: "t", messages: [ChatMessage(role: .user, body: "hi"), ChatMessage(role: .assistant, body: "yo")])]
        state.rooms[0].entries = [RoomEntry(speaker: .user, displayName: "你", body: "大家好")]
        return state
    }

    func testPreviewSummarizesWithoutChangingAnything() throws {
        let (store, _) = try store()
        try store.save(sample())
        let file = try store.backup()
        var changed = sample(); changed.conversations = []
        try store.save(changed)

        let summary = try store.preview(file)
        XCTAssertEqual(summary.deskTopics, 1)
        XCTAssertEqual(summary.deskMessages, 2)
        XCTAssertEqual(summary.loungeMessages, 1)
        XCTAssertTrue(summary.memberNames.contains("克勞迪婭"))
        XCTAssertEqual(summary.memories, 1)
        XCTAssertEqual(summary.ownerName, "小明")
        XCTAssertEqual(try store.load().conversations.count, 0, "previewing restores nothing")
    }

    func testListMarksBackupsMadeBeforeARestore() throws {
        let (store, _) = try store()
        try store.save(sample())
        let manual = try store.backup()
        _ = try store.restore(from: manual)
        let files = store.backups()
        XCTAssertEqual(files.count, 2)
        XCTAssertEqual(files.filter(\.beforeRestore).count, 1, "a restore backs up the current data first")
        XCTAssertTrue(files.allSatisfy { $0.bytes > 0 })
    }

    func testDamagedOrForeignBackupsFailThePreview() throws {
        let (store, _) = try store()
        try store.save(sample())
        let file = try store.backup()
        let (other, _) = try self.store(XORProtector(key: 0x33))
        XCTAssertThrowsError(try other.preview(file), "sealed with another key")
        try Data("garbage".utf8).write(to: file)
        XCTAssertThrowsError(try store.preview(file))
        XCTAssertThrowsError(try store.restore(from: file))
    }

    func testOnlyFilesInTheBackupFolderCanBeDeleted() throws {
        let (store, dir) = try store()
        try store.save(sample())
        let file = try store.backup()
        let outside = dir.appendingPathComponent("AIROOM-backup-x.airoombackup")
        try Data("x".utf8).write(to: outside)
        XCTAssertThrowsError(try store.deleteBackup(outside))
        let link = store.backupDirectory.appendingPathComponent("AIROOM-backup-link.airoombackup")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: outside)
        XCTAssertThrowsError(try store.deleteBackup(link))
        XCTAssertTrue(FileManager.default.fileExists(atPath: outside.path))
        try store.deleteBackup(file)
        XCTAssertEqual(store.backups().count, 0)
    }
}
