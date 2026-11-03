import SwiftUI
import AVFoundation
import AIROOMCore

/// Voice + VTube Studio setup for the live co-host show.
struct LiveStageView: View {
    @EnvironmentObject private var model: WorkbenchModel
    @ObservedObject var stage: LiveStageController
    @State private var voices: [AVSpeechSynthesisVoice] = []

    private var settings: LiveStageSettings { model.archive.liveStage }
    private var english: Bool { model.archive.settings.language == .english }
    private func t(_ zh: String, _ en: String) -> String { english ? en : zh }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                StudioPageHeading(eyebrow: "LIVE STAGE", title: t("直播舞台", "Live Stage"),
                    subtitle: t("把雙 AI 直播的每一句話念出來，並用 VTube Studio 驅動 Live2D 表情與嘴型。一位說完才輪到下一位。",
                                "Speak every co-host line and drive Live2D expressions and lip sync through VTube Studio. One speaker at a time."))
                speechPanel
                vtsPanel
                ForEach(AgentKind.allCases) { agent in characterPanel(agent) }
                StudioNotice(message: t("AI 只能從固定的 8 種情緒中選擇；App 只觸發你在下方對應、且目前模型確實存在的熱鍵。VTube Studio 授權 Token 只存在本機加密資料中。聲音從系統預設輸出播放，OBS 擷取桌面音訊即可。",
                                        "Agents can only pick one of 8 fixed emotions; the app only fires hotkeys you mapped below that exist on the loaded model. The VTube Studio token stays in the local encrypted state. Audio plays on the default output for OBS desktop capture."))
            }
            .padding(26)
            .frame(maxWidth: 980, alignment: .leading)
        }
        .onAppear { if voices.isEmpty { voices = SpeechPlayer.voices() } }
    }

    private var speechPanel: some View {
        StudioPanel {
            VStack(alignment: .leading, spacing: 10) {
                Toggle(isOn: Binding(get: { settings.speechEnabled },
                                     set: { value in model.updateLiveStage { $0.speechEnabled = value } })) {
                    Label(t("直播時用語音念出發言（macOS 內建 TTS）", "Speak lines aloud (built-in macOS TTS)"),
                          systemImage: "waveform").font(.headline)
                }
                Text(t("想要更自然的中文聲音：系統設定 → 輔助使用 → 朗讀內容 → 系統聲音 → 管理聲音，下載「美佳（加強版）」等高品質語音後，回到這裡選擇。",
                       "For better voices: System Settings → Accessibility → Spoken Content → System Voice → Manage Voices, download an Enhanced/Premium voice, then pick it below."))
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private var vtsPanel: some View {
        StudioPanel {
            VStack(alignment: .leading, spacing: 10) {
                Toggle(isOn: Binding(get: { settings.vtsEnabled },
                                     set: { value in model.updateLiveStage { $0.vtsEnabled = value } })) {
                    Label(t("連接 VTube Studio（Live2D）", "Connect VTube Studio (Live2D)"),
                          systemImage: "person.crop.square.badge.camera").font(.headline)
                }
                Text(t("每位成員各開一個 VTube Studio、各自載入自己的模型。第一個從 Steam 開啟（連接埠 8001）；第二個執行 ~/Library/Application Support/Steam/steamapps/common/VTube Studio 裡的 start_without_steam，會自動使用下一個連接埠（8002）。兩個都要在設定開啟「Start API」，OBS 以兩個 NDI 來源分別擷取。",
                       "Each co-host runs its own VTube Studio with its own model. Start the first from Steam (port 8001); launch start_without_steam in ~/Library/Application Support/Steam/steamapps/common/VTube Studio for the second, which takes the next port (8002). Enable \"Start API\" in both; capture each in OBS as its own NDI source."))
                    .font(.caption).foregroundStyle(.secondary)
                if let warning = stage.lastWarning {
                    Label(warning, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange)
                }
            }
        }
    }

    private func vtsControls(_ agent: AgentKind, _ character: LiveCharacterStage) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Text(t("VTS 連接埠", "VTS port"))
                TextField("8001", value: Binding(get: { character.vtsPort },
                                                 set: { value in model.updateStageCharacter(agent) { $0.vtsPort = value } }),
                          format: .number.grouping(.never))
                    .frame(width: 80).textFieldStyle(.roundedBorder)
                Button(stage.isConnected(agent) ? t("重新連線", "Reconnect") : t("連線", "Connect")) { model.connectVTubeStudio(agent) }
                    .buttonStyle(.borderedProminent)
                    .disabled(!settings.vtsEnabled || stage.connection(agent) == .connecting)
                if stage.isConnected(agent) {
                    Button(t("重新讀取熱鍵", "Reload hotkeys")) { Task { await stage.refreshHotkeys(agent) } }
                    Button(t("中斷", "Disconnect")) { stage.disconnect(agent) }
                }
                Spacer()
                if !character.vtsToken.isEmpty {
                    Button(t("撤銷授權", "Forget token"), role: .destructive) { model.forgetVTubeStudioToken(agent) }
                        .font(.caption)
                }
            }
            connectionStatus(agent)
        }
    }

    @ViewBuilder private func connectionStatus(_ agent: AgentKind) -> some View {
        switch stage.connection(agent) {
        case .off:
            Label(t("未連線", "Not connected"), systemImage: "circle").font(.caption).foregroundStyle(.secondary)
        case .connecting:
            Label(t("連線中…若 VTube Studio 跳出 AIROOM Native 授權視窗，請按 Allow", "Connecting… click Allow on the AIROOM Native prompt in VTube Studio"),
                  systemImage: "hourglass").font(.caption)
        case .connected(let name):
            Label(t("已連線 · 模型：", "Connected · model: ") + (name.isEmpty ? t("（未載入）", "(none loaded)") : name)
                  + " · \(stage.hotkeys(agent).count) " + t("個熱鍵", "hotkeys"),
                  systemImage: "checkmark.circle.fill").font(.caption).foregroundStyle(.green)
        case .failed(let message):
            Label(message, systemImage: "xmark.octagon").font(.caption).foregroundStyle(.red)
        }
    }

    private func characterPanel(_ agent: AgentKind) -> some View {
        let character = settings.character(agent)
        let name = model.archive.members.first(where: { $0.agent == agent })?.name ?? agent.shortName
        return StudioPanel {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 10) {
                    StudioAvatar(agent: agent, size: 34)
                    Text(name).font(.headline)
                    Spacer()
                    if stage.speaking == agent {
                        Label(t("發言中", "Speaking"), systemImage: "speaker.wave.2.fill").font(.caption).foregroundStyle(agent.studioColor)
                    }
                    Button { model.rehearseStage(agent) } label: { Label(t("試演", "Rehearse"), systemImage: "play.circle") }
                        .disabled(model.liveActive || !settings.performs)
                }
                Picker(t("聲音", "Voice"), selection: Binding(get: { character.voiceIdentifier },
                        set: { value in model.updateStageCharacter(agent) { $0.voiceIdentifier = value } })) {
                    Text(t("系統預設", "System default")).tag("")
                    ForEach(voices, id: \.identifier) { voice in
                        Text("\(voice.name) · \(voice.language)\(voice.quality == .default ? "" : " ★")").tag(voice.identifier)
                    }
                }
                HStack(spacing: 18) {
                    slider(t("語速", "Rate"), value: character.speechRate, range: 0.3...0.65) { value in
                        model.updateStageCharacter(agent, persist: false) { $0.speechRate = value }
                    }
                    slider(t("音高", "Pitch"), value: character.pitch, range: 0.5...2.0) { value in
                        model.updateStageCharacter(agent, persist: false) { $0.pitch = value }
                    }
                }
                Divider()
                Toggle(t("這位有自己的 VTube Studio 形象", "This co-host has its own VTube Studio avatar"),
                       isOn: Binding(get: { character.drivesAvatar },
                                     set: { value in model.updateStageCharacter(agent) { $0.drivesAvatar = value } }))
                if character.drivesAvatar {
                    vtsControls(agent, character)
                    HStack {
                        Text(t("嘴型參數", "Mouth parameter"))
                        TextField("MouthOpen", text: Binding(get: { character.mouthParameter },
                                  set: { value in model.updateStageCharacter(agent) { $0.mouthParameter = value } }))
                            .frame(width: 160).textFieldStyle(.roundedBorder)
                        Text(t("VTS 預設輸入參數為 MouthOpen", "VTS default input is MouthOpen")).font(.caption).foregroundStyle(.secondary)
                    }
                    emotionGrid(agent, character)
                }
            }
        }
    }

    private func emotionGrid(_ agent: AgentKind, _ character: LiveCharacterStage) -> some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 210), spacing: 12)], alignment: .leading, spacing: 8) {
            ForEach(LiveEmotion.allCases.filter { $0 != .neutral }) { emotion in
                Picker(english ? emotion.rawValue : emotion.zhTitle, selection: Binding(
                    get: { character.emotionHotkeys[emotion.rawValue] ?? "" },
                    set: { value in model.updateStageCharacter(agent) { $0.emotionHotkeys[emotion.rawValue] = value.isEmpty ? nil : value } })) {
                    Text(t("不觸發", "None")).tag("")
                    // Keep a mapped ID selectable even while VTS is offline.
                    if let mapped = character.emotionHotkeys[emotion.rawValue],
                       !stage.hotkeys(agent).contains(where: { $0.id == mapped }) {
                        Text(t("（離線）", "(offline) ") + mapped.prefix(8)).tag(mapped)
                    }
                    ForEach(stage.hotkeys(agent)) { hotkey in Text("\(hotkey.name) · \(hotkey.type)").tag(hotkey.id) }
                }
            }
        }
        .font(.caption)
    }

    private func slider(_ title: String, value: Double, range: ClosedRange<Double>,
                        set: @escaping (Double) -> Void) -> some View {
        HStack {
            Text(title).frame(width: 40, alignment: .leading)
            Slider(value: Binding(get: { value }, set: set), in: range,
                   onEditingChanged: { editing in if !editing { model.saveLiveStage() } })
            Text(String(format: "%.2f", value)).monospacedDigit().font(.caption).frame(width: 36)
        }
    }
}
