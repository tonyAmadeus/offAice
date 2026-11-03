import SwiftUI
import AppKit
import AIROOMCore

/// Artwork is fetched from a pinned upstream commit by Scripts/fetch-original-assets.sh.
/// The UI remains usable with SF Symbol placeholders before the opt-in download.
enum StudioAsset {
    static func image(_ name: String) -> NSImage? {
        let file = (name as NSString).lastPathComponent
        guard !file.contains(".."), !file.isEmpty else { return nil }
        if let bundled = Bundle.main.resourceURL?.appendingPathComponent("Assets", isDirectory: true)
            .appendingPathComponent(file), let result = NSImage(contentsOf: bundled) {
            return result
        }
        if let url = Bundle.module.url(forResource: (file as NSString).deletingPathExtension,
                                       withExtension: (file as NSString).pathExtension),
           let result = NSImage(contentsOf: url) { return result }
        return nil
    }
    static func portrait(for agent: AgentKind) -> String {
        agent == .claude ? "claudia.webp" : "gptia.webp"
    }
    static func backdrop(for date: Date) -> String {
        switch Calendar.current.component(.hour, from: date) {
        case 5..<11: return "morning.webp"
        case 11..<17: return "afternoon.webp"
        case 17..<21: return "evening.webp"
        default: return "night.webp"
        }
    }
}

struct StudioPortrait: View {
    @EnvironmentObject private var model: WorkbenchModel
    let agent: AgentKind
    /// The editor's framing while a slider is being dragged.
    var preview: (scale: Double, offset: PortraitOffset)? = nil
    var body: some View {
        let card = model.card(agent)
        let scale = preview?.scale ?? card?.portraitScale ?? 1
        let offset = preview?.offset ?? card?.portraitOffset ?? PortraitOffset(x: 0, y: 0)
        GeometryReader { geo in
            if let art = model.portraitImage(agent) {
                Image(nsImage: art)
                    .resizable().scaledToFit()
                    .frame(width: geo.size.width, height: geo.size.height, alignment: .top)
                    .scaleEffect(scale, anchor: .top)
                    .offset(x: geo.size.width * offset.x, y: geo.size.height * offset.y)
                    .frame(width: geo.size.width, height: geo.size.height)
                    .clipped()
                    .accessibilityLabel(agent.rawValue)
            } else {
                Image(systemName: agent == .claude ? "sparkles" : "curlybraces")
                    .font(.system(size: 49, weight: .light))
                    .foregroundStyle(agent.studioColor)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }
}

struct StudioRoomBackdrop: View {
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            ZStack {
                StudioTheme.background(scheme)
                if let artwork = StudioAsset.image(StudioAsset.backdrop(for: context.date)) {
                    GeometryReader { geo in
                        Image(nsImage: artwork)
                            .resizable().scaledToFill()
                            .frame(width: geo.size.width, height: geo.size.height)
                            .clipped()
                    }
                    .opacity(scheme == .dark ? 0.24 : 0.28)
                }
                StudioTheme.background(scheme).opacity(scheme == .dark ? 0.30 : 0.43)
            }
            .accessibilityHidden(true)
        }
    }
}
