import SwiftUI
import AppKit
import AIROOMCore

struct ProjectsView: View {
    var initialProjectID: UUID? = nil
    @EnvironmentObject private var model: WorkbenchModel
    @Environment(\.colorScheme) private var scheme
    private func t(_ key: String) -> String { LocalizedUI.text(key, language: model.archive.settings.language) }
    @State private var selectedID: UUID?
    var body: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 10) {
                StudioPageHeading(eyebrow: "PROJECTS", title: t("專案工作區"),
                    subtitle: t("先在副本執行，逐檔驗收後才能寫回原資料夾。"))
                TextField(t("專案名稱"), text: $model.projectTitleDraft)
                HStack {
                    TextField(t("原始資料夾"), text: $model.projectFolderDraft)
                    Button(t("選取")) { chooseFolder() }
                }
                Button(t("建立專案")) { model.addProject() }
                    .buttonStyle(.borderedProminent)
                Divider()
                List(selection: $selectedID) {
                    ForEach(model.archive.projects) { project in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(project.title).font(.headline)
                            Text(LocalizedUI.phase(project.phase, language: model.archive.settings.language)).font(.caption).foregroundStyle(.secondary)
                        }.tag(project.id)
                    }
                }
            }
            .padding(17)
            .frame(minWidth: 265, idealWidth: 295, maxWidth: 340)
            .background(StudioTheme.sidebar(scheme))
            Divider()
            if let project = model.archive.projects.first(where: { $0.id == selectedID }) {
                ProjectDetailView(project: project)
            } else {
                ContentUnavailableView(t("選擇或建立專案"), systemImage: "folder.badge.gearshape", description: Text(t("建立專案後，輸入需求即可在獨立副本執行。")))
            }
        }
        .onAppear {
            if selectedID == nil {
                selectedID = initialProjectID ?? model.archive.projects.first?.id
            }
        }
        .onChange(of: initialProjectID) { _, newValue in
            if let newValue { selectedID = newValue }
        }
    }
    private func chooseFolder() {
        let picker = NSOpenPanel()
        picker.canChooseFiles = false
        picker.canChooseDirectories = true
        picker.allowsMultipleSelection = false
        if picker.runModal() == .OK, let url = picker.url { model.projectFolderDraft = url.path }
    }
}

private struct ProjectDetailView: View {
    @EnvironmentObject private var model: WorkbenchModel
    private func t(_ key: String) -> String { LocalizedUI.text(key, language: model.archive.settings.language) }
    let project: ProjectRecord
    @State private var selectedChange: String?
    @State private var confirmWriteback = false
    private var task: Binding<String> {
        Binding(get: { model.archive.projects.first(where: { $0.id == project.id })?.task ?? "" },
                set: { model.updateProjectTask(id: project.id, task: $0) })
    }
    private var changes: [FileChange] { (try? model.projectChanges(id: project.id)) ?? [] }
    private func stepTitle(_ step: TeamProjectStep) -> String {
        switch step {
        case .discussion: return t("討論")
        case .leader: return t("負責人")
        case .proposal: return t("方案")
        case .execution: return t("執行")
        case .review: return t("驗收")
        case .completed: return t("完成")
        }
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text(project.title).font(.title.bold())
                if let workflow = model.workflow(for: project.id) {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack(spacing: 6) {
                            ForEach(TeamProjectStep.allCases, id: \.self) { step in
                                Text(stepTitle(step)).font(.caption2.weight(.medium))
                                    .padding(.horizontal, 9).padding(.vertical, 6)
                                    .background(step == workflow.step ? Color.orange.opacity(0.22) : Color.secondary.opacity(0.08), in: Capsule())
                            }
                        }
                        Text("目前階段：" + stepTitle(workflow.step)).font(.headline)
                        if workflow.step == .discussion {
                            TextEditor(text: $model.workflowDiscussionDraft)
                                .frame(height: 70).padding(6)
                                .background(Color.secondary.opacity(0.07), in: RoundedRectangle(cornerRadius: 9))
                            Button(t("請 Claude 和 Codex 討論需求")) { model.discussProject(id: project.id) }
                                .disabled(model.projectBusy || model.workflowDiscussionDraft.isEmpty)
                            ForEach(workflow.discussion.suffix(12)) { entry in
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(entry.displayName).font(.caption.weight(.semibold))
                                    Text(entry.body).font(.caption).textSelection(.enabled)
                                }
                            }
                            HStack {
                                Text(t("討論足夠後選負責人："))
                                ForEach(workflow.participants) { agent in
                                    Button(agent.shortName) { model.chooseWorkflowLeader(id: project.id, agent: agent) }
                                        .disabled(model.projectBusy)
                                }
                            }
                        } else if workflow.step == .leader {
                            Text("負責人：" + (workflow.leader?.shortName ?? "未選擇"))
                            Button(t("由負責人擬定可驗收方案")) { model.generateWorkflowProposal(id: project.id) }
                                .buttonStyle(.borderedProminent).disabled(model.projectBusy)
                        } else if workflow.step == .proposal {
                            Text(t("工作方案（請確認後才允許執行）")).font(.headline)
                            Text(workflow.proposal).textSelection(.enabled)
                            Button(t("核准方案並在副本執行")) { model.approveWorkflowAndRun(id: project.id) }
                                .buttonStyle(.borderedProminent).disabled(model.projectBusy)
                            if workflow.reviewRejected { Text(t("上一輪被駁回，請重新檢查方案。"))
                                .foregroundStyle(.orange).font(.caption) }
                        } else if workflow.step == .execution {
                            Text(t("已核准方案；Codex 在獨立副本執行中。"))
                                .font(.caption).foregroundStyle(.secondary)
                            if project.phase == .failed {
                                Button(t("重新在副本執行本輪任務")) { model.startProject(id: project.id) }
                                    .disabled(model.projectBusy)
                            }
                        } else if workflow.step == .review {
                            Text(t("執行完畢；必須逐檔檢查，由你決定驗收或駁回。"))
                                .font(.caption).foregroundStyle(.secondary)
                        } else {
                            Label(t("專案已驗收完成"), systemImage: "checkmark.seal")
                                .foregroundStyle(.green)
                        }
                    }
                }
                StudioPhasePill(phase: project.phase, language: model.archive.settings.language)
                LabeledContent(t("原始路徑"), value: project.originalFolder)
                    .textSelection(.enabled)
                LabeledContent(t("狀態"), value: LocalizedUI.phase(project.phase, language: model.archive.settings.language))
                Text(t("工作需求")).font(.headline)
                TextEditor(text: task)
                    .frame(height: 120)
                    .padding(6)
                    .background(Color.secondary.opacity(0.07), in: RoundedRectangle(cornerRadius: 10))
                    .disabled(project.phase != .draft || (model.workflow(for: project.id)?.step != .discussion && model.workflow(for: project.id) != nil))
                HStack {
                    if model.workflow(for: project.id) == nil && (project.phase == .draft || project.phase == .rejected || project.phase == .failed) {
                        Button(t("在獨立副本執行（Codex）")) { model.startProject(id: project.id) }
                            .buttonStyle(.borderedProminent)
                            .disabled(model.projectBusy)
                    }
                    if project.phase == .executing {
                        ProgressView().controlSize(.small)
                        Button(t("中止"), role: .destructive) { model.stopProject() }
                    }
                    if project.phase == .reviewing {
                        Button(t("確認套用到原資料夾")) { confirmWriteback = true }
                            .buttonStyle(.borderedProminent)
                            .disabled(model.projectBusy)
                        Button(t("請 Claude 進行唯讀審查")) { model.reviewProjectWithClaude(id: project.id) }
                            .disabled(model.projectBusy)
                        Button(t("駁回這次修改")) { model.rejectProject(id: project.id) }
                            .disabled(model.projectBusy)
                    }
                }
                Text(t("注意：這是工作副本與人工驗收機制，不是 macOS 系統沙箱。Codex CLI 仍以本機使用者權限啟動；不要用於不可信任的任務。"))
                    .font(.caption).foregroundStyle(.orange)
                if !project.report.isEmpty {
                    Divider()
                    Text(t("執行報告")).font(.headline)
                    Text(project.report).textSelection(.enabled)
                }
                if let review = project.reviewNotes, !review.isEmpty {
                    Divider()
                    Text(t("審查意見")).font(.headline)
                    Text(review).textSelection(.enabled)
                }
                if model.projectBusy && project.phase == .reviewing {
                    Button(t("中止"), role: .destructive) { model.stopProject() }
                }
                if project.phase == .reviewing || project.phase == .accepted || project.phase == .rejected {
                    Divider()
                    Text("\(t("檔案變更")) (\(changes.count))").font(.headline)
                    ForEach(changes) { item in
                        HStack {
                            Text(LocalizedUI.change(item.kind, language: model.archive.settings.language)).font(.caption.monospaced()).foregroundStyle(.secondary)
                            Button(item.path) { selectedChange = item.path }
                                .buttonStyle(.plain)
                                .foregroundStyle(.tint)
                            Spacer()
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
        }
        .alert(t("確認寫回原始專案？"), isPresented: $confirmWriteback) {
            Button(t("取消"), role: .cancel) { }
            Button(t("核准寫回")) { model.acceptProject(id: project.id) }
        } message: {
            Text(t("只有差異檢查中列出的檔案會寫入。若原始檔案已改變，系統將拒絕寫回。請先檢查每個變更。"))
        }
        .sheet(item: Binding(
            get: { selectedChange.map { SelectedFile(path: $0) } },
            set: { selectedChange = $0?.path }
        )) { item in
            FilePreviewView(projectID: project.id, path: item.path)
                .frame(minWidth: 850, minHeight: 560)
        }
    }
}

private struct SelectedFile: Identifiable {
    let path: String
    var id: String { path }
}

private struct FilePreviewView: View {
    @EnvironmentObject private var model: WorkbenchModel
    private func t(_ key: String) -> String { LocalizedUI.text(key, language: model.archive.settings.language) }
    @Environment(\.dismiss) private var dismiss
    let projectID: UUID
    let path: String
    var body: some View {
        let pair = try? model.projectPreview(id: projectID, path: path)
        VStack {
            HStack {
                Text("\(t("變更審查")): \(path)").font(.headline)
                Spacer()
                Button(t("關閉")) { dismiss() }
            }
            HStack {
                VStack(alignment: .leading) {
                    Text(t("修改前")).bold()
                    ScrollView { Text(pair?.before ?? t("無法讀取")).font(.system(.body, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                }.frame(maxWidth: .infinity)
                Divider()
                VStack(alignment: .leading) {
                    Text(t("修改後")).bold()
                    ScrollView { Text(pair?.after ?? t("無法讀取")).font(.system(.body, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                }.frame(maxWidth: .infinity)
            }
        }.padding()
    }
}
