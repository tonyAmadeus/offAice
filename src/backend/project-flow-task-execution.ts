import type { Session, RoomId } from "../shared/types";
import {
  FlowError,
  type FlowRecord,
  type ProjectFlow,
  type Task,
  type Round,
  type Decision,
  type Submission,
  type Review,
  type FlowOperation,
  type Evidence,
  type ReviewFinding,
  type ReviewLevel,
} from "../shared/project-flow";
import { flowPrompt, pathWithin, validateSubmission } from "../shared/project-flow-protocol";
import { memberCriteria } from "../shared/project-flow-review";
import type { Store } from "./store";
import type { FlowArtifacts } from "./project-flow-artifacts";
import { assertProjectBoundary, assertProjectSerial, assertProjectPaths } from "./project-access";
import { acceptedMeetingBackground, markRoomRead } from "./project-flow-room";
import { requirementsRevision } from "./project-flow-supplements";

export interface FlowTaskExecutionHost {
  readonly store: Store;
  readonly artifacts: FlowArtifacts;
  flow(id: string): ProjectFlow;
  need<T>(entity: string, id: string): T;
  update<T extends FlowRecord>(entity: string, item: T, patch: Partial<T>): T;
  session(projectId: string, memberId: string, title: string, write: boolean): Session;
  operation(flow: ProjectFlow, kind: string, target: FlowRecord, sessionId?: string): FlowOperation;
  protocol<T>(
    op: FlowOperation,
    kind: string,
    prompt: string,
    validate: (raw: unknown, runId: string) => T,
  ): Promise<{ payload: T; runId: string }>;
  disputeFindings(task: Task): ReviewFinding[];
  validOperation(op: FlowOperation, runId: string): boolean;
  settleSupplements(taskId: string): Promise<unknown>;
  record(projectId: string, flowId: string): FlowRecord;
  bindEvidence(evidence: Evidence[], runId: string): Evidence[];
  taskLevel(task: Task): ReviewLevel;
  decision(
    flow: ProjectFlow,
    kind: Decision["kind"],
    task: Task,
    title: string,
    reason: string,
  ): Decision;
  supersededOperation(op: FlowOperation): boolean;
  failOperation(op: FlowOperation, error: unknown): void;
  adjudicateTask(task: Task, submission: Submission): Promise<unknown>;
  skipTaskReview(task: Task): boolean;
  reviewTask(task: Task, submission: Submission): Promise<unknown>;
}

/** Prepare dependency inputs, run the task, and capture a submission before handing off review. */
export async function executeFlowTask(host: FlowTaskExecutionHost, initial: Task) {
  const flow = host.flow(initial.flowId);
  let task = host.need<Task>("flow_tasks", initial.id);
  assertProjectBoundary(host.store, flow.projectId, flow.writeBoundary);
  assertProjectSerial(host.store, flow.projectId);
  assertProjectPaths(host.store, flow.projectId, task.allowedPaths);
  if (flow.dispatchMode !== "running") {
    host.update("flow_tasks", task, { status: "pending" });
    return;
  }
  let session: Session;
  if (task.sessionId)
    session = host.need<Session>("sessions", task.sessionId);
  else {
    const round = host.need<Round>("flow_rounds", task.roundId),
      base = host.artifacts.get(
        (task.startBase ?? round.baseVersion)!.artifactId,
      ),
      work = await host.artifacts.capture(
        flow,
        base.root,
        "task-base",
        base.id,
        base.fingerprint,
      );
    // Accepted earlier rounds, including their integration repairs, are already in this base.
    // An early copy inherits the permission's source round base; that round's pending submissions still need merging.
    const inputRound = task.earlyDecisionId
      ? host.need<Round>(
          "flow_rounds",
          host.need<Decision>("flow_decisions", task.earlyDecisionId)
            .roundId!,
        )
      : round;
    const includedRounds = new Set(
      host.store
        .list<Round>("flow_rounds")
        .filter(
          (r) =>
            r.flowId === flow.id &&
            r.planId === task.planId &&
            r.index < inputRound.index &&
            r.status === "accepted",
        )
        .map((r) => r.id),
    );
    // The whole dependency chain in order: a predecessor's change is relative to a base that already holds its own
    // predecessors (2026-10-06: A -> B -> C on one file; merging only B into C's copy conflicted). Applied content is skipped.
    const chain: Task[] = [],
      seen = new Set<string>(),
      visit = (id: string) => {
        if (seen.has(id)) return;
        seen.add(id);
        const t = host.need<Task>("flow_tasks", id);
        if (includedRounds.has(t.roundId)) return;
        t.dependencies.forEach(visit);
        chain.push(t);
      };
    task.dependencies.forEach(visit);
    for (const predecessor of chain) {
      const submission = host.need<Submission>(
        "flow_submissions",
        predecessor.latestSubmissionId!,
      );
      const conflicts = await host.artifacts.merge(
        work.root,
        host.artifacts.get(submission.version.artifactId),
      );
      if (conflicts.length)
        throw new FlowError(
          "SCOPE_CONFLICT",
          `任务依赖成果合入发生冲突：${predecessor.title}（${conflicts
            .map((c) => c.path)
            .slice(0, 5)
            .join("、")}）。`,
        );
    }
    const executionBase = await host.artifacts.capture(
      flow,
      work.root,
      "task-base",
    );
    session = host.session(
      flow.projectId,
      task.memberId,
      task.title,
      true,
    );
    host.store.put("sessions", session.id, {
      ...session,
      workspace: work.root,
      workspaceKind: "copy",
      purpose: "flow-task",
      flowId: flow.id,
    });
    task = host.update("flow_tasks", task, {
      sessionId: session.id,
      executionBase: host.artifacts.version(executionBase),
    });
  }
  for (;;) {
    task = host.need<Task>("flow_tasks", task.id);
    if (host.flow(flow.id).dispatchMode !== "running") {
      if (["queued", "running"].includes(task.status))
        host.update("flow_tasks", task, {
          status: "correcting",
          activeRunId: undefined,
        });
      return;
    }
    const meetingBackground = acceptedMeetingBackground(
        host.store,
        flow,
        task.memberId,
      ),
      op = host.operation(flow, "task", task, session.id);
    let submitted: Submission | undefined;
    try {
      const result = await host.protocol(
        op,
        "submission",
        flowPrompt(
          "submission",
          {
            summary: "完成情况",
            userSummary: "做出了什么、怎么看、还有什么没完成",
            evidence: [
              {
                kind: "inspection",
                description: "成果检查",
                result: "实际结果",
                eventIds: [],
              },
            ],
            completionResults: memberCriteria(
              task.completionCriteria,
              host.store.profile().name,
            ).required.map((criterion) => ({
              criterion,
              verified: false,
              evidence: "",
            })),
            outOfScopeExplanation: "如有越界，说明原因，否则省略",
          },
          {
            task,
            fixes: host.store
              .list<Review>("flow_reviews")
              .filter(
                (r) =>
                  r.taskId === task.id && r.status === "changes_requested",
              )
              .at(-1)?.findings,
            allowedPaths: task.allowedPaths,
            acceptedMeetingBackground: meetingBackground,
            meetingPolicy:
              "会议背景不改变本任务的目标、许可范围或验收标准。task.supplements 是用户明确补充的要求，必须完成并按最新 completionCriteria 逐项提交；这是需求变更，不是复核退回。",
          },
        ),
        (raw) => {
          const payload = validateSubmission(raw),
            known = host.disputeFindings(task);
          if (
            payload.disputes?.some(
              (d) => !known.some((f) => f.id === d.findingId),
            )
          )
            throw new FlowError(
              "INVALID_PROTOCOL",
              "异议只能引用本任务实际复核问题的 findingId。",
            );
          const latest = host.need<Task>("flow_tasks", task.id),
            operation = host.need<FlowOperation>("flow_operations", op.id);
          if (
            memberCriteria(
              latest.completionCriteria,
              host.store.profile().name,
            ).required.some(
              (criterion) =>
                !payload.completionResults.some(
                  (result) => result.criterion === criterion,
                ),
            )
          ) {
            const currentRun = operation.correctionRunId ?? operation.runId;
            if (
              latest.supplements?.some(
                (s) =>
                  s.status === "delivered" && s.deliveredRunId === currentRun,
              )
            )
              throw new FlowError(
                "REQUIREMENTS_CHANGED",
                "本轮未包含已送达的补充标准，需要按最新要求继续修正。",
              );
            const missing=memberCriteria(latest.completionCriteria,host.store.profile().name).required.filter(criterion=>!payload.completionResults.some(result=>result.criterion===criterion));
            payload.completionResults.push(...missing.map(criterion=>({criterion,verified:false,evidence:'成员未单独报告此项完成情况，需结合实际成果核对。'})));
            payload.replyNotes=[...(payload.replyNotes??[]),'部分完成标准未单独报告，已标为待核实，原成果和说明保留。'];
          }
          return payload;
        },
      );
      if (!host.validOperation(op, result.runId)) return;
      task = host.need<Task>("flow_tasks", task.id);
      const capturedRequirements = requirementsRevision(task),
        currentSession = host.need<Session>("sessions", session.id),
        snapshot = await host.artifacts.capture(
          flow,
          currentSession.workspace!,
          "submission",
          task.executionBase!.artifactId,
        ),
        changes = await host.artifacts.changes(
          host.artifacts.get(task.executionBase!.artifactId).root,
          snapshot.root,
        ),
        outOfScopeChanges = changes.filter(
          (c) => !task.allowedPaths.some((s) => pathWithin(c.path, s)),
        );
      await host.settleSupplements(task.id);
      if (!host.validOperation(op, result.runId)) {
        await host.artifacts.remove(snapshot);
        return;
      }
      if (
        requirementsRevision(host.need<Task>("flow_tasks", task.id)) !==
        capturedRequirements
      ) {
        await host.artifacts.remove(snapshot);
        throw new FlowError(
          "REQUIREMENTS_CHANGED",
          "捕获成果时新增了补充，先修正再提交。",
        );
      }
      markRoomRead(
        host.store,
        flow.roomId as RoomId,
        task.memberId,
        meetingBackground.messages.map((message) => message.id),
      );
      const submission: Submission = {
        ...host.record(flow.projectId, flow.id),
        taskId: task.id,
        sequence:
          host.store
            .list<Submission>("flow_submissions")
            .filter((s) => s.taskId === task.id).length + 1,
        runId: result.runId,
        sessionId: session.id,
        version: host.artifacts.version(snapshot),
        changes,
        evidence: host.bindEvidence(result.payload.evidence, result.runId),
        completionResults: result.payload.completionResults,
        disputes: result.payload.disputes,
        outOfScopeChanges,
        scopeExplanation: result.payload.outOfScopeExplanation,
        summary: result.payload.summary,
        ...(result.payload.replyNotes?.length?{replyNotes:result.payload.replyNotes}:{}),
        ...(result.payload.userSummary
          ? { userSummary: result.payload.userSummary }
          : {}),
        status: "submitted",
        requirementsRevision: capturedRequirements,
      };
      host.store.transaction(() => {
        host.store.put("flow_submissions", submission.id, submission);
        task = host.need<Task>("flow_tasks", task.id);
        if (task.latestSubmissionId) {
          const old = host.need<Submission>(
            "flow_submissions",
            task.latestSubmissionId,
          );
          if (old.status !== "stale")
            host.update("flow_submissions", old, { status: "superseded" });
        }
        task = host.update("flow_tasks", task, {
          status: outOfScopeChanges.length ? "blocked" : "awaiting_review",
          reviewLevelAtSubmission: host.taskLevel(task),
          latestSubmissionId: submission.id,
          activeRunId: undefined,
          supplements: (task.supplements ?? []).map((s) =>
            s.requirementsRevision &&
            s.requirementsRevision <= capturedRequirements &&
            ["pending", "delivered", "submitted"].includes(s.status)
              ? { ...s, status: "submitted", appliedRunId: result.runId }
              : s,
          ),
          ...(outOfScopeChanges.length
            ? { blockedReason: "修改超出许可范围，需要说明并处理范围变更。" }
            : {}),
        });
        host.update("flow_operations", op, { state: "done" });
      });
      if (outOfScopeChanges.length) {
        host.decision(
          flow,
          "scope-change",
          task,
          "修改范围需要确认",
          submission.scopeExplanation ?? "提交包含超出许可范围的文件。",
        );
        return;
      }
      submitted = submission;
    } catch (error) {
      if (host.supersededOperation(op)) return;
      if (
        error instanceof FlowError &&
        error.code === "REQUIREMENTS_CHANGED"
      ) {
        if (
          host.need<FlowOperation>("flow_operations", op.id).state !== "done"
        )
          host.update("flow_operations", op, {
            state: "done",
            result: { requirementsChanged: true },
          });
        task = host.update(
          "flow_tasks",
          host.need<Task>("flow_tasks", task.id),
          { status: "queued", activeRunId: undefined },
        );
        continue;
      }
      host.failOperation(op, error);
      throw error;
    }
    if (submitted?.disputes?.length) {
      await host.adjudicateTask(
        host.need<Task>("flow_tasks", task.id),
        submitted,
      );
      return;
    }
    if (host.skipTaskReview(host.need<Task>("flow_tasks", task.id))) return;
    await host.reviewTask(task, submitted!);
    return;
  }
}
