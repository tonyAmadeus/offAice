import SwiftUI
import AppKit
import AIROOMCore

/// 項目會議室: projects on the left; the selected project's six steps on the right.
struct ProjectRoomView: View {
    @EnvironmentObject private var model: WorkbenchModel
    @Environment(\.colorScheme) private var scheme
    var initialProjectID: UUID? = nil
    @State private var creating = false
    @State private var showingLegacy = false
    @State private var confirmDelete: UUID?
    private func t(_ zh: String, _ en: String) -> String { StudioI18n.t(zh, en, model.archive.settings.language) }

    private var selected: ProjectFlow? {
        model.archive.projectFlows.first { $0.id == model.selectedFlowID } ?? model.archive.projectFlows.first
    }

    var body: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text(t("專案", "Projects")).font(.title3.bold())
                    Spacer()
                    Button { creating = true } label: { Label(t("新增專案", "New project"), systemImage: "plus") }
                }
                ScrollView {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(model.archive.projectFlows) { flow in
                            Button { model.selectedFlowID = flow.id } label: {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(flow.title).font(.subheadline.weight(.semibold)).lineLimit(1)
                                    Text("\(flow.step.title) · \((flow.folder as NSString).lastPathComponent)")
                                        .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                                }
                                .frame(maxWidth: .infinity, alignment: .leading).padding(8)
                                .background(flow.id == selected?.id ? StudioTheme.amber.opacity(0.14) : .clear,
                                            in: RoundedRectangle(cornerRadius: 8))
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .contextMenu { Button(t("刪除專案紀錄", "Delete project record"), role: .destructive) { confirmDelete = flow.id } }
                        }
                    }
                }
                if !model.archive.projects.isEmpty {
                    Button(t("舊版專案紀錄", "Older projects")) { showingLegacy = true }.font(.caption)
                }
            }
            .padding(14).frame(width: 250)
            .background(StudioTheme.surface(scheme).opacity(0.6))
            Divider()
            // .id: each project gets fresh view state (e.g. its own review level).
            if let flow = selected { FlowDetailView(flow: flow).id(flow.id) }
            else {
                StudioEmptyState(icon: "folder.badge.person.crop", title: t("請大家一起來", "Bring the team in"),
                                 detail: t("新增一個專案資料夾、選至少兩位成員，就能進入會議室。", "Add a project folder and at least two members to open its room."))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .onAppear { if let id = initialProjectID, model.archive.projectFlows.contains(where: { $0.id == id }) { model.selectedFlowID = id } }
        .sheet(isPresented: $creating) { NewFlowSheet().environmentObject(model) }
        .sheet(isPresented: $showingLegacy) {
            VStack(alignment: .trailing) {
                Button(t("關閉", "Close")) { showingLegacy = false }.padding(10)
                ProjectsView().environmentObject(model)
            }.frame(minWidth: 960, minHeight: 640)
        }
        .confirmationDialog(t("刪除這個專案的紀錄和副本？原始資料夾不受影響。", "Delete this project's record and copies? The original folder is untouched."),
                            isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } })) {
            Button(t("刪除", "Delete"), role: .destructive) { if let id = confirmDelete { model.deleteFlow(id) } }
        }
    }
}

// MARK: One project

struct FlowDetailView: View {
    @EnvironmentObject private var model: WorkbenchModel
    @Environment(\.colorScheme) private var scheme
    let flow: ProjectFlow
    @State private var tab = 0
    @State private var note = ""
    @State private var opinion = ""
    @State private var level: ReviewLevel = .standard
    @State private var preview: (path: String, before: String, after: String)?
    private func t(_ zh: String, _ en: String) -> String { StudioI18n.t(zh, en, model.archive.settings.language) }
    private var busy: Bool { model.flowRunning || model.roomRunning }

    var body: some View {
        VStack(spacing: 0) {
            header.padding(18)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    nextStep
                    Picker("", selection: $tab) {
                        Text(t("會議室", "Room")).tag(0)
                        Text(t("看板", "Board")).tag(1)
                        Text(t("成員匯報", "Member reports")).tag(2)
                    }.pickerStyle(.segmented).labelsHidden().frame(width: 330)
                    switch tab {
                    case 1: FlowBoard(flow: flow)
                    case 2: FlowReports(flow: flow)
                    default: FlowRoom(flow: flow)
                    }
                }.padding(18)
            }
        }
        .onAppear { level = flow.reviewLevel }
        .sheet(isPresented: Binding(get: { preview != nil }, set: { if !$0 { preview = nil } })) {
            if let preview {
                VStack(alignment: .leading) {
                    HStack { Text(preview.path).font(.headline.monospaced()); Spacer(); Button(t("關閉", "Close")) { self.preview = nil } }
                    HStack(alignment: .top) {
                        ScrollView { Text(preview.before).font(.caption.monospaced()).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                        ScrollView { Text(preview.after).font(.caption.monospaced()).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                    }
                }.padding(16).frame(minWidth: 820, minHeight: 520)
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text(flow.title).font(.title2.bold())
                    Text(flow.folder).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
                Text(t("第 \(flow.segment) 段 · 呼叫 \(flow.calls) 次", "Segment \(flow.segment) · \(flow.calls) calls"))
                    .font(.caption).foregroundStyle(.secondary)
                if flow.step == .executing {
                    if flow.paused {
                        Button(t("繼續", "Resume")) { model.resumeFlow(flow.id) }.disabled(model.flowRunning)
                    } else if model.flowRunning {
                        Button(t("暫停", "Pause")) { model.pauseFlow(flow.id) }
                            .help(t("做完正在做的任務後，不再派新任務", "Finish the current task, then stop dispatching"))
                    }
                }
                if model.flowRunning { Button(t("中止", "Stop"), role: .destructive) { model.stopFlow() } }
            }
            HStack(spacing: 6) {
                ForEach(Array(FlowStep.allCases.enumerated()), id: \.offset) { index, step in
                    let reached = FlowStep.allCases.firstIndex(of: flow.step)! >= index
                    Text("\(index + 1) \(step.title)").font(.caption)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(step == flow.step ? StudioTheme.amber.opacity(0.35)
                                    : reached ? StudioTheme.amber.opacity(0.14) : .secondary.opacity(0.1), in: Capsule())
                    if index < FlowStep.allCases.count - 1 { Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.secondary) }
                }
            }
            if let activity = model.flowActivity, model.flowRunning {
                HStack(spacing: 6) { ProgressView().controlSize(.small); Text(activity).font(.caption) }
            }
        }
    }

    // MARK: 下一步

    @ViewBuilder private var nextStep: some View {
        StudioPanel {
            VStack(alignment: .leading, spacing: 10) {
                switch flow.step {
                case .discussion, .leader:
                    Text(t("下一步：說清楚要做什麼，然後選負責人起草方案", "Next: explain the work, then choose a lead to draft the plan")).font(.headline)
                    Text(t("在下方會議室聊需求；成員可以只讀查看專案檔案核實現狀，不會改檔案。", "Discuss below; members may read the project files but never change them."))
                        .font(.caption).foregroundStyle(.secondary)
                    HStack {
                        ForEach(flow.members, id: \.self) { agent in
                            Button(t("請 \(model.memberName(agent)) 當負責人，起草方案", "Ask \(model.memberName(agent)) to lead")) {
                                model.chooseFlowLead(flow.id, agent: agent)
                            }.disabled(busy)
                        }
                    }
                case .plan:
                    planCard
                case .executing:
                    executingCard
                case .acceptance:
                    acceptanceCard
                case .completed:
                    Text(t("整段工作總結", "Work summary")).font(.headline)
                    RichText(flow.completionReport, font: .callout).textSelection(.enabled)
                    Button(t("開始新的一段工作", "Start a new segment of work")) { model.startNewSegment(flow.id) }.disabled(busy)
                }
            }
        }
    }

    @ViewBuilder private var planCard: some View {
        if let plan = flow.plan {
            Text(t("方案（第 \(plan.version) 版，負責人：\(flow.lead.map(model.memberName) ?? "")）", "Plan v\(plan.version)")).font(.headline)
            RichText("**目標**：\(plan.objective)\n**範圍**：\(plan.scope)", font: .callout)
            if !plan.deliverables.isEmpty { Text(t("交付：", "Deliverables: ") + plan.deliverables.joined(separator: "；")).font(.callout) }
            if !plan.acceptance.isEmpty { Text(t("怎樣算完成：", "Done when: ") + plan.acceptance.joined(separator: "；")).font(.callout) }
            ForEach(plan.rounds) { round in
                VStack(alignment: .leading, spacing: 3) {
                    Text("\(round.title)：\(round.goal)").font(.subheadline.weight(.semibold))
                    ForEach(plan.tasks(in: round)) { task in
                        HStack(spacing: 6) {
                            StudioAvatar(agent: task.member, size: 18)
                            Text(task.title).font(.caption.weight(.semibold))
                            Text(task.goal).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                            if !task.files.isEmpty {
                                Text(task.files.joined(separator: "、")).font(.caption2.monospaced()).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                    }
                }.padding(.vertical, 3)
            }
            Divider()
            Picker(t("複核程度", "Review level"), selection: $level) {
                ForEach(ReviewLevel.allCases) { Text($0.title).tag($0) }
            }.pickerStyle(.segmented).frame(maxWidth: 420)
            Text(level.detail).font(.caption).foregroundStyle(.secondary)
            parallelControl
            HStack {
                TextField(t("給第一輪的附言（可留空）", "Note for the first round (optional)"), text: $note).textFieldStyle(.roundedBorder)
                Button(t("確認方案，開工", "Confirm plan and start")) { model.confirmPlan(flow.id, reviewLevel: level, note: note); note = "" }
                    .buttonStyle(.borderedProminent).disabled(busy)
            }
            HStack {
                TextField(t("要改一下：寫下要負責人改什麼", "Request changes to the plan"), text: $opinion).textFieldStyle(.roundedBorder)
                Button(t("要改一下", "Request changes")) { model.requestPlanChange(flow.id, note: opinion); opinion = "" }
                    .disabled(busy || opinion.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
    }

    @ViewBuilder private var executingCard: some View {
        if let round = flow.activeRound {
            let tasks = flow.plan?.tasks(in: round) ?? []
            Text(t("第 \(flow.currentRound + 1) 輪：\(round.title)", "Round \(flow.currentRound + 1): \(round.title)")).font(.headline)
            Text(round.goal).font(.callout).foregroundStyle(.secondary)
            if round.status == .pending && !model.flowRunning {
                Text(t("下一步：開始這一輪前，確認按原計劃開始還是要求修改方案。附言會交給這一輪的成員，並在檢查時核對。",
                       "Next: start as planned or request plan changes. A note goes to this round's members."))
                    .font(.caption)
                HStack {
                    TextField(t("附言（可留空）", "Note (optional)"), text: $note).textFieldStyle(.roundedBorder)
                    Button(t("按原計劃開始", "Start as planned")) { model.startRound(flow.id, note: note); note = "" }
                        .buttonStyle(.borderedProminent).disabled(busy)
                    Button(t("要求修改方案", "Request plan changes")) { model.requestPlanChange(flow.id, note: note); note = "" }
                        .disabled(busy || note.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            } else {
                HStack {
                    Text(t("已完成 \(tasks.filter { $0.status == .done }.count)/\(tasks.count) 項任務", "\(tasks.filter { $0.status == .done }.count)/\(tasks.count) tasks done"))
                        .font(.caption)
                    Spacer()
                    parallelControl
                }
                ForEach(flow.quotaWaits) { wait in FlowQuotaBanner(flow: flow, wait: wait) }
                ForEach(tasks.filter { $0.status == .disputed }) { task in DisputeRulingCard(flow: flow, task: task) }
                if let failed = tasks.first(where: { $0.status == .failed }) {
                    Label(t("「\(failed.title)」沒有完成：\(failed.error ?? "")", "\(failed.title) failed: \(failed.error ?? "")"), systemImage: "exclamationmark.triangle")
                        .font(.caption).foregroundStyle(.orange)
                    Button(t("繼續（重新派這一輪未完成的任務）", "Continue (re-dispatch unfinished tasks)")) { model.resumeFlow(flow.id) }
                        .disabled(model.flowRunning)
                } else if flow.paused && !model.flowRunning {
                    Text(t("已暫停。按「繼續」接著派任務。", "Paused. Press Resume to continue.")).font(.caption)
                }
            }
        }
    }

    /// 同時進行的任務: how many tasks may run side by side.
    private var parallelControl: some View {
        HStack(spacing: 8) {
            Text(t("同時進行的任務", "Tasks at once")).font(.caption)
            Picker("", selection: Binding(get: { flow.maxParallel }, set: { model.setFlowParallel(flow.id, $0) })) {
                ForEach(1...3, id: \.self) { Text("\($0)").tag($0) }
            }.pickerStyle(.segmented).labelsHidden().frame(width: 110)
        }
        .help(t("只有不同成員、彼此不依賴、預計修改的檔案不重疊的任務才會同時做；沒寫檔案的任務單獨做。",
                "Only tasks by different members, without dependencies between them and with separate files, run at once."))
    }

    @ViewBuilder private var acceptanceCard: some View {
        if let round = flow.activeRound {
            Text(t("下一步：查看第 \(flow.currentRound + 1) 輪成品並驗收", "Next: review round \(flow.currentRound + 1) and accept")).font(.headline)
            RichText(round.report, font: .callout).textSelection(.enabled)
            let changes = model.flowRoundChanges(flow.id)
            Text(t("改動的檔案（點一下看前後對比）：", "Changed files (click to compare):")).font(.caption.weight(.semibold))
            ForEach(changes) { change in
                Button {
                    if let result = model.flowPreview(flow.id, path: change.path) { preview = (change.path, result.before, result.after) }
                } label: {
                    Label(change.path, systemImage: change.kind == .added ? "plus.circle" : change.kind == .deleted ? "minus.circle" : "pencil.circle")
                        .font(.caption.monospaced())
                }.buttonStyle(.link)
            }
            if changes.isEmpty { Text(t("這一輪沒有檔案改動。", "No file changes this round.")).font(.caption).foregroundStyle(.secondary) }
            Text(t("通過後才會寫進你的專案資料夾；寫入前會檢查衝突。", "Only a pass writes into your project folder, after a conflict check."))
                .font(.caption2).foregroundStyle(.secondary)
            HStack {
                Button(t("通過", "Accept")) { model.acceptRound(flow.id) }.buttonStyle(.borderedProminent).disabled(busy)
                TextField(t("駁回意見：哪裡要改", "What needs to change"), text: $opinion).textFieldStyle(.roundedBorder)
                Button(t("駁回", "Return")) { model.returnRound(flow.id, opinion: opinion); opinion = "" }
                    .disabled(busy || opinion.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
    }
}

// MARK: 異議裁定 and 額度等待

/// The author disputed review findings; the owner rules on each one.
struct DisputeRulingCard: View {
    @EnvironmentObject private var model: WorkbenchModel
    let flow: ProjectFlow
    let task: FlowTask
    @State private var verdicts: [String: FlowVerdict] = [:]
    private func t(_ zh: String, _ en: String) -> String { StudioI18n.t(zh, en, model.archive.settings.language) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(t("「\(task.title)」：\(model.memberName(task.member)) 對複核意見有異議，等你裁定",
                    "\(task.title): \(model.memberName(task.member)) disputes the review"), systemImage: "scale.3d")
                .font(.subheadline.weight(.semibold))
            Text(t("支持作者：這條不用改，並返還一次退回次數（每項任務最多 \(ProjectFlowEngine.maxWaivers) 次，已用 \(task.waivers) 次）。維持複核：作者必須修正，不能再提異議。",
                   "Side with the author: no change needed, one return refunded (at most \(ProjectFlowEngine.maxWaivers) per task). Uphold: the author must fix it."))
                .font(.caption).foregroundStyle(.secondary)
            ForEach(task.disputes, id: \.findingID) { dispute in
                if let finding = task.openFindings.first(where: { $0.id == dispute.findingID }) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("\(task.reviewer.map(model.memberName) ?? t("複核者", "Reviewer"))：\(finding.location.isEmpty ? "" : finding.location + "：")\(finding.request)")
                            .font(.callout)
                        Text(t("作者異議：", "Author: ") + dispute.reason).font(.callout).foregroundStyle(.secondary)
                        Picker("", selection: Binding(get: { verdicts[dispute.findingID] }, set: { verdicts[dispute.findingID] = $0 })) {
                            Text(t("支持作者", "Author")).tag(Optional(FlowVerdict.author))
                            Text(t("維持複核", "Review")).tag(Optional(FlowVerdict.review))
                        }.pickerStyle(.segmented).labelsHidden().frame(width: 220)
                    }
                    .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                    .background(.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
                }
            }
            if !task.summary.isEmpty {
                DisclosureGroup(t("作者這次的說明", "Author's report")) {
                    RichText(task.summary, font: .callout).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                }.font(.caption)
            }
            HStack {
                Button(t("支持全部異議", "Side with the author on all")) { rule(.author) }
                Button(t("維持全部複核意見", "Uphold all")) { rule(.review) }
                Spacer()
                Button(t("提交逐條裁定", "Submit rulings")) { model.ruleDisputes(flow.id, taskID: task.id, verdicts: verdicts) }
                    .buttonStyle(.borderedProminent)
                    .disabled(task.disputes.contains { verdicts[$0.findingID] == nil })
            }
        }
        .padding(10)
        .background(StudioTheme.amber.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
    }

    private func rule(_ verdict: FlowVerdict) {
        model.ruleDisputes(flow.id, taskID: task.id, verdicts: Dictionary(uniqueKeysWithValues: task.disputes.map { ($0.findingID, verdict) }))
    }
}

/// A member ran out of quota; their work waits until the owner continues or hands it over.
struct FlowQuotaBanner: View {
    @EnvironmentObject private var model: WorkbenchModel
    let flow: ProjectFlow
    let wait: FlowQuotaWait
    private func t(_ zh: String, _ en: String) -> String { StudioI18n.t(zh, en, model.archive.settings.language) }
    private var hasWorkToHand: Bool {
        guard let round = flow.activeRound, let plan = flow.plan else { return false }
        return plan.tasks.contains { $0.roundKey == round.key && $0.member == wait.agent && [.pending, .failed, .fixing].contains($0.status) }
    }

    var body: some View {
        let name = model.memberName(wait.agent)
        VStack(alignment: .leading, spacing: 6) {
            Label(wait.ready ? t("\(name) 的額度應該恢復了", "\(name)'s quota should be back") : t("\(name) 的額度用完了", "\(name) is out of quota"),
                  systemImage: wait.ready ? "checkmark.circle" : "hourglass")
                .font(.subheadline.weight(.semibold))
            Text(t("停在：\(wait.stage)。", "Stopped at: \(wait.stage). ")
                 + (wait.resetAt.map { t("預計 \($0.formatted(date: .abbreviated, time: .shortened)) 恢復，到時會通知你。",
                                          "Expected back \($0.formatted(date: .abbreviated, time: .shortened)); you'll be notified.") }
                    ?? t("官方還沒給恢復時間，可以重新查詢額度。", "No reset time yet; you can check the quota again.")))
                .font(.caption)
            if !wait.message.isEmpty { Text(wait.message).font(.caption2).foregroundStyle(.secondary).lineLimit(2) }
            Text(t("不會自動重送。其他成員的任務照常進行。", "Nothing is re-sent by itself. Other members keep working."))
                .font(.caption2).foregroundStyle(.secondary)
            HStack {
                Button(t("接著做", "Continue")) { model.resumeFlow(flow.id) }
                    .buttonStyle(.borderedProminent).disabled(model.flowRunning)
                ForEach(flow.members.filter { $0 != wait.agent }, id: \.self) { other in
                    Button(t("交給 \(model.memberName(other)) 接手", "Hand to \(model.memberName(other))")) {
                        model.handOverQuotaWork(flow.id, from: wait.agent, to: other)
                    }
                    .disabled(!hasWorkToHand)
                }
                Button(t("重新查詢額度", "Check quota")) { model.refreshQuota(for: wait.agent) }
                    .disabled(model.quotaRefreshing.contains(wait.agent))
            }
        }
        .padding(10)
        .background(Color.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
    }
}

// MARK: 會議室

struct FlowRoom: View {
    @EnvironmentObject private var model: WorkbenchModel
    let flow: ProjectFlow
    @State private var draft = ""
    @State private var purpose = 0
    private func t(_ zh: String, _ en: String) -> String { StudioI18n.t(zh, en, model.archive.settings.language) }
    private var room: TeamRoom? { flow.roomID.flatMap { id in model.archive.rooms.first { $0.id == id } } }
    private var mentioned: AgentKind? {
        LoungeEngine.mentions(in: draft, members: model.archive.members.filter { flow.members.contains($0.agent) }).first
    }
    private var working: Bool { flow.step == .executing || flow.step == .acceptance }

    var body: some View {
        StudioPanel {
            VStack(alignment: .leading, spacing: 10) {
                ForEach((room?.entries ?? []).filter { $0.speaker != .system }) { entry in
                    HStack(alignment: .top, spacing: 8) {
                        if let agent = entry.agent { StudioAvatar(agent: agent, size: 24) }
                        else { Image(systemName: "person.crop.circle.fill").font(.title3).foregroundStyle(StudioTheme.warning) }
                        VStack(alignment: .leading, spacing: 3) {
                            HStack {
                                Text(entry.displayName).font(.caption.weight(.semibold))
                                if entry.delivery == .inProgress { ProgressView().controlSize(.mini) }
                            }
                            RichText(entry.body, font: .callout).textSelection(.enabled)
                        }
                    }
                }
                if room?.entries.isEmpty ?? true {
                    Text(t("在這裡說清楚要做什麼、有什麼要求。每位成員會依序回答一次，然後等你。", "Explain the work here. Each member answers once, then waits."))
                        .font(.caption).foregroundStyle(.secondary)
                }
                if working, let member = mentioned {
                    Picker(t("點名用途", "Purpose"), selection: $purpose) {
                        Text(t("只是問問", "Just ask")).tag(0)
                        Text(t("安排新任務", "New task")).tag(1)
                        Text(t("補充到他目前的任務", "Add to current task")).tag(2)
                    }.pickerStyle(.segmented).frame(maxWidth: 460)
                    Text(purpose == 0 ? t("\(model.memberName(member)) 只回答，不改任務。", "Answers only.")
                         : purpose == 1 ? t("追加一項任務到本輪，交給 \(model.memberName(member))。", "Adds a task to this round.")
                         : t("把補充要求送到 \(model.memberName(member)) 正在做的任務。", "Sends the extra requirement to their current task."))
                        .font(.caption2).foregroundStyle(.secondary)
                }
                HStack {
                    TextField(t("在會議室發言（用 @名字 點名）", "Speak in the room (@name to address)"), text: $draft)
                        .textFieldStyle(.roundedBorder).onSubmit(send)
                    if model.roomRunning { Button(t("停止", "Stop"), role: .destructive) { model.stopRoom() } }
                    Button(t("送出", "Send"), action: send)
                        .disabled(model.roomRunning || model.flowRunning && purpose == 0 || draft.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        if working, let member = mentioned, purpose != 0 {
            let body = text.replacingOccurrences(of: "@\(model.memberName(member))", with: "").trimmingCharacters(in: .whitespaces)
            if purpose == 1 { model.addFlowTask(flow.id, member: member, goal: body) }
            else { model.supplementFlowTask(flow.id, member: member, text: body) }
        } else {
            model.sayInProject(flow.id, text: text)
        }
        draft = ""
        purpose = 0
    }
}

// MARK: 看板

struct FlowBoard: View {
    @EnvironmentObject private var model: WorkbenchModel
    let flow: ProjectFlow
    private func t(_ zh: String, _ en: String) -> String { StudioI18n.t(zh, en, model.archive.settings.language) }

    var body: some View {
        let tasks = flow.plan?.tasks ?? []
        HStack(alignment: .top, spacing: 12) {
            ForEach(0..<3) { column in
                VStack(alignment: .leading, spacing: 8) {
                    Text([t("待開始", "To do"), t("進行中", "In progress"), t("已完成", "Done")][column]).font(.headline)
                    ForEach(tasks.filter { $0.status.column == column }) { task in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(spacing: 6) {
                                StudioAvatar(agent: task.member, size: 18)
                                Text(task.title).font(.caption.weight(.semibold)).lineLimit(2)
                            }
                            Text(statusTitle(task)).font(.caption2).foregroundStyle(task.status == .failed ? .orange : .secondary)
                            if !task.files.isEmpty {
                                Text(task.files.joined(separator: "、")).font(.caption2.monospaced()).foregroundStyle(.secondary).lineLimit(1)
                            }
                            if !task.findings.isEmpty { Text(task.findings).font(.caption2).foregroundStyle(.secondary).lineLimit(3) }
                            if task.waivers > 0 {
                                Text(t("異議返還已用 \(task.waivers)/\(ProjectFlowEngine.maxWaivers) 次", "Dispute refunds \(task.waivers)/\(ProjectFlowEngine.maxWaivers)"))
                                    .font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                        .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                        .background(.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
                    }
                }.frame(maxWidth: .infinity, alignment: .topLeading)
            }
        }
    }

    private func statusTitle(_ task: FlowTask) -> String {
        switch task.status {
        case .pending: return t("待開始", "To do")
        case .running: return t("執行中", "Running")
        case .reviewing: return t("複核中", "Reviewing") + (task.reviewer.map { "（\(model.memberName($0))）" } ?? "")
        case .fixing: return t("依複核修正（第 \(task.returns) 次退回）", "Fixing (return \(task.returns))")
        case .done: return t("完成", "Done") + (task.changes.isEmpty ? "" : t(" · 改了 \(task.changes.count) 個檔案", " · \(task.changes.count) files"))
        case .failed: return t("沒有完成：", "Failed: ") + (task.error ?? "")
        case .disputed: return t("對複核有異議，等你裁定", "Disputed, waiting for your ruling")
        }
    }
}

// MARK: 成員匯報

struct FlowReports: View {
    @EnvironmentObject private var model: WorkbenchModel
    let flow: ProjectFlow
    @State private var questions: [AgentKind: String] = [:]
    @State private var answers: [AgentKind: String] = [:]
    private func t(_ zh: String, _ en: String) -> String { StudioI18n.t(zh, en, model.archive.settings.language) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(flow.members, id: \.self) { agent in
                StudioPanel {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack { StudioAvatar(agent: agent, size: 26); Text(model.memberName(agent)).font(.headline) }
                        let mine = (flow.plan?.tasks ?? []).filter { $0.member == agent }
                        if mine.isEmpty { Text(t("還沒有分到任務。", "No tasks yet.")).font(.caption).foregroundStyle(.secondary) }
                        ForEach(mine) { task in
                            DisclosureGroup("\(task.title) · \(task.status.rawValue)") {
                                RichText(task.summary.isEmpty ? t("（還沒有匯報）", "(no report yet)") : task.summary, font: .callout)
                                    .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                            }.font(.caption)
                        }
                        HStack {
                            TextField(t("問 TA 做了什麼（只讀回答，不改檔案）", "Ask about their work (read-only)"),
                                      text: Binding(get: { questions[agent] ?? "" }, set: { questions[agent] = $0 }))
                                .textFieldStyle(.roundedBorder)
                            Button(t("提問", "Ask")) {
                                let question = questions[agent] ?? ""
                                questions[agent] = ""
                                model.askFlowMember(flow.id, member: agent, question: question) { answers[agent] = $0 }
                            }.disabled(model.flowRunning || (questions[agent] ?? "").trimmingCharacters(in: .whitespaces).isEmpty)
                        }
                        if let answer = answers[agent] { RichText(answer, font: .callout).textSelection(.enabled) }
                    }
                }
            }
        }
    }
}

// MARK: New project

struct NewFlowSheet: View {
    @EnvironmentObject private var model: WorkbenchModel
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var folder = ""
    @State private var members = Set(AgentKind.allCases)
    @State private var level: ReviewLevel = .standard
    private func t(_ zh: String, _ en: String) -> String { StudioI18n.t(zh, en, model.archive.settings.language) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(t("請大家一起來：新增專案", "New project")).font(.title3.bold())
            HStack {
                TextField(t("專案資料夾", "Project folder"), text: $folder).textFieldStyle(.roundedBorder)
                Button(t("選取…", "Choose…")) {
                    let picker = NSOpenPanel()
                    picker.canChooseFiles = false; picker.canChooseDirectories = true; picker.allowsMultipleSelection = false
                    if picker.runModal() == .OK, let url = picker.url { folder = url.path }
                }
            }
            TextField(t("專案名稱（可留空，用資料夾名稱）", "Name (optional)"), text: $title).textFieldStyle(.roundedBorder)
            HStack(spacing: 14) {
                Text(t("參加成員（至少兩位）", "Members (at least two)"))
                ForEach(AgentKind.allCases) { agent in
                    Toggle(model.memberName(agent), isOn: Binding(get: { members.contains(agent) },
                        set: { if $0 { members.insert(agent) } else { members.remove(agent) } }))
                }
            }.toggleStyle(.checkbox)
            Picker(t("複核程度", "Review level"), selection: $level) {
                ForEach(ReviewLevel.allCases) { Text($0.title).tag($0) }
            }.pickerStyle(.segmented)
            Text(level.detail).font(.caption).foregroundStyle(.secondary)
            Text(t("成員可以只讀查看這個資料夾；所有修改都在副本進行，你驗收通過才寫回。", "Members may read this folder; all edits happen in copies and are written back only when you accept."))
                .font(.caption).foregroundStyle(.secondary)
            HStack {
                Spacer()
                Button(t("取消", "Cancel")) { dismiss() }
                Button(t("進入會議室", "Open room")) {
                    model.createFlow(title: title, folder: folder, members: Array(members), reviewLevel: level)
                    dismiss()
                }
                .buttonStyle(.borderedProminent).disabled(members.count < 2 || folder.isEmpty)
            }
        }
        .padding(20).frame(width: 600)
    }
}
