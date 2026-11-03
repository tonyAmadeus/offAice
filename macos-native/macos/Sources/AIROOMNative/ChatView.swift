import SwiftUI
import UniformTypeIdentifiers
import AIROOMCore

struct ChatView: View {
    @EnvironmentObject private var model: WorkbenchModel
    @Environment(\.colorScheme) private var scheme
    let agent: AgentKind
    @State private var importing = false
    @State private var renaming = false
    @State private var renameText = ""
    @State private var dropTargeted = false
    @State private var choosingFolder = false
    @State private var confirmDiscard = false

    private var lang: InterfaceLanguage { model.archive.settings.language }
    private func t(_ zh: String, _ en: String) -> String { StudioI18n.t(zh, en, lang) }
    private var memberName: String { model.archive.members.first(where: { $0.agent == agent })?.name ?? agent.shortName }
    private var busy: Bool { model.busyAgents.contains(agent) }
    private var topic: Conversation? { model.activeTopic(for: agent) }
    private var draft: Binding<String> {
        Binding(get: { model.chatDrafts[agent] ?? "" },
                set: { model.chatDrafts[agent] = $0; model.draftChanged(agent) })
    }
    private var pendingAttachments: [ChatAttachment] { model.chatAttachments[agent] ?? [] }
    private var canSend: Bool {
        !busy && (!draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pendingAttachments.isEmpty)
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            transcript
            Divider()
            composer
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.image, .pdf, .text, .sourceCode, .json, .data],
                      allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { model.addAttachments(urls, to: agent) }
        }
        .fileImporter(isPresented: $choosingFolder, allowedContentTypes: [.folder]) { result in
            if case .success(let url) = result { model.setTopicFolder(agent, to: url) }
        }
        .task(id: topic?.id) { if let id = topic?.id { model.refreshDesk(id) } }
        .confirmationDialog(t("丟棄這份工作副本的所有改動？原資料夾不受影響。", "Discard every change in this task copy? The original folder is untouched."),
                            isPresented: $confirmDiscard) {
            Button(t("丟棄工作副本", "Discard task copy"), role: .destructive) { model.discardDeskCopy(agent) }
        }
        .alert(t("重新命名話題", "Rename topic"), isPresented: $renaming) {
            TextField(t("話題名稱", "Topic name"), text: $renameText)
            Button(t("儲存", "Save")) { if let id = topic?.id { model.renameTopic(id, title: renameText) } }
            Button(t("取消", "Cancel"), role: .cancel) {}
        }
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 12) {
            StudioAvatar(agent: agent, size: 40, running: busy)
            VStack(alignment: .leading, spacing: 3) {
                Text(memberName).font(.headline)
                Text(t("成員工位 · ", "Member Desk · ") + agent.rawValue)
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if busy { ProgressView().controlSize(.small) }
            folderMenu
            topicMenu
            Button { model.openVendorDesktop(for: agent) } label: {
                Label(agent == .codex ? t("在 Codex App 開新工作階段", "New session in Codex App") : t("在 Claude App 開新工作階段", "New session in Claude App"), systemImage: "arrow.up.forward.app")
            }
            .help(t("僅開啟官方桌面 App；不傳送 AIROOM 對話、Token 或工作紀錄。若設定了工作目錄，將交由 App 自行確認存取。", "Opens the official desktop app only. Does not copy AIROOM conversations or credentials. An explicitly configured workspace may be offered to the app."))
            Button { model.newTopic(for: agent) } label: { Label(t("開新話題", "New Topic"), systemImage: "plus.bubble") }
                .disabled(busy)
        }
        .padding(.horizontal, 21).padding(.vertical, 13)
    }

    private var topicMenu: some View {
        Menu {
            Section(t("話題（舊話題已歸檔，可隨時翻回）", "Topics (archived topics can be reopened)")) {
                ForEach(model.topics(for: agent)) { item in
                    Button { model.openTopic(item.id) } label: {
                        Label("\(item.title) · \(item.updatedAt.formatted(date: .abbreviated, time: .shortened))",
                              systemImage: item.archived ? "archivebox" : "checkmark.circle.fill")
                    }
                    .disabled(!item.archived)
                }
            }
            Divider()
            Button { renameText = topic?.title ?? ""; renaming = true } label: {
                Label(t("重新命名目前話題…", "Rename current topic…"), systemImage: "pencil")
            }
            Button { if let id = topic?.id { model.proposeMemories(topicID: id) } } label: {
                Label(t("請成員從這個話題提議記憶", "Ask for memory suggestions from this topic"), systemImage: "brain")
            }
            .disabled(topic.map { model.proposingMemory.contains($0.id) || !$0.messages.contains(where: { $0.role == .assistant && !$0.body.isEmpty }) } ?? true)
        } label: {
            Label(topic?.title ?? TopicNaming.defaultTitle, systemImage: "text.bubble")
                .lineLimit(1).frame(maxWidth: 220)
        }
        .disabled(busy)
    }

    private var folderMenu: some View {
        let folder = topic?.workFolder ?? ""
        return Menu {
            Button { model.setTopicFolder(agent, to: nil) } label: {
                Label(t("個人資料夾（直接修改）", "Personal folder (edited in place)"),
                      systemImage: folder.isEmpty ? "checkmark" : "person.crop.square")
            }
            Button { choosingFolder = true } label: {
                Label(t("選擇其他資料夾…（在任務副本裡修改）", "Choose another folder… (edited in a task copy)"), systemImage: "folder.badge.plus")
            }
            Divider()
            Button {
                if let url = model.deskFolderURL(for: agent) { NSWorkspace.shared.activateFileViewerSelecting([url]) }
            } label: { Label(t("在 Finder 顯示目前工作資料夾", "Show working folder in Finder"), systemImage: "folder") }
        } label: {
            Label(folder.isEmpty ? t("個人資料夾", "Personal folder") : (folder as NSString).lastPathComponent,
                  systemImage: folder.isEmpty ? "person.crop.square" : "folder")
                .lineLimit(1).frame(maxWidth: 170)
        }
        .disabled(busy)
        .help(folder.isEmpty ? t("成員的私人空間，改動直接保存", "The member's own space; edits are saved directly")
                             : t("成員在任務副本裡修改，原資料夾在你套用前不會變動：", "Edits happen in a task copy; the original stays untouched until you apply: ") + folder)
    }

    /// Task-copy changes and round actions, shown above the composer.
    @ViewBuilder private var deskStrip: some View {
        if let topic {
            let changes = model.deskChanges[topic.id] ?? []
            let undoable = model.deskUndoable.contains(topic.id)
            if !changes.isEmpty || undoable {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: topic.workFolder.isEmpty ? "person.crop.square" : "doc.on.doc")
                        .foregroundStyle(agent.studioColor)
                    VStack(alignment: .leading, spacing: 4) {
                        if topic.workFolder.isEmpty {
                            Text(t("個人資料夾的改動已直接保存。", "Changes in the personal folder are saved directly."))
                                .font(.caption)
                        } else if changes.isEmpty {
                            Text(t("任務副本與原資料夾一致。", "The task copy matches the original folder.")).font(.caption)
                        } else {
                            DisclosureGroup {
                                VStack(alignment: .leading, spacing: 2) {
                                    ForEach(changes.prefix(40)) { change in
                                        Label(change.path, systemImage: change.kind == .added ? "plus.circle"
                                              : change.kind == .deleted ? "minus.circle" : "pencil.circle")
                                            .font(.caption.monospaced()).lineLimit(1)
                                    }
                                    if changes.count > 40 { Text("… +\(changes.count - 40)").font(.caption2) }
                                }
                            } label: {
                                Text(t("任務副本有 \(changes.count) 個檔案變更，尚未寫回原資料夾", "\(changes.count) changed files in the task copy, not yet applied"))
                                    .font(.caption.weight(.semibold))
                            }
                        }
                    }
                    Spacer()
                    if !topic.workFolder.isEmpty && !changes.isEmpty {
                        Button(t("應用到原資料夾", "Apply to original")) { model.applyDeskChanges(agent) }
                            .buttonStyle(.borderedProminent).controlSize(.small)
                    }
                    if undoable {
                        Button(t("撤銷最近一輪", "Undo last round")) { model.undoDeskRound(agent) }
                            .controlSize(.small)
                            .help(t("恢復到這一輪開始前的樣子；已寫回的原檔案也一起恢復", "Restore the state before this round, including files already applied"))
                    }
                    if !topic.workFolder.isEmpty && !changes.isEmpty {
                        Button(t("丟棄工作副本", "Discard copy"), role: .destructive) { confirmDiscard = true }
                            .controlSize(.small)
                    }
                }
                .disabled(busy)
                .padding(10)
                .background(agent.studioColor.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
            }
        }
    }

    // MARK: Transcript

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 18) {
                    if model.messages(for: agent).isEmpty { emptyState }
                    ForEach(model.messages(for: agent)) { message in messageRow(message).id(message.id) }
                }
                .padding(.horizontal, 25).padding(.vertical, 22)
                .frame(maxWidth: 940)
                .frame(maxWidth: .infinity)
            }
            .onChange(of: model.messages(for: agent).count) { _, _ in
                if let last = model.messages(for: agent).last?.id {
                    withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(last, anchor: .bottom) }
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            StudioAvatar(agent: agent, size: 66)
            Text(t("找 \(memberName) 聊聊吧", "Start a conversation with \(memberName)"))
                .font(.title2.bold())
            Text(t("可以附上圖片、PDF 或文字檔，也能直接把檔案拖進來。對話在本機加密保存。",
                   "Attach images, PDFs or text files, or drag them in. History is encrypted on this device."))
                .foregroundStyle(.secondary)
        }
        .padding(.top, 105)
        .frame(maxWidth: .infinity)
    }

    private func messageRow(_ message: ChatMessage) -> some View {
        HStack(alignment: .top, spacing: 12) {
            if message.role == .user { Spacer(minLength: 42) }
            if message.role == .assistant { StudioAvatar(agent: agent, size: 34, running: busy) }
            VStack(alignment: .leading, spacing: 7) {
                HStack(spacing: 8) {
                    Text(message.role == .user ? t("你", "You") : memberName)
                        .font(.caption.weight(.semibold))
                    if let used = message.modelUsed {
                        Text(used).font(.caption2.monospaced()).foregroundStyle(.secondary)
                            .padding(.horizontal, 6).padding(.vertical, 1)
                            .background(.secondary.opacity(0.12), in: Capsule())
                            .help(t("這一輪實際使用的模型", "Model actually used for this reply"))
                    }
                    Spacer()
                    Text(message.createdAt, style: .time)
                        .font(.caption2).foregroundStyle(.secondary)
                }
                if !message.attachments.isEmpty { attachmentStrip(message.attachments, removable: false) }
                if !message.body.isEmpty {
                    RichText(message.body)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(14)
            .frame(maxWidth: 660, alignment: .leading)
            .background(message.role == .user
                ? agent.studioColor.opacity(0.12) : StudioTheme.surface(scheme),
                in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14)
                .strokeBorder(StudioTheme.border(scheme).opacity(0.85)))
            if message.role == .assistant { Spacer(minLength: 42) }
        }
    }

    private func attachmentStrip(_ items: [ChatAttachment], removable: Bool) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(items) { item in
                    AttachmentChip(attachment: item, onRemove: {
                        model.removeDraftAttachment(item.id, from: agent)
                    }, removable: removable)
                }
            }
        }
    }

    // MARK: Composer

    private var composer: some View {
        VStack(spacing: 9) {
            deskStrip
            if !pendingAttachments.isEmpty { attachmentStrip(pendingAttachments, removable: true) }
            TextEditor(text: draft)
                .font(.body)
                .frame(minHeight: 72, maxHeight: 130)
                .scrollContentBackground(.hidden)
                .padding(8)
                .background(StudioTheme.surface(scheme), in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12)
                    .strokeBorder(dropTargeted ? agent.studioColor : StudioTheme.border(scheme), lineWidth: dropTargeted ? 2 : 1))
            HStack(spacing: 10) {
                Button { importing = true } label: { Image(systemName: "plus.circle") }
                    .buttonStyle(.borderless).disabled(busy)
                    .help(t("附上圖片、PDF 或文字檔", "Attach images, PDFs or text files"))
                modelPickers
                Spacer()
                Image(systemName: "lock.shield").foregroundStyle(.secondary)
                Text((topic?.workFolder.isEmpty ?? true ? t("個人資料夾", "Personal folder") : t("任務副本", "Task copy"))
                     + (topic?.sessionID != nil ? t(" · 延續 CLI 對話", " · Continuing CLI session") : "")
                     + t(" · 不自動重送", " · No auto-retry"))
                    .font(.caption).foregroundStyle(.secondary)
                if busy {
                    Button(t("停止", "Stop"), role: .destructive) { model.stop(agent: agent) }
                }
                Button { model.submit(to: agent) } label: {
                    Label(t("傳送", "Send"), systemImage: "arrow.up")
                }
                .keyboardShortcut(.return, modifiers: .command)
                .buttonStyle(.borderedProminent)
                .disabled(!canSend)
            }
        }
        .padding(.horizontal, 23).padding(.vertical, 15)
        .background(StudioTheme.secondary(scheme))
        .dropDestination(for: URL.self) { urls, _ in
            let files = urls.filter(\.isFileURL)
            guard !files.isEmpty, !busy else { return false }
            model.addAttachments(files, to: agent)
            return true
        } isTargeted: { dropTargeted = $0 }
    }

    private var modelPickers: some View {
        let choices = model.modelChoices(for: agent)
        let current = topic?.model ?? ""
        // An empty choice inherits the member card's default, then the CLI's.
        let card = model.card(agent)
        let inherited = card?.defaultModel ?? ""
        let effective = current.isEmpty ? inherited : current
        // Efforts follow the chosen model (or the CLI default); some models report none.
        let selected = effective.isEmpty ? choices.first(where: \.isDefault) : choices.first(where: { $0.id == effective })
        let efforts = selected?.efforts ?? (agent == .claude ? ModelCatalog.claudeEfforts : [])
        let inheritedEffort = current.isEmpty ? card?.defaultEffort ?? "" : ""
        return HStack(spacing: 6) {
            Picker(t("模型", "Model"), selection: Binding(get: { current },
                                                          set: { model.setTopicModel(agent, model: $0) })) {
                if inherited.isEmpty {
                    Text(t("預設模型", "Default model")
                         + (choices.first(where: \.isDefault).map { "（\($0.title)）" } ?? "")).tag("")
                } else {
                    Text(t("成員預設", "Member default") + "（\(choices.first(where: { $0.id == inherited })?.title ?? inherited)）").tag("")
                }
                ForEach(choices) { choice in Text(choice.title).tag(choice.id) }
                if !current.isEmpty && !choices.contains(where: { $0.id == current }) { Text(current).tag(current) }
            }
            .labelsHidden().frame(width: 190)
            Button { model.refreshModelCatalogs([agent]) } label: {
                if model.modelCatalogLoading.contains(agent) { ProgressView().controlSize(.mini) }
                else { Image(systemName: "arrow.clockwise") }
            }
            .buttonStyle(.borderless)
            .help(t("重新向官方 CLI 讀取模型清單（CLI 更新後會出現新模型）", "Reload the model list from the official CLI (new models appear after a CLI update)"))
            Picker(t("思考程度", "Effort"), selection: Binding(get: { topic?.effort ?? "" },
                                                            set: { model.setTopicEffort(agent, effort: $0) })) {
                Text(inheritedEffort.isEmpty ? t("預設思考", "Default effort") : t("成員預設", "Member default") + "（\(inheritedEffort)）").tag("")
                ForEach(efforts, id: \.self) { Text($0).tag($0) }
            }
            .labelsHidden().frame(width: 115)
            .disabled(efforts.isEmpty)
        }
        .disabled(busy)
        .help(t("只套用在這個話題", "Applies to this topic only"))
    }
}

/// Attachment pill; images show a thumbnail decrypted on demand.
private struct AttachmentChip: View {
    @EnvironmentObject private var model: WorkbenchModel
    let attachment: ChatAttachment
    let onRemove: () -> Void
    let removable: Bool
    @State private var thumbnail: NSImage?

    init(attachment: ChatAttachment, onRemove: @escaping () -> Void, removable: Bool) {
        self.attachment = attachment; self.onRemove = onRemove; self.removable = removable
    }

    var body: some View {
        HStack(spacing: 6) {
            if let thumbnail {
                Image(nsImage: thumbnail).resizable().scaledToFill()
                    .frame(width: 34, height: 34).clipShape(RoundedRectangle(cornerRadius: 6))
            } else {
                Image(systemName: attachment.kind == .pdf ? "doc.richtext" : attachment.kind == .text ? "doc.text" : "photo")
                    .frame(width: 22)
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(attachment.fileName).font(.caption).lineLimit(1)
                Text(ByteCountFormatter.string(fromByteCount: Int64(attachment.byteCount), countStyle: .file))
                    .font(.caption2).foregroundStyle(.secondary)
            }
            if removable {
                Button(action: onRemove) { Image(systemName: "xmark.circle.fill") }
                    .buttonStyle(.borderless).foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 5)
        .frame(maxWidth: 220, alignment: .leading)
        .background(.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 9))
        .task(id: attachment.id) {
            guard attachment.kind == .image, thumbnail == nil, let data = model.attachmentData(attachment.id) else { return }
            thumbnail = NSImage(data: data)
        }
    }
}
