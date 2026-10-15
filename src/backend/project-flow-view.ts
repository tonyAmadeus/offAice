import type { Store } from "./store";
import { SUPPLEMENTABLE } from "./project-flow-supplements";
import {
  roundLead,
  roundReviewLevel,
  QUOTA_STAGE_LABELS,
  type FlowRecord,
  type ProjectFlow,
  type Plan,
  type Round,
  type Task,
  type Decision,
  type FlowOperation,
  type Acceptance,
  type AllowedAction,
  type Submission,
  type Integration,
  type FlowStage,
  type ProjectFlowSnapshot,
  type QuotaWait,
  type Review,
  type RequestedRoundCheck,
  type ReviewLevel,
  FlowError,
} from "../shared/project-flow";
import type { TaskAddition } from "../shared/project-workbench";
import type { JointReview } from "../shared/joint-review";
const finished = new Set([
  "review_passed",
  "review_skipped",
  "integrated",
  "accepted",
]);
interface Host {
  busyTargets: Set<string>;
  flow(id: string): ProjectFlow;
  need<T>(entity: string, id: string): T;
  taskLevel(task: Task): ReviewLevel;
  pendingScope(roundId: string): boolean;
  replanBlock(flow: ProjectFlow): FlowError | undefined;
  retryable(flow: ProjectFlow): Task[];
  jointReviews(
    projectId: string,
    before: undefined,
    limit: number,
  ): JointReview[];
}
/** Read-only actions and stage summaries; dispatch and mutation stay in the controller. */
export class ProjectFlowView {
  constructor(
    private store: Store,
    private host: Host,
  ) {}
  withActions<T extends FlowRecord>(
    entity: string,
    item: T,
  ): T & { allowedActions: AllowedAction[] } {
    if (
      entity === "flow_operations" &&
      (item as unknown as FlowOperation).jointReviewId
    )
      return { ...item, allowedActions: [] };
    const flow = this.host.flow(item.flowId),
      ongoing = !["completed", "cancelled"].includes(flow.status),
      current =
        ongoing && (!("planId" in item) || item.planId === flow.activePlanId);
    let allowedActions: AllowedAction[] = [];
    if (entity === "flow_tasks") {
      const task = item as unknown as Task,
        held = this.store
          .list<FlowOperation>("flow_operations")
          .some(
            (o) =>
              o.targetId === task.id &&
              ["prepared", "running", "blocked"].includes(o.state),
          );
      allowedActions = [
        {
          name: "projectFlow.task.reassign",
          enabled:
            current &&
            !held &&
            !this.host.busyTargets.has(task.id) &&
            ["pending", "ready", "correcting", "blocked", "escalated"].includes(
              task.status,
            ) &&
            !(
              task.status === "pending" &&
              task.manualRedos?.at(-1)?.status === "pending"
            ),
          reason:
            "换人只重做当前任务一次，保留历史计数；先核对在途或未知运行。",
        },
        {
          name: "projectFlow.task.supplement",
          enabled:
            current &&
            flow.status === "active" &&
            SUPPLEMENTABLE.has(task.status) &&
            !task.supplements?.some((s) =>
              ["delivering", "unknown", "awaiting_scope"].includes(s.status),
            ),
          reason: finished.has(task.status)
            ? "已完成的任务请追加为新任务。"
            : "补充只修改当前任务；先处理未知投递或范围决策。",
        },
      ];
    }
    if (entity === "flow_rounds") {
      const round = item as unknown as Round,
        acceptance = round.acceptanceId
          ? this.store.get<Acceptance>("flow_acceptances", round.acceptanceId)
          : undefined,
        enabled =
          current &&
          flow.status === "active" &&
          round.status === "awaiting_acceptance" &&
          round.requiresUserAcceptance &&
          !this.host.busyTargets.has(round.id) &&
          !["applying", "requested", "recovery_required"].includes(
            acceptance?.status ?? "",
          ),
        pending =
          this.host.pendingScope(round.id) ||
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
            );
      allowedActions = [
        {
          name: "projectFlow.round.requestCheck",
          enabled: enabled && !pending,
          reason: "检查完成后仍由你决定通过或驳回。",
        },
        {
          name: "projectFlow.round.accept",
          enabled: enabled && !pending,
          reason: pending
            ? "先处理会议要求或补充范围的决策，再验收成品。"
            : "需要当前成品等待验收，且上一项写入已核对。",
        },
        {
          name: "projectFlow.round.requestChanges",
          enabled: enabled && !pending,
          reason: "先核对当前验收写入和补充范围，才能提出修改。",
        },
      ];
    }
    if (entity === "flow_plans") {
      const plan = item as unknown as Plan,
        active = ongoing && flow.activePlanId === plan.id,
        block = this.host.replanBlock(flow);
      allowedActions = [
        {
          name: "projectFlow.plan.confirm",
          enabled:
            active &&
            flow.status === "awaiting_plan" &&
            plan.status === "awaiting_confirmation",
          reason: "只能确认当前待确认方案。",
        },
        {
          name: "projectFlow.plan.revise",
          enabled:
            active &&
            ["awaiting_confirmation", "confirmed"].includes(plan.status) &&
            !block,
          reason: block?.message ?? "修改当前项目的方案，其他项目可继续工作。",
        },
      ];
    }
    if (entity === "flow_decisions") {
      const decision = item as unknown as Decision,
        round = decision.roundId
          ? this.store.get<Round>("flow_rounds", decision.roundId)
          : undefined;
      allowedActions = [
        {
          name: "projectFlow.decision.answer",
          enabled:
            ongoing &&
            decision.status === "open" &&
            !this.host.busyTargets.has(
              decision.taskId ?? decision.roundId ?? "",
            ) &&
            (!decision.integrationId ||
              round?.integrationId === decision.integrationId),
          reason: "先等待当前操作结束；决策只适用于当前成果版本。",
        },
      ];
    }
    if (entity === "flow_acceptances")
      allowedActions = [
        {
          name: "projectFlow.acceptance.recover",
          enabled:
            (item as unknown as Acceptance).status === "recovery_required" &&
            !this.host.busyTargets.has((item as unknown as Acceptance).roundId),
          reason: "仅中断的验收写入需要核对。",
        },
      ];
    if (entity === "flow_operations")
      allowedActions = [
        {
          name: "projectFlow.unknown.resolve",
          enabled: (item as unknown as FlowOperation).state === "blocked",
          reason: "只核对阻塞的操作，不自动重发。",
        },
      ];
    if (entity === "flow_submissions" || entity === "flow_integrations")
      allowedActions = [
        "projectFlow.artifact.files",
        "projectFlow.artifact.read",
        "projectFlow.artifact.diff",
      ].map((name) => ({
        name,
        enabled: Boolean((item as unknown as Submission | Integration).version),
        reason: "只有已捕获的成果可预览。",
      }));
    return { ...item, allowedActions };
  }
  private currentStage(
    flow: ProjectFlow | null,
    round: Round | undefined,
    tasks: Task[],
    decisions: Decision[],
  ): FlowStage {
    const base = {
        roundId: round?.id,
        leadMemberId: flow ? roundLead(flow, round) : undefined,
      },
      stage = (kind: FlowStage["kind"], label: string): FlowStage => ({
        ...base,
        kind,
        label,
      });
    if (!flow) return stage("idle", "尚未启动");
    if (["completed", "cancelled"].includes(flow.status))
      return stage(
        "completed",
        flow.status === "completed" ? "已完成" : "已取消",
      );
    const decision = decisions.find(
      (d) =>
        d.status === "open" &&
        d.roundId === round?.id &&
        [
          "unresolved-review",
          "replan",
          "review-choice",
          "review-dispute",
          "next-round",
          "quota-wait",
        ].includes(d.kind),
    );
    if (decision)
      return stage(
        "decision",
        decision.kind === "next-round"
          ? "等待下一轮确认"
          : decision.kind === "quota-wait"
            ? "等待选择继续等额度或换人"
            : decision.kind === "review-dispute"
              ? "等待你裁定复核异议"
              : decision.kind === "review-choice"
                ? "等待选择复核或验收"
                : "等待处理复核或重做决策",
      );
    if (flow.dispatchMode !== "running") return stage("paused", "派发已暂停");
    if (["planning", "awaiting_plan"].includes(flow.status))
      return stage(
        "planning",
        flow.status === "planning" ? "正在拆解方案" : "等待确认方案",
      );
    if (round?.status === "awaiting_acceptance")
      return stage("acceptance", "等待成品验收");
    if (round?.status === "blocked") return stage("blocked", "流程已阻塞");
    const wait = this.store
      .list<QuotaWait>("flow_quota_waits")
      .find((w) => w.flowId === flow.id && w.status !== "resolved");
    if (wait)
      return stage(
        "quota",
        "等待 " +
          (this.store.members().find((m) => m.id === wait.memberId)?.name ??
            wait.memberId) +
          " 额度恢复 · " +
          QUOTA_STAGE_LABELS[wait.stage],
      );
    if (
      round?.nextConfirmation &&
      round.nextConfirmation.status !== "confirmed"
    )
      return stage("reporting", "负责人正在提出下一轮建议");
    const ops = this.store
      .list<FlowOperation>("flow_operations")
      .filter(
        (o) =>
          o.flowId === flow.id && ["prepared", "running"].includes(o.state),
      );
    if (ops.some((o) => o.kind === "peer-review"))
      return stage("peer-review", "正在由其他成员复核整轮成果");
    if (ops.some((o) => o.kind === "round-report"))
      return stage("reporting", "负责人正在汇总汇报");
    if (round?.status === "checking")
      return stage("checking", "负责人正在检查整轮成果");
    if (round?.status === "integrating")
      return stage("integrating", "正在整合本轮成果");
    if (
      tasks.some(
        (t) => t.roundId === round?.id && t.status === "awaiting_review",
      )
    )
      return stage("reviewing", "正在复核个人任务");
    return stage("executing", "正在执行本轮任务");
  }
  snapshot(projectId: string): ProjectFlowSnapshot {
    const flow =
      this.store
        .list<ProjectFlow>("project_flows")
        .filter((f) => f.projectId === projectId)
        .at(-1) ?? null;
    const list = <T extends FlowRecord>(entity: string): T[] =>
      flow
        ? this.store.list<T>(entity).filter((t) => t.flowId === flow.id)
        : [];
    const tasks = list<Task>("flow_tasks").map((t) => ({
        ...this.withActions("flow_tasks", t),
        effectiveReviewLevel: this.host.taskLevel(t),
      })),
      rounds = list<Round>("flow_rounds").map((r) => ({
        ...this.withActions("flow_rounds", r),
        effectiveReviewLevel:
          (r.integrationId
            ? this.store.get<Integration>("flow_integrations", r.integrationId)
                ?.reviewLevel
            : undefined) ?? roundReviewLevel(flow!, r),
      })),
      decisions = list<Decision>("flow_decisions").map((d) =>
        this.withActions("flow_decisions", d),
      ),
      current = rounds.find((r) => r.id === flow?.currentRoundId);
    const storedPlan = flow?.activePlanId
        ? this.host.need<Plan>("flow_plans", flow.activePlanId)
        : null,
      plan = storedPlan ? this.withActions("flow_plans", storedPlan) : null;
    const plans = list<Plan>("flow_plans")
      .sort((a, b) => a.version - b.version)
      .map(
        ({
          id,
          projectId,
          flowId,
          revision,
          version,
          parentPlanId,
          status,
          objective,
          scope,
          deliverables,
          createdAt,
          updatedAt,
          rounds,
          tasks,
        }) => ({
          id,
          projectId,
          flowId,
          revision,
          version,
          parentPlanId,
          status,
          objective,
          scope,
          deliverables,
          createdAt,
          updatedAt,
          roundCount: rounds.length,
          taskCount: tasks.length,
        }),
      );
    const submissions = list<Submission>("flow_submissions").map((s) => ({
        ...this.withActions("flow_submissions", s),
        changedFileCount: s.changes.length,
        evidenceCount: s.evidence.length,
        outOfScopeCount: s.outOfScopeChanges.length,
      })),
      reviews = list<Review>("flow_reviews").map((r) => ({
        ...this.withActions("flow_reviews", r),
        findingCounts: Object.fromEntries(
          [
            "verified",
            "suspected",
            "suggestion",
            "blocking",
            "should-fix",
            "optional",
          ].map((key) => [
            key,
            r.findings.filter((f) => f.kind === key || f.severity === key)
              .length,
          ]),
        ),
      })),
      integrations = list<Integration>("flow_integrations").map((i) => ({
        ...this.withActions("flow_integrations", i),
        conflictCount: i.conflicts.length,
        checkSummary: i.checkEvidence.map((e) => e.result).join("；"),
      })),
      acceptances = list<Acceptance>("flow_acceptances").map((a) =>
        this.withActions("flow_acceptances", a),
      );
    const ongoing = flow && !["completed", "cancelled"].includes(flow.status),
      quotaWaits = list<QuotaWait>("flow_quota_waits").filter(
        (w) => w.status !== "resolved" && ongoing,
      ),
      taskAdditions = list<TaskAddition>("flow_task_additions").filter(
        (p) =>
          ongoing &&
          p.planId === flow.activePlanId &&
          ["preparing", "ready", "blocked"].includes(p.status),
      );
    const jointReviews = this.host.jointReviews(projectId, undefined, 100),
      blockedOperations = list<FlowOperation>("flow_operations")
        .filter((o) => o.state === "blocked" && o.recovery !== "completed")
        .map((o) => this.withActions("flow_operations", o));
    return {
      projectId,
      revision:
        (flow?.revision ?? 0) +
        jointReviews.reduce((sum, r) => sum + r.revision, 0) +
        taskAdditions.reduce((sum, p) => sum + p.revision, 0),
      flow,
      plan,
      plans,
      rounds,
      tasks,
      submissions,
      reviews,
      integrations,
      acceptances,
      decisions,
      quotaWaits,
      taskAdditions,
      requestedChecks: list<RequestedRoundCheck>("flow_requested_checks"),
      jointReviews,
      blockedOperations,
      overview: {
        stage: this.currentStage(flow, current, tasks, decisions),
        working: tasks.filter((t) => t.status === "running").length,
        remaining: tasks.filter(
          (t) =>
            t.roundId === current?.id &&
            !finished.has(t.status) &&
            t.status !== "cancelled",
        ).length,
        needsUser: ongoing
          ? Number(flow.status === "awaiting_plan") +
            decisions.filter((d) => d.status === "open").length +
            taskAdditions.filter(
              (p) => p.status === "ready" || p.status === "blocked",
            ).length +
            rounds.filter(
              (r) =>
                r.planId === flow.activePlanId &&
                r.status === "awaiting_acceptance" &&
                r.requiresUserAcceptance,
            ).length +
            // A paused task or check waits for the user just like a decision does.
            blockedOperations.filter((o) => !o.jointReviewId).length
          : 0,
      },
      allowedActions: ongoing
        ? [
            { name: "projectFlow.review.configure", enabled: true },
            {
              name: "projectFlow.pause",
              enabled: flow.dispatchMode === "running",
            },
            {
              name: "projectFlow.resume",
              enabled:
                (flow.dispatchMode !== "running" ||
                  flow.blockedReasons.length > 0 ||
                  this.host.retryable(flow).length > 0) &&
                !decisions.some(
                  (d) =>
                    d.status === "open" &&
                    ["unresolved-review", "replan", "review-dispute"].includes(
                      d.kind,
                    ),
                ) &&
                !this.store
                  .list<FlowOperation>("flow_operations")
                  .some(
                    (o) =>
                      o.flowId === flow.id &&
                      o.state === "blocked" &&
                      o.recovery !== "completed",
                  ),
              reason: flow.blockedReasons.join("；"),
            },
            { name: "projectFlow.cancel", enabled: true },
          ]
        : [{ name: "projectFlow.start", enabled: true }],
    };
  }
  overviews() {
    return this.store
      .list<ProjectFlow>("project_flows")
      .filter((f) => !["completed", "cancelled"].includes(f.status))
      .map((f) => {
        const snapshot = this.snapshot(f.projectId);
        return {
          projectId: f.projectId,
          flowId: f.id,
          revision: snapshot.revision,
          status: f.status,
          dispatchMode: f.dispatchMode,
          ...snapshot.overview,
        };
      });
  }
}
