import Foundation

// MARK: Project room extras, after upstream AIROOM's project flow:
// - tasks whose files don't overlap run side by side (one task per member);
// - an author may dispute review findings on a fix; the owner rules on each;
// - a member whose quota ran out waits with a reset time. Nothing is re-sent
//   by itself: the owner presses 接著做 or hands the work to another member.

/// One review finding, with an id the author can dispute.
public struct FlowFinding: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var severity: String
    public var location: String
    public var request: String
    public init(id: String, severity: String, location: String, request: String) {
        self.id = id; self.severity = String(severity.prefix(20)); self.location = String(location.prefix(300))
        self.request = String(request.prefix(1_500))
    }
    public var line: String { "[\(id)][\(severity)] \(location.isEmpty ? "" : location + "：")\(request)" }
}

public struct FlowDispute: Codable, Equatable, Sendable {
    public var findingID: String
    public var reason: String
    public init(findingID: String, reason: String) { self.findingID = findingID; self.reason = String(reason.prefix(1_500)) }
}

public enum FlowVerdict: String, Codable, Sendable {
    /// 支持作者: the finding is dropped. 維持複核: the author must fix it.
    case author, review
}

public struct FlowRuling: Codable, Equatable, Sendable {
    public var finding: FlowFinding
    public var reason: String
    public var verdict: FlowVerdict
    public var at: Date
    public init(finding: FlowFinding, reason: String, verdict: FlowVerdict, at: Date = .now) {
        self.finding = finding; self.reason = reason; self.verdict = verdict; self.at = at
    }
}

public struct FlowReview: Equatable, Sendable {
    public var pass: Bool
    public var summary: String
    public var findings: [FlowFinding]
    public var text: String { findings.isEmpty ? summary : findings.map { "- " + $0.line }.joined(separator: "\n") }
}

/// A member whose quota ran out while working on this flow.
public struct FlowQuotaWait: Codable, Equatable, Identifiable, Sendable {
    public var id: UUID
    public var agent: AgentKind
    /// What was being done (e.g. 執行任務「…」).
    public var stage: String
    public var since: Date
    /// When the official quota says it resets, if known.
    public var resetAt: Date?
    /// The reset time passed (or a fresh quota sample shows room); the owner was told.
    public var ready: Bool
    public var message: String
    public init(id: UUID = UUID(), agent: AgentKind, stage: String, since: Date = .now, resetAt: Date? = nil, message: String) {
        self.id = id; self.agent = agent; self.stage = String(stage.prefix(200)); self.since = since
        self.resetAt = resetAt; ready = false
        // The `|<unix seconds>` reset hint is read into resetAt; it isn't for reading.
        self.message = String(message.replacingOccurrences(of: #"\|\d{9,}"#, with: "", options: .regularExpression).prefix(600))
    }
}

public enum QuotaSignal {
    /// Whether a failed run says the member's usage limit was reached.
    public static func isQuotaFailure(_ message: String) -> Bool {
        let text = message.lowercased()
        return ["usage limit", "usagelimitexceeded", "rate limit", "rate_limit", "limit reached", "hit your limit",
                "hit your usage", "session limit", "weekly limit", "quota exceeded", "額度已用完", "额度已用完"]
            .contains { text.contains($0) }
    }

    /// A reset time some CLIs append as `…|<unix seconds>`.
    public static func resetHint(_ message: String, now: Date = .now) -> Date? {
        guard let bar = message.lastIndex(of: "|") else { return nil }
        let digits = message[message.index(after: bar)...].prefix { $0.isNumber }
        guard digits.count >= 9, let seconds = Double(digits) else { return nil }
        let date = Date(timeIntervalSince1970: seconds > 1e12 ? seconds / 1000 : seconds)
        return date > now && date < now.addingTimeInterval(14 * 86_400) ? date : nil
    }

    /// The latest future reset among the windows that are used up.
    public static func resetAt(_ quota: AccountQuota?, now: Date = .now) -> Date? {
        quota?.windows.filter(\.exhausted).compactMap(\.resetsAt).filter { $0 > now }.max()
    }

    /// A fresh official sample says this member has no quota left (and that window hasn't reset since).
    public static func blocks(_ quota: AccountQuota?, now: Date = .now) -> Bool {
        guard let quota, quota.status == .ready, quota.isFresh(at: now) else { return false }
        return quota.windows.contains { $0.exhausted && ($0.resetsAt.map { $0 > now } ?? true) }
    }

    /// The reset time passed, or a sample taken after the wait began shows room again.
    public static func recovered(_ wait: FlowQuotaWait, quota: AccountQuota?, now: Date = .now) -> Bool {
        if let reset = wait.resetAt, now >= reset { return true }
        guard let quota, quota.status == .ready, quota.checkedAt > wait.since, quota.isFresh(at: now) else { return false }
        return !quota.windows.contains(where: \.exhausted)
    }
}

extension ProjectFlowEngine {
    public static let maxWaivers = 2

    /// Relative, cleaned paths; "." or "" stands for the whole project.
    public static func normalizedPaths(_ paths: [String]) -> [String] {
        var seen: [String] = []
        for raw in paths.prefix(20) {
            var path = raw.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "\\", with: "/")
            while path.hasPrefix("./") { path.removeFirst(2) }
            while path.hasPrefix("/") { path.removeFirst() }
            while path.hasSuffix("/") { path.removeLast() }
            if path.isEmpty { path = "." }
            path = String(path.prefix(300))
            if !seen.contains(path) { seen.append(path) }
        }
        return seen
    }

    /// Two file lists may touch the same file. An empty list means "unknown", which overlaps everything.
    public static func filesOverlap(_ a: [String], _ b: [String]) -> Bool {
        guard !a.isEmpty, !b.isEmpty else { return true }
        for x in a {
            for y in b where x == "." || y == "." || x == y || x.hasPrefix(y + "/") || y.hasPrefix(x + "/") { return true }
        }
        return false
    }

    /// Tasks that can start now next to `active`: their dependencies are done, their member
    /// isn't busy or out of quota, and their files don't overlap anything running.
    public static func readyTasks(in round: FlowRound, plan: FlowPlan, active: Set<UUID>, maxParallel: Int,
                                  unavailable: Set<AgentKind> = []) -> [FlowTask] {
        let done = Set(plan.tasks.filter { $0.status == .done }.map(\.key))
        var running = plan.tasks.filter { active.contains($0.id) }
        var picked: [FlowTask] = []
        for task in plan.tasks(in: round) where [.pending, .fixing, .reviewing].contains(task.status) && !active.contains(task.id) {
            guard running.count < min(3, max(1, maxParallel)) else { break }
            // A task waiting for review needs its reviewer, not its author.
            let worker = task.status == .reviewing ? (task.reviewer ?? task.member) : task.member
            guard task.dependencies.allSatisfy(done.contains), !unavailable.contains(worker),
                  !running.contains(where: { $0.member == task.member }),
                  running.allSatisfy({ !filesOverlap($0.files, task.files) }) else { continue }
            picked.append(task)
            running.append(task)
        }
        return picked
    }

    /// Reads a reviewer's JSON verdict; findings get ids f1, f2, … for disputes.
    public static func parseReview(_ text: String) -> FlowReview {
        guard let object = LoungeEngine.jsonObject(in: text) else {
            let lowered = text.lowercased()
            return FlowReview(pass: lowered.contains("verdict: pass") || text.contains("通過"), summary: text, findings: [])
        }
        let verdict = ((object["verdict"] as? String) ?? "").lowercased()
        var findings: [FlowFinding] = []
        for item in ((object["findings"] as? [Any]) ?? []).prefix(30) {
            let id = "f\(findings.count + 1)"
            if let line = item as? String {
                findings.append(FlowFinding(id: id, severity: "should-fix", location: "", request: line))
            } else if let dict = item as? [String: Any] {
                findings.append(FlowFinding(id: id, severity: (dict["severity"] as? String) ?? "should-fix",
                                            location: (dict["location"] as? String) ?? "",
                                            request: (dict["request"] as? String) ?? (dict["text"] as? String) ?? ""))
            }
        }
        return FlowReview(pass: verdict == "pass", summary: (object["summary"] as? String) ?? "", findings: findings)
    }

    static let disputeMarker = "AIROOM_DISPUTES:"

    /// Splits an author's fix report from the disputes line at its end. Only open,
    /// not-yet-ruled findings can be disputed, each once.
    public static func parseDisputes(_ text: String, open: [FlowFinding], ruled: [FlowRuling]) -> (summary: String, disputes: [FlowDispute]) {
        guard let range = text.range(of: disputeMarker, options: .backwards) else { return (text, []) }
        let summary = String(text[..<range.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
        guard let object = LoungeEngine.jsonObject(in: String(text[range.upperBound...])) else { return (summary, []) }
        let allowed = Set(open.map(\.id)).subtracting(ruled.map(\.finding.id))
        var disputes: [FlowDispute] = []
        for item in ((object["disputes"] as? [[String: Any]]) ?? []) {
            let id = ((item["finding"] as? String) ?? (item["findingId"] as? String) ?? "").trimmingCharacters(in: .whitespaces)
            let reason = ((item["reason"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard allowed.contains(id), !reason.isEmpty, !disputes.contains(where: { $0.findingID == id }) else { continue }
            disputes.append(FlowDispute(findingID: id, reason: reason))
        }
        return (summary, disputes)
    }

    /// Applies the owner's rulings. A ruling for the author gives one return back (at most
    /// `maxWaivers` per task); findings upheld for the review go back to the author to fix.
    public static func applyRulings(_ task: inout FlowTask, verdicts: [String: FlowVerdict], at now: Date = .now) {
        let disputed = task.disputes.filter { verdicts[$0.findingID] != nil }
        guard !disputed.isEmpty, disputed.count == task.disputes.count else { return }
        var upheld: [FlowFinding] = []
        var forAuthor = false
        for dispute in disputed {
            guard let finding = task.openFindings.first(where: { $0.id == dispute.findingID }),
                  let verdict = verdicts[dispute.findingID] else { continue }
            task.rulings.append(FlowRuling(finding: finding, reason: dispute.reason, verdict: verdict, at: now))
            if verdict == .review { upheld.append(finding) } else { forAuthor = true }
        }
        if forAuthor, task.returns > 0, task.waivers < maxWaivers { task.returns -= 1; task.waivers += 1 }
        task.disputes = []
        if upheld.isEmpty {
            task.openFindings = []
            task.findings = ""
            task.status = .reviewing
        } else {
            task.openFindings = upheld
            task.findings = upheld.map { "- " + $0.line }.joined(separator: "\n")
            task.status = .fixing
        }
    }
}
