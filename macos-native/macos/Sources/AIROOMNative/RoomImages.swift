import SwiftUI
import AppKit
import UniformTypeIdentifiers
import AIROOMCore

/// Thumbnails of the pictures on a lounge entry; a click opens the viewer.
struct RoomImagesStrip: View {
    @EnvironmentObject private var model: WorkbenchModel
    let images: [RoomImage]
    let onEdit: (RoomImage) -> Void
    @State private var viewing: RoomImage?

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            ForEach(images) { image in
                Button { viewing = image } label: {
                    RoomImageView(image: image).frame(maxWidth: images.count == 1 ? 320 : 160, maxHeight: images.count == 1 ? 320 : 160)
                }
                .buttonStyle(.plain)
                .help(image.revisedPrompt ?? image.attachment.fileName)
            }
        }
        .sheet(item: $viewing) { image in
            RoomImageViewer(image: image, onEdit: { onEdit(image); viewing = nil }).environmentObject(model)
        }
    }
}

/// Decrypts and shows one stored picture.
struct RoomImageView: View {
    @EnvironmentObject private var model: WorkbenchModel
    let image: RoomImage
    @State private var picture: NSImage?
    @State private var missing = false

    var body: some View {
        Group {
            if let picture {
                Image(nsImage: picture).resizable().aspectRatio(contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
            } else if missing {
                Label(StudioI18n.t("圖片無法讀取", "Image unavailable", model.archive.settings.language), systemImage: "photo.badge.exclamationmark")
                    .font(.caption).foregroundStyle(.secondary).padding(10)
            } else {
                ProgressView().controlSize(.small).frame(width: 60, height: 60)
            }
        }
        .task(id: image.id) {
            if let data = model.imageData(image), let loaded = NSImage(data: data) { picture = loaded } else { missing = true }
        }
    }
}

private struct RoomImageViewer: View {
    @EnvironmentObject private var model: WorkbenchModel
    @Environment(\.dismiss) private var dismiss
    let image: RoomImage
    let onEdit: () -> Void
    private func t(_ zh: String, _ en: String) -> String { StudioI18n.t(zh, en, model.archive.settings.language) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            RoomImageView(image: image).frame(width: 680, height: 500)
            if let prompt = image.revisedPrompt, !prompt.isEmpty {
                // Long prompts wrap inside the sheet instead of widening it.
                ScrollView {
                    Text(t("Codex 實際使用的描述：", "Prompt Codex used: ") + prompt)
                        .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 64)
            }
            HStack {
                Button { save() } label: { Label(t("另存新檔…", "Save As…"), systemImage: "square.and.arrow.down") }
                Button { copy() } label: { Label(t("拷貝", "Copy"), systemImage: "doc.on.doc") }
                Button { onEdit() } label: { Label(t("以這張修改", "Edit from this"), systemImage: "paintbrush") }
                    .disabled(!model.canGenerateImage)
                Spacer()
                Button(t("關閉", "Close")) { dismiss() }.keyboardShortcut(.cancelAction)
            }
        }
        .padding(20)
        .frame(width: 720)
    }

    private func save() {
        guard let data = model.imageData(image) else { return }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = image.attachment.fileName
        if let type = UTType(mimeType: image.attachment.mediaType) { panel.allowedContentTypes = [type] }
        if panel.runModal() == .OK, let url = panel.url { try? data.write(to: url, options: .atomic) }
    }

    private func copy() {
        guard let data = model.imageData(image), let picture = NSImage(data: data) else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.writeObjects([picture])
    }
}

/// What to ask Codex to draw, with optional reference pictures.
struct ImageRequestSheet: View {
    @EnvironmentObject private var model: WorkbenchModel
    @Environment(\.dismiss) private var dismiss
    @State var text: String
    @State var references: [RoomImage]
    @State private var picking = false
    private func t(_ zh: String, _ en: String) -> String { StudioI18n.t(zh, en, model.archive.settings.language) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(t("請 Codex 畫圖", "Ask Codex for a picture")).font(.title3.weight(.semibold))
            Text(t("只打開 Codex 的圖片工具；不執行命令、不讀寫檔案、不上網搜尋。會用掉 Codex 的額度，失敗不會自動重送。",
                   "Only Codex's image tool is on: no commands, files or web search. Uses Codex quota; a failure is never re-sent."))
                .font(.caption).foregroundStyle(.secondary)
            TextEditor(text: $text)
                .frame(minHeight: 110).font(.body).scrollContentBackground(.hidden).padding(8)
                .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
            HStack(spacing: 8) {
                ForEach(references) { image in
                    ZStack(alignment: .topTrailing) {
                        RoomImageView(image: image).frame(width: 72, height: 72)
                        Button { references.removeAll { $0.id == image.id } } label: {
                            Image(systemName: "xmark.circle.fill").foregroundStyle(.white, .black.opacity(0.6))
                        }.buttonStyle(.plain)
                    }
                }
                Button { picking = true } label: { Label(t("加參考圖…", "Add reference…"), systemImage: "photo.badge.plus") }
                    .disabled(references.count >= 4)
                Spacer()
            }
            HStack {
                Spacer()
                Button(t("取消", "Cancel")) { dismiss() }.keyboardShortcut(.cancelAction)
                Button(t("請 Codex 畫", "Draw")) {
                    model.generateImage(request: text, references: references)
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || text.count > 4_000 || !model.canGenerateImage)
            }
        }
        .padding(22)
        .frame(width: 560)
        .fileImporter(isPresented: $picking, allowedContentTypes: [.png, .jpeg, .webP], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            for url in urls.prefix(4 - references.count) {
                if let image = model.storeImageReference(url) { references.append(image) }
            }
        }
    }
}
