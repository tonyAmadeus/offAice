import XCTest
@testable import AIROOMCore

private struct ReversingProtector: StateProtector {
    func seal(_ plaintext: Data) throws -> Data { Data([0x5A]) + Data(plaintext.reversed()) }
    func open(_ ciphertext: Data) throws -> Data {
        guard ciphertext.first == 0x5A else { throw StateProtectionError.invalidCiphertext }
        return Data(ciphertext.dropFirst().reversed())
    }
}

final class MemberDeskTests: XCTestCase {
    func testTopicTitleSkipsMentionsAndUsesFirstTwentyCharacters() {
        XCTAssertEqual(TopicNaming.title(from: "@Claude @Codex 幫我看看這段程式碼為什麼會一直當掉呢謝謝你"),
                       "幫我看看這段程式碼為什麼會一直當掉呢謝謝")
        XCTAssertEqual(TopicNaming.title(from: "  @Claude  "), TopicNaming.defaultTitle)
        XCTAssertEqual(TopicNaming.title(from: "第一行\n第二行"), "第一行")
    }

    func testAttachmentClassification() throws {
        XCTAssertEqual(try AttachmentPolicy.classify(fileName: "a.PNG", data: Data([1, 2])).kind, .image)
        XCTAssertEqual(try AttachmentPolicy.classify(fileName: "doc", data: Data("%PDF-1.7".utf8)).kind, .pdf)
        XCTAssertEqual(try AttachmentPolicy.classify(fileName: "notes.md", data: Data("# hi".utf8)).kind, .text)
        XCTAssertThrowsError(try AttachmentPolicy.classify(fileName: "app.bin", data: Data([0, 1, 2])))
        let huge = Data(count: AttachmentPolicy.maxImageBytes + 1)
        XCTAssertEqual(try? AttachmentPolicy.classify(fileName: "big.jpg", data: huge), nil)
    }

    func testInlinedTextIsDelimitedAndBudgeted() {
        let item = ChatAttachment(fileName: "log.txt", kind: .text, mediaType: "text/plain", byteCount: 5000)
        let text = AttachmentPolicy.inline([(item, Data(String(repeating: "x", count: 5000).utf8))], budget: 1000)
        XCTAssertTrue(text.contains("附件：log.txt"))
        XCTAssertTrue(text.contains("已截斷 4000 字"))
    }

    func testLegacyConversationDecodesWithDefaults() throws {
        let legacy = #"{"id":"6F9619FF-8B86-D011-B42D-00C04FC964FF","agent":"Codex","title":"舊","updatedAt":0,"messages":[{"id":"7F9619FF-8B86-D011-B42D-00C04FC964FF","role":"user","body":"hi","createdAt":0}]}"#
        let topic = try JSONDecoder().decode(Conversation.self, from: Data(legacy.utf8))
        XCTAssertFalse(topic.archived)
        XCTAssertEqual(topic.model, "")
        XCTAssertEqual(topic.messages.first?.attachments, [])
        XCTAssertNil(topic.messages.first?.modelUsed)
    }

    func testClaudeArgumentsCarryModelEffortAndStreamInput() {
        let file = URL(fileURLWithPath: "/tmp/x.png")
        let image = PreparedAttachment(attachment: ChatAttachment(fileName: "x.png", kind: .image, mediaType: "image/png", byteCount: 1), file: file)
        let args = CommandPlan.arguments(for: .claude, options: CLIRunOptions(model: "opus", effort: "max", attachments: [image]))
        XCTAssertEqual(args.suffix(6), ["--model", "opus", "--effort", "max", "--input-format", "stream-json"])
        XCTAssertFalse(CommandPlan.arguments(for: .claude).contains("--model"))
    }

    func testModelStringsAreSanitised() {
        XCTAssertEqual(CLIRunOptions(model: "opus; rm -rf /").model, "")
        XCTAssertEqual(CLIRunOptions(model: "gpt-6.1-sol").model, "gpt-6.1-sol")
        XCTAssertEqual(CLIRunOptions(effort: "--dangerously-skip-permissions").effort, "")
    }

    func testClaudeStreamMessageCarriesImageBlock() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID()).png")
        try Data([0x89, 0x50]).write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        let item = PreparedAttachment(attachment: ChatAttachment(fileName: "a.png", kind: .image, mediaType: "image/png", byteCount: 2), file: file)
        let line = try ClaudeStreamInput.userMessage(prompt: "看圖", attachments: [item])
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: line.dropLast()) as? [String: Any])
        let content = try XCTUnwrap((json["message"] as? [String: Any])?["content"] as? [[String: Any]])
        XCTAssertEqual(content.map { $0["type"] as? String }, ["image", "text"])
        XCTAssertEqual((content[0]["source"] as? [String: Any])?["data"] as? String, Data([0x89, 0x50]).base64EncodedString())
    }

    func testClaudeInitEventReportsModel() {
        var parser = CLIEventAccumulator(agent: .claude)
        parser.consume(line: #"{"type":"system","subtype":"init","model":"claude-opus-5-5"}"#)
        XCTAssertEqual(parser.model, "claude-opus-5-5")
    }

    func testCodexThreadStartReportsModel() {
        var wire = CodexServerWire()
        wire.receive(#"{"id":1,"result":{}}"#)
        wire.receive(#"{"id":2,"result":{"model":"gpt-6.1-sol","thread":{"id":"t1"}}}"#)
        XCTAssertEqual(wire.model, "gpt-6.1-sol")
        XCTAssertEqual(wire.threadID, "t1")
    }

    func testAttachmentsAreSealedAtRest() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("airoom-attach-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try LocalStateStore(root: root, protector: ReversingProtector())
        let id = UUID()
        try store.storeAttachment(Data("秘密圖片".utf8), id: id)
        let raw = try Data(contentsOf: root.appendingPathComponent("attachments/\(id.uuidString).aesgcm"))
        XCTAssertNil(raw.range(of: Data("秘密圖片".utf8)))
        XCTAssertEqual(try store.loadAttachment(id: id), Data("秘密圖片".utf8))
    }
}

final class ModelCatalogTests: XCTestCase {
    func testClaudeCatalogFoldsDefaultAndKeepsVersions() {
        let models: [[String: Any]] = [
            ["value": "default", "displayName": "Default (recommended)", "resolvedModel": "claude-opus-5-5",
             "supportsEffort": true, "supportedEffortLevels": ["low", "max"]],
            ["value": "opus", "displayName": "Opus 5.5", "resolvedModel": "claude-opus-5-5",
             "supportsEffort": true, "supportedEffortLevels": ["low", "max"]],
            ["value": "claude-opus-5", "displayName": "Opus 5", "resolvedModel": "claude-opus-5-5x"],
            ["value": "claude-haiku-4-5-20251001", "displayName": "Haiku 4.5"],
            ["value": "--evil", "displayName": "bad"]
        ]
        let choices = ModelCatalog.claudeModels(from: models)
        XCTAssertEqual(choices.map(\.id), ["opus", "claude-opus-5", "claude-haiku-4-5-20251001"])
        XCTAssertEqual(choices.map(\.title), ["Opus 5.5", "Opus 5", "Haiku 4.5"])
        XCTAssertEqual(choices.filter(\.isDefault).map(\.id), ["opus"])
        XCTAssertEqual(choices[2].efforts, [])
    }
}

final class ClaudeErrorResultTests: XCTestCase {
    func testErrorResultIsAFailureNotAnAnswer() {
        var parser = CLIEventAccumulator(agent: .claude)
        parser.consume(line: #"{"type":"result","subtype":"success","is_error":true,"result":"Claude AI usage limit reached|1793620000"}"#)
        XCTAssertEqual(parser.text, "")
        XCTAssertEqual(parser.failure, "Claude AI usage limit reached|1793620000")
        var ok = CLIEventAccumulator(agent: .claude)
        ok.consume(line: #"{"type":"result","subtype":"success","is_error":false,"result":"OK"}"#)
        XCTAssertEqual(ok.text, "OK"); XCTAssertNil(ok.failure)
        var bare = CLIEventAccumulator(agent: .claude)
        bare.consume(line: #"{"type":"result","subtype":"error_during_execution","is_error":true}"#)
        XCTAssertEqual(bare.failure, "Claude 執行失敗：error_during_execution")
    }
}
