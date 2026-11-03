import Foundation

/// Normalized face anchor and source-width magnification used by the original AIROOM UI.
/// Values describe the artwork, not a fixed pixel displacement, so small sidebar avatars
/// and larger member cards use the same crop without stretching a portrait into a square.
public struct PortraitFaceAnchor: Codable, Equatable, Sendable {
    public let x: Double
    public let y: Double
    public let zoom: Double

    public init(x: Double, y: Double, zoom: Double) {
        self.x = x
        self.y = y
        self.zoom = zoom
    }
}


public extension PortraitFaceAnchor {
    /// Ensure a crop always fills the full circular viewport and uses reasonable
    /// magnification. Coordinates remain normalized to the ORIGINAL artwork.
    func constrained(sourceWidth: Double, sourceHeight: Double,
                     zoomRange: ClosedRange<Double> = 2.5...7.0) -> PortraitFaceAnchor {
        guard sourceWidth.isFinite, sourceWidth > 0,
              sourceHeight.isFinite, sourceHeight > 0,
              x.isFinite, y.isFinite, zoom.isFinite else { return self }
        let zoomValue = min(max(zoom, zoomRange.lowerBound), zoomRange.upperBound)
        let xMargin = 0.5 / zoomValue
        let heightRatio = sourceHeight / sourceWidth
        let yMargin = 0.5 / (zoomValue * heightRatio)
        guard yMargin.isFinite, yMargin <= 0.5 else { return self }
        return PortraitFaceAnchor(
            x: min(max(x, xMargin), 1 - xMargin),
            y: min(max(y, yMargin), 1 - yMargin),
            zoom: zoomValue
        )
    }

    /// The user drags the ART in screen pixels, whereas x/y encode the face
    /// focus in original-image coordinates. Dragging right decreases x.
    func translated(dragX: Double, dragY: Double, diameter: Double,
                    sourceWidth: Double, sourceHeight: Double) -> PortraitFaceAnchor {
        guard diameter.isFinite, diameter > 0,
              dragX.isFinite, dragY.isFinite,
              sourceWidth.isFinite, sourceWidth > 0,
              sourceHeight.isFinite, sourceHeight > 0,
              zoom.isFinite, zoom > 0 else { return self }
        let displayedWidth = diameter * zoom
        let displayedHeight = displayedWidth * sourceHeight / sourceWidth
        guard displayedWidth.isFinite, displayedHeight.isFinite,
              displayedHeight > 0 else { return self }
        return PortraitFaceAnchor(
            x: x - dragX / displayedWidth,
            y: y - dragY / displayedHeight,
            zoom: zoom
        ).constrained(sourceWidth: sourceWidth, sourceHeight: sourceHeight)
    }
}

public extension AgentKind {
    /// Source: offAice/src/renderer/members.tsx, BUILTIN_ART (pinned upstream artwork).
    var portraitFaceAnchor: PortraitFaceAnchor {
        switch self {
        case .claude: return PortraitFaceAnchor(x: 0.500, y: 0.123, zoom: 3.6)
        case .codex: return PortraitFaceAnchor(x: 0.487, y: 0.113, zoom: 3.6)
        }
    }
}

/// Geometry for placing the original, undistorted portrait behind a circular clipping mask.
/// The selected point in the source image lands exactly at the circle's center.
public struct PortraitCropLayout: Equatable, Sendable {
    public let imageWidth: Double
    public let imageHeight: Double
    public let centerX: Double
    public let centerY: Double

    public var originX: Double { centerX - imageWidth / 2 }
    public var originY: Double { centerY - imageHeight / 2 }

    public static func make(
        diameter: Double,
        sourceWidth: Double,
        sourceHeight: Double,
        anchor: PortraitFaceAnchor
    ) -> PortraitCropLayout? {
        guard diameter.isFinite, diameter > 0,
              sourceWidth.isFinite, sourceWidth > 0,
              sourceHeight.isFinite, sourceHeight > 0,
              anchor.x.isFinite, (0...1).contains(anchor.x),
              anchor.y.isFinite, (0...1).contains(anchor.y),
              anchor.zoom.isFinite, anchor.zoom >= 1 else { return nil }

        let width = diameter * anchor.zoom
        let height = width * sourceHeight / sourceWidth
        guard height.isFinite, height > 0 else { return nil }
        let centerX = diameter / 2 + (0.5 - anchor.x) * width
        let centerY = diameter / 2 + (0.5 - anchor.y) * height
        return PortraitCropLayout(imageWidth: width, imageHeight: height,
                                  centerX: centerX, centerY: centerY)
    }
}
