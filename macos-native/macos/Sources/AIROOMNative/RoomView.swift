import SwiftUI
import AIROOMCore

struct RoomView: View {
    @EnvironmentObject private var model: WorkbenchModel
    @Environment(\.colorScheme) private var scheme
    @State private var confirmClear = false
    /// An open image request: its text and reference pictures.
    @State private var imageRequest: ImageRequestDraft?
    private var lang: InterfaceLanguage { model.archive.settings.language }
    private func t(_ zh: String, _ en: String) -> String { StudioI18n.t(zh, en, lang) }
    private var context: SharedContextSnapshot {
        RoomPromptBuilder.snapshot(room: model.activeRoom ?? TeamRoom(), language: lang)
    }

    var body: some View {
        ZStack {
            StudioRoomBackdrop()
            VStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 11) {
                    HStack(spacing: 14) {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(t("共用上下文對話室", "Shared AI Conversation"))
                                .font(.title2.bold())
                            Text(t("同一段歷史供所有成員閱讀；完成的回覆會接續傳給下一位。",
                                   "All agents see the same transcript; each completed reply is available to the next."))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Menu {
                            ForEach(model.loungeRooms) { room in
                                Button {
                                    model.selectRoom(room.id)
                                } label: {
                                    Label(room.title, systemImage: room.id == model.activeRoom?.id ? "checkmark.circle.fill" : "text.bubble")
                                }
                            }
                            Divider()
                            Button {
                                model.createRoom()
                            } label: { Label(t("新對話室", "New room"), systemImage: "plus") }
                        } label: {
                            Label(model.activeRoom?.title ?? t("討論室", "Discussion"), systemImage: "rectangle.stack")
                        }
                        .disabled(model.roomRunning || model.liveActive)
                        Menu {
                            Button(t("開新話題（帶入目前話題的摘要）", "New topic (carry over a summary)")) { model.createRoom(carryOver: true) }
                            Button(t("開新話題（不再延續）", "New topic (start fresh)")) { model.createRoom(carryOver: false) }
                        } label: {
                            Label(t("新話題", "New topic"), systemImage: "plus.bubble")
                        } primaryAction: { model.createRoom(carryOver: true) }
                        .fixedSize()
                        .disabled(model.roomRunning || model.liveActive)
                        Menu {
                            Button { model.compressRoom() } label: { Label(t("壓縮上下文", "Compress context"), systemImage: "arrow.down.right.and.arrow.up.left") }
                            Button { exportRoom() } label: { Label(t("匯出聊天室（Markdown）", "Export room (Markdown)"), systemImage: "square.and.arrow.up") }
                            Divider()
                            Button(role: .destructive) { confirmClear = true } label: { Label(t("清空當前話題", "Clear this topic"), systemImage: "trash") }
                        } label: { Image(systemName: "ellipsis.circle") }
                        .menuIndicator(.hidden).fixedSize()
                        .disabled(model.roomRunning || model.liveActive || model.roomEntries().isEmpty)
                    }
                    modeBar
                    if let room = model.activeRoom { loungeStatus(room) }
                    HStack(spacing: 12) {
                        Text(t("在場", "Present")).font(.caption.weight(.semibold))
                        ForEach(AgentKind.allCases) { agent in
                            Toggle(isOn: Binding(
                                get: { model.activeRoom?.participants.contains(agent) ?? false },
                                set: { model.setRoomParticipant(agent, included: $0) }
                            )) {
                                HStack(spacing: 6) {
                                    StudioAvatar(agent: agent, size: 26)
                                    Text(agent.shortName).font(.caption)
                                }
                            }
                            .toggleStyle(.checkbox)
                            .disabled(model.roomRunning || model.liveActive)
                        }
                        Spacer()
                        Label("\(context.includedCount) / \(model.roomEntries().count) " + t("則共用紀錄", "shared entries"), systemImage: "text.book.closed")
                            .font(.caption).foregroundStyle(.secondary)
                        if context.omittedEntries > 0 {
                            Label(t("較早 \(context.omittedEntries) 則未傳送", "\(context.omittedEntries) older omitted"), systemImage: "exclamationmark.circle")
                                .font(.caption).foregroundStyle(.orange)
                        }
                    }
                }
                .padding(18)
                .background(StudioTheme.surface(scheme).opacity(0.91))
                // LIVE is a bounded, explicitly started cooperative conversation,
                // not the occasional idle auto-chat rule from the original app.
                DisclosureGroup {
                    VStack(alignment: .leading, spacing: 10) {
                        TextField(t("直播主題", "Show topic"), text: Binding(
                            get: { model.archive.liveShow.topic },
                            set: { value in model.updateLiveConfig { $0.topic = String(value.prefix(2_000)) } }))
                            .textFieldStyle(.roundedBorder).disabled(model.liveActive)
                        HStack(spacing: 16) {
                            Stepper(t("間隔 \(model.archive.liveShow.turnDelaySeconds) 秒", "Delay \(model.archive.liveShow.turnDelaySeconds)s"),
                                value: Binding(get: { model.archive.liveShow.turnDelaySeconds },
                                               set: { value in model.updateLiveConfig { $0.turnDelaySeconds = value } }),
                                in: 15...180, step: 15).disabled(model.liveActive)
                            Stepper(t("最多 \(model.archive.liveShow.maxTurns) 輪", "Up to \(model.archive.liveShow.maxTurns) turns"),
                                value: Binding(get: { model.archive.liveShow.maxTurns },
                                               set: { value in model.updateLiveConfig { $0.maxTurns = value } }),
                                in: 2...300, step: 2).disabled(model.liveActive)
                            Stepper(t("最長 \(model.archive.liveShow.maxDurationMinutes) 分鐘", "Up to \(model.archive.liveShow.maxDurationMinutes) min"),
                                value: Binding(get: { model.archive.liveShow.maxDurationMinutes },
                                               set: { value in model.updateLiveConfig { $0.maxDurationMinutes = value } }),
                                in: 10...240, step: 10).disabled(model.liveActive)
                        }
                        .font(.caption)
                        HStack(spacing: 12) {
                            if model.liveActive {
                                Label(t("直播中 · 第 \(model.liveTurns) 輪", "LIVE · \(model.liveTurns) turns"), systemImage: "dot.radiowaves.left.and.right")
                                    .foregroundStyle(.red)
                                Button(t("停止直播", "Stop live show"), role: .destructive) { model.stopLiveShow() }
                            } else {
                                Button { model.startLiveShow() } label: {
                                    Label(t("開始雙 AI 同台直播", "Start multi-AI show"), systemImage: "play.fill")
                                }.buttonStyle(.borderedProminent).disabled(model.roomRunning)
                            }
                            Spacer()
                            Text(t("需要兩位 AI；僅本機執行期間有效；每 12 輪產生一次摘要。", "Requires 2 agents. Runs only while app is open; summary every 12 turns."))
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                        if model.liveActive {
                            HStack(spacing: 8) {
                                TextField(t("觀眾暱稱", "Viewer name"), text: $model.liveAudienceName).frame(width: 125)
                                TextField(t("插入觀眾留言，下一輪 AI 會看到", "Insert viewer comment for next AI turn"),
                                          text: $model.liveAudienceDraft)
                                    .onSubmit { model.enqueueLiveAudienceMessage() }
                                Button(t("加入聊天室", "Post comment")) { model.enqueueLiveAudienceMessage() }
                                    .disabled(model.liveAudienceDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            }
                            .textFieldStyle(.roundedBorder)
                            if !model.liveSubtitle.isEmpty {
                                Text(model.liveSubtitle).font(.caption).lineLimit(3)
                                    .textSelection(.enabled).foregroundStyle(.secondary)
                            }
                        }
                        Text(model.archive.liveStage.performs
                             ? t("已啟用直播舞台：每句話會念出並驅動 VTube Studio，念完才輪到下一位。到左側「直播舞台」調整聲音與表情。直播平台聊天室尚未串接。",
                                 "Live Stage is on: lines are spoken and drive VTube Studio; the next co-host waits until speech ends. Configure voices and expressions under Live Stage. Streaming chat ingestion is not connected yet.")
                             : t("目前只輸出文字。到左側「直播舞台」開啟語音與 VTube Studio。直播平台聊天室尚未串接。AI 回覆會傳送給所選供應商。",
                                 "Text only. Turn on voice and VTube Studio under Live Stage. Streaming chat ingestion is not connected yet. Messages go to the selected vendors."))
                            .font(.caption2).foregroundStyle(.secondary)
                    }.padding(.vertical, 8)
                } label: {
                    Label(t("雙 AI 同台直播模式", "Multi-AI live co-host mode"), systemImage: "dot.radiowaves.left.and.right")
                        .font(.subheadline.weight(.semibold))
                }
                .padding(.horizontal, 20).padding(.vertical, 9)
                .background(StudioTheme.surface(scheme).opacity(0.93))
                Divider()
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 14) {
                            if model.roomEntries().isEmpty {
                                StudioEmptyState(icon: "cup.and.saucer.fill",
                                    title: t("歡迎來到茶歇室", "Welcome to the Lounge"),
                                    detail: t("選擇在場成員，再提出第一個話題。", "Invite teammates and start the first conversation."))
                                    .padding(.top, 65)
                            }
                            ForEach(groupedEntries(model.roomEntries()), id: \.entry.id) { item in
                                let entry = item.entry
                                if entry.speaker == .system {
                                    Text(entry.body).font(.caption).foregroundStyle(.secondary)
                                        .frame(maxWidth: .infinity).padding(.vertical, 2).id(entry.id)
                                } else if entry.isReaction {
                                    HStack(spacing: 6) {
                                        if let agent = entry.agent { StudioAvatar(agent: agent, size: 20) }
                                        Text("\(entry.displayName) " + t("回應了", "reacted") + " \(entry.body)")
                                            .font(.caption).foregroundStyle(.secondary)
                                    }
                                    .padding(.leading, 43).id(entry.id)
                                } else {
                                HStack(alignment: .top, spacing: 10) {
                                    if let agent = entry.agent {
                                        StudioAvatar(agent: agent, size: 33)
                                    } else {
                                        Image(systemName: "person.crop.circle.fill")
                                            .font(.system(size: 31)).foregroundStyle(StudioTheme.warning)
                                    }
                                    VStack(alignment: .leading, spacing: 7) {
                                        HStack {
                                            Text(entry.displayName).font(.subheadline.weight(.semibold))
                                            if entry.isMinutes {
                                                Label(t("會議紀要", "Minutes"), systemImage: "doc.text")
                                                    .font(.caption2.weight(.semibold)).foregroundStyle(StudioTheme.amber)
                                            }
                                            if entry.delivery == .inProgress {
                                                ProgressView().controlSize(.mini)
                                            } else if entry.delivery == .failed || entry.delivery == .interrupted {
                                                Image(systemName: "exclamationmark.triangle.fill")
                                                    .foregroundStyle(.orange)
                                                    .help(t("本次回覆未完成，不會進入其他成員的上下文。", "Unconfirmed response; excluded from other agents' context."))
                                            }
                                            Spacer()
                                            Text(entry.createdAt, style: .time)
                                                .font(.caption2).foregroundStyle(.secondary)
                                        }
                                        RichText(entry.body)
                                            .textSelection(.enabled)
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                        if !entry.images.isEmpty {
                                            RoomImagesStrip(images: entry.images) { image in
                                                imageRequest = ImageRequestDraft(text: "", references: [image])
                                            }
                                        }
                                        if !item.reactions.isEmpty { reactionChips(item.reactions) }
                                    }
                                    .padding(14)
                                    .background(StudioTheme.surface(scheme).opacity(0.96),
                                                in: RoundedRectangle(cornerRadius: 13))
                                    .overlay(RoundedRectangle(cornerRadius: 13)
                                        .strokeBorder(entry.isMinutes ? StudioTheme.amber : StudioTheme.border(scheme)))
                                }
                                .id(entry.id)
                                }
                            }
                        }
                        .padding(24)
                        .frame(maxWidth: 810)
                        .frame(maxWidth: .infinity)
                    }
                    .onChange(of: model.roomEntries().count) { _, _ in
                        if let last = model.roomEntries().last?.id {
                            withAnimation { proxy.scrollTo(last, anchor: .bottom) }
                        }
                    }
                }
                Divider()
                VStack(alignment: .leading, spacing: 10) {
                    if let room = model.activeRoom { questionStrip(room); handsPanel(room) }
                    TextEditor(text: $model.roomDraft)
                        .frame(height: 78).font(.body).scrollContentBackground(.hidden)
                        .padding(8)
                        .background(StudioTheme.surface(scheme), in: RoundedRectangle(cornerRadius: 12))
                        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(StudioTheme.border(scheme)))
                    HStack(spacing: 10) {
                        Picker(t("回覆成員", "Responders"), selection: $model.roomTarget) {
                            Text(t("所有在場成員", "All present agents")).tag(nil as AgentKind?)
                            ForEach(AgentKind.allCases.filter { model.activeRoom?.participants.contains($0) ?? false }) { agent in
                                Text(agent.shortName).tag(Optional(agent))
                            }
                        }
                        .pickerStyle(.menu)
                        .frame(maxWidth: 245)
                        .disabled(model.roomRunning || model.liveActive)
                        Text(t("用 @名字 指定誰先接話。共用紀錄會傳給所選 AI 供應商。", "Use @name to choose who answers first. Shared history goes to the selected AI vendors."))
                            .font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        if model.roomRunning {
                            ProgressView().controlSize(.small)
                            Button(t("停止", "Stop"), role: .destructive) { model.stopRoom() }
                        }
                        Button { imageRequest = ImageRequestDraft(text: model.roomDraft, references: []) } label: {
                            Label(t("畫圖", "Draw"), systemImage: "paintbrush.pointed")
                        }
                        .disabled(!model.canGenerateImage)
                        .help(model.canGenerateImage ? t("請 Codex 生成或修改一張圖片", "Ask Codex to create or edit a picture")
                              : t("需要 Codex 在場，且目前沒有成員正在發言", "Needs Codex in the room and nobody speaking"))
                        Button { model.sendToRoom() } label: {
                            Label(model.answeringQuestionID != nil ? t("回答", "Answer") : t("送出", "Send"), systemImage: "arrow.up")
                        }
                        .keyboardShortcut(.return, modifiers: .command)
                        .buttonStyle(.borderedProminent)
                        // A chat accepts interjections while members are talking.
                        .disabled((model.roomRunning && model.activeRoom?.lounge.style != .chat) || model.liveActive
                                  || model.roomDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
                .padding(.horizontal, 21).padding(.vertical, 13)
                .background(StudioTheme.secondary(scheme).opacity(0.95))
            }
        }
        .sheet(item: $imageRequest) { draft in
            ImageRequestSheet(text: draft.text, references: draft.references).environmentObject(model)
        }
        .confirmationDialog(t("清空這個話題的所有訊息？", "Clear every message in this topic?"), isPresented: $confirmClear) {
            Button(t("清空當前話題", "Clear this topic"), role: .destructive) { model.clearRoom() }
        }
    }

    /// Emoji-only replies attach to the message just before them, like reactions in a chat app.
    private func groupedEntries(_ entries: [RoomEntry]) -> [(entry: RoomEntry, reactions: [RoomEntry])] {
        var result: [(entry: RoomEntry, reactions: [RoomEntry])] = []
        for entry in entries {
            if entry.isReaction, let host = result.lastIndex(where: { $0.entry.speaker != .system }) {
                result[host].reactions.append(entry)
            } else {
                result.append((entry, []))
            }
        }
        return result
    }

    private func reactionChips(_ reactions: [RoomEntry]) -> some View {
        HStack(spacing: 6) {
            ForEach(reactions) { reaction in
                HStack(spacing: 4) {
                    Text(reaction.body)
                    if let agent = reaction.agent { StudioAvatar(agent: agent, size: 16) }
                }
                .padding(.horizontal, 7).padding(.vertical, 3)
                .background(.secondary.opacity(0.12), in: Capsule())
                .help("\(reaction.displayName) " + t("回應了", "reacted") + " \(reaction.body)")
            }
        }
    }

    // MARK: Lounge mode and status

    private var modeBar: some View {
        let lounge = model.activeRoom?.lounge ?? LoungeState()
        return HStack(spacing: 14) {
            Picker("", selection: Binding(get: { lounge.style }, set: { model.setLoungeStyle($0) })) {
                Text(t("閒聊", "Chat")).tag(LoungeStyle.chat)
                Text(t("開會", "Meeting")).tag(LoungeStyle.meeting)
            }
            .pickerStyle(.segmented).labelsHidden().frame(width: 150)
            .disabled(model.roomRunning || model.liveActive)
            if lounge.style == .meeting {
                Toggle(t("舉手模式", "Hand raising"), isOn: Binding(get: { lounge.handRaise },
                                                                    set: { model.setLoungeOption(handRaise: $0) }))
                Toggle(t("舉手後由我點名", "I pick who speaks"), isOn: Binding(get: { lounge.hostPick },
                                                                         set: { model.setLoungeOption(hostPick: $0) }))
                    .disabled(!lounge.handRaise)
            }
            Spacer()
            Text(lounge.style == .chat
                 ? t("成員自由接話，聊到自然告一段落就停；你隨時可以插話。", "Members chat freely until it winds down; jump in anytime.")
                 : t("每人依序回答一次，然後等你；結束時整理會議紀要。", "Each member answers once in turn, then waits; finish with minutes."))
                .font(.caption).foregroundStyle(.secondary)
        }
        .toggleStyle(.checkbox).font(.caption)
    }

    private func phaseLabel(_ phase: LoungePhase) -> String {
        switch phase {
        case .talking: return t("討論中", "Talking")
        case .raising: return t("大家正在舉手", "Raising hands")
        case .awaitingHost: return t("等你點名", "Your pick")
        case .closing: return t("有人提議先聊到這裡", "Someone suggested wrapping up")
        case .summarizing: return t("正在整理會議紀要", "Writing minutes")
        case .waitingUser: return t("等你說話", "Waiting for you")
        case .paused: return t("已暫停", "Paused")
        case .idle: return t("本次討論已結束", "Ended")
        }
    }

    @ViewBuilder private func loungeStatus(_ room: TeamRoom) -> some View {
        let lounge = room.lounge
        let hasMeeting = lounge.style == .meeting && lounge.meetingStartEntryID != nil
        if let activity = model.loungeActivity {
            Label(activity, systemImage: "hourglass").font(.caption).foregroundStyle(.secondary)
        }
        if lounge.phase != .idle || lounge.reason != nil || hasMeeting {
            HStack(spacing: 10) {
                Label(phaseLabel(lounge.phase), systemImage: "bubble.left.and.bubble.right")
                    .font(.caption.weight(.semibold)).foregroundStyle(StudioTheme.warning)
                if let reason = lounge.reason { Text(reason).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                Spacer()
                if lounge.phase == .paused && !model.roomRunning {
                    Button(t("繼續聊", "Continue")) { model.continueLounge() }.controlSize(.small)
                }
                if hasMeeting && !model.roomRunning {
                    Menu(t("整理會議紀要", "Write minutes")) {
                        ForEach(model.archive.members.filter { $0.enabled && room.participants.contains($0.agent) }) { member in
                            Button(t("請 \(member.name) 整理", "Ask \(member.name)")) { model.writeMinutes(by: member.agent) }
                        }
                    }
                    .fixedSize().controlSize(.small)
                }
            }
        }
    }

    @ViewBuilder private func questionStrip(_ room: TeamRoom) -> some View {
        let pending = room.lounge.pendingQuestions
        if !pending.isEmpty {
            VStack(alignment: .leading, spacing: 5) {
                ForEach(pending.suffix(4)) { question in
                    HStack(spacing: 8) {
                        StudioAvatar(agent: question.from, size: 20)
                        Text(t("問你：", "asks: ") + question.text).font(.caption).lineLimit(2)
                        Spacer()
                        Button(model.answeringQuestionID == question.id ? t("回答中", "Answering") : t("回答", "Answer")) {
                            model.answerQuestion(question)
                        }.controlSize(.small)
                        Button(t("略過", "Skip")) { model.dismissQuestion(question.id) }.controlSize(.small)
                    }
                }
            }
            .padding(9)
            .background(StudioTheme.amber.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
        }
    }

    @ViewBuilder private func handsPanel(_ room: TeamRoom) -> some View {
        let lounge = room.lounge
        if [.raising, .awaitingHost].contains(lounge.phase) && !lounge.hands.isEmpty {
            VStack(alignment: .leading, spacing: 5) {
                ForEach(AgentKind.allCases.filter { lounge.hands[$0.rawValue] != nil }) { agent in
                    let vote = lounge.hands[agent.rawValue]!
                    HStack(spacing: 8) {
                        StudioAvatar(agent: agent, size: 20)
                        Text(String(repeating: "✋", count: vote.want) + (vote.want == 0 ? t("沒有補充", "No addition") : ""))
                            .font(.caption)
                        Text(vote.why).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        Spacer()
                        if lounge.phase == .awaitingHost && vote.want > 0 && !lounge.supplemented.contains(agent) {
                            Button(t("請他補充", "Let them add")) { model.pickHand(agent) }.controlSize(.small)
                        }
                    }
                }
                if lounge.phase == .awaitingHost {
                    Button(t("不用了，等我說話", "No one, back to me")) { model.pickHand(nil) }.controlSize(.small)
                }
            }
            .padding(9)
            .background(StudioTheme.surface(scheme), in: RoundedRectangle(cornerRadius: 10))
        }
    }

    private func exportRoom() {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.init(filenameExtension: "md")!]
        panel.nameFieldStringValue = "\(model.activeRoom?.title ?? "AIROOM").md"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do { try model.roomMarkdown().write(to: url, atomically: true, encoding: .utf8) }
        catch { model.statusMessage = error.localizedDescription }
    }
}

private struct ImageRequestDraft: Identifiable {
    let id = UUID()
    var text: String
    var references: [RoomImage]
}
