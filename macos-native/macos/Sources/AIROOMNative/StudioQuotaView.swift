import SwiftUI
import AIROOMCore

/// Quota is per vendor account, not per custom member card. The UI never
/// guesses a limit from token consumption, and never turns failure into 0%.
struct StudioQuotaCompact: View {
    let quota: AccountQuota?
    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { tick in
            if let quota, quota.isFresh(at: tick.date), quota.status == .ready,
               let limiting = quota.windows.max(by: { $0.usedPercent < $1.usedPercent }) {
                Text("\(Int(limiting.remainingPercent.rounded()))%")
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .foregroundStyle(limiting.remainingPercent <= 20 ? Color.orange : Color.secondary)
                    .help("\(limiting.label) · \(Int(limiting.remainingPercent.rounded()))% remaining")
            }
        }
    }
}

struct StudioQuotaView: View {
    @EnvironmentObject private var model: WorkbenchModel
    private var lang: InterfaceLanguage { model.archive.settings.language }
    private func t(_ zh: String, _ en: String) -> String { StudioI18n.t(zh, en, lang) }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { tick in
          ScrollView {
            VStack(alignment: .leading, spacing: 17) {
                StudioPageHeading(eyebrow: "USAGE", title: t("用量與額度", "Usage & Quotas"),
                    subtitle: t("直接查詢官方執行端回報的訂閱限制。不是 Token 推算，也不是 ChatGPT／Claude App 的帳單。", "Subscription limits from official executable reports, not estimates derived from tokens or billing."))
                ForEach(AgentKind.allCases) { agent in
                    StudioPanel {
                        VStack(alignment: .leading, spacing: 13) {
                            HStack(spacing: 10) {
                                StudioAvatar(agent: agent, size: 37)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(agent.rawValue).font(.headline)
                                    Text(agent == .codex ? "Codex App Server · account/rateLimits/read" : "Claude Code · /usage")
                                        .font(.caption2.monospaced()).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Button {
                                    model.refreshQuota(for: agent)
                                } label: {
                                    Label(t("刷新額度", "Refresh Quota"), systemImage: "arrow.clockwise")
                                }
                                .disabled(model.quotaRefreshing.contains(agent))
                                if model.quotaRefreshing.contains(agent) { ProgressView().controlSize(.small) }
                            }
                            VStack(alignment: .leading, spacing: 3) {
                                Label(t("今天：", "Today: ") + model.archive.calls.usage(agent, day: LocalAutomation.dayKey(tick.date)).label(lang),
                                      systemImage: "arrow.up.arrow.down.circle").font(.caption)
                                Text(t("近 60 天：", "Last 60 days: ") + model.archive.calls.usage(agent).label(lang))
                                    .font(.caption2).foregroundStyle(.secondary)
                            }
                            if let quota = model.accountQuotas[agent] {
                                if !quota.isFresh(at: tick.date) {
                                    Label(t("上次資料已過期，請重新整理；過期不代表額度耗盡。", "Previous sample is stale; refresh it. Stale data does not mean exhausted quota."), systemImage: "clock")
                                        .font(.caption).foregroundStyle(.secondary)
                                } else if quota.status == .unavailable {
                                    Label(t("官方執行端目前未提供可驗證的額度資料；請確認登入狀態。", "Official executable did not return verifiable quota data. Check sign-in."), systemImage: "questionmark.circle")
                                        .font(.caption).foregroundStyle(.secondary)
                                } else {
                                    ForEach(quota.windows) { window in
                                        VStack(alignment: .leading, spacing: 7) {
                                            HStack {
                                                Text(window.label).font(.subheadline.weight(.semibold))
                                                Spacer()
                                                Text(String(format: "%.1f%%", window.remainingPercent) + " " + t("剩餘", "remaining"))
                                                    .font(.subheadline.monospacedDigit())
                                            }
                                            ProgressView(value: window.remainingPercent, total: 100)
                                                .tint(window.remainingPercent <= 20 ? .orange : .green)
                                            HStack {
                                                Text(String(format: "%.1f%%", window.usedPercent) + " " + t("已使用", "used"))
                                                Spacer()
                                                if let resetsAt = window.resetsAt {
                                                    Text(t("重置：", "Resets: ") + resetsAt.formatted(date: .abbreviated, time: .shortened))
                                                } else {
                                                    Text(t("未提供重置時間", "No reset time provided"))
                                                }
                                            }.font(.caption2).foregroundStyle(.secondary)
                                        }
                                        Divider()
                                    }
                                }
                                Text(t("檢查時間：", "Checked: ") + quota.checkedAt.formatted(date: .abbreviated, time: .standard))
                                    .font(.caption2).foregroundStyle(.secondary)
                            } else {
                                Text(t("尚未查詢，按「刷新額度」讀取官方帳號回報。", "Not checked yet. Select Refresh Quota to query the official executable."))
                                    .font(.subheadline).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                StudioNotice(icon: "lock.shield", message: t(
                    "資料只暫存於本次執行期間，超過 15 分鐘標示過期。這項查詢不會傳送聊天室內容，也不讀取 Token；Claude 只有在確認 /usage 為內建命令後才會呼叫。",
                    "Samples are kept in memory and expire after 15 minutes. No chat transcript or token is read; Claude runs /usage only after verifying it is a built-in command."))
            }
            .padding(26)
            .frame(maxWidth: 960)
            .frame(maxWidth: .infinity)
          }
        }
    }
}
