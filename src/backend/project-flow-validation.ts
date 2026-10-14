import type { Store } from "./store";
import type { Run, Session } from "../shared/types";
import {
  FlowError,
  type Evidence,
  type FlowOperation,
  type Task,
  type RoundReport,
} from "../shared/project-flow";
import {
  validateReview,
  validateReport,
  pathWithin,
} from "../shared/project-flow-protocol";
import { commandEvidenceProblem } from "../shared/project-flow-review";
import { bindSourceEvidence } from "./source-evidence";
import { bindFlowEvidence, eventCommand } from "./project-flow-evidence";
import { roundMeetingMaterial } from "./project-flow-room";
/** Binds claims to actual recorded activity and validates meeting references. */
export class FlowValidation {
  constructor(private store: Store) {}
  private need<T>(entity: string, id: string): T {
    const value = this.store.get<T>(entity, id);
    if (!value) throw new FlowError("NOT_FOUND", "记录不存在，请刷新项目。");
    return value;
  }
  bindEvidence(evidence: Evidence[], runId: string, originalRunId?: string) {
    const run = this.store.get<Run>("runs", runId),
      session = run
        ? this.store.get<Session>("sessions", run.sessionId)
        : undefined;
    return bindSourceEvidence(
      bindFlowEvidence(
        evidence,
        this.store.eventsForRuns([runId,originalRunId]),
        originalRunId ? [runId, originalRunId] : [runId],
      ),
      session?.workspace,
    );
  }
  reviewEvidence(
    payload: ReturnType<typeof validateReview>,
    op: FlowOperation,
    runId: string,
  ) {
    const original = this.need<FlowOperation>("flow_operations", op.id).runId,
      bound = this.bindEvidence(payload.evidence, runId, original);
    // Missing presentation metadata is accepted; assessReview retains an unverified outcome.
    const problems = bound.filter((e) => !e.commandKindInferred && commandEvidenceProblem(e));
    if (payload.verdict === "pass" && problems.length) {
      const messages = problems.map((e) => {
        const command = JSON.stringify((e.command ?? "").slice(0, 160)),
          problem = commandEvidenceProblem(e);
        if (problem === "exit-code-mismatch")
          return (
            "退出码不一致：" +
            command +
            "；成员填写 " +
            e.exitCode +
            "，实际记录为 " +
            e.observedExitCode +
            "。请依据真实结果填写，不能据此通过复核。"
          );
        if (problem === "failed-execution")
          return (
            "执行结果矛盾：" +
            command +
            "；原生记录显示执行失败，不能填写退出码 0 并据此通过复核。"
          );
        return (
          "命令缺少实际完成事件：" +
          command +
          "。请逐字填写实际运行过的 command，并确认对应工具已完成；概括或改写的检查请使用 inspection。"
        );
      });
      if (
        problems.some((e) => commandEvidenceProblem(e) === "missing-completion")
      ) {
        const ran = [
          ...new Set(
            this.store
              .eventsForRuns([runId, original])
              .filter(
                (e) =>
                  [runId, original].includes(e.runId) &&
                  e.fidelity === "native" &&
                  e.kind === "tool",
              )
              .map(eventCommand)
              .filter((c): c is string => typeof c === "string" && Boolean(c)),
          ),
        ].slice(0, 12);
        messages.push(
          ran.length
            ? "本轮记录的命令：" +
                ran.map((c) => JSON.stringify(c.slice(0, 200))).join("、") +
                "。"
            : "本轮没有记录到实际运行的命令。",
        );
      }
      throw new FlowError("UNVERIFIED_EVIDENCE", messages.join("\n"));
    }
    return bound;
  }
  validateMeetingReport(
    raw: unknown,
    meeting: ReturnType<typeof roundMeetingMaterial>,
    tasks: Task[],
  ): RoundReport {
    const report = validateReport(raw),
      responses = report.meetingResponses ?? [],
      expected = meeting.pendingUserMessages.map((message) => message.id);
    if (
      new Set(report.completedTaskKeys).size !== tasks.length ||
      report.completedTaskKeys.some((key) => !tasks.some((t) => t.key === key))
    )
      throw new FlowError(
        "INVALID_PROTOCOL",
        "completedTaskKeys 必须逐项填写本轮实际任务 key：" +
          tasks.map((t) => t.key).join("、"),
      );
    if (
      responses.length !== expected.length ||
      new Set(responses.map((response) => response.messageId)).size !==
        responses.length ||
      responses.some((response) => !expected.includes(response.messageId))
    )
      throw new FlowError(
        "INVALID_PROTOCOL",
        "汇报必须逐条处理本轮尚未处理的用户会议发言，不得遗漏或虚构关联。",
      );
    for (const response of responses)
      if (response.disposition === "in-scope-fix") {
        if (!response.paths.length)
          throw new FlowError(
            "INVALID_PROTOCOL",
            "会议要求的范围内修正必须列出实际修改路径。",
          );
        if (
          response.paths.some(
            (path) =>
              !tasks.some((task) =>
                task.allowedPaths.some((scope) => pathWithin(path, scope)),
              ),
          )
        )
          response.disposition = "scope-change";
      }
    return report;
  }
}
