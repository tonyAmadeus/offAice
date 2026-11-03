import SwiftUI
import AppKit
import AIROOMCore

/// A local, non-destructive portrait editor. The source WebP remains unchanged;
/// only normalized framing coordinates are written into the encrypted member card.
struct AvatarCropEditor: View {
    @EnvironmentObject private var model: WorkbenchModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    let agent: AgentKind
    let source: AvatarSource
    /// The new crop, nil for the default; saved to the uploaded avatar or the portrait, as `source` says.
    let onSave: (PortraitFaceAnchor?) -> Void

    @State private var draft: PortraitFaceAnchor
    @State private var startOfDrag: PortraitFaceAnchor?

    private let previewSize: CGFloat = 230

    init(agent: AgentKind, source: AvatarSource, onSave: @escaping (PortraitFaceAnchor?) -> Void) {
        self.agent = agent
        self.source = source
        self.onSave = onSave
        _draft = State(initialValue: source.fitted(source.anchor))
    }

    private var language: InterfaceLanguage { model.archive.settings.language }
    private func t(_ zh: String, _ en: String) -> String { StudioI18n.t(zh, en, language) }
    private var artwork: NSImage? { source.image }

    private func restrict(_ candidate: PortraitFaceAnchor) -> PortraitFaceAnchor { source.fitted(candidate) }

    private func change(x: Double? = nil, y: Double? = nil, zoom: Double? = nil) {
        draft = restrict(PortraitFaceAnchor(x: x ?? draft.x,
                                           y: y ?? draft.y,
                                           zoom: zoom ?? draft.zoom))
    }

    private var cropGesture: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                guard let art = artwork else { return }
                let origin = startOfDrag ?? draft
                if startOfDrag == nil { startOfDrag = origin }
                // Move first, then fit to this picture's own zoom range.
                let moved = origin.translated(
                    dragX: Double(value.translation.width),
                    dragY: Double(value.translation.height),
                    diameter: Double(previewSize),
                    sourceWidth: Double(art.size.width),
                    sourceHeight: Double(art.size.height)
                )
                draft = restrict(PortraitFaceAnchor(x: moved.x, y: moved.y, zoom: origin.zoom))
            }
            .onEnded { _ in startOfDrag = nil }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                VStack(alignment: .leading, spacing: 5) {
                    Text(t("調整頭像", "Adjust Avatar"))
                        .font(.title2.bold())
                    Text(agent.rawValue)
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer()
                Button { dismiss() } label: { Image(systemName: "xmark.circle.fill") }
                    .buttonStyle(.plain).foregroundStyle(.secondary)
                    .accessibilityLabel(t("關閉", "Close"))
            }
            Divider()
            HStack(alignment: .center, spacing: 32) {
                VStack(spacing: 10) {
                    StudioFaceArtwork(agent: agent, size: previewSize, previewAnchor: draft)
                        .background(agent.studioColor.opacity(0.14), in: Circle())
                        .overlay(Circle().strokeBorder(agent.studioColor.opacity(0.7), lineWidth: 2))
                        .contentShape(Circle())
                        .gesture(cropGesture)
                        .accessibilityLabel(t("拖曳頭像以調整位置", "Drag avatar to reposition"))
                    Text(t("拖曳圓形預覽來移動圖片", "Drag inside the circle to reposition"))
                        .font(.caption).foregroundStyle(.secondary)
                }
                VStack(alignment: .leading, spacing: 16) {
                    HStack(spacing: 14) {
                        StudioFaceArtwork(agent: agent, size: 46, previewAnchor: draft)
                            .background(agent.studioColor.opacity(0.14), in: Circle())
                        StudioFaceArtwork(agent: agent, size: 88, previewAnchor: draft)
                            .background(agent.studioColor.opacity(0.14), in: Circle())
                    }
                    Text(t("小尺寸與大尺寸即時預覽", "Live previews at sidebar and card sizes"))
                        .font(.caption).foregroundStyle(.secondary)
                    Spacer(minLength: 4)
                    VStack(alignment: .leading, spacing: 7) {
                        HStack {
                            Text(t("縮放", "Zoom"))
                            Spacer()
                            Text(String(format: "%.1f×", draft.zoom)).monospacedDigit()
                        }
                        Slider(value: Binding(get: { draft.zoom },
                                              set: { change(zoom: $0) }), in: source.zoomRange, step: 0.1)
                            .tint(agent.studioColor)
                    }
                    VStack(alignment: .leading, spacing: 7) {
                        Text(t("水平位置（精細調整）", "Horizontal position (fine tune)"))
                        Slider(value: Binding(get: { draft.x },
                                              set: { change(x: $0) }), in: 0...1)
                            .tint(agent.studioColor)
                    }
                    VStack(alignment: .leading, spacing: 7) {
                        Text(t("垂直位置（精細調整）", "Vertical position (fine tune)"))
                        Slider(value: Binding(get: { draft.y },
                                              set: { change(y: $0) }), in: 0...1)
                            .tint(agent.studioColor)
                    }
                    Text(String(format: "X %.1f%%  ·  Y %.1f%%", draft.x * 100, draft.y * 100))
                        .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
            }
            .disabled(artwork == nil)

            if artwork == nil {
                StudioNotice(icon: "photo.badge.exclamationmark", message:
                    t("找不到原始人物圖片。請先執行 ./Scripts/package-app.sh 下載素材，再重新開啟 App。",
                      "Original portrait is missing. Run ./Scripts/package-app.sh to fetch assets, then reopen the app."))
            } else {
                StudioNotice(icon: "lock.shield", message:
                    t("只儲存裁切參數，不修改原始立繪。按「儲存」後會同步更新所有房間的頭像。",
                      "Only crop coordinates are saved; original artwork stays intact. Saving updates avatars across all rooms."))
            }
            Divider()
            HStack {
                Button(t("恢復預設位置", "Reset to Default")) {
                    draft = source.fitted(source.defaultAnchor)
                    startOfDrag = nil
                }
                .disabled(artwork == nil)
                Spacer()
                Button(t("取消", "Cancel")) { dismiss() }
                Button(t("儲存", "Save")) {
                    onSave(draft == source.fitted(source.defaultAnchor) ? nil : draft)
                    dismiss()
                }
                .buttonStyle(.borderedProminent)
                .disabled(artwork == nil || !model.storageAvailable)
            }
        }
        .padding(25)
        .frame(width: 690)
        .background(StudioTheme.background(colorScheme))
    }
}
