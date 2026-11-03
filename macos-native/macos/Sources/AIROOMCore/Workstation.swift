import Foundation

// MARK: Call usage — counted receipts, as upstream AIROOM shows them:
// "累計嘗試 N 次 · 已發出 N 次 · 已完成 N 次", plus not-sent and unknown results.

/// `notReached`: it was handed to the CLI, which refused it before reaching the model
/// (e.g. a conversation that can no longer be continued) — counted as not sent.
public enum CallEvent: Sendable { case attempt, delivered, completed, notSent, unknown, notReached }

public struct CallUsage: Codable, Equatable, Sendable {
    public var total = 0
    public var delivered = 0
    public var completed = 0
    public var notSent = 0
    public var unknown = 0
    public init() {}

    public mutating func record(_ event: CallEvent) {
        switch event {
        case .attempt: total += 1
        case .delivered: delivered += 1
        case .completed: completed += 1
        case .notSent: notSent += 1
        case .unknown: unknown += 1
        case .notReached: delivered = max(0, delivered - 1); notSent += 1
        }
    }

    public static func + (a: CallUsage, b: CallUsage) -> CallUsage {
        var sum = CallUsage()
        sum.total = a.total + b.total; sum.delivered = a.delivered + b.delivered
        sum.completed = a.completed + b.completed; sum.notSent = a.notSent + b.notSent
        sum.unknown = a.unknown + b.unknown
        return sum
    }

    /// AIROOM's own request count — not the subscription bill.
    public func label(_ language: InterfaceLanguage) -> String {
        var text = language == .english
            ? "Attempted \(total) · Sent \(delivered) · Completed \(completed)"
            : "累計嘗試 \(total) 次 · 已發出 \(delivered) 次 · 已完成 \(completed) 次"
        if notSent > 0 { text += language == .english ? " · Not sent \(notSent)" : " · 未發出失敗 \(notSent) 次" }
        if unknown > 0 { text += language == .english ? " · Unknown \(unknown)" : " · 結果未知 \(unknown) 次" }
        return text
    }
}

/// Per member, per day; old days are pruned so the state file stays small.
public struct CallLedger: Codable, Equatable, Sendable {
    public var days: [String: [String: CallUsage]] = [:] // agent → day → usage
    public init() {}

    public mutating func record(_ event: CallEvent, agent: AgentKind, day: String, keepDays: Int = 60) {
        days[agent.rawValue, default: [:]][day, default: CallUsage()].record(event)
        if let byDay = days[agent.rawValue], byDay.count > keepDays {
            for key in byDay.keys.sorted().prefix(byDay.count - keepDays) { days[agent.rawValue]?[key] = nil }
        }
    }

    public func usage(_ agent: AgentKind, day: String? = nil) -> CallUsage {
        let byDay = days[agent.rawValue] ?? [:]
        if let day { return byDay[day] ?? CallUsage() }
        return byDay.values.reduce(CallUsage(), +)
    }
}

// MARK: Needs-attention list (navigation only; opening an item never answers,
// resends, merges or accepts anything).

public enum AttentionKind: String, Sendable { case question, decision, unknown, login, missing, acceptance }

public struct AttentionItem: Identifiable, Equatable, Sendable {
    public enum Target: Equatable, Sendable { case room(UUID), roundtable(UUID), project(UUID), settings, member(AgentKind), memberCard(AgentKind) }
    public var id: String
    public var kind: AttentionKind
    public var title: String
    public var detail: String
    public var target: Target

    /// The version shown now. An ignored item comes back once this changes.
    public var fingerprint: String { "\(kind.rawValue)|\(title)|\(detail)" }
}

public enum AttentionBuilder {
    /// Items not ignored in their current version.
    public static func visible(_ items: [AttentionItem], dismissed: [String: String]) -> [AttentionItem] {
        items.filter { dismissed[$0.id] != $0.fingerprint }
    }

    /// Ignoring only hides the reminder; the work it points to is unchanged. Records of
    /// items that no longer exist are dropped.
    public static func dismissing(_ item: AttentionItem, among items: [AttentionItem], dismissed: [String: String]) -> [String: String] {
        let live = Set(items.map(\.id))
        var next = dismissed.filter { live.contains($0.key) }
        if live.contains(item.id) { next[item.id] = item.fingerprint }
        return next
    }

    public static func items(state: SavedState, cli: [AgentKind: OfficialCLIStatus]) -> [AttentionItem] {
        var items: [AttentionItem] = []
        let name = { (agent: AgentKind) in state.members.first(where: { $0.agent == agent })?.name ?? agent.rawValue }
        for agent in AgentKind.allCases where state.members.contains(where: { $0.agent == agent && $0.enabled }) {
            switch cli[agent] {
            case .notLoggedIn:
                items.append(AttentionItem(id: "login-\(agent.rawValue)", kind: .login, title: "\(name(agent)) 需要登入",
                    detail: "官方 CLI 尚未登入，成員暫時無法回覆。", target: .settings))
            case .missingExecutable:
                items.append(AttentionItem(id: "missing-\(agent.rawValue)", kind: .missing, title: "\(name(agent)) 缺少程式",
                    detail: "找不到官方 CLI，請在設定指定路徑或安裝。", target: .settings))
            default: break
            }
        }
        for member in state.members where !member.memoryProposals.isEmpty {
            items.append(AttentionItem(id: "memory-\(member.agent.rawValue)", kind: .decision,
                title: "\(member.name) 提議了 \(member.memoryProposals.count) 條記憶",
                detail: member.memoryProposals.first?.text ?? "", target: .memberCard(member.agent)))
        }
        for room in state.rooms {
            let target: AttentionItem.Target = room.roundtableID.map { .roundtable($0) }
                ?? room.projectID.map { .project($0) } ?? .room(room.id)
            for question in room.lounge.pendingQuestions {
                items.append(AttentionItem(id: "q-\(question.id)", kind: .question, title: "\(name(question.from)) 在「\(room.title)」問你",
                    detail: String(question.text.prefix(140)), target: target))
            }
            if room.lounge.phase == .awaitingHost {
                items.append(AttentionItem(id: "pick-\(room.id)", kind: .decision, title: "「\(room.title)」有人舉手",
                    detail: "請點名誰補充，或讓大家等你說話。", target: target))
            }
            // Only the latest member reply counts: an older failure was already seen.
            if let last = room.entries.last(where: { $0.speaker == .assistant }),
               last.delivery == .failed {
                items.append(AttentionItem(id: "unknown-\(last.id)", kind: .unknown, title: "「\(room.title)」有結果待核對",
                    detail: "\(last.displayName) 的回覆沒有確認完成，沒有自動重送。", target: target))
            }
        }
        for topic in state.roundtableTopics {
            if topic.status == .prepared {
                items.append(AttentionItem(id: "rt-reveal-\(topic.id)", kind: .decision, title: "圓桌「\(topic.title)」準備完成",
                    detail: "大家都交了，可以公開並開始審議。", target: .roundtable(topic.id)))
            } else if topic.status == .conclusion {
                items.append(AttentionItem(id: "rt-confirm-\(topic.id)", kind: .acceptance, title: "圓桌「\(topic.title)」等你確認結論",
                    detail: "會議紀要已整理，請確認結論。", target: .roundtable(topic.id)))
            }
        }
        for flow in state.projectFlows {
            let target = AttentionItem.Target.project(flow.id)
            if flow.step == .plan {
                items.append(AttentionItem(id: "flow-plan-\(flow.id)", kind: .decision, title: "專案「\(flow.title)」的方案等你確認",
                    detail: "看過方案後按「確認方案，開工」，或要求修改。", target: target))
            } else if let round = flow.activeRound, round.status == .awaitingAcceptance {
                items.append(AttentionItem(id: "flow-accept-\(round.id)", kind: .acceptance, title: "專案「\(flow.title)」：\(round.title) 等你驗收",
                    detail: "查看成品和改動，選擇通過或駁回。", target: target))
            } else if flow.step == .executing, let round = flow.activeRound, round.status == .pending {
                items.append(AttentionItem(id: "flow-next-\(round.id)", kind: .decision, title: "專案「\(flow.title)」：下一輪等你開始",
                    detail: "按原計劃開始，或要求修改方案。", target: target))
            } else if let task = flow.plan?.tasks.first(where: { $0.status == .disputed }) {
                items.append(AttentionItem(id: "flow-dispute-\(task.id)", kind: .decision, title: "專案「\(flow.title)」：「\(task.title)」的複核異議等你裁定",
                    detail: "逐條選擇支持作者或維持複核。", target: target))
            } else if let wait = flow.quotaWaits.first {
                items.append(AttentionItem(id: "flow-quota-\(wait.id)-\(wait.ready)", kind: .decision,
                    title: wait.ready ? "專案「\(flow.title)」：\(wait.agent.rawValue) 的額度應該恢復了" : "專案「\(flow.title)」：\(wait.agent.rawValue) 的額度用完了",
                    detail: wait.ready ? "按「接著做」繼續，不會自動重送。" : "可以等恢復、換人接手，其他成員的任務照常進行。", target: target))
            } else if flow.paused, flow.plan?.tasks.contains(where: { $0.status == .failed }) == true {
                items.append(AttentionItem(id: "flow-failed-\(flow.id)", kind: .unknown, title: "專案「\(flow.title)」有任務沒有完成",
                    detail: "檢查原因後可以繼續，沒有自動重送。", target: target))
            }
        }
        for project in state.projects where project.phase == .reviewing || project.phase == .failed {
            items.append(AttentionItem(id: "project-\(project.id)", kind: project.phase == .reviewing ? .acceptance : .unknown,
                title: project.title, detail: project.phase == .reviewing ? "變更待驗收" : "執行失敗，請檢查結果",
                target: .project(project.id)))
        }
        return items
    }
}

// MARK: Signing in through the official CLI, in the user's own Terminal.

public enum LoginScript {
    /// A `.command` file Terminal runs. It contains only the CLI's own login
    /// command; AIROOM never sees or stores what the user types.
    public static func contents(agent: AgentKind, executable: URL) -> String {
        let quoted = "'" + executable.path.replacingOccurrences(of: "'", with: "'\\''") + "'"
        let command = agent == .claude ? "\(quoted) auth login" : "\(quoted) login"
        return """
        #!/bin/zsh
        echo "AIROOM：用官方程式登入 \(agent.rawValue)"
        echo
        \(command)
        echo
        echo "完成後可以關閉這個視窗，回到 AIROOM 按「重新檢查」。"
        """
    }
}
