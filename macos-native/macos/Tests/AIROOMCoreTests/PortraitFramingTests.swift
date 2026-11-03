import XCTest
@testable import AIROOMCore

final class PortraitFramingTests: XCTestCase {
    // Both source portraits use a 960 × 1720 canvas.
    private let portraitWidth = 960.0
    private let portraitHeight = 1720.0

    func testFaceAnchorCenteredForBothAgentsAcrossAvatarSizes() throws {
        for agent in AgentKind.allCases {
            for diameter in [26.0, 33.0, 42.0, 66.0, 128.0] {
                let anchor = agent.portraitFaceAnchor
                let crop = try XCTUnwrap(PortraitCropLayout.make(
                    diameter: diameter, sourceWidth: portraitWidth,
                    sourceHeight: portraitHeight, anchor: anchor))
                let alignedFaceX = crop.originX + anchor.x * crop.imageWidth
                let alignedFaceY = crop.originY + anchor.y * crop.imageHeight
                XCTAssertEqual(alignedFaceX, diameter / 2, accuracy: 0.000001)
                XCTAssertEqual(alignedFaceY, diameter / 2, accuracy: 0.000001)
                XCTAssertEqual(crop.imageHeight / crop.imageWidth,
                               portraitHeight / portraitWidth, accuracy: 0.000001,
                               "The portrait must not be distorted into a square.")
            }
        }
    }

    func testSourceAnchorsMatchOriginalUI() {
        XCTAssertEqual(AgentKind.claude.portraitFaceAnchor,
                       PortraitFaceAnchor(x: 0.500, y: 0.123, zoom: 3.6))
        XCTAssertEqual(AgentKind.codex.portraitFaceAnchor,
                       PortraitFaceAnchor(x: 0.487, y: 0.113, zoom: 3.6))
    }

    func testRejectInvalidDimensionsAndCoordinates() {
        let anchor = AgentKind.claude.portraitFaceAnchor
        XCTAssertNil(PortraitCropLayout.make(diameter: 0, sourceWidth: 960,
                                             sourceHeight: 1720, anchor: anchor))
        XCTAssertNil(PortraitCropLayout.make(diameter: 40, sourceWidth: 0,
                                             sourceHeight: 1720, anchor: anchor))
        XCTAssertNil(PortraitCropLayout.make(diameter: 40, sourceWidth: 960,
                                             sourceHeight: .infinity, anchor: anchor))
        XCTAssertNil(PortraitCropLayout.make(diameter: 40, sourceWidth: 960,
                                             sourceHeight: 1720,
                                             anchor: PortraitFaceAnchor(x: 1.5, y: 0.2, zoom: 3.6)))
    }

    func testCodexFaceIsSlightlyRightOfCenterInSource() throws {
        let anchor = AgentKind.codex.portraitFaceAnchor
        let crop = try XCTUnwrap(PortraitCropLayout.make(diameter: 40,
                sourceWidth: portraitWidth, sourceHeight: portraitHeight, anchor: anchor))
        XCTAssertGreaterThan(crop.centerX, 20) // source focus x=0.487
        XCTAssertLessThan(crop.originY, 0) // face is close to top of original artwork
    }
}
