import SwiftUI
import AIROOMCore

struct StudioDashboard: View {
    @EnvironmentObject private var model: WorkbenchModel
    @Environment(\.colorScheme) private var scheme
    let onChat: (AgentKind) -> Void
    let onProject: () -> Void
    let onRoom: () -> Void
    let onMembers: () -> Void
    let onMemberCard: (AgentKind) -> Void
    var onSettings: () -> Void = {}
    private var lang: InterfaceLanguage { model.archive.settings.language }
    private func t(_ zh: String, _ en: String) -> String { StudioI18n.t(zh, en, lang) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                VStack(alignment: .leading, spacing: 17) {
                    Text(t("我們一起工作的房間", "A place to work together"))
                        .font(.system(size: 12, weight: .semibold)).tracking(2)
                        .foregroundStyle(StudioTheme.warning)
                    Text(t("歡迎來到 AIROOM。", "Welcome to AIROOM."))
                        .font(.system(size: 32, weight: .bold, design: .rounded))
                        .foregroundStyle(StudioTheme.ink(scheme))
                    Text(t("讓你的 AI 成員一起討論、獨立比較提案，或在你確認後將修改寫入專案。", "Talk with your AI teammates, compare independent ideas, and approve project changes before writeback."))
                        .font(.system(size: 15)).foregroundStyle(.secondary)
                        .frame(maxWidth: 750, alignment: .leading)
                    HStack(spacing: 10) {
                        Button(action: onProject) {
                            Label(t("打開專案工作區", "Open Projects"), systemImage: "folder.badge.plus")
                        }.buttonStyle(.borderedProminent)
                        Button(action: onRoom) { Label(t("前往茶歇室", "Visit Lounge"), systemImage: "cup.and.saucer") }
                        Button(action: onMembers) { Label(t("管理人物卡", "Manage Members"), systemImage: "person.crop.rectangle.stack") }
                    }
                }
                .padding(.top, 4)

                HStack(alignment: .top, spacing: 15) {
                    ForEach(model.visibleAgents) { agent in
                        let card = model.archive.members.first(where: { $0.agent == agent })
                        VStack(alignment: .leading, spacing: 0) {
                            ZStack {
                                agent.studioColor.opacity(0.09)
                                StudioPortrait(agent: agent)
                                    .padding(.top, 14)
                                    .padding(.horizontal, 8)
                            }
                            .frame(height: 225)
                            .clipped()
                            VStack(alignment: .leading, spacing: 9) {
                                HStack(spacing: 8) {
                                    Circle().fill(model.busyAgents.contains(agent) ? StudioTheme.orange : StudioTheme.moss)
                                        .frame(width: 8, height: 8)
                                    Text(card?.name ?? agent.shortName).font(.title3.weight(.semibold))
                                    Spacer()
                                    Text(agent == .claude ? "Claude Code" : "Codex")
                                        .font(.caption2).foregroundStyle(.secondary)
                                }
                                Text(model.busyAgents.contains(agent)
                                     ? t("正在工作", "Working")
                                     : (card?.enabled == false ? t("尚未啟用", "Disabled") : t("準備就緒時可以接收訊息", "Available for new tasks")))
                                    .font(.caption).foregroundStyle(.secondary)
                                if let motto = card?.motto, !motto.isEmpty {
                                    Text("「\(motto)」").font(.caption).italic().foregroundStyle(.secondary).lineLimit(2)
                                }
                                HStack {
                                    Button(t("人物卡", "Profile")) { onMemberCard(agent) }
                                    Spacer()
                                    Button { onChat(agent) } label: {
                                        Label(t("前往工位", "Open desk"), systemImage: "arrow.right")
                                    }
                                    .buttonStyle(.borderedProminent)
                                    .disabled(card?.enabled == false)
                                }
                                .font(.caption)
                            }
                            .padding(16)
                        }
                        .background(StudioTheme.surface(scheme), in: RoundedRectangle(cornerRadius: 16))
                        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(StudioTheme.border(scheme)))
                        .frame(maxWidth: .infinity)
                    }
                }

                HStack(alignment: .top, spacing: 16) {
                    StudioPanel {
                        VStack(alignment: .leading, spacing: 12) {
                            Label(t("開工前檢查", "Preflight Checklist"), systemImage: "checklist")
                                .font(.headline)
                            ForEach(AgentKind.allCases) { agent in preflightRow(agent) }
                            StudioNotice(message: t("「去登入」會在終端機打開官方程式自己的登入流程；AIROOM 不接觸帳號密碼或 Token。", "\"Sign in\" opens the official CLI's own login in Terminal; AIROOM never handles passwords or tokens."))
                        }
                    }
                    StudioPanel {
                        VStack(alignment: .leading, spacing: 13) {
                            Label(t("專案進度", "Project Activity"), systemImage: "square.stack.3d.up")
                                .font(.headline)
                            if model.archive.projects.isEmpty {
                                Text(t("還沒有專案。可以先新增一個資料夾。", "No projects yet. Add a project folder to begin."))
                                    .font(.subheadline).foregroundStyle(.secondary)
                            } else {
                                ForEach(model.archive.projects.prefix(4)) { project in
                                    HStack {
                                        VStack(alignment: .leading, spacing: 4) {
                                            Text(project.title).font(.subheadline.weight(.semibold))
                                            Text(project.originalFolder).font(.caption2)
                                                .foregroundStyle(.secondary).lineLimit(1)
                                        }
                                        Spacer()
                                        StudioPhasePill(phase: project.phase, language: lang)
                                    }
                                }
                            }
                            Button(t("查看專案", "View Projects"), action: onProject)
                        }
                    }
                }
                Text(t("所有工作台紀錄保存在本機。外部 AI CLI 可能需要連接其官方服務。", "Workbench history stays on this device. External AI CLIs may connect to their official services."))
                    .font(.caption2).foregroundStyle(.secondary)
            }
            .padding(28)
            .frame(maxWidth: 1100)
            .frame(maxWidth: .infinity)
        }
    }
}

struct StudioMemberSheet: View {
    @EnvironmentObject private var model: WorkbenchModel
    @Environment(\.colorScheme) private var scheme
    let agent: AgentKind
    let onDesk: () -> Void
    let onManage: () -> Void
    private func t(_ zh: String, _ en: String) -> String {
        StudioI18n.t(zh, en, model.archive.settings.language)
    }
    var body: some View {
        let member = model.archive.members.first(where: { $0.agent == agent })
        VStack(spacing: 0) {
            ZStack {
                agent.studioColor.opacity(0.08)
                StudioPortrait(agent: agent).padding(.top, 14)
            }
            .frame(height: 210).clipped()
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text(member?.name ?? agent.shortName).font(.title2.bold())
                    Spacer()
                    Text(agent.rawValue).foregroundStyle(.secondary)
                }
                Text(member?.persona.isEmpty == false ? (member?.persona ?? "") : t("這張人物卡尚未設定個性與分工。", "No persona or role has been configured."))
                    .foregroundStyle(.secondary)
                    .lineLimit(4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                HStack {
                    Button(t("編輯人物卡", "Edit Profile"), action: onManage)
                    Spacer()
                    Button(t("前往成員工位", "Open Member Desk"), action: onDesk)
                        .buttonStyle(.borderedProminent)
                }
            }
            .padding(20)
        }
        .background(StudioTheme.surface(scheme))
    }
}

extension StudioDashboard {
    @ViewBuilder func preflightRow(_ agent: AgentKind) -> some View {
        let status = model.officialCLIStatuses[agent]
        HStack(spacing: 8) {
            StudioAvatar(agent: agent, size: 27, running: model.busyAgents.contains(agent))
            Text(model.memberName(agent)).font(.subheadline)
            Spacer()
            switch status {
            case .authenticated:
                Label(t("已就緒", "Ready"), systemImage: "checkmark.circle.fill").font(.caption).foregroundStyle(.green)
            case .notLoggedIn:
                Label(t("需要登入", "Sign-in needed"), systemImage: "person.crop.circle.badge.exclamationmark")
                    .font(.caption).foregroundStyle(.orange)
                Button(t("去登入", "Sign in")) { model.openOfficialLogin(for: agent) }.controlSize(.small)
                Button { model.checkVendorCLIAccount(for: agent) } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.borderless).help(t("重新檢查", "Check again"))
            case .missingExecutable:
                Label(t("缺少程式", "CLI missing"), systemImage: "xmark.circle").font(.caption).foregroundStyle(.red)
                Button(t("設定路徑", "Set path"), action: onSettings).controlSize(.small)
            case .checking, nil:
                ProgressView().controlSize(.mini)
                Text(t("檢查中", "Checking")).font(.caption).foregroundStyle(.secondary)
            case .notConfirmed, .timedOut:
                Label(t("無法確認", "Unconfirmed"), systemImage: "questionmark.circle").font(.caption).foregroundStyle(.secondary)
                Button { model.checkVendorCLIAccount(for: agent) } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.borderless).help(t("重新檢查", "Check again"))
            }
        }
    }
}

struct StudioAttentionView: View {
    @EnvironmentObject private var model: WorkbenchModel
    let onOpen: (AttentionItem.Target) -> Void
    private func t(_ zh: String, _ en: String) -> String {
        StudioI18n.t(zh, en, model.archive.settings.language)
    }
    private func icon(_ kind: AttentionKind) -> String {
        switch kind {
        case .question: return "questionmark.bubble"
        case .decision: return "hand.raised"
        case .unknown: return "exclamationmark.triangle"
        case .login: return "person.crop.circle.badge.exclamationmark"
        case .missing: return "xmark.circle"
        case .acceptance: return "doc.text.magnifyingglass"
        }
    }
    var body: some View {
        let items = model.attentionItems
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                StudioPageHeading(eyebrow: "ATTENTION", title: t("待你處理", "Needs Attention"),
                    subtitle: t("成員在等你回答、需要你點名或登入、有結果要核對、有成品等你驗收，都會列在這裡。", "Questions for you, picks, sign-ins, results to check and work to accept."))
                if items.isEmpty {
                    StudioEmptyState(icon: "checkmark.circle", title: t("目前沒有待辦", "All clear"),
                                     detail: t("需要你處理的事會出現在這裡。", "Anything that needs you will show up here."))
                }
                ForEach(items) { item in
                    StudioPanel {
                        HStack(spacing: 14) {
                            Image(systemName: icon(item.kind)).font(.title2).foregroundStyle(StudioTheme.orange)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(item.title).font(.headline)
                                Text(item.detail).font(.caption).foregroundStyle(.secondary).lineLimit(3)
                            }
                            Spacer()
                            Button(t("忽略", "Ignore")) { model.ignoreAttention(item) }
                                .help(t("只隱藏這則提醒，原本的工作和狀態都保留；內容有變化時會再出現。",
                                        "Only hides this reminder; the work stays as it is. It comes back if it changes."))
                                .disabled(!model.storageAvailable)
                            Button(t("前往", "Open")) { onOpen(item.target) }
                        }
                    }
                }
                if model.ignoredAttentionCount > 0 {
                    Button(t("重新顯示已忽略的 \(model.ignoredAttentionCount) 則", "Show \(model.ignoredAttentionCount) ignored")) {
                        model.showIgnoredAttention()
                    }
                    .buttonStyle(.borderless).font(.caption)
                }
                StudioNotice(message: t("這個頁面只負責帶你過去；不會自動回答、批准寫回或重送任何請求。", "This page only takes you there; it never answers, approves writeback or resends anything."))
            }.padding(26).frame(maxWidth: 900).frame(maxWidth: .infinity)
        }
    }
}
