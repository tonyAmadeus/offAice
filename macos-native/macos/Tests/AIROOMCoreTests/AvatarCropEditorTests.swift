import XCTest
@testable import AIROOMCore

final class AvatarCropEditorTests: XCTestCase {
    private let sourceWidth = 960.0
    private let sourceHeight = 1720.0

    func testCustomCropIsPersistedPerMember() throws {
        var state = SavedState()
        let original = try XCTUnwrap(state.members.first(where: { $0.agent == .claude }))
        let custom = PortraitFaceAnchor(x: 0.44, y: 0.19, zoom: 4.7)
        let index = try XCTUnwrap(state.members.firstIndex(where: { $0.id == original.id }))
        state.members[index].avatarCrop = custom
        let encoded = try JSONEncoder().encode(state)
        let decoded = try JSONDecoder().decode(SavedState.self, from: encoded)
        XCTAssertEqual(decoded.members.first(where: { $0.agent == .claude })?.avatarCrop, custom)
        XCTAssertNil(decoded.members.first(where: { $0.agent == .codex })?.avatarCrop)
    }

    func testLegacyMemberCardWithoutCropLoadsDefault() throws {
        let card = MemberCard(agent: .codex, name: "GPTIA", persona: "Developer")
        var encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(card)) as? [String: Any])
        encoded.removeValue(forKey: "avatarCrop")
        let legacy = try JSONSerialization.data(withJSONObject: encoded)
        let restored = try JSONDecoder().decode(MemberCard.self, from: legacy)
        XCTAssertEqual(restored.id, card.id)
        XCTAssertEqual(restored.persona, "Developer")
        XCTAssertNil(restored.avatarCrop)
        XCTAssertEqual(restored.agent.portraitFaceAnchor, AgentKind.codex.portraitFaceAnchor)
    }

    func testDraggingRightAndDownMovesImageRightAndDown() throws {
        let start = AgentKind.claude.portraitFaceAnchor
        let changed = start.translated(dragX: 18, dragY: 24, diameter: 230,
                                       sourceWidth: sourceWidth, sourceHeight: sourceHeight)
        XCTAssertLessThan(changed.x, start.x)
        XCTAssertLessThan(changed.y, start.y)
        let before = try XCTUnwrap(PortraitCropLayout.make(diameter: 230, sourceWidth: sourceWidth,
                    sourceHeight: sourceHeight, anchor: start))
        let after = try XCTUnwrap(PortraitCropLayout.make(diameter: 230, sourceWidth: sourceWidth,
                    sourceHeight: sourceHeight, anchor: changed))
        XCTAssertEqual(after.centerX - before.centerX, 18, accuracy: 0.000001)
        XCTAssertEqual(after.centerY - before.centerY, 24, accuracy: 0.000001)
    }

    func testDraggingCannotExposeOutsideOfArtwork() throws {
        let start = AgentKind.codex.portraitFaceAnchor
        let changed = start.translated(dragX: 100_000, dragY: -100_000, diameter: 230,
                                       sourceWidth: sourceWidth, sourceHeight: sourceHeight)
        let crop = try XCTUnwrap(PortraitCropLayout.make(diameter: 230, sourceWidth: sourceWidth,
                    sourceHeight: sourceHeight, anchor: changed))
        XCTAssertLessThanOrEqual(crop.originX, 0.000001)
        XCTAssertLessThanOrEqual(crop.originY, 0.000001)
        XCTAssertGreaterThanOrEqual(crop.originX + crop.imageWidth, 230 - 0.000001)
        XCTAssertGreaterThanOrEqual(crop.originY + crop.imageHeight, 230 - 0.000001)
    }

    func testZoomAndPositionClamping() {
        let changed = PortraitFaceAnchor(x: -1, y: 3, zoom: 100)
            .constrained(sourceWidth: sourceWidth, sourceHeight: sourceHeight)
        XCTAssertEqual(changed.zoom, 7)
        XCTAssertGreaterThanOrEqual(changed.x, 0)
        XCTAssertLessThanOrEqual(changed.y, 1)
    }
}
