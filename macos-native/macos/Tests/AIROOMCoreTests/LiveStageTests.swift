import XCTest
@testable import AIROOMCore

final class LiveCueParserTests: XCTestCase {
    func testSplitsSegmentsByWhitelistedCue() {
        let parsed = LiveCueParser.parse("[happy] 歡迎大家！ [thinking] 今天想聊什麼呢？")
        XCTAssertEqual(parsed.segments.map(\.emotion), [.happy, .thinking])
        XCTAssertEqual(parsed.segments.map(\.text), ["歡迎大家！", "今天想聊什麼呢？"])
        XCTAssertEqual(parsed.cleanText, "歡迎大家！ 今天想聊什麼呢？")
    }

    func testChineseAliasesAndDefaultNeutral() {
        let parsed = LiveCueParser.parse("大家好。【驚訝】真的嗎？")
        XCTAssertEqual(parsed.segments.map(\.emotion), [.neutral, .surprised])
        XCTAssertEqual(parsed.cleanText, "大家好。真的嗎？")
    }

    func testInventedTagsAreDroppedButOrdinaryBracketsKept() {
        let parsed = LiveCueParser.parse("[runShell] 你好 [1] 第一點 【注意】小心")
        XCTAssertEqual(parsed.segments.count, 1)
        XCTAssertEqual(parsed.segments[0].emotion, .neutral)
        XCTAssertFalse(parsed.cleanText.contains("runShell"))
        XCTAssertTrue(parsed.cleanText.contains("[1]"))
        XCTAssertTrue(parsed.cleanText.contains("【注意】"))
    }

    func testSegmentCountIsBounded() {
        let reply = (0..<20).map { "[happy] 第\($0)句" }.joined(separator: " ")
        let parsed = LiveCueParser.parse(reply)
        XCTAssertEqual(parsed.segments.count, LiveCueParser.maxSegments)
        XCTAssertTrue(parsed.segments.last!.text.contains("第19句"))
    }

    func testEventsAreOrderedAndAttributed() {
        let turn = UUID()
        let events = LiveCueParser.events(from: LiveCueParser.parse("[sad] 好可惜 [happy] 不過沒關係"),
                                          speaker: .claude, turnID: turn)
        XCTAssertEqual(events.map(\.sequence), [0, 1])
        XCTAssertTrue(events.allSatisfy { $0.turnID == turn && $0.speaker == .claude })
    }

    func testSpeakableTextRemovesMarkdownAndLinks() {
        let spoken = LiveSpeechText.speakable("**重點** 請看 https://example.com/x 和 `rm -rf` 👋")
        XCTAssertEqual(spoken, "重點 請看 和")
    }

    func testMouthCurveIsNormalisedAndGated() {
        let curve = LipSync.mouthCurve(rms: [0, 0.01, 0.5, 1.0])
        XCTAssertEqual(curve[0], 0); XCTAssertEqual(curve[1], 0)
        XCTAssertEqual(curve[3], 1, accuracy: 0.0001)
        XCTAssertGreaterThan(curve[2], 0.5)
    }
}

final class LiveStageSettingsTests: XCTestCase {
    func testLegacyStateGainsStageDefaults() throws {
        let legacy = try JSONEncoder().encode(SavedState())
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: legacy) as? [String: Any])
        object.removeValue(forKey: "liveStage")
        let restored = try JSONDecoder().decode(SavedState.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertFalse(restored.liveStage.performs)
        XCTAssertEqual(restored.liveStage.character(.codex).vtsPort, 8001)
        XCTAssertEqual(restored.liveStage.character(.claude).vtsPort, 8002)
        XCTAssertEqual(Set(restored.liveStage.characters.map(\.agent)), Set(AgentKind.allCases))
    }

    func testCharacterValuesAreClampedAndSanitised() {
        var stage = LiveStageSettings()
        stage.updateCharacter(.codex) {
            $0.speechRate = 9; $0.vtsPort = 80; $0.mouthParameter = "Mouth Open;rm"
            $0.emotionHotkeys = ["happy": "abc", "launch": "x"]
        }
        let codex = stage.character(.codex)
        XCTAssertEqual(codex.speechRate, 0.65)
        XCTAssertEqual(codex.vtsPort, 1_024)
        XCTAssertEqual(codex.mouthParameter, "MouthOpenrm")
        XCTAssertEqual(codex.emotionHotkeys, ["happy": "abc"])
    }
}

/// Scripted VTube Studio: answers each request type from a closure.
private final class MockVTS: VTSTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var inbox: [String] = []
    private var waiters: [CheckedContinuation<String, Error>] = []
    private(set) var sent: [VTSEnvelope] = []
    let respond: (VTSEnvelope) -> VTSEnvelope?

    init(respond: @escaping (VTSEnvelope) -> VTSEnvelope?) { self.respond = respond }

    func send(_ text: String) async throws {
        let request = try VTSProtocol.decode(text)
        lock.lock(); sent.append(request); lock.unlock()
        if let reply = respond(request) { push(try VTSProtocol.encode(reply)) }
    }
    func receive() async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            if inbox.isEmpty { waiters.append(continuation); lock.unlock() }
            else { let next = inbox.removeFirst(); lock.unlock(); continuation.resume(returning: next) }
        }
    }
    func close() {
        lock.lock(); let pending = waiters; waiters = []; lock.unlock()
        pending.forEach { $0.resume(throwing: VTSError.disconnected) }
    }
    private func push(_ text: String) {
        lock.lock()
        if waiters.isEmpty { inbox.append(text); lock.unlock() }
        else { let waiter = waiters.removeFirst(); lock.unlock(); waiter.resume(returning: text) }
    }
    var sentTypes: [String] { lock.lock(); defer { lock.unlock() }; return sent.map(\.messageType) }
}

private func reply(_ request: VTSEnvelope, _ type: String, _ data: [String: JSONValue]) -> VTSEnvelope {
    VTSEnvelope(requestID: request.requestID, messageType: type, data: .object(data))
}

private func scriptedVTS(validToken: String) -> MockVTS {
    MockVTS { request in
        switch request.messageType {
        case "AuthenticationRequest":
            let ok = request.data?["authenticationToken"]?.string == validToken
            return reply(request, "AuthenticationResponse", ["authenticated": .bool(ok)])
        case "AuthenticationTokenRequest":
            return reply(request, "AuthenticationTokenResponse", ["authenticationToken": .string(validToken)])
        case "CurrentModelRequest":
            return reply(request, "CurrentModelResponse", ["modelLoaded": .bool(true),
                         "modelName": .string("Claudia"), "modelID": .string("m1")])
        case "HotkeysInCurrentModelRequest":
            return reply(request, "HotkeysInCurrentModelResponse", ["availableHotkeys": .array([
                .object(["hotkeyID": .string("hk-smile"), "name": .string("Smile"), "type": .string("ToggleExpression")])])])
        case "HotkeyTriggerRequest":
            return reply(request, "HotkeyTriggerResponse", ["hotkeyID": request.data?["hotkeyID"] ?? .null])
        default:
            return VTSEnvelope(requestID: request.requestID, messageType: "APIError",
                               data: .object(["errorID": .number(1), "message": .string("nope")]))
        }
    }
}

final class VTubeStudioClientTests: XCTestCase {
    func testNewTokenIsRequestedWhenStoredTokenIsRejected() async throws {
        let mock = scriptedVTS(validToken: "fresh")
        let client = VTubeStudioClient(makeTransport: { _ in mock })
        let result = try await client.connect(port: 8001, token: "revoked")
        XCTAssertEqual(result.token, "fresh")
        XCTAssertEqual(result.model.name, "Claudia")
        XCTAssertEqual(mock.sentTypes, ["AuthenticationRequest", "AuthenticationTokenRequest",
                                        "AuthenticationRequest", "CurrentModelRequest"])
    }

    func testStoredTokenSkipsApprovalDialog() async throws {
        let mock = scriptedVTS(validToken: "kept")
        let client = VTubeStudioClient(makeTransport: { _ in mock })
        _ = try await client.connect(port: 8001, token: "kept")
        XCTAssertFalse(mock.sentTypes.contains("AuthenticationTokenRequest"))
    }

    func testOnlyListedHotkeysCanBeTriggered() async throws {
        let mock = scriptedVTS(validToken: "t")
        let client = VTubeStudioClient(makeTransport: { _ in mock })
        _ = try await client.connect(port: 8001, token: "t")
        do { try await client.trigger(hotkeyID: "hk-smile"); XCTFail("must refresh the whitelist first") }
        catch { XCTAssertEqual(error as? VTSError, .unknownHotkey("hk-smile")) }
        let keys = try await client.hotkeys()
        XCTAssertEqual(keys.first?.toggles, true)
        try await client.trigger(hotkeyID: "hk-smile")
        XCTAssertEqual(mock.sentTypes.last, "HotkeyTriggerRequest")
    }

    func testRequestTimesOutWhenVTSIsSilent() async throws {
        let silent = MockVTS { _ in nil }
        let client = VTubeStudioClient(makeTransport: { _ in silent })
        do {
            _ = try await client.connect(port: 8001, token: "", approvalTimeout: 0.2)
            XCTFail("expected timeout")
        } catch {
            guard case .timedOut = error as? VTSError else { return XCTFail("\(error)") }
        }
    }

    func testInjectClampsValues() throws {
        let envelope = VTSProtocol.inject(id: "1", parameters: [("MouthOpen", 3)])
        let value = envelope.data?["parameterValues"]?.array?.first?["value"]?.number
        XCTAssertEqual(value, 1)
        XCTAssertEqual(envelope.data?["faceFound"]?.bool, false)
    }
}

final class LiveShowCuePromptTests: XCTestCase {
    func testCueInstructionsOnlyWhenStagePerforms() {
        let room = TeamRoom(entries: [RoomEntry(speaker: .user, displayName: "觀眾", body: "嗨")])
        let plain = LiveShowPolicy.prompt(room: room, speaker: .claude, topic: "遊戲", summary: "", language: .zhTW)
        let staged = LiveShowPolicy.prompt(room: room, speaker: .claude, topic: "遊戲", summary: "",
                                           language: .zhTW, cues: true)
        XCTAssertFalse(plain.contains("[happy]"))
        XCTAssertTrue(staged.contains("[happy]") && staged.contains("[shy]"))
    }
}
