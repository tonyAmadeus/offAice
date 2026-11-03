import AppKit
import Foundation
import AIROOMCore

@MainActor
extension WorkbenchModel {
    /// Opens the vendor desktop application's official *new Code session* flow.
    /// AIROOM's conversation text, local encrypted state and credentials are
    /// intentionally never forwarded, and this does not claim session sync.
    func openVendorDesktop(for agent: AgentKind) {
        do {
            let url = try DesktopAppHandoff.newCodeSession(
                agent: agent,
                selectedWorkspace: archive.settings.workspacePath
            )
            guard NSWorkspace.shared.urlForApplication(toOpen: url) != nil else {
                statusMessage = archive.settings.language == .english
                    ? "The official \(agent == .codex ? "Codex" : "Claude") desktop app is not installed or its link handler is unavailable."
                    : "找不到 \(agent == .codex ? "Codex" : "Claude") 桌面 App，或其連結協定尚未註冊。"
                return
            }
            if !NSWorkspace.shared.open(url) {
                statusMessage = archive.settings.language == .english
                    ? "Unable to open the official desktop app."
                    : "無法開啟官方桌面 App。"
            }
        } catch {
            statusMessage = error.localizedDescription
        }
    }

    private func recordOfficialCLIStatus(_ status: OfficialCLIStatus, for agent: AgentKind) {
        officialCLIStatuses[agent] = status
    }

    func checkVendorCLIAccount(for agent: AgentKind) {
        guard officialCLIStatuses[agent] != .checking else { return }
        officialCLIStatuses[agent] = .checking
        let settings = archive.settings
        Task.detached(priority: .userInitiated) { [weak self] in
            let outcome = OfficialCLIProbe.check(agent: agent, settings: settings)
            await self?.recordOfficialCLIStatus(outcome, for: agent)
        }
    }
}
