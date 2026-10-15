import { executeFlowTask } from "./project-flow-task-execution";
import { FlowValidation } from "./project-flow-validation";
import { ProjectFlowView } from "./project-flow-view";
import { payloadObject } from "../shared/project-flow-protocol";
import { AMBIGUOUS_FIELDS, retainCommandProvenance } from "../shared/flow-format";
import { recordFormatCorrection } from "./format-corrections";
import { RoundResultReader } from "./round-results";
import { ProjectWorkbench } from "./project-workbench";
import { ProjectProgress } from "./project-progress";
import {
  assertProjectSerial,
  assertProjectPaths,
  captureProjectBoundary,
  assertProjectBoundary,
} from "./project-access";
import type { TaskAddition } from "../shared/project-workbench";
import { presentRoundReport } from "./round-report";
import { WorkLogs } from "./work-log";
import { projectRequestSource } from "./project-request-source";
import { randomUUID } from "node:crypto";
import type { Store } from "./store";
import type {
  MemberProfile,
  Project,
  Session,
  Run,
  TimelineEvent,
  RoomId,
  RoomMessage,
  MemberQuota,
} from "../shared/types";
import { FlowArtifacts } from "./project-flow-artifacts";
import {
  workspaceFingerprint,
  diffWorkspace,
  listArtifacts,
  readArtifact,
} from "./workspace";
import { FlowApply, type ApplyJournal } from "./project-flow-apply";
import {
  projectFlowCardWrite,
  stageFlowCard,
  stageRoundReport,
} from "./project-room-reports";
import { captureFlowDiscussion } from "./project-flow-discussion";
import {
  markRoomRead,
  roundMeetingMaterial,
} from "./project-flow-room";
import {
  checkSupplementCapacity,
  requirementsRevision,
  retainSupplementRequirements,
  supplementRequest,
  SUPPLEMENTABLE,
} from "./project-flow-supplements";
import {
  FLOW_LIMITS,
  FlowError,
  type FlowRecord,
  type ProjectFlow,
  type Plan,
  type Round,
  type RoundReport,
  type Task,
  type Submission,
  type Review,
  type Decision,
  type FlowOperation,
  type FlowArtifact,
  type ProjectFlowSnapshot,
  type OperationResult,
  type Evidence,
  type Integration,
  type Acceptance,
  type AllowedAction,
  type TaskSupplement,
  type TaskSupplementResult,
} from "../shared/project-flow";
import {
  validatePlan,
  validateReview,
  validateReport,
  validateNextRound,
  parseReply,
  flowPrompt,
  pathWithin,
  scopesOverlap,
  scopePath,
  text,
  object,
  texts,
} from "../shared/project-flow-protocol";
import {
  assessReview,
  assertReviewMeaning,
  commandEvidenceProblem,
  memberCriteria,
  rejectUserCriteria,
} from "../shared/project-flow-review";
import { criterionText, criterionKind } from "../shared/project-flow";
import { bindSourceEvidence } from "./source-evidence";
import { parseCompletionCriteria } from "../shared/project-flow-protocol";
import { bindFlowEvidence, eventCommand } from "./project-flow-evidence";
import { roundActivityMaterial } from "./project-flow-activity";
/** The answer shape shown to a reviewer: nothing counts as verified until the reviewer checks it. */
function reviewTemplate(
  criteria: string[],
  description: string,
  result: string,
  previous?: { id: string }[],
  eventIds = true,
) {
  return {
    verdict: "inconclusive",
    verificationComplete: false,
    criteriaResults: criteria.map((criterion) => ({
      criterion,
      verified: false,
      evidence: "",
    })),
    ...(previous
      ? {
          previousFindingChecks: previous.map((f) => ({
            findingId: f.id,
            resolved: false,
            evidence: "",
          })),
        }
      : {}),
    findings: [],
    evidence: [
      {
        kind: "inspection",
        description,
        result,
        ...(eventIds ? { eventIds: [] } : {}),
      },
    ],
  };
}
/** The verdict fields every review record keeps, in their stored order. */
function reviewOutcome<
  P extends {
    verdict: unknown;
    criteriaResults: unknown;
    assessments?: unknown;
    strengths?: unknown;
  },
  A extends { outcome: unknown; reasons: unknown },
>(payload: P, assessment: A) {
  return {
    verdict: payload.verdict as P["verdict"],
    outcome: assessment.outcome as A["outcome"],
    outcomeReasons: assessment.reasons as A["reasons"],
    criteriaResults: payload.criteriaResults as P["criteriaResults"],
    assessments: payload.assessments as P["assessments"],
    strengths: payload.strengths as P["strengths"],
  };
}
import {
  reviewLevel,
  roundReviewLevel,
  roundLead,
  QUOTA_STAGE_LABELS,
  type ReviewLevel,
  type ManualRedo,
  type FlowStage,
  type ReviewFinding,
  type UserChangeRequest,
  type DisputeRuling,
  type QuotaWait,
  type NextRoundRecommendation,
  type RequestedRoundCheck,
} from "../shared/project-flow";
import {
  finishedFlowReply,
  operationNotDelivered,
} from "./project-flow-recovery";
import { JointReviews } from "./joint-review";
import {
  JOINT_READS,
  JOINT_WRITES,
  type JointSlot,
} from "../shared/joint-review";

export interface FlowHost {
  alive(): boolean;
  changed(): void;
  maxParallel(): number;
  available(memberId: string, write: boolean): boolean;
  quotaAllows(memberId: string, model?: string): boolean;
  quota100?(memberId: string, model?: string): boolean;
  session(
    projectId: string,
    memberId: string,
    title: string,
    write: boolean,
  ): Session;
  configuration?(
    projectId: string,
    memberId: string,
  ): import("../shared/executor-config").RequestedRunConfig;
  run(
    sessionId: string,
    prompt: string,
    operationId: string,
    attachments?: import("../shared/types").Attachment[],
  ): Promise<OperationResult>;
  steer?(
    runId: string,
    prompt: string,
    deliveryId: string,
  ): Promise<"current" | "next-turn" | "unknown">;
  stop(runId: string): Promise<void>;
  report?(): void;
  roundtableSource?(
    ref: NonNullable<ProjectFlow["sourceRoundtable"]>,
    projectId: string,
  ): Promise<unknown>;
}
const at = () => new Date().toISOString();
const finished = new Set([
  "review_passed",
  "review_skipped",
  "integrated",
  "accepted",
]);
export class ProjectFlowController {
  private validation: FlowValidation;
  private view: ProjectFlowView;
  private workbench: ProjectWorkbench;
  private logs: WorkLogs;
  readonly artifacts: FlowArtifacts;
  readonly joint: JointReviews;
  private applications: FlowApply;
  private jobs = new Set<Promise<void>>();
  private pumping = false;
  private repump = false;
  private closed = false;
  private requests = new Map<string, Promise<unknown>>();
  private busyTargets = new Set<string>();
  private recoveringReplies = new Map<string, OperationResult>();
  private quotaTimer: ReturnType<typeof setInterval>;
  get busy() {
    return this.jobs.size > 0 || this.requests.size > 0 || this.joint?.busy;
  }
  pauseAll() {
    this.joint?.pauseAll();
    for (const f of this.store
      .list<ProjectFlow>("project_flows")
      .filter((f) => !["completed", "cancelled"].includes(f.status)))
      this.update("project_flows", f, { dispatchMode: "paused" });
  }
  constructor(
    private store: Store,
    private host: FlowHost,
  ) {
    this.validation = new FlowValidation(store);
    this.view = new ProjectFlowView(store, {
      busyTargets: this.busyTargets,
      flow: (id) => this.flow(id),
      need: <T>(entity: string, id: string) => this.need<T>(entity, id),
      taskLevel: (task) => this.taskLevel(task),
      pendingScope: (id) => this.pendingScope(id),
      replanBlock: (flow) => this.replanBlock(flow),
      retryable: (flow) => this.retryable(flow),
      jointReviews: (projectId, before, limit) =>
        this.joint.list(projectId, before, limit),
    });
    this.workbench = new ProjectWorkbench(store);
    this.logs = new WorkLogs(store);
    this.artifacts = new FlowArtifacts(store);
    this.applications = new FlowApply(store, this.artifacts);
    this.joint = new JointReviews(store, host, this.artifacts);
    this.recover();
    for (const proposal of store
      .list<TaskAddition>("flow_task_additions")
      .filter((p) => p.status === "preparing"))
      this.update("flow_task_additions", proposal, {
        status: "blocked",
        error: "上次准备中断，请核对旧运行后重新准备；没有自动重发。",
      });
    for (const flow of store
      .list<ProjectFlow>("project_flows")
      .filter(
        (f) =>
          ["completed", "cancelled"].includes(f.status) &&
          store.get("projects", f.projectId),
      )) {
      this.workbench.checkpoint(flow.id);
      const receipt = store.get<{ state: string }>(
        "flow_record_receipts",
        flow.id,
      );
      if (
        store.get<Project>("projects", flow.projectId)?.projectRecordToFolder &&
        (!receipt || receipt.state === "prepared")
      )
        this.launch(() => this.workbench.finish(flow.id));
    }
    this.quotaTimer = setInterval(() => this.kick(), 30_000);
    this.quotaTimer.unref();
  }
  private record(projectId: string, flowId: string): FlowRecord {
    const id = randomUUID(),
      date = at();
    return {
      id,
      projectId,
      flowId,
      schemaVersion: 1,
      revision: 1,
      createdAt: date,
      updatedAt: date,
    };
  }
  private need<T>(entity: string, id: string): T {
    const value = this.store.get<T>(entity, id);
    if (!value) throw new FlowError("NOT_FOUND", "记录不存在，请刷新项目。");
    return value;
  }
  private update<T extends FlowRecord>(
    entity: string,
    item: T,
    patch: Partial<T>,
  ): T {
    const latest = this.need<T>(entity, item.id),
      next = {
        ...latest,
        ...patch,
        revision: latest.revision + 1,
        updatedAt: at(),
      },
      writes = [{ entity, id: next.id, value: next as unknown }];
    if (entity !== "project_flows") {
      const flow = this.store.get<ProjectFlow>("project_flows", item.flowId);
      if (flow)
        writes.push({
          entity: "project_flows",
          id: flow.id,
          value: { ...flow, revision: flow.revision + 1, updatedAt: at() },
        });
    }
    if (entity === "flow_decisions") {
      const card = projectFlowCardWrite(
        this.store,
        "decision",
        next as unknown as Decision,
      );
      if (card) writes.push(card);
    }
    this.store.putMany(writes);
    return next;
  }
  private check(record: FlowRecord, p: Record<string, unknown>) {
    if (p.expectedRevision !== record.revision)
      throw new FlowError("STALE_REVISION", "记录已更新，请刷新后再操作。");
  }
  private flow(id: string) {
    return this.need<ProjectFlow>("project_flows", id);
  }
  private tasks(flowId: string) {
    return this.store
      .list<Task>("flow_tasks")
      .filter((t) => t.flowId === flowId);
  }
  private lead(taskOrRound: Task | Round) {
    const round =
      "roundId" in taskOrRound
        ? this.need<Round>("flow_rounds", taskOrRound.roundId)
        : taskOrRound;
    return roundLead(this.flow(round.flowId), round);
  }
  private configuredLevel(
    value: unknown,
    fallback: ReviewLevel = "high",
  ): ReviewLevel {
    if (value === undefined) return fallback;
    if (!["high", "medium", "low"].includes(String(value)))
      throw new FlowError(
        "INVALID_REQUEST",
        "复核程度只能是 high、medium 或 low。",
      );
    return value as ReviewLevel;
  }
  private taskLevel(task: Task) {
    return task.review
      ? ("high" as const)
      : (task.reviewLevelAtSubmission ??
          roundReviewLevel(
            this.flow(task.flowId),
            this.need<Round>("flow_rounds", task.roundId),
          ));
  }
  private reviewer(
    flow: ProjectFlow,
    author: string,
    assigned: Pick<Task, "reviewerMemberId">[] = this.tasks(flow.id).filter(
      (t) => t.planId === flow.activePlanId && t.status !== "cancelled",
    ),
    eligible = flow.memberIds,
  ) {
    const candidates = eligible.filter(
        (id) => id !== author && this.host.available(id, false),
      ),
      count = (id: string) =>
        assigned.filter((t) => t.reviewerMemberId === id).length;
    candidates.sort(
      (a, b) =>
        count(a) - count(b) ||
        Number(a === flow.leadMemberId) - Number(b === flow.leadMemberId) ||
        flow.memberIds.indexOf(a) - flow.memberIds.indexOf(b),
    );
    if (!candidates[0])
      throw new FlowError("REVIEWER_REQUIRED", "需要团队内另一名可用复核人。");
    return candidates[0];
  }
  private quotaFor(flow: ProjectFlow, memberId: string) {
    return this.host.quotaAllows(
      memberId,
      flow.memberConfigs?.[memberId]?.model ??
        this.host.configuration?.(flow.projectId, memberId).model,
    );
  }
  private availableReviewer(task: Task) {
    const flow = this.flow(task.flowId);
    if (this.quotaFor(flow, task.reviewerMemberId)) return task;
    const eligible = flow.memberIds.filter(
      (id) =>
        id !== task.memberId &&
        id !== task.reviewerMemberId &&
        this.host.available(id, true) &&
        this.quotaFor(flow, id),
    );
    if (!eligible.length) return task;
    const memberId = this.reviewer(flow, task.memberId, undefined, eligible),
      reason = "原复核人额度不足，自动分配给有额度的其他成员。";
    return this.update("flow_tasks", task, {
      reviewerMemberId: memberId,
      reviewerChanges: [
        ...(task.reviewerChanges ?? []),
        { previousMemberId: task.reviewerMemberId, memberId, reason, at: at() },
      ],
    });
  }
  private availablePeer(round: Round) {
    const flow = this.flow(round.flowId),
      lead = this.lead(round),
      member =
        round.peerReviewerMemberId ??
        flow.memberIds.find(
          (id) => id !== lead && this.host.available(id, true),
        );
    if (!member || this.quotaFor(flow, member)) return member;
    const eligible = flow.memberIds.filter(
      (id) =>
        id !== lead &&
        id !== member &&
        this.host.available(id, true) &&
        this.quotaFor(flow, id),
    );
    if (!eligible.length) return member;
    const selected = this.reviewer(flow, lead, undefined, eligible);
    this.update("flow_rounds", round, {
      peerReviewerMemberId: selected,
      peerReviewerChanges: [
        ...(round.peerReviewerChanges ?? []),
        {
          previousMemberId: member,
          memberId: selected,
          reason: "原整轮复核人额度不足，自动换给有额度的其他成员。",
          at: at(),
        },
      ],
    });
    return selected;
  }
  private resolveQuotaWait(wait: QuotaWait) {
    if (wait.status === "resolved") return;
    this.update("flow_quota_waits", wait, { status: "resolved" });
    const decision = wait.decisionId
      ? this.store.get<Decision>("flow_decisions", wait.decisionId)
      : undefined;
    if (decision?.status === "open")
      this.update("flow_decisions", decision, { status: "expired" });
    this.host.changed();
  }
  private quotaAllows(
    flow: ProjectFlow,
    target: Task | Round,
    memberId: string,
    stage: QuotaWait["stage"],
  ) {
    const waiting = this.store
      .list<QuotaWait>("flow_quota_waits")
      .find(
        (w) =>
          w.flowId === flow.id &&
          w.targetId === target.id &&
          w.memberId === memberId &&
          w.stage === stage &&
          w.status !== "resolved",
      );
    if (this.quotaFor(flow, memberId)) {
      if (waiting) this.resolveQuotaWait(waiting);
      return true;
    }
    const wait = waiting ?? {
      ...this.record(flow.projectId, flow.id),
      targetId: target.id,
      memberId,
      stage,
      startedAt: at(),
      status: "waiting" as const,
    };
    if (!waiting) {
      this.store.put("flow_quota_waits", wait.id, wait);
      this.host.changed();
    }
    if (
      wait.status === "waiting" &&
      Date.now() - Date.parse(wait.startedAt) >= 600_000
    ) {
      const task = "roundId" in target ? target : undefined,
        round = task
          ? this.need<Round>("flow_rounds", task.roundId)
          : (target as Round),
        author =
          stage === "review" || stage === "adjudication"
            ? task?.memberId
            : stage === "peer-review"
              ? this.lead(round)
              : undefined;
      const decision = this.saveDecision({
        ...this.record(flow.projectId, flow.id),
        kind: "quota-wait",
        roundId: round.id,
        taskId: task?.id,
        quotaWaitId: wait.id,
        stage: task
          ? stage === "review"
            ? "task-review"
            : "task"
          : "integration-check",
        currentMemberId: memberId,
        eligibleMemberIds: flow.memberIds.filter(
          (id) => id !== memberId && id !== author,
        ),
        title: "等待额度已超过 10 分钟",
        reason:
          "等待 " +
          (this.store.members().find((m) => m.id === memberId)?.name ??
            memberId) +
          " 额度恢复，阶段：" +
          QUOTA_STAGE_LABELS[stage] +
          "。继续等不会重发旧运行；换人只接手当前事项。",
        options: [
          "继续等待",
          "换人接手",
          ...(stage === "adjudication" ? ["交给我裁定"] : []),
        ],
        eligibleTaskIds: [],
        sourceVersions: [],
        status: "open",
      });
      this.update("flow_quota_waits", wait, {
        status: "decision",
        decisionId: decision.id,
      });
      this.host.changed();
    }
    return false;
  }
  private quotaWaitCurrent(wait: QuotaWait, flow: ProjectFlow) {
    if (flow.status !== "active") return false;
    if (wait.operationId) return this.store.get<FlowOperation>("flow_operations", wait.operationId)?.state === "blocked";
    const task = this.store.get<Task>("flow_tasks", wait.targetId);
    if (task)
      return (
        task.planId === flow.activePlanId &&
        (wait.stage === "task"
          ? ["pending", "ready", "correcting"].includes(task.status) &&
            task.memberId === wait.memberId
          : task.status === "awaiting_review" &&
            (wait.stage === "review"
              ? task.reviewerMemberId
              : this.lead(task)) === wait.memberId)
      );
    const round = this.store.get<Round>("flow_rounds", wait.targetId);
    if (!round || round.planId !== flow.activePlanId) return false;
    const requested = round.requestedCheckId
        ? this.store.get<RequestedRoundCheck>(
            "flow_requested_checks",
            round.requestedCheckId,
          )
        : undefined,
      member =
        wait.stage === "requested-check"
          ? requested?.memberId
          : wait.stage === "peer-review"
            ? (round.peerReviewerMemberId ??
              flow.memberIds.find((id) => id !== this.lead(round)))
            : this.lead(round);
    return (
      member === wait.memberId &&
      (wait.stage === "next-round"
        ? round.status === "pending" &&
          round.nextConfirmation?.status === "suggesting"
        : round.status === "checking")
    );
  }
  private reconcileQuotaWaits(flow: ProjectFlow) {
    for (const wait of this.store.list<QuotaWait>("flow_quota_waits").filter(w => w.flowId === flow.id && w.status !== "resolved")) {
      if (!this.quotaWaitCurrent(wait, flow)) { this.resolveQuotaWait(wait); continue; }
      if (wait.operationId) {
        const member = this.store.members().find(m => m.id === wait.memberId);
        const quota = this.store.get<MemberQuota>("quotas", member?.executor ?? wait.memberId);
        const freshRecovery = quota && quota.checkedAt > wait.startedAt && quota.windows.some(w => w.usedPercent !== undefined && w.usedPercent < 100) && this.quotaFor(flow, wait.memberId);
        if (!wait.readyToResume && (wait.resetAt ? Date.now() >= wait.resetAt * 1000 : freshRecovery)) {
          this.update("flow_quota_waits", wait, {readyToResume: true});
          const message = "成员额度预计已恢复，可点击接着做，沿用原会话继续。";
          const task = this.store.get<Task>("flow_tasks", wait.targetId);
          if (task?.status === "blocked") this.update("flow_tasks", task, {blockedReason: message});
          const operation = this.store.get<FlowOperation>("flow_operations", wait.operationId);
          if (operation) this.update("flow_operations", operation, {error: message});
          this.host.changed();
        }
      } else if (this.quotaFor(flow, wait.memberId)) this.resolveQuotaWait(wait);
    }
  }
  private recover() {
    this.store.transaction(() => {
      for (const flow of this.store.list<ProjectFlow>("project_flows"))
        if (!["completed", "cancelled"].includes(flow.status))
          this.update("project_flows", flow, { dispatchMode: "paused" });
      for (const operation of this.store.list<FlowOperation>("flow_operations"))
        if (
          !operation.jointReviewId &&
          ["prepared", "running"].includes(operation.state)
        ) {
          if (operationNotDelivered(this.store, operation)) {
            this.update("flow_operations", operation, {
              state: "done",
              result: { notDelivered: true },
              resumeRequested: ["plan", "rearrange"].includes(operation.kind),
            });
            const task = this.store.get<Task>("flow_tasks", operation.targetId);
            if (task) {
              const status =
                operation.kind === "rearrange"
                  ? "escalated"
                  : ["review", "adjudication"].includes(operation.kind)
                    ? "awaiting_review"
                    : task.latestSubmissionId
                      ? "correcting"
                      : "pending";
              this.update("flow_tasks", task, {
                status,
                activeRunId: undefined,
                blockedReason: undefined,
                statusBeforeBlock: undefined,
              });
              for (const review of this.store
                .list<Review>("flow_reviews")
                .filter((r) => r.taskId === task.id && r.status === "running"))
                this.update("flow_reviews", review, {
                  status: "stale",
                  staleReason: "运行尚未投递，恢复后重新开始复核。",
                });
            }
            const requested = this.store.get<RequestedRoundCheck>(
              "flow_requested_checks",
              operation.targetId,
            );
            if (requested)
              this.update("flow_requested_checks", requested, {
                status: "pending",
              });
            continue;
          }
          const completed = Boolean(finishedFlowReply(this.store, operation));
          this.update("flow_operations", operation, {
            state: "blocked",
            recovery: completed ? "completed" : "interrupted",
            error: completed
              ? "运行已正常结束，点击继续后校验并恢复实际结果，不重发。"
              : "重启后执行结果待核对，未自动重发。",
          });
          if (
            operation.kind === "supplement-delivery" &&
            operation.supplementId
          )
            this.patchSupplement(operation.targetId, operation.supplementId, {
              status: "unknown",
            });
          const task = this.store.get<Task>("flow_tasks", operation.targetId);
          if (task)
            this.update("flow_tasks", task, {
              status: "blocked",
              statusBeforeBlock: task.status,
              blockedReason: completed
                ? "已结束的真实结果等待恢复。"
                : "重启后执行结果待核对。",
            });
          if (!completed) {
            const flow = this.flow(operation.flowId);
            this.update("project_flows", flow, {
              blockedReasons: [
                ...new Set([
                  ...flow.blockedReasons,
                  "重启后执行结果待核对，未自动重发。",
                ]),
              ],
            });
          }
        }
      for (const acceptance of this.store
        .list<Acceptance>("flow_acceptances")
        .filter(
          (a) =>
            a.status === "applying" ||
            (a.status === "requested" && a.requiresApply),
        ))
        this.update("flow_acceptances", acceptance, {
          status: "recovery_required",
        });
    });
    const cleanup = this.store
      .list<FlowArtifact>("flow_artifacts")
      .filter(
        (a) =>
          (a.transient || a.status === "capturing") && a.status !== "removed",
      );
    if (cleanup.length)
      this.launch(async () => {
        for (const artifact of cleanup) {
          const ops = this.store
            .list<FlowOperation>("flow_operations")
            .filter((o) => o.sessionId === artifact.sessionId);
          if (
            this.store
              .list<JointSlot>("flow_joint_slots")
              .some(
                (slot) =>
                  slot.disposableArtifactId === artifact.id &&
                  ["queued", "recoverable", "running", "blocked"].includes(
                    slot.status,
                  ),
              )
          )
            continue;
          if (
            ops.some((o) =>
              [o.runId, o.correctionRunId].some(
                (id) =>
                  id &&
                  (this.store.get<Run>("runs", id)?.status === "unknown" ||
                    this.store.get<Run>("runs", id)?.delivery === "unknown"),
              ),
            )
          )
            continue;
          if (artifact.status !== "removed")
            await this.artifacts.remove(artifact);
        }
      });
  }
  private launch(job: () => Promise<void>, failure?: (error: Error) => void) {
    if (this.closed) return;
    let promise: Promise<void>;
    promise = Promise.resolve()
      .then(job)
      .catch((error) => failure?.(error as Error))
      .finally(() => {
        this.jobs.delete(promise);
        this.host.changed();
        this.kick();
      });
    this.jobs.add(promise);
  }
  private deferred(error: Error) {
    return (
      error instanceof FlowError &&
      ["PAUSED", "QUOTA_BLOCKED"].includes(error.code)
    );
  }
  /** A disposable copy of a version and a read-only review session that works only inside it. */
  private async openReviewCopy(
    flow: { id: string; projectId: string },
    root: string,
    fingerprint: string | undefined,
    memberId: string,
    title: string,
  ): Promise<{ disposable: FlowArtifact; session: Session }>;
  /** `keep` is checked again once the copy exists; a stale review removes the copy and opens nothing. */
  private async openReviewCopy(
    flow: { id: string; projectId: string },
    root: string,
    fingerprint: string | undefined,
    memberId: string,
    title: string,
    keep: () => boolean,
  ): Promise<{ disposable: FlowArtifact; session: Session } | undefined>;
  private async openReviewCopy(
    flow: { id: string; projectId: string },
    root: string,
    fingerprint: string | undefined,
    memberId: string,
    title: string,
    keep?: () => boolean,
  ) {
    const disposable = await this.artifacts.capture(
        flow,
        root,
        "review",
        undefined,
        fingerprint,
        true,
      ),
      session = this.host.session(flow.projectId, memberId, title, true);
    if (keep && !keep()) {
      await this.artifacts.remove(disposable);
      return;
    }
    this.store.put("sessions", session.id, {
      ...session,
      workspace: disposable.root,
      workspaceKind: "original",
      purpose: "flow-review",
      flowId: flow.id,
    });
    this.store.put("flow_artifacts", disposable.id, {
      ...disposable,
      sessionId: session.id,
    });
    return { disposable, session };
  }
  /** A review copy stays only while its run's outcome is unknown, so that run can still be checked. */
  private async releaseReviewCopy(operationId: string, disposableId: string) {
    const current = this.need<FlowOperation>("flow_operations", operationId),
      runId = current.correctionRunId ?? current.runId;
    if (!runId || this.store.get<Run>("runs", runId)?.status !== "unknown")
      await this.artifacts.remove(this.artifacts.get(disposableId));
  }
  private failOperation(op: FlowOperation, error: unknown) {
    const current = this.need<FlowOperation>("flow_operations", op.id);
    if (
      this.deferred(error as Error) &&
      operationNotDelivered(this.store, current) &&
      current.recovery !== "completed"
    ) {
      this.update("flow_operations", current, {
        state: "done",
        result: { notDelivered: true },
        resumeRequested: ["plan", "rearrange"].includes(op.kind),
        error: undefined,
      });
      return;
    }
    this.update("flow_operations", current, {
      state: "blocked",
      error: (error as Error).message,
    });
  }
  private blocked(flowId: string, error: Error, targetId?: string) {
    const flow = this.flow(flowId),
      task = targetId
        ? this.store.get<Task>("flow_tasks", targetId)
        : undefined;
    if (this.deferred(error)) {
      if (task?.status === "queued")
        this.update("flow_tasks", task, { status: "pending" });
      return;
    }
    this.store.transaction(() => {
      this.update("project_flows", flow, {
        blockedReasons: [...new Set([...flow.blockedReasons, error.message])],
      });
      if (task)
        this.update("flow_tasks", task, {
          status: "blocked",
          statusBeforeBlock: task.status,
          blockedReason: error.message,
        });
    });
  }
  private recoveryOperation(kind: string, targetId: string) {
    return this.store
      .list<FlowOperation>("flow_operations")
      .find(
        (o) =>
          o.kind === kind &&
          o.targetId === targetId &&
          this.recoveringReplies.has(o.id),
      );
  }
  private operation(
    flow: ProjectFlow,
    kind: string,
    target: FlowRecord,
    sessionId?: string,
  ) {
    const recovery = this.recoveryOperation(kind, target.id),
      continuation = this.store
        .list<FlowOperation>("flow_operations")
        .find(
          (o) =>
            o.flowId === flow.id &&
            o.kind === kind &&
            o.targetId === target.id &&
            o.resumeRequested &&
            !o.continuedByOperationId,
        ),
      prior = recovery ?? continuation;
    if (prior?.sessionId && sessionId && prior.sessionId !== sessionId) {
      const original = this.need<Session>("sessions", prior.sessionId),
        prepared = this.need<Session>("sessions", sessionId);
      this.store.put("sessions", original.id, {
        ...original,
        workspace: prepared.workspace,
        workspaceKind: prepared.workspaceKind,
        purpose: prepared.purpose,
        flowId: flow.id,
      });
      for (const artifact of this.store
        .list<FlowArtifact>("flow_artifacts")
        .filter((a) => a.sessionId === sessionId))
        this.store.put("flow_artifacts", artifact.id, {
          ...artifact,
          sessionId: original.id,
        });
      sessionId = original.id;
    }
    if (recovery)
      return this.update("flow_operations", recovery, {
        state: "running",
        sessionId,
      });
    const op: FlowOperation = {
      ...this.record(flow.projectId, flow.id),
      kind,
      targetId: target.id,
      targetRevision: target.revision,
      ...(["review", "adjudication"].includes(kind)
        ? { submissionId: (target as Task).latestSubmissionId }
        : {}),
      ...("completionCriteria" in target
        ? { requirementsRevision: requirementsRevision(target as Task) }
        : {}),
      sessionId,
      state: "prepared",
    };
    this.store.put("flow_operations", op.id, op);
    if (continuation)
      this.update("flow_operations", continuation, {
        continuedByOperationId: op.id,
        resumeRequested: false,
      });
    return op;
  }
  private async protocol<T>(
    op: FlowOperation,
    kind: string,
    prompt: string,
    validate: (raw: unknown, runId: string) => T,
  ): Promise<{ payload: T; runId: string }> {
    try {
      if (!this.host.alive() || this.flow(op.flowId).dispatchMode !== "running")
        throw new FlowError("PAUSED", "后续派发已暂停。");
      const recovered = this.recoveringReplies.get(op.id);
      if (recovered) {
        await this.checkRequirements(op);
        const payload = parseReply(recovered.text, kind);
        if (
          op.correctionRunId &&
          [
            "review",
            "integration-check",
            "peer-review",
            "requested-check",
            "adjudication",
          ].includes(kind)
        ) {
          const original = finishedFlowReply(this.store, {
            ...op,
            correctionRunId: undefined,
          });
          if (original) {
            let before: unknown;
            try {
              before = parseReply(original.text, kind);
            } catch {}
            assertReviewMeaning(before, payload);
          }
        }
        this.update("flow_operations", op, {
          recoveredFromRunId: recovered.runId,
          recovery: undefined,
        });
        return {
          payload: validate(payload, recovered.runId),
          runId: recovered.runId,
        };
      }
      const member = this.need<Session>("sessions", op.sessionId!);
      if (
        !this.quotaFor(this.flow(op.flowId), member.memberId ?? member.provider)
      )
        throw new FlowError(
          "QUOTA_BLOCKED",
          "该成员额度已耗尽，未开始新阶段。",
        );
      await this.checkRequirements(op);
      let result = await this.host.run(op.sessionId!, prompt, op.id);
      if (result.status === "rate_limited") {
        const task = this.store.get<Task>("flow_tasks", op.targetId);
        const integration = this.store.get<Integration>("flow_integrations", op.targetId);
        const quota = this.store.get<MemberQuota>("quotas", member.provider);
        const resets = (quota?.windows ?? []).filter(w => w.exhausted || (w.usedPercent ?? 0) >= 100).map(w => w.resetsAt).filter((n): n is number => typeof n === "number" && n * 1000 > Date.now());
        const resetAt = resets.length ? Math.max(...resets) : undefined;
        const stage = (op.kind === "task" ? "task" : kind) as QuotaWait["stage"];
        if (Object.hasOwn(QUOTA_STAGE_LABELS, stage)) {
          const wait: QuotaWait = {...this.record(op.projectId, op.flowId), targetId: task?.id ?? integration?.roundId ?? op.targetId, memberId: member.memberId ?? member.provider, stage, startedAt: at(), status: "waiting", operationId: op.id, resetAt};
          this.store.put("flow_quota_waits", wait.id, wait);
        }
        throw new FlowError("RATE_LIMITED", "成员额度已用完，已保留当前会话和成果。" + (resetAt ? "预计恢复时间：" + new Date(resetAt * 1000).toLocaleString("zh-CN") + "；到点会提示接着做。" : "恢复时间尚未提供；额度恢复后可接着做。"));
      }
      if (!["ended", "completed"].includes(result.status))
        throw new FlowError(
          result.status === "unknown" ? "UNKNOWN_RESULT" : "RUN_BLOCKED",
          `成员运行未完成：${result.status}；未自动重发。`,
        );
      await this.checkRequirements(op);
      let original: unknown;
      try {
        let repairedTail = false;
        original = parseReply(result.text, kind, () => { repairedTail = true; });
        const payload = validate(original, result.runId);
        if (repairedTail) recordFormatCorrection(this.store, { area: "project-flow", stage: kind, memberId: member.memberId, executor: member.provider, operationId: op.id, runId: result.runId, error: new FlowError("UNCLOSED_TAIL", "已补齐回复尾部闭合括号，内容未改写。"), outcome: "corrected" });
        return {
          payload,
          runId: result.runId,
        };
      } catch (error) {
        const correction = {
          area: "project-flow" as const,
          stage: kind,
          memberId: member.memberId,
          executor: member.provider,
          operationId: op.id,
          runId: result.runId,
          error,
        };
        if (
          (error instanceof FlowError &&
            (error.code === "REQUIREMENTS_CHANGED" ||
              // A correction may not choose between the member's own conflicting fields.
              error.code === AMBIGUOUS_FIELDS)) ||
          this.supersededOperation(op)
        ) {
          if (error instanceof FlowError && error.code === AMBIGUOUS_FIELDS)
            recordFormatCorrection(this.store, { ...correction, outcome: "skipped" });
          throw error;
        }
        if (
          !this.host.alive() ||
          this.flow(op.flowId).dispatchMode !== "running" ||
          !this.quotaFor(
            this.flow(op.flowId),
            member.memberId ?? member.provider,
          )
        )
          throw error;
        const sourceVersion =
          member.writeMode && member.workspace
            ? await workspaceFingerprint(member.workspace)
            : undefined;
        try {
        const originalText = result.text;
        result = await this.host.run(
          op.sessionId!,
          `仅补正上轮 JSON 格式，不再执行文件任务，不运行命令、不改文件。仅整理已有输出，不能新增验证声明。命令依据改成 inspection 时，保持 evidence 条数和顺序，原 result（包括句末标点）必须完整保留为前缀；可以在末尾补充原输出已有的信息（例如已有退出码），不能新增检查、改写原文或把未核实说成已核实。用途 ${kind}。错误：${(error as Error).message}\n原输出：${result.text.slice(0, FLOW_LIMITS.replyBytes)}\n${prompt.split("\n任务材料：")[0]}`,
          op.id,
        );
        if (!["ended", "completed"].includes(result.status))
          throw new FlowError("UNKNOWN_RESULT", "格式补正未确认完成，未继续。");
        if (
          sourceVersion &&
          (await workspaceFingerprint(member.workspace!)) !== sourceVersion
        )
          throw new FlowError(
            "STALE_VERSION",
            "格式补正改变了文件内容，已停止后续派发。",
          );
        await this.checkRequirements(op);
        if (result.text.trim() === originalText.trim()) throw new FlowError("FORMAT_UNCHANGED", "成员原样返回了未通过的回复，格式补正未生效。原问题：" + (error as Error).message + " 请核对原回复后调整要求或重新安排任务。");
        const corrected = retainCommandProvenance(original, parseReply(result.text, kind));
        if (
          [
            "review",
            "integration-check",
            "peer-review",
            "requested-check",
            "adjudication",
          ].includes(kind)
        )
          assertReviewMeaning(original, corrected);
        const payload = validate(corrected, result.runId);
        recordFormatCorrection(this.store, { ...correction, outcome: "corrected" });
        return { payload, runId: result.runId };
        } catch (failure) {
          recordFormatCorrection(this.store, { ...correction, outcome: "failed" });
          throw failure;
        }
      }
    } catch (error) {
      if (error instanceof FlowError && error.code === "REQUIREMENTS_CHANGED") {
        if (this.need<FlowOperation>("flow_operations", op.id).state !== "done")
          this.update("flow_operations", op, {
            state: "done",
            result: { requirementsChanged: true },
          });
      } else if (!this.supersededOperation(op)) this.failOperation(op, error);
      throw error;
    }
  }
  private validOperation(op: FlowOperation, runId: string) {
    const current = this.need<FlowOperation>("flow_operations", op.id),
      flow = this.flow(op.flowId),
      run = this.store.get<Run>("runs", runId),
      task = this.store.get<Task>("flow_tasks", op.targetId);
    const valid =
      current.state === "running" &&
      flow.status !== "cancelled" &&
      (current.correctionRunId ?? current.runId) === runId &&
      run?.flowOperationId === op.id &&
      (!task ||
        (task.planId === flow.activePlanId &&
          task.status !== "cancelled" &&
          (op.kind !== "task" ||
            (["queued", "running"].includes(task.status) &&
              task.sessionId === op.sessionId)) &&
          (!["review", "adjudication"].includes(op.kind) ||
            (task.status === "awaiting_review" &&
              task.latestSubmissionId === op.submissionId &&
              requirementsRevision(task) === (op.requirementsRevision ?? 1)))));
    if (!valid && current.state === "running")
      this.update("flow_operations", current, {
        state: "blocked",
        error: "结果到达时任务或方案已改变，仅保留实际运行记录。",
      });
    return valid;
  }
  private async proposed(
    flow: ProjectFlow,
    instruction: string,
    parent?: Plan,
  ) {
    const session = this.host.session(
        flow.projectId,
        flow.leadMemberId,
        "项目方案",
        false,
      ),
      op = this.operation(flow, "plan", flow, session.id);
    const notes: string[] = [];
    const currentTaskRequirements = parent
      ? this.tasks(flow.id)
          .filter(
            (task) => task.planId === parent.id && task.supplements?.length,
          )
          .map((task) => ({
            key: task.key,
            memberId: task.memberId,
            goal: task.goal,
            completionCriteria: task.completionCriteria,
            supplements: task.supplements,
          }))
      : [];
    this.store.put("sessions", session.id, { ...session, flowId: flow.id });
    try {
      const sourceRoundtables = await this.roundtableMaterials(flow);
      const sourceJointReview = flow.sourceJointReviewId
        ? await this.joint.sourceForPlan(
            flow.sourceJointReviewId,
            flow.projectId,
          )
        : undefined;
      const sourceRoundtable = flow.sourceRoundtable
        ? await this.host.roundtableSource!(
            flow.sourceRoundtable,
            flow.projectId,
          )
        : undefined;
      const result = await this.protocol(
        op,
        "plan",
        flowPrompt(
          "plan",
          {
            objective: "目标",
            scope: "范围",
            deliverables: ["成品"],
            acceptanceCriteria: [
              { text: "验收标准", kind: "check" },
              { text: "用户确认最终成果", kind: "owner" },
            ],
            rounds: [
              {
                key: "r1",
                title: "第一轮",
                goal: "轮次目标",
                requiresUserAcceptance: true,
                completionCriteria: [{ text: "具体文件标准", kind: "check" }],
              },
            ],
            tasks: [
              {
                key: "t1",
                roundKey: "r1",
                title: "任务",
                memberId: flow.memberIds[0],
                goal: "目标",
                inputs: [],
                completionCriteria: [{ text: "具体完成标准", kind: "check" }],
                dependencies: [],
                allowedPaths: ["src/feature-a/", "docs/feature-a.md"],
              },
            ],
          },
          {
            instruction,
            topic: flow.topic,
            discussion: flow.discussionContext,
            previousRecord: flow.previousRecord,
            sourceRoundtables,
            sourceJointReview,
            sourceRoundtable,
            parentPlan: parent,
            currentTaskRequirements,
            memberIds: flow.memberIds,
            projectWriteScopes: this.need<Project>("projects", flow.projectId)
              .writeScopes ?? ["."],
            reviewLevel: reviewLevel(flow),
            rules:
              "起草前先只读查看项目目录中与目标相关的现有文件，按实际文件结构安排任务和 allowedPaths，不修改文件。流程按用户配置安排个人或整轮复核、负责人汇报、用户验收；不要把这些自动阶段写成文件任务，标准分类为可核对的 check、成员评价的 judge、用户判断的 owner；只有 owner 可以写用户确认或偏好，不能让成员替用户作决定。只写本任务实际要修改的文件或文件夹，只读路径不用写入 allowedPaths。负责人每轮自己领的任务不超过任务数的三分之一，两人团队除外。没有变化的任务可用 reuse 指向旧任务 key，后台核实成员、范围、标准、依赖和起点后才沿用。同一个文件由前后串行的任务修改，用 dependencies 写清先后。",
          },
        ),
        (raw) => {
          notes.length = 0;
          const plan = validatePlan(
            raw,
            flow.memberIds,
            notes,
            this.store.profile().name,
          );
          assertProjectPaths(
            this.store,
            flow.projectId,
            plan.tasks.flatMap((t) => t.allowedPaths),
          );
          return plan;
        },
      );
      if (!this.validOperation(op, result.runId)) return;
      for (const task of result.payload.tasks)
        if (!this.host.available(task.memberId, true))
          throw new FlowError(
            "MEMBER_UNAVAILABLE",
            "计划成员未连接或不支持文件任务。",
          );
      if (flow.sourceJointReviewId)
        await this.joint.sourceForPlan(
          flow.sourceJointReviewId,
          flow.projectId,
        );
      if (flow.sourceRoundtable)
        await this.host.roundtableSource!(
          flow.sourceRoundtable,
          flow.projectId,
        );
      const plan: Plan = {
        ...this.record(flow.projectId, flow.id),
        ...result.payload,
        sourceJointReviewId: flow.sourceJointReviewId,
        sourceRoundtable: flow.sourceRoundtable,
        roundtableMessageIds: sourceRoundtables.map(m => m.sourceRoundtable.messageId),
        version: (parent?.version ?? 0) + 1,
        parentPlanId: parent?.id,
        proposedByRunId: result.runId,
        status: "awaiting_confirmation",
        notes,
      };
      this.store.transaction(() => {
        this.store.put("flow_plans", plan.id, plan);
        stageFlowCard(this.store, "plan", plan);
        this.update("project_flows", this.flow(flow.id), {
          status: "awaiting_plan",
          activePlanId: plan.id,
          blockedReasons: [],
        });
        this.update("flow_operations", op, { state: "done" });
      });
    } catch (error) {
      this.failOperation(op, error);
      if (this.deferred(error as Error))
        this.update("project_flows", this.flow(flow.id), {
          dispatchMode: "paused",
          blockedReasons: [(error as Error).message],
        });
      else this.blocked(flow.id, error as Error);
    }
  }
  private restoreCompleted(flow: ProjectFlow) {
    const operations = this.store
      .list<FlowOperation>("flow_operations")
      .filter(
        (o) =>
          o.flowId === flow.id &&
          o.state === "blocked" &&
          o.recovery === "completed",
      );
    for (const op of operations) {
      const reply = finishedFlowReply(this.store, op);
      if (!reply)
        throw new FlowError(
          "UNKNOWN_RESULT",
          "已结束运行的真实回复缺失，请核对原运行。",
        );
      this.recoveringReplies.set(op.id, reply);
      const task = this.store.get<Task>("flow_tasks", op.targetId),
        integration = this.store.get<Integration>(
          "flow_integrations",
          op.targetId,
        ),
        requested = this.store.get<RequestedRoundCheck>(
          "flow_requested_checks",
          op.targetId,
        ),
        round = requested
          ? this.need<Round>("flow_rounds", requested.roundId)
          : integration
            ? this.need<Round>("flow_rounds", integration.roundId)
            : this.store.get<Round>("flow_rounds", op.targetId),
        lock = task?.id ?? round?.id ?? flow.id;
      if (task) {
        if (task.planId !== flow.activePlanId) {
          this.update("flow_operations", op, {
            state: "done",
            result: { superseded: true },
          });
          this.recoveringReplies.delete(op.id);
          continue;
        }
        this.update("flow_tasks", task, {
          status: ["review", "adjudication"].includes(op.kind)
            ? "awaiting_review"
            : op.kind === "rearrange"
              ? "escalated"
              : "queued",
          blockedReason: undefined,
          statusBeforeBlock: undefined,
        });
        for (const review of this.store
          .list<Review>("flow_reviews")
          .filter((r) => r.taskId === task.id && r.status === "running"))
          this.update("flow_reviews", review, {
            status: "stale",
            staleReason: "重启后从同一真实运行结果恢复。",
          });
      } else if (round) {
        if (
          round.planId !== flow.activePlanId ||
          (integration && round.integrationId !== integration.id)
        ) {
          this.update("flow_operations", op, {
            state: "done",
            result: { superseded: true },
          });
          this.recoveringReplies.delete(op.id);
          continue;
        }
        this.update("flow_rounds", round, {
          status: op.kind === "next-round" ? "pending" : "checking",
        });
      }
      this.busyTargets.add(lock);
      this.launch(
        async () => {
          try {
            const targetTask = task
                ? this.need<Task>("flow_tasks", task.id)
                : undefined,
              targetRound = round
                ? this.need<Round>("flow_rounds", round.id)
                : undefined,
              roundTasks = targetRound
                ? this.tasks(flow.id).filter(
                    (t) =>
                      t.roundId === targetRound.id && t.status !== "cancelled",
                  )
                : [];
            if (op.kind === "task") await this.executeTask(targetTask!);
            else if (op.kind === "review")
              await this.reviewTask(
                targetTask!,
                this.need<Submission>("flow_submissions", op.submissionId!),
              );
            else if (op.kind === "adjudication")
              await this.adjudicateTask(
                targetTask!,
                this.need<Submission>("flow_submissions", op.submissionId!),
              );
            else if (op.kind === "rearrange") await this.rearrange(targetTask!);
            else if (op.kind === "integration-check")
              await this.checkIntegratedRound(
                targetRound!,
                integration!,
                roundTasks,
              );
            else if (op.kind === "peer-review")
              await this.peerReviewRound(
                targetRound!,
                integration!,
                roundTasks,
              );
            else if (op.kind === "round-report")
              await this.reportIntegratedRound(
                targetRound!,
                integration!,
                roundTasks,
                op.sessionId!,
              );
            else if (op.kind === "next-round")
              await this.suggestNextRound(targetRound!);
            else if (op.kind === "requested-check")
              await this.runRequestedCheck(targetRound!, requested!);
            else if (op.kind === "plan") {
              const run = this.need<Run>("runs", op.runId!),
                material = run.input.includes("\n任务材料：")
                  ? JSON.parse(run.input.split("\n任务材料：")[1])
                  : {},
                parent = material.parentPlan?.id
                  ? this.need<Plan>("flow_plans", material.parentPlan.id)
                  : undefined;
              if (this.flow(flow.id).status !== "planning")
                throw new FlowError("STALE_VERSION", "原方案已被替换。");
              await this.proposed(
                this.flow(flow.id),
                material.instruction ?? flow.topic ?? "继续原方案",
                parent,
              );
            } else
              throw new FlowError(
                "UNKNOWN_RESULT",
                "此阶段需要单独核对投递回执，不能自动恢复。",
              );
          } finally {
            this.recoveringReplies.delete(op.id);
            this.busyTargets.delete(lock);
          }
        },
        (error) => {
          this.update("flow_operations", op, {
            state: "blocked",
            recovery: undefined,
            error: error.message,
          });
          this.blocked(flow.id, error, task?.id);
        },
      );
    }
  }
  private resumePlanning(flow: ProjectFlow) {
    for (const op of this.store
      .list<FlowOperation>("flow_operations")
      .filter(
        (o) =>
          o.flowId === flow.id &&
          o.state === "done" &&
          o.resumeRequested &&
          ["plan", "rearrange"].includes(o.kind) &&
          !o.continuedByOperationId,
      )) {
      if (this.busyTargets.has(op.targetId)) continue;
      this.busyTargets.add(op.targetId);
      this.launch(
        async () => {
          try {
            if (op.kind === "rearrange")
              await this.rearrange(this.need<Task>("flow_tasks", op.targetId));
            else {
              const run = op.runId
                  ? this.store.get<Run>("runs", op.runId)
                  : undefined,
                material = run?.input.includes("\n任务材料：")
                  ? JSON.parse(run.input.split("\n任务材料：")[1])
                  : {},
                parent = material.parentPlan?.id
                  ? this.need<Plan>("flow_plans", material.parentPlan.id)
                  : undefined;
              await this.proposed(
                this.flow(flow.id),
                material.instruction ?? flow.topic ?? "继续原方案",
                parent,
              );
            }
          } finally {
            this.busyTargets.delete(op.targetId);
          }
        },
        (error) =>
          this.blocked(
            flow.id,
            error,
            op.kind === "rearrange" ? op.targetId : undefined,
          ),
      );
    }
  }
  async invoke(method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;
    if ((JOINT_READS as readonly string[]).includes(method))
      return this.joint.read(method, p);
    if (method === "projectFlow.memberReports")
      return this.workbench.memberReports(p);
    if (method === "projectFlow.timeline")
      return new ProjectProgress(this.store).timeline(
        p,
        this.overviews()
          .filter((o) => o.stage)
          .map((o) => ({ flowId: o.flowId, label: o.stage!.label })),
      );
    if (method === "projectFlow.progress.detail")
      return new ProjectProgress(this.store).detail(p);
    if (method === "projectFlow.record") return this.workbench.record(p);
    if (method === "projectFlow.round.report.export")
      return this.workbench.roundExport(p);
    if (method === "projectFlow.task.proposal") {
      const proposal = this.need<TaskAddition>(
        "flow_task_additions",
        String(p.proposalId),
      );
      if (proposal.projectId !== p.projectId)
        throw new FlowError("NOT_FOUND", "追加项不属于这个项目。");
      return proposal;
    }
    if (method === "projectFlow.log") return this.logs.page(p);
    if (method === "projectFlow.log.export") return this.logs.export(p);
    if (method === "projectFlow.round.results")
      return new RoundResultReader(this.store).results(p);
    if (method === "projectFlow.round.preview")
      return new RoundResultReader(this.store).preview(p);
    if (method.startsWith("projectFlow.artifact.")) {
      const artifact = this.artifacts.get(String(p.artifactId));
      if (artifact.transient)
        throw new FlowError("NOT_FOUND", "临时复核副本不作为交付成果。");
      if (method.endsWith("files"))
        return (await listArtifacts(artifact.root)).map(
          ({ path: _, ...file }) => file,
        );
      if (method.endsWith("read"))
        return readArtifact(artifact.root, scopePath(text(p.path)));
      if (method.endsWith("diff")) {
        const against = p.against
          ? this.artifacts.get(String(p.against))
          : artifact.baseArtifactId
            ? this.artifacts.get(artifact.baseArtifactId)
            : artifact;
        if (against.projectId !== artifact.projectId)
          throw new FlowError("INVALID_PROJECT", "不能对比不同项目的成果。");
        return this.artifacts.diff(against, artifact);
      }
      throw new FlowError("NOT_FOUND", "成果操作不存在。");
    }
    if (method === "projectFlow.get") return this.snapshot(String(p.projectId));
    if (method === "projectFlow.history")
      return this.store
        .list<ProjectFlow>("project_flows")
        .filter(
          (f) =>
            f.projectId === p.projectId &&
            (!p.before || f.createdAt < String(p.before)),
        )
        .slice(-Math.min(100, Number(p.limit) || 20))
        .reverse();
    if (method === "projectFlow.detail") {
      const map: Record<string, string> = {
        plan: "flow_plans",
        task: "flow_tasks",
        submission: "flow_submissions",
        review: "flow_reviews",
        round: "flow_rounds",
        decision: "flow_decisions",
        integration: "flow_integrations",
        acceptance: "flow_acceptances",
        operation: "flow_operations",
      };
      const entity = map[String(p.kind)];
      if (!entity) throw new FlowError("NOT_FOUND", "记录类别不正确。");
      const value = this.need<FlowRecord>(entity, String(p.id));
      if (value.projectId !== p.projectId)
        throw new FlowError("NOT_FOUND", "记录不属于当前项目。");
      return this.withActions(entity, value);
    }
    const requestId = text(p.requestId);
    if (requestId.length > 100)
      throw new FlowError("INVALID_REQUEST", "请求编号过长。");
    const key = JSON.stringify([method, params]);
    const existing = this.store.get<{ key: string; result?: unknown }>(
      "flow_requests",
      requestId,
    );
    if (existing) {
      if (existing.key !== key)
        throw new FlowError("REQUEST_REUSED", "请求编号不能用于另一项操作。");
      if (this.requests.has(requestId)) return this.requests.get(requestId);
      if (existing.result !== undefined) return existing.result;
      throw new FlowError("UNKNOWN_RESULT", "上次操作尚未核对，未重复执行。");
    }
    this.store.put("flow_requests", requestId, { key });
    const promise = this.mutate(method, p)
      .then((result) => {
        this.store.put("flow_requests", requestId, { key, result });
        return result;
      })
      .catch((error) => {
        this.store.delete("flow_requests", requestId);
        throw error;
      })
      .finally(() => {
        this.requests.delete(requestId);
        this.host.changed();
        this.kick();
      });
    this.requests.set(requestId, promise);
    return promise;
  }
  private additionRound(flow: ProjectFlow, roundId?: unknown) {
    if (flow.status !== "active" || !flow.activePlanId)
      throw new FlowError(
        "FLOW_ACTIVE",
        "请在已确认且尚未结束的方案里追加任务。",
      );
    const round = this.need<Round>(
      "flow_rounds",
      String(roundId ?? flow.currentRoundId),
    );
    if (
      round.flowId !== flow.id ||
      round.planId !== flow.activePlanId ||
      ![
        "pending",
        "executing",
        "changes_requested",
        "awaiting_acceptance",
      ].includes(round.status)
    )
      throw new FlowError(
        "ROUND_STARTED",
        "请选本方案尚未验收的轮次；整合和检查进行时先等待结果。",
      );
    if (this.busyTargets.has(round.id))
      throw new FlowError("ROUND_BUSY", "本轮正在汇总，等待完成后再确认追加。");
    return round;
  }
  private async prepareAddition(p: Record<string, unknown>) {
    const flow = this.flow(String(p.flowId));
    this.check(flow, p);
    const round = this.additionRound(flow, p.roundId),
      plan = this.need<Plan>("flow_plans", flow.activePlanId!),
      memberId = text(p.memberId);
    if (
      !flow.memberIds.includes(memberId) ||
      !this.host.available(memberId, true)
    )
      throw new FlowError(
        "MEMBER_UNAVAILABLE",
        "追加任务只能安排给本流程内可用成员。",
      );
    if (
      this.store
        .list<FlowOperation>("flow_operations")
        .some(
          (o) =>
            o.flowId === flow.id &&
            o.kind === "task-addition" &&
            o.state === "blocked",
        )
    )
      throw new FlowError(
        "UNKNOWN_RESULT",
        "先核对上次追加任务的准备结果；不会自动重发。",
      );
    const title = text(p.title),
      goal = text(p.goal),
      supplied =
        p.completionCriteria === undefined
          ? []
          : parseCompletionCriteria(p.completionCriteria),
      paths =
        p.allowedPaths === undefined
          ? []
          : texts(p.allowedPaths).map(scopePath);
    rejectUserCriteria(supplied, this.store.profile().name);
    const dependencies =
        p.dependencies === undefined ? [] : texts(p.dependencies, true),
      known = this.tasks(flow.id).filter((t) => t.planId === flow.activePlanId);
    if (
      dependencies.some(
        (id) =>
          !known.some(
            (t) =>
              t.id === id &&
              t.status !== "cancelled" &&
              this.need<Round>("flow_rounds", t.roundId).index <= round.index,
          ),
      )
    )
      throw new FlowError(
        "DEPENDENCY_BLOCKED",
        "依赖只能是本方案内此前或本轮的现有任务。",
      );
    let sourceMessageId: string | undefined;
    if (p.sourceMessageId) {
      if (
        !projectRequestSource(
          this.store,
          flow,
          String(p.sourceMessageId),
          memberId,
          false,
        )
      )
        throw new FlowError(
          "NOT_FOUND",
          "来源必须是本项目会议或这位成员汇报中的用户消息。",
        );
      sourceMessageId = String(p.sourceMessageId);
    }
    if (flow.dispatchMode !== "running")
      throw new FlowError(
        "PAUSED",
        "请继续派发后让负责人补全追加任务；准备期间不会执行文件任务。",
      );
    if (p.sourceText && !p.sourceMessageId) {
      const id = randomUUID(),
        thread = this.store.currentRoomThread(flow.roomId as RoomId);
      this.store.put("room_messages", id, {
        id,
        roomId: flow.roomId,
        threadId: thread.id,
        author: "user",
        text: text(p.sourceText),
        at: at(),
        taskRequest: true,
      });
      sourceMessageId = id;
    }
    assertProjectPaths(this.store, flow.projectId, paths);
    const sourceRoundtable = p.sourceRoundtable
      ? (object(p.sourceRoundtable, [
          "topicId",
          "conclusionId",
          "messageId",
        ]) as NonNullable<ProjectFlow["sourceRoundtable"]>)
      : undefined;
    if (sourceRoundtable) {
      await this.host.roundtableSource!(sourceRoundtable, flow.projectId);
      const current = this.flow(flow.id);
      if (
        current.activePlanId !== plan.id ||
        this.need<Plan>("flow_plans", plan.id).revision !== plan.revision
      )
        throw new FlowError("STALE_REVISION", "核对圆桌材料期间方案已改变。");
      this.additionRound(current, round.id);
      if (current.dispatchMode !== "running")
        throw new FlowError("PAUSED", "准备任务期间已暂停，请明确继续。");
    }
    const proposal: TaskAddition = {
      ...this.record(flow.projectId, flow.id),
      planId: plan.id,
      expectedPlanRevision: plan.revision,
      roundId: round.id,
      memberId,
      title,
      goal,
      completionCriteria: supplied,
      allowedPaths: paths,
      dependencies,
      sourceMessageId,
      sourceRoundtable,
      source: sourceMessageId
        ? projectRequestSource(
            this.store,
            flow,
            sourceMessageId,
            memberId,
            false,
          )!
        : "task-card",
      status: "preparing",
    };
    this.store.put("flow_task_additions", proposal.id, proposal);
    const session = this.host.session(
      flow.projectId,
      roundLead(flow, round),
      "补全追加任务 · " + title,
      false,
    );
    this.store.put("sessions", session.id, {
      ...session,
      flowId: flow.id,
      purpose: "flow-plan",
    });
    const op = this.operation(flow, "task-addition", proposal, session.id);
    this.update("flow_task_additions", proposal, { operationId: op.id });
    this.launch(async () => {
      try {
        const roundtableMaterial = sourceRoundtable
          ? await this.host.roundtableSource!(sourceRoundtable, flow.projectId)
          : undefined;
        const result = await this.protocol(
          op,
          "task-addition",
          flowPrompt(
            "task-addition",
            {
              completionCriteria: [{ text: "具体可核对标准", kind: "check" }],
              allowedPaths: ["成果文件"],
              inScope: true,
              scopeReason: "与方案目标和范围的关系",
            },
            {
              objective: plan.objective,
              scope: plan.scope,
              deliverables: plan.deliverables,
              proposal,
              sourceRoundtable: roundtableMaterial,
              tasks: known,
              rules:
                "仅补全并判断是否超出方案目标或范围，不执行文件任务。用户已有标准和许可路径不能改写。未指定路径时只选择现有任务声明的范围；需要新范围明确 inScope:false。非工程标准可以用 judge、owner。",
            },
          ),
          (raw) => {
            const payload = payloadObject(raw, "task-addition");
            if (typeof payload.inScope !== "boolean")
              throw new FlowError("INVALID_PROTOCOL", "追加范围判断必须明确。");
            const criteria = supplied.length
                ? supplied
                : parseCompletionCriteria(payload.completionCriteria),
              allowedPaths = paths.length
                ? paths
                : texts(payload.allowedPaths).map(scopePath);
            rejectUserCriteria(criteria, this.store.profile().name);
            assertProjectPaths(this.store, flow.projectId, allowedPaths);
            return {
              completionCriteria: criteria,
              allowedPaths,
              inScope: payload.inScope,
              scopeReason: text(payload.scopeReason),
            };
          },
        );
        if (!this.validOperation(op, result.runId)) return;
        if (sourceRoundtable)
          await this.host.roundtableSource!(sourceRoundtable, flow.projectId);
        const latest = this.flow(flow.id);
        if (
          latest.activePlanId !== plan.id ||
          this.need<Plan>("flow_plans", plan.id).revision !== plan.revision
        )
          throw new FlowError(
            "STALE_REVISION",
            "方案已改变，旧追加提案不再可确认。",
          );
        this.store.transaction(() => {
          this.update("flow_task_additions", proposal, {
            ...result.payload,
            status: "ready",
          });
          this.update("flow_operations", op, { state: "done" });
        });
      } catch (error) {
        this.failOperation(op, error);
        this.update("flow_task_additions", proposal, {
          status: "blocked",
          error: (error as Error).message,
        });
      }
    });
    return {
      requestId: p.requestId,
      entityId: proposal.id,
      proposalId: proposal.id,
      pending: true,
    };
  }
  private async confirmAddition(p: Record<string, unknown>) {
    const proposal = this.need<TaskAddition>(
      "flow_task_additions",
      String(p.proposalId),
    );
    this.check(proposal, p);
    if (proposal.status === "confirmed")
      return { entityId: proposal.taskId, pending: false };
    if (proposal.status !== "ready")
      throw new FlowError("STALE_REVISION", "请先核对负责人补全后的追加提案。");
    const flow = this.flow(proposal.flowId),
      round = this.additionRound(flow, proposal.roundId),
      plan = this.need<Plan>("flow_plans", proposal.planId);
    if (
      flow.activePlanId !== plan.id ||
      plan.revision !== proposal.expectedPlanRevision
    )
      throw new FlowError("STALE_REVISION", "方案已改变，请重新准备追加任务。");
    if (proposal.sourceRoundtable) {
      await this.host.roundtableSource!(
        proposal.sourceRoundtable,
        flow.projectId,
      );
      this.check(
        this.need<TaskAddition>("flow_task_additions", proposal.id),
        p,
      );
    }
    const prior = this.tasks(flow.id).filter(
        (t) => t.planId === plan.id && t.status !== "cancelled",
      ),
      outside = proposal.allowedPaths.some(
        (path) =>
          !prior.some((t) =>
            t.allowedPaths.some((scope) => pathWithin(path, scope)),
          ),
      );
    if (outside || proposal.inScope === false) {
      const decision: Decision = {
        ...this.record(flow.projectId, flow.id),
        kind: "scope-change",
        additionId: proposal.id,
        roundId: round.id,
        title: "追加任务的目标或范围需要确认",
        reason: proposal.scopeReason ?? "新增了方案未声明的路径。",
        options: ["确认追加范围", "不追加"],
        eligibleTaskIds: [],
        sourceVersions: round.baseVersion ? [round.baseVersion] : [],
        status: "open",
      };
      this.store.transaction(() => {
        this.saveDecision(decision);
        this.update("flow_task_additions", proposal, {
          status: "scope-change",
          decisionId: decision.id,
        });
      });
      return {
        requestId: p.requestId,
        entityId: proposal.id,
        decisionId: decision.id,
        pending: false,
      };
    }
    return this.appendAddition(proposal);
  }
  private async appendAddition(proposal: TaskAddition) {
    const roundtableMaterial = proposal.sourceRoundtable
      ? await this.host.roundtableSource!(
          proposal.sourceRoundtable,
          proposal.projectId,
        )
      : undefined;
    const current = this.need<TaskAddition>("flow_task_additions", proposal.id);
    if (current.status === "confirmed")
      return { entityId: current.taskId, pending: false };
    if (current.revision !== proposal.revision)
      throw new FlowError("STALE_REVISION", "追加提案已更新，请刷新后操作。");
    assertProjectPaths(this.store, proposal.projectId, proposal.allowedPaths);
    const flow = this.flow(proposal.flowId),
      round = this.additionRound(flow, proposal.roundId),
      plan = this.need<Plan>("flow_plans", proposal.planId);
    if (
      flow.activePlanId !== plan.id ||
      plan.status !== "confirmed" ||
      plan.revision !== proposal.expectedPlanRevision
    )
      throw new FlowError("STALE_REVISION", "方案已改变，请重新准备追加任务。");
    if (
      !flow.memberIds.includes(proposal.memberId) ||
      !this.host.available(proposal.memberId, true)
    )
      throw new FlowError("MEMBER_UNAVAILABLE", "任务成员已不可用。");
    const prior = this.tasks(flow.id).filter(
      (t) => t.planId === plan.id && t.status !== "cancelled",
    );
    if (prior.length >= FLOW_LIMITS.tasks)
      throw new FlowError("LIMIT_REACHED", "本方案任务数量已达到上限。");
    const dependencies = [
      ...new Set([
        ...proposal.dependencies,
        ...prior
          .filter(
            (t) =>
              t.roundId === round.id &&
              (t.memberId === proposal.memberId ||
                scopesOverlap(t.allowedPaths, proposal.allowedPaths)),
          )
          .map((t) => t.id),
      ]),
    ];
    if (
      dependencies.some(
        (id) =>
          !prior.some(
            (t) =>
              t.id === id &&
              this.need<Round>("flow_rounds", t.roundId).index <= round.index,
          ),
      )
    )
      throw new FlowError(
        "DEPENDENCY_BLOCKED",
        "依赖已失效，请重新准备追加项。",
      );
    const now = at(),
      task: Task = {
        ...this.record(flow.projectId, flow.id),
        planId: plan.id,
        roundId: round.id,
        key: "added-" + proposal.id,
        title: proposal.title,
        memberId: proposal.memberId,
        goal: proposal.goal,
        inputs: roundtableMaterial
          ? [
              "圆桌已确认选用的稿件与结论：" +
                JSON.stringify(roundtableMaterial),
            ]
          : [],
        completionCriteria: proposal.completionCriteria,
        dependencies,
        allowedPaths: proposal.allowedPaths,
        kind: "implementation",
        reviewerMemberId: this.reviewer(flow, proposal.memberId),
        returnCount: 0,
        rearrangeCount: 0,
        status: "pending",
        findingIds: [],
        additionId: proposal.id,
        sourceMessageId: proposal.sourceMessageId,
        confirmedAt: now,
      };
    this.store.transaction(() => {
      if (round.integrationId) {
        const integration = this.need<Integration>(
          "flow_integrations",
          round.integrationId,
        );
        this.update("flow_integrations", integration, { status: "stale" });
        for (const acceptance of this.store
          .list<Acceptance>("flow_acceptances")
          .filter(
            (a) =>
              a.integrationId === integration.id && a.status === "requested",
          ))
          this.update("flow_acceptances", acceptance, {
            status: "changes_requested",
            opinion: "追加任务后需要重新汇总和验收。",
          });
      }
      this.store.put("flow_tasks", task.id, task);
      this.update("flow_rounds", round, {
        taskIds: [...round.taskIds, task.id],
        status: round.status === "pending" ? "pending" : "executing",
        integrationId: undefined,
        acceptanceId: undefined,
        requestedCheckId: undefined,
        report: undefined,
        reportedAt: undefined,
        manualAcceptance: undefined,
      });
      this.update("flow_task_additions", proposal, {
        status: "confirmed",
        taskId: task.id,
        confirmedAt: now,
      });
    });
    return { entityId: task.id, revision: task.revision, pending: false };
  }
  private async mutate(method: string, p: Record<string, unknown>) {
    if ((JOINT_WRITES as readonly string[]).includes(method))
      return this.joint.mutate(method, p);
    if (method === "projectFlow.record.write") {
      const flow = this.flow(String(p.flowId));
      if (flow.projectId !== p.projectId)
        throw new FlowError("NOT_FOUND", "记录不属于当前项目。");
      return this.workbench.write(flow.id);
    }
    if (method === "projectFlow.task.prepare") return this.prepareAddition(p);
    if (method === "projectFlow.task.add") return this.confirmAddition(p);
    if (method === "projectFlow.log.write") return this.logs.write(p);
    if (method === "projectFlow.review.configure") {
      const flow = this.flow(String(p.flowId));
      this.check(flow, p);
      if (["completed", "cancelled"].includes(flow.status))
        throw new FlowError("STALE_REVISION", "流程已结束。");
      const level = this.configuredLevel(p.reviewLevel);
      if (level === "high" && flow.memberIds.length < 2)
        throw new FlowError(
          "REVIEWER_REQUIRED",
          "最高程度需要另一名成员复核负责人自己的任务。",
        );
      if (p.roundId) {
        const round = this.need<Round>("flow_rounds", String(p.roundId));
        if (
          round.flowId !== flow.id ||
          round.planId !== flow.activePlanId ||
          round.status !== "pending" ||
          this.tasks(flow.id).some((t) => t.roundId === round.id && t.sessionId)
        )
          throw new FlowError(
            "ROUND_STARTED",
            "每轮程度只可在尚未开工时单独调整。",
          );
        this.update("flow_rounds", round, {
          reviewLevel: level,
          ...(level === "low" ? { requiresUserAcceptance: true } : {}),
        });
        return {
          requestId: p.requestId,
          entityId: round.id,
          revision: this.need<Round>("flow_rounds", round.id).revision,
          pending: false,
        };
      }
      const updated = this.update("project_flows", flow, {
        reviewLevel: level,
      });
      return {
        requestId: p.requestId,
        entityId: flow.id,
        revision: updated.revision,
        pending: false,
      };
    }
    if (method === "projectFlow.start") {
      const project = this.need<Project>("projects", String(p.projectId));
      if (project.kind)
        throw new FlowError("INVALID_PROJECT", "请在工作项目中启动项目流程。");
      const sourceJointReviewId =
          p.sourceJointReviewId === undefined
            ? undefined
            : text(p.sourceJointReviewId),
        sourceJointReview = sourceJointReviewId
          ? await this.joint.sourceForPlan(sourceJointReviewId, project.id)
          : undefined;
      assertProjectSerial(this.store, project.id);
      if (
        this.store
          .list<ProjectFlow>("project_flows")
          .some(
            (f) =>
              f.projectId === project.id &&
              !["completed", "cancelled"].includes(f.status),
          )
      )
        throw new FlowError("FLOW_ACTIVE", "这个项目已有进行中的流程。");
      const memberIds = [
          ...new Set(Array.isArray(p.memberIds) ? p.memberIds.map(String) : []),
        ],
        leadMemberId = text(p.leadMemberId);
      if (
        !memberIds.includes(leadMemberId) ||
        !memberIds.length ||
        memberIds.some((id) => !this.host.available(id, false))
      )
        throw new FlowError(
          "MEMBER_UNAVAILABLE",
          "请选择已连接的负责人和团队成员。",
        );
      if (!memberIds.some((id) => id !== leadMemberId))
        throw new FlowError(
          "REVIEWER_REQUIRED",
          "负责人参与任务时需要另一名成员复核。",
        );
      if (
        !this.host.quotaAllows(
          leadMemberId,
          this.host.configuration?.(project.id, leadMemberId).model,
        )
      )
        throw new FlowError(
          "QUOTA_BLOCKED",
          "负责人额度已耗尽，请刷新额度或选择其他负责人。",
        );
      const topic =
          p.topic === undefined
            ? (sourceJointReview?.conclusion?.summary ?? "")
            : text(p.topic, true),
        previous = this.store
          .list<ProjectFlow>("project_flows")
          .filter(
            (flow) =>
              flow.projectId === project.id &&
              ["completed", "cancelled"].includes(flow.status),
          )
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      this.store.ensureProjectRoom(project.id);
      const discussionContext = captureFlowDiscussion(
        this.store,
        project.id,
        p,
        topic ? undefined : previous?.updatedAt,
      );
      if (
        !topic &&
        !discussionContext.messages.length &&
        !discussionContext.minutes?.text.trim() &&
        !discussionContext.background?.trim()
      )
        throw new FlowError(
          "INVALID_REQUEST",
          "请先在本项目会议室讨论这次要完成的内容，或填写 topic。",
        );
      const instruction = topic || "根据本项目会议讨论起草方案",
        flow: ProjectFlow = {
          ...this.record(project.id, ""),
          leadMemberId,
          memberIds,
          reviewLevel: this.configuredLevel(p.reviewLevel, "medium"),
          roomId: discussionContext.roomId,
          threadId: discussionContext.threadId,
          topic: instruction,
          discussionContext,
          dispatchMode: "running",
          status: "planning",
          blockedReasons: [],
        };
      flow.writeBoundary = captureProjectBoundary(this.store, project.id);
      flow.sourceJointReviewId = sourceJointReviewId;
      if (p.sourceRoundtable) {
        if (!this.host.roundtableSource)
          throw new FlowError("INVALID_SUBJECT", "圆桌材料不可用。");
        flow.sourceRoundtable = object(p.sourceRoundtable, [
          "topicId",
          "conclusionId",
          "messageId",
        ]) as NonNullable<ProjectFlow["sourceRoundtable"]>;
        await this.host.roundtableSource(flow.sourceRoundtable, project.id);
      }
      if (this.host.configuration)
        flow.memberConfigs = Object.fromEntries(
          memberIds.map((id) => [id, this.host.configuration!(project.id, id)]),
        );
      flow.memberNames = Object.fromEntries(
        this.store
          .members()
          .filter((m) => memberIds.includes(m.id))
          .map((m) => [m.id, m.name]),
      );
      if (previous && p.includePreviousRecord !== false) {
        const record = this.workbench.record({ flowId: previous.id });
        flow.previousRecord = { flowId: previous.id, summary: record.summary };
      }
      flow.flowId = flow.id;
      this.store.put("project_flows", flow.id, flow);
      this.launch(() => this.proposed(flow, instruction));
      return {
        requestId: p.requestId,
        entityId: flow.id,
        revision: flow.revision,
        pending: true,
      };
    }
    if (method === "projectFlow.plan.revise") {
      const plan = this.need<Plan>("flow_plans", String(p.planId));
      this.check(plan, p);
      const flow = this.flow(plan.flowId),
        instruction =
          text(p.instruction ?? "", true) ||
          "用户选择修改方案，未补充意见。沿用现有任务目标和范围，复查方案并提出改进。";
      if (
        !["awaiting_confirmation", "confirmed"].includes(plan.status) ||
        flow.activePlanId !== plan.id
      )
        throw new FlowError("STALE_REVISION", "该方案已被替代。");
      const roomId = ("project:" +
          flow.projectId) as import("../shared/types").RoomId,
        minutes = this.store.roomState(roomId).discussion?.meetingMinutes;
      if (
        minutes?.source === "user" &&
        minutes.status === "done" &&
        this.store.currentRoomThread(roomId).id === flow.threadId
      )
        this.update("project_flows", flow, {
          discussionContext: captureFlowDiscussion(this.store, flow.projectId, {
            threadId: flow.threadId,
            minutesMessageId: minutes.messageId,
          }),
        });
      this.prepareReplan(this.flow(flow.id));
      this.launch(() => this.proposed(this.flow(flow.id), instruction, plan));
      return {
        requestId: p.requestId,
        entityId: plan.id,
        revision: plan.revision,
        pending: true,
      };
    }
    if (method === "projectFlow.plan.confirm") {
      const plan = this.need<Plan>("flow_plans", String(p.planId));
      this.check(plan, p);
      const flow = this.flow(plan.flowId);
      if (
        plan.status !== "awaiting_confirmation" ||
        flow.activePlanId !== plan.id ||
        flow.status !== "awaiting_plan"
      )
        throw new FlowError("STALE_REVISION", "该方案已被替代或正在调整。");
      if (flow.sourceJointReviewId)
        await this.joint.sourceForPlan(
          flow.sourceJointReviewId,
          flow.projectId,
        );
      if (flow.sourceRoundtable)
        await this.host.roundtableSource!(
          flow.sourceRoundtable,
          flow.projectId,
        );
      assertProjectBoundary(this.store, flow.projectId, flow.writeBoundary);
      assertProjectPaths(
        this.store,
        flow.projectId,
        plan.tasks.flatMap((t) => t.allowedPaths),
      );
      assertProjectSerial(this.store, flow.projectId);
      for (const r of plan.rounds) {
        const choice = (
          p.requiresUserAcceptanceByRound as Record<string, boolean> | undefined
        )?.[r.key];
        if (choice !== undefined && typeof choice !== "boolean")
          throw new FlowError("INVALID_REQUEST", "每轮验收选择必须明确。");
      }
      const level = this.configuredLevel(p.reviewLevel, reviewLevel(flow)),
        peerChoices = p.requiresPeerReviewByRound as
          | Record<string, unknown>
          | undefined;
      for (const r of plan.rounds)
        if (
          peerChoices?.[r.key] !== undefined &&
          typeof peerChoices[r.key] !== "boolean"
        )
          throw new FlowError("INVALID_REQUEST", "整轮他人复核选择必须明确。");
      const priorRound = flow.currentRoundId
          ? this.store.get<Round>("flow_rounds", flow.currentRoundId)
          : undefined,
        priorIntegration = priorRound?.integrationId
          ? this.store.get<Integration>(
              "flow_integrations",
              priorRound.integrationId,
            )
          : undefined,
        priorArtifact =
          priorRound?.status === "accepted" && priorIntegration?.version
            ? this.artifacts.get(priorIntegration.version.artifactId)
            : priorRound?.baseVersion
              ? this.artifacts.get(priorRound.baseVersion.artifactId)
              : undefined;
      const base = await this.artifacts.capture(
        flow,
        priorArtifact?.root ??
          this.need<Project>("projects", flow.projectId).directory,
        "base",
        priorArtifact?.baseArtifactId,
        priorArtifact?.fingerprint,
      );
      const roundMap = new Map<string, Round>(),
        taskMap = new Map<string, Task>();
      try {
        this.check(this.need<Plan>("flow_plans", plan.id), p);
        const latest = this.flow(flow.id);
        if (
          latest.status !== "awaiting_plan" ||
          latest.activePlanId !== plan.id
        )
          throw new FlowError(
            "STALE_REVISION",
            "捕获基线期间方案或流程已改变。",
          );
      } catch (error) {
        await this.artifacts.remove(base);
        throw error;
      }
      plan.rounds.forEach((r, index) => {
        const choice = (
            p.requiresUserAcceptanceByRound as
              | Record<string, boolean>
              | undefined
          )?.[r.key],
          roundLevel = this.configuredLevel(
            (p.reviewLevelByRound as Record<string, unknown> | undefined)?.[
              r.key
            ],
            r.reviewLevel ?? level,
          );
        const round: Round = {
          ...this.record(flow.projectId, flow.id),
          ...r,
          planId: plan.id,
          index,
          reviewLevel:
            (p.reviewLevelByRound as Record<string, unknown> | undefined)?.[
              r.key
            ] !== undefined
              ? roundLevel
              : r.reviewLevel,
          requiresUserAcceptance:
            index === plan.rounds.length - 1 || roundLevel === "low"
              ? true
              : (choice ?? r.requiresUserAcceptance),
          requiresPeerReview: peerChoices?.[r.key] === true,
          taskIds: [],
          integrationFixCount: 0,
          status: index === 0 ? "executing" : "pending",
          startedAt: index === 0 ? flow.createdAt : undefined,
          baseVersion: index === 0 ? this.artifacts.version(base) : undefined,
        };
        roundMap.set(r.key, round);
      });
      for (const spec of plan.tasks) {
        const round = roundMap.get(spec.roundKey)!,
          reviewerMemberId =
            spec.reviewerMemberId ??
            this.reviewer(flow, spec.memberId, [...taskMap.values()]);
        const task: Task = {
          ...this.record(flow.projectId, flow.id),
          ...spec,
          planId: plan.id,
          roundId: round.id,
          kind: "implementation",
          reviewerMemberId,
          returnCount: 0,
          disputeReturnWaiverCount: 0,
          rearrangeCount: 0,
          status: "pending",
          findingIds: [],
        };
        taskMap.set(spec.key, task);
        round.taskIds.push(task.id);
      }
      const rounds = [...roundMap.values()];
      rounds.forEach((r, i) => (r.predecessorRoundId = rounds[i - 1]?.id));
      const reused = await this.reusableTasks(plan, base, taskMap, roundMap);
      try {
        assertProjectPaths(
          this.store,
          flow.projectId,
          plan.tasks.flatMap((t) => t.allowedPaths),
        );
        assertProjectSerial(this.store, flow.projectId);
        if (flow.sourceJointReviewId)
          await this.joint.sourceForPlan(
            flow.sourceJointReviewId,
            flow.projectId,
          );
        if (flow.sourceRoundtable)
          await this.host.roundtableSource!(
            flow.sourceRoundtable,
            flow.projectId,
          );
        this.check(this.need<Plan>("flow_plans", plan.id), p);
        const latest = this.flow(flow.id);
        if (
          latest.status !== "awaiting_plan" ||
          latest.activePlanId !== plan.id
        )
          throw new FlowError(
            "STALE_REVISION",
            "核对沿用成果期间方案或流程已改变。",
          );
      } catch (error) {
        await this.artifacts.remove(base);
        throw error;
      }
      this.store.transaction(() => {
        if (plan.parentPlanId) {
          const parent = this.need<Plan>("flow_plans", plan.parentPlanId);
          this.update("flow_plans", parent, { status: "superseded" });
          for (const t of this.store
            .list<Task>("flow_tasks")
            .filter(
              (t) =>
                t.planId === parent.id &&
                !["accepted", "integrated"].includes(t.status),
            ))
            this.update("flow_tasks", t, { status: "cancelled" });
          for (const d of this.store
            .list<Decision>("flow_decisions")
            .filter((d) => d.flowId === flow.id && d.status === "open"))
            this.update("flow_decisions", d, { status: "expired" });
        }
        for (const write of reused)
          this.store.put(write.entity, write.id, write.value);
        for (const r of rounds) this.store.put("flow_rounds", r.id, r);
        for (const t of taskMap.values())
          this.store.put("flow_tasks", t.id, {
            ...t,
            dependencies: t.dependencies.map((key) => taskMap.get(key)!.id),
          });
        this.update("flow_plans", plan, {
          status: "confirmed",
          confirmedAt: at(),
        });
        this.update("project_flows", this.flow(flow.id), {
          status: "active",
          reviewLevel: level,
          currentRoundId: rounds[0].id,
          blockedReasons: [],
        });
      });
      return {
        requestId: p.requestId,
        entityId: flow.id,
        revision: this.flow(flow.id).revision,
        pending: false,
      };
    }
    if (
      method === "projectFlow.pause" ||
      method === "projectFlow.resume" ||
      method === "projectFlow.cancel"
    ) {
      const flow = this.flow(String(p.flowId));
      this.check(flow, p);
      if (["completed", "cancelled"].includes(flow.status))
        throw new FlowError("STALE_REVISION", "流程已结束，不能修改历史状态。");
      if (method.endsWith("resume")) {
        const held = this.store
          .list<FlowOperation>("flow_operations")
          .filter(
            (o) =>
              o.flowId === flow.id &&
              o.state === "blocked" &&
              o.recovery !== "completed",
          );
        if (held.length)
          throw new FlowError(
            "UNKNOWN_RESULT",
            "请先处理阻塞事项，继续不会重发未知运行。",
          );
        if (
          this.store
            .list<Decision>("flow_decisions")
            .some(
              (d) =>
                d.flowId === flow.id &&
                d.status === "open" &&
                ["unresolved-review", "replan", "review-dispute"].includes(
                  d.kind,
                ),
            )
        )
          throw new FlowError(
            "DECISION_REQUIRED",
            "请先处理复核或重做决策；继续不会自动重做。",
          );
        // A task that failed before any member started (preparing its copy, merging dependencies) has no attempt to give up;
        // continuing retries it. Tasks blocked after a member's work keep waiting for the owner.
        // A review that could not decide is reviewed again (the task itself is kept).
        for (const task of this.retryable(flow))
          this.update("flow_tasks", task, {
            status:
              ["pending", "ready", "queued"].includes(
                task.statusBeforeBlock ?? "",
              ) || !task.latestSubmissionId
                ? "pending"
                : "awaiting_review",
            blockedReason: undefined,
            statusBeforeBlock: undefined,
            activeRunId: undefined,
          });
        if (flow.blockedReasons.length)
          this.update("project_flows", flow, { blockedReasons: [] });
      }
      this.update("project_flows", this.flow(flow.id), {
        dispatchMode: method.endsWith("resume")
          ? "running"
          : p.mode === "stop"
            ? "stopping"
            : "paused",
        ...(method.endsWith("cancel") ? { status: "cancelled" as const } : {}),
      });
      if (method.endsWith("resume")) {
        this.restoreCompleted(this.flow(flow.id));
        this.resumePlanning(this.flow(flow.id));
      }
      if (p.mode === "stop" || method.endsWith("cancel"))
        await Promise.all(
          this.store
            .list<FlowOperation>("flow_operations")
            .filter(
              (o) => o.flowId === flow.id && o.state === "running" && o.runId,
            )
            .map((o) => this.host.stop(o.correctionRunId ?? o.runId!)),
        );
      if (method.endsWith("cancel")) await this.workbench.finish(flow.id);
      return {
        requestId: p.requestId,
        entityId: flow.id,
        revision: this.flow(flow.id).revision,
        pending: false,
        activeTaskContinues: p.mode !== "stop",
      };
    }
    if (method === "projectFlow.task.reassign") {
      const task = this.need<Task>("flow_tasks", String(p.taskId));
      this.check(task, p);
      this.manualTaskRedo(task, p, String(p.requestId));
      return {
        requestId: p.requestId,
        entityId: task.id,
        revision: this.need<Task>("flow_tasks", task.id).revision,
        pending: false,
      };
    }
    if (method === "projectFlow.task.supplement") return this.supplementTask(p);
    if (method === "projectFlow.round.requestCheck") {
      const round = this.need<Round>("flow_rounds", String(p.roundId));
      this.check(round, p);
      const integration = this.need<Integration>(
          "flow_integrations",
          String(p.integrationId),
        ),
        check = this.requestRoundCheck(round, integration, text(p.memberId));
      return {
        requestId: p.requestId,
        entityId: check.id,
        revision: check.revision,
        pending: true,
      };
    }
    if (method === "projectFlow.round.accept") {
      const round = this.need<Round>("flow_rounds", String(p.roundId));
      this.check(round, p);
      const integration = this.need<Integration>(
        "flow_integrations",
        String(p.integrationId),
      );
      if (
        this.busyTargets.has(round.id) ||
        (round.acceptanceId &&
          ["requested", "applying", "recovery_required"].includes(
            this.need<Acceptance>("flow_acceptances", round.acceptanceId)
              .status,
          ))
      )
        throw new FlowError(
          "RECOVERY_REQUIRED",
          "上一项验收写入还未核对完成。",
        );
      const flow = this.flow(round.flowId);
      if (
        flow.status !== "active" ||
        round.planId !== flow.activePlanId ||
        round.status !== "awaiting_acceptance" ||
        round.integrationId !== integration.id ||
        integration.status !== "ready" ||
        p.fingerprint !== integration.version?.fingerprint
      )
        throw new FlowError("STALE_VERSION", "请选择当前待验收的整合版本。");
      if (
        this.store
          .list<Decision>("flow_decisions")
          .some(
            (decision) =>
              decision.roundId === round.id &&
              [
                "meeting-request",
                "review-choice",
                "unresolved-review",
                "replan",
                "review-dispute",
              ].includes(decision.kind) &&
              decision.status === "open",
          )
      )
        throw new FlowError(
          "MEETING_PENDING",
          "请先处理会议要求或复核决策，再验收成品。",
        );
      if (this.pendingScope(round.id))
        throw new FlowError(
          "SCOPE_PENDING",
          "请先处理补充要求的范围决策，再验收成品。",
        );
      if (roundMeetingMaterial(this.store, round).pendingUserMessages.length) {
        this.update("flow_rounds", round, { status: "checking" });
        throw new FlowError(
          "MEETING_PENDING",
          "会议里有新的发言尚未纳入汇报，负责人会先补充汇报，请核对后再验收。",
        );
      }
      const acceptance: Acceptance = {
        ...this.record(round.projectId, round.flowId),
        roundId: round.id,
        integrationId: integration.id,
        version: integration.version!,
        actor: "user",
        opinion: String(p.opinion ?? "验收通过"),
        requiresApply: true,
        status: "requested",
        appliedPaths: [],
        conflictPaths: [],
      };
      this.store.transaction(() => {
        this.store.put("flow_acceptances", acceptance.id, acceptance);
        this.update("flow_rounds", round, { acceptanceId: acceptance.id });
      });
      this.busyTargets.add(round.id);
      this.launch(
        async () => {
          try {
            await this.accept(round, integration, acceptance);
          } finally {
            this.busyTargets.delete(round.id);
          }
        },
        (error) => {
          const journal = this.store.get<ApplyJournal>(
            "flow_apply_journals",
            acceptance.id,
          );
          this.update("flow_acceptances", acceptance, {
            status: journal ? "recovery_required" : "conflict",
          });
          if (!journal) this.blocked(round.flowId, error);
        },
      );
      return {
        requestId: p.requestId,
        entityId: acceptance.id,
        revision: acceptance.revision,
        operationId: acceptance.id,
        pending: true,
      };
    }
    if (method === "projectFlow.acceptance.recover") {
      const acceptance = this.need<Acceptance>(
        "flow_acceptances",
        String(p.acceptanceId),
      );
      this.check(acceptance, p);
      if (
        acceptance.status !== "recovery_required" ||
        this.busyTargets.has(acceptance.roundId)
      )
        throw new FlowError(
          "RECOVERY_REQUIRED",
          "当前没有可核对的中断验收，或正在核对。",
        );
      if (!["reconcile", "continue"].includes(String(p.choice)))
        throw new FlowError(
          "INVALID_REQUEST",
          "请选择核对结果或继续剩余写入。",
        );
      this.busyTargets.add(acceptance.roundId);
      try {
        const round = this.need<Round>("flow_rounds", acceptance.roundId),
          integration = this.need<Integration>(
            "flow_integrations",
            acceptance.integrationId,
          ),
          journal = this.store.get<ApplyJournal>(
            "flow_apply_journals",
            acceptance.id,
          );
        if (!journal) {
          if (p.choice === "continue")
            await this.accept(round, integration, acceptance);
        } else {
          const recovered = await this.applications.recover(
            acceptance.id,
            p.choice as "reconcile" | "continue",
          );
          if (recovered.state === "applied")
            await this.finishAcceptance(round, integration, acceptance);
          else
            this.update("flow_acceptances", acceptance, {
              status: "recovery_required",
              conflictPaths: recovered.conflicts.map((c) => c.path),
            });
        }
      } finally {
        this.busyTargets.delete(acceptance.roundId);
      }
      return {
        requestId: p.requestId,
        entityId: acceptance.id,
        revision: this.need<Acceptance>("flow_acceptances", acceptance.id)
          .revision,
        pending: false,
      };
    }
    if (method === "projectFlow.round.requestChanges") {
      const round = this.need<Round>("flow_rounds", String(p.roundId));
      this.check(round, p);
      const flow = this.flow(round.flowId);
      if (
        flow.status !== "active" ||
        round.planId !== flow.activePlanId ||
        round.status !== "awaiting_acceptance" ||
        round.integrationId !== p.integrationId
      )
        throw new FlowError("STALE_VERSION", "该成品已不处于待验收状态。");
      if (
        this.busyTargets.has(round.id) ||
        (round.acceptanceId &&
          ["requested", "applying", "recovery_required"].includes(
            this.need<Acceptance>("flow_acceptances", round.acceptanceId)
              .status,
          ))
      )
        throw new FlowError(
          "RECOVERY_REQUIRED",
          "先核对验收写入，再请求修改。",
        );
      const integration = this.need<Integration>(
        "flow_integrations",
        round.integrationId!,
      );
      await this.integrationFix(
        round,
        integration,
        text(p.opinion ?? "", true) ||
          "用户选择驳回本轮，请复查未满足的要求；未补充意见。",
        undefined,
        undefined,
        undefined,
        {
          id: String(p.requestId),
          integrationId: integration.id,
          opinion: text(p.opinion ?? "", true),
          at: at(),
        },
      );
      return {
        requestId: p.requestId,
        entityId: round.id,
        revision: this.need<Round>("flow_rounds", round.id).revision,
        pending: false,
      };
    }
    if (method === "projectFlow.decision.answer") {
      const decision = this.need<Decision>(
        "flow_decisions",
        String(p.decisionId),
      );
      this.check(decision, p);
      if (decision.status !== "open")
        throw new FlowError("STALE_REVISION", "这张决策卡已处理或过期。");
      if (
        ["completed", "cancelled"].includes(this.flow(decision.flowId).status)
      )
        throw new FlowError("STALE_REVISION", "流程已结束，决策不再有效。");
      await this.answerDecision(decision, p);
      return {
        requestId: p.requestId,
        entityId: decision.id,
        revision: this.need<Decision>("flow_decisions", decision.id).revision,
        pending: false,
      };
    }
    if (method === "projectFlow.unknown.resolve") {
      const op = this.need<FlowOperation>(
        "flow_operations",
        String(p.operationId),
      );
      this.check(op, p);
      if (
        op.state !== "blocked" ||
        !["reconcile", "abandon", "continue"].includes(String(p.choice))
      )
        throw new FlowError("INVALID_REQUEST", "请选择待核对操作及处理方式。");
      const runId = op.correctionRunId ?? op.runId,
        run = runId ? this.store.get<Run>("runs", runId) : undefined;
      if (
        ["queued", "running", "waiting_user", "stopping"].includes(
          run?.status ?? "",
        ) ||
        (run?.status === "rate_limited" && !run.completedAt)
      )
        throw new FlowError(
          "UNKNOWN_RESULT",
          "旧运行尚未确认停止；请先处理成员问题，或停止并核对旧运行。",
        );
      const evidence = text(p.evidence ?? "", true);
      if (p.choice === "reconcile") {
        if (!finishedFlowReply(this.store, op))
          throw new FlowError(
            "UNKNOWN_RESULT",
            "只有实际已正常结束、投递明确、且保留完整回复的运行才能恢复；不能仅凭声明标为完成。",
          );
        this.update("flow_operations", op, { recovery: "completed" });
        const flow = this.flow(op.flowId);
        if (flow.dispatchMode === "running") this.restoreCompleted(flow);
        return {
          requestId: p.requestId,
          entityId: op.id,
          revision: this.need<FlowOperation>("flow_operations", op.id).revision,
          pending: true,
        };
      }
      if (p.choice === "continue" && op.kind === "supplement-delivery")
        throw new FlowError(
          "UNKNOWN_RESULT",
          "补充投递结果未知时先核对回执，不能当成成员任务续做或重复投递。",
        );
      this.store.transaction(() => {
        this.update("flow_operations", op, {
          state: "done",
          resumeRequested:
            p.choice === "continue" ||
            op.kind === "plan" ||
            op.kind === "rearrange",
          result: {
            [p.choice === "continue" ? "continued" : "abandoned"]: true,
            evidence,
          },
          error:
            "用户明确选择" +
            (p.choice === "continue" ? "接着做" : "放弃重做") +
            "：" +
            evidence,
        });
        const task = this.store.get<Task>("flow_tasks", op.targetId);
        if (task) {
          if (op.kind === "supplement-delivery" && op.supplementId) {
            this.patchSupplement(task.id, op.supplementId, {
              status: "pending",
              delivery: "next-turn",
              deliveredRunId: undefined,
            });
            const receipt = this.store.get<Record<string, unknown>>(
              "outbox",
              op.id,
            );
            if (receipt)
              this.store.put("outbox", op.id, {
                ...receipt,
                acknowledgedAt: at(),
                acknowledgement: { choice: "abandon", evidence },
              });
            const previous = run?.flowOperationId
              ? this.store.get<FlowOperation>(
                  "flow_operations",
                  run.flowOperationId,
                )
              : undefined;
            if (previous?.targetId === task.id && previous.kind === "task")
              this.update("flow_operations", previous, {
                state: "done",
                result: {
                  ...(previous.result as Record<string, unknown> | undefined),
                  abandoned: true,
                  abandonedWithSupplement: op.id,
                  evidence,
                },
              });
          }
          if (
            p.choice !== "continue" &&
            task.manualRedos?.at(-1)?.status === "pending" &&
            ["task", "supplement-delivery"].includes(op.kind)
          ) {
            const round = this.need<Round>("flow_rounds", task.roundId),
              flow = this.flow(task.flowId);
            this.update("flow_tasks", task, {
              status:
                task.kind === "integration-fix" ? "cancelled" : "escalated",
              blockedReason: "人工指定的单次尝试已明确放弃，需要重新选择。",
              activeRunId: undefined,
              manualRedos: this.completeRedo(task.manualRedos, "failed"),
            });
            if (task.kind === "integration-fix" && round.integrationId) {
              this.update("flow_rounds", round, {
                status: "blocked",
                manualRedos: this.completeRedo(round.manualRedos, "failed"),
              });
              this.roundRedoDecision(
                flow,
                round,
                this.need<Integration>(
                  "flow_integrations",
                  round.integrationId,
                ),
                "人工指定负责人的单次运行已放弃，需要重新选择。",
              );
            } else
              this.decision(
                flow,
                "replan",
                this.need<Task>("flow_tasks", task.id),
                "人工重做需要重新选择",
                "本次工作已明确放弃。历史计数保留，选择新成员后仅再做一次。",
              );
          } else
            this.update("flow_tasks", task, {
              status:
                ["review", "adjudication"].includes(op.kind) &&
                task.latestSubmissionId
                  ? "awaiting_review"
                  : op.kind === "rearrange"
                    ? "escalated"
                    : p.choice === "continue"
                      ? "correcting"
                      : "pending",
              blockedReason: undefined,
              activeRunId: undefined,
              ...(op.kind === "task"
                ? p.choice === "continue"
                  ? {
                      inputs: [
                        ...task.inputs,
                        "上次运行被中断。请检查当前文件状态，在原副本把任务做完，再按格式提交；历史退回计数保留。",
                      ],
                    }
                  : { sessionId: undefined, executionBase: undefined }
                : {}),
            });
        } else if (
          ["integration-check", "peer-review", "round-report"].includes(op.kind)
        ) {
          const integration = this.need<Integration>(
              "flow_integrations",
              op.targetId,
            ),
            round = this.need<Round>("flow_rounds", integration.roundId);
          if (
            round.integrationId === integration.id &&
            round.planId === this.flow(op.flowId).activePlanId
          ) {
            this.update("flow_rounds", round, { status: "checking" });
            this.update("flow_integrations", integration, {
              status: "checking",
              ...(op.kind === "integration-check"
                ? { checkRunId: undefined, outcome: undefined }
                : {}),
              ...(op.kind === "peer-review" ? { peerReview: undefined } : {}),
            });
          }
        } else if (op.kind === "requested-check") {
          const check = this.need<RequestedRoundCheck>(
              "flow_requested_checks",
              op.targetId,
            ),
            round = this.need<Round>("flow_rounds", check.roundId);
          this.update("flow_requested_checks", check, { status: "pending" });
          this.update("flow_rounds", round, { status: "checking" });
        } else if (op.kind === "next-round") {
          const round = this.need<Round>("flow_rounds", op.targetId);
          if (
            round.planId === this.flow(op.flowId).activePlanId &&
            round.nextConfirmation?.status === "suggesting"
          )
            this.update("flow_rounds", round, { status: "pending" });
        }
        const flow = this.flow(op.flowId),
          others = this.store
            .list<FlowOperation>("flow_operations")
            .filter((o) => o.flowId === op.flowId && o.state === "blocked");
        this.update("project_flows", flow, {
          blockedReasons: [
            ...new Set(
              others
                .filter((o) => o.recovery !== "completed")
                .map((o) => o.error)
                .filter((e): e is string => Boolean(e)),
            ),
          ],
        });
      });
      const latestFlow = this.flow(op.flowId);
      if (latestFlow.dispatchMode === "running")
        this.resumePlanning(latestFlow);
      return {
        requestId: p.requestId,
        entityId: op.id,
        revision: this.need<FlowOperation>("flow_operations", op.id).revision,
        pending: false,
      };
    }
    throw new FlowError("NOT_IMPLEMENTED", "这个操作将在下一里程碑接入。");
  }
  private async supplementTask(
    p: Record<string, unknown>,
  ): Promise<TaskSupplementResult> {
    let task = this.need<Task>("flow_tasks", String(p.taskId));
    this.check(task, p);
    const flow = this.flow(task.flowId),
      requestId = String(p.requestId);
    if (
      !["active", "completed"].includes(flow.status) ||
      flow.activePlanId !== task.planId
    )
      throw new FlowError("STALE_REVISION", "只能补充当前执行方案中的任务。");
    const request = supplementRequest(this.store, flow, task, p);
    if (finished.has(task.status))
      return {
        requestId,
        entityId: task.id,
        revision: task.revision,
        pending: false,
        disposition: "new-task-required",
        nextAction: "projectFlow.task.add",
        requiresNewFlow: flow.status === "completed",
        draft: {
          originTaskId: task.id,
          flowId: flow.id,
          roundId: task.roundId,
          memberId: task.memberId,
          goal: request.content,
          allowedPaths: [...task.allowedPaths],
          ...(request.sourceMessageId
            ? { sourceMessageId: request.sourceMessageId }
            : {}),
        },
      };
    if (flow.status !== "active")
      throw new FlowError("STALE_REVISION", "流程已结束，不能修改历史任务。");
    const operations = this.store
      .list<FlowOperation>("flow_operations")
      .filter((op) => op.targetId === task.id);
    if (
      task.supplements?.some((s) => s.status === "unknown") ||
      operations.some(
        (op) =>
          op.state === "blocked" &&
          (op.kind === "supplement-delivery" ||
            this.store.get<Run>("runs", op.correctionRunId ?? op.runId ?? "")
              ?.status === "unknown"),
      )
    )
      throw new FlowError(
        "UNKNOWN_RESULT",
        "先核对原任务或补充的未知投递，补充不会自动重发。",
      );
    if (!SUPPLEMENTABLE.has(task.status))
      throw new FlowError(
        "TASK_ACTIVE",
        "请先处理任务的阻塞或重新安排，再补充要求。",
      );
    if (task.supplements?.some((s) => s.status === "delivering"))
      throw new FlowError(
        "SUPPLEMENT_PENDING",
        "上一项补充还在确认投递，请稍后刷新。",
      );
    if (task.supplements?.some((s) => s.status === "awaiting_scope"))
      throw new FlowError("SCOPE_PENDING", "先处理已有补充的范围决策。");
    checkSupplementCapacity(task, request.content);
    const supplement: TaskSupplement = {
      id: randomUUID(),
      requestId,
      text: request.content,
      createdAt: at(),
      source: request.source,
      ...(request.sourceMessageId
        ? { sourceMessageId: request.sourceMessageId }
        : {}),
      requestedPaths: request.requestedPaths,
      status: request.outside.length ? "awaiting_scope" : "pending",
    };
    if (request.outside.length) {
      const decision: Decision = {
        ...this.record(flow.projectId, flow.id),
        kind: "scope-change",
        taskId: task.id,
        roundId: task.roundId,
        supplementId: supplement.id,
        title: "补充要求超出当前任务范围",
        reason: `补充：${supplement.text}\n需处理的范围：${request.outside.join("、")}。原任务和许可范围尚未修改。`,
        options: ["调整方案", "保持原范围"],
        eligibleTaskIds: [],
        sourceVersions: task.latestSubmissionId
          ? [
              this.need<Submission>("flow_submissions", task.latestSubmissionId)
                .version,
            ]
          : [],
        status: "open",
      };
      supplement.decisionId = decision.id;
      this.store.transaction(() => {
        task = this.update("flow_tasks", task, {
          supplements: [...(task.supplements ?? []), supplement],
        });
        this.store.putMany([
          { entity: "flow_decisions", id: decision.id, value: decision },
          projectFlowCardWrite(this.store, "decision", decision)!,
        ]);
      });
      return {
        requestId,
        entityId: task.id,
        revision: task.revision,
        pending: true,
        disposition: "scope-change",
        supplementId: supplement.id,
        decisionId: decision.id,
      };
    }
    supplement.requirementsRevision = requirementsRevision(task) + 1;
    if (task.status === "awaiting_review")
      supplement.withdrawnSubmissionId = task.latestSubmissionId;
    this.store.transaction(() => {
      if (supplement.withdrawnSubmissionId)
        this.update(
          "flow_submissions",
          this.need<Submission>(
            "flow_submissions",
            supplement.withdrawnSubmissionId,
          ),
          {
            status: "stale",
            staleReason:
              "用户补充了任务要求，本次提交已撤回，复核不能使用旧标准。",
          },
        );
      for (const review of this.store
        .list<Review>("flow_reviews")
        .filter(
          (review) =>
            review.taskId === task.id &&
            ["queued", "running"].includes(review.status),
        ))
        this.update("flow_reviews", review, {
          status: "stale",
          staleReason: "用户补充了要求，等待作者修正后重新提交。",
        });
      for (const op of operations.filter(
        (op) =>
          ["review", "adjudication"].includes(op.kind) &&
          ["prepared", "running"].includes(op.state),
      ))
        this.update("flow_operations", op, {
          state: "done",
          result: { supersededBySupplement: supplement.id },
        });
      for (const decision of this.store
        .list<Decision>("flow_decisions")
        .filter(
          (d) =>
            d.taskId === task.id &&
            d.status === "open" &&
            d.submissionId === supplement.withdrawnSubmissionId,
        ))
        this.update("flow_decisions", decision, { status: "expired" });
      task = this.update("flow_tasks", task, {
        goal: task.goal + "\n\n用户补充：" + supplement.text,
        completionCriteria: [
          ...new Set([
            ...task.completionCriteria,
            "补充要求：" + supplement.text,
          ]),
        ],
        requirementsRevision: supplement.requirementsRevision,
        supplements: [...(task.supplements ?? []), supplement],
        ...(supplement.withdrawnSubmissionId
          ? {
              status: "correcting",
              latestSubmissionId: undefined,
              activeRunId: undefined,
            }
          : {}),
      });
      if (supplement.sourceMessageId) {
        const round = this.need<Round>("flow_rounds", task.roundId);
        this.update("flow_rounds", round, {
          meetingHandledIds: [
            ...new Set([
              ...(round.meetingHandledIds ?? []),
              supplement.sourceMessageId,
            ]),
          ],
          meetingResponses: [
            ...(round.meetingResponses ?? []),
            {
              messageId: supplement.sourceMessageId,
              disposition: "in-scope-fix",
              summary:
                "用户已将这项要求补充到任务 " +
                task.title +
                "，按新的完成标准复核。",
              paths: supplement.requestedPaths,
              fixTaskId: task.id,
            },
          ],
        });
      }
    });
    const authorOperation = operations.find(
        (op) => op.kind === "task" && op.state === "running",
      ),
      runId =
        authorOperation &&
        (authorOperation.correctionRunId ?? authorOperation.runId);
    if (
      !authorOperation ||
      !runId ||
      authorOperation.correctionRunId ||
      this.flow(flow.id).dispatchMode !== "running"
    )
      return {
        requestId,
        entityId: task.id,
        revision: task.revision,
        pending: true,
        disposition: "recorded",
        supplementId: supplement.id,
      };
    const delivery = this.operation(
      flow,
      "supplement-delivery",
      task,
      task.sessionId,
    );
    this.update("flow_operations", delivery, {
      state: "running",
      runId,
      supplementId: supplement.id,
    });
    this.patchSupplement(task.id, supplement.id, {
      status: "delivering",
      deliveryOperationId: delivery.id,
    });
    const prompt = `用户明确补充当前任务，这不是复核退回，不改变许可文件范围。\n补充要求：${supplement.text}\n任务目标：${task.goal}\n最新完成标准：${JSON.stringify(task.completionCriteria)}\n结束时仍只返回 airoom.project-flow submission JSON，completionResults 必须逐项包含最新完成标准。`;
    let outcome: "current" | "next-turn" | "unknown";
    try {
      outcome =
        (await this.host.steer?.(runId, prompt, delivery.id)) ?? "next-turn";
    } catch {
      outcome = "unknown";
    }
    this.store.transaction(() => {
      if (outcome === "unknown") {
        const reason = "补充要求的投递结果待核对，未自动重发。";
        this.patchSupplement(task.id, supplement.id, {
          status: "unknown",
          deliveredRunId: runId,
        });
        this.update("flow_operations", delivery, {
          state: "blocked",
          error: reason,
        });
        const previous = this.need<FlowOperation>(
          "flow_operations",
          authorOperation.id,
        );
        if (["prepared", "running"].includes(previous.state))
          this.update("flow_operations", previous, {
            state: "done",
            result: {
              supersededBySupplement: supplement.id,
              deliveryUnknown: true,
            },
          });
        task = this.update(
          "flow_tasks",
          this.need<Task>("flow_tasks", task.id),
          {
            status: "blocked",
            statusBeforeBlock: "correcting",
            blockedReason: reason,
            activeRunId: undefined,
          },
        );
        const latestFlow = this.flow(flow.id);
        this.update("project_flows", latestFlow, {
          dispatchMode: "paused",
          blockedReasons: [...new Set([...latestFlow.blockedReasons, reason])],
        });
      } else {
        this.patchSupplement(task.id, supplement.id, {
          status: outcome === "current" ? "delivered" : "pending",
          delivery: outcome,
          deliveredRunId: outcome === "current" ? runId : undefined,
        });
        this.update("flow_operations", delivery, {
          state: "done",
          result: { delivery: outcome },
        });
        if (outcome === "current") {
          const latest = this.need<FlowOperation>(
            "flow_operations",
            authorOperation.id,
          );
          if (latest.state === "running")
            this.update("flow_operations", latest, {
              requirementsRevision: supplement.requirementsRevision,
            });
        }
      }
    });
    task = this.need<Task>("flow_tasks", task.id);
    return {
      requestId,
      entityId: task.id,
      revision: task.revision,
      pending: outcome !== "current",
      disposition: outcome,
      supplementId: supplement.id,
      operationId: delivery.id,
    };
  }
  private patchSupplement(
    taskId: string,
    supplementId: string,
    patch: Partial<TaskSupplement>,
  ) {
    const task = this.need<Task>("flow_tasks", taskId);
    return this.update("flow_tasks", task, {
      supplements: (task.supplements ?? []).map((s) =>
        s.id === supplementId ? { ...s, ...patch } : s,
      ),
    });
  }
  private supersededOperation(op: FlowOperation) {
    return Boolean(
      (
        this.need<FlowOperation>("flow_operations", op.id).result as
          | { supersededBySupplement?: string }
          | undefined
      )?.supersededBySupplement,
    );
  }
  private async settleSupplements(taskId: string) {
    while (
      this.need<Task>("flow_tasks", taskId).supplements?.some(
        (s) => s.status === "delivering",
      )
    ) {
      if (!this.host.alive())
        throw new FlowError("PAUSED", "正在结束工作，补充投递未自动重发。");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  private async checkRequirements(op: FlowOperation) {
    const flow = this.flow(op.flowId);
    assertProjectBoundary(this.store, flow.projectId, flow.writeBoundary);
    if (!["task", "review", "adjudication"].includes(op.kind)) return;
    if (op.kind === "task") await this.settleSupplements(op.targetId);
    if (this.supersededOperation(op))
      throw new FlowError(
        "STALE_REQUIREMENTS",
        "用户补充了要求，旧尝试不再用于提交或复核。",
      );
    const task = this.need<Task>("flow_tasks", op.targetId),
      latest = this.need<FlowOperation>("flow_operations", op.id);
    if (requirementsRevision(task) !== (latest.requirementsRevision ?? 1))
      throw new FlowError(
        "REQUIREMENTS_CHANGED",
        "任务要求已经更新，请在同一作者会话按最新要求继续。",
      );
  }
  private pendingScope(roundId: string) {
    return this.store
      .list<Decision>("flow_decisions")
      .some(
        (decision) =>
          decision.roundId === roundId &&
          decision.status === "open" &&
          Boolean(decision.supplementId),
      );
  }
  kick() {
    if (this.closed || !this.host.alive()) return;
    this.joint?.kick();
    this.repump = true;
    if (this.pumping) return;
    this.pumping = true;
    let promise: Promise<void>;
    promise = Promise.resolve()
      .then(async () => {
        do {
          this.repump = false;
          await this.pump();
        } while (this.repump && !this.closed);
      })
      .catch(() => {})
      .finally(() => {
        this.pumping = false;
        this.jobs.delete(promise);
        if (this.repump) this.kick();
      });
    this.jobs.add(promise);
  }
  private async pump() {
    for (const flow of this.store
      .list<ProjectFlow>("project_flows")
      .filter((f) => f.status === "active" && f.dispatchMode === "running")) {
      this.reconcileQuotaWaits(flow);
      for (const round of this.store
        .list<Round>("flow_rounds")
        .filter(
          (r) =>
            r.flowId === flow.id &&
            r.planId === flow.activePlanId &&
            r.status === "pending" &&
            r.nextConfirmation?.status === "suggesting",
        )) {
        if (
          !this.busyTargets.has(round.id) &&
          (round.nextConfirmation?.recommendation ||
            this.quotaAllows(flow, round, this.lead(round), "next-round"))
        ) {
          this.busyTargets.add(round.id);
          this.launch(
            async () => {
              try {
                await this.suggestNextRound(round);
              } finally {
                this.busyTargets.delete(round.id);
              }
            },
            (error) => this.blocked(flow.id, error),
          );
        }
      }
      const tasks = this.tasks(flow.id).filter(
          (t) => t.planId === flow.activePlanId,
        ),
        active = tasks.filter((t) =>
          ["queued", "running", "awaiting_review"].includes(t.status),
        );
      for (const task of tasks.filter(
        (t) => t.status === "awaiting_review" && !this.busyTargets.has(t.id),
      )) {
        const submission = this.need<Submission>(
          "flow_submissions",
          task.latestSubmissionId!,
        );
        if (submission.disputes?.length && !submission.disputeRulings) {
          const lead = this.lead(task);
          if (
            lead !== task.memberId &&
            lead !== task.reviewerMemberId &&
            !this.quotaAllows(flow, task, lead, "adjudication")
          )
            continue;
          this.busyTargets.add(task.id);
          this.launch(
            async () => {
              try {
                await this.adjudicateTask(task, submission);
              } finally {
                this.busyTargets.delete(task.id);
              }
            },
            (error) => this.blocked(flow.id, error, task.id),
          );
          continue;
        }
        if (this.skipTaskReview(task)) continue;
        const assigned = this.availableReviewer(task);
        if (
          !this.quotaAllows(flow, assigned, assigned.reviewerMemberId, "review")
        )
          continue;
        this.busyTargets.add(task.id);
        this.launch(
          async () => {
            try {
              await this.reviewTask(
                assigned,
                this.need<Submission>(
                  "flow_submissions",
                  assigned.latestSubmissionId!,
                ),
              );
            } finally {
              this.busyTargets.delete(task.id);
            }
          },
          (error) => this.blocked(flow.id, error, task.id),
        );
      }
      for (const task of tasks.filter(
        (t) =>
          ["pending", "ready", "correcting"].includes(t.status) &&
          !this.busyTargets.has(t.id) &&
          !t.supplements?.some((s) => s.status === "delivering"),
      )) {
        const round = this.need<Round>("flow_rounds", task.roundId);
        if (
          round.nextConfirmation &&
          round.nextConfirmation.status !== "confirmed"
        )
          continue;
        if (
          (!round.baseVersion ||
            !["executing", "changes_requested"].includes(round.status)) &&
          !(task.earlyDecisionId && task.startBase)
        )
          continue;
        const dependencies = task.dependencies.map((id) =>
          this.need<Task>("flow_tasks", id),
        );
        if (dependencies.some((t) => !finished.has(t.status))) continue;
        if (
          active.some((t) =>
            scopesOverlap(task.allowedPaths, t.allowedPaths),
          ) ||
          active.length >= this.host.maxParallel()
        )
          continue;
        if (!this.quotaAllows(flow, task, task.memberId, "task")) continue;
        if (!round.startedAt)
          this.update("flow_rounds", round, { startedAt: at() });
        const queued = this.update("flow_tasks", task, { status: "queued" });
        active.push(queued);
        this.busyTargets.add(task.id);
        this.launch(
          async () => {
            try {
              await this.executeTask(queued);
            } finally {
              this.busyTargets.delete(task.id);
            }
          },
          (error) => this.blocked(flow.id, error, task.id),
        );
      }
      for (const round of this.store
        .list<Round>("flow_rounds")
        .filter(
          (r) =>
            r.flowId === flow.id &&
            r.planId === flow.activePlanId &&
            [
              "executing",
              "changes_requested",
              "checking",
              "awaiting_acceptance",
            ].includes(r.status),
        )) {
        if (this.pendingScope(round.id)) continue;
        const pendingAcceptance = this.store
          .list<Acceptance>("flow_acceptances")
          .find(
            (a) =>
              a.roundId === round.id &&
              a.integrationId === round.integrationId &&
              a.actor === "lead" &&
              !a.requiresApply &&
              a.status === "requested",
          );
        if (pendingAcceptance) {
          if (!this.busyTargets.has(round.id)) {
            this.busyTargets.add(round.id);
            this.launch(
              async () => {
                try {
                  await this.finishAcceptance(
                    round,
                    this.need<Integration>(
                      "flow_integrations",
                      pendingAcceptance.integrationId,
                    ),
                    pendingAcceptance,
                  );
                } finally {
                  this.busyTargets.delete(round.id);
                }
              },
              (error) => this.blocked(flow.id, error),
            );
          }
          continue;
        }
        const roundTasks = this.tasks(flow.id).filter(
          (t) => t.roundId === round.id && t.status !== "cancelled",
        );
        if (round.status === "checking") {
          const integration = round.integrationId
              ? this.need<Integration>("flow_integrations", round.integrationId)
              : undefined,
            check =
              integration &&
              this.store
                .list<FlowOperation>("flow_operations")
                .find(
                  (o) =>
                    o.targetId === integration.id &&
                    o.kind === "integration-check" &&
                    o.state === "done",
                );
          const lead = this.lead(round),
            requested = round.requestedCheckId
              ? this.store.get<RequestedRoundCheck>(
                  "flow_requested_checks",
                  round.requestedCheckId,
                )
              : undefined,
            needsRequested = requested?.status === "pending",
            needsCheck =
              integration &&
              (!integration.checkRunId ||
                (integration.outcome && integration.outcome !== "pass")) &&
              !round.manualAcceptance &&
              !(integration.reviewLevel === "low" && !integration.reviewChoice),
            needsPeer =
              integration &&
              !needsCheck &&
              round.requiresPeerReview &&
              !integration.peerReview &&
              !round.manualAcceptance &&
              integration.reviewLevel !== "low",
            stage = needsRequested
              ? "requested-check"
              : needsCheck
                ? "integration-check"
                : needsPeer
                  ? "peer-review"
                  : "round-report",
            member = needsRequested
              ? requested.memberId
              : needsPeer
                ? !this.busyTargets.has(round.id)
                  ? this.availablePeer(round)
                  : (round.peerReviewerMemberId ??
                    flow.memberIds.find((id) => id !== lead))
                : lead;
          const cachedReport =
            stage === "round-report" &&
            !round.manualAcceptance &&
            integration?.reportDraft &&
            integration.checkRunId &&
            JSON.stringify(integration.draftMeetingIds) ===
              JSON.stringify(
                roundMeetingMaterial(this.store, round).pendingUserMessages.map(
                  (m) => m.id,
                ),
              );
          if (
            integration &&
            member &&
            !this.openRoundDecision(round.id) &&
            !this.busyTargets.has(round.id) &&
            (cachedReport || this.quotaAllows(flow, round, member, stage))
          ) {
            this.busyTargets.add(round.id);
            this.launch(
              async () => {
                try {
                  if (needsRequested)
                    await this.runRequestedCheck(round, requested);
                  else if (round.manualAcceptance)
                    await this.manualRoundReport(
                      round,
                      integration,
                      roundTasks,
                    );
                  else if (
                    integration.reviewLevel === "low" &&
                    !integration.reviewChoice
                  )
                    await this.reportUncheckedRound(
                      round,
                      integration,
                      roundTasks,
                    );
                  else if (
                    !integration.checkRunId ||
                    (integration.outcome && integration.outcome !== "pass")
                  )
                    await this.checkIntegratedRound(
                      round,
                      integration,
                      roundTasks,
                    );
                  else if (
                    round.requiresPeerReview &&
                    !integration.peerReview &&
                    !round.manualAcceptance
                  )
                    await this.peerReviewRound(round, integration, roundTasks);
                  else if (
                    check?.sessionId &&
                    this.need<Session>("sessions", check.sessionId).memberId ===
                      lead
                  )
                    await this.reportIntegratedRound(
                      round,
                      integration,
                      roundTasks,
                      check.sessionId,
                    );
                  else
                    await this.manualRoundReport(
                      round,
                      integration,
                      roundTasks,
                    );
                } finally {
                  this.busyTargets.delete(round.id);
                }
              },
              (error) => {
                this.update("flow_rounds", round, {
                  status: this.deferred(error) ? "checking" : "blocked",
                });
                this.blocked(flow.id, error);
              },
            );
          }
          continue;
        }
        if (
          round.status !== "awaiting_acceptance" &&
          roundTasks.length &&
          roundTasks.every((t) => finished.has(t.status)) &&
          !this.busyTargets.has(round.id)
        ) {
          this.busyTargets.add(round.id);
          this.update("flow_rounds", round, { status: "integrating" });
          this.launch(
            async () => {
              try {
                await this.integrate(this.need<Round>("flow_rounds", round.id));
              } finally {
                this.busyTargets.delete(round.id);
              }
            },
            (error) => {
              this.update("flow_rounds", round, {
                status: this.deferred(error) ? "executing" : "blocked",
              });
              this.blocked(flow.id, error);
            },
          );
        } else await this.earlyCandidates(round);
      }
    }
  }
  private executeTask(initial: Task) {
    return executeFlowTask({
      store: this.store,
      artifacts: this.artifacts,
      flow: (id) => this.flow(id),
      need: <T>(entity: string, id: string) => this.need<T>(entity, id),
      update: <T extends FlowRecord>(entity: string, item: T, patch: Partial<T>) =>
        this.update(entity, item, patch),
      session: (projectId, memberId, title, write) =>
        this.host.session(projectId, memberId, title, write),
      operation: (flow, kind, target, sessionId) =>
        this.operation(flow, kind, target, sessionId),
      protocol: <T>(
        op: FlowOperation,
        kind: string,
        prompt: string,
        validate: (raw: unknown, runId: string) => T,
      ) => this.protocol(op, kind, prompt, validate),
      disputeFindings: (task) => this.disputeFindings(task),
      validOperation: (op, runId) => this.validOperation(op, runId),
      settleSupplements: (taskId) => this.settleSupplements(taskId),
      record: (projectId, flowId) => this.record(projectId, flowId),
      bindEvidence: (evidence, runId) => this.bindEvidence(evidence, runId),
      taskLevel: (task) => this.taskLevel(task),
      decision: (flow, kind, task, title, reason) =>
        this.decision(flow, kind, task, title, reason),
      supersededOperation: (op) => this.supersededOperation(op),
      failOperation: (op, error) => this.failOperation(op, error),
      adjudicateTask: (task, submission) => this.adjudicateTask(task, submission),
      skipTaskReview: (task) => this.skipTaskReview(task),
      reviewTask: (task, submission) => this.reviewTask(task, submission),
    }, initial);
  }
  private skipTaskReview(task: Task) {
    const level = this.taskLevel(task);
    if (
      task.reviewRequested ||
      (task.kind !== "integration-fix" && level === "high")
    )
      return false;
    this.update("flow_tasks", task, {
      status: "review_skipped",
      reviewLevelAtSubmission: level,
      reviewSkipped:
        task.kind === "integration-fix" ? "round-fix" : "configured",
      supplements: (task.supplements ?? []).map((s) =>
        s.status === "submitted" ? { ...s, status: "applied" } : s,
      ),
    });
    return true;
  }
  private openRoundDecision(roundId: string) {
    return this.store
      .list<Decision>("flow_decisions")
      .some(
        (d) =>
          d.roundId === roundId &&
          d.status === "open" &&
          [
            "unresolved-review",
            "replan",
            "review-choice",
            "review-dispute",
          ].includes(d.kind),
      );
  }
  private completeRedo(
    redos: ManualRedo[] | undefined,
    status: ManualRedo["status"],
  ) {
    return redos?.map((redo, index) =>
      index === redos.length - 1 && redo.status === "pending"
        ? { ...redo, status }
        : redo,
    );
  }
  private previousTaskFindings(task: Task) {
    return (
      this.store
        .list<Review>("flow_reviews")
        .filter((r) => r.taskId === task.id && r.status === "changes_requested")
        .at(-1)
        ?.findings.filter(
          (f) =>
            (f.kind === "verified" || f.disposition === "requires-fix") &&
            f.severity !== "optional" &&
            f.disposition !== "advice",
        ) ?? []
    );
  }
  private userReviewRequest(
    target: Task | Integration,
    stage: Decision["stage"],
    version: Submission["version"] | undefined,
  ) {
    if (!version) return;
    const decision = this.store
      .list<Decision>("flow_decisions")
      .filter(
        (d) =>
          d.flowId === target.flowId &&
          d.kind === "unresolved-review" &&
          d.stage === stage &&
          d.status === "answered" &&
          (stage === "task-review"
            ? d.taskId === target.id
            : d.integrationId === target.id) &&
          d.sourceVersions.some(
            (v) =>
              v.artifactId === version.artifactId &&
              v.fingerprint === version.fingerprint,
          ) &&
          d.answer,
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    return decision
      ? {
          decisionId: decision.id,
          choice: decision.answer!.choice,
          opinion:
            decision.answer!.opinion ||
            "用户选择：" + decision.answer!.choice + "；未补充意见。",
          scope:
            "只补充本版本的复核关注点，不改变完成标准或文件权限；无法核实仍如实记录。",
        }
      : undefined;
  }
  private disputeFindings(task: Task) {
    return [
      ...new Map(
        this.store
          .list<Review>("flow_reviews")
          .filter((r) => r.taskId === task.id && r.status !== "stale")
          .flatMap((r) => r.findings)
          .map((f) => [f.id, f]),
      ).values(),
    ];
  }
  private validateDisputeRulings(raw: unknown, submission: Submission) {
    const payload = payloadObject(raw, "adjudication");
    if (
      !Array.isArray(payload.rulings) ||
      payload.rulings.length !== submission.disputes!.length
    )
      throw new FlowError("INVALID_PROTOCOL", "必须逐条裁定所有有异议的问题。");
    const rulings: DisputeRuling[] = payload.rulings.map((value) => {
      const r = object(value, ["findingId", "verdict", "reason"]);
      if (
        !["uphold-author", "uphold-review", "inconclusive"].includes(
          String(r.verdict),
        ) ||
        !submission.disputes!.some((d) => d.findingId === r.findingId)
      )
        throw new FlowError(
          "INVALID_PROTOCOL",
          "异议裁定必须引用实际 findingId，结论只能是 uphold-author、uphold-review、inconclusive。",
        );
      return {
        findingId: text(r.findingId),
        verdict: r.verdict as DisputeRuling["verdict"],
        reason: text(r.reason),
      };
    });
    if (new Set(rulings.map((r) => r.findingId)).size !== rulings.length)
      throw new FlowError("INVALID_PROTOCOL", "不能重复裁定同一个问题。");
    return rulings;
  }
  private accountDisputeReturn(task: Task, submission: Submission) {
    const saved = this.need<Submission>(
      "flow_submissions",
      submission.id,
    ).disputeReturnAccounting;
    if (saved) return saved;
    return this.store.transaction(() => {
      const current = this.need<Task>("flow_tasks", task.id),
        reviews = this.store
          .list<Review>("flow_reviews")
          .filter((r) => r.taskId === task.id),
        last = reviews.filter((r) => r.status === "changes_requested").at(-1);
      // Legacy records carry their refund history on reviews. Never erase that history on restart or reuse.
      let used = Math.max(
          current.disputeReturnWaiverCount ?? 0,
          reviews.filter((r) => r.returnWaivedBySubmissionId).length,
        ),
        refunded = last?.returnWaivedBySubmissionId === submission.id;
      const eligible =
        last?.returnCounted &&
        !last.returnWaivedBySubmissionId &&
        current.returnCount > 0 &&
        submission.disputes!.some((d) =>
          last.findings.some((f) => f.id === d.findingId),
        );
      if (eligible && used < FLOW_LIMITS.disputeReturnWaivers) {
        this.update("flow_reviews", last!, {
          returnWaivedBySubmissionId: submission.id,
        });
        this.update("flow_tasks", current, {
          returnCount: current.returnCount - 1,
        });
        used++;
        refunded = true;
      }
      const accounting = {
        refunded,
        used,
        limit: FLOW_LIMITS.disputeReturnWaivers,
      };
      this.update("flow_tasks", current, { disputeReturnWaiverCount: used });
      this.update("flow_submissions", submission, {
        disputeReturnAccounting: accounting,
      });
      return accounting;
    });
  }
  private disputeDecision(task: Task, submission: Submission, reason: string) {
    const flow = this.flow(task.flowId);
    if (
      this.store
        .list<Decision>("flow_decisions")
        .some(
          (d) =>
            d.kind === "review-dispute" &&
            d.submissionId === submission.id &&
            d.status === "open",
        )
    )
      return;
    const accounting = this.need<Submission>(
      "flow_submissions",
      submission.id,
    ).disputeReturnAccounting;
    if (accounting)
      reason +=
        " " +
        (accounting.refunded
          ? "本次异议返还 1 次退回次数。"
          : accounting.used >= accounting.limit
            ? "异议返还已达上限，本次退回正常计数，异议仍可裁定。"
            : "本次异议没有可返还的新增退回，退回次数不变。") +
        " 本任务异议返还已用 " +
        accounting.used +
        "/" +
        accounting.limit +
        " 次。";
    const findings = this.disputeFindings(task),
      decision = this.saveDecision({
        ...this.record(flow.projectId, flow.id),
        kind: "review-dispute",
        taskId: task.id,
        roundId: task.roundId,
        submissionId: submission.id,
        title: "作者的复核异议需要你裁定",
        reason,
        disputeReturnAccounting: accounting,
        options: ["支持全部异议", "维持全部复核意见", "提交逐条裁定"],
        eligibleTaskIds: [],
        sourceVersions: [submission.version],
        disputeItems: submission.disputes!.map((d) => ({
          finding: findings.find((f) => f.id === d.findingId)!,
          reason: d.reason,
        })),
        status: "open",
      });
    this.update("flow_submissions", submission, {
      disputeDecisionId: decision.id,
    });
    this.update("flow_tasks", task, {
      status: "blocked",
      statusBeforeBlock: "awaiting_review",
      blockedReason: reason,
    });
    this.update("project_flows", this.flow(flow.id), {
      blockedReasons: [
        ...new Set([...this.flow(flow.id).blockedReasons, reason]),
      ],
    });
  }
  private async adjudicateTask(task: Task, submission: Submission) {
    if (submission.disputeRulings) return;
    if (!this.reviewCurrent(task.id, submission)) return;
    const flow = this.flow(task.flowId),
      lead = this.lead(task);
    this.accountDisputeReturn(task, submission);
    if (task.memberId === lead || task.reviewerMemberId === lead) {
      this.disputeDecision(
        this.need<Task>("flow_tasks", task.id),
        submission,
        "作者或原复核者是本轮负责人，请你裁定这些有异议的问题。",
      );
      return;
    }
    if (
      flow.dispatchMode !== "running" ||
      (!this.recoveryOperation("adjudication", task.id) &&
        !this.quotaAllows(flow, task, lead, "adjudication"))
    )
      return;
    const artifact = this.artifacts.get(submission.version.artifactId);
    const { disposable, session } = await this.openReviewCopy(
      flow,
      artifact.root,
      artifact.fingerprint,
      lead,
      "裁定复核异议 " + task.title,
    );
    const op = this.operation(
      flow,
      "adjudication",
      this.need<Task>("flow_tasks", task.id),
      session.id,
    );
    try {
      const result = await this.protocol(
        op,
        "adjudication",
        flowPrompt(
          "adjudication",
          {
            rulings: submission.disputes!.map((d) => ({
              findingId: d.findingId,
              verdict: "inconclusive",
              reason: "依据实际核查裁定",
            })),
          },
          {
            task,
            submission,
            disputes: submission.disputes,
            findings: this.disputeFindings(task),
            instruction:
              "在一次性副本核实作者的异议。uphold-author 支持作者，uphold-review 维持复核，inconclusive 交给用户决定。只裁定问题，不修改作者版本。",
          },
        ),
        (raw) => this.validateDisputeRulings(raw, submission),
      );
      if (
        !this.validOperation(op, result.runId) ||
        !this.reviewCurrent(task.id, submission)
      )
        return;
      if (
        (await workspaceFingerprint(artifact.root)) !==
        submission.version.fingerprint
      )
        throw new FlowError("STALE_VERSION", "裁定期间提交版本已改变。");
      this.update("flow_operations", op, { state: "done" });
      this.update("flow_submissions", submission, {
        disputeRunId: result.runId,
      });
      if (result.payload.some((r) => r.verdict === "inconclusive"))
        this.disputeDecision(
          task,
          submission,
          "负责人无法确定异议，请你裁定。",
        );
      else this.resolveDisputes(task, submission, result.payload);
    } catch (error) {
      if (this.supersededOperation(op)) return;
      this.failOperation(op, error);
      throw error;
    } finally {
      await this.releaseReviewCopy(op.id, disposable.id);
    }
  }
  private resolveDisputes(
    task: Task,
    submission: Submission,
    rulings: DisputeRuling[],
  ) {
    this.update("flow_submissions", submission, { disputeRulings: rulings });
    const upheld = rulings.filter((r) => r.verdict === "uphold-review");
    this.update("flow_tasks", task, {
      status: upheld.length ? "correcting" : "awaiting_review",
      reviewRequested: upheld.length ? undefined : true,
      blockedReason: undefined,
      statusBeforeBlock: undefined,
      inputs: [...task.inputs, "异议裁定：" + JSON.stringify(rulings)],
    });
  }
  private previousRoundFindings(
    round: Round,
    integration: Integration,
    peer = false,
  ) {
    const previous = this.store
      .list<Integration>("flow_integrations")
      .filter(
        (i) =>
          i.roundId === round.id &&
          i.id !== integration.id &&
          i.sequence < integration.sequence &&
          (peer ? i.peerReview?.outcome : i.outcome) === "changes_requested",
      )
      .at(-1);
    return (
      (peer ? previous?.peerReview?.findings : previous?.findings)?.filter(
        (f) =>
          (f.kind === "verified" || f.disposition === "requires-fix") &&
          f.severity !== "optional" &&
          f.disposition !== "advice",
      ) ?? []
    );
  }
  private taskAdvice(tasks: Task[]) {
    return tasks.flatMap(
      (task) =>
        this.store
          .list<Review>("flow_reviews")
          .filter(
            (r) =>
              r.taskId === task.id &&
              r.submissionId === task.latestSubmissionId &&
              r.status === "passed",
          )
          .at(-1)
          ?.findings.filter(
            (f) => f.disposition === "advice" || f.severity === "optional",
          ) ?? [],
    );
  }
  private roundRedoDecision(
    flow: ProjectFlow,
    round: Round,
    integration: Integration,
    reason: string,
  ) {
    return this.saveDecision({
      ...this.record(flow.projectId, flow.id),
      kind: "replan",
      stage: "integration-fix",
      roundId: round.id,
      integrationId: integration.id,
      currentMemberId: this.lead(round),
      eligibleMemberIds: flow.memberIds.filter((id) => id !== this.lead(round)),
      title: "本轮整合需要你决定",
      reason,
      options: ["重新安排", "暂停"],
      eligibleTaskIds: [],
      sourceVersions: integration.version ? [integration.version] : [],
      status: "open",
    });
  }
  private bindEvidence(
    evidence: Evidence[],
    runId: string,
    originalRunId?: string,
  ) {
    return this.validation.bindEvidence(evidence, runId, originalRunId);
  }
  private retryable(flow: ProjectFlow) {
    const held = new Set(
        this.store
          .list<FlowOperation>("flow_operations")
          .filter(
            (o) =>
              o.flowId === flow.id &&
              ["blocked", "running", "prepared"].includes(o.state),
          )
          .map((o) => o.targetId),
      ),
      deciding = new Set(
        this.store
          .list<Decision>("flow_decisions")
          .filter(
            (d) => d.flowId === flow.id && d.status === "open" && d.taskId,
          )
          .map((d) => d.taskId!),
      );
    return this.store
      .list<Task>("flow_tasks")
      .filter(
        (t) =>
          t.flowId === flow.id &&
          t.planId === flow.activePlanId &&
          t.status === "blocked" &&
          !this.runActive(t.activeRunId) &&
          !held.has(t.id) &&
          !deciding.has(t.id),
      );
  }
  private runActive(runId?: string) {
    const run = runId ? this.store.get<Run>("runs", runId) : undefined;
    return Boolean(
      run &&
        !run.completedAt &&
        [
          "queued",
          "running",
          "waiting_user",
          "stopping",
          "rate_limited",
        ].includes(run.status),
    );
  }
  private checkedReview(
    op: FlowOperation,
    criteria: string[],
    previous: ReviewFinding[] = [],
  ) {
    return (raw: unknown, runId: string) => {
      const payload = validateReview(raw, criteria, previous);
      this.reviewEvidence(payload, op, runId);
      return payload;
    };
  }
  private integratedReply(
    op: FlowOperation,
    criteria: string[],
    previous: ReviewFinding[],
    round: Round,
    tasks: Task[],
    meeting: ReturnType<typeof roundMeetingMaterial>,
  ) {
    return (raw: unknown, runId: string) => {
      const fields = [
          "verdict",
          "verificationComplete",
          "criteriaResults",
          "findings",
          "evidence",
        ],
        p = object(
          raw,
          [
            ...fields,
            "previousFindingChecks",
            "assessments",
            "strengths",
            "report",
            "nextRoundRecommendation",
          ],
          [],
        ),
        { report, nextRoundRecommendation, ...review } = p,
        payload = this.checkedReview(op, criteria, previous)(review, runId),
        next = this.store
          .list<Round>("flow_rounds")
          .find(
            (r) => r.planId === round.planId && r.index === round.index + 1,
          );
      return {
        ...payload,
        ...(report === undefined
          ? {}
          : { report: this.validateMeetingReport(report, meeting, tasks) }),
        ...(nextRoundRecommendation === undefined
          ? {}
          : {
              nextRoundRecommendation: next
                ? validateNextRound(
                    nextRoundRecommendation,
                    this.tasks(round.flowId).filter(
                      (t) => t.roundId === next.id,
                    ),
                    this.store.profile().name,
                  )
                : undefined,
            }),
      };
    };
  }
  private reviewEvidence(
    payload: ReturnType<typeof validateReview>,
    op: FlowOperation,
    runId: string,
  ) {
    return this.validation.reviewEvidence(payload, op, runId);
  }
  private reviewCurrent(taskId: string, submission: Submission) {
    const task = this.need<Task>("flow_tasks", taskId),
      flow = this.flow(task.flowId);
    return (
      flow.status !== "cancelled" &&
      task.planId === flow.activePlanId &&
      task.status === "awaiting_review" &&
      task.latestSubmissionId === submission.id &&
      this.need<Submission>("flow_submissions", submission.id).status ===
        "submitted" &&
      requirementsRevision(task) === (submission.requirementsRevision ?? 1)
    );
  }
  private async reviewTask(task: Task, submission: Submission) {
    const flow = this.flow(task.flowId);
    if (!this.reviewCurrent(task.id, submission)) return;
    if (!this.recoveryOperation("review", task.id))
      task = this.availableReviewer(this.need<Task>("flow_tasks", task.id));
    if (
      flow.dispatchMode !== "running" ||
      (!this.recoveryOperation("review", task.id) &&
        !this.quotaAllows(flow, task, task.reviewerMemberId, "review"))
    )
      return;
    const author = this.need<Session>("sessions", submission.sessionId);
    if (
      (await workspaceFingerprint(author.workspace!)) !==
      submission.version.fingerprint
    )
      throw new FlowError("STALE_VERSION", "作者成果在提交后改变。");
    const opened = await this.openReviewCopy(
      flow,
      this.artifacts.get(submission.version.artifactId).root,
      submission.version.fingerprint,
      task.reviewerMemberId,
      "复核 " + task.title,
      () => this.reviewCurrent(task.id, submission),
    );
    if (!opened) return;
    const { disposable, session } = opened;
    const previous = this.previousTaskFindings(task),
      criteria = memberCriteria(
        task.completionCriteria,
        this.store.profile().name,
      ),
      review: Review = {
        ...this.record(flow.projectId, flow.id),
        taskId: task.id,
        submissionId: submission.id,
        reviewerMemberId: task.reviewerMemberId,
        disposableArtifactId: disposable.id,
        reviewedVersion: submission.version,
        findings: [],
        evidence: [],
        verificationComplete: false,
        status: "running",
        requirementsRevision: requirementsRevision(task),
        deferredUserCriteria: criteria.deferred,
      };
    this.store.put("flow_reviews", review.id, review);
    const op = this.operation(flow, "review", task, session.id);
    try {
      // The reviewer compares the version the author started from with the submitted one: the copy's own baseline is taken
      // after the work, so it cannot show what changed (2026-10-06: a real review could not verify "earlier text kept").
      const diff = task.executionBase
        ? await this.artifacts.diff(
            this.artifacts.get(task.executionBase.artifactId),
            this.artifacts.get(submission.version.artifactId),
          )
        : await diffWorkspace(author.workspace!);
      const result = await this.protocol(
        op,
        "review",
        flowPrompt(
          "review",
          reviewTemplate(criteria.required, "实际检查", "结果", previous),
          {
            task: { ...task, completionCriteria: criteria.required },
            userReviewRequest: this.userReviewRequest(
              task,
              "task-review",
              submission.version,
            ),
            executionActivity: roundActivityMaterial(
              this.store,
              this.need<Round>("flow_rounds", task.roundId),
            ),
            deferredUserCriteria: criteria.deferred,
            judgedCriteria: criteria.judged,
            previousFindings: previous,
            disputeRulings: submission.disputeRulings,
            submission,
            diff: diff.text.slice(0, 40000),
            instruction:
              "这是一次性复核副本，按成果性质选择检查方式；任务确实需要时运行命令、测试或构建。必须实际核对必需标准，无法核实则 inconclusive。不能修改作者成果。diff 是作者开工时的版本与提交版本之间的完整对比（- 行是开工时的内容，+ 行是提交的内容），由程序生成；submission.changes 是程序核对出的全部改动文件，没列出的文件没有改动。副本里 .airoom 下的基线是提交之后生成的，不能当作开工前的版本。diff 和 submission.changes 可以直接作为“哪些文件改了、哪些没改”的依据，不需要再要别的基线。用户验收在整轮完成之后进行，不要因为“用户还没确认”而不通过。",
          },
        ),
        this.checkedReview(op, criteria.required, previous),
      );
      if (!this.validOperation(op, result.runId)) {
        this.update("flow_reviews", review, {
          status: "stale",
          runId: result.runId,
          staleReason: "复核到达时任务或依赖版本已改变。",
        });
        return;
      }
      if (
        (await workspaceFingerprint(author.workspace!)) !==
        submission.version.fingerprint
      ) {
        this.update("flow_reviews", review, {
          status: "stale",
          staleReason: "作者成果已改变。",
        });
        throw new FlowError("STALE_VERSION", "复核期间作者版本改变。");
      }
      if (!this.validOperation(op, result.runId)) return;
      const boundEvidence = this.reviewEvidence(
          result.payload,
          op,
          result.runId,
        ),
        assessment = assessReview(
          { ...result.payload, evidence: boundEvidence },
          criteria.required,
          criteria.deferred,
          previous,
          submission.disputeRulings
            ?.filter((r) => r.verdict === "uphold-author")
            .map((r) => r.findingId),
          criteria.judged,
        ),
        findings = assessment.findings.map((f) => ({
          ...f,
          id: f.previousFindingId ?? randomUUID(),
        }));
      this.store.transaction(() => {
        this.update("flow_reviews", review, {
          runId: result.runId,
          status:
            assessment.outcome === "pass"
              ? "passed"
              : assessment.outcome === "inconclusive"
                ? "inconclusive"
                : "changes_requested",
          verdict: result.payload.verdict,
          outcome: assessment.outcome,
          outcomeReasons: assessment.reasons,
          deferredUserCriteria: assessment.deferredUserCriteria,
          verificationComplete: result.payload.verificationComplete,
          criteriaResults: result.payload.criteriaResults,
          assessments: result.payload.assessments,
          strengths: result.payload.strengths,
          findings,
          evidence: boundEvidence,
          previousFindingChecks: result.payload.previousFindingChecks,
        });
        const latest = this.need<Task>("flow_tasks", task.id);
        if (assessment.outcome === "pass")
          this.update("flow_tasks", latest, {
            status: "review_passed",
            reviewSkipped: undefined,
            reviewRequested: undefined,
            reviewLevelAtSubmission: "high",
            manualRedos: this.completeRedo(latest.manualRedos, "passed"),
            supplements: (latest.supplements ?? []).map((s) =>
              s.status === "submitted" ? { ...s, status: "applied" } : s,
            ),
          });
        else if (assessment.outcome === "inconclusive") {
          const reason =
            "复核无法下结论：" +
            task.title +
            "，" +
            (assessment.reasons.join("；") || "需要补充验证依据。");
          this.update("flow_tasks", latest, {
            status: "blocked",
            blockedReason: reason,
            statusBeforeBlock: "awaiting_review",
          });
          this.reviewDecision(
            flow,
            this.need<Task>("flow_tasks", task.id),
            reason,
          );
        } else if (latest.manualRedos?.at(-1)?.status === "pending") {
          this.update("flow_tasks", latest, {
            status: "escalated",
            manualRedos: this.completeRedo(latest.manualRedos, "failed"),
          });
          this.decision(
            flow,
            "replan",
            this.need<Task>("flow_tasks", task.id),
            "换人后的任务仍未通过",
            "人工换人后的单次重做已用完。" + assessment.reasons.join("；"),
          );
        } else if (latest.returnCount >= FLOW_LIMITS.returns) {
          this.update("flow_tasks", latest, { status: "escalated" });
          if (latest.rearrangeCount < 1)
            this.launch(
              () => this.rearrange(latest),
              (error) =>
                this.decision(
                  flow,
                  "replan",
                  latest,
                  "任务需要你决定",
                  error.message,
                ),
            );
          else
            this.decision(
              flow,
              "replan",
              latest,
              "任务需要重新安排",
              "已退回两次并重新安排，不能继续自动退回。",
            );
        } else {
          this.update("flow_tasks", latest, {
            status: "correcting",
            returnCount: latest.returnCount + 1,
            findingIds: findings
              .filter((f) => f.disposition === "requires-fix")
              .map((f) => f.id),
          });
          this.update("flow_reviews", review, { returnCounted: true });
        }
        this.update("flow_operations", op, { state: "done" });
      });
    } catch (error) {
      if (
        this.supersededOperation(op) ||
        requirementsRevision(this.need<Task>("flow_tasks", task.id)) !==
          review.requirementsRevision
      ) {
        this.update("flow_reviews", review, {
          status: "stale",
          staleReason: "用户补充了要求，旧复核结果不再生效。",
        });
        this.update("flow_operations", op, { state: "done" });
        return;
      }
      if (this.need<Review>("flow_reviews", review.id).status !== "stale")
        this.update("flow_reviews", review, {
          status: this.deferred(error as Error) ? "stale" : "blocked",
          staleReason: (error as Error).message,
        });
      this.failOperation(op, error);
      throw error;
    } finally {
      const runId =
        this.store.get<FlowOperation>("flow_operations", op.id)
          ?.correctionRunId ??
        this.store.get<FlowOperation>("flow_operations", op.id)?.runId;
      if (!runId || this.store.get<Run>("runs", runId)?.status !== "unknown")
        await this.artifacts.remove(this.artifacts.get(disposable.id));
    }
  }
  private saveDecision(decision: Decision) {
    this.store.putMany([
      { entity: "flow_decisions", id: decision.id, value: decision },
      projectFlowCardWrite(this.store, "decision", decision)!,
    ]);
    return decision;
  }
  private decision(
    flow: ProjectFlow,
    kind: Decision["kind"],
    task: Task,
    title: string,
    reason: string,
  ) {
    return this.saveDecision({
      ...this.record(flow.projectId, flow.id),
      kind,
      taskId: task.id,
      roundId: task.roundId,
      stage: kind === "replan" ? "task" : undefined,
      currentMemberId: task.memberId,
      eligibleMemberIds: flow.memberIds.filter((id) => id !== task.memberId),
      title,
      reason,
      options:
        kind === "replan"
          ? ["重新安排", "暂停"]
          : ["确认范围调整", "保持原范围"],
      eligibleTaskIds: [],
      sourceVersions: task.latestSubmissionId
        ? [
            this.need<Submission>("flow_submissions", task.latestSubmissionId)
              .version,
          ]
        : [],
      status: "open",
    });
  }
  private reviewDecision(
    flow: ProjectFlow,
    target: Task | Integration,
    reason: string,
    peer = false,
  ) {
    const task = "completionCriteria" in target ? target : undefined,
      round = this.need<Round>("flow_rounds", target.roundId),
      currentMemberId = task
        ? task.reviewerMemberId
        : peer
          ? (round.peerReviewerMemberId ??
            flow.memberIds.find((id) => id !== this.lead(round)))
          : this.lead(round);
    if (
      this.store
        .list<Decision>("flow_decisions")
        .some(
          (d) =>
            d.status === "open" &&
            d.kind === "unresolved-review" &&
            (task ? d.taskId === task.id : d.integrationId === target.id),
        )
    )
      return;
    this.saveDecision({
      ...this.record(flow.projectId, flow.id),
      kind: "unresolved-review",
      taskId: task?.id,
      roundId: round.id,
      integrationId: task ? undefined : target.id,
      stage: task ? "task-review" : peer ? "peer-review" : "integration-check",
      currentMemberId,
      eligibleMemberIds: flow.memberIds.filter(
        (id) =>
          id !== currentMemberId &&
          id !== (task?.memberId ?? (peer ? this.lead(round) : undefined)),
      ),
      title: task ? "任务复核需要进一步核实" : "整轮检查需要进一步核实",
      reason,
      options: task
        ? ["重新复核", "换人复核", "退回补充依据"]
        : peer
          ? ["重新检查", "换人复核", "我来判断"]
          : ["重新检查", "换负责人检查", "我来判断"],
      eligibleTaskIds: [],
      sourceVersions: task
        ? [
            this.need<Submission>("flow_submissions", task.latestSubmissionId!)
              .version,
          ]
        : (target as Integration).version
          ? [(target as Integration).version!]
          : [],
      status: "open",
    });
    this.update("project_flows", this.flow(flow.id), {
      blockedReasons: [
        ...new Set([...this.flow(flow.id).blockedReasons, reason]),
      ],
    });
  }
  private async rearrange(task: Task) {
    const flow = this.flow(task.flowId),
      lead = this.lead(task),
      session = this.host.session(flow.projectId, lead, "重新安排任务", false),
      op = this.operation(flow, "rearrange", task, session.id);
    this.store.put("sessions", session.id, { ...session, flowId: flow.id });
    this.update("flow_tasks", task, { rearrangeCount: 1 });
    try {
      const result = await this.protocol(
        op,
        "task-rearrange",
        flowPrompt(
          "task-rearrange",
          {
            memberId: task.memberId,
            goal: task.goal,
            completionCriteria: task.completionCriteria,
            reason: "重新安排的依据",
          },
          {
            task,
            memberIds: flow.memberIds,
            findings: this.store
              .list<Review>("flow_reviews")
              .filter((r) => r.taskId === task.id)
              .flatMap((r) => r.findings),
            instruction:
              "只调整本任务的目标表述和团队内成员，不能扩大范围或重置退回次数。完成标准按 check、judge、owner 分类；主观要求用 judge 或 owner，不能冒充可核对事实。",
          },
        ),
        (raw) => {
          const p = payloadObject(raw, "task-rearrange");
          if (
            !flow.memberIds.includes(String(p.memberId)) ||
            !this.host.available(String(p.memberId), true)
          )
            throw new FlowError(
              "REPLAN_REQUIRED",
              "负责人未能给出可执行的重新安排。",
            );
          const completionCriteria = parseCompletionCriteria(
            p.completionCriteria,
          );
          rejectUserCriteria(completionCriteria, this.store.profile().name);
          return {
            memberId: text(p.memberId),
            goal: text(p.goal),
            completionCriteria,
            reason: text(p.reason),
          };
        },
      );
      if (!this.validOperation(op, result.runId)) return;
      const required = retainSupplementRequirements(
        this.need<Task>("flow_tasks", task.id),
        result.payload.goal,
        result.payload.completionCriteria,
      );
      this.update("flow_tasks", this.need<Task>("flow_tasks", task.id), {
        memberId: result.payload.memberId,
        ...required,
        sessionId:
          result.payload.memberId === task.memberId
            ? task.sessionId
            : undefined,
        reviewerMemberId:
          result.payload.memberId === task.reviewerMemberId
            ? this.reviewer(flow, result.payload.memberId)
            : task.reviewerMemberId,
        status: "pending",
        blockedReason: undefined,
      });
      this.update("flow_operations", op, {
        state: "done",
        result: result.payload,
      });
    } catch (error) {
      this.failOperation(op, error);
      throw error;
    }
  }
  private async integrate(round: Round) {
    const flow = this.flow(round.flowId),
      plan = this.need<Plan>("flow_plans", round.planId),
      tasks = this.tasks(flow.id).filter(
        (t) => t.roundId === round.id && t.status !== "cancelled",
      ),
      previous = round.integrationId
        ? this.need<Integration>("flow_integrations", round.integrationId)
        : undefined;
    const base = this.artifacts.get(round.baseVersion!.artifactId),
      start =
        previous && ["conflict", "changes_requested"].includes(previous.status)
          ? this.artifacts.get(previous.workspaceArtifactId)
          : base;
    const appliedBaseline = base.baseArtifactId ?? base.id,
      candidate = await this.artifacts.capture(
        flow,
        start.root,
        "integration",
        appliedBaseline,
        start.fingerprint,
      ),
      included = previous?.includedSubmissionIds ?? [];
    const integration: Integration = {
      ...this.record(flow.projectId, flow.id),
      roundId: round.id,
      sequence: (previous?.sequence ?? 0) + 1,
      reviewLevel: roundReviewLevel(flow, round),
      advisoryFindings: this.taskAdvice(tasks),
      baseVersion: round.baseVersion!,
      includedSubmissionIds: [],
      workspaceArtifactId: candidate.id,
      checkEvidence: [],
      findings: [],
      conflicts: [],
      status: "assembling",
    };
    this.store.put("flow_integrations", integration.id, integration);
    this.update("flow_rounds", round, {
      integrationId: integration.id,
      manualAcceptance: undefined,
    });
    const ordered: Task[] = [];
    const visit = (t: Task) => {
      if (ordered.includes(t)) return;
      for (const dep of t.dependencies) {
        const other = tasks.find((x) => x.id === dep);
        if (other) visit(other);
      }
      ordered.push(t);
    };
    tasks.forEach(visit);
    for (const task of ordered) {
      const sub = this.need<Submission>(
          "flow_submissions",
          task.latestSubmissionId!,
        ),
        author = this.need<Session>("sessions", sub.sessionId);
      if (
        sub.status !== "submitted" ||
        (await workspaceFingerprint(author.workspace!)) !==
          sub.version.fingerprint
      )
        throw new FlowError("STALE_VERSION", "提交成果在整合前改变。");
      integration.includedSubmissionIds.push(sub.id);
      if (included.includes(sub.id)) continue;
      integration.conflicts.push(
        ...(await this.artifacts.merge(
          candidate.root,
          this.artifacts.get(sub.version.artifactId),
        )),
      );
    }
    candidate.fingerprint = await workspaceFingerprint(candidate.root);
    this.store.put("flow_artifacts", candidate.id, candidate);
    integration.version = this.artifacts.version(candidate);
    if (integration.conflicts.length) {
      this.update("flow_integrations", integration, {
        ...integration,
        status: "conflict",
      });
      await this.integrationFix(
        round,
        integration,
        "整合冲突：" + JSON.stringify(integration.conflicts),
      );
      return;
    }
    this.store.transaction(() => {
      this.update("flow_integrations", integration, {
        ...integration,
        status: "checking",
      });
      this.update("flow_rounds", round, { status: "checking" });
    });
    if (integration.reviewLevel === "low") {
      await this.reportUncheckedRound(round, integration, tasks);
      return;
    }
    await this.checkIntegratedRound(round, integration, tasks);
  }
  private integrationCriteria(round: Round) {
    const plan = this.need<Plan>("flow_plans", round.planId),
      tasks = this.tasks(round.flowId).filter(
        (t) => t.roundId === round.id && t.status !== "cancelled",
      ),
      taskCriteria = tasks.flatMap((t) => t.completionCriteria),
      supplementCriteria = tasks.flatMap((t) =>
        t.completionCriteria.filter((c) =>
          criterionText(c).startsWith("补充要求："),
        ),
      ),
      ownerCriteria = taskCriteria.filter(
        (c) => memberCriteria([c], this.store.profile().name).deferred.length,
      );
    return memberCriteria(
      [
        ...new Set([
          ...(round.completionCriteria ?? taskCriteria),
          ...supplementCriteria,
          ...ownerCriteria,
          ...(round.index === plan.rounds.length - 1
            ? plan.acceptanceCriteria
            : []),
        ]),
      ],
      this.store.profile().name,
    );
  }
  private requestRoundCheck(
    round: Round,
    integration: Integration,
    memberId: string,
  ) {
    const flow = this.flow(round.flowId);
    this.requireIdle(round.id);
    if (
      round.planId !== flow.activePlanId ||
      flow.status !== "active" ||
      round.status !== "awaiting_acceptance" ||
      round.integrationId !== integration.id ||
      integration.status !== "ready" ||
      !integration.version
    )
      throw new FlowError("STALE_VERSION", "只能检查当前待验收的整轮成品。");
    if (
      !flow.memberIds.includes(memberId) ||
      !this.host.available(memberId, true)
    )
      throw new FlowError("MEMBER_UNAVAILABLE", "请选择团队内可用的检查成员。");
    const check: RequestedRoundCheck = {
      ...this.record(flow.projectId, flow.id),
      roundId: round.id,
      integrationId: integration.id,
      memberId,
      version: integration.version,
      status: "pending",
    };
    this.store.transaction(() => {
      this.store.put("flow_requested_checks", check.id, check);
      this.update("flow_rounds", round, {
        status: "checking",
        requiresUserAcceptance: true,
        requestedCheckId: check.id,
      });
      this.update("flow_integrations", integration, {
        reviewChoice: memberId === this.lead(round) ? "lead" : "user",
      });
      for (const decision of this.store
        .list<Decision>("flow_decisions")
        .filter(
          (d) =>
            d.roundId === round.id &&
            d.kind === "review-choice" &&
            d.status === "open",
        ))
        this.update("flow_decisions", decision, { status: "expired" });
    });
    return check;
  }
  private async runRequestedCheck(round: Round, check: RequestedRoundCheck) {
    const flow = this.flow(round.flowId),
      integration = this.need<Integration>(
        "flow_integrations",
        check.integrationId,
      ),
      artifact = this.artifacts.get(check.version.artifactId),
      split = this.integrationCriteria(round);
    if (
      !this.recoveryOperation("requested-check", check.id) &&
      !this.quotaAllows(flow, round, check.memberId, "requested-check")
    )
      return;
    if (
      round.integrationId !== integration.id ||
      (await workspaceFingerprint(artifact.root)) !== check.version.fingerprint
    )
      throw new FlowError("STALE_VERSION", "你要求检查的成品版本已改变。");
    const { disposable, session } = await this.openReviewCopy(
      flow,
      artifact.root,
      artifact.fingerprint,
      check.memberId,
      "用户要求的整轮检查 " + round.title,
    );
    const op = this.operation(flow, "requested-check", check, session.id);
    this.update("flow_requested_checks", check, { status: "running" });
    try {
      const base = this.artifacts.get(round.baseVersion!.artifactId),
        diff = await this.artifacts.diff(base, artifact),
        changes = await this.artifacts.changes(base.root, artifact.root);
      const result = await this.protocol(
        op,
        "requested-check",
        flowPrompt(
          "requested-check",
          reviewTemplate(split.required, "检查整轮成品", "实际检查结果", undefined, false),
          {
            round,
            executionActivity: roundActivityMaterial(this.store, round),
            integration,
            diff: diff.text.slice(0, 40000),
            changes,
            criteria: split.required,
            deferredUserCriteria: split.deferred,
            judgedCriteria: split.judged,
            instruction:
              "在一次性副本实际检查。diff 是本轮开始版本与待验收成品之间的对比，changes 是程序核对出的全部改动文件，未列出的文件没有改动；这两项可作为修改范围的依据，不需要再索要开工前基线。作者执行目录与一次性复核副本目录不同是正常的隔离安排，执行时间以 executionActivity 中的后台原生记录为准。只报告检查结果和问题，不修改成品或安排修正。检查结束后交回用户，由用户决定通过或驳回。",
          },
        ),
        this.checkedReview(op, split.required),
      );
      if (
        !this.validOperation(op, result.runId) ||
        this.need<Round>("flow_rounds", round.id).integrationId !==
          integration.id
      )
        return;
      if (
        (await workspaceFingerprint(artifact.root)) !==
        check.version.fingerprint
      )
        throw new FlowError("STALE_VERSION", "检查期间成品版本已改变。");
      const evidence = this.reviewEvidence(result.payload, op, result.runId),
        assessment = assessReview(
          { ...result.payload, evidence },
          split.required,
          split.deferred,
          [],
          [],
          split.judged,
        );
      this.store.transaction(() => {
        this.update("flow_requested_checks", check, {
          status: "completed",
          runId: result.runId,
          ...reviewOutcome(result.payload, assessment),
          findings: assessment.findings.map((f) => ({
            ...f,
            id: randomUUID(),
          })),
          evidence,
        });
        this.update("flow_operations", op, { state: "done" });
        this.update("flow_rounds", round, {
          status: "awaiting_acceptance",
          requiresUserAcceptance: true,
        });
      });
    } catch (error) {
      this.failOperation(op, error);
      this.update("flow_requested_checks", check, {
        status: this.deferred(error as Error) ? "pending" : "blocked",
      });
      this.update("flow_rounds", round, {
        status: this.deferred(error as Error) ? "checking" : "blocked",
      });
      throw error;
    } finally {
      await this.releaseReviewCopy(op.id, disposable.id);
    }
  }
  private async checkIntegratedRound(
    round: Round,
    integration: Integration,
    tasks: Task[],
  ) {
    const flow = this.flow(round.flowId),
      candidate = this.artifacts.get(integration.workspaceArtifactId),
      lead = this.lead(round),
      split = this.integrationCriteria(round),
      criteria = split.required,
      previous = this.previousRoundFindings(round, integration);
    if (
      flow.dispatchMode !== "running" ||
      (!this.recoveryOperation("integration-check", integration.id) &&
        !this.quotaAllows(flow, round, lead, "integration-check"))
    )
      return;
    if (
      (await workspaceFingerprint(candidate.root)) !==
      integration.version?.fingerprint
    )
      throw new FlowError("STALE_VERSION", "整合检查前成果版本已改变。");
    const session = this.host.session(
      flow.projectId,
      lead,
      "整合检查 " + round.title,
      true,
    );
    this.store.put("sessions", session.id, {
      ...session,
      workspace: candidate.root,
      workspaceKind: "original",
      purpose: "flow-integration",
      flowId: flow.id,
    });
    const meeting = roundMeetingMaterial(
        this.store,
        this.need<Round>("flow_rounds", round.id),
      ),
      nextRound = this.store
        .list<Round>("flow_rounds")
        .find((r) => r.planId === round.planId && r.index === round.index + 1),
      nextTasks = this.tasks(flow.id).filter(
        (t) => t.roundId === nextRound?.id,
      ),
      op = this.operation(flow, "integration-check", integration, session.id);
    const diff = await this.artifacts.diff(
        this.artifacts.get(round.baseVersion!.artifactId),
        candidate,
      ),
      changes = await this.artifacts.changes(
        this.artifacts.get(round.baseVersion!.artifactId).root,
        candidate.root,
      );
    try {
      const result = await this.protocol(
        op,
        "integration-check",
        flowPrompt(
          "integration-check",
          {
            ...reviewTemplate(criteria, "整合检查", "结果", previous),
            report: {
              summary: "本轮结论",
              completedTaskKeys: tasks.map((t) => t.key),
              deliverables: this.need<Plan>("flow_plans", round.planId)
                .deliverables,
              validationSummary: "实际验证结果",
              remainingIssues: [],
              nextRoundSummary: "下一轮安排",
              userDecisionNeeded: round.requiresUserAcceptance
                ? "请验收本轮成品"
                : "",
              meetingResponses: meeting.pendingUserMessages.map((m) => ({
                messageId: m.id,
                disposition: "needs-user",
                summary: "实际处理结果",
                paths: [],
              })),
            },
            ...(nextRound
              ? {
                  nextRoundRecommendation: {
                    mode: "as-planned",
                    summary: "按原计划",
                    taskAdjustments: [],
                  },
                }
              : {}),
          },
          {
            round,
            userReviewRequest: this.userReviewRequest(
              integration,
              "integration-check",
              integration.version,
            ),
            executionActivity: roundActivityMaterial(this.store, round),
            nextRound,
            nextTasks,
            taskScopeEvidence: this.tasks(flow.id).filter(t => t.latestSubmissionId).map(t => {
              const submission = this.need<Submission>("flow_submissions", t.latestSubmissionId!);
              return {taskId: t.id, key: t.key, roundId: t.roundId, status: t.status, allowedPaths: t.allowedPaths, submissionId: submission.id, changes: submission.changes, outOfScopeChanges: submission.outOfScopeChanges};
            }),
            submissions: tasks.map((t) =>
              this.need<Submission>("flow_submissions", t.latestSubmissionId!),
            ),
            criteria,
            deferredUserCriteria: split.deferred,
            judgedCriteria: split.judged,
            previousFindings: previous,
            advisoryFindings: integration.advisoryFindings,
            diff: diff.text.slice(0, 40000),
            changes,
            meeting,
            instruction:
              "在整合副本实际检查，不编辑源文件；不确定则 inconclusive。检查通过时请在同次回复的 report 汇报；remainingIssues 必须列出仍未处理的 advisoryFindings。根据本轮结果在 nextRoundRecommendation 提出下一轮建议，无调整用 as-planned 和按原计划，轻量调整只改未开工任务的目标、输入或标准，大的方向或范围变化用 replan，不能改变负责人、成员或任务范围。diff 是本轮开始时的版本与当前整合结果之间的对比，changes 是程序核对出的改动文件清单。这两项可以直接作为内容和修改范围的依据，不需要再要开工前的基线。taskScopeEvidence 是程序保存的各已提交任务的许可路径、实际改动和越界记录，可用于跨轮核对；不要将本轮 diff 误当作所有轮次的改动。用户验收在这次整合检查和汇报之后进行，不要因为“用户还没确认”判为未通过。阅读本轮未读会议消息，聊天不是修改授权。发现范围内需要修改的内容写入 findings，范围变化或用户问题留给汇报和决策。",
          },
        ),
        this.integratedReply(op, criteria, previous, round, tasks, meeting),
      );
      if (
        !this.validOperation(op, result.runId) ||
        this.need<Round>("flow_rounds", round.id).integrationId !==
          integration.id
      )
        return;
      integration.checkRunId = result.runId;
      integration.checkEvidence = this.reviewEvidence(
        result.payload,
        op,
        result.runId,
      );
      const assessment = assessReview(
        { ...result.payload, evidence: integration.checkEvidence },
        criteria,
        split.deferred,
        previous,
        [],
        split.judged,
      );
      integration.findings = assessment.findings.map((f) => ({
        ...f,
        id: f.previousFindingId ?? randomUUID(),
      }));
      Object.assign(integration, {
        ...reviewOutcome(result.payload, assessment),
        verificationComplete: result.payload.verificationComplete,
        deferredUserCriteria: assessment.deferredUserCriteria,
        previousFindingChecks: result.payload.previousFindingChecks,
        reportDraft: result.payload.report,
        draftMeetingIds: meeting.pendingUserMessages.map((m) => m.id),
        nextRoundDraft: result.payload.nextRoundRecommendation,
      });
      const latest = this.need<Round>("flow_rounds", round.id);
      this.update("flow_rounds", latest, {
        deferredUserCriteria: assessment.deferredUserCriteria,
        requiresUserAcceptance: round.requiresUserAcceptance || assessment.deferredUserCriteria.length > 0,
        meetingReadIds: [
          ...new Set([
            ...(latest.meetingReadIds ?? []),
            ...meeting.messages.map((message) => message.id),
          ]),
        ],
      });
      markRoomRead(
        this.store,
        flow.roomId as RoomId,
        lead,
        meeting.messages.map((message) => message.id),
      );
      if (
        (await workspaceFingerprint(candidate.root)) !== candidate.fingerprint
      )
        throw new FlowError(
          "STALE_VERSION",
          "整合检查改变了源文件，需要明确修正任务。",
        );
      this.update("flow_operations", op, { state: "done" });
      if (assessment.outcome === "inconclusive") {
        this.update("flow_integrations", integration, {
          ...integration,
          status: "blocked",
        });
        this.update("flow_rounds", round, { status: "blocked" });
        this.reviewDecision(
          flow,
          integration,
          "整合检查无法下结论：" +
            (assessment.reasons.join("；") || "需要进一步验证。"),
        );
        return;
      }
      if (assessment.outcome === "changes_requested") {
        this.update("flow_integrations", integration, {
          ...integration,
          status: "changes_requested",
        });
        await this.integrationFix(
          round,
          integration,
          "整合检查未通过：" + assessment.reasons.join("；"),
        );
        return;
      }
      this.update("flow_integrations", integration, {
        ...integration,
        status: "checking",
      });
      this.update("flow_rounds", round, {
        manualRedos: this.completeRedo(
          this.need<Round>("flow_rounds", round.id).manualRedos,
          "passed",
        ),
      });
      if (this.need<Round>("flow_rounds", round.id).requiresPeerReview) {
        await this.peerReviewRound(round, integration, tasks);
        return;
      }
      await this.reportIntegratedRound(round, integration, tasks, session.id);
    } catch (error) {
      this.failOperation(op, error);
      throw error;
    }
  }
  private validateMeetingReport(
    raw: unknown,
    meeting: ReturnType<typeof roundMeetingMaterial>,
    tasks: Task[],
  ): RoundReport {
    return this.validation.validateMeetingReport(raw, meeting, tasks);
  }
  private async reportUncheckedRound(
    round: Round,
    integration: Integration,
    tasks: Task[],
  ) {
    const flow = this.flow(round.flowId),
      lead = this.lead(round);
    this.update("flow_rounds", round, { requiresUserAcceptance: true });
    const session = this.host.session(
      flow.projectId,
      lead,
      "本轮汇总 " + round.title,
      true,
    );
    this.store.put("sessions", session.id, {
      ...session,
      workspace: this.artifacts.get(integration.workspaceArtifactId).root,
      workspaceKind: "original",
      purpose: "flow-integration",
      flowId: flow.id,
    });
    await this.reportIntegratedRound(
      this.need<Round>("flow_rounds", round.id),
      integration,
      tasks,
      session.id,
    );
    const latest = this.need<Round>("flow_rounds", round.id);
    if (
      latest.status !== "awaiting_acceptance" ||
      latest.integrationId !== integration.id
    )
      return;
    if (
      this.store
        .list<Decision>("flow_decisions")
        .some(
          (d) =>
            d.integrationId === integration.id &&
            d.kind === "review-choice" &&
            ["open", "answered"].includes(d.status),
        )
    )
      return;
    this.saveDecision({
      ...this.record(flow.projectId, flow.id),
      kind: "review-choice",
      stage: "integration-check",
      roundId: round.id,
      integrationId: integration.id,
      title: "本轮已汇总，选择复核或验收",
      reason:
        "当前为最低复核程度，个人任务和本轮成果尚未由 AI 复核。可先交给负责人复核，也可直接进入你的成品验收。",
      options: ["交给负责人复核", "直接由我验收"],
      eligibleTaskIds: [],
      sourceVersions: [integration.version!],
      status: "open",
    });
  }
  private async manualRoundReport(
    round: Round,
    integration: Integration,
    tasks: Task[],
  ) {
    const flow = this.flow(round.flowId),
      session = this.host.session(
        flow.projectId,
        this.lead(round),
        "本轮汇报 " + round.title,
        true,
      );
    this.store.put("sessions", session.id, {
      ...session,
      workspace: this.artifacts.get(integration.workspaceArtifactId).root,
      workspaceKind: "original",
      purpose: "flow-integration",
      flowId: flow.id,
    });
    await this.reportIntegratedRound(round, integration, tasks, session.id);
  }
  private async peerReviewRound(
    round: Round,
    integration: Integration,
    tasks: Task[],
  ) {
    const flow = this.flow(round.flowId),
      lead = this.lead(round),
      memberId = this.recoveryOperation("peer-review", integration.id)
        ? round.peerReviewerMemberId
        : this.availablePeer(round);
    if (flow.dispatchMode !== "running" || !this.host.alive()) return;
    if (!memberId || memberId === lead)
      throw new FlowError(
        "REVIEWER_REQUIRED",
        "整轮他人复核需要一名可用的其他成员。",
      );
    if (
      flow.dispatchMode !== "running" ||
      (!this.recoveryOperation("peer-review", integration.id) &&
        !this.quotaAllows(flow, round, memberId, "peer-review"))
    )
      return;
    const candidate = this.artifacts.get(integration.workspaceArtifactId),
      split = this.integrationCriteria(round),
      previous = this.previousRoundFindings(round, integration, true);
    if (
      (await workspaceFingerprint(candidate.root)) !==
      integration.version?.fingerprint
    )
      throw new FlowError("STALE_VERSION", "整轮复核前版本已改变。");
    const { disposable, session } = await this.openReviewCopy(
      flow,
      candidate.root,
      candidate.fingerprint,
      memberId,
      "整轮复核 " + round.title,
    );
    this.update("flow_rounds", round, { peerReviewerMemberId: memberId });
    const op = this.operation(flow, "peer-review", integration, session.id);
    try {
      const diff = await this.artifacts.diff(
          this.artifacts.get(round.baseVersion!.artifactId),
          candidate,
        ),
        result = await this.protocol(
          op,
          "peer-review",
          flowPrompt(
            "peer-review",
            reviewTemplate(split.required, "整轮成果检查", "实际结果", previous),
            {
              round,
              userReviewRequest: this.userReviewRequest(
                integration,
                "peer-review",
                integration.version,
              ),
              executionActivity: roundActivityMaterial(this.store, round),
              criteria: split.required,
              deferredUserCriteria: split.deferred,
              judgedCriteria: split.judged,
              previousFindings: previous,
              diff: diff.text.slice(0, 40000),
              integrationVersion: integration.version,
              leadCheck: {
                verdict: integration.verdict,
                criteriaResults: integration.criteriaResults,
                findings: integration.findings,
              },
              instruction:
                "在一次性副本检查整轮成果，不能修改负责人整合版本。不确定就记录 inconclusive，用户验收留到汇报之后。",
            },
          ),
          this.checkedReview(op, split.required, previous),
        );
      if (
        !this.validOperation(op, result.runId) ||
        this.need<Round>("flow_rounds", round.id).integrationId !==
          integration.id
      )
        return;
      if (
        (await workspaceFingerprint(candidate.root)) !==
        integration.version!.fingerprint
      )
        throw new FlowError("STALE_VERSION", "整轮复核期间整合版本改变。");
      const evidence = this.reviewEvidence(result.payload, op, result.runId),
        assessment = assessReview(
          { ...result.payload, evidence },
          split.required,
          split.deferred,
          previous,
          [],
          split.judged,
        ),
        peerReview = {
          memberId,
          runId: result.runId,
          ...reviewOutcome(result.payload, assessment),
          findings: assessment.findings.map((f) => ({
            ...f,
            id: f.previousFindingId ?? randomUUID(),
          })),
          evidence,
          verificationComplete: result.payload.verificationComplete,
        };
      this.update("flow_operations", op, { state: "done" });
      const saved = this.update("flow_integrations", integration, {
        peerReview,
        deferredUserCriteria: [...new Set([...integration.deferredUserCriteria ?? [], ...assessment.deferredUserCriteria])],
      });
      if (assessment.outcome === "inconclusive") {
        this.update("flow_integrations", saved, { status: "blocked" });
        this.update("flow_rounds", round, { status: "blocked" });
        this.reviewDecision(
          flow,
          saved,
          "整轮他人复核无法下结论：" +
            (assessment.reasons.join("；") || "需要进一步验证。"),
          true,
        );
        return;
      }
      if (assessment.outcome === "changes_requested") {
        await this.integrationFix(
          round,
          saved,
          "整轮他人复核未通过：" + assessment.reasons.join("；"),
        );
        return;
      }
      const reportSession = this.host.session(
        flow.projectId,
        lead,
        "本轮汇报 " + round.title,
        true,
      );
      this.store.put("sessions", reportSession.id, {
        ...reportSession,
        workspace: candidate.root,
        workspaceKind: "original",
        purpose: "flow-integration",
        flowId: flow.id,
      });
      await this.reportIntegratedRound(
        this.need<Round>("flow_rounds", round.id),
        saved,
        tasks,
        reportSession.id,
      );
    } catch (error) {
      if (this.need<FlowOperation>("flow_operations", op.id).state !== "done")
        this.failOperation(op, error);
      throw error;
    } finally {
      await this.releaseReviewCopy(op.id, disposable.id);
    }
  }
  private meetingDecision(
    flow: ProjectFlow,
    round: Round,
    response: NonNullable<RoundReport["meetingResponses"]>[number],
  ) {
    const id = `meeting-request:${round.id}:${response.messageId}`;
    if (this.store.get("flow_decisions", id)) return;
    const asked = this.store.get<{ text: string }>(
        "room_messages",
        response.messageId,
      ),
      decision: Decision = {
        ...this.record(flow.projectId, flow.id),
        id,
        kind: "meeting-request",
        roundId: round.id,
        title:
          response.disposition === "scope-change"
            ? "会议要求涉及范围变化"
            : "会议问题需要你决定",
        reason: `${response.summary}\n\n原发言：${asked?.text ?? "见会议记录"}`,
        options: ["保留当前方案", "调整方案", "暂停派发"],
        eligibleTaskIds: [],
        sourceVersions: round.baseVersion ? [round.baseVersion] : [],
        status: "open",
      };
    this.store.putMany([
      { entity: "flow_decisions", id: decision.id, value: decision },
      projectFlowCardWrite(this.store, "decision", decision)!,
    ]);
  }
  private async reportIntegratedRound(
    round: Round,
    integration: Integration,
    tasks: Task[],
    sessionId: string,
  ) {
    round = this.need<Round>("flow_rounds", round.id);
    const flow = this.flow(round.flowId),
      lead = this.lead(round);
    if (flow.dispatchMode !== "running") return;
    const plan = this.need<Plan>("flow_plans", round.planId),
      candidate = this.artifacts.get(integration.workspaceArtifactId),
      criteria =
        round.index === plan.rounds.length - 1
          ? plan.acceptanceCriteria
          : [round.goal];
    if ((await workspaceFingerprint(candidate.root)) !== candidate.fingerprint)
      throw new FlowError("STALE_VERSION", "汇报前整合版本已改变。");
    const meeting = roundMeetingMaterial(this.store, round),
      cached =
        !round.manualAcceptance &&
        integration.reportDraft &&
        integration.checkRunId &&
        JSON.stringify(integration.draftMeetingIds) ===
          JSON.stringify(meeting.pendingUserMessages.map((m) => m.id));
    if (
      !cached &&
      !this.recoveryOperation("round-report", integration.id) &&
      !this.quotaAllows(flow, round, lead, "round-report")
    )
      return;
    const op = cached
      ? undefined
      : this.operation(flow, "round-report", integration, sessionId);
    try {
      const report = cached
        ? {
            payload: this.validateMeetingReport(
              integration.reportDraft!,
              meeting,
              tasks,
            ),
            runId: integration.checkRunId!,
          }
        : await this.protocol(
            op!,
            "round-report",
            flowPrompt(
              "round-report",
              {
                summary: "本轮结论",
                completedTaskKeys: tasks.map((t) => t.key),
                deliverables: plan.deliverables,
                validationSummary: "实际验证结果",
                remainingIssues: [],
                nextRoundSummary: "下一轮安排",
                userDecisionNeeded: round.requiresUserAcceptance
                  ? "请验收本轮成品"
                  : "",
                meetingResponses: meeting.pendingUserMessages.map(
                  (message) => ({
                    messageId: message.id,
                    disposition: "needs-user",
                    summary: "逐条写明实际处理结果",
                    paths: [],
                  }),
                ),
              },
              {
                round,
                executionActivity: roundActivityMaterial(this.store, round),
                criteria,
                reviewLevel: integration.reviewLevel ?? "high",
                manualAcceptance: round.manualAcceptance,
                sourceRoundtables: await this.roundtableMaterials(flow),
                taskReviews: tasks.map(t => ({key: t.key, reviewSkipped: t.reviewSkipped})),
                checkOutcome: integration.outcome,
                assessments: integration.assessments,
                strengths: integration.strengths,
                criteriaResults: integration.criteriaResults,
                deferredUserCriteria: integration.deferredUserCriteria,
                peerReview: integration.peerReview,
                advisoryFindings: integration.advisoryFindings,
                checkEvidence: integration.checkEvidence,
                integrationVersion: integration.version,
                taskKeys: tasks.map((t) => t.key),
                meeting,
                instruction:
                  "manualAcceptance.ownerNote 是用户的直接反馈，引用为用户实测/反馈；明确已实测的项目不要再声称尚未实测，但不得把用户反馈说成 AI 验证。taskReviews 标明 configured 的任务须说明未单独复核。保留圆桌来源。逐条处理 pendingUserMessages，只允许 noted、answered、in-scope-fix、scope-change、needs-user。问题和未满足的要求写入 remainingIssues，需要用户决定的写入 userDecisionNeeded。范围内确需修改时给出实际路径，后台会按配置安排修正及复核；不要自行改文件或扩大任务范围。",
              },
            ),
            (raw) => this.validateMeetingReport(raw, meeting, tasks),
          );
      if (op && !this.validOperation(op, report.runId)) return;
      if (
        (await workspaceFingerprint(candidate.root)) !== candidate.fingerprint
      )
        throw new FlowError(
          "STALE_VERSION",
          "汇报期间整合成果变化，不能提交验收。",
        );
      if (
        new Set(report.payload.completedTaskKeys).size !== tasks.length ||
        report.payload.completedTaskKeys.some(
          (key) => !tasks.some((t) => t.key === key),
        )
      )
        throw new FlowError(
          "INVALID_PROTOCOL",
          "汇报的已完成任务必须与本轮实际任务一致。",
        );
      const responses = report.payload.meetingResponses ?? [],
        fixes = responses.filter(
          (response) => response.disposition === "in-scope-fix",
        ),
        decisions = responses.filter((response) =>
          ["scope-change", "needs-user"].includes(response.disposition),
        );
      const previous = (round.meetingResponses ?? []).map((response) =>
        response.fixTaskId &&
        finished.has(this.need<Task>("flow_tasks", response.fixTaskId).status)
          ? { ...response, resolvedAt: at() }
          : response,
      );
      const evidence = tasks.flatMap((task) => [
        ...(task.latestSubmissionId
          ? this.need<Submission>("flow_submissions", task.latestSubmissionId)
              .evidence
          : []),
        ...(this.store
          .list<Review>("flow_reviews")
          .filter(
            (r) =>
              r.taskId === task.id &&
              r.submissionId === task.latestSubmissionId &&
              r.status === "passed",
          )
          .at(-1)?.evidence ?? []),
      ]);
      report.payload = presentRoundReport(
        report.payload,
        round,
        integration,
        tasks,
        [
          ...evidence,
          ...integration.checkEvidence,
          ...(integration.peerReview?.evidence ?? []),
        ],
      );
      const payload = {
        ...report.payload,
        remainingIssues: [
          ...new Set([
            ...report.payload.remainingIssues,
            ...(integration.advisoryFindings ?? []).map(
              (f) => "成员建议：" + f.location + "：" + f.request,
            ),
            ...[
              ...integration.findings,
              ...(integration.peerReview?.findings ?? []),
            ]
              .filter(
                (f) => f.disposition === "advice" || f.severity === "optional",
              )
              .map((f) => "改进建议：" + f.location + "：" + f.request),
            ...responses
              .filter((response) =>
                ["in-scope-fix", "scope-change", "needs-user"].includes(
                  response.disposition,
                ),
              )
              .map((response) => `会议要求：${response.summary}`),
          ]),
        ],
        userDecisionNeeded: [
          report.payload.userDecisionNeeded,
          ...decisions.map((response) => response.summary),
        ]
          .filter(Boolean)
          .join("\n"),
        meetingResponses: [...previous, ...responses],
      };
      const save = (fixTask?: Task) => {
        for (const response of fixes)
          if (fixTask) response.fixTaskId = fixTask.id;
        for (const response of decisions)
          this.meetingDecision(flow, round, response);
        if (op) this.update("flow_operations", op, { state: "done" });
        if (!fixes.length)
          this.update("flow_integrations", integration, {
            ...integration,
            status: "ready",
          });
        const latest = this.need<Round>("flow_rounds", round.id),
          reported = this.update("flow_rounds", latest, {
            ...(!fixes.length
              ? { status: "awaiting_acceptance" as const }
              : {}),
            requiresUserAcceptance:
              latest.requiresUserAcceptance || decisions.length > 0,
            report: {
              ...payload,
              ...(fixes.length
                ? {
                    summary:
                      payload.summary +
                      "\n正在按会议要求安排范围内修正，复核后再汇报。",
                  }
                : {}),
            },
            reportRunId: report.runId,
            reportedAt: at(),
            meetingResponses: payload.meetingResponses,
            meetingReadIds: [
              ...new Set([
                ...(latest.meetingReadIds ?? []),
                ...meeting.messages.map((message) => message.id),
              ]),
            ],
            meetingHandledIds: [
              ...new Set([
                ...(latest.meetingHandledIds ?? []),
                ...meeting.pendingUserMessages.map((message) => message.id),
              ]),
            ],
          });
        stageRoundReport(this.store, reported);
        for (const t of tasks)
          this.update("flow_tasks", t, { status: "integrated" });
      };
      if (fixes.length) {
        await this.integrationFix(
          round,
          integration,
          "会议要求：" + fixes.map((response) => response.summary).join("；"),
          fixes.map((response) => response.summary),
          save,
        );
        markRoomRead(
          this.store,
          flow.roomId as RoomId,
          lead,
          meeting.messages.map((message) => message.id),
        );
        this.host.report?.();
        return;
      }
      this.store.transaction(() => save());
      markRoomRead(
        this.store,
        flow.roomId as RoomId,
        lead,
        meeting.messages.map((message) => message.id),
      );
      this.host.report?.();
      const latest = this.need<Round>("flow_rounds", round.id);
      if (roundMeetingMaterial(this.store, latest).pendingUserMessages.length) {
        this.update("flow_rounds", latest, { status: "checking" });
        return;
      }
      if (!latest.requiresUserAcceptance) {
        const acceptance: Acceptance = {
          ...this.record(flow.projectId, flow.id),
          roundId: round.id,
          integrationId: integration.id,
          version: integration.version!,
          actor: "lead",
          opinion: report.payload.summary,
          requiresApply: false,
          status: "requested",
          appliedPaths: [],
          conflictPaths: [],
        };
        this.store.put("flow_acceptances", acceptance.id, acceptance);
        await this.finishAcceptance(latest, integration, acceptance);
      }
    } catch (error) {
      if (op) this.failOperation(op, error);
      throw error;
    }
  }
  private async integrationFix(
    round: Round,
    integration: Integration,
    reason: string,
    completionCriteria = ["整合问题已解决"],
    onStaged?: (task?: Task) => void,
    manualRedo?: ManualRedo,
    userRequest?: UserChangeRequest,
  ) {
    round = this.need<Round>("flow_rounds", round.id);
    const flow = this.flow(round.flowId),
      lead = manualRedo?.memberId ?? this.lead(round),
      pendingRedo = round.manualRedos?.at(-1)?.status === "pending";
    if (
      !manualRedo &&
      !userRequest &&
      (pendingRedo || round.integrationFixCount >= FLOW_LIMITS.integrationFixes)
    ) {
      this.store.transaction(() => {
        this.update("flow_rounds", round, {
          status: "blocked",
          manualRedos: pendingRedo
            ? this.completeRedo(round.manualRedos, "failed")
            : round.manualRedos,
        });
        this.saveDecision({
          ...this.record(flow.projectId, flow.id),
          kind: "replan",
          stage: "integration-fix",
          roundId: round.id,
          integrationId: integration.id,
          currentMemberId: lead,
          eligibleMemberIds: flow.memberIds.filter((id) => id !== lead),
          title: "本轮整合需要你决定",
          reason:
            (pendingRedo
              ? "人工指定负责人后的单次修正仍未通过。"
              : "整合已自动修正两次，不能无限继续。") +
            "\n" +
            reason,
          options: ["重新安排", "暂停"],
          eligibleTaskIds: [],
          sourceVersions: integration.version ? [integration.version] : [],
          status: "open",
        });
        onStaged?.();
      });
      return;
    }
    const base = this.artifacts.get(integration.workspaceArtifactId);
    if (
      (await workspaceFingerprint(base.root)) !==
      integration.version?.fingerprint
    )
      throw new FlowError("STALE_VERSION", "安排整合修正前版本已改变。");
    if (this.need<Round>("flow_rounds", round.id).revision !== round.revision)
      throw new FlowError("STALE_REVISION", "安排修正期间轮次已改变。");
    const members = this.tasks(flow.id).filter(
        (t) => t.roundId === round.id && t.status !== "cancelled",
      ),
      issues = [
        ...integration.findings,
        ...(integration.peerReview?.findings ?? []),
      ].filter(
        (f) =>
          f.disposition === "requires-fix" ||
          (f.disposition === undefined &&
            f.kind === "verified" &&
            f.severity !== "optional"),
      ),
      allPaths = [...new Set(members.flatMap((t) => t.allowedPaths))],
      groups = new Map<
        string,
        {
          memberId: string;
          owner?: Task;
          issues: ReviewFinding[];
          paths: string[];
        }
      >();
    let routable = Boolean(
      issues.length &&
        !integration.conflicts.length &&
        !manualRedo &&
        !userRequest &&
        !onStaged,
    );
    for (const finding of issues) {
      const references = [...(finding.location + " " + finding.request).matchAll(/[\w@.-]+(?:[\/][\w@.-]+)*\.[a-zA-Z][a-zA-Z0-9]{0,9}\b/g)].map(m => m[0]);
      const location = finding.location.split(/[:：\n]/)[0].trim(),
        owners = members.filter(
          (t) =>
            t.kind === "implementation" &&
            t.allowedPaths.some((p) => pathWithin(location, p)),
        );
      if (owners.length !== 1 || references.some(path => !owners[0].allowedPaths.some(scope => pathWithin(path, scope)))) {
        routable = false;
        break;
      }
      const owner = owners[0],
        group = groups.get(owner.id) ?? {
          memberId: owner.memberId,
          owner,
          issues: [],
          paths: owner.allowedPaths,
        };
      group.issues.push(finding);
      groups.set(owner.id, group);
    }
    const values = [...groups.values()];
    if (
      values.some((a, i) =>
        values.some((b, j) => j < i && scopesOverlap(a.paths, b.paths)),
      )
    )
      routable = false;
    if (!routable) {
      groups.clear();
      groups.set("lead", { memberId: lead, issues, paths: allPaths });
    }
    const firstSequence =
        members.filter((t) => t.kind === "integration-fix").length + 1,
      tasks = [...groups.values()].map((group, index): Task => {
        const sequence = firstSequence + index,
          criteria = [
            ...new Set([
              ...(completionCriteria[0] === "整合问题已解决" &&
              completionCriteria.length === 1
                ? []
                : completionCriteria),
              ...group.issues.map((f) => f.location + "：" + f.request),
              ...integration.conflicts.map(
                (c) => "解决 " + c.path + " 的合并冲突，保留双方的内容",
              ),
            ]),
          ];
        return {
          ...this.record(flow.projectId, flow.id),
          planId: round.planId,
          roundId: round.id,
          key: "integration-fix-" + sequence,
          title:
            (userRequest ? "用户驳回修正" : "整合修正") +
            " 第" +
            sequence +
            "次 · " +
            round.title,
          kind: "integration-fix",
          memberId: group.memberId,
          reviewerMemberId: lead,
          originTaskId: group.owner?.id,
          goal: userRequest
            ? "按用户驳回意见修正本轮成品"
            : group.issues.length
              ? "修正整合检查发现的 " + group.issues.length + " 个问题"
              : integration.conflicts.length
                ? "解决本轮整合冲突"
                : "完成本轮范围内修正",
          inputs: [
            group.issues.length && !userRequest ? "仅修正下面列出的实际问题，保留已通过的行为。" : reason,
            "完整问题清单：" + JSON.stringify(group.issues),
            ...members.map(
              (t) => "任务 " + t.key + " 提交 " + t.latestSubmissionId,
            ),
          ],
          completionCriteria: criteria.length ? criteria : ["整合问题已解决"],
          allowedPaths: group.paths,
          dependencies: [],
          returnCount: 0,
          disputeReturnWaiverCount: 0,
          rearrangeCount: 0,
          manualRedos: manualRedo ? [manualRedo] : undefined,
          userChangeRequestId: userRequest?.id,
          findingIds: group.issues.map((f) => f.id),
          status: "pending",
          startBase: this.artifacts.version(base),
        };
      });
    this.store.transaction(() => {
      for (const task of tasks) this.store.put("flow_tasks", task.id, task);
      this.update("flow_integrations", integration, {
        status: "changes_requested",
      });
      this.update("flow_rounds", round, {
        ...(manualRedo ? { leadMemberId: lead } : {}),
        status: "changes_requested",
        integrationFixCount:
          round.integrationFixCount + (manualRedo || userRequest ? 0 : 1),
        manualRedos: manualRedo
          ? [...(round.manualRedos ?? []), manualRedo]
          : userRequest
            ? this.completeRedo(round.manualRedos, "failed")
            : round.manualRedos,
        userChangeRequests: userRequest
          ? [
              ...(round.userChangeRequests ?? []),
              { ...userRequest, taskId: tasks[0].id },
            ]
          : round.userChangeRequests,
        taskIds: [...round.taskIds, ...tasks.map((t) => t.id)],
      });
      onStaged?.(tasks[0]);
    });
  }
  private async accept(
    round: Round,
    integration: Integration,
    acceptance: Acceptance,
  ) {
    const artifact = this.artifacts.get(integration.version!.artifactId);
    if (
      (await workspaceFingerprint(artifact.root)) !==
      acceptance.version.fingerprint
    )
      throw new FlowError("STALE_VERSION", "成品在验收前变化。");
    this.update("flow_acceptances", acceptance, {
      status: "applying",
      applyOperationId: acceptance.id,
    });
    const journal = await this.applications.apply(
      acceptance.id,
      artifact,
      this.need<Project>("projects", round.projectId).directory,
    );
    if (journal.state === "applied")
      await this.finishAcceptance(round, integration, acceptance);
    else
      this.update("flow_acceptances", acceptance, {
        status: journal.state === "conflict" ? "conflict" : "recovery_required",
        conflictPaths: journal.conflicts.map((c) => c.path),
      });
  }
  private async finishAcceptance(
    round: Round,
    integration: Integration,
    acceptance: Acceptance,
  ) {
    const flow = this.flow(round.flowId),
      accepted = this.artifacts.get(integration.version!.artifactId),
      checkpoint = await this.artifacts.capture(
        flow,
        accepted.root,
        "base",
        acceptance.requiresApply ? undefined : accepted.baseArtifactId,
        accepted.fingerprint,
      ),
      rounds = this.store
        .list<Round>("flow_rounds")
        .filter((r) => r.flowId === flow.id && r.planId === round.planId),
      next = rounds.find((r) => r.index === round.index + 1);
    const completedRounds = rounds.slice().sort((a,b) => a.index-b.index).map(r => ({roundId:r.id,title:r.title,summary:r.report?.summary ?? "本轮已验收",deliverables:r.report?.deliverables ?? [],validationSummary:r.report?.validationSummary ?? ""}));
    const completionReport = next ? undefined : {
      generatedAt: at(),
      summary: completedRounds.map(r => r.title + "：" + r.summary).join("\n\n"),
      rounds: completedRounds,
      corrections: this.tasks(flow.id).filter(t => t.kind === "integration-fix" || t.returnCount > 0).map(t => ({taskId:t.id,title:t.title,returns:t.returnCount,kind:t.kind})),
      userReturns: rounds.flatMap(r => r.userChangeRequests ?? []),
      roundtables: (await this.roundtableMaterials(flow)).map(m => m.sourceRoundtable),
      remainingIssues: [...new Set(round.report?.remainingIssues ?? [])],
    };
    if (next) await this.invalidateEarlyInputs(next, checkpoint);
    this.store.transaction(() => {
      this.update("flow_acceptances", acceptance, {
        status: "accepted",
        acceptedAt: at(),
        appliedPaths:
          this.store
            .get<ApplyJournal>("flow_apply_journals", acceptance.id)
            ?.files.map((f) => f.path) ?? [],
      });
      this.update("flow_integrations", integration, { status: "accepted" });
      this.update("flow_rounds", round, {
        status: "accepted",
        acceptanceId: acceptance.id,
      });
      for (const t of this.tasks(flow.id).filter(
        (t) => t.roundId === round.id && t.status === "integrated",
      ))
        this.update("flow_tasks", t, { status: "accepted" });
      for (const decision of this.store
        .list<Decision>("flow_decisions")
        .filter(
          (d) =>
            d.roundId === round.id &&
            d.kind === "early-start" &&
            ["open", "answered"].includes(d.status),
        ))
        this.update("flow_decisions", decision, { status: "expired" });
      const currentFlow = this.flow(flow.id);
      if (next && currentFlow.status !== "cancelled")
        this.update("flow_rounds", next, {
          status: acceptance.actor === "user" ? "pending" : "executing",
          startedAt:
            acceptance.actor === "user"
              ? next.startedAt
              : (next.startedAt ?? at()),
          baseVersion: this.artifacts.version(checkpoint),
          ...(acceptance.actor === "user"
            ? {
                nextConfirmation: {
                  previousRoundId: round.id,
                  acceptanceId: acceptance.id,
                  status: "suggesting" as const,
                  recommendation: integration.nextRoundDraft,
                  runId: integration.checkRunId,
                },
              }
            : {}),
        });
      this.update("project_flows", currentFlow, {
        currentRoundId: next?.id,
        ...(next || currentFlow.status === "cancelled"
          ? {}
          : { status: "completed" as const, completionReport }),
      });
    });
    await this.logs.afterAcceptance(round.projectId, round.id);
    if (["completed", "cancelled"].includes(this.flow(flow.id).status))
      await this.workbench.finish(flow.id);
  }
  private async suggestNextRound(round: Round) {
    const flow = this.flow(round.flowId),
      confirmation = round.nextConfirmation!,
      previous = this.need<Round>("flow_rounds", confirmation.previousRoundId),
      acceptance = this.need<Acceptance>(
        "flow_acceptances",
        confirmation.acceptanceId,
      ),
      lead = this.lead(round);
    if (confirmation.recommendation) {
      let draft: NextRoundRecommendation | undefined;
      try {
        draft = validateNextRound(
          confirmation.recommendation,
          this.tasks(flow.id).filter((t) => t.roundId === round.id),
          this.store.profile().name,
        );
      } catch {
        this.update("flow_rounds", round, {
          nextConfirmation: { ...confirmation, recommendation: undefined },
        });
      }
      if (draft) {
        this.saveNextSuggestion(round, draft, confirmation.runId);
        return;
      }
    }
    if (
      !this.recoveryOperation("next-round", round.id) &&
      !this.quotaAllows(flow, round, lead, "next-round")
    )
      return;
    const session = this.host.session(
        flow.projectId,
        lead,
        "下一轮确认建议",
        false,
      ),
      op = this.operation(flow, "next-round", round, session.id),
      tasks = this.tasks(flow.id).filter(
        (t) => t.roundId === round.id && t.status !== "cancelled",
      );
    this.store.put("sessions", session.id, { ...session, flowId: flow.id });
    try {
      const result = await this.protocol(
        op,
        "next-round",
        flowPrompt(
          "next-round",
          { mode: "as-planned", summary: "按原计划", taskAdjustments: [] },
          {
            sourceRoundtables: await this.roundtableMaterials(flow, true),
            previousRound: previous,
            acceptedVersion: acceptance.version,
            acceptanceOpinion: acceptance.opinion,
            round,
            tasks,
            instruction:
              "根据已验收的本轮结果，给出下一轮建议。无调整必须 mode=as-planned，summary=按原计划。轻量调整用 adjusted，只可修改尚未开工的现有任务目标、输入和可核对标准，以及本轮可核对标准；任务成员、负责人、路径、依赖、轮次和已开工任务保留。只要方向、范围、分工或依赖有较大变化，就用 replan 并解释，需要用户要求修改方案。只提建议，不执行任何文件任务。",
          },
        ),
        (raw) =>
          validateNextRound(
            raw,
            this.tasks(flow.id).filter((t) => t.roundId === round.id),
            this.store.profile().name,
          ),
      );
      if (!this.validOperation(op, result.runId)) return;
      const latest = this.need<Round>("flow_rounds", round.id);
      if (
        flow.activePlanId !== latest.planId ||
        this.flow(flow.id).activePlanId !== latest.planId ||
        latest.nextConfirmation?.status !== "suggesting" ||
        latest.baseVersion?.fingerprint !== round.baseVersion?.fingerprint
      )
        throw new FlowError(
          "STALE_VERSION",
          "建议到达时下一轮方案或基线已经改变。",
        );
      const decision: Decision = {
        ...this.record(flow.projectId, flow.id),
        kind: "next-round",
        roundId: round.id,
        title: "下一轮确认 · " + round.title,
        reason: result.payload.summary,
        options: [
          "按原计划开始",
          ...(result.payload.mode === "adjusted" ? ["按调整开始"] : []),
          "要求修改方案",
        ],
        eligibleTaskIds: [],
        sourceVersions: [acceptance.version, round.baseVersion!],
        status: "open",
      };
      this.store.transaction(() => {
        this.saveDecision(decision);
        this.update("flow_rounds", latest, {
          nextConfirmation: {
            ...confirmation,
            status: "ready",
            recommendation: result.payload,
            decisionId: decision.id,
            runId: result.runId,
          },
        });
        this.update("flow_operations", op, { state: "done" });
      });
    } catch (error) {
      if (this.supersededOperation(op)) return;
      this.failOperation(op, error);
      this.update("flow_rounds", round, {
        status: this.deferred(error as Error) ? "pending" : "blocked",
      });
      this.blocked(flow.id, error as Error);
    }
  }
  private saveNextSuggestion(
    round: Round,
    recommendation: NextRoundRecommendation,
    runId?: string,
  ) {
    const flow = this.flow(round.flowId),
      confirmation = round.nextConfirmation!,
      acceptance = this.need<Acceptance>(
        "flow_acceptances",
        confirmation.acceptanceId,
      ),
      decision: Decision = {
        ...this.record(flow.projectId, flow.id),
        kind: "next-round",
        roundId: round.id,
        title: "下一轮确认 · " + round.title,
        reason: recommendation.summary,
        options: [
          "按原计划开始",
          ...(recommendation.mode === "adjusted" ? ["按调整开始"] : []),
          "要求修改方案",
        ],
        eligibleTaskIds: [],
        sourceVersions: [acceptance.version, round.baseVersion!],
        status: "open",
      };
    this.store.transaction(() => {
      this.saveDecision(decision);
      this.update("flow_rounds", round, {
        nextConfirmation: {
          ...confirmation,
          status: "ready",
          recommendation,
          decisionId: decision.id,
          runId,
        },
      });
    });
  }
  /** Roundtable conclusions brought back to the project room for this piece of work. Material brought back before an
   * earlier piece ended belongs to that work. fresh: only material no plan or started round of this flow has taken in. */
  private async roundtableMaterials(flow: ProjectFlow, fresh = false) {
    const since = this.store.list<ProjectFlow>("project_flows").filter(f => f.projectId === flow.projectId && f.id !== flow.id && f.createdAt < flow.createdAt && ["completed", "cancelled"].includes(f.status)).map(f => f.updatedAt).sort().at(-1) ?? "";
    const used = fresh ? new Set([...this.store.list<Plan>("flow_plans").filter(p => p.flowId === flow.id), ...this.store.list<Round>("flow_rounds").filter(r => r.flowId === flow.id)].flatMap(r => r.roundtableMessageIds ?? [])) : new Set<string>();
    const messages = this.store.list<RoomMessage>("room_messages").filter(m => m.roomId === `project:${flow.projectId}` && m.author === "user" && m.status === "done" && m.roundtable?.kind === "material" && m.roundtable.conclusionId && m.at > since && !used.has(m.id));
    return messages.map(m => ({sourceRoundtable: {topicId: m.roundtable!.topicId, conclusionId: m.roundtable!.conclusionId!, messageId: m.id}, text: m.text}));
  }
  private async startConfirmedRound(
    decision: Decision,
    p: Record<string, unknown>,
    choice: string,
  ) {
    await this.checkDecisionVersion(decision, p);
    const round = this.need<Round>("flow_rounds", decision.roundId!),
      flow = this.flow(round.flowId),
      confirmation = round.nextConfirmation;
    this.requireIdle(round.id);
    if (
      round.planId !== flow.activePlanId ||
      round.status !== "pending" ||
      confirmation?.status !== "ready" ||
      confirmation.decisionId !== decision.id
    )
      throw new FlowError("STALE_VERSION", "下一轮确认已经失效。");
    if (choice === "要求修改方案") {
      this.prepareReplan(flow);
      const plan = this.need<Plan>("flow_plans", flow.activePlanId!);
      this.launch(() =>
        this.proposed(
          this.flow(flow.id),
          "用户要求根据本轮结果修改方案：" +
            confirmation.recommendation!.summary +
            "\n" +
            String(p.opinion ?? ""),
          plan,
        ),
      );
      return;
    }
    const tasks = this.tasks(flow.id).filter((t) => t.roundId === round.id),
      recommendation = confirmation.recommendation!;
    const adjustments =
      choice === "按调整开始"
        ? validateNextRound(recommendation, tasks, this.store.profile().name)
        : undefined;
    const opinion = text(p.opinion ?? "", true);
    const sourceRoundtables = await this.roundtableMaterials(flow, true);
    if ((opinion || sourceRoundtables.length) && tasks.some(task => !["pending", "ready", "cancelled"].includes(task.status)))
      throw new FlowError("REPLAN_REQUIRED", "本轮已有提前开工的任务。请用要求修改方案处理新附言和圆桌材料，避免把已执行成果当成符合新要求。");
    const patches = tasks.filter(task => ["pending", "ready"].includes(task.status)).map(task => {
      const adjustment = adjustments?.taskAdjustments.find(a => a.taskId === task.id);
      const supplements = opinion ? [...task.supplements ?? [], {
        id: randomUUID(), requestId: decision.id, text: opinion, createdAt: at(), source: "task-card" as const,
        requirementsRevision: requirementsRevision(task) + 1, status: "pending" as const, delivery: "next-turn" as const, requestedPaths: [],
      }] : task.supplements;
      const patch = {
        ...retainSupplementRequirements({...task, supplements}, adjustment?.goal ?? task.goal, adjustment?.completionCriteria ?? task.completionCriteria),
        supplements,
        inputs: [...new Set([...task.inputs, ...adjustment?.inputs ?? [], ...(opinion ? ["用户补充：" + opinion] : []), ...sourceRoundtables.map(source => "已确认圆桌材料（不扩大修改范围）：" + JSON.stringify(source))])],
        requirementsRevision: requirementsRevision(task) + (opinion || adjustment || sourceRoundtables.length ? 1 : 0),
      };
      return {task, patch};
    });
    this.store.transaction(() => {
      for (const { task, patch } of patches)
        this.update("flow_tasks", task, patch);
      this.update("flow_rounds", round, {
        status: "executing",
        startedAt: round.startedAt ?? at(),
        ...(adjustments?.completionCriteria
          ? { completionCriteria: adjustments.completionCriteria }
          : {}),
        nextConfirmation: { ...confirmation, status: "confirmed", choice },
        ...(sourceRoundtables.length ? { roundtableMessageIds: sourceRoundtables.map(m => m.sourceRoundtable.messageId) } : {}),
      });
    });
  }
  private async invalidateEarlyInputs(round: Round, accepted: FlowArtifact) {
    for (const task of this.tasks(round.flowId).filter(
      (t) =>
        t.roundId === round.id &&
        t.earlyDecisionId &&
        t.startBase &&
        !["accepted", "cancelled"].includes(t.status),
    )) {
      const changed = await this.artifacts.changes(
          this.artifacts.get(task.startBase!.artifactId).root,
          accepted.root,
        ),
        scopes = [
          ...task.allowedPaths,
          ...task.dependencies.flatMap(
            (id) => this.need<Task>("flow_tasks", id).allowedPaths,
          ),
        ];
      if (!changed.some((c) => scopes.some((s) => pathWithin(c.path, s))))
        continue;
      const reason = "提前开工所依据的内容在前轮修正后改变，请重新安排并复核。";
      this.store.transaction(() => {
        if (task.latestSubmissionId)
          this.update(
            "flow_submissions",
            this.need<Submission>("flow_submissions", task.latestSubmissionId),
            { status: "stale" },
          );
        for (const review of this.store
          .list<Review>("flow_reviews")
          .filter(
            (r) =>
              r.taskId === task.id && !["stale", "blocked"].includes(r.status),
          ))
          this.update("flow_reviews", review, {
            status: "stale",
            staleReason: reason,
          });
        for (const op of this.store
          .list<FlowOperation>("flow_operations")
          .filter(
            (o) =>
              o.targetId === task.id &&
              ["prepared", "running"].includes(o.state),
          ))
          this.update("flow_operations", op, {
            state: "blocked",
            error: reason,
          });
        this.update("flow_tasks", task, {
          status: "blocked",
          statusBeforeBlock: task.status,
          blockedReason: reason,
          sessionId: undefined,
          executionBase: undefined,
          startBase: undefined,
          earlyDecisionId: undefined,
        });
        this.decision(
          this.flow(task.flowId),
          "replan",
          task,
          "提前成果需要重新安排",
          reason,
        );
      });
    }
  }
  private async earlyCandidates(round: Round) {
    if (!round.requiresUserAcceptance) return;
    const flow = this.flow(round.flowId),
      tasks = this.tasks(flow.id),
      passed = tasks.filter(
        (t) => t.roundId === round.id && finished.has(t.status),
      ),
      next = this.store
        .list<Round>("flow_rounds")
        .find(
          (r) =>
            r.flowId === flow.id &&
            r.planId === round.planId &&
            r.index === round.index + 1,
        );
    if (!next || !passed.length) return;
    const candidates = tasks.filter(
      (t) =>
        t.roundId === next.id &&
        t.status === "pending" &&
        !t.earlyDecisionId &&
        passed.some((p) => p.memberId === t.memberId) &&
        t.dependencies.every((id) =>
          finished.has(this.need<Task>("flow_tasks", id).status),
        ),
    );
    if (!candidates.length) return;
    const existing = this.store
      .list<Decision>("flow_decisions")
      .find(
        (d) =>
          d.flowId === flow.id &&
          d.roundId === round.id &&
          d.kind === "early-start",
      );
    if (existing) {
      if (
        existing.status === "open" &&
        JSON.stringify(existing.eligibleTaskIds) !==
          JSON.stringify(candidates.map((t) => t.id))
      )
        this.update("flow_decisions", existing, {
          eligibleTaskIds: candidates.map((t) => t.id),
          sourceVersions: passed.map(
            (t) =>
              this.need<Submission>("flow_submissions", t.latestSubmissionId!)
                .version,
          ),
        });
      return;
    }
    const decision: Decision = {
      ...this.record(flow.projectId, flow.id),
      kind: "early-start",
      roundId: round.id,
      title: "允许提前进行下一轮吗？",
      reason: "这些成员的当前任务已通过复核，整轮成品尚未验收。",
      options: ["允许提前开工", "等验收后继续"],
      eligibleTaskIds: candidates.map((t) => t.id),
      sourceVersions: passed.map(
        (t) =>
          this.need<Submission>("flow_submissions", t.latestSubmissionId!)
            .version,
      ),
      status: "open",
    };
    this.store.putMany([
      { entity: "flow_decisions", id: decision.id, value: decision },
      projectFlowCardWrite(this.store, "decision", decision)!,
    ]);
  }
  private async answerDecision(decision: Decision, p: Record<string, unknown>) {
    const flow = this.flow(decision.flowId),
      choice = text(p.choice);
    if (!decision.options.includes(choice))
      throw new FlowError("INVALID_REQUEST", "请从当前决策选项中选择。");
    let selected: string[] = [];
    if (decision.additionId) {
      const proposal = this.need<TaskAddition>(
        "flow_task_additions",
        decision.additionId,
      );
      if (
        proposal.status !== "scope-change" ||
        proposal.decisionId !== decision.id
      )
        throw new FlowError("STALE_REVISION", "追加范围决策已失效。");
      if (choice === "确认追加范围") await this.appendAddition(proposal);
      else
        this.update("flow_task_additions", proposal, {
          status: "blocked",
          error: "用户选择不追加。",
        });
      this.update("flow_decisions", decision, {
        status: "answered",
        answer: { choice, taskIds: [], opinion: String(p.opinion ?? "") },
      });
      return;
    }
    if (
      !decision.additionId &&
      decision.kind === "early-start" &&
      choice === "允许提前开工"
    ) {
      selected =
        p.allowAllEligible === true
          ? decision.eligibleTaskIds
          : Array.isArray(p.selectedTaskIds)
            ? p.selectedTaskIds.map(String)
            : [];
      if (
        !selected.length ||
        selected.some((id) => !decision.eligibleTaskIds.includes(id))
      )
        throw new FlowError("INVALID_REQUEST", "请选择卡片中明确列出的任务。");
      const round = this.need<Round>("flow_rounds", decision.roundId!);
      if (round.status === "accepted")
        throw new FlowError("STALE_VERSION", "本轮已验收，提前许可已过期。");
      for (const version of decision.sourceVersions) {
        const sub = this.store
            .list<Submission>("flow_submissions")
            .find((s) => s.version.artifactId === version.artifactId),
          author = sub && this.need<Session>("sessions", sub.sessionId);
        if (
          !sub ||
          sub.status !== "submitted" ||
          (await workspaceFingerprint(
            this.artifacts.get(version.artifactId).root,
          )) !== version.fingerprint ||
          !author?.workspace ||
          (await workspaceFingerprint(author.workspace)) !== version.fingerprint
        )
          throw new FlowError("STALE_VERSION", "许可依据的成果已变化。");
      }
      const base = this.artifacts.get(round.baseVersion!.artifactId),
        early = await this.artifacts.capture(
          flow,
          base.root,
          "task-base",
          base.id,
          base.fingerprint,
        );
      for (const version of decision.sourceVersions)
        if (
          (
            await this.artifacts.merge(
              early.root,
              this.artifacts.get(version.artifactId),
            )
          ).length
        )
          throw new FlowError("SCOPE_CONFLICT", "提前工作依赖成果整合冲突。");
      early.fingerprint = await workspaceFingerprint(early.root);
      this.store.put("flow_artifacts", early.id, early);
      this.check(this.need<Decision>("flow_decisions", decision.id), p);
      if (
        this.need<Decision>("flow_decisions", decision.id).status !== "open" ||
        this.need<Round>("flow_rounds", round.id).status === "accepted"
      )
        throw new FlowError("STALE_VERSION", "创建提前副本期间许可已失效。");
      const eligible = selected.map((id) => this.need<Task>("flow_tasks", id));
      for (const task of eligible)
        if (
          task.status !== "pending" ||
          task.dependencies.some(
            (dep) => !finished.has(this.need<Task>("flow_tasks", dep).status),
          )
        )
          throw new FlowError("DEPENDENCY_BLOCKED", "任务资格已改变。");
      this.store.transaction(() => {
        for (const task of eligible)
          this.update("flow_tasks", task, {
            earlyDecisionId: decision.id,
            startBase: this.artifacts.version(early),
          });
      });
    } else if (decision.kind === "meeting-request") {
      if (choice === "暂停派发")
        this.update("project_flows", flow, { dispatchMode: "paused" });
      else if (choice === "调整方案") {
        this.prepareReplan(flow);
        const parent = this.need<Plan>("flow_plans", flow.activePlanId!);
        this.launch(() =>
          this.proposed(
            this.flow(flow.id),
            decision.reason + "\n用户选择按这项会议要求调整方案。",
            parent,
          ),
        );
      }
    } else if (decision.kind === "scope-change") {
      if (decision.supplementId) {
        const task = this.need<Task>("flow_tasks", decision.taskId!),
          supplement = task.supplements?.find(
            (s) => s.id === decision.supplementId,
          );
        if (!supplement || supplement.status !== "awaiting_scope")
          throw new FlowError("STALE_REVISION", "这项补充的范围决策已失效。");
        if (choice === "调整方案") {
          this.prepareReplan(flow);
          const parent = this.need<Plan>("flow_plans", flow.activePlanId!);
          this.launch(() =>
            this.proposed(
              this.flow(flow.id),
              "用户希望按这项补充调整方案：" +
                supplement.text +
                "\n所提范围：" +
                supplement.requestedPaths.join("、") +
                "。需要起草新方案，等待用户确认后才执行。",
              parent,
            ),
          );
        }
        this.patchSupplement(task.id, supplement.id, {
          status: choice === "调整方案" ? "replanned" : "dismissed",
        });
        if (supplement.sourceMessageId) {
          const round = this.need<Round>("flow_rounds", task.roundId);
          this.update("flow_rounds", round, {
            meetingHandledIds: [
              ...new Set([
                ...(round.meetingHandledIds ?? []),
                supplement.sourceMessageId,
              ]),
            ],
            meetingResponses: [
              ...(round.meetingResponses ?? []),
              {
                messageId: supplement.sourceMessageId,
                disposition: "noted",
                summary:
                  choice === "调整方案"
                    ? "用户选择重新拆解方案，补充要求等待新方案确认。"
                    : "用户选择保持原范围，本次范围外补充未执行。",
                paths: [],
              },
            ],
          });
        }
        this.update("flow_decisions", decision, {
          status: "answered",
          answer: { choice, taskIds: [], opinion: String(p.opinion ?? "") },
        });
        return;
      }
      const task = this.need<Task>("flow_tasks", decision.taskId!),
        sub = this.need<Submission>(
          "flow_submissions",
          task.latestSubmissionId!,
        );
      if (choice === "确认范围调整") {
        const paths = [
          ...new Set([
            ...task.allowedPaths,
            ...sub.outOfScopeChanges.map((c) => c.path),
          ]),
        ];
        assertProjectPaths(this.store, flow.projectId, paths);
        if (
          this.tasks(flow.id).some(
            (t) =>
              t.id !== task.id &&
              ["queued", "running"].includes(t.status) &&
              scopesOverlap(paths, t.allowedPaths),
          )
        )
          throw new FlowError(
            "SCOPE_CONFLICT",
            "新范围与正在执行的任务重叠，请先等待。",
          );
        this.update("flow_tasks", task, {
          allowedPaths: paths,
          status: "awaiting_review",
          blockedReason: undefined,
        });
      } else
        this.update("flow_tasks", task, {
          status: "correcting",
          blockedReason: undefined,
        });
    } else if (decision.kind === "next-round") {
      await this.startConfirmedRound(decision, p, choice);
    } else if (decision.kind === "review-dispute") {
      await this.checkDecisionVersion(decision, p);
      const task = this.need<Task>("flow_tasks", decision.taskId!),
        submission = this.need<Submission>(
          "flow_submissions",
          decision.submissionId!,
        );
      this.requireIdle(task.id);
      if (
        task.status !== "blocked" ||
        task.latestSubmissionId !== submission.id ||
        task.planId !== flow.activePlanId ||
        submission.status !== "submitted"
      )
        throw new FlowError("STALE_VERSION", "异议所针对的提交版本已改变。");
      const rulings =
        choice === "提交逐条裁定"
          ? this.validateDisputeRulings({ rulings: p.rulings }, submission)
          : submission.disputes!.map((d) => ({
              findingId: d.findingId,
              verdict:
                choice === "支持全部异议"
                  ? ("uphold-author" as const)
                  : ("uphold-review" as const),
              reason: String(p.opinion || "用户裁定：" + choice),
            }));
      if (rulings.some((r) => r.verdict === "inconclusive"))
        throw new FlowError(
          "INVALID_REQUEST",
          "逐条裁定请选择支持作者或维持复核；尚未确定可保留此卡片。",
        );
      this.resolveDisputes(task, submission, rulings);
      this.clearDecisionReason(decision);
    } else if (decision.kind === "quota-wait") {
      this.reconcileQuotaWaits(flow);
      const wait = this.need<QuotaWait>(
        "flow_quota_waits",
        decision.quotaWaitId!,
      );
      if (
        wait.status === "resolved" ||
        wait.decisionId !== decision.id ||
        !this.quotaWaitCurrent(wait, flow)
      )
        throw new FlowError("STALE_REVISION", "等待额度的事项已改变。");
      if (choice === "继续等待")
        this.update("flow_quota_waits", wait, {
          status: "waiting",
          startedAt: at(),
          decisionId: undefined,
        });
      else {
        const task = decision.taskId
            ? this.need<Task>("flow_tasks", decision.taskId)
            : undefined,
          round = this.need<Round>("flow_rounds", decision.roundId!);
        this.requireIdle(task?.id ?? round.id);
        if (choice === "交给我裁定" && task)
          this.disputeDecision(
            task,
            this.need<Submission>("flow_submissions", task.latestSubmissionId!),
            "负责人额度尚未恢复，用户选择直接裁定异议。",
          );
        else if (wait.stage === "task" && task)
          this.manualTaskRedo(task, p, decision.id);
        else {
          const memberId = this.selectedMember(
            flow,
            p,
            wait.memberId,
            wait.stage === "review"
              ? task?.memberId
              : wait.stage === "peer-review"
                ? this.lead(round)
                : undefined,
          );
          if (wait.stage === "review" && task)
            this.update("flow_tasks", task, {
              reviewerMemberId: memberId,
              reviewRequested: true,
            });
          else if (wait.stage === "peer-review")
            this.update("flow_rounds", round, {
              peerReviewerMemberId: memberId,
            });
          else if (wait.stage === "requested-check")
            this.update(
              "flow_requested_checks",
              this.need<RequestedRoundCheck>(
                "flow_requested_checks",
                round.requestedCheckId!,
              ),
              { memberId },
            );
          else this.update("flow_rounds", round, { leadMemberId: memberId });
        }
        this.update("flow_quota_waits", wait, { status: "resolved" });
      }
    } else if (decision.kind === "review-choice") {
      const { round, integration } = await this.decisionIntegration(
        decision,
        p,
      );
      if (round.status !== "awaiting_acceptance")
        throw new FlowError("STALE_VERSION", "本轮汇总状态已改变。");
      if (choice === "交给负责人复核") {
        this.requestRoundCheck(round, integration, this.lead(round));
      } else {
        this.update("flow_integrations", integration, { reviewChoice: "user" });
        this.update("flow_rounds", round, {
          requiresUserAcceptance: true,
          manualAcceptance: {
            decisionId: decision.id,
            reason: "用户选择直接进行成品验收。",
          },
        });
      }
    } else if (decision.kind === "unresolved-review") {
      if (decision.taskId) {
        const task = this.need<Task>("flow_tasks", decision.taskId);
        await this.checkDecisionVersion(decision, p);
        this.requireIdle(task.id);
        if (task.status !== "blocked" || task.planId !== flow.activePlanId)
          throw new FlowError("STALE_VERSION", "任务复核决策已经失效。");
        if (choice === "退回补充依据") {
          const redo: ManualRedo = {
            decisionId: decision.id,
            memberId: task.memberId,
            previousMemberId: task.memberId,
            opinion: String(p.opinion ?? decision.reason),
            at: at(),
            status: "pending",
          };
          this.update("flow_tasks", task, {
            status: "correcting",
            manualRedos: [...(task.manualRedos ?? []), redo],
            inputs: [...task.inputs, "用户要求补充依据：" + redo.opinion],
            blockedReason: undefined,
            statusBeforeBlock: undefined,
          });
        } else {
          const reviewer =
            choice === "换人复核"
              ? this.selectedMember(
                  flow,
                  p,
                  task.reviewerMemberId,
                  task.memberId,
                )
              : task.reviewerMemberId;
          this.update("flow_tasks", task, {
            status: "awaiting_review",
            reviewRequested: true,
            reviewerMemberId: reviewer,
            blockedReason: undefined,
            statusBeforeBlock: undefined,
            activeRunId: undefined,
          });
        }
      } else {
        const { round, integration } = await this.decisionIntegration(
          decision,
          p,
        );
        if (round.status !== "blocked")
          throw new FlowError("STALE_VERSION", "整轮复核决策已经失效。");
        if (choice === "我来判断")
          this.update("flow_rounds", round, {
            status: "checking",
            requiresUserAcceptance: true,
            manualAcceptance: {
              decisionId: decision.id,
              reason: decision.reason,
              ownerNote: text(p.opinion ?? "", true),
              source: "user-tested",
            },
          });
        else if (decision.stage === "peer-review") {
          const reviewer =
            choice === "换人复核"
              ? this.selectedMember(
                  flow,
                  p,
                  decision.currentMemberId,
                  this.lead(round),
                )
              : decision.currentMemberId!;
          this.update("flow_integrations", integration, {
            status: "checking",
            peerReview: undefined,
          });
          this.update("flow_rounds", round, {
            status: "checking",
            peerReviewerMemberId: reviewer,
          });
        } else {
          const lead =
            choice === "换负责人检查"
              ? this.selectedMember(flow, p, this.lead(round))
              : this.lead(round);
          this.update("flow_integrations", integration, { status: "checking" });
          this.update("flow_rounds", round, {
            status: "checking",
            leadMemberId: lead,
          });
        }
      }
      this.clearDecisionReason(decision);
    } else if (decision.kind === "replan") {
      if (choice === "暂停")
        this.update("project_flows", flow, { dispatchMode: "paused" });
      else if (decision.stage === "integration-fix") {
        const { round, integration } = await this.decisionIntegration(
            decision,
            p,
          ),
          memberId = this.selectedMember(flow, p, this.lead(round)),
          redo: ManualRedo = {
            decisionId: decision.id,
            memberId,
            previousMemberId: this.lead(round),
            opinion: String(p.opinion ?? decision.reason),
            at: at(),
            status: "pending",
          };
        await this.integrationFix(
          round,
          integration,
          "用户指定本轮新负责人，仅修正当前卡住的整合事项。" + redo.opinion,
          undefined,
          undefined,
          redo,
        );
      } else {
        const task = this.need<Task>("flow_tasks", decision.taskId!);
        await this.checkDecisionVersion(decision, p);
        this.manualTaskRedo(task, p, decision.id);
      }
    }
    this.update("flow_decisions", decision, {
      status: "answered",
      answer: {
        choice,
        taskIds: selected,
        opinion: String(p.opinion ?? ""),
        ...(p.memberId ? { memberId: String(p.memberId) } : {}),
      },
    });
  }
  private selectedMember(
    flow: ProjectFlow,
    p: Record<string, unknown>,
    current?: string,
    author?: string,
  ) {
    const memberId = text(p.memberId);
    if (
      !flow.memberIds.includes(memberId) ||
      memberId === current ||
      memberId === author ||
      !this.host.available(memberId, true)
    )
      throw new FlowError("MEMBER_UNAVAILABLE", "请选择团队中另一名可用成员。");
    return memberId;
  }
  private async reusableTasks(
    plan: Plan,
    base: FlowArtifact,
    taskMap: Map<string, Task>,
    roundMap: Map<string, Round>,
  ) {
    const result: { entity: string; id: string; value: unknown }[] = [],
      candidates = new Map<
        string,
        { old: Task; submission: Submission; review?: Review }
      >();
    if (!plan.parentPlanId) return result;
    for (const spec of plan.tasks.filter((t) => t.reuse)) {
      const old = this.tasks(plan.flowId).find(
          (t) => t.planId === plan.parentPlanId && t.key === spec.reuse,
        ),
        round = roundMap.get(spec.roundKey)!;
      if (
        !old ||
        !["review_passed", "integrated"].includes(old.status) ||
        old.memberId !== spec.memberId ||
        old.goal !== spec.goal ||
        !old.latestSubmissionId ||
        round.index !== 0 ||
        spec.allowedPaths.some(
          (p) => !old.allowedPaths.some((scope) => pathWithin(p, scope)),
        )
      )
        continue;
      const oldRound = this.need<Round>("flow_rounds", old.roundId),
        submission = this.need<Submission>(
          "flow_submissions",
          old.latestSubmissionId,
        ),
        review = this.store
          .list<Review>("flow_reviews")
          .filter(
            (r) => r.submissionId === submission.id && r.status === "passed",
          )
          .at(-1),
        integration = oldRound.integrationId
          ? this.store.get<Integration>(
              "flow_integrations",
              oldRound.integrationId,
            )
          : undefined;
      if (
        oldRound.baseVersion?.fingerprint !== base.fingerprint ||
        submission.status !== "submitted" ||
        submission.outOfScopeChanges.length ||
        submission.changes.some(
          (c) => !spec.allowedPaths.some((p) => pathWithin(c.path, p)),
        )
      )
        continue;
      const verified =
        review?.criteriaResults ??
        (integration?.outcome === "pass"
          ? integration.criteriaResults
          : undefined);
      if (
        !verified ||
        memberCriteria(
          spec.completionCriteria,
          this.store.profile().name,
        ).required.some(
          (c) =>
            !verified.some(
              (r) => r.criterion === c && r.verified && r.evidence.trim(),
            ),
        )
      )
        continue;
      const oldDeps = old.dependencies.map(
        (id) => this.need<Task>("flow_tasks", id).key,
      );
      if (
        spec.dependencies.length !== oldDeps.length ||
        spec.dependencies.some(
          (key) => !oldDeps.includes(taskMap.get(key)?.reuse ?? ""),
        )
      )
        continue;
      if (
        (await workspaceFingerprint(
          this.artifacts.get(submission.version.artifactId).root,
        )) !== submission.version.fingerprint ||
        (await workspaceFingerprint(
          this.need<Session>("sessions", submission.sessionId).workspace!,
        )) !== submission.version.fingerprint
      )
        continue;
      candidates.set(spec.key, { old, submission, review });
    }
    for (let changed = true; changed; ) {
      changed = false;
      for (const [key] of candidates)
        if (
          taskMap.get(key)!.dependencies.some((dep) => !candidates.has(dep))
        ) {
          candidates.delete(key);
          changed = true;
        }
    }
    for (const [key, { old, submission, review }] of candidates) {
      const task = taskMap.get(key)!,
        copied: Submission = {
          ...submission,
          ...this.record(plan.projectId, plan.flowId),
          taskId: task.id,
          sequence: 1,
          requirementsRevision: requirementsRevision(old),
        };
      result.push({ entity: "flow_submissions", id: copied.id, value: copied });
      Object.assign(task, {
        status: review ? "review_passed" : "review_skipped",
        reusedFromTaskId: old.id,
        latestSubmissionId: copied.id,
        sessionId: old.sessionId,
        executionBase: old.executionBase,
        reviewerMemberId: review?.reviewerMemberId ?? old.reviewerMemberId,
        reviewLevelAtSubmission: old.reviewLevelAtSubmission,
        reviewSkipped: review ? undefined : (old.reviewSkipped ?? "configured"),
        returnCount: old.returnCount,
        disputeReturnWaiverCount: Math.max(
          old.disputeReturnWaiverCount ?? 0,
          this.store
            .list<Review>("flow_reviews")
            .filter((r) => r.taskId === old.id && r.returnWaivedBySubmissionId)
            .length,
        ),
        rearrangeCount: old.rearrangeCount,
        manualRedos: old.manualRedos,
        requirementsRevision: requirementsRevision(old),
        supplements: old.supplements,
        goal: old.goal,
      });
      if (review) {
        const copiedReview: Review = {
          ...review,
          ...this.record(plan.projectId, plan.flowId),
          taskId: task.id,
          submissionId: copied.id,
        };
        result.push({
          entity: "flow_reviews",
          id: copiedReview.id,
          value: copiedReview,
        });
      }
    }
    return result;
  }
  private requireIdle(targetId: string) {
    const round = this.store.get<Round>("flow_rounds", targetId);
    if (
      this.busyTargets.has(targetId) ||
      (round?.integrationId && this.busyTargets.has(round.integrationId)) ||
      this.store
        .list<FlowOperation>("flow_operations")
        .some(
          (o) =>
            (o.targetId === targetId ||
              o.targetId === round?.integrationId ||
              o.targetId === round?.requestedCheckId) &&
            ["prepared", "running", "blocked"].includes(o.state),
        )
    )
      throw new FlowError(
        "TASK_ACTIVE",
        "先等待在途操作结束，或核对阻塞运行。",
      );
  }
  private async checkDecisionVersion(
    decision: Decision,
    p: Record<string, unknown>,
  ) {
    for (const version of decision.sourceVersions)
      if (
        (await workspaceFingerprint(
          this.artifacts.get(version.artifactId).root,
        )) !== version.fingerprint
      )
        throw new FlowError("STALE_VERSION", "决策依据的成果版本已改变。");
    this.check(this.need<Decision>("flow_decisions", decision.id), p);
    if (this.need<Decision>("flow_decisions", decision.id).status !== "open")
      throw new FlowError("STALE_VERSION", "决策已经失效。");
  }
  private async decisionIntegration(
    decision: Decision,
    p: Record<string, unknown>,
  ) {
    await this.checkDecisionVersion(decision, p);
    const round = this.need<Round>("flow_rounds", decision.roundId!),
      integration = this.need<Integration>(
        "flow_integrations",
        decision.integrationId!,
      );
    this.requireIdle(round.id);
    if (
      round.planId !== this.flow(round.flowId).activePlanId ||
      round.integrationId !== integration.id
    )
      throw new FlowError("STALE_VERSION", "请选择当前轮的整合成果。");
    return { round, integration };
  }
  private clearDecisionReason(decision: Decision) {
    const flow = this.flow(decision.flowId);
    this.update("project_flows", flow, {
      blockedReasons: flow.blockedReasons.filter(
        (reason) => reason !== decision.reason,
      ),
    });
  }
  private manualTaskRedo(
    task: Task,
    p: Record<string, unknown>,
    decisionId: string,
  ) {
    const flow = this.flow(task.flowId);
    this.requireIdle(task.id);
    if (
      !["pending", "ready", "correcting", "blocked", "escalated"].includes(
        task.status,
      ) ||
      task.planId !== flow.activePlanId ||
      flow.status !== "active"
    )
      throw new FlowError(
        "STALE_VERSION",
        "只能重做当前方案中尚未通过的任务。",
      );
    const memberId = this.selectedMember(flow, p, task.memberId),
      lead = this.lead(task),
      redo: ManualRedo = {
        decisionId,
        memberId,
        previousMemberId: task.memberId,
        opinion: String(p.opinion ?? ""),
        at: at(),
        status: "pending",
      };
    this.update("flow_tasks", task, {
      memberId,
      sessionId: undefined,
      activeRunId: undefined,
      reviewerMemberId:
        memberId === task.reviewerMemberId
          ? this.reviewer(flow, memberId)
          : task.reviewerMemberId,
      status: "pending",
      blockedReason: undefined,
      statusBeforeBlock: undefined,
      manualRedos: [...(task.manualRedos ?? []), redo],
      inputs: [
        ...task.inputs,
        ...(redo.opinion ? ["用户重做要求：" + redo.opinion] : []),
      ],
    });
    for (const decision of this.store
      .list<Decision>("flow_decisions")
      .filter((d) => d.taskId === task.id && d.status === "open")) {
      this.clearDecisionReason(decision);
      if (decision.id !== decisionId)
        this.update("flow_decisions", decision, {
          status: "answered",
          answer: {
            choice: "重新安排",
            taskIds: [],
            memberId,
            opinion: redo.opinion,
          },
        });
    }
  }
  private replanBlock(flow: ProjectFlow) {
    if (["completed", "cancelled"].includes(flow.status))
      return new FlowError("STALE_REVISION", "流程已经结束。");
    if (
      this.store
        .list<FlowOperation>("flow_operations")
        .some(
          (o) =>
            o.flowId === flow.id && ["prepared", "running"].includes(o.state),
        ) ||
      this.tasks(flow.id).some((t) => this.busyTargets.has(t.id)) ||
      this.store
        .list<Round>("flow_rounds")
        .some((r) => r.flowId === flow.id && this.busyTargets.has(r.id))
    )
      return new FlowError(
        "TASK_ACTIVE",
        "先停止或等待在途任务结束，再调整方案。",
      );
    if (
      this.store
        .list<Run>("runs")
        .some(
          (r) =>
            r.projectId === flow.projectId &&
            r.flowOperationId &&
            r.status === "unknown" &&
            this.store.get<FlowOperation>("flow_operations", r.flowOperationId)
              ?.state !== "done",
        )
    )
      return new FlowError(
        "UNKNOWN_RESULT",
        "先核对并处理未知运行，再调整方案。",
      );
    if (
      this.store
        .list<Acceptance>("flow_acceptances")
        .some(
          (a) =>
            a.flowId === flow.id &&
            ["requested", "applying", "recovery_required"].includes(a.status),
        )
    )
      return new FlowError(
        "RECOVERY_REQUIRED",
        "先核对未完成的成品写入，再调整方案。",
      );
  }
  private prepareReplan(flow: ProjectFlow) {
    const block = this.replanBlock(flow);
    if (block) throw block;
    this.update("project_flows", flow, {
      status: "planning",
      dispatchMode: "running",
    });
  }
  activity(event: TimelineEvent) {
    const run = this.store.get<Run>("runs", event.runId);
    if (!run?.flowOperationId || !["status", "tool"].includes(event.kind))
      return;
    const op = this.store.get<FlowOperation>(
        "flow_operations",
        run.flowOperationId,
      ),
      task =
        op &&
        op.state === "running" &&
        this.store.get<Task>("flow_tasks", op.targetId);
    if (task)
      this.update("flow_tasks", task, {
        lastActivity: {
          text: event.text.replace(/\s+/g, " ").slice(0, 240),
          at: event.at,
        },
        activeRunId: run.id,
        ...(op?.kind === "task" &&
        task.status === "queued" &&
        run.status === "running"
          ? { status: "running" as const }
          : {}),
      });
  }
  private withActions<T extends FlowRecord>(entity: string, item: T) {
    return this.view.withActions(entity, item);
  }
  snapshot(projectId: string) {
    return this.view.snapshot(projectId);
  }
  overviews() {
    return this.view.overviews();
  }
  async close() {
    this.closed = true;
    clearInterval(this.quotaTimer);
    this.pauseAll();
    await Promise.allSettled([
      ...this.jobs,
      ...this.requests.values(),
      this.joint.close(),
    ]);
  }
}
