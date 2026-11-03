import SwiftUI
import AIROOMCore

@main
struct AIROOMNativeApp: App {
    @StateObject private var workbench = WorkbenchModel()

    init() {
        // Every rebuild is signed ad hoc with a new identity, so restoring the
        // previous build's window state fails and SwiftUI then opened no
        // window at all. The single workbench window is simply recreated.
        UserDefaults.standard.register(defaults: ["NSQuitAlwaysKeepsWindows": false])
    }

    var body: some Scene {
        // One workbench window: a single scene can always be reopened from the
        // Window menu or the Dock, and never splits state across two windows.
        Window("AIROOM Native", id: "main") {
            ContentView()
                .environmentObject(workbench)
                .environment(\.locale, Locale(identifier: workbench.archive.settings.language.rawValue))
                .frame(minWidth: 840, minHeight: 560)
                // Daily opening: the first activation of each day (once the state is unlocked).
                .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
                    workbench.windowOpened()
                }
        }
        .defaultSize(width: 1180, height: 780)
        // Like upstream's tray icon: closing the window keeps AIROOM available here.
        MenuBarExtra("AIROOM", systemImage: workbench.anythingRunning ? "circle.hexagongrid.fill" : "circle.hexagongrid") {
            StudioMenuBar().environmentObject(workbench)
        }
        .commands {
            CommandGroup(replacing: .newItem) {
                Button(LocalizedUI.text("開始新對話", language: workbench.archive.settings.language)) { workbench.resetConversation(for: .claude) }
                    .keyboardShortcut("n", modifiers: .command)
            }
        }
    }
}

struct StudioMenuBar: View {
    @EnvironmentObject private var model: WorkbenchModel
    @Environment(\.openWindow) private var openWindow
    private func t(_ zh: String, _ en: String) -> String { StudioI18n.t(zh, en, model.archive.settings.language) }

    var body: some View {
        ForEach(AgentKind.allCases) { agent in
            Text("\(model.memberName(agent))：" + (model.busyAgents.contains(agent) ? t("工作中", "Working") : t("空閒", "Idle")))
        }
        if model.roomRunning { Text(t("茶歇室討論中", "Lounge is talking")) }
        if !model.attentionItems.isEmpty {
            Text(t("\(model.attentionItems.count) 項待你處理", "\(model.attentionItems.count) items need you"))
        }
        Divider()
        Button(t("打開 AIROOM 工作室", "Open AIROOM")) {
            openWindow(id: "main")
            NSApp.activate(ignoringOtherApps: true)
        }
        Button(t("全部中止", "Stop All")) { model.stopAll() }
            .disabled(!model.anythingRunning)
        Divider()
        Button(t("結束 AIROOM", "Quit AIROOM")) { NSApp.terminate(nil) }
            .keyboardShortcut("q")
    }
}
