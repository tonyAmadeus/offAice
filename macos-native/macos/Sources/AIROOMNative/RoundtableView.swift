import SwiftUI
import UniformTypeIdentifiers
import AIROOMCore

/// 圓桌: topics on the left; the selected topic's stage on the right.
struct RoundtableView: View {
    @EnvironmentObject private var model: WorkbenchModel
    @Environment(\.colorScheme) private var scheme
    @State private var composing = false
    @State private var confirmDelete: UUID?
    private var lang: InterfaceLanguage { model.archive.settings.language }
    private func t(_ zh: String, _ en: String) -> String { StudioI18n.t(zh, en, lang) }

    private var selected: RoundtableTopic? {
        model.archive.roundtableTopics.first { $0.id == model.selectedRoundtableID } ?? model.archive.roundtableTopics.first
    }

    var body: some View {
        HStack(spacing: 0) {
            topicList.frame(width: 250)
            Divider()
            Group {
                if let topic = selected { RoundtableTopicView(topic: topic) }
                else {
                    StudioEmptyState(icon: "person.3", title: t("還沒有議題", "No topics yet"),
                                     detail: t("開一個新議題：評審、比稿或方案比較。", "Open a topic: review, candidates or proposals."))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .sheet(isPresented: $composing) { NewRoundtableSheet().environmentObject(model) }
        .confirmationDialog(t("刪除這個議題和它的審議紀錄？", "Delete this topic and its deliberation?"),
                            isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } })) {
            Button(t("刪除議題", "Delete topic"), role: .destructive) { if let id = confirmDelete { model.deleteRoundtable(id) } }
        }
    }

    private var topicList: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(t("圓桌", "Roundtable")).font(.title3.bold())
                Spacer()
                Button { composing = true } label: { Label(t("開新議題", "New topic"), systemImage: "plus") }
                    .disabled(model.roundtableRunning)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(model.archive.roundtableTopics) { topic in
                        Button { model.selectedRoundtableID = topic.id } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(topic.title).font(.subheadline.weight(.semibold)).lineLimit(1)
                                HStack(spacing: 6) {
                                    Text(topic.kind.title).font(.caption2)
                                    Text("·").font(.caption2)
                                    Text(statusTitle(topic.status)).font(.caption2)
                                }.foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(8)
                            .background(topic.id == selected?.id ? StudioTheme.amber.opacity(0.14) : .clear,
                                        in: RoundedRectangle(cornerRadius: 8))
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .contextMenu {
                            Button(t("刪除議題", "Delete topic"), role: .destructive) { confirmDelete = topic.id }
                        }
                    }
                    if !model.archive.roundtables.isEmpty { legacy }
                }
            }
        }
        .padding(14)
        .background(StudioTheme.surface(scheme).opacity(0.6))
    }

    private var legacy: some View {
        DisclosureGroup(t("舊版圓桌紀錄", "Older roundtables")) {
            ForEach(model.archive.roundtables.prefix(20)) { old in
                VStack(alignment: .leading, spacing: 4) {
                    Text(old.question).font(.caption.weight(.semibold)).lineLimit(2)
                    ForEach(old.results) { result in
                        Text("\(result.agent.shortName)：\(result.text)").font(.caption2).foregroundStyle(.secondary).lineLimit(3)
                    }
                }
                .padding(.vertical, 4)
                .textSelection(.enabled)
            }
        }
        .font(.caption).padding(.top, 10)
    }

    private func statusTitle(_ status: RoundtableStatus) -> String {
        switch status {
        case .preparing: return t("各自準備中", "Preparing")
        case .prepared: return t("待公開", "Ready to reveal")
        case .reviewing: return t("互評與整理問題", "Reviewing")
        case .discussing: return t("審議中", "Deliberating")
        case .conclusion: return t("等你確認結論", "Confirm conclusion")
        case .confirmed: return t("已確認", "Confirmed")
        }
    }
}

// MARK: One topic

struct RoundtableTopicView: View {
    @EnvironmentObject private var model: WorkbenchModel
    @Environment(\.colorScheme) private var scheme
    let topic: RoundtableTopic
    @State private var draft = ""
    @State private var comparing = false
    @State private var handoffProject: UUID?
    private var lang: InterfaceLanguage { model.archive.settings.language }
    private func t(_ zh: String, _ en: String) -> String { StudioI18n.t(zh, en, lang) }
    private var room: TeamRoom? { topic.roomID.flatMap { id in model.archive.rooms.first { $0.id == id } } }
    private var revealed: Bool { ![.preparing, .prepared].contains(topic.status) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                progress
                StudioPanel {
                    DisclosureGroup(t("材料／要求", "Material")) {
                        Text(topic.material).font(.callout).textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 6)
                        if !topic.attachments.isEmpty {
                            Text(t("附件：", "Attachments: ") + topic.attachments.map(\.fileName).joined(separator: "、"))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                stage
            }
            .padding(22)
            .frame(maxWidth: 980, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .sheet(isPresented: $comparing) { CompareSheet(topic: topic).environmentObject(model) }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("ROUNDTABLE · \(topic.kind.title)").font(.caption.weight(.bold)).tracking(1.4).foregroundStyle(StudioTheme.warning)
            Text(topic.title).font(.title2.bold())
            HStack(spacing: 6) {
                ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                    Text(step.0).font(.caption)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(step.1 ? StudioTheme.amber.opacity(0.25) : .secondary.opacity(0.1), in: Capsule())
                    if index < steps.count - 1 { Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.secondary) }
                }
            }
        }
    }

    private var steps: [(String, Bool)] {
        let order: [RoundtableStatus] = [.preparing, .prepared, .reviewing, .discussing, .conclusion, .confirmed]
        let at = order.firstIndex(of: topic.status) ?? 0
        return [(t("各自準備", "Prepare"), at >= 0), (t("公開", "Reveal"), at >= 2), (t("審議", "Deliberate"), at >= 3),
                (t("結論", "Conclude"), at >= 4), (t("確認", "Confirm"), at >= 5)]
    }

    private var progress: some View {
        HStack(spacing: 14) {
            ForEach(topic.members, id: \.self) { agent in
                HStack(spacing: 5) {
                    StudioAvatar(agent: agent, size: 22, running: model.roundtableRunning)
                    if let submission = topic.submission(agent) {
                        Image(systemName: submission.succeeded ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                            .foregroundStyle(submission.succeeded ? .green : .orange)
                    } else {
                        Image(systemName: "circle.dotted").foregroundStyle(.secondary)
                    }
                    if agent == topic.lead {
                        Text(t("匯總", "Lead")).font(.caption2).padding(.horizontal, 5)
                            .background(.secondary.opacity(0.15), in: Capsule())
                    }
                }
            }
            Spacer()
            Text(t("已交 \(topic.completed)/\(topic.members.count) · 問題 \(topic.findingCount) 個 · 呼叫 \(topic.calls) 次",
                   "\(topic.completed)/\(topic.members.count) in · \(topic.findingCount) issues · \(topic.calls) calls"))
                .font(.caption).foregroundStyle(.secondary)
            if model.roundtableRunning {
                ProgressView().controlSize(.small)
                Button(t("停止", "Stop"), role: .destructive) { model.stopRoundtable() }
            }
        }
    }

    @ViewBuilder private var stage: some View {
        switch topic.status {
        case .preparing:
            StudioNotice(icon: "eye.slash", message: model.roundtableRunning
                ? t("成員正在各自準備，公開前互相看不到。", "Members are preparing independently; nobody sees the others yet.")
                : t("準備被中斷了，可以繼續讓還沒交的成員準備。", "Preparation stopped; continue with members who haven't submitted."))
            if !model.roundtableRunning {
                Button(t("繼續準備", "Continue preparing")) { model.prepareRoundtable(topic.id) }
            }
        case .prepared:
            StudioPanel {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(t("大家都交了", "Everyone has submitted")).font(.headline)
                        Text(topic.peerReview
                             ? t("公開後每位成員只看別人的版本互評，再由匯總成員整理問題清單。", "After reveal, each member reviews the others' versions; then the lead compiles an issue list.")
                             : t("公開後由匯總成員整理問題清單，接著開始審議。", "After reveal, the lead compiles an issue list, then deliberation starts."))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button(t("公開", "Reveal")) { model.revealRoundtable(topic.id) }
                        .buttonStyle(.borderedProminent).disabled(model.roundtableRunning || topic.completed == 0)
                }
            }
        default:
            revealedContent
        }
    }

    @ViewBuilder private var revealedContent: some View {
        StudioPanel {
            VStack(alignment: .leading, spacing: 8) {
                DisclosureGroup(t("各成員的版本", "Versions")) {
                    ForEach(topic.submissions) { submission in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                StudioAvatar(agent: submission.agent, size: 20)
                                Text(model.memberName(submission.agent)).font(.subheadline.weight(.semibold))
                                if topic.adopted == submission.agent {
                                    Label(t("已採用", "Adopted"), systemImage: "checkmark.seal.fill").font(.caption).foregroundStyle(.green)
                                }
                            }
                            RichText(submission.succeeded ? submission.text : t("沒有完成：", "Not completed: ") + (submission.error ?? ""), font: .callout)
                                .textSelection(.enabled)
                        }
                        .padding(.vertical, 6)
                    }
                }
                if !topic.peerReviews.isEmpty {
                    DisclosureGroup(t("互評", "Peer reviews")) {
                        ForEach(topic.peerReviews) { review in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(model.memberName(review.agent)).font(.subheadline.weight(.semibold))
                                RichText(review.succeeded ? review.text : (review.error ?? ""), font: .callout).textSelection(.enabled)
                            }.padding(.vertical, 6)
                        }
                    }
                }
                DisclosureGroup(t("問題清單（\(topic.findingCount) 個）", "Issue list (\(topic.findingCount))")) {
                    if let error = topic.findingsError {
                        HStack {
                            Label(t("問題清單沒有整理完成：", "Issue list failed: ") + error, systemImage: "exclamationmark.triangle")
                                .font(.callout).foregroundStyle(.orange)
                            Spacer()
                            Button(t("重新整理問題清單", "Compile again")) { model.recompileFindings(topic.id) }
                                .disabled(model.roundtableRunning || model.roomRunning)
                        }
                    } else {
                        RichText(topic.findings.isEmpty ? t("整理中……", "Compiling…") : topic.findings, font: .callout)
                            .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
        if topic.status == .reviewing {
            StudioNotice(icon: "hourglass", message: t("正在互評並整理問題清單，完成後會自動開始審議。", "Reviewing and compiling issues; deliberation starts automatically."))
        }
        if let room { deliberation(room) }
        conclusionPanel
    }

    private func deliberation(_ room: TeamRoom) -> some View {
        StudioPanel {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Label(t("審議討論", "Deliberation"), systemImage: "bubble.left.and.bubble.right").font(.headline)
                    Spacer()
                    if topic.kind.hasCandidates {
                        Button(t("下一步：比較並選擇候選", "Next: compare candidates")) { comparing = true }
                    }
                    if [.discussing].contains(topic.status) && !model.roomRunning {
                        // The lead (匯總成員) writes the minutes by default; others via the arrow.
                        Menu {
                            ForEach(topic.members, id: \.self) { agent in
                                Button(t("請 \(model.memberName(agent)) 整理", "Ask \(model.memberName(agent))")) {
                                    model.concludeRoundtable(topic.id, by: agent)
                                }
                            }
                        } label: {
                            Text(t("整理會議紀要", "Write minutes"))
                        } primaryAction: { model.concludeRoundtable(topic.id, by: topic.lead) }
                        .fixedSize()
                        .help(t("由匯總成員 \(model.memberName(topic.lead)) 整理；按箭頭可改請其他成員", "Written by the lead, \(model.memberName(topic.lead)); use the arrow to pick someone else"))
                    }
                }
                ForEach(room.entries.filter { $0.speaker != .system }) { entry in
                    HStack(alignment: .top, spacing: 8) {
                        if let agent = entry.agent { StudioAvatar(agent: agent, size: 24) }
                        else { Image(systemName: "person.crop.circle.fill").font(.title3).foregroundStyle(StudioTheme.warning) }
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(spacing: 6) {
                                Text(entry.displayName).font(.caption.weight(.semibold))
                                if entry.isMinutes { Label(t("會議紀要", "Minutes"), systemImage: "doc.text").font(.caption2).foregroundStyle(StudioTheme.amber) }
                                if entry.delivery == .inProgress { ProgressView().controlSize(.mini) }
                            }
                            RichText(entry.isReaction ? t("回應了 ", "reacted ") + entry.body : entry.body, font: .callout)
                                .textSelection(.enabled)
                        }
                    }
                }
                if room.lounge.phase == .paused && !model.roomRunning {
                    HStack {
                        Label(room.lounge.reason ?? t("審議已暫停", "Paused"), systemImage: "pause.circle")
                            .font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        Button(t("繼續", "Continue")) { model.continueLounge(in: room.id) }.controlSize(.small)
                    }
                }
                if room.lounge.phase == .awaitingHost {
                    HStack {
                        Text(t("有人舉手：", "Hands up: ")).font(.caption)
                        ForEach(topic.members.filter { (room.lounge.hands[$0.rawValue]?.want ?? 0) > 0 && !room.lounge.supplemented.contains($0) }, id: \.self) { agent in
                            Button(t("請 \(model.memberName(agent)) 補充", "Let \(model.memberName(agent)) add")) { model.pickHand(agent, in: room.id) }
                        }
                        Button(t("不用了", "No one")) { model.pickHand(nil, in: room.id) }
                    }.controlSize(.small)
                }
                if topic.status == .discussing {
                    HStack {
                        TextField(t("在審議中發言（每位成員會回答一次）", "Speak in the deliberation (each member answers once)"), text: $draft)
                            .textFieldStyle(.roundedBorder)
                            .onSubmit(send)
                        if model.roomRunning {
                            Button(t("停止", "Stop"), role: .destructive) { model.stopRoom() }
                        }
                        Button(t("送出", "Send"), action: send)
                            .disabled(model.roomRunning || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }
        }
    }

    private func send() {
        model.sendToDeliberation(topic.id, text: draft)
        draft = ""
    }

    @ViewBuilder private var conclusionPanel: some View {
        if topic.status == .conclusion || topic.status == .confirmed {
            StudioPanel {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Label(t("結論", "Conclusion"), systemImage: "checkmark.seal").font(.headline)
                        Spacer()
                        if topic.status == .conclusion {
                            Button(t("確認結論", "Confirm conclusion")) { model.confirmConclusion(topic.id) }
                                .buttonStyle(.borderedProminent)
                        } else {
                            Label(t("已確認", "Confirmed"), systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                        }
                    }
                    if let adopted = topic.adopted {
                        Text(t("採用：\(model.memberName(adopted)) 的版本", "Adopted: \(model.memberName(adopted))'s version")).font(.caption)
                    }
                    RichText(topic.conclusion, font: .callout).textSelection(.enabled)
                    if topic.status == .confirmed { handoff }
                }
            }
        }
    }

    @ViewBuilder private var handoff: some View {
        let flows = model.archive.projectFlows.filter { $0.step != .completed }
        if let projectID = topic.handoffProjectID {
            Text(t("已帶回專案：", "Handed to project: ") + (model.archive.projectFlows.first { $0.id == projectID }?.title
                 ?? model.archive.projects.first { $0.id == projectID }?.title ?? ""))
                .font(.caption).foregroundStyle(.secondary)
        } else if !flows.isEmpty {
            HStack {
                Picker(t("帶回專案", "Hand to project"), selection: $handoffProject) {
                    Text(t("選擇專案", "Choose project")).tag(UUID?.none)
                    ForEach(flows) { flow in Text(flow.title).tag(Optional(flow.id)) }
                }.frame(maxWidth: 320)
                Button(t("帶回專案", "Hand over")) { if let id = handoffProject { model.handoffTopicToFlow(topic.id, flowID: id) } }
                    .disabled(handoffProject == nil)
            }
            Text(t("結論會作為該專案下一次寫方案的材料，只用一次；不會自動寫檔或開工。", "The conclusion becomes material for that project's next plan, once; nothing runs automatically."))
                .font(.caption2).foregroundStyle(.secondary)
        }
    }
}

// MARK: Side-by-side comparison

struct CompareSheet: View {
    @EnvironmentObject private var model: WorkbenchModel
    @Environment(\.dismiss) private var dismiss
    let topic: RoundtableTopic
    private func t(_ zh: String, _ en: String) -> String { StudioI18n.t(zh, en, model.archive.settings.language) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(t("並排比較", "Compare side by side")).font(.title3.bold())
                Spacer()
                Button(t("完成", "Done")) { dismiss() }.keyboardShortcut(.defaultAction)
            }
            HStack(alignment: .top, spacing: 12) {
                ForEach(topic.submissions.filter(\.succeeded)) { submission in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            StudioAvatar(agent: submission.agent, size: 24)
                            Text(model.memberName(submission.agent)).font(.headline)
                            Spacer()
                            if model.archive.roundtableTopics.first(where: { $0.id == topic.id })?.adopted == submission.agent {
                                Label(t("已採用", "Adopted"), systemImage: "checkmark.seal.fill").foregroundStyle(.green)
                            } else {
                                Button(t("採用此候選", "Adopt this")) { model.adoptCandidate(topic.id, agent: submission.agent) }
                                    .buttonStyle(.borderedProminent)
                            }
                        }
                        ScrollView {
                            RichText(submission.text, font: .callout).textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    .padding(12)
                    .background(.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
                }
            }
        }
        .padding(20)
        .frame(minWidth: 860, minHeight: 560)
    }
}

// MARK: New topic

struct NewRoundtableSheet: View {
    @EnvironmentObject private var model: WorkbenchModel
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var kind: RoundtableKind = .proposals
    @State private var material = ""
    @State private var attachments: [ChatAttachment] = []
    @State private var members = Set(AgentKind.allCases)
    @State private var lead: AgentKind = .claude
    @State private var peerReview = true
    @State private var importing = false
    private func t(_ zh: String, _ en: String) -> String { StudioI18n.t(zh, en, model.archive.settings.language) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(t("開新議題", "New roundtable topic")).font(.title3.bold())
            Picker("", selection: $kind) {
                ForEach(RoundtableKind.allCases) { Text($0.title).tag($0) }
            }.pickerStyle(.segmented).labelsHidden()
            Text(kind.detail).font(.caption).foregroundStyle(.secondary)
            TextField(t("議題名稱（可留空，自動取材料開頭）", "Title (optional)"), text: $title).textFieldStyle(.roundedBorder)
            TextEditor(text: $material).font(.body).frame(minHeight: 160)
                .overlay(alignment: .topLeading) {
                    if material.isEmpty {
                        Text(t("寫下材料或要求……", "Material or requirements…")).foregroundStyle(.secondary).padding(6).allowsHitTesting(false)
                    }
                }
                .border(.secondary.opacity(0.3))
            HStack {
                Button { importing = true } label: { Label(t("附加檔案", "Attach files"), systemImage: "paperclip") }
                Text(attachments.map(\.fileName).joined(separator: "、")).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            HStack(spacing: 14) {
                Text(t("參加成員", "Members")).font(.subheadline)
                ForEach(AgentKind.allCases) { agent in
                    Toggle(model.memberName(agent), isOn: Binding(
                        get: { members.contains(agent) },
                        set: { if $0 { members.insert(agent) } else { members.remove(agent) } }))
                }
                Spacer()
                Picker(t("匯總成員", "Lead"), selection: $lead) {
                    ForEach(AgentKind.allCases.filter(members.contains)) { Text(model.memberName($0)).tag($0) }
                }.frame(width: 220)
            }.toggleStyle(.checkbox)
            Toggle(t("公開後互評（每人只看別人的版本並提意見）", "Peer review after reveal (each sees only the others)"), isOn: $peerReview)
                .toggleStyle(.checkbox)
            HStack {
                Text(t("成員會各自獨立準備，公開前互相看不到。每一步都會呼叫 AI。", "Members prepare independently and can't see each other until reveal. Each step calls the AI."))
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button(t("取消", "Cancel")) { dismiss() }
                Button(t("開始準備", "Start")) {
                    model.openRoundtable(title: title, kind: kind, material: material, attachments: attachments,
                                         members: Array(members), lead: lead, peerReview: peerReview)
                    dismiss()
                }
                .buttonStyle(.borderedProminent)
                .disabled(members.count < 2 || (material.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments.isEmpty))
            }
        }
        .padding(20)
        .frame(width: 680)
        .fileImporter(isPresented: $importing, allowedContentTypes: [.image, .pdf, .text, .sourceCode, .json, .data],
                      allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { attachments += model.storeRoundtableAttachments(urls) }
        }
    }
}
