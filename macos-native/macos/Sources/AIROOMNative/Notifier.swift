import AppKit
import UserNotifications

/// System notifications while AIROOM is in the background (a member finished,
/// asked you something, or is waiting for you), plus a Dock bounce.
@MainActor
enum Notifier {
    private static var authorized: Bool?

    static func post(_ title: String, _ body: String) {
        guard !NSApp.isActive else { return }
        NSApp.requestUserAttention(.informationalRequest)
        let center = UNUserNotificationCenter.current()
        let deliver = {
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = String(body.prefix(160))
            center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
        }
        if authorized == true { deliver(); return }
        if authorized == false { return }
        // Asked once, the first time there is something to tell.
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            Task { @MainActor in
                authorized = granted
                if granted { deliver() }
            }
        }
    }
}
