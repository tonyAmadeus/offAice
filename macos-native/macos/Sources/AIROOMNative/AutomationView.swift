import SwiftUI
import AIROOMCore

struct AutomationView: View {
    @EnvironmentObject private var model: WorkbenchModel
    @Environment(\.colorScheme) private var scheme
    @State private var title = ""
    @State private var text = ""
    @State private var hour = 12
    @State private var minute = 0
    @State private var action: ScheduleAction = .reminder
    @State private var target: AgentKind?

    private var english: Bool { model.archive.settings.language == .english }
    private func t(_ zh: String, _ en: String) -> String { english ? en : zh }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                StudioPageHeading(eyebrow: "AUTOMATION", title: t("排程與自動對話", "Schedules & Auto Chat"),
                    subtitle: t("只有 App 執行時才檢查；關閉期間錯過的任務不補發。", "Triggers only while the app runs; missed runs are never replayed."))
                StudioPanel {
                    VStack(alignment: .leading, spacing: 13) {
                        Text(t("建立每日排程", "Daily schedule")).font(.headline)
                        TextField(t("排程名稱", "Task name"), text: $title)
                        Picker(t("類型", "Action"), selection: $action) {
                            Text(t("提醒", "Reminder")).tag(ScheduleAction.reminder)
                            Text(t("讓 AI 在聊天室回應", "AI room message")).tag(ScheduleAction.roomMessage)
                        }
                        .pickerStyle(.segmented)
                        TextField(t("內容或提示詞", "Message or prompt"), text: $text)
                        HStack {
                            Picker(t("小時", "Hour"), selection: $hour) {
                                ForEach(0..<24, id: \.self) { value in Text(String(format: "%02d", value)).tag(value) }
                            }.frame(width: 125)
                            Picker(t("分鐘", "Minute"), selection: $minute) {
                                ForEach(0..<60, id: \.self) { value in Text(String(format: "%02d", value)).tag(value) }
                            }.frame(width: 125)
                            if action == .roomMessage {
                                Picker(t("回覆成員", "Responder"), selection: $target) {
                                    Text(t("所有在場成員", "All present")).tag(nil as AgentKind?)
                                    ForEach(AgentKind.allCases) { agent in
                                        Text(agent.shortName).tag(Optional(agent))
                                    }
                                }.frame(maxWidth: 200)
                            }
                            Spacer()
                            Button(t("建立排程", "Add schedule")) {
                                model.addSchedule(name: title, text: text, hour: hour,
                                    minute: minute, action: action, target: target)
                                title = ""; text = ""
                            }.buttonStyle(.borderedProminent).disabled(title.isEmpty || text.isEmpty)
                        }
                    }
                }
                StudioPanel {
                    VStack(alignment: .leading, spacing: 13) {
                        Text(t("現有任務", "Schedules")).font(.headline)
                        if model.archive.schedules.isEmpty {
                            Text(t("尚未建立排程", "No schedules yet")).foregroundStyle(.secondary)
                        }
                        ForEach(model.archive.schedules) { item in
                            HStack(spacing: 10) {
                                Toggle(isOn: Binding(
                                    get: { model.archive.schedules.first(where: { $0.id == item.id })?.enabled ?? false },
                                    set: { model.setSchedule(id: item.id, enabled: $0) })) {
                                    VStack(alignment: .leading) {
                                        Text(item.name).font(.subheadline.weight(.semibold))
                                        Text(String(format: "%02d:%02d", item.hour, item.minute) + " · " + item.text)
                                            .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                                    }
                                }.toggleStyle(.checkbox)
                                Spacer()
                                Button(role: .destructive) { model.deleteSchedule(id: item.id) } label: {
                                    Image(systemName: "trash")
                                }.buttonStyle(.borderless)
                            }
                            Divider()
                        }
                    }
                }
                StudioPanel {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(t("每日開場", "Daily greeting")).font(.headline)
                        Toggle(t("每天第一次打開 AIROOM 時，由成員輪流在茶歇室問候你", "The first time you open AIROOM each day, a member greets you in the lounge"),
                               isOn: Binding(get: { model.archive.dailyOpening.enabled },
                                             set: { model.configureDailyOpening(enabled: $0) }))
                        Text(t("從下一天開始生效；會提到昨天房間裡確實說過的事，不會編造。每次一則、一次呼叫。",
                               "Starts the next day. It may mention what was actually said in the room yesterday. One line, one call."))
                            .font(.caption).foregroundStyle(.secondary)
                        Divider()
                        Text(t("成員閒聊", "Member small talk")).font(.headline)
                        Toggle(t("兩位成員依作息和關係設定，在茶歇室輕鬆聊兩句", "Two members exchange two lines in the lounge, based on their routines and relations"), isOn: Binding(
                            get: { model.archive.autoChat.enabled },
                            set: { enabled in model.configureIdleChat(enabled: enabled,
                                intervalMinutes: model.archive.autoChat.intervalMinutes,
                                dailyLimit: model.archive.autoChat.dailyLimit) }))
                        HStack(spacing: 18) {
                            Stepper(t("每 \(model.archive.autoChat.intervalMinutes) 分鐘", "Every \(model.archive.autoChat.intervalMinutes) min"),
                                value: Binding(get: { model.archive.autoChat.intervalMinutes },
                                               set: { model.configureIdleChat(enabled: model.archive.autoChat.enabled,
                                                     intervalMinutes: $0, dailyLimit: model.archive.autoChat.dailyLimit) }),
                                in: 60...1440, step: 60)
                            Stepper(t("每天上限 \(model.archive.autoChat.dailyLimit) 次", "Daily cap \(model.archive.autoChat.dailyLimit)"),
                                value: Binding(get: { model.archive.autoChat.dailyLimit },
                                               set: { model.configureIdleChat(enabled: model.archive.autoChat.enabled,
                                                     intervalMinutes: model.archive.autoChat.intervalMinutes, dailyLimit: $0) }),
                                in: 1...6)
                        }
                        Text(t("若想讓 Claude 和 Codex 長時間互相接話、回應觀眾，請到茶歇室使用「雙 AI 同台直播」。",
                               "For continuous multi-agent co-hosting and viewer comments, start a Live Show in the Lounge."))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            .padding(24)
            .frame(maxWidth: 1000)
            .frame(maxWidth: .infinity)
        }
    }
}
