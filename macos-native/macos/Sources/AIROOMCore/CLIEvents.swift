import Foundation

/// Convert each vendor's official JSONL output into displayable final text.
/// Do not show tool calls or raw JSON events as if they were assistant answers.
public struct CLIEventAccumulator {
    public let agent: AgentKind
    public private(set) var text = ""
    public private(set) var failure: String?
    /// Model reported by the CLI itself (Claude's `system/init` event).
    public private(set) var model: String?
    /// Claude's session ID for this run (continue it with --resume).
    public private(set) var sessionID: String?
    /// The run ended in error without a single model turn (e.g. a missing session).
    public private(set) var endedBeforeModel = false
    private var claudeDeltas = ""

    public init(agent: AgentKind) { self.agent = agent }

    @discardableResult public mutating func consume(line: String) -> String? {
        guard let data = line.data(using: .utf8),
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = value["type"] as? String else { return nil }

        switch agent {
        case .codex:
            if ["item.completed", "item.updated"].contains(type),
               let item = value["item"] as? [String: Any],
               item["type"] as? String == "agent_message",
               let content = item["text"] as? String {
                text = content
                return text
            }
            if type == "error" || type == "turn.failed" {
                let source = (value["error"] as? [String: Any])?["message"] as? String
                failure = source ?? (value["message"] as? String) ?? "Codex 執行失敗"
            }
        case .claude:
            if let session = value["session_id"] as? String, !session.isEmpty { sessionID = session }
            if type == "system", value["subtype"] as? String == "init", let name = value["model"] as? String {
                model = name
                return nil
            }
            if type == "stream_event", let event = value["event"] as? [String: Any],
               event["type"] as? String == "content_block_delta",
               let delta = event["delta"] as? [String: Any],
               delta["type"] as? String == "text_delta",
               let part = delta["text"] as? String {
                claudeDeltas += part
                text = claudeDeltas
                return text
            }
            if type == "assistant", let message = value["message"] as? [String: Any],
               let blocks = message["content"] as? [[String: Any]] {
                let completed = blocks.compactMap { block -> String? in
                    guard block["type"] as? String == "text" else { return nil }
                    return block["text"] as? String
                }.joined(separator: "\n")
                if !completed.isEmpty { text = completed; return text }
            }
            if type == "result" {
                // An error result carries its reason (e.g. a usage limit) in
                // `result`; it must never be mistaken for an answer.
                if value["is_error"] as? Bool == true {
                    endedBeforeModel = (value["num_turns"] as? Int) == 0 && (value["duration_api_ms"] as? Int) == 0
                    let reason = (value["result"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                    failure = reason ?? (value["subtype"] as? String).map { "Claude 執行失敗：\($0)" } ?? "Claude 執行失敗"
                    return nil
                }
                if let result = value["result"] as? String, !result.isEmpty {
                    text = result
                    return text
                }
            }
        }
        return nil
    }
}
