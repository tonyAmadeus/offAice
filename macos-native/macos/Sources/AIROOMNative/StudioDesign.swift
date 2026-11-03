import SwiftUI
import AppKit
import AIROOMCore

// Native reconstruction of AIROOM's warm paper / lamplight design system.
// The original Electron stylesheet is not loaded; all controls are SwiftUI.
enum StudioTheme {
    static let amber = Color(red: 0.86, green: 0.59, blue: 0.29)
    static let orange = Color(red: 0.85, green: 0.41, blue: 0.18)
    static let violet = Color(red: 0.48, green: 0.43, blue: 0.84)
    static let moss = Color(red: 0.24, green: 0.54, blue: 0.36)
    static let warning = Color(red: 0.65, green: 0.43, blue: 0.14)
    static func background(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(red: 0.10, green: 0.085, blue: 0.075) : Color(red: 0.965, green: 0.941, blue: 0.907)
    }
    static func sidebar(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(red: 0.13, green: 0.11, blue: 0.095) : Color(red: 0.943, green: 0.905, blue: 0.855)
    }
    static func surface(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(red: 0.15, green: 0.13, blue: 0.115) : Color(red: 1.0, green: 0.993, blue: 0.972)
    }
    static func secondary(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(red: 0.18, green: 0.15, blue: 0.13) : Color(red: 0.982, green: 0.961, blue: 0.934)
    }
    static func border(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(red: 0.26, green: 0.22, blue: 0.19) : Color(red: 0.89, green: 0.854, blue: 0.805)
    }
    static func ink(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(red: 0.95, green: 0.92, blue: 0.88) : Color(red: 0.20, green: 0.16, blue: 0.13)
    }
}

enum StudioI18n {
    static func t(_ zh: String, _ en: String, _ language: InterfaceLanguage) -> String {
        language == .english ? en : zh
    }
}

/// Colors chosen on member cards; kept current by WorkbenchModel.
enum MemberColors {
    nonisolated(unsafe) static var chosen: [AgentKind: Color] = [:]
}

extension Color {
    /// "#rrggbb"; nil for anything else.
    init?(hex: String) {
        guard hex.range(of: #"^#[0-9a-fA-F]{6}$"#, options: .regularExpression) != nil,
              let value = UInt32(hex.dropFirst(), radix: 16) else { return nil }
        self.init(red: Double((value >> 16) & 0xFF) / 255, green: Double((value >> 8) & 0xFF) / 255, blue: Double(value & 0xFF) / 255)
    }

    var hexString: String? {
        guard let rgb = NSColor(self).usingColorSpace(.sRGB) else { return nil }
        let part = { (v: CGFloat) in Int((min(max(v, 0), 1) * 255).rounded()) }
        return String(format: "#%02x%02x%02x", part(rgb.redComponent), part(rgb.greenComponent), part(rgb.blueComponent))
    }
}

extension AgentKind {
    var studioColor: Color { MemberColors.chosen[self] ?? builtInColor }
    var builtInColor: Color { self == .claude ? StudioTheme.orange : StudioTheme.violet }
    var shortName: String { self == .claude ? "Claude" : "Codex" }
}

struct StudioPanel<Content: View>: View {
    @Environment(\.colorScheme) private var scheme
    var padding: CGFloat = 18
    @ViewBuilder var content: Content
    var body: some View {
        content
            .padding(padding)
            .background(StudioTheme.surface(scheme), in: RoundedRectangle(cornerRadius: 17))
            .overlay(RoundedRectangle(cornerRadius: 17).strokeBorder(StudioTheme.border(scheme), lineWidth: 1))
    }
}

struct StudioBrandMark: View {
    var size: CGFloat = 36
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.28)
                .fill(Color(red: 0.23, green: 0.18, blue: 0.15))
            Circle().fill(StudioTheme.orange)
                .frame(width: size * 0.27, height: size * 0.27)
                .offset(x: -size * 0.19, y: size * 0.14)
            Circle().fill(StudioTheme.violet)
                .frame(width: size * 0.27, height: size * 0.27)
                .offset(x: size * 0.19, y: size * 0.14)
            Circle().fill(Color(red: 0.26, green: 0.44, blue: 0.82))
                .frame(width: size * 0.27, height: size * 0.27)
                .offset(y: -size * 0.18)
        }
        .frame(width: size, height: size)
        .accessibilityLabel("AIROOM")
    }
}

/// Face crop shared by the sidebar, member card, chat bubbles and room participants.
/// Original artwork is a tall portrait. The face is NOT at the image centre;
/// preserve its aspect ratio and align the original artwork's measured face anchor.
struct StudioFaceArtwork: View {
    @EnvironmentObject private var model: WorkbenchModel
    let agent: AgentKind
    let size: CGFloat
    /// Supplied by the editor for live preview; otherwise read the saved card.
    var previewAnchor: PortraitFaceAnchor? = nil

    var body: some View {
        GeometryReader { geometry in
            if let source = model.avatarSource(agent),
               let crop = PortraitCropLayout.make(
                   diameter: Double(geometry.size.width),
                   sourceWidth: Double(source.image.size.width),
                   sourceHeight: Double(source.image.size.height),
                   anchor: source.fitted(previewAnchor ?? source.anchor)
               ) {
                Image(nsImage: source.image)
                    .resizable()
                    .interpolation(.high)
                    .frame(width: CGFloat(crop.imageWidth), height: CGFloat(crop.imageHeight))
                    .position(x: CGFloat(crop.centerX), y: CGFloat(crop.centerY))
            } else {
                Image(systemName: agent == .claude ? "sparkle" : "curlybraces")
                    .font(.system(size: geometry.size.width * 0.42, weight: .semibold))
                    .foregroundStyle(agent.studioColor)
                    .frame(width: geometry.size.width, height: geometry.size.height)
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .accessibilityHidden(true)
    }
}

/// What a member's avatar is cut from: an uploaded avatar, else the (uploaded or built-in) portrait.
struct AvatarSource {
    let image: NSImage
    /// The saved crop, or the default for this picture.
    let anchor: PortraitFaceAnchor
    let defaultAnchor: PortraitFaceAnchor
    let zoomRange: ClosedRange<Double>
    /// Whether the crop belongs to an uploaded avatar (avatarImageCrop) or the portrait (avatarCrop).
    let isUploadedAvatar: Bool

    func fitted(_ anchor: PortraitFaceAnchor) -> PortraitFaceAnchor {
        anchor.constrained(sourceWidth: Double(image.size.width), sourceHeight: Double(image.size.height), zoomRange: zoomRange)
    }
}

extension WorkbenchModel {
    func card(_ agent: AgentKind) -> MemberCard? { archive.members.first { $0.agent == agent } }

    /// Members whose card shows on the home page and in the sidebar.
    var visibleAgents: [AgentKind] { AgentKind.allCases.filter { card($0)?.cardHidden != true } }

    /// The uploaded portrait, else the built-in art.
    func portraitImage(_ agent: AgentKind) -> NSImage? {
        memberImage(card(agent)?.portrait) ?? StudioAsset.image(StudioAsset.portrait(for: agent))
    }

    func avatarSource(_ agent: AgentKind) -> AvatarSource? {
        let card = card(agent)
        if let image = memberImage(card?.avatar), image.size.width > 0, image.size.height > 0 {
            // An uploaded avatar always covers the circle.
            let cover = max(1, Double(image.size.width / image.size.height))
            let fallback = PortraitFaceAnchor(x: 0.5, y: 0.5, zoom: cover)
            return AvatarSource(image: image, anchor: card?.avatarImageCrop ?? fallback, defaultAnchor: fallback,
                                zoomRange: cover...max(cover, 8), isUploadedAvatar: true)
        }
        if let image = memberImage(card?.portrait) {
            let fallback = PortraitFaceAnchor(x: 0.5, y: 0.15, zoom: 3)
            return AvatarSource(image: image, anchor: card?.avatarCrop ?? fallback, defaultAnchor: fallback,
                                zoomRange: 1...8, isUploadedAvatar: false)
        }
        guard let image = StudioAsset.image(StudioAsset.portrait(for: agent)) else { return nil }
        return AvatarSource(image: image, anchor: card?.avatarCrop ?? agent.portraitFaceAnchor, defaultAnchor: agent.portraitFaceAnchor,
                            zoomRange: 2.5...7, isUploadedAvatar: false)
    }
}

struct StudioAvatar: View {
    let agent: AgentKind
    var size: CGFloat = 40
    var running = false
    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            Circle().fill(agent.studioColor.opacity(0.15))
                .overlay(Circle().strokeBorder(agent.studioColor.opacity(0.34), lineWidth: 1.4))
                .overlay {
                    StudioFaceArtwork(agent: agent, size: size)
                }
            Circle()
                .fill(running ? StudioTheme.amber : StudioTheme.moss)
                .frame(width: size * 0.23, height: size * 0.23)
                .overlay(Circle().strokeBorder(.background, lineWidth: 2))
        }
        .frame(width: size, height: size)
        .accessibilityLabel(agent.shortName)
    }
}

struct StudioPageHeading: View {
    @Environment(\.colorScheme) private var scheme
    var eyebrow: String
    var title: String
    var subtitle: String
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(eyebrow.uppercased())
                .font(.system(size: 11, weight: .bold, design: .rounded))
                .tracking(1.8)
                .foregroundStyle(StudioTheme.warning)
            Text(title)
                .font(.system(size: 28, weight: .bold, design: .rounded))
                .foregroundStyle(StudioTheme.ink(scheme))
            Text(subtitle)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

struct StudioNotice: View {
    var icon: String = "shield.lefthalf.filled"
    var message: String
    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            Image(systemName: icon).foregroundStyle(StudioTheme.warning)
            Text(message).font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(StudioTheme.amber.opacity(0.09), in: RoundedRectangle(cornerRadius: 10))
    }
}

struct StudioPhasePill: View {
    let phase: ProjectPhase
    let language: InterfaceLanguage
    private var color: Color {
        switch phase {
        case .draft: return StudioTheme.warning
        case .executing: return StudioTheme.violet
        case .reviewing: return StudioTheme.orange
        case .accepted: return StudioTheme.moss
        case .rejected, .failed: return .red
        }
    }
    var body: some View {
        Text(LocalizedUI.phase(phase, language: language))
            .font(.caption.weight(.medium))
            .padding(.horizontal, 9).padding(.vertical, 4)
            .background(color.opacity(0.12), in: Capsule())
            .foregroundStyle(color)
    }
}

struct StudioEmptyState: View {
    var icon: String
    var title: String
    var detail: String
    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: icon).font(.system(size: 38)).foregroundStyle(StudioTheme.amber)
            Text(title).font(.title3.weight(.semibold))
            Text(detail).font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .padding(30)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Renders the light Markdown models write (headings, **bold**, *italic*,
/// `code`, lists) without turning links into anything clickable.
struct RichText: View {
    let source: String
    var font: Font = .system(size: 14)
    init(_ source: String, font: Font = .system(size: 14)) { self.source = source; self.font = font }

    var body: some View {
        Text(Self.render(source)).font(font)
    }

    static func render(_ text: String) -> AttributedString {
        var result = AttributedString()
        let lines = text.components(separatedBy: "\n")
        for (index, raw) in lines.enumerated() {
            var line = raw
            var heading = false
            let hashes = line.prefix(while: { $0 == "#" }).count
            if (1...6).contains(hashes), line.dropFirst(hashes).first == " " {
                line = String(line.dropFirst(hashes + 1))
                heading = true
            }
            var piece = (try? AttributedString(markdown: line, options: .init(
                allowsExtendedAttributes: false, interpretedSyntax: .inlineOnlyPreservingWhitespace,
                failurePolicy: .returnPartiallyParsedIfPossible))) ?? AttributedString(line)
            // Links stay plain text: model output must never become a click target.
            for run in piece.runs where run.link != nil { piece[run.range].link = nil }
            if heading { piece.inlinePresentationIntent = .stronglyEmphasized }
            result += piece
            if index < lines.count - 1 { result += AttributedString("\n") }
        }
        return result
    }
}
