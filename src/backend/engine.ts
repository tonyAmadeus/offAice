import { formatCorrectionSummary } from "./format-corrections";
import { executeRun, type RunExecutionActive } from './run-execution';
import {logoutProvider} from './provider-logout';
import { discussionCallLimits } from "../shared/discussion-budget";
import { memberPermissions, normalizeMemberPermissions } from "../shared/permissions";
import { EngineBackups } from "./engine-backups";
import { LegacyCollaborations } from "./engine-collaborations";
import { ComposerDrafts } from "./composer-drafts";
import { ensurePortableNode } from "./portable-node";
import {
  newCompatibility,
  withCompatibility,
  currentIdentity,
  confirmProgram,
  observeAccount,
  readProgramIdentity,
  setProgramFingerprintStore,
  type ProgramFingerprintStore,
} from "./compatibility";
import {
  CATALOG_REVISION,
  catalogEntry,
  catalogProvider,
} from "../shared/executor-catalog";
import {
  catalogStatuses,
  catalogCandidate,
  catalogAuthentication,
  assertCatalogVersionUnused,
} from "./executor-catalog";
import { nodeRuntimeInfo } from "./node-runtime";
import type {
  CompatibilityReport,
  ExecutorIdentity,
} from "../shared/compatibility";
import type {
  MemberVersions,
  MemberVersionUse,
  MemberInstallation,
} from "../shared/member-versions";
import {
  memberVersionUseKey,
  sameMemberProgram,
} from "./member-version-status";
import { resolveCliEntry } from "./adapters/common";
import { RoundResultReader } from "./round-results";
import {
  normalizeConfigSelection,
  requestedConfig,
  type RequestedRunConfig,
} from "../shared/executor-config";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync, unlinkSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  Attachment,
  AcpExecutor,
  AcpExecutorId,
  Adapter,
  AdapterContext,
  MemberPermissions,
  MemberQuota,
  Approval,
  Collaboration,
  MemberProfile,
  Project,
  ProviderId,
  ProviderInfo,
  PushEvent,
  RoomMessage,
  RoomState,
  RoomSummary,
  RoomThread,
  Run,
  Session,
  Settings,
  TimelineEvent,
  UserProfile,
} from "../shared/types";
import {
  mergeQuota,
  quotaPreference,
  quotaReport,
  quotaAt100,
} from "../shared/quota";
import {
  ROOM_REACTIONS,
  isRoomPass,
  reactionText,
  roomMarkdown,
  toggleReaction,
} from "../shared/room";
import {
  ACP_DEFAULT_PERMISSIONS,
  BUILTIN_MEMBERS,
  DEFAULT_SETTINGS,
  PROVIDER_NAMES,
  SECRET_PLACEHOLDER,
  isAcpId,
  isSecretName,
  normalizeExecutor,
  normalizeMember,
  normalizePermissions,
  automaticWorkSettings,
  personaInstructions,
  rememberExecutors,
} from "../shared/defaults";
import { AcpAdapter } from "./adapters/acp";
import { ZcodeAdapter } from "./adapters/zcode";
import type { CatalogLoginState } from "../shared/executor-catalog";
import { Store } from "./store";
import { RoomDiscussionController } from "./room-discussion";
import { RoomContexts } from "./room-contexts";
import type { RoomId } from "../shared/types";
import { buildEnvironment, redact, registerSecret } from "./security";
import {
  MEMBER_PACKAGES,
  VERIFIED_VERSIONS,
  installVersion,
  installedVersions,
  isVerified,
  latestVersion,
  versionOfPath,
  removeVersion,
} from "./member-versions";
import {
  failureMessage,
  isConnectionFailure,
} from "./adapter-failure";
import {
  workspaceFingerprint,
  listArtifacts,
  readArtifact,
  diffWorkspace,
  applyWorkspace,
  discardWorkspace,
} from "./workspace";
import { checkNetwork } from "./network";
import { disposeOwned, stopOwned } from "./process-supervisor";
import { CodexAdapter } from "./adapters/codex";
import { ClaudeAdapter, invalidateClaudeChecks } from "./adapters/claude";
import { DshAdapter, resolveDshEntry } from "./adapters/dsh";
import { DeepseekAdapter } from "./adapters/deepseek";
import {
  fileStamp,
  RoomRuntimePool,
} from "./runtime-pool";
import {
  checkpointInfo,
  undoCheckpoint,
  removeCheckpoint,
} from "./workspace-checkpoint";
import { AutomationScheduler, type TimedResult } from "./automation-scheduler";
import type {
  AutomaticOrigin,
  TimedAction,
  TimedJob,
  TimedOccurrence,
} from "../shared/automation";
import {
  AUTOMATIC_FEATURES,
  AUTOMATION_PAUSE_FILE,
  localParts,
  policiesOf,
  validateDailyLife,
} from "../shared/automation";
import { AutomaticBudget, AutomaticDenied } from "./automatic-budget";
import { memoryCandidates, memorySources } from "./desktop-memory";
import {
  attachmentPath,
  describeAttachments,
  importAttachments,
  resolveAttachments,
  withoutPath,
} from "./attachments";
import { EngineAttachments } from "./engine-attachments";
import { collectAttention, dismissAttention } from "./attention";
import { GENERATED_IMAGES_MAX, storeGeneratedImage } from "./generated-images";
import { IMAGE_SEND_MAX } from "../shared/attachments";
import { memoryEntries, newMemoryId } from "../shared/memory";
import {
  DailyLife,
  memberChatPrompt,
  openingPrompt,
  rotateMembers,
} from "./daily-life";
import { BackupRestorer } from "./backup-restore";
import { writeBackup } from "./backup-writer";
import type { BackupReason } from "../shared/backup";
import { ProjectFlowController } from "./project-flow";
import {
  migrateFlowCards,
  migrateRoundReports,
  publishFlowCards,
  publishRoundReports,
} from "./project-room-reports";
import {
  markRoomRead,
  roomTaskStatus,
  workingRoomMember,
} from "./project-flow-room";
import {
  claudeOAuthTokenConfigured,
  claudeApiKeyConfigured,
} from "./adapters/claude";
import type { FlowOperation, ProjectFlow } from "../shared/project-flow";
import { PROJECT_FLOW_READS } from "../shared/project-flow";
import type { LogReceipt } from "../shared/work-log";
import { MemberWorkspaces } from "./member-workspaces";
import { isPersonalRoom } from "../shared/member-workspaces";
import { Roundtables } from "./roundtable";
import { ROUNDTABLE_READS, ROUNDTABLE_WRITES } from "../shared/roundtable";
import { JOINT_READS, JOINT_WRITES } from "../shared/joint-review";
import { ProjectTree } from "./project-tree";
import {
  assertProjectSerial,
  assertProjectPaths,
  withProjectWrite,
  markProjectRemoving,
  captureProjectBoundary,
} from "./project-access";
import { projectUndoInfo, undoWriteback } from "./workspace-writeback";

const now = () => new Date().toISOString();
const UNAVAILABLE_OPERATION = "这个操作当前不可用，请刷新工作台后重试。";
/** Which domain handler owns each method prefix. */
const INVOKE_DOMAINS: Record<string, "rooms" | "members" | "work" | "automation" | "data"> = {
  room: "rooms", projectRoom: "rooms", desk: "rooms", report: "rooms", memory: "rooms", attachment: "rooms", attention: "rooms",
  member: "members", catalog: "members", provider: "members", executor: "members", team: "members", persona: "members", profile: "members", network: "members",
  project: "work", session: "work", run: "work", approval: "work", all: "work", workspace: "work", artifact: "work", collaboration: "work",
  automation: "automation",
  snapshot: "data", settings: "data", backup: "data", diagnostics: "data", internal: "data",
};
const ROOM_BUSY_SKIP =
  "聊天室还在讨论、已被你暂停或有结果待核对，本次自动发言已跳过。";
/** Idempotency receipts are replayed within moments; older ones only grow the database. */
const RECEIPT_RETENTION = {
  roundtable_requests: 300,
  flow_requests: 300,
  personal_read_tokens: 500,
  format_corrections: 1000,
};
// The DeepSeek API stand-in is retired now that DSH runs on its own account; old records still render.
const ids: ProviderId[] = ["codex", "claude", "dsh"];
const RUN_STATUS_TEXT: Partial<Record<Run["status"], string>> = {
  failed: "没能完成",
  unknown: "状态待核对",
  interrupted: "运行中断",
  rate_limited: "额度受限",
  stopped: "已停止",
};
const terminal = new Set([
  "stopped",
  "ended",
  "completed",
  "interrupted",
  "unknown",
  "failed",
]);
const bounded = (
  value: unknown,
  min: number,
  max: number,
  fallback: number,
) => {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.max(min, Math.min(Math.floor(number), max))
    : fallback;
};
type Active = RunExecutionActive;
export class Engine {
  readonly store: Store;
  private fingerprints?: ProgramFingerprintStore;
  readonly bootId = randomUUID();
  settings: Settings;
  private attachments: EngineAttachments;
  private rooms: RoomContexts;
  private get roomId() {
    return this.rooms.id;
  }
  private get roomStore() {
    return this.rooms.get().store;
  }
  private get discussion() {
    return this.rooms.get().discussion;
  }
  private get roomRunning() {
    return this.rooms.get().running;
  }
  private set roomRunning(value: Promise<void> | undefined) {
    this.rooms.get().running = value;
  }
  private get roomStopping() {
    return this.rooms.get().stopping;
  }
  private set roomStopping(value: boolean) {
    this.rooms.get().stopping = value;
  }
  private get roomChanging() {
    return this.rooms.get().changing;
  }
  private set roomChanging(value: boolean) {
    this.rooms.get().changing = value;
  }
  private providers: ProviderInfo[] = [];
  private active = new Map<string, Active>();
  private approvals = new Map<
    string,
    {
      resolve: (v: { choice: string; answers?: unknown }) => void;
      reject: (e: Error) => void;
    }
  >();
  private buffers = new Map<
    string,
    {
      ctx: AdapterContext;
      kind: "delta" | "reasoning";
      text: string;
      data?: unknown;
      fidelity: TimelineEvent["fidelity"];
      timer: NodeJS.Timeout;
    }
  >();
  private legacyCollaborations: LegacyCollaborations;
  private alive = true;
  private key?: string;
  private executions = new Set<Promise<void>>();
  private flowTasks = new Set<Promise<void>>();
  private closing?: Promise<void>;
  private closed = false;
  private probeRevisions = new Map<ProviderId, number>();
  private loginChecks = new Set<Promise<unknown>>();
  private probeRetries = new Map<ProviderId, NodeJS.Timeout>();
  private deferredProbeRetries = new Map<ProviderId, number>();
  private providerChecks = new Map<string, Promise<ProviderInfo>>();
  private balanceRevision = 0;
  private balanceCheck?: {
    key: string;
    task: Promise<MemberQuota | undefined>;
  };
  private quotaChecks = new Map<
    ProviderId,
    { key: string; task: Promise<MemberQuota | undefined> }
  >();
  private dailyLife: DailyLife;
  private lifeRunning = false;
  private memberOperations = new Set<string>();
  private removingExecutors = new Set<string>();
  private memberInstallations = new Map<string, MemberInstallation>();
  private acpLogins = new Set<string>();
  private executorLoginStates = new Map<string, CatalogLoginState>();
  private executorLoginAdapters = new Map<string, AcpAdapter | ZcodeAdapter>();
  /** Connected programs' secret variables: decrypted by the main process and held only in memory here. */
  private acpSecrets = new Map<string, Record<string, string>>();
  private roomContextInputs = new Map<
    string,
    (canRemember: boolean, refreshRules?: boolean) => string
  >();
  private roomContextAttachments = new Map<string, () => Attachment[]>();
  private roomStartChecks = new Map<string, () => boolean>();
  private roomRuntimes = new RoomRuntimePool();
  private workspaceOperations = new Set<string>();
  private automation: AutomationScheduler;
  private automaticBudget: AutomaticBudget;
  private maintenance = false;
  private maintenanceWasPaused = true;
  private backups: EngineBackups;
  private projectFlow: ProjectFlowController;
  private memberWorkspaces: MemberWorkspaces;
  private roundtables: Roundtables;
  /** Publish accumulated changes once per event-loop turn; facts are still persisted immediately. */
  private snapshotTimer?: NodeJS.Immediate;
  private removingProjects = new Set<string>();
  private projectTree: ProjectTree;
  constructor(
    dataDirectory: string,
    private push: (event: PushEvent) => void,
    private owned: (child: import("node:child_process").ChildProcess) => void,
    private factory?: (id: ProviderId) => Adapter,
    private timing?: {
      runBudgetMs?: number;
      roomRuntimeReuse?: boolean;
      runtimeIdleMs?: number;
      runtimeLimit?: number;
      roomReplyIdleMs?: number;
      providerRetryMs?: number;
      automationNow?: () => number;
      automationTickMs?: number;
      maintenanceOnly?: boolean;
    },
    private memberInstaller: typeof installVersion = installVersion,
    private backupWriter: typeof writeBackup = writeBackup,
  ) {
    this.roomRuntimes = new RoomRuntimePool({
      idleMs: timing?.runtimeIdleMs,
      limit: timing?.runtimeLimit,
    });
    this.store = new Store(dataDirectory);
    // Replay protection only needs recent request IDs; then reclaim the space deleted records left behind.
    this.store.retainNewest(RECEIPT_RETENTION);
    this.store.compact();
    this.fingerprints = {
      get: (file) => this.store.get("program_fingerprints", file),
      put: (file, value) => this.store.put("program_fingerprints", file, value),
    };
    setProgramFingerprintStore(this.fingerprints);
    this.backups = new EngineBackups(
      dataDirectory,
      (directory, reason) => this.backupWriter(directory, reason),
      {
        maintenance: () => this.maintenance,
        begin: () => this.beginDataMaintenance(),
        end: () => this.endDataMaintenance(),
      },
    );
    this.legacyCollaborations = new LegacyCollaborations(this.store, () => this.broadcast());
    this.attachments = new EngineAttachments(this.store, (provider) =>
      this.acceptsImages(provider),
    );
    const saved = this.store.get<Settings>("settings", "main");
    this.projectTree = new ProjectTree(this.store, (id) =>
      this.removingProjects.has(id),
    );
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...saved,
      paths: { ...saved?.paths },
      models: { ...saved?.models },
      efforts: { ...saved?.efforts },
    };
    // Older installations used the local Node by default. Preserve that working runtime on upgrade.
    if (
      saved &&
      saved.nodeRuntime === undefined &&
      nodeRuntimeInfo({ ...this.settings, nodeRuntime: "local" }).source ===
        "local"
    )
      this.settings.nodeRuntime = "local";
    // The owner explicitly chose automatic work. Upgrade old profiles once, retaining an exact backup.
    if (saved && typeof saved.defaultAutoApprove !== "boolean") {
      if (!this.store.get("settings_backups", "before-automatic-work"))
        this.store.put("settings_backups", "before-automatic-work", saved);
      this.settings = automaticWorkSettings(this.settings);
    }
    this.settings.maxRunMinutes = bounded(
      this.settings.maxRunMinutes,
      1,
      1440,
      DEFAULT_SETTINGS.maxRunMinutes,
    );
    this.settings.deepseekMaxRequests = bounded(
      this.settings.deepseekMaxRequests,
      1,
      200,
      DEFAULT_SETTINGS.deepseekMaxRequests,
    );
    this.settings.permissions = normalizePermissions(this.settings.permissions);
    this.settings.memberPermissions = normalizeMemberPermissions(this.settings.memberPermissions);
    this.settings.defaultAutoApprove =
      typeof this.settings.defaultAutoApprove === "boolean"
        ? this.settings.defaultAutoApprove
        : DEFAULT_SETTINGS.defaultAutoApprove;
    this.store.put("settings", "main", this.settings);
    this.store.recover(this.bootId);
    const pauseFile = path.join(
      this.store.dataDirectory,
      AUTOMATION_PAUSE_FILE,
    );
    if (existsSync(pauseFile)) {
      this.store.put("automation_state", "main", { paused: true, at: now() });
      try {
        unlinkSync(pauseFile);
      } catch {
        /* Retain the marker and remain paused. */
      }
    }
    this.automaticBudget = new AutomaticBudget(
      this.store,
      () => this.settings.automationPolicies,
      {
        now: timing?.automationNow,
        quotaAllows: (provider, model) =>
          quotaPreference(this.memberQuota(provider), Date.now(), model) > 0,
      },
    );
    rememberExecutors(this.store.executors());
    // Files attached long ago but never sent, or left behind by deletions, are swept at start.
    this.releaseAttachments();
    // Sessions created since character cards got "<member> 对话" titles the list never replaced; mark them as generated.
    for (const session of this.store.list<Session>("sessions"))
      if (
        session.autoTitle === undefined &&
        session.title === `${this.memberFor(session).name} 对话`
      )
        this.store.put("sessions", session.id, { ...session, autoTitle: true });
    this.providers = this.store
      .list<ProviderInfo>("providers")
      .filter((info) => this.executorIds().includes(info.id))
      .map((info) => ({ ...info, stale: true }));
    for (const event of this.store.liveEvents())
      if (!this.store.get("quotas", event.provider))
        this.rememberQuota(event.provider, event.data, event.at, "event");
    for (const info of this.providers)
      if (!this.store.get("quotas", info.id) && info.quota)
        this.rememberQuota(
          info.id,
          info.quota,
          info.quotaCheckedAt ?? info.checkedAt ?? now(),
          "probe",
        );
    this.rooms = new RoomContexts(this.store, (id, store) =>
      this.createRoomDiscussion(id, store),
    );
    this.automation = new AutomationScheduler(
      this.store,
      {
        changed: () => this.broadcast(),
        run: (job, item) =>
          this.rooms.run("global", () => this.timedAction(job, item)),
      },
      { now: timing?.automationNow, tickMs: timing?.automationTickMs },
    );
    this.automation.system("聊天室空闲程序回收", 1, {
      kind: "local-event",
      event: "runtime-reap",
    });
    this.dailyLife = new DailyLife(
      this.store,
      this.automation,
      () => this.settings,
      () => this.automationNow(),
    );
    this.dailyLife.sync();
    if (!timing?.maintenanceOnly) this.automation.start();
    this.projectFlow = new ProjectFlowController(this.store, {
      alive: () =>
        this.alive && !this.maintenance && !this.timing?.maintenanceOnly,
      changed: () => {
        publishRoundReports(this.store);
        publishFlowCards(this.store);
        this.broadcast();
      },
      maxParallel: () => this.settings.maxParallel,
      available: (memberId, write) => {
        const member = this.store.members().find((m) => m.id === memberId),
          info = member && this.providers.find((p) => p.id === member.executor);
        return Boolean(
          member && info?.available && (!write || info.capabilities.write),
        );
      },
      quotaAllows: (memberId, model) => this.flowQuotaAllows(memberId, model),
      quota100: (memberId, model) => {
        const member = this.store.members().find((m) => m.id === memberId);
        return Boolean(
          member &&
            quotaAt100(
              this.memberQuota(member.executor),
              Date.now(),
              model ?? (member.model || this.settings.models[member.executor]),
            ),
        );
      },
      session: (projectId, memberId, title, write) => {
        const member = this.store.members().find((m) => m.id === memberId)!;
        return this.createSession(
          projectId,
          member.executor,
          title,
          write,
          memberId,
          write ? "flow-task" : "flow-plan",
        );
      },
      configuration: (projectId, memberId) =>
        this.projectConfiguration(
          this.require<Project>("projects", projectId),
          memberId,
        ),
      run: async (sessionId, prompt, operationId, attachments) => {
        const sent = (await this.send(
          sessionId,
          prompt,
          "message",
          undefined,
          attachments ?? [],
          false,
          operationId,
        )) as { runId: string };
        const result = await this.waitForReply(sent.runId, sessionId);
        while (this.active.has(sent.runId))
          await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          runId: sent.runId,
          status: this.require<Run>("runs", sent.runId).status,
          text: result.text,
        };
      },
      steer: (runId, prompt, deliveryId) =>
        this.steerActive(runId, prompt, deliveryId),
      roundtableSource: (ref, projectId) =>
        this.roundtables.sourceForPlan(ref, projectId),
      stop: (runId) => this.stopRun(runId),
      report: () => {
        publishRoundReports(this.store);
        this.broadcast();
      },
    });
    this.roundtables = new Roundtables(
      this.store,
      this.projectFlow.joint,
      this.projectFlow.artifacts,
      {
        changed: () => this.broadcast(),
        discuss: async (topic, material) =>
          this.rooms.run(topic.roomId, async () => {
            await this.discussion.input({
              text: material,
              materialContext: true,
              memberIds: [
                ...new Set([
                  ...topic.memberIds,
                  ...(topic.authorMemberId ? [topic.authorMemberId] : []),
                ]),
              ],
              style: "work",
              maxMinutes: 0,
              handRaise: topic.handRaise,
              hostPick: topic.hostPick,
              attachments: topic.material.attachments,
            });
            return this.roomStore.roomState().discussion!.id;
          }),
        stop: async (id) =>
          this.rooms.run(id, async () => {
            const running = this.roomRunning;
            await this.roomStop();
            await running;
          }),
        removeSession: (id) =>
          this.deleteSession(id, false, { broadcast: false }),
        handoff: async (
          projectId,
          as,
          messageId,
          topic,
          material,
          memberId,
        ) => {
          if (as === "plan")
            return this.projectFlow.invoke("projectFlow.start", {
              requestId: "roundtable-plan:" + messageId,
              projectId,
              leadMemberId: topic.leadMemberId,
              memberIds: [...new Set([...topic.memberIds, topic.leadMemberId])],
              topic: "依据圆桌「" + topic.title + "」的选定稿与结论起草新方案",
              sourceRoundtable: {
                topicId: topic.id,
                conclusionId: topic.conclusion!.id,
                messageId,
              },
            });
          const flow = this.store
            .list<ProjectFlow>("project_flows")
            .findLast(
              (f) => f.projectId === projectId && f.status === "active",
            );
          if (!flow)
            throw new Error(
              "目标项目尚无已确认的活动方案；请带回为材料，或选择新方案。",
            );
          return this.projectFlow.invoke("projectFlow.task.prepare", {
            requestId: "roundtable-task:" + messageId,
            flowId: flow.id,
            expectedRevision: flow.revision,
            memberId: memberId ?? topic.leadMemberId,
            title: "采用圆桌选定稿：" + topic.title,
            goal:
              material.slice(0, 17000) +
              (material.length > 17000
                ? "\n（文字预览已截断，完整材料保存在来源消息中，未提供的部分仍待核对。）"
                : ""),
            sourceMessageId: messageId,
            sourceRoundtable: {
              topicId: topic.id,
              conclusionId: topic.conclusion!.id,
              messageId,
            },
          });
        },
      },
    );
    migrateRoundReports(this.store);
    migrateFlowCards(this.store);
    this.memberWorkspaces = new MemberWorkspaces(this.store, {
      createSession: (projectId, member, title, write) =>
        this.createSession(projectId, member.executor, title, write, member.id),
      send: (sessionId, text, attachments) =>
        this.send(sessionId, text, "message", undefined, attachments),
      reply: (roomId, member, prompt, attachments, onRun, shouldStart) =>
        this.rooms.run(roomId, async () => {
          const session = await this.loungeSession(member, "room-mention");
          if (!this.alive || !shouldStart())
            return { text: "", status: "stopped" };
          this.roomStartChecks.set(session.id, shouldStart);
          try {
            const sent = (await this.send(
              session.id,
              prompt,
              "message",
              undefined,
              attachments,
            )) as { runId: string };
            onRun(sent.runId);
            if (!shouldStart()) await this.stopRun(sent.runId);
            const result = await this.waitForReply(sent.runId, session.id);
            return { ...result, status: result.status ?? "failed" };
          } finally {
            if (this.roomStartChecks.get(session.id) === shouldStart)
              this.roomStartChecks.delete(session.id);
          }
        }),
      stop: (runId) => this.stopRun(runId),
      removeSession: (sessionId) => this.deleteSession(sessionId, false),
      resetSession: async (sessionId) => {
        this.assertSessionUsable(this.require<Session>("sessions", sessionId));
        this.requireIdle(sessionId, "整理话题");
        await this.roomRuntimes.closeSession(sessionId);
        const session = this.require<Session>("sessions", sessionId);
        this.store.put("sessions", sessionId, {
          ...session,
          nativeId: undefined,
          nativeHome: undefined,
          revision: session.revision + 1,
        });
        return { reset: true };
      },
      changed: () => this.broadcast(),
      track: (task) => {
        this.flowTasks.add(task as Promise<void>);
        void task.finally(() => this.flowTasks.delete(task as Promise<void>));
      },
    });
  }
  private createRoomDiscussion(roomId: RoomId, store: Store) {
    return new RoomDiscussionController(store, {
      callLimits: () => this.settings.discussionCallLimits,
      alive: () => this.alive,
      busy: () =>
        Boolean(
          this.rooms.get(roomId).running || this.rooms.get(roomId).changing,
        ),
      changed: () => this.broadcast(),
      working: (memberId) => workingRoomMember(this.store, roomId, memberId),
      taskStatus: (memberId) => roomTaskStatus(this.store, roomId, memberId),
      read: (memberId, ids) => markRoomRead(this.store, roomId, memberId, ids),
      available: (member) =>
        this.providers.some((p) => p.id === member.executor && p.available),
      quotaPreference: (memberId) => {
        const member = this.store
          .members()
          .find((member) => member.id === memberId);
        return member
          ? quotaPreference(
              this.memberQuota(member.executor),
              Date.now(),
              member.model || this.settings.models[member.executor],
            )
          : 1;
      },
      launch: (flow) =>
        this.rooms.run(roomId, () => this.launchDiscussion(flow)),
      interrupt: () => this.rooms.run(roomId, () => this.roomStop()),
      pausePendingHands: () =>
        this.rooms.run(roomId, () => this.pausePendingHands()),
      cancelHands: () => this.rooms.run(roomId, () => this.cancelHands()),
      attachments: (member, messages) => this.roomAttachments(member, messages),
      minutesInstruction: () =>
        this.roundtables?.minutesInstruction(roomId) ?? "",
      minutesMember: () => {
        if (!roomId.startsWith("project:")) return;
        const data = this.projectFlow.snapshot(roomId.slice(8));
        return data.overview.stage?.leadMemberId ?? data.flow?.leadMemberId;
      },
      projectFiles: () => this.projectRoomDirectory(roomId),
      interruptAndWait: () =>
        this.rooms.run(roomId, async () => {
          const running = this.roomRunning;
          await this.roomStop(true);
          await running;
        }),
      warning: (runId, text) => {
        const run = this.store.get<Run>("runs", runId),
          session = run && this.store.get<Session>("sessions", run.sessionId);
        if (run && session)
          this.writeEvent(
            this.context(run, session),
            "warning",
            text,
            undefined,
            "derived",
          );
      },
      turn: (member, prompt, onRun, options) =>
        this.rooms.run(roomId, async () => {
          const session = await this.loungeSession(
            member,
            options?.mention
              ? "room-mention"
              : options?.hand
                ? "room-hand"
                : options?.summary
                  ? "room-minutes"
                  : undefined,
          );
          if (
            this.roomStopping ||
            !this.alive ||
            options?.shouldStart?.() === false
          )
            return { text: "", status: "stopped" as const };
          if (options?.freshPrompt)
            this.roomContextInputs.set(session.id, options.freshPrompt);
          if (options?.attachments)
            this.roomContextAttachments.set(session.id, options.attachments);
          if (options?.shouldStart)
            this.roomStartChecks.set(session.id, options.shouldStart);
          try {
            const discussionId = store.roomState().discussion?.id;
            const sent = (await this.send(
              session.id,
              prompt,
              "message",
              undefined,
              options?.attachments?.() ?? [],
            )) as { runId: string };
            const receipt = this.store.get<Run>("runs", sent.runId);
            if (receipt && discussionId)
              this.store.put("runs", receipt.id, {
                ...receipt,
                origin: {
                  ...receipt.origin,
                  discussionId,
                  callKind: options?.callKind ?? "normal",
                },
              });
            onRun(sent.runId);
            const result = await this.waitForReply(sent.runId, session.id),
              run = this.store.get<Run>("runs", sent.runId);
            const connectionFailure =
                run?.status === "failed" &&
                isConnectionFailure(run.error ?? ""),
              retryableConnection =
                connectionFailure && run?.delivery === "prepared";
            if (retryableConnection)
              this.writeEvent(
                this.context(run!, session),
                "warning",
                "这条消息尚未发出，会议讨论可重试一次连接。",
                undefined,
                "derived",
              );
            return {
              ...result,
              unknown: run?.status === "unknown" || run?.delivery === "unknown",
              limited:
                run?.status === "rate_limited" ||
                run?.stopReason === "rate_limited",
              retryableConnection,
              connectionFailure,
            };
          } finally {
            if (this.roomContextInputs.get(session.id) === options?.freshPrompt)
              this.roomContextInputs.delete(session.id);
            if (
              this.roomContextAttachments.get(session.id) ===
              options?.attachments
            )
              this.roomContextAttachments.delete(session.id);
            if (this.roomStartChecks.get(session.id) === options?.shouldStart)
              this.roomStartChecks.delete(session.id);
          }
        }),
    });
  }
  setKey(key?: string) {
    if (key) registerSecret(key);
    this.key = key;
    this.broadcast();
  }
  setAcpSecrets(all: Record<string, Record<string, string>> = {}) {
    for (const [id, secrets] of Object.entries(all)) {
      if (!isAcpId(id)) continue;
      for (const value of Object.values(secrets)) registerSecret(value);
      this.acpSecrets.set(id, { ...secrets });
    }
  }
  private withSecrets(executor: AcpExecutor): AcpExecutor {
    const secrets = this.acpSecrets.get(executor.id);
    return secrets
      ? { ...executor, env: { ...executor.env, ...secrets } }
      : executor;
  }
  private quotaAccountStamp(provider: ProviderId) {
    const home =
      provider === "claude"
        ? process.env.AIROOM_CLAUDE_HOME
        : provider === "codex"
          ? process.env.AIROOM_CODEX_HOME
          : undefined;
    const account =
      provider === "dsh"
        ? [process.env.AIROOM_DSH_HOME ?? "", this.settings.dshProfile]
        : home
          ? fileStamp(
              path.join(
                home,
                provider === "claude" ? ".credentials.json" : "auth.json",
              ),
            )
          : null;
    return createHash("sha256")
      .update(
        JSON.stringify([
          provider,
          this.settings.paths[provider] ?? "",
          account,
        ]),
      )
      .digest("hex");
  }
  private memberQuota(provider: ProviderId) {
    const saved = this.store.get<MemberQuota>("quotas", provider);
    return saved && saved.accountStamp === this.quotaAccountStamp(provider)
      ? saved
      : undefined;
  }
  private flowQuotaAllows(memberId: string, model?: string) {
    const member = this.store.members().find((m) => m.id === memberId);
    return Boolean(
      member &&
        quotaPreference(
          this.memberQuota(member.executor),
          Date.now(),
          model ?? (member.model || this.settings.models[member.executor]),
        ) > 0,
    );
  }
  private rememberQuota(
    provider: ProviderId,
    data: unknown,
    checkedAt: string,
    source: MemberQuota["source"],
  ) {
    const report = quotaReport(provider, data, checkedAt, source);
    if (!report) return false;
    this.store.put("quotas", provider, {
      ...mergeQuota(this.memberQuota(provider), report),
      accountStamp: this.quotaAccountStamp(provider),
    });
    if (this.projectFlow) {
      this.projectFlow.kick();
      void this.schedule();
    }
    return true;
  }
  private async refreshBalance() {
    if (!this.alive) return;
    if (this.memberOperations.has("dsh"))
      throw new Error("DeepSeek 程序正在更新，请稍后刷新余额。");
    const settings = this.settings,
      revision = this.balanceRevision;
    const key = JSON.stringify([
      revision,
      this.quotaAccountStamp("dsh"),
      settings.networkMode,
      settings.proxyUrl,
    ]);
    if (this.balanceCheck?.key === key) return this.balanceCheck.task;
    const task = (async () => {
      let balance;
      try {
        balance = await this.adapter("dsh").accountBalance?.(
          settings,
          buildEnvironment(settings),
        );
      } catch {
        /* Balance availability never changes connectivity. */
      }
      if (!this.alive) return;
      if (revision !== this.balanceRevision || settings !== this.settings)
        return this.memberQuota("dsh");
      this.rememberQuota(
        "dsh",
        { accountBalance: balance },
        balance?.checkedAt ?? now(),
        "probe",
      );
      this.broadcast();
      if (balance?.signedOut) {
        this.loginLost("dsh");
        await this.probe("dsh").catch(() => {});
      }
      return this.memberQuota("dsh");
    })();
    this.balanceCheck = { key, task };
    try {
      return await task;
    } finally {
      if (this.balanceCheck?.task === task) this.balanceCheck = undefined;
    }
  }
  private async refreshQuota(provider: "codex" | "claude") {
    if (!this.alive) return;
    if (this.memberOperations.has(provider))
      throw new Error(
        `${PROVIDER_NAMES[provider]} 程序正在更新，请稍后刷新额度。`,
      );
    const settings = this.settings,
      revision = this.probeRevisions.get(provider) ?? 0,
      accountStamp = this.quotaAccountStamp(provider);
    const key = JSON.stringify([
      revision,
      accountStamp,
      settings.networkMode,
      settings.proxyUrl,
    ]);
    if (this.quotaChecks.get(provider)?.key === key)
      return this.quotaChecks.get(provider)!.task;
    const task = (async () => {
      let result;
      try {
        result = await this.adapter(provider).accountQuota?.(
          settings,
          buildEnvironment(settings),
        );
      } catch {}
      if (!this.alive) return;
      if (
        settings !== this.settings ||
        revision !== (this.probeRevisions.get(provider) ?? 0) ||
        (provider === "codex" &&
          accountStamp !== this.quotaAccountStamp(provider))
      )
        return this.memberQuota(provider);
      this.rememberQuota(
        provider,
        result?.payload ??
          (provider === "codex"
            ? { accountRateLimits: undefined }
            : { accountUsage: undefined }),
        result?.checkedAt ?? now(),
        "probe",
      );
      this.broadcast();
      // The login is gone: check the connection again so the member shows it needs a login.
      if (result?.signedOut) {
        this.loginLost(provider);
        if (provider === "claude") await this.probe(provider).catch(() => {});
      }
      return this.memberQuota(provider);
    })();
    this.quotaChecks.set(provider, { key, task });
    try {
      return await task;
    } finally {
      if (this.quotaChecks.get(provider)?.task === task)
        this.quotaChecks.delete(provider);
    }
  }
  private attention() {
    return collectAttention(
      this.store,
      this.providers,
      new Set(this.approvals.keys()),
    );
  }
  snapshot() {
    return this.store.readScope(() => this.snapshotFacts());
  }
  private snapshotFacts() {
    const failed = this.store
        .list<LogReceipt>("flow_log_receipts")
        .filter((r) => r.state === "failed"),
      base = this.store.snapshot({
        providers: this.providers,
        settings: this.settings,
        backendReady: true,
        deepseekKeyConfigured: !!this.key,
      });
    return {
      ...base,
      removedProviders: ids.filter(id => !!this.store.get('removed_providers', id)),
      rooms: [
        ...(base.rooms ?? []),
        ...(this.memberWorkspaces?.overviews() ?? []),
      ],
      workLogFailures: failed
        .filter(
          (r, index) =>
            failed.findIndex(
              (other) =>
                other.roundId === r.roundId && other.projectId === r.projectId,
            ) === index,
        )
        .map((r) => ({ projectId: r.projectId, roundId: r.roundId })),
      claudeTokenConfigured: claudeOAuthTokenConfigured(),
      claudeApiKeyConfigured: claudeApiKeyConfigured(),
      projectFlows: this.projectFlow?.overviews() ?? [],
      jointReviews: this.projectFlow?.joint.overviews() ?? [],
      roundtable: this.roundtables?.snapshot(),
      attention: this.attention(),
      automation: this.automation
        ? {
            ...this.automation.snapshot(),
            policies: policiesOf(this.settings.automationPolicies),
            usage: this.automaticBudget.snapshot(),
          }
        : undefined,
      quotas: Object.fromEntries(
        this.executorIds().flatMap((id) => {
          const quota = this.memberQuota(id);
          return quota ? [[id, quota]] : [];
        }),
      ),
    };
  }
  private timedJob(params: any) {
    const action = params.action as TimedAction;
    if (
      !action ||
      !["notice", "local-event", "member-message"].includes(action.kind)
    )
      throw new Error("定时动作无效。");
    if (action.kind === "notice" || action.kind === "member-message") {
      if (
        typeof action.text !== "string" ||
        !action.text.trim() ||
        action.text.length > 4000
      )
        throw new Error("定时内容应为 1–4000 字。");
      if (
        action.threadId &&
        !this.roomStore.get<RoomThread>("room_threads", action.threadId)
      )
        throw new Error("指定的话题已删除。");
    }
    if (
      action.kind === "member-message" &&
      (!this.store.members().some((member) => member.id === action.memberId) ||
        !Object.hasOwn(AUTOMATIC_FEATURES, action.feature))
    )
      throw new Error("请选择有效成员和自动功能类别。");
    if (
      action.kind === "local-event" &&
      (typeof action.event !== "string" ||
        !action.event.trim() ||
        action.event.length > 100)
    )
      throw new Error("本地事件名称无效。");
    if (
      action.kind === "member-message" &&
      (typeof action.threadId !== "string" || !action.threadId)
    )
      throw new Error("定时发言需要指定话题。");
    return this.automation.save({ ...params, action });
  }
  private async timedAction(
    job: TimedJob,
    item: TimedOccurrence,
  ): Promise<TimedResult> {
    if (!this.alive || !this.automation.current(item))
      return { status: "skipped", reason: "任务已暂停或工作台正在退出。" };
    if (job.action.kind === "local-event") {
      if (job.system && job.action.event === "runtime-reap")
        await this.roomRuntimes.reapIdle();
      else {
        this.store.put("timed_events", item.id, {
          ...job.action,
          jobId: job.id,
          occurrenceId: item.id,
          at: now(),
          status: "done",
        });
        this.store.pruneHistory("timed_events", 200);
      }
      return { status: "done" };
    }
    if (
      job.action.kind === "daily-opening" ||
      job.action.kind === "member-chat"
    )
      return this.lifeSpeech(job, item);
    if (job.action.kind === "member-message")
      return this.automaticSpeech(job, item);
    const thread = job.action.threadId
      ? this.roomStore.get<RoomThread>("room_threads", job.action.threadId)
      : this.roomStore.currentRoomThread();
    if (!thread || thread.archivedAt)
      return { status: "skipped", reason: "话题已删除或归档。" };
    this.roomMessage({
      id: `timed-${item.id}`,
      author: "system",
      threadId: thread.id,
      system: true,
      at: now(),
      text: `定时提醒 · ${job.name}\n${job.action.text}`,
      scheduled: { jobId: job.id, occurrenceId: item.id },
    });
    return { status: "done" };
  }
  private automaticAllowed(
    origin: AutomaticOrigin,
    provider: ProviderId,
    model?: string,
  ) {
    const item = this.store.get<TimedOccurrence>(
        "timed_occurrences",
        origin.occurrenceId,
      ),
      job = item && this.store.get<TimedJob>("timed_jobs", origin.jobId);
    if (
      !item ||
      item.status !== "running" ||
      item.jobId !== origin.jobId ||
      !job ||
      !this.automation.current(item)
    )
      throw new AutomaticDenied("自动任务已暂停、删除或设置已改变。");
    let memberId: string | undefined, threadId: string | undefined;
    if (job.action.kind === "member-message") {
      if (job.action.feature !== origin.feature)
        throw new AutomaticDenied("自动功能类别已改变。");
      memberId = job.action.memberId;
      threadId = job.action.threadId;
    } else if (
      job.managed === origin.feature &&
      (job.action.kind === "daily-opening" ||
        job.action.kind === "member-chat") &&
      job.action.kind === origin.feature
    ) {
      const parent =
          item.parentOccurrenceId &&
          this.store.get<TimedOccurrence>(
            "timed_occurrences",
            item.parentOccurrenceId,
          ),
        step = item.step;
      if (
        !parent ||
        parent.status !== "running" ||
        parent.jobId !== job.id ||
        parent.jobRevision !== item.jobRevision ||
        step === undefined ||
        parent.memberIds?.[step] !== item.memberId ||
        parent.memberStamps?.[step] !==
          this.lifeMemberStamp(
            this.store.members().find((member) => member.id === item.memberId),
          )
      )
        throw new AutomaticDenied("本次自动发言的轮次或成员资料已改变。");
      if (!this.dailyLife.visible || this.roomStopping)
        throw new AutomaticDenied("窗口已隐藏或本次发言已停止。");
      if (
        job.action.kind === "daily-opening" &&
        job.action.day !== localParts(this.automationNow()).day
      )
        throw new AutomaticDenied("每日开场已错过当天，未补发。");
      memberId = item.memberId;
      threadId = parent.threadId;
    } else throw new AutomaticDenied("自动任务来源无效。");
    if (
      this.store.members().find((member) => member.id === memberId)
        ?.executor !== provider
    )
      throw new AutomaticDenied("自动任务的成员设置已改变。");
    if (threadId !== this.roomStore.currentRoomThread().id)
      throw new AutomaticDenied("话题已切换，未向其他话题发言。");
    const reason = this.automaticBudget.reason(origin.feature, provider, model);
    if (reason) throw new AutomaticDenied(reason);
  }
  private automationNow() {
    return this.timing?.automationNow?.() ?? Date.now();
  }
  private lifeMemberStamp(member?: MemberProfile) {
    return member
      ? createHash("sha256").update(JSON.stringify(member)).digest("hex")
      : undefined;
  }
  /** An automatic speech waits for the room; it never interrupts a discussion, a pause or an unchecked result. */
  private roomBusyForAutomation(previous: RoomState) {
    return Boolean(
      this.roomRunning ||
        this.roomChanging ||
        previous.active ||
        (previous.discussion && previous.discussion.phase !== "idle"),
    );
  }
  /** Holds the room for one automatic task, then restores the state it had before. */
  private holdRoomFor(task: Promise<unknown>, previous: RoomState, life = false) {
    const lifecycle = task
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        if (this.roomRunning === lifecycle) {
          this.roomRunning = undefined;
          if (life) this.lifeRunning = false;
          if (!this.closed)
            this.setRoomState({
              ...previous,
              active: false,
              speaking: undefined,
            });
        }
        this.flowTasks.delete(lifecycle);
      });
    this.roomRunning = lifecycle;
    this.flowTasks.add(lifecycle);
  }
  /** One automatic room reply: send, show it speaking, wait, and settle the message. An unknown result is never resent. */
  private async speakAutomatically(params: {
    member: MemberProfile;
    sessionId: string;
    prompt: string;
    origin: AutomaticOrigin;
    messageId: string;
    threadId: string;
    afterSend?: () => void;
  }): Promise<{ outcome: TimedResult; run?: Run; text?: string }> {
    let runId: string | undefined;
    try {
      const sent = (await this.send(
        params.sessionId,
        params.prompt,
        "message",
        params.origin,
      )) as { runId: string };
      runId = sent.runId;
      params.afterSend?.();
      const message: RoomMessage = {
        id: params.messageId,
        author: params.member.id,
        authorName: params.member.name,
        threadId: params.threadId,
        runId,
        text: "",
        at: now(),
        status: "speaking",
        automatic: params.origin,
      };
      this.roomMessage(message);
      const reply = await this.waitForReply(runId, params.sessionId),
        run = this.store.get<Run>("runs", runId)!;
      const unknown = run.status === "unknown" || run.delivery === "unknown";
      this.roomMessage({
        ...message,
        ...reply,
        ...(unknown
          ? {
              text: "",
              status: "failed" as const,
              error: "本次自动发言结果待核对，未自动重发。",
            }
          : {}),
        automatic: run.automatic,
      });
      return {
        run,
        text: reply.text,
        outcome: {
          status: unknown
            ? "unknown"
            : reply.status === "done"
              ? "done"
              : run.delivery === "withdrawn" || reply.status === "stopped"
                ? "skipped"
                : "failed",
          reason: reply.error || run.error,
          runId,
        },
      };
    } catch (error) {
      return {
        outcome: {
          status: error instanceof AutomaticDenied ? "skipped" : "failed",
          reason: (error as Error).message,
          runId,
        },
      };
    }
  }
  private async lifeSpeech(
    job: TimedJob,
    item: TimedOccurrence,
  ): Promise<TimedResult> {
    if (!job.managed || job.action.kind !== job.managed)
      return { status: "skipped", reason: "内置自动任务来源无效。" };
    // The first window can appear before startup account checks finish. Wait for those read-only checks.
    await Promise.allSettled([...this.providerChecks.values()]);
    const previous = this.roomStore.roomState(),
      feature = job.managed;
    if (
      !this.alive ||
      !this.dailyLife.visible ||
      !this.automation.current(item)
    )
      return { status: "skipped", reason: "窗口已隐藏或自动功能已暂停。" };
    if (this.roomBusyForAutomation(previous))
      return { status: "skipped", reason: ROOM_BUSY_SKIP };
    const denied = this.automaticBudget.reason(feature);
    if (denied) return { status: "skipped", reason: denied };
    const thread = this.roomStore.currentRoomThread();
    if (
      thread.archivedAt ||
      (job.action.kind === "daily-opening" &&
        (job.action.threadId !== thread.id ||
          job.action.day !== localParts(this.automationNow()).day))
    )
      return {
        status: "skipped",
        reason: "话题或日期已改变，未补发每日开场。",
      };
    const ready = this.store
      .members()
      .filter((member) =>
        this.providers.some(
          (provider) =>
            provider.id === member.executor &&
            provider.available &&
            !provider.stale,
        ),
      );
    const candidates = ready.filter(
      (member) =>
        !this.automaticBudget.reason(
          feature,
          member.executor,
          member.model || this.settings.models[member.executor],
        ) &&
        !this.store
          .list<Session>("sessions")
          .some(
            (session) =>
              session.projectId === "lounge" &&
              session.purpose !== "room-hand" &&
              (session.memberId ?? session.provider) === member.id &&
              this.store.get("blocked_sessions", session.id),
          ),
    );
    if (
      ready.length &&
      ready.every(
        (member) =>
          quotaPreference(
            this.memberQuota(member.executor),
            Date.now(),
            member.model || this.settings.models[member.executor],
          ) === 0,
      )
    ) {
      this.automation.hold(
        job.id,
        "所有可用成员的账号额度均受限，请核对额度后恢复未来的触发。",
      );
      return {
        status: "skipped",
        reason: "全员额度受限，已暂停这类自动发言。",
      };
    }
    const order = rotateMembers(
        candidates,
        this.store.get<{ memberId: string }>("daily_life", feature)?.memberId,
      ),
      first = order[0];
    if (!first || (feature === "member-chat" && order.length < 2))
      return {
        status: "skipped",
        reason:
          "没有足够的已连接且无需核对的成员；每日开场需一位，闲聊需两位。",
      };
    const usage = this.automaticBudget
      .snapshot()
      .find((value) => value.feature === feature)!;
    if (feature === "member-chat" && usage.limit - usage.used < 2)
      return {
        status: "skipped",
        reason: "成员闲聊需要两次调用，今日剩余预算不足。",
      };
    const other =
      order
        .slice(1)
        .find(
          (member) =>
            first.relations?.some(
              (relation) => relation.memberId === member.id,
            ) ||
            member.relations?.some(
              (relation) => relation.memberId === first.id,
            ),
        ) ?? order[1];
    const members = feature === "daily-opening" ? [first] : [first, other];
    const parent = {
      ...item,
      threadId: thread.id,
      memberIds: members.map((member) => member.id),
      memberStamps: members.map((member) => this.lifeMemberStamp(member)!),
    };
    this.store.put("timed_occurrences", item.id, parent);
    this.roomStopping = false;
    this.lifeRunning = true;
    this.setRoomState({ active: true, mode: "chat", speaking: first.id });
    const task = Promise.resolve().then(async (): Promise<TimedResult> => {
      const runIds: string[] = [];
      let replyText: string | undefined;
      for (let step = 0; step < members.length; step++) {
        const member = members[step],
          child: TimedOccurrence = {
            ...item,
            id: `${item.id}:${step}`,
            parentOccurrenceId: item.id,
            memberId: member.id,
            step,
            status: "running",
            startedAt: now(),
            threadId: thread.id,
          };
        if (this.store.get("timed_occurrences", child.id))
          return {
            status: "unknown",
            reason: "这次成员发言已经登记，未重复发送。",
            runIds,
          };
        this.store.put("timed_occurrences", child.id, child);
        const origin: AutomaticOrigin = {
          feature,
          jobId: job.id,
          occurrenceId: child.id,
        };
        let outcome: TimedResult;
        try {
          this.automaticAllowed(
            origin,
            member.executor,
            member.model || this.settings.models[member.executor],
          );
          const session = await this.loungeSession(member);
          this.automaticAllowed(
            origin,
            member.executor,
            member.model || this.settings.models[member.executor],
          );
          if (this.store.get("blocked_sessions", session.id))
            throw new AutomaticDenied("成员上一轮仍待核对，未开始自动发言。");
          this.setRoomState({ speaking: member.id });
          const prompt =
            feature === "daily-opening"
              ? openingPrompt(
                  member,
                  this.roomStore.roomMessages(1000, thread.id),
                  this.automationNow(),
                )
              : memberChatPrompt(
                  member,
                  members[step === 0 ? 1 : 0],
                  this.automationNow(),
                  replyText,
                );
          const spoken = await this.speakAutomatically({
            member,
            sessionId: session.id,
            prompt,
            origin,
            messageId: `automatic-${child.id}`,
            threadId: thread.id,
            afterSend:
              step === 0
                ? () =>
                    this.store.put("daily_life", feature, {
                      memberId: member.id,
                      at: now(),
                    })
                : undefined,
          });
          outcome = spoken.outcome;
          if (outcome.runId) runIds.push(outcome.runId);
          replyText = spoken.text;
          if (spoken.run?.status === "rate_limited")
            this.automation.hold(
              job.id,
              "本次成员发言受限，请核对额度后恢复未来的触发。",
            );
        } catch (error) {
          outcome = {
            status: error instanceof AutomaticDenied ? "skipped" : "failed",
            reason: (error as Error).message,
          };
        }
        this.store.put("timed_occurrences", child.id, {
          ...child,
          ...outcome,
          finishedAt: now(),
        });
        if (outcome.status !== "done") return { ...outcome, runIds };
      }
      return { status: "done", runId: runIds.at(-1), runIds };
    });
    this.holdRoomFor(task, previous, true);
    return task;
  }
  private async automaticSpeech(
    job: TimedJob,
    item: TimedOccurrence,
  ): Promise<TimedResult> {
    if (job.action.kind !== "member-message") return { status: "skipped" };
    const action = job.action;
    const member = this.store
      .members()
      .find((member) => member.id === action.memberId);
    if (!member) return { status: "skipped", reason: "成员已经删除。" };
    const origin: AutomaticOrigin = {
      feature: action.feature,
      jobId: job.id,
      occurrenceId: item.id,
    };
    try {
      this.automaticAllowed(
        origin,
        member.executor,
        member.model || this.settings.models[member.executor],
      );
    } catch (error) {
      return { status: "skipped", reason: (error as Error).message };
    }
    const previous = this.roomStore.roomState();
    if (this.roomBusyForAutomation(previous))
      return { status: "skipped", reason: ROOM_BUSY_SKIP };
    this.roomStopping = false;
    this.setRoomState({ active: true, mode: "chat", speaking: member.id });
    const task = Promise.resolve().then(async (): Promise<TimedResult> => {
      try {
        const session = await this.loungeSession(member),
          current = this.store.get<Session>("sessions", session.id)!;
        if (this.store.get("blocked_sessions", current.id))
          return {
            status: "skipped",
            reason: "成员上一轮的结果还待核对，本次自动发言已跳过。",
          };
        if (this.roomStopping || !this.alive)
          return { status: "skipped", reason: "你已停止本次发言。" };
        this.automaticAllowed(
          origin,
          member.executor,
          member.model || this.settings.models[member.executor],
        );
        const context = this.roomStore
          .roomMessages(8, action.threadId)
          .filter((message) => !message.system && message.status !== "speaking")
          .map(
            (message) =>
              `${message.authorName || message.author}：${message.text.slice(0, 700)}`,
          )
          .join("\n");
        const prompt = `[AIROOM 主人已启用的定时发言]\n任务名称：${job.name}\n主人预先设置的要求：${action.text}\n这是一条定时发言，只回复一次，不继续调度其他成员。不要使用工具、读写文件或执行命令；不要声称做过没有记录的工作。\n近期聊天仅为参考：\n${context || "（暂无）"}`;
        return (
          await this.speakAutomatically({
            member,
            sessionId: session.id,
            prompt,
            origin,
            messageId: `automatic-${item.id}`,
            threadId: action.threadId,
          })
        ).outcome;
      } catch (error) {
        return {
          status: error instanceof AutomaticDenied ? "skipped" : "failed",
          reason: (error as Error).message,
        };
      }
    });
    this.holdRoomFor(task, previous);
    return task;
  }
  broadcast() {
    if (!this.alive || this.snapshotTimer) return;
    this.snapshotTimer = setImmediate(() => {
      this.snapshotTimer = undefined;
      if (!this.alive) return;
      this.store.readScope(() => {
        this.roundtables?.sync();
        this.memberWorkspaces?.refresh();
        this.push({ type: "snapshot", snapshot: this.snapshot() });
      });
    });
  }
  /** The built-in executors plus every program the user connected over ACP. */
  private executorIds(): ProviderId[] {
    return [...ids.filter(id => !this.store.get('removed_providers', id)), ...this.store.executors().map((item) => item.id)];
  }
  private permissionsFor(
    id: ProviderId,
    settings: Settings,
  ): MemberPermissions {
    if (id !== "deepseek" && settings.permissions[id]) return settings.permissions[id];
    if (isAcpId(id))
      return (
        this.store.get<AcpExecutor>("executors", id)?.permissions ??
        ACP_DEFAULT_PERMISSIONS
      );
    return settings.permissions[id as "codex" | "claude" | "dsh"];
  }
  private adapter(id: ProviderId): Adapter {
    const injected = this.factory?.(id);
    if (injected) return injected;
    if (isAcpId(id)) {
      const executor = this.store.get<AcpExecutor>("executors", id);
      if (!executor) throw new Error("这个外接程序已经删除");
      return this.externalAdapter(executor);
    }
    switch (id) {
      case "codex":
        return new CodexAdapter();
      case "claude":
        return new ClaudeAdapter();
      case "dsh":
        return new DshAdapter();
      case "deepseek":
        return new DeepseekAdapter(() => this.key, this.store.dataDirectory);
    }
    throw new Error("成员无效");
  }
  private externalAdapter(executor: AcpExecutor) {
    return executor.catalogId &&
      catalogEntry(executor.catalogId).adapter === "zcode"
      ? new ZcodeAdapter(this.withSecrets(executor))
      : new AcpAdapter(this.withSecrets(executor));
  }
  private async invalidateRuntimes(provider?: ProviderId, stopActive = false) {
    invalidateClaudeChecks();
    if (stopActive)
      await Promise.all(
        [...this.active.entries()]
          .filter(
            ([, active]) => !provider || active.ctx.run.provider === provider,
          )
          .map(([id]) => this.stopRun(id)),
      );
    await this.roomRuntimes.invalidate(
      (key) =>
        !provider ||
        this.store.get<Session>("sessions", key)?.provider === provider,
    );
  }
  private removeExecutor(id: AcpExecutorId) {
    this.cancelProbeRetry(id);
    this.probeRevisions.set(id, (this.probeRevisions.get(id) ?? 0) + 1);
    this.store.delete("executors", id);
    this.store.delete("providers", id);
    const permissions = { ...this.settings.permissions }, models = { ...this.settings.models }, efforts = { ...this.settings.efforts };
    delete permissions[id]; delete models[id]; delete efforts[id];
    this.settings = { ...this.settings, permissions, models, efforts };
    this.store.put("settings", "main", this.settings);
    this.acpSecrets.delete(id);
    this.providers = this.providers.filter((info) => info.id !== id);
    rememberExecutors(this.store.executors());
  }
  private require<T>(entity: string, id: string): T {
    const value = this.store.get<T>(entity, id);
    if (!value) throw new Error("所选记录不存在，请刷新工作台");
    return value;
  }
  private persistRun(run: Run, change: Partial<Run>) {
    const current = this.require<Run>("runs", run.id);
    const next = { ...current, ...change, updatedAt: now() };
    this.store.put("runs", run.id, next);
    this.broadcast();
    return next;
  }
  private writeEvent(
    ctx: AdapterContext,
    kind: TimelineEvent["kind"],
    text: string,
    data?: unknown,
    fidelity: TimelineEvent["fidelity"] = "native",
  ) {
    if (this.closed) return;
    const event = this.store.appendEvent({
      id: randomUUID(),
      runId: ctx.run.id,
      sessionId: ctx.session.id,
      provider: ctx.run.provider,
      at: now(),
      kind,
      text,
      data,
      fidelity,
    });
    this.projectFlow?.activity(event);
    this.push({ type: "event", event });
  }
  private emit(
    ctx: AdapterContext,
    kind: TimelineEvent["kind"],
    text: string,
    data?: unknown,
    fidelity: TimelineEvent["fidelity"] = "native",
  ) {
    if (this.closed) return;
    if (kind === "image") {
      const active = this.active.get(ctx.run.id),
        run = this.store.get<Run>("runs", ctx.run.id);
      const native =
        data && typeof data === "object"
          ? (data as Record<string, unknown>)
          : {};
      // Images have the same receipt and round boundary as text, and stop never publishes a late picture.
      if (
        active?.ctx !== ctx ||
        active.stopping ||
        !run ||
        run.provider !== "codex" ||
        run.automatic ||
        run.delivery !== "confirmed" ||
        !run.nativeTurnId ||
        native.nativeTurnId !== run.nativeTurnId
      )
        return;
      if (
        this.store.get<Project>("projects", run.projectId)?.kind === "lounge" &&
        !run.imageGeneration
      )
        return;
      if (
        run.generatedImages?.some(
          (image) =>
            image.nativeItemId === native.nativeItemId &&
            image.nativeTurnId === run.nativeTurnId,
        )
      )
        return;
      try {
        if ((run.generatedImages?.length ?? 0) >= GENERATED_IMAGES_MAX)
          throw new Error("本轮返回的图片过多，后续图片未保存。");
        const image = redact(
          storeGeneratedImage(this.store.dataDirectory, native),
        );
        const generatedImages = [...(run.generatedImages ?? []), image];
        this.persistRun(ctx.run, { generatedImages });
        for (const message of this.store
          .list<RoomMessage>("room_messages")
          .filter(
            (message) => message.runId === run.id && !message.discussionControl,
          ))
          this.store.put("room_messages", message.id, {
            ...message,
            generatedImages,
          });
        active.metrics?.mark("first-output");
        this.flushRun(run.id);
        this.writeEvent(ctx, "image", "图片已生成。", image, fidelity);
        this.broadcast();
      } catch (error) {
        this.flushRun(run.id);
        this.writeEvent(
          ctx,
          "error",
          (error as Error).message,
          undefined,
          "derived",
        );
      }
      return;
    }
    if (
      (kind === "usage" || kind === "status") &&
      this.rememberQuota(ctx.run.provider, data, now(), "event")
    )
      this.broadcast();
    if (kind === "delta" || kind === "reasoning") {
      const metadata =
        data && typeof data === "object" && !Array.isArray(data)
          ? { ...(data as Record<string, unknown>) }
          : data;
      if (
        metadata &&
        typeof metadata === "object" &&
        !Array.isArray(metadata)
      ) {
        delete (metadata as any).delta;
        delete (metadata as any).text;
        delete (metadata as any).thinking;
      }
      const signature = JSON.stringify(redact(metadata), (_key, value) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(
              Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
            )
          : value,
      );
      const key = `${ctx.run.id}:${kind}:${fidelity}:${signature ?? ""}`;
      const existing = this.buffers.get(key);
      if (existing) {
        existing.text += text;
        return;
      }
      this.flushRun(ctx.run.id); // Preserve ordering across different native items and channels.
      const value = {
        ctx,
        kind,
        text,
        data: metadata,
        fidelity,
        timer: setTimeout(() => this.flush(key), 100),
      };
      this.buffers.set(key, value);
      return;
    }
    this.flushRun(ctx.run.id);
    this.writeEvent(ctx, kind, text, data, fidelity);
  }
  private flush(key: string) {
    const value = this.buffers.get(key);
    if (!value) return;
    clearTimeout(value.timer);
    this.buffers.delete(key);
    this.writeEvent(
      value.ctx,
      value.kind,
      value.text,
      value.data,
      value.fidelity,
    );
  }
  private flushRun(id: string) {
    for (const key of [...this.buffers.keys()])
      if (key.startsWith(`${id}:`)) this.flush(key);
  }
  private member(value: unknown) {
    if (value !== "codex" && value !== "claude" && value !== "dsh")
      throw new Error("该成员不支持版本管理");
    return value;
  }
  private async memberProgram(
    member: "codex" | "claude" | "dsh",
    info?: ProviderInfo,
  ): Promise<ExecutorIdentity> {
    const entry =
      member === "dsh"
        ? await resolveDshEntry(this.settings)
        : resolveCliEntry(
            member,
            this.settings,
            buildEnvironment(this.settings),
          ).path;
    const identity = {
      ...newCompatibility(member, "probe", this.settings).identity,
      ...readProgramIdentity(entry),
    };
    // A native version may be available for a standalone executable without a manifest.
    const observed = [info?.compatibility, info?.lastRunCompatibility]
      .filter((r): r is CompatibilityReport => !!r)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .find((r) => sameMemberProgram(identity, r.identity));
    if (!identity.version && observed?.identity.version) {
      identity.version = observed.identity.version;
      identity.versionSource = observed.identity.versionSource;
    }
    return identity;
  }
  private async memberVersions(
    provider: unknown,
    checkLatest: boolean,
  ): Promise<MemberVersions> {
    const member = this.member(provider);
    const info = this.providers.find((x) => x.id === member);
    const configured = this.settings.paths[member];
    const activeVersion = versionOfPath(
      this.store.dataDirectory,
      member,
      configured,
    );
    let latest: string | undefined, latestError: string | undefined;
    if (checkLatest)
      try {
        latest = await latestVersion(
          member,
          buildEnvironment(this.settings),
          this.store.dataDirectory,
        );
      } catch (error) {
        latestError = (error as Error).message;
      }
    let identity: ExecutorIdentity | undefined,
      connection: MemberVersions["connection"];
    try {
      identity = await this.memberProgram(member, info);
      const observed =
        info?.connectionCheck?.source === "run"
          ? info.lastRunCompatibility?.identity
          : info?.compatibility?.identity;
      const matches = sameMemberProgram(identity, observed);
      connection = !matches
        ? { state: "unchecked", detail: "当前程序等待连接检查。" }
        : info?.stale
          ? { state: "stale", detail: "上次已连接，等待重新确认。" }
          : {
              state: info?.available ? "connected" : "failed",
              detail: info?.detail ?? "等待连接检查。",
              checkedAt: info?.checkedAt,
            };
    } catch (error) {
      connection = {
        state: "failed",
        detail: String(redact((error as Error).message)),
      };
    }
    const key = identity && memberVersionUseKey(member, identity),
      successfulUse = key
        ? this.store.get<MemberVersionUse>("member_version_uses", key)
        : undefined;
    const report = info?.lastRunCompatibility,
      lastRun =
        report && sameMemberProgram(identity, report.identity)
          ? {
              outcome: report.outcome,
              completedAt: report.completedAt,
              error: report.error ? String(redact(report.error)) : undefined,
            }
          : undefined;
    return {
      member,
      packageName: MEMBER_PACKAGES[member],
      current: identity?.version,
      baselineVersions: VERIFIED_VERSIONS[member],
      connection,
      successfulUse,
      lastRun,
      installation: this.memberInstallations.get(member),
      source: configured
        ? activeVersion
          ? "airoom"
          : "custom"
        : member === "claude"
          ? "global"
          : "bundled",
      activeVersion,
      selectedPath: configured ?? null,
      installed: installedVersions(this.store.dataDirectory, member).map(
        (x) => x.version,
      ),
      latest,
      latestError,
    };
  }
  private async memberOperation<T>(
    member: string,
    action: () => Promise<T>,
  ): Promise<T> {
    if (this.acpLogins.has(member))
      throw new Error("该执行端正在登录，请完成或取消登录后再操作。");
    if (this.memberOperations.has(member))
      throw new Error("该成员正在安装或切换版本，请等待完成");
    this.memberOperations.add(member);
    try {
      return await action();
    } finally {
      this.memberOperations.delete(member);
    }
  }
  private async inspectCatalogCandidate(executor: AcpExecutor) {
    const report = newCompatibility(executor.id, "candidate", this.settings);
    this.rememberCompatibility(report);
    const adapter =
      this.factory?.(executor.id) ?? this.externalAdapter(executor);
    const info = await withCompatibility(report, () =>
      adapter.probe(this.settings, buildEnvironment(this.settings)),
    );
    const auth = catalogEntry(executor.catalogId).authentication.find(
      (item) => item.id === executor.authentication,
    );
    if (
      auth?.kind === "api" &&
      !executor.secretKeys?.length &&
      info.runtimeReady
    ) {
      info.available = false;
      info.auth = "none";
      info.detail =
        "程序已连接，需要在 AIROOM 中填写 API Key 后使用。未发送模型任务。";
    }
    info.checkedAt = now();
    info.stale = false;
    report.completedAt = now();
    report.outcome = info.available
      ? "passed"
      : info.runtimeReady && info.auth === "none"
        ? "needs-auth"
        : "failed";
    report.account = info.auth;
    report.capabilities = info.capabilities;
    if (info.version)
      report.identity = {
        ...report.identity,
        version: info.version,
        versionSource: "native",
      };
    if (report.outcome === "failed") report.error = info.detail;
    info.compatibility = report;
    this.rememberCompatibility(report);
    return info;
  }
  private async useCatalogExecutor(executor: AcpExecutor) {
    const original = this.settings,
      previous = this.store.get<AcpExecutor>("executors", executor.id);
    if (!previous && this.store.executors().length >= 12)
      throw new Error("最多接入 12 个外接程序。");
    await this.invalidateRuntimes(executor.id);
    const info = await this.inspectCatalogCandidate(executor);
    if (
      this.active.size ||
      this.settings !== original ||
      JSON.stringify(previous) !==
        JSON.stringify(this.store.get("executors", executor.id))
    )
      throw new Error("检查期间任务或配置发生变化，原配置已保留，请重试。");
    if (!info.available && !(info.runtimeReady && info.auth === "none"))
      throw new Error("候选执行端未通过连接检查，原配置已保留：" + info.detail);
    if (
      info.compatibility?.identity.path &&
      info.compatibility.identity.digest
    ) {
      const check = newCompatibility(executor.id, "candidate", this.settings);
      await withCompatibility(
        check,
        () => confirmProgram(info.compatibility!.identity.path!),
        info.compatibility.identity,
      );
    }
    this.store.put("executors", executor.id, executor);
    rememberExecutors(this.store.executors());
    this.cancelProbeRetry(executor.id);
    this.probeRevisions.set(
      executor.id,
      (this.probeRevisions.get(executor.id) ?? 0) + 1,
    );
    this.publishProvider(info);
    return executor;
  }
  private async catalogOperation(params: any, install: boolean) {
    const entry = catalogEntry(params.id),
      provider = catalogProvider(entry.id);
    if (install && entry.downloadable === false)
      throw new Error("该执行端已从下载清单移除；已有连接和历史记录仍保留。");
    if (this.active.size)
      throw new Error("请先停止正在运行的成员，再下载或切换执行端。");
    const consent = this.store.get<{ revision: string }>(
      "catalog_consents",
      entry.id,
    );
    if (
      consent?.revision !== CATALOG_REVISION &&
      (params.agree !== true || params.revision !== CATALOG_REVISION)
    )
      throw new Error("请先阅读并同意该厂商的条款。");
    return this.memberOperation(provider, async () => {
      const before = installedVersions(this.store.dataDirectory, entry.id),
        version = String(params.version),
        startedAt = now();
      this.memberInstallations.set(provider, {
        version,
        phase: "installing",
        startedAt,
        phaseStartedAt: startedAt,
      });
      try {
        const item = install
          ? await this.memberInstaller(
              this.store.dataDirectory,
              entry.id,
              version,
              buildEnvironment(this.settings),
              {
                requireIntegrity: true,
                progress: (value) => {
                  const current = this.memberInstallations.get(provider);
                  if (!current) return;
                  this.memberInstallations.set(provider, {
                    ...current,
                    ...value,
                    phaseStartedAt:
                      current.phase === value.phase
                        ? current.phaseStartedAt
                        : now(),
                  });
                },
              },
            )
          : before.find((item) => item.version === version);
        if (!item) throw new Error("这个版本没有完整安装。");
        this.memberInstallations.set(provider, {
          ...this.memberInstallations.get(provider)!,
          phase: "connection",
          phaseStartedAt: now(),
        });
        if (isAcpId(provider))
          await this.useCatalogExecutor(
            catalogCandidate(
              entry.id,
              item.entry,
              this.store.get("executors", provider),
            ),
          );
        else {
          try {
            await this.useMemberPath(this.member(provider), item.entry);
          } catch (error) {
            if (
              entry.id !== "dsh" ||
              !process.versions.electron ||
              !/Electron.*不兼容|node-addon|NODE_MODULE_VERSION|ERR_DLOPEN_FAILED/i.test(
                (error as Error).message,
              )
            )
              throw error;
            this.memberInstallations.set(provider, {
              ...this.memberInstallations.get(provider)!,
              detail:
                "正在从 nodejs.org 下载并校验 DSH 兼容运行环境（26.4.0）。",
            });
            await ensurePortableNode(
              this.store.dataDirectory,
              buildEnvironment(this.settings),
            );
            await this.useMemberPath("dsh", item.entry);
          }
        }
        this.store.put("catalog_consents", entry.id, {
          revision: CATALOG_REVISION,
          at: now(),
          packageName: entry.packageName,
          termsUrl: entry.termsUrl,
        });
        return catalogStatuses(this.store, this.settings).find(
          (item) => item.entry.id === entry.id,
        );
      } catch (error) {
        if (install && !before.some((item) => item.version === version))
          await removeVersion(this.store.dataDirectory, entry.id, version, () =>
            assertCatalogVersionUnused(
              this.store,
              this.settings,
              entry.id,
              version,
            ),
          ).catch(() => {});
        throw error;
      } finally {
        this.memberInstallations.delete(provider);
        this.broadcast();
      }
    });
  }
  private compatibilityQueues = new Map<ProviderId, Promise<unknown>>();
  private rememberCompatibility(report: CompatibilityReport) {
    if (this.closed) return;
    this.store.put("compatibility_reports", report.id, redact(report));
    const old = this.store
      .list<CompatibilityReport>("compatibility_reports")
      .filter((r) => r.provider === report.provider && r.id !== report.id)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    for (const item of old.slice(49))
      this.store.delete("compatibility_reports", item.id);
  }
  private async inspectProvider(
    id: ProviderId,
    settings: Settings,
    trigger: CompatibilityReport["trigger"] = "probe",
  ) {
    // Startup, settings save and a manual check can otherwise initialize the same native home concurrently.
    // Different connection settings still get a new check, and the revision guard rejects stale results.
    const key = JSON.stringify([
      id,
      settings.networkMode,
      settings.proxyUrl,
      settings.paths[id],
      settings.models[id],
      settings.efforts[id],
      id !== "deepseek" ? this.permissionsFor(id, settings) : undefined,
      id === "dsh"
        ? [settings.dshProfile, settings.deepseekBaseUrl]
        : undefined,
      isAcpId(id) ? this.store.get("executors", id) : undefined,
    ]);
    const existing = this.providerChecks.get(key);
    if (existing) return existing;
    const previous = this.compatibilityQueues.get(id);
    const task = (async () => {
      if (previous) await previous.catch(() => {});
      if (!this.alive || this.maintenance)
        throw new Error("执行服务已停止或正在恢复，未启动排队中的探测。");
      const report = newCompatibility(id, trigger, settings);
      this.rememberCompatibility(report);
      const result = await withCompatibility(report, () =>
        this.adapter(id).probe(settings, buildEnvironment(settings)),
      ).catch(
        (error) =>
          ({
            id,
            name: PROVIDER_NAMES[id],
            available: false,
            auth: "unknown",
            detail: (error as Error).message,
            capabilities: {
              steer: false,
              cancel: "process",
              streaming: false,
              write: false,
              history: false,
            },
          }) as ProviderInfo,
      );
      const info: ProviderInfo = redact({
        ...result,
        checkedAt: now(),
        stale: false,
      });
      if (
        ["codex", "claude", "dsh"].includes(id) &&
        !settings.paths[id] &&
        !info.path &&
        !info.runtimeReady &&
        /未找到|ENOENT|找不到/.test(info.detail)
      ) {
        info.installationRequired = true;
        info.detail = "尚未下载官方程序，请从内置清单选择、下载并登录。";
      }
      if (isAcpId(id) && !info.permissionSupport) {
        // AIROOM only sees the permission requests a connected program chooses to send.
        info.permissionSupport = {
          commandReadIsolation: false,
          commandWriteIsolation: "approval-only",
          networkIsolation: "none",
        };
      } else if (!isAcpId(id) && id !== "deepseek") {
        const permissions = this.permissionsFor(id, settings);
        info.verified = isVerified(
          id as "codex" | "claude" | "dsh",
          info.version,
        );
        info.permissionSupport = {
          commandReadIsolation: false,
          commandWriteIsolation:
            permissions.fileScope === "any"
              ? "none"
              : id === "claude" ||
                  (id === "codex" &&
                    process.platform === "win32" &&
                    !info.windowsSandbox?.ready)
                ? "approval-only"
                : "native",
          networkIsolation: permissions.network ? "none" : "commands-disabled",
        };
      }
      report.completedAt = now();
      report.outcome = info.available
        ? "passed"
        : info.runtimeReady && info.auth === "none"
          ? "needs-auth"
          : "failed";
      report.account = info.auth;
      report.capabilities = info.capabilities;
      report.identity = {
        ...report.identity,
        ...(info.path && !report.identity.path ? { path: info.path } : {}),
        ...(info.version
          ? { version: info.version, versionSource: "native" as const }
          : {}),
      };
      if (report.outcome === "failed") report.error = info.detail;
      info.compatibility = report;
      this.rememberCompatibility(report);
      return info;
    })();
    this.compatibilityQueues.set(id, task);
    void task
      .finally(() => {
        if (this.compatibilityQueues.get(id) === task)
          this.compatibilityQueues.delete(id);
      })
      .catch(() => {});
    this.providerChecks.set(key, task);
    try {
      return await task;
    } finally {
      if (this.providerChecks.get(key) === task)
        this.providerChecks.delete(key);
    }
  }
  private publishProvider(info: ProviderInfo) {
    info = {
      ...info,
      lastRunCompatibility:
        info.lastRunCompatibility ??
        this.providers.find((item) => item.id === info.id)
          ?.lastRunCompatibility,
    };
    if (info.quota)
      this.rememberQuota(
        info.id,
        info.quota,
        info.quotaCheckedAt ?? info.checkedAt ?? now(),
        "probe",
      );
    const index = this.providers.findIndex((x) => x.id === info.id);
    if (index < 0) this.providers.push(info);
    else this.providers[index] = info;
    this.store.put("providers", info.id, info);
    this.broadcast();
  }
  private async useMemberPath(
    member: "codex" | "claude" | "dsh",
    entry: string | undefined,
  ) {
    const original = this.settings,
      paths = { ...original.paths };
    if (entry) paths[member] = entry;
    else delete paths[member];
    const candidate = { ...original, paths },
      info = await this.inspectProvider(member, candidate, "candidate");
    try {
      if (this.active.size)
        throw new Error(
          "任务正在运行，新版本已安装但暂不切换。请等任务结束或停止后，再点击切换版本。",
        );
      if (this.settings !== original)
        throw new Error("探测期间设置已改变，请重试切换；原配置已保留");
      if (!info.available && !(info.auth === "none" && info.runtimeReady))
        throw new Error(
          "新版本连接检查未通过，原版本已保留。请查看成员设置中的连接结果：" +
            info.detail,
        );
      if (
        info.compatibility?.identity.path &&
        info.compatibility.identity.digest
      ) {
        const recheck = newCompatibility(member, "candidate", candidate);
        await withCompatibility(
          recheck,
          () => confirmProgram(info.compatibility!.identity.path!),
          info.compatibility.identity,
        );
      }
      const requestedModel = candidate.models[member],
        requestedEffort = candidate.efforts[member],
        options = info.modelOptions ?? [];
      const selected = requestedModel
        ? options.find((option) => option.id === requestedModel)
        : options.find((option) => option.isDefault);
      if (requestedModel && options.length && !selected)
        throw new Error("候选版本不支持所选模型，原版本已保留。");
      if (
        requestedEffort &&
        selected &&
        selected.efforts.length &&
        !selected.efforts.includes(requestedEffort)
      )
        throw new Error("候选版本不支持所选思考程度，原版本已保留。");
    } catch (error) {
      if (info.compatibility) {
        info.compatibility.outcome = "failed";
        info.compatibility.error = String(redact((error as Error).message));
        info.compatibility.completedAt = now();
        this.rememberCompatibility(info.compatibility);
      }
      throw error;
    }
    this.cancelProbeRetry(member);
    this.probeRevisions.set(member, (this.probeRevisions.get(member) ?? 0) + 1);
    this.settings = candidate;
    this.store.delete('removed_providers', member);
    this.store.put("settings", "main", candidate);
    this.publishProvider(info);
    await this.invalidateRuntimes(member);
    return this.memberVersions(member, false);
  }
  private cancelProbeRetry(id: ProviderId) {
    clearTimeout(this.probeRetries.get(id));
    this.probeRetries.delete(id);
    this.deferredProbeRetries.delete(id);
  }
  private async confirmProvider(ctx: AdapterContext) {
    const run = this.store.get<Run>("runs", ctx.run.id),
      info = this.providers.find((info) => info.id === ctx.run.provider);
    if (
      !this.alive ||
      !info ||
      !run ||
      !["ended", "completed"].includes(run.status) ||
      run.delivery !== "confirmed" ||
      run.revision !==
        this.store.get<Session>("sessions", run.sessionId)?.revision
    )
      return;
    const replied = this.store
      .runEvents(run.id)
      .some(
        (event) =>
          event.runId === run.id &&
          event.fidelity === "native" &&
          ["message", "delta"].includes(event.kind) &&
          event.text.trim() &&
          !(event.data as { role?: string } | undefined)?.role,
      );
    if (!replied) return;
    const identity = currentIdentity();
    if (info.id === "codex" || info.id === "claude" || info.id === "dsh") {
      const key = identity && memberVersionUseKey(info.id, identity);
      if (key && identity)
        this.store.put("member_version_uses", key, {
          provider: info.id,
          identity,
          runId: run.id,
          completedAt: run.completedAt ?? now(),
          requestedConfig: run.requestedConfig,
          effectiveConfig: run.effectiveConfig,
        } satisfies MemberVersionUse);
      // A completed old bound session is evidence for its own version, never for today's selected program.
      try {
        if (
          identity &&
          !sameMemberProgram(identity, await this.memberProgram(info.id, info))
        )
          return;
      } catch {
        return;
      }
    }
    if (
      !this.alive ||
      this.providers.find((item) => item.id === info.id) !== info ||
      (info.auth === "none" &&
        Date.parse(run.createdAt) < Date.parse(info.checkedAt ?? ""))
    )
      return;
    this.cancelProbeRetry(info.id);
    this.probeRevisions.set(
      info.id,
      (this.probeRevisions.get(info.id) ?? 0) + 1,
    );
    this.publishProvider({
      ...info,
      quotaCheckedAt: info.quotaCheckedAt ?? info.checkedAt,
      available: true,
      stale: false,
      runtimeReady: true,
      auth:
        info.id === "claude"
          ? ctx.settings.claudeAuthMode === "api"
            ? "api"
            : "subscription"
          : info.id === "codex"
            ? "subscription"
            : info.id === "dsh"
              ? "account"
              : info.auth,
      checkedAt: now(),
      detail: "本轮已收到并核对成员回复，连接已确认。",
      connectionCheck: { source: "run", runId: run.id },
    });
  }
  private loginLost(id: ProviderId) {
    const info = this.providers.find((info) => info.id === id);
    if (!info) return;
    this.cancelProbeRetry(id);
    this.publishProvider({
      ...info,
      available: false,
      auth: "none",
      checkedAt: now(),
      quota: undefined,
      quotaCheckedAt: undefined,
      detail: "登录已失效，请在成员设置里重新登录，然后检测连接。",
    });
  }
  async probe(provider?: ProviderId, automaticRetry = false) {
    if (!this.alive || this.maintenance) return this.providers;
    if (provider && this.store.get('removed_providers',provider)) throw new Error('这个执行端连接已删除，请先重新添加连接。');
    const empty=!this.store.members().length&&!this.store.executors().length&&!Object.values(this.settings.paths).some(Boolean)&&!this.key;
    await Promise.all(
      (provider ? [provider] : empty?[]:this.executorIds()).map(async (id) => {
        this.cancelProbeRetry(id);
        const revision = (this.probeRevisions.get(id) ?? 0) + 1;
        this.probeRevisions.set(id, revision);
        const info = await this.inspectProvider(id, this.settings);
        if (!this.alive || this.probeRevisions.get(id) !== revision) return;
        const retry =
          !automaticRetry &&
          !info.available &&
          !["none", "api"].includes(info.auth) &&
          !/所选|没有接受|配置.*不支持/.test(info.detail) &&
          id !== "deepseek";
        const delay = Math.max(1, this.timing?.providerRetryMs ?? 30_000);
        info.connectionCheck = {
          source: "probe",
          retryAttempt: automaticRetry ? 1 : 0,
          ...(retry
            ? { retryAt: new Date(Date.now() + delay).toISOString() }
            : {}),
        };
        this.publishProvider(info);
        if (retry) {
          const timer = setTimeout(() => {
            this.probeRetries.delete(id);
            if (!this.alive || this.probeRevisions.get(id) !== revision) return;
            if (
              [...this.active.values()].some(
                (active) => active.ctx.run.provider === id,
              )
            ) {
              this.deferredProbeRetries.set(id, revision);
              return;
            }
            void this.probe(id, true).catch(() => {});
          }, delay);
          timer.unref();
          this.probeRetries.set(id, timer);
        }
      }),
    );
    return this.providers;
  }
  async invoke(method: string, params: any = {}): Promise<unknown> {
    if(method==='composer.draft.get')return new ComposerDrafts(this.store).get(params);
    if(method==='composer.draft.save'){
      if(this.maintenance)throw new Error('正在备份或恢复资料，请等完成后再保存草稿。');
      const result=new ComposerDrafts(this.store).save(params);
      if(result.released.length)this.releaseAttachments(result.released);
      return {saved:true};
    }
    // Finish obsolete view reads without recreating a deleted room or surfacing a false delete error.
    if (
      ["room.get", "room.history", "room.read"].includes(method) &&
      typeof params?.roomId === "string" &&
      params.roomId.startsWith("roundtable:") &&
      this.store.get("roundtable_tombstones", params.roomId.slice(11))
    ) {
      return method === "room.read"
        ? { read: false }
        : {
            roomId: params.roomId,
            threadId: "",
            currentThreadId: "",
            messages: [],
            threads: [],
            hasMore: false,
            state: { active: false, mode: "chat" },
          };
    }
    if (
      method.startsWith("room.") &&
      isPersonalRoom(String(params?.roomId ?? ""))
    ) {
      if (
        this.maintenance &&
        !["room.get", "room.history", "room.export"].includes(method)
      )
        throw new Error("正在备份或恢复资料，请等完成后再操作。");
      const id = String(params.roomId) as RoomId,
        parts = id.split(":");
      if (id.startsWith("desk:") && !this.store.get("personal_rooms", id))
        this.memberWorkspaces.ensureMember(parts.slice(1).join(":"));
      if (id.startsWith("report:") && !this.store.get("personal_rooms", id)) {
        if (parts.length !== 3) throw new Error("汇报房间标识无效");
        this.memberWorkspaces.ensureReport(parts[1], parts[2]);
      }
      this.store.validateRoomId(id);
      if (method === "room.send")
        params = {
          ...params,
          attachments: resolveAttachments(
            this.store.dataDirectory,
            params.attachments,
          ).map(withoutPath),
        };
      if (method === "room.react")
        return this.rooms.run(id, () =>
          this.roomReact(
            String(params.messageId ?? ""),
            String(params.emoji ?? ""),
          ),
        );
      return this.memberWorkspaces.invoke(method, params, id);
    }
    if (
      method.startsWith("room.") ||
      ["run.review", "run.verdict", "memory.accept", "memory.dismiss"].includes(
        method,
      )
    ) {
      const roomId = this.store.validateRoomId(params?.roomId ?? "global");
      if (roomId.startsWith("roundtable:"))
        this.roundtables.guardRoom(roomId, method);
      return this.rooms.run(roomId, () => {
        this.rooms.get(roomId);
        for (const key of ["threadId", "from"])
          if (params?.[key]) this.roomThread(String(params[key]));
        for (const key of ["messageId", "replyTo"])
          if (params?.[key]) this.roomMessageRecord(String(params[key]));
        return this.invokeCore(method, params);
      });
    }
    return this.rooms.run("global", () => this.invokeCore(method, params));
  }
  private roomThread(id: string) {
    return this.store.roomThread(id, this.roomId);
  }
  private roomMessageRecord(id: string) {
    const message = this.roomStore.get<RoomMessage>("room_messages", id);
    if (!message) throw new Error("消息不属于当前房间");
    return message;
  }
  private async invokeCore(method: string, params: any = {}): Promise<unknown> {
    const operationProject = String(
      params.projectId ??
        (typeof params.roomId === "string" &&
        params.roomId.startsWith("project:")
          ? params.roomId.slice(8)
          : ""),
    );
    if (this.removingProjects.has(operationProject))
      throw new Error("项目正在移除，请稍后操作。");
    if ([...ROUNDTABLE_READS, ...ROUNDTABLE_WRITES].includes(method as never)) {
      if (
        this.maintenance &&
        !(ROUNDTABLE_READS as readonly string[]).includes(method)
      )
        throw new Error("正在备份或恢复资料，请等完成后再操作。");
      return (ROUNDTABLE_READS as readonly string[]).includes(method)
        ? this.store.readScope(() => this.roundtables.invoke(method, params))
        : this.roundtables.invoke(method, params);
    }
    if ((JOINT_WRITES as readonly string[]).includes(method))
      throw new Error(
        "共同评审已独立成圆桌；历史项目评审只供阅读，请在圆桌开新议题。",
      );
    if (
      (JOINT_READS as readonly string[]).includes(method) &&
      this.store.get<Project>("projects", String(params.projectId))?.kind ===
        "roundtable"
    )
      throw new Error("请通过当前圆桌议题读取保存版本。");
    if (method.startsWith("projectFlow.")) {
      if (this.maintenance && !PROJECT_FLOW_READS.includes(method))
        throw new Error("正在备份或恢复资料，请等完成后再操作。");
      const result = await this.projectFlow.invoke(method, params);
      if (!PROJECT_FLOW_READS.includes(method)) void this.schedule();
      return result;
    }
    if (
      [
        "workspace.apply",
        "workspace.undo",
        "workspace.discard",
        "session.update",
        "session.delete",
        "run.validate",
      ].includes(method)
    ) {
      const run = params.runId
        ? this.store.get<Run>("runs", String(params.runId))
        : undefined;
      const session = this.store.get<Session>(
        "sessions",
        String(params.sessionId ?? run?.sessionId ?? ""),
      );
      if (session?.flowId)
        throw new Error(
          "项目任务由负责人复核和轮次验收管理，请在项目会议室操作。",
        );
    }
    if (
      this.maintenance &&
      ![
        "snapshot",
        "room.get",
        "room.history",
        "room.export",
        "attention.list",
        "session.events",
        "session.approvals",
        "run.inputs",
        "internal.lookup",
        "backup.list",
        "backup.preview",
        "internal.backup.beforeRestore",
        "internal.restore.cancel",
      ].includes(method)
    )
      throw new Error("正在备份或恢复资料，请等完成后再操作。");
    // Called without await so each handler runs synchronously up to its first await, exactly like one switch.
    switch (INVOKE_DOMAINS[method.split(".")[0]]) {
      case "rooms":
        return this.invokeRooms(method, params);
      case "members":
        return this.invokeMembers(method, params);
      case "work":
        return this.invokeWork(method, params);
      case "automation":
        return this.invokeAutomation(method, params);
      case "data":
        return this.invokeData(method, params);
      default:
        throw new Error(UNAVAILABLE_OPERATION);
    }
  }
  /** Rooms, desks, reports, discussion memory and attachments. */
  private async invokeRooms(method: string, params: any): Promise<unknown> {
    switch (method) {
      case "desk.open": {
        const roomId: RoomId = `desk:${String(params.memberId)}`;
        return this.memberWorkspaces.get(
          this.store.get("personal_rooms", roomId)
            ? roomId
            : this.memberWorkspaces.ensureMember(String(params.memberId)),
        );
      }
      case "desk.folder": {
        this.memberWorkspaces.ensureMember(String(params.memberId));
        return {
          directory: this.memberWorkspaces.folder(String(params.memberId)),
        };
      }
      case "desk.switchFolder":
        return this.memberWorkspaces.switchFolder(
          String(params.memberId),
          params,
        );
      case "desk.topic":
        return this.memberWorkspaces.newTopic(
          this.memberWorkspaces.ensureMember(String(params.memberId)),
          params,
        );
      case "report.open":
        return this.memberWorkspaces.get(
          this.memberWorkspaces.ensureReport(
            String(params.projectId),
            String(params.memberId),
          ),
        );
      case "report.work":
        return this.memberWorkspaces.work(
          String(params.projectId),
          String(params.memberId),
        );
      case "attention.list":
        return this.attention();
      case "attention.dismiss": {
        const result = dismissAttention(
          this.store,
          this.providers,
          new Set(this.approvals.keys()),
          params.id,
          params.fingerprint,
        );
        this.broadcast();
        return result;
      }
      case "projectRoom.ensure": {
        if (this.maintenance)
          throw new Error("正在备份或恢复资料，请等完成后再操作。");
        const thread = this.store.ensureProjectRoom(String(params.projectId));
        this.broadcast();
        return { roomId: thread.roomId, threadId: thread.id };
      }
      case "room.get":
        return this.store.roomView(this.roomId);
      case "room.send":
        return this.roomSend(params);
      case "room.generateImage":
        return this.roomGenerateImage(params);
      case "room.stop":
        return this.roomId.startsWith("roundtable:")
          ? this.roundtables.interruptRoom(this.roomId)
          : this.roomStop();
      case "room.handoff":
        return this.roomHandoff(params);
      case "room.pause":
        return this.discussion.pause();
      case "room.end": {
        const state = this.roomStore.roomState(),
          d = state.discussion;
        if (
          state.mode !== "discuss" ||
          !d ||
          typeof params.discussionId !== "string" ||
          params.discussionId !== d.id
        )
          throw new Error("讨论已切换，请刷新后再结束。");
        if (d.phase === "idle") return { ended: true };
        const running = this.roomRunning;
        await this.roomStop();
        await running;
        return this.discussion.finishByUser(
          params.acknowledgeUnknown === true,
          params.discussionId,
        );
      }
      case "room.resume":
        return this.discussion.resume(params ?? {});
      case "room.minutes":
        return this.discussion.requestMinutes(params ?? {});
      case "room.host":
        return this.discussion.hostChoice(params ?? {});
      case "room.react":
        return this.roomReact(
          String(params.messageId ?? ""),
          String(params.emoji ?? ""),
        );
      case "room.clear":
        return this.roomClear();
      case "room.uninherit":
        return this.roomUninherit(String(params.threadId ?? ""));
      case "memory.sources":
        return memorySources(String(params.executor ?? ""));
      case "memory.read":
        return memoryCandidates(
          String(params.executor ?? ""),
          String(params.source ?? ""),
        );
      case "memory.accept":
        return this.acceptMemories(params);
      case "memory.dismiss": {
        const thread = this.roomThread(String(params.threadId ?? ""));
        if (thread.summary?.proposals) {
          const { proposals: _handled, ...summary } = thread.summary;
          this.roomStore.put("room_threads", thread.id, { ...thread, summary });
          this.broadcast();
        }
        return { dismissed: true };
      }
      case "room.archive":
        return this.roomArchive(
          params.title,
          Boolean(params.inherit),
          params.memberId,
          params.from == null ? undefined : String(params.from),
        );
      case "room.compress":
        return this.roomCompress(
          String(params.threadId ?? this.roomStore.currentRoomThread().id),
          params.memberId,
        );
      case "room.rename":
        return this.roomRename(String(params.threadId ?? ""), params.title);
      case "room.delete":
        return this.roomDelete(String(params.threadId ?? ""));
      case "room.history":
        return this.roomStore.roomHistory(
          String(params.threadId ?? this.roomStore.currentRoomThread().id),
          params.before == null ? undefined : String(params.before),
          bounded(params.limit, 1, 200, 100),
        );
      case "room.export":
        return this.roomExport(
          String(params.threadId ?? this.roomStore.currentRoomThread().id),
        );
      case "attachment.import":
        return importAttachments(this.store.dataDirectory, params.paths);
      default:
        throw new Error(UNAVAILABLE_OPERATION);
    }
  }
  /** Members, executor programs, versions, accounts and connectivity. */
  private async invokeMembers(method: string, params: any): Promise<unknown> {
    switch (method) {
      case "catalog.list":
        return {
          revision: CATALOG_REVISION,
          items: catalogStatuses(this.store, this.settings).map((item) => ({
            ...item,
            installation: this.memberInstallations.get(item.provider),
          })),
          node: nodeRuntimeInfo(this.settings),
        };
      case "catalog.installation":
        return this.memberInstallations.get(
          catalogProvider(catalogEntry(params.id).id),
        );
      case "catalog.latest": {
        const entry = catalogEntry(params.id);
        return {
          version: await latestVersion(
            entry.id,
            buildEnvironment(this.settings),
            this.store.dataDirectory,
          ),
        };
      }
      case "catalog.install":
        return this.catalogOperation(params, true);
      case "catalog.use":
        return this.catalogOperation(params, false);
      case "catalog.remove": {
        const entry = catalogEntry(params.id),
          provider = catalogProvider(entry.id);
        if (this.active.size) throw new Error("请先停止当前任务。");
        return this.memberOperation(provider, async () => {
          await removeVersion(
            this.store.dataDirectory,
            entry.id,
            String(params.version),
            () => {
              if(this.active.size)throw new Error("任务已开始运行，未删除版本。");
              assertCatalogVersionUnused(
                this.store,
                this.settings,
                entry.id,
                String(params.version),
              );
            },
          );
          return { removed: true };
        });
      }
      case "catalog.credentials": {
        const entry = catalogEntry(params.id),
          provider = catalogProvider(entry.id);
        if (!isAcpId(provider))
          throw new Error("内置成员请使用各自的登录入口。");
        if (this.active.size)
          throw new Error("请先停止当前任务，再修改登录方式。");
        return this.memberOperation(provider, async () => {
          const previous = this.require<AcpExecutor>("executors", provider);
          if (previous.catalogId !== entry.id)
            throw new Error("这个连接不是清单管理的执行端。");
          const { executor, secrets } = catalogAuthentication(previous, params);
          const authenticationChanged = (previous.authentication ?? (entry.id === 'zcode' ? 'zai' : undefined)) !== executor.authentication;
          if (entry.id === 'zcode' && authenticationChanged) {
            for (const session of this.store.list<Session>('sessions').filter(item => item.provider === provider)) {
              // Canonical AIROOM history remains; a new account must not resume a thread pinned to the old provider.
              this.store.put('sessions', session.id, { ...session, nativeId: undefined, nativeHome: undefined });
            }
          }
          for (const value of Object.values(secrets)) registerSecret(value);
          if (
            entry.modelConfiguration?.resetOnAuthenticationChange &&
            authenticationChanged
          ) {
            const models = { ...this.settings.models },
              efforts = { ...this.settings.efforts };
            delete models[provider];
            delete efforts[provider];
            this.settings = { ...this.settings, models, efforts };
            this.store.put("settings", "main", this.settings);
          }
          this.acpSecrets.set(provider, secrets);
          this.store.put("executors", provider, executor);
          await this.invalidateRuntimes(provider);
          const known = this.providers.find((item) => item.id === provider);
          if (known) this.publishProvider({ ...known, stale: true });
          this.broadcast();
          return { saved: !!Object.keys(secrets).length, executor };
        });
      }
      case "provider.probe":
        await this.invalidateRuntimes(params.provider);
        return this.probe(params.provider);
      case 'provider.logout': {
        const id=String(params.provider) as ProviderId;
        if(!this.executorIds().includes(id))throw new Error('执行端不存在。');
        if(this.active.size||this.memberOperations.has(id)||this.acpLogins.has(id))throw new Error('请先停止当前任务、取消登录或等待下载完成，再登出。');
        this.memberOperations.add(id);
        try{
          await this.invalidateRuntimes(id,true);
          await logoutProvider(id,this.settings,buildEnvironment(this.settings),this.store.executors().find(item=>item.id===id));
          this.providers=this.providers.map(info=>info.id===id?{...info,auth:'none' as const,available:false,stale:true,quota:undefined,detail:'已登出，请重新登录。'}:info);
          this.store.delete('quotas',id);this.probeRevisions.set(id,(this.probeRevisions.get(id)??0)+1);
          const info=this.providers.find(item=>item.id===id);if(info)this.store.put('providers',id,info);
          this.executorLoginStates.delete(id);this.broadcast();return {loggedOut:true};
        }finally{this.memberOperations.delete(id);void this.schedule();}
      }
      case "provider.compatibility":
        return this.store
          .list<CompatibilityReport>("compatibility_reports")
          .filter((r) => r.provider === params.provider)
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
          .slice(0, 50);
      case "provider.config": {
        const id = String(params.provider) as ProviderId;
        if (!this.executorIds().includes(id)) throw new Error("执行端不存在");
        const choice = normalizeConfigSelection({
          model: params.model ?? null,
        });
        const settings = {
          ...this.settings,
          models: { ...this.settings.models, [id]: choice.model ?? undefined },
          efforts: { ...this.settings.efforts, [id]: undefined },
        };
        return this.inspectProvider(id, settings, "configuration");
      }
      case "provider.balance": {
        if (params.provider !== "dsh")
          throw new Error("这位成员程序尚未提供账户余额接口。");
        return this.refreshBalance();
      }
      case "provider.quota": {
        if (params.provider !== "claude" && params.provider !== "codex")
          throw new Error("这位成员程序尚未提供独立的额度刷新接口。");
        return this.refreshQuota(params.provider);
      }
      case "network.check":
        return checkNetwork(this.settings);
      case "member.versions":
        return this.memberVersions(params.provider, !!params.checkLatest);
      case "member.installation":
        return this.memberInstallations.get(this.member(params.provider));
      case "member.install": {
        // Explicit, user-initiated update: install alongside existing versions, then switch to it.
        const member = this.member(params.provider);
        if (this.active.size)
          throw new Error("请先停止正在运行的成员，再切换版本");
        if (!this.store.get("catalog_consents", member))
          try {
            await this.memberProgram(member);
          } catch {
            throw new Error("首次使用请从内置清单阅读厂商条款后下载。");
          }
        return this.memberOperation(member, async () => {
          const startedAt = now();
          this.memberInstallations.set(member, {
            version: String(params.version),
            phase: "installing",
            startedAt,
            phaseStartedAt: startedAt,
          });
          try {
            const item = await this.memberInstaller(
              this.store.dataDirectory,
              member,
              String(params.version),
              buildEnvironment(this.settings),
              {
                requireIntegrity: true,
                progress: (value) => {
                  const current = this.memberInstallations.get(member);
                  if (!current) return;
                  this.memberInstallations.set(member, {
                    ...current,
                    ...value,
                    phaseStartedAt:
                      current.phase === value.phase
                        ? current.phaseStartedAt
                        : now(),
                  });
                },
              },
            );
            if (this.active.size)
              return {
                ...(await this.memberVersions(member, false)),
                installation: undefined,
                installedOnly: true,
                detail: "安装已完成；有任务正在运行，请空闲后切换",
              };
            const current = this.memberInstallations.get(member)!;
            this.memberInstallations.set(member, {
              ...current,
              phase: "connection",
              phaseStartedAt: now(),
            });
            try {
              return {
                ...(await this.useMemberPath(member, item.entry)),
                installation: undefined,
              };
            } catch (error) {
              if (this.active.size)
                return {
                  ...(await this.memberVersions(member, false)),
                  installation: undefined,
                  installedOnly: true,
                  detail: (error as Error).message,
                };
              throw error;
            }
          } finally {
            this.memberInstallations.delete(member);
          }
        });
      }
      case "member.use": {
        const member = this.member(params.provider);
        if (this.active.size)
          throw new Error("请先停止正在运行的成员，再切换版本");
        return this.memberOperation(member, async () => {
          if (!params.version) return this.useMemberPath(member, undefined);
          const item = installedVersions(this.store.dataDirectory, member).find(
            (x) => x.version === params.version,
          );
          if (!item) throw new Error("该版本尚未完整安装");
          return this.useMemberPath(member, item.entry);
        });
      }
      case "member.remove": {
        const member = this.member(params.provider);
        if (this.active.size) throw new Error("请先停止正在运行的任务");
        return this.memberOperation(member, async () => {
          const version = String(params.version);
          await removeVersion(this.store.dataDirectory, member, version, () => {
            if (this.active.size) throw new Error("任务已开始运行，未删除版本");
            const selected = this.settings.paths[member];
            const relative = selected
              ? path.relative(
                  path.resolve(
                    this.store.dataDirectory,
                    "members",
                    member,
                    version,
                  ),
                  path.resolve(selected),
                )
              : undefined;
            if (
              relative !== undefined &&
              relative !== ".." &&
              !relative.startsWith(".." + path.sep) &&
              !path.isAbsolute(relative)
            )
              throw new Error("不能删除正在使用的版本，请先切换");
            assertCatalogVersionUnused(
              this.store,
              this.settings,
              member,
              version,
            );
          });
          return this.memberVersions(member, false);
        });
      }
      case "member.stop.preview":
        return this.memberStopPreview(String(params.memberId));
      case "member.stop":
        return this.stopMember(params);
      case "team.save": {
        // A card keeps its identity; changing its executor only affects new contexts.
        const members = this.store.members();
        const given = params.member ?? {};
        const existing = given.id
          ? members.find((member) => member.id === given.id)
          : undefined;
        const addingTemplate=params.addTemplate===true&&BUILTIN_MEMBERS.some(member=>member.id===given.id)&&!this.store.get('removed_members',given.id);
        if(params.addTemplate===true&&existing)throw new Error('这张模板人物卡已添加，请刷新后编辑已有人物。');
        if (given.id && !existing && !addingTemplate)
          throw new Error("这位成员不存在，请刷新工作台");
        const card = normalizeMember(
          given,
          existing,
          existing ? undefined : `m-${randomUUID().slice(0, 8)}`,
        );
        if(this.store.get('removed_providers',card.executor))throw new Error('这个执行端连接已删除，请先在连接与版本中重新添加。');
        if(this.removingExecutors.has(card.executor))throw new Error('该执行端正在删除连接，请完成后再保存人物。');
        if (
          isAcpId(card.executor) &&
          !this.store.get("executors", card.executor)
        )
          throw new Error("请先保存这个 AI 程序的连接设置");
        if (!existing && members.length >= 16)
          throw new Error("团队最多 16 位成员");
        if(existing && card.executor !== existing.executor) {
          if(this.active.size)throw new Error('请先停止当前任务，再更换人物绑定的执行端。');
          if(this.store.list<import('../shared/project-flow').ProjectFlow>('project_flows').some(flow=>flow.memberIds?.includes(card.id)&&!['completed','cancelled'].includes(flow.status)))throw new Error('请先结束项目流程，再更换人物绑定的执行端。');
          card.model=undefined;card.effort=undefined;
        }
        await this.roomRuntimes.invalidate(
          (key) =>
            (this.store.get<Session>("sessions", key)?.memberId ??
              this.store.get<Session>("sessions", key)?.provider) === card.id,
        );
        if(existing&&card.executor!==existing.executor){
          if(this.active.size||this.store.members().find(member=>member.id===card.id)?.executor!==existing.executor)throw new Error('成员任务或绑定已变化，请停止任务并刷新后重试。');
          this.store.transaction(()=>{
            for(const session of this.store.list<Session>('sessions').filter(session=>(session.memberId??session.provider)===card.id&&!session.flowId)){
              const config=this.runConfiguration(session);
              this.store.put('sessions',session.id,{...session,model:session.model??config.model,effort:session.effort??config.effort});
            }
            for(const project of this.store.list<Project>('projects').filter(project=>project.memberConfigs?.[card.id])){
              const memberConfigs={...project.memberConfigs};delete memberConfigs[card.id];
              this.store.put('projects',project.id,{...project,memberConfigs,memberConfigRevision:(project.memberConfigRevision??0)+1});
            }
            this.store.put('members',card.id,card);
          });
        }else this.store.put('members',card.id,card);
        this.memberWorkspaces.folder(card.id,true);this.memberWorkspaces.ensureMember(card.id);
        this.broadcast();
        return card;
      }
      case "executor.save": {
        const given = params.executor ?? {};
        const existing = given.id
          ? this.store.get<AcpExecutor>("executors", String(given.id))
          : undefined;
        if (given.id && !existing)
          throw new Error("这个外接程序不存在，请刷新工作台");
        if (given.id && this.acpLogins.has(String(given.id)))
          throw new Error("请完成或取消登录后再修改连接。");
        if (!existing && this.store.executors().length >= 12)
          throw new Error("最多接入 12 个外接程序");
        const executor = normalizeExecutor(
          given,
          existing ? { ...existing, permissions: this.permissionsFor(existing.id, this.settings) } : undefined,
          existing
            ? undefined
            : (`acp-${randomUUID().replace(/-/g, "").slice(0, 12)}` as AcpExecutorId),
        );
        // Secret values never reach the database or a snapshot, even when sent as ordinary variables.
        const previous = this.acpSecrets.get(executor.id) ?? {},
          secrets: Record<string, string> = {};
        for (const [key, value] of Object.entries(
          params.secrets && typeof params.secrets === "object"
            ? params.secrets
            : {},
        ))
          if (
            isSecretName(key) &&
            /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) &&
            typeof value === "string" &&
            value
          )
            secrets[key] = value.slice(0, 4096);
        for (const key of Object.keys(executor.env))
          if (isSecretName(key)) {
            const value = executor.env[key];
            delete executor.env[key];
            const resolved =
              value === SECRET_PLACEHOLDER ? previous[key] : value;
            if (resolved) secrets[key] = resolved;
          }
        for (const value of Object.values(secrets)) registerSecret(value);
        executor.secretKeys = Object.keys(secrets).sort();
        this.acpSecrets.set(executor.id, secrets);
        this.store.put("executors", executor.id, executor);
        this.settings = { ...this.settings, permissions: { ...this.settings.permissions, [executor.id]: executor.permissions } };
        this.store.put("settings", "main", this.settings);
        rememberExecutors(this.store.executors());
        await this.invalidateRuntimes(executor.id);
        const known = this.providers.find((info) => info.id === executor.id);
        if (known)
          this.publishProvider({ ...known, name: executor.name, stale: true });
        this.broadcast();
        void this.probe(executor.id).catch(() => {});
        return executor;
      }
      case 'executor.restore': {
        const id=String(params.id) as ProviderId;
        if (!['codex','claude','dsh'].includes(id)) throw new Error('所选内置执行端不存在。');
        this.store.delete('removed_providers', id);
        this.broadcast();
        return { restored:true };
      }
      case "executor.delete": {
        const id = String(params.id);
        const builtin=['codex','claude','dsh'].includes(id);
        if (!builtin && (!isAcpId(id) || !this.store.get("executors", id)))
          throw new Error("这个执行端不存在");
        return this.memberOperation(id, async () => {
        this.removingExecutors.add(id);
        try {
        if (this.acpLogins.has(id))
          throw new Error("请完成或取消登录后再删除连接。");
        const users = this.store
          .members()
          .filter((member) => member.executor === id);
        if (users.length)
          throw new Error(
            `还有成员在使用它：${users.map((member) => member.name).join("、")}`,
          );
        for (const session of this.store
          .list<Session>("sessions")
          .filter((item) => item.provider === id))
          this.requireIdle(session.id, "删除外接程序");
        await this.invalidateRuntimes(id as ProviderId);
        if (builtin) {
          const provider=id as ProviderId,paths={...this.settings.paths};
          delete paths[provider];
          this.settings={...this.settings,paths};
          this.store.put('settings','main',this.settings);
          this.cancelProbeRetry(provider);
          this.probeRevisions.set(provider,(this.probeRevisions.get(provider)??0)+1);
          this.store.put('removed_providers',provider,{id:provider,at:now()});
          this.store.delete('providers',provider);
          this.providers=this.providers.filter(info=>info.id!==provider);
        } else this.removeExecutor(id as AcpExecutorId);
        this.broadcast();
        return { deleted: true };
        } finally { this.removingExecutors.delete(id); }
        });
      }
      case "executor.authenticate": {
        const executor = this.require<AcpExecutor>(
          "executors",
          String(params.id),
        );
        if (this.active.size || this.memberOperations.has(executor.id))
          throw new Error("请先等待当前任务或下载完成，再登录执行端。");
        if (this.acpLogins.has(executor.id))
          throw new Error("登录正在进行，请在已打开的页面里完成");
        const adapter = this.externalAdapter(executor);
        this.acpLogins.add(executor.id);
        this.executorLoginAdapters.set(executor.id, adapter);
        this.executorLoginStates.set(executor.id, {
          phase: "starting",
          message: "正在启动官方登录…",
        });
        let authorized = false;
        try {
          await this.invalidateRuntimes(executor.id, true);
          const result = await adapter.authenticate(
            buildEnvironment(this.settings),
            params.methodId == null ? undefined : String(params.methodId),
            (state) => {
              if (
                this.executorLoginStates.get(executor.id)?.phase !== "cancelled"
              ) {
                this.executorLoginStates.set(executor.id, state);
                this.push({ type: "executor-login", id: executor.id, state });
              }
            },
          );
          if (this.executorLoginStates.get(executor.id)?.phase === "cancelled")
            throw new Error("登录已取消。");
          authorized = true;
          this.executorLoginStates.set(executor.id, {
            phase: "completed",
            message: "官方授权已完成，正在检查连接。",
          });
          return {
            detail: `${executor.name} 已完成登录（${result.method}）。`,
          };
        } catch (error) {
          if (this.executorLoginStates.get(executor.id)?.phase !== "cancelled")
            this.executorLoginStates.set(executor.id, {
              phase: "failed",
              message: executor.catalogId === "zcode" && error instanceof Error
                ? String(redact(error.message)).slice(0,400)
                : "官方登录没有完成，请重试或检查网络。",
            });
          throw error;
        } finally {
          const completed=this.executorLoginStates.get(executor.id);
          if (
            this.alive && authorized &&
            this.executorLoginStates.get(executor.id)?.phase !== "cancelled"
          ) {
            const check=this.probe(executor.id).then(()=>{
              if(!this.alive||this.executorLoginStates.get(executor.id)!==completed)return;
              const info=this.providers.find(item=>item.id===executor.id);
              const state:CatalogLoginState={phase:'completed',message:info?.available?'官方授权已完成，连接检查通过。':`官方授权已完成，连接检查未通过：${info?.detail||'请重新检查成员连接。'}`};
              this.executorLoginStates.set(executor.id,state);this.push({type:'executor-login',id:executor.id,state});
            }).catch(()=>{});
            this.loginChecks.add(check);
            void check.finally(()=>this.loginChecks.delete(check));
          }
          this.acpLogins.delete(executor.id);
          this.executorLoginAdapters.delete(executor.id);
          if (this.alive) void this.schedule();
        }
      }
      case "executor.loginStatus":
        return this.executorLoginStates.get(String(params.id));
      case "executor.cancelLogin": {
        const id = String(params.id),
          adapter = this.executorLoginAdapters.get(id);
        if (adapter) {
          this.executorLoginStates.set(id, {
            phase: "cancelled",
            message: "登录已取消。",
          });
          await adapter.stop();
        }
        return { cancelled: !!adapter };
      }
      case "team.visibility": {
        const member = this.store
          .members()
          .find((item) => item.id === String(params.id));
        if (!member) throw new Error("这位成员不存在");
        if (typeof params.hidden !== "boolean")
          throw new Error("请选择显示或隐藏人物卡");
        const card = { ...member, cardHidden: params.hidden };
        this.store.put("members", member.id, card);
        // Visibility never invalidates a native context or stops a connection/turn.
        this.broadcast();
        return card;
      }
      case "team.delete": {
        const member = this.store
          .members()
          .find((item) => item.id === String(params.id));
        if (!member) throw new Error("这位成员不存在");
        if (params.folderChoice !== undefined && params.folderChoice !== "keep")
          throw new Error("删除人物卡会保留个人文件夹和成果，不能同时删除文件");
        const sessions = this.store
          .list<Session>("sessions")
          .filter(
            (session) => (session.memberId ?? session.provider) === member.id,
          );
        for (const session of sessions)
          this.requireIdle(session.id, "删除成员");
        const folder = this.memberWorkspaces.preserveMemberFolder(member.id);
        const {
          id,
          executor,
          name,
          color,
          portrait,
          avatar,
          portraitScale,
          portraitOffset,
          face,
          avatarFace,
          templateId,
          builtIn,
        } = member;
        // Retain only attribution for history. Sessions, native IDs, outputs and shared executors stay intact.
        this.store.transaction(() => {
          this.store.put("removed_members", id, {
            id,
            executor,
            name,
            color,
            portrait,
            avatar,
            portraitScale,
            portraitOffset,
            face,
            avatarFace,
            templateId,
            builtIn,
          });
          this.store.delete("members", id);
          const overrides = { ...this.settings.memberPermissions };
          delete overrides[id];
          this.settings = { ...this.settings, memberPermissions: overrides };
          this.store.put("settings", "main", this.settings);
          for (const project of this.store
            .list<Project>("projects")
            .filter(
              (project) =>
                !project.kind &&
                (project.memberIds?.includes(id) ||
                  project.memberConfigs?.[id]),
            )) {
            const configs = { ...project.memberConfigs };
            delete configs[id];
            this.store.put("projects", project.id, {
              ...project,
              memberIds: project.memberIds?.filter((value) => value !== id),
              memberConfigs: configs,
            });
          }
        });
        const sessionIds = new Set(sessions.map((session) => session.id));
        await this.roomRuntimes.invalidate((key) => sessionIds.has(key));
        this.broadcast();
        return { deleted: true, sessions: sessions.length, folder };
      }
      case "team.reset": {
        const member = BUILTIN_MEMBERS.find(
          (item) => item.id === String(params.id),
        );
        if (!member) throw new Error("只有内置成员可以恢复默认资料");
        const current = this.store
          .members()
          .find((item) => item.id === member.id);
        if (!current) throw new Error("这张人物卡已删除，请添加新成员");
        this.store.put("members", member.id, { ...member, executor:current.executor, cardHidden:current.cardHidden });
        await this.roomRuntimes.invalidate(
          (key) =>
            (this.store.get<Session>("sessions", key)?.memberId ??
              this.store.get<Session>("sessions", key)?.provider) === member.id,
        );
        this.broadcast();
        return this.store.members().find((item) => item.id === member.id);
      }
      case "profile.save": {
        const given = params.profile ?? {};
        const name =
          typeof given.name === "string" ? given.name.trim().slice(0, 40) : "";
        if (!name) throw new Error("名字不能为空");
        const avatar =
          typeof given.avatar === "string" &&
          /^[a-f0-9-]{8,64}\.(png|jpe?g|webp|gif)$/i.test(given.avatar)
            ? given.avatar
            : undefined;
        const profile: UserProfile = { name, ...(avatar ? { avatar } : {}) };
        this.store.put("profile", "main", profile);
        await this.roomRuntimes.invalidate();
        this.broadcast();
        return profile;
      }
      case "persona.import":
        return this.importPersona(String(params.executor));
      default:
        throw new Error(UNAVAILABLE_OPERATION);
    }
  }
  /** Projects, sessions, runs, approvals, work copies and legacy collaborations. */
  private async invokeWork(method: string, params: any): Promise<unknown> {
    switch (method) {
      case "project.openPath":
        return new RoundResultReader(this.store).openPath(params);
      case "project.create": {
        // A relative path would resolve against the app install directory, never the user's intent.
        const requested = String(params.directory || "").trim();
        if (!path.isAbsolute(requested))
          throw new Error(
            "请填写项目文件夹的完整路径，例如 C:\\Users\\你\\Desktop\\项目",
          );
        const directory = path.resolve(requested);
        const info = await stat(directory).catch(() => undefined);
        if (!info?.isDirectory())
          throw new Error("找不到这个文件夹，请检查路径");
        const project = this.projectTree.create(directory, params);
        this.broadcast();
        return project;
      }
      case "project.move": {
        const project = this.projectTree.move(params);
        this.broadcast();
        return project;
      }
      case "session.create":
        return this.createSession(
          params.projectId,
          params.provider,
          params.title,
          params.writeMode,
          params.memberId ? String(params.memberId) : undefined,
        );
      case "session.approvals": {
        // Revoke or grant session-level auto-approval; takes effect on the next request.
        const session = this.require<Session>(
          "sessions",
          String(params.sessionId),
        );
        const next = {
          ...session,
          ...(typeof params.autoApprove === "boolean"
            ? { autoApprove: params.autoApprove }
            : {}),
          ...(params.clearRules ? { approvalRules: [] } : {}),
        };
        this.store.put("sessions", session.id, next);
        this.broadcast();
        await this.roomRuntimes.closeSession(session.id);
        // Codex's `never` policy is fixed for an active turn. Stop it when revoking automatic approval.
        const running = [...this.active.values()].find(
          (active) => active.ctx.session.id === session.id,
        );
        if (
          session.autoApprove &&
          next.autoApprove === false &&
          running &&
          session.provider === "codex" &&
          running.ctx.session.writeMode &&
          running.ctx.settings.permissions.codex.commands === "auto" &&
          running.ctx.settings.permissions.codex.fileScope === "any"
        ) {
          this.emit(
            running.ctx,
            "status",
            "已关闭会话自动批准，停止当前 Codex 轮次；下一轮按成员权限重新启动。",
            undefined,
            "derived",
          );
          await this.stopRun(running.ctx.run.id);
        }
        return next;
      }
      case "session.update": {
        const result = this.updateSession(String(params.sessionId), params);
        await this.roomRuntimes.closeSession(String(params.sessionId));
        return result;
      }
      case "session.delete":
        return this.deleteSession(
          String(params.sessionId),
          params.discardWorkspace !== false,
        );
      case "project.update": {
        const project = this.require<Project>(
            "projects",
            String(params.projectId),
          ),
          next = { ...project };
        if (
          params.name === undefined &&
          params.memberIds === undefined &&
          params.writeWorkLogs === undefined &&
          params.memberConfigs === undefined &&
          params.projectRecordToFolder === undefined
        )
          throw new Error("请提供项目名称、参会成员名单或项目设置");
        if (params.writeWorkLogs !== undefined) {
          if (typeof params.writeWorkLogs !== "boolean")
            throw new Error("日志设置必须是开或关");
          next.writeWorkLogs = params.writeWorkLogs;
        }
        if (params.projectRecordToFolder !== undefined) {
          if (typeof params.projectRecordToFolder !== "boolean")
            throw new Error("记录设置必须是开或关");
          next.projectRecordToFolder = params.projectRecordToFolder;
        }
        if (params.name !== undefined) {
          const name = String(params.name ?? "").trim();
          if (!name) throw new Error("项目名称不能为空");
          next.name = name.slice(0, 120);
        }
        if (params.memberIds !== undefined) {
          const ids = params.memberIds,
            known = new Set(this.store.members().map((member) => member.id));
          if (
            !Array.isArray(ids) ||
            ids.some((id) => typeof id !== "string" || !known.has(id))
          )
            throw new Error("参会名单必须是已存在成员的编号数组");
          next.memberIds = [...new Set<string>(ids)];
        }
        const changedMembers: string[] = [];
        if (params.memberConfigs !== undefined) {
          if (
            params.expectedConfigRevision !== undefined &&
            params.expectedConfigRevision !==
              (project.memberConfigRevision ?? 0)
          )
            throw new Error("项目成员配置已更新，请刷新后再保存");
          if (
            !params.memberConfigs ||
            typeof params.memberConfigs !== "object" ||
            Array.isArray(params.memberConfigs)
          )
            throw new Error("项目成员配置必须是按成员保存的对象");
          const known = new Set(
            this.store.members().map((member) => member.id),
          );
          next.memberConfigs = { ...project.memberConfigs };
          for (const [memberId, value] of Object.entries(
            params.memberConfigs,
          )) {
            if (!known.has(memberId)) throw new Error("配置中的成员不存在");
            const choice =
              value === null ? {} : normalizeConfigSelection(value);
            if (
              JSON.stringify(next.memberConfigs[memberId] ?? {}) !==
              JSON.stringify(choice)
            )
              changedMembers.push(memberId);
            if (Object.keys(choice).length)
              next.memberConfigs[memberId] = choice;
            else delete next.memberConfigs[memberId];
          }
          if (changedMembers.length)
            next.memberConfigRevision = (project.memberConfigRevision ?? 0) + 1;
        }
        this.store.transaction(() => {
          this.store.put("projects", project.id, next);
          for (const flow of this.store
            .list<import("../shared/project-flow").ProjectFlow>("project_flows")
            .filter(
              (flow) =>
                flow.projectId === project.id &&
                !["completed", "cancelled"].includes(flow.status),
            )) {
            const relevant = changedMembers.filter((id) =>
              flow.memberIds.includes(id),
            );
            if (!relevant.length) continue;
            this.store.put("project_flows", flow.id, {
              ...flow,
              revision: flow.revision + 1,
              updatedAt: now(),
              memberConfigs: {
                ...flow.memberConfigs,
                ...Object.fromEntries(
                  relevant.map((id) => [
                    id,
                    this.projectConfiguration(next, id),
                  ]),
                ),
              },
            });
          }
        });
        this.broadcast();
        return next;
      }
      case "project.remove":
        return this.removeProject(
          String(params.projectId),
          params.discardWorkspaces !== false,
        );
      case "workspace.apply": {
        const session = this.require<Session>(
          "sessions",
          String(params.sessionId),
        );
        this.assertSessionUsable(session);
        if (
          !session.workspace ||
          session.workspaceKind === "original" ||
          !session.workspaceKind
        )
          throw new Error("这个会话直接在项目里工作，没有需要应用的副本");
        const project = this.require<Project>("projects", session.projectId);
        return this.workspaceOperation(session, "应用改动", () =>
          withProjectWrite(
            this.store,
            project.id,
            project.directory,
            async (check) => {
              const checkpoint = await checkpointInfo(
                session,
                this.store.dataDirectory,
              );
              const result = await applyWorkspace(
                session.workspace!,
                project.directory,
                (paths) => {
                  check();
                  assertProjectPaths(this.store, project.id, paths);
                },
                checkpoint.status === "available"
                  ? checkpoint.runId
                  : undefined,
              );
              if (result.conflicts.length)
                this.store.put("workspace_conflicts", session.id, {
                  sessionId: session.id,
                  workspace: session.workspace,
                  at: now(),
                  conflicts: result.conflicts,
                });
              else this.store.delete("workspace_conflicts", session.id);
              this.broadcast();
              return result;
            },
            true,
          ),
        );
      }
      case "workspace.discard": {
        const session = this.require<Session>(
          "sessions",
          String(params.sessionId),
        );
        return this.workspaceOperation(session, "丢弃副本", async () => {
          await discardWorkspace(
            session,
            this.require<Project>("projects", session.projectId),
            this.store.dataDirectory,
          );
          await removeCheckpoint(session.id, this.store.dataDirectory).catch(
            () => {},
          );
          // The next turn builds a fresh copy from the project as it is then.
          const next = {
            ...session,
            workspace: undefined,
            workspaceKind: undefined,
            updatedAt: now(),
          };
          this.store.put("sessions", session.id, next);
          this.store.delete("workspace_conflicts", session.id);
          for (const run of this.store
            .list<Run>("runs")
            .filter(
              (run) =>
                run.sessionId === session.id &&
                run.workspaceUndo?.status === "available",
            ))
            this.persistRun(run, {
              workspaceUndo: {
                status: "unavailable",
                reason: "工作副本已丢弃",
              },
            });
          this.broadcast();
          return next;
        });
      }
      case "workspace.undo.info": {
        const session = this.require<Session>(
            "sessions",
            String(params.sessionId),
          ),
          info = await checkpointInfo(session, this.store.dataDirectory);
        if (info.runId && session.workspace)
          info.projectUndo = await projectUndoInfo(
            session.workspace,
            info.runId,
            this.require<Project>("projects", session.projectId).directory,
          );
        return info;
      }
      case "workspace.undo":
        return this.undoWorkspace(
          String(params.sessionId),
          String(params.runId),
          params.restoreUnchanged === true,
        );
      case "run.review":
        return this.reviewRun(params);
      case "run.verdict":
        return this.runVerdict(params);
      case "session.send":
        return this.send(
          params.sessionId,
          String(params.text || ""),
          params.intent || "message",
          undefined,
          resolveAttachments(this.store.dataDirectory, params.attachments).map(
            withoutPath,
          ),
        );
      case "session.events": {
        this.require<Session>("sessions", String(params.sessionId));
        return this.store.listEvents(String(params.sessionId));
      }
      case "run.inputs": {
        // The snapshot carries previews only; retry, export and the session view read the exact task here.
        const ids = Array.isArray(params.runIds) ? params.runIds.map(String).slice(0, 500) : [];
        return Object.fromEntries(
          ids.flatMap((id: string) => {
            const run = this.store.get<Run>("runs", id);
            return run ? [[id, run.input]] : [];
          }),
        );
      }
      case "run.nudge": {
        const runId = String(params.runId);
        this.require<Run>("runs", runId);
        // One durable receipt per attempt, including unknown delivery, prevents
        // another window or a reload from repeating this fixed request.
        const delivery = await this.steerActive(
          runId,
          "请尽快收尾这一份工作，给出已有成果，并如实说明尚未完成或未核实的部分。不要扩大任务范围，不要为了收尾虚报完成。",
          `run-nudge:${runId}`,
        );
        return { delivery };
      }
      case "run.stop":
        await this.stopRun(String(params.runId));
        return { received: true };
      case "all.stop":
        await this.stopAll();
        return { received: true };
      case "approval.answer":
        return this.answer(params);
      case "artifact.list": {
        const session = this.require<Session>("sessions", params.sessionId);
        if (session.restoredHistoryOnly) return [];
        const project = this.require<Project>("projects", session.projectId);
        let files = await listArtifacts(session.workspace || project.directory);
        const outputs = path.join(
          this.store.dataDirectory,
          "artifacts",
          session.id,
        );
        try {
          files = [
            ...files,
            ...(await listArtifacts(outputs)).map((x) => ({
              ...x,
              relativePath: `@artifacts/${x.relativePath}`,
            })),
          ];
        } catch {}
        return files;
      }
      case "artifact.read": {
        const session = this.require<Session>("sessions", params.sessionId);
        this.assertSessionUsable(session);
        const project = this.require<Project>("projects", session.projectId);
        const output = String(params.relativePath);
        const root = output.startsWith("@artifacts/")
          ? path.join(this.store.dataDirectory, "artifacts", session.id)
          : session.workspace || project.directory;
        const result = await readArtifact(
          root,
          output.startsWith("@artifacts/") ? output.slice(11) : output,
        );
        const content = redact(result.content);
        return {
          ...result,
          content:
            content === result.content
              ? content
              : `[AIROOM：敏感凭据已脱敏；源文件未改动]\n${content}`,
        };
      }
      case "project.diff": {
        const session = this.require<Session>("sessions", params.sessionId);
        if (session.restoredHistoryOnly)
          return {
            text: "备份不包含工作副本，本会话仅保留历史；当前项目文件未被恢复。",
          };
        return diffWorkspace(
          session.workspace ||
            this.require<Project>("projects", session.projectId).directory,
        );
      }
      case "run.validate": {
        const run = this.require<Run>("runs", params.runId);
        this.assertSessionUsable(
          this.require<Session>("sessions", run.sessionId),
        );
        if (
          run.workspaceUndo?.status === "undone" ||
          run.workspaceUndo?.status === "capturing"
        )
          throw new Error("本轮文件改动已撤销或还原点尚未完成，不能验收。");
        if (!["ended", "completed"].includes(run.status))
          throw new Error(
            "先核对当前执行状态；未结束或结果未知的任务不能直接验收完成",
          );
        this.persistRun(run, {
          status: "completed",
          validation:
            String(params.validation ?? "").trim() ||
            "用户确认验收，未补充说明。",
        });
        return { saved: true };
      }
      case "collaboration.start":
        return this.startCollaboration(params);
      case "collaboration.pause":
        return this.pauseCollaboration(params.id);
      case "collaboration.resume":
        return this.resumeCollaboration(params.id);
      default:
        throw new Error(UNAVAILABLE_OPERATION);
    }
  }
  /** Timed jobs, policies and the automatic budget. */
  private async invokeAutomation(method: string, params: any): Promise<unknown> {
    switch (method) {
      case "automation.list":
        return this.snapshot().automation;
      case "automation.policy.save": {
        const policies = AutomaticBudget.validate(params.policies),
          dailyLife =
            params.dailyLife === undefined
              ? this.settings.dailyLife
              : validateDailyLife(params.dailyLife);
        this.settings = {
          ...this.settings,
          dailyLife,
          automationPolicies: {
            ...this.settings.automationPolicies,
            ...policies,
          },
        };
        this.store.put("settings", "main", this.settings);
        this.dailyLife.sync();
        this.broadcast();
        return this.snapshot().automation;
      }
      case "automation.life.acknowledge": {
        if (
          !["daily-opening", "member-chat"].includes(params.feature) ||
          params.acknowledgeUnknown !== true
        )
          throw new Error("请先核对上次发言和活动记录，再明确恢复未来的触发。");
        this.automation.acknowledgeManaged(params.feature);
        return this.snapshot().automation;
      }
      case "automation.save":
        return this.timedJob(params);
      case "automation.remove":
        this.automation.remove(String(params.id));
        return { removed: true };
      case "automation.pause":
        this.automation.pause();
        return { paused: true };
      case "automation.resume": {
        const marker = path.join(
          this.store.dataDirectory,
          AUTOMATION_PAUSE_FILE,
        );
        if (existsSync(marker)) unlinkSync(marker);
        this.automation.resume();
        return { resumed: true };
      }
      default:
        throw new Error(UNAVAILABLE_OPERATION);
    }
  }
  /** Snapshot, settings, backups, diagnostics and main-process internals. */
  private async invokeData(method: string, params: any): Promise<unknown> {
    switch (method) {
      case "backup.list":
        return new BackupRestorer(this.store.dataDirectory).list();
      case "backup.preview":
        return new BackupRestorer(this.store.dataDirectory).preview(
          String(params.id),
        );
      case "backup.create":
        return this.createDataBackup("manual");
      case "backup.delete":
        if (params.confirm !== true) throw new Error("请先确认删除这份备份。");
        return new BackupRestorer(this.store.dataDirectory).remove(
          String(params.id),
        );
      case "internal.restore.begin":
        this.beginDataMaintenance();
        return { ready: true };
      case "internal.restore.cancel":
        this.endDataMaintenance();
        return { cancelled: true };
      case "internal.backup.beforeRestore":
        if (!this.maintenance) throw new Error("恢复前尚未暂停执行服务。");
        return this.createDataBackup("before-restore");
      case "snapshot":
        return this.snapshot();
      case "internal.room.opened": {
        if (typeof params.visible !== "boolean")
          throw new Error("窗口状态无效。");
        if (this.alive) this.dailyLife.opened(params.visible);
        return { received: this.alive };
      }
      case 'internal.provider.loginBegin': {
        const id=String(params.provider);
        if(!['claude','codex','dsh'].includes(id))throw new Error('执行端无效。');
        if(this.store.get('removed_providers',id))throw new Error('这个执行端连接已删除，请先重新添加连接。');
        if(this.active.size||this.memberOperations.has(id)||this.acpLogins.has(id))throw new Error('请先停止当前任务或等待下载完成，再登录。');
        this.acpLogins.add(id);
        try{await this.invalidateRuntimes(id as ProviderId,true);}catch(error){this.acpLogins.delete(id);throw error;}
        return {started:true};
      }
      case 'internal.provider.loginEnd':
        this.acpLogins.delete(String(params.provider));void this.schedule();return {ended:true};
      case "internal.provider.invalidate": {
        if (!params.provider || params.provider === "dsh")
          this.balanceRevision++;
        for (const id of params.provider
          ? [params.provider]
          : this.executorIds()) {
          this.cancelProbeRetry(id);
          this.probeRevisions.set(id, (this.probeRevisions.get(id) ?? 0) + 1);
          this.store.put("quotas", id, {
            provider: id,
            windows: [],
            checkedAt: now(),
            source: "event",
            accountStamp: this.quotaAccountStamp(id),
          });
        }
        await this.invalidateRuntimes(params.provider, true);
        this.broadcast();
        return { invalidated: true };
      }
      case "settings.save": {
        if (this.active.size)
          throw new Error("请先停止正在运行的成员，再修改执行端或网络设置");
        const previous = this.settings;
        const value = params.settings || params;
        const next = {
          ...this.settings,
          ...value,
          paths: { ...this.settings.paths, ...value.paths },
          models: { ...this.settings.models, ...value.models },
          efforts: { ...this.settings.efforts, ...value.efforts },
        };
        if (value.automationPolicies !== undefined)
          next.automationPolicies = AutomaticBudget.validate({
            ...this.settings.automationPolicies,
            ...value.automationPolicies,
          });
        if (value.dailyLife !== undefined)
          next.dailyLife = validateDailyLife(value.dailyLife);
        if (value.discussionCallLimits !== undefined)
          next.discussionCallLimits = discussionCallLimits(
            value.discussionCallLimits,
          );
        if (
          !["official", "npmmirror"].includes(next.npmRegistry ?? "official") ||
          !["bundled", "local"].includes(next.nodeRuntime ?? "bundled") ||
          !["subscription", "api"].includes(
            next.claudeAuthMode ?? "subscription",
          )
        )
          throw new Error("下载源、运行环境或登录方式无效。");
        if (!["tun", "proxy"].includes(next.networkMode))
          throw new Error("网络模式无效，请在设置里重新选择网络连接方式。");
        if (
          !Number.isInteger(next.maxParallel) ||
          next.maxParallel < 1 ||
          next.maxParallel > 8
        )
          throw new Error("同时运行数量应为 1–8");
        next.maxRunMinutes = bounded(
          next.maxRunMinutes,
          1,
          1440,
          DEFAULT_SETTINGS.maxRunMinutes,
        );
        next.deepseekMaxRequests = bounded(
          next.deepseekMaxRequests,
          1,
          200,
          DEFAULT_SETTINGS.deepseekMaxRequests,
        );
        next.permissions = normalizePermissions(next.permissions);
        next.memberPermissions = normalizeMemberPermissions(next.memberPermissions, new Set(this.store.members().map(member => member.id)));
        if (typeof next.defaultAutoApprove !== "boolean")
          throw new Error("新工作会话自动批准设置无效");
        next.stopTimeoutMs = Math.max(
          1000,
          Math.min(Number(next.stopTimeoutMs) || 10000, 60000),
        );
        buildEnvironment(next);
        // Model/effort choices change the next run, not the last observed account connection.
        const affected = this.executorIds().filter(
          (id) =>
            this.settings.nodeRuntime !== next.nodeRuntime ||
            (id === "claude" &&
              this.settings.claudeAuthMode !== next.claudeAuthMode) ||
            this.settings.networkMode !== next.networkMode ||
            this.settings.proxyUrl !== next.proxyUrl ||
            this.settings.paths[id] !== next.paths[id] ||
            (id !== "deepseek" &&
              JSON.stringify(this.settings.permissions[id]) !==
                JSON.stringify(next.permissions[id])) ||
            (id === "dsh" &&
              (this.settings.dshProfile !== next.dshProfile ||
                this.settings.deepseekBaseUrl !== next.deepseekBaseUrl)) ||
            (id === "deepseek" &&
              (this.settings.deepseekBaseUrl !== next.deepseekBaseUrl ||
                this.settings.deepseekEnabled !== next.deepseekEnabled)),
        );
        const runtimeAffected = this.executorIds().filter(
          (id) =>
            affected.includes(id) ||
            this.settings.models[id] !== next.models[id] ||
            this.settings.efforts[id] !== next.efforts[id] ||
            this.store.members().some(member => member.executor === id && JSON.stringify(this.settings.memberPermissions?.[member.id]) !== JSON.stringify(next.memberPermissions?.[member.id])),
        );
        // Retire all affected idle runtimes together, and do not persist a settings
        // change whose native cleanup failed. Healthy cleanup never waits in series.
        if (runtimeAffected.length) {
          invalidateClaudeChecks();
          const providers = new Set(runtimeAffected);
          await this.roomRuntimes.invalidate((key) => {
            const provider = this.store.get<Session>("sessions", key)?.provider;
            return Boolean(provider && providers.has(provider));
          });
        }
        if (this.active.size || this.settings !== previous)
          throw new Error("保存期间任务或配置发生变化，已保留最新设置，请重试。");
        this.settings = next;
        this.store.put("settings", "main", next);
        for (const executor of this.store.executors()) {
          const permissions = next.permissions[executor.id];
          if (permissions && JSON.stringify(permissions) !== JSON.stringify(executor.permissions))
            this.store.put("executors", executor.id, { ...executor, permissions });
        }
        this.dailyLife.sync();
        this.providers = this.providers.map((info) =>
          affected.includes(info.id) ? { ...info, stale: true } : info,
        );
        for (const id of affected) {
          this.probeRevisions.set(id, (this.probeRevisions.get(id) ?? 0) + 1);
          const info = this.providers.find((info) => info.id === id);
          if (info) this.store.put("providers", id, info);
        }
        this.broadcast();
        for (const id of affected) void this.probe(id).catch(() => {});
        return next;
      }
      case "internal.lookup": {
        // Main-process checks need one record, not the whole workbench snapshot.
        const session = params.sessionId
          ? this.store.get<Session>("sessions", String(params.sessionId))
          : undefined;
        const projectId = params.projectId ?? session?.projectId;
        return {
          session,
          project: projectId
            ? this.store.get<Project>("projects", String(projectId))
            : undefined,
          ...(params.executors ? { executors: this.store.executors() } : {}),
        };
      }
      case "diagnostics.export":
        return this.diagnostics();
      default:
        throw new Error(UNAVAILABLE_OPERATION);
    }
  }
  /** Session housekeeping must never race a member that is still working in it. */
  private assertDataIdle() {
    if (
      this.projectFlow?.busy ||
      this.active.size ||
      this.executions.size ||
      this.flowTasks.size ||
      this.workspaceOperations.size ||
      this.memberOperations.size ||
      this.acpLogins.size ||
      this.providerChecks.size ||
      this.balanceCheck ||
      this.quotaChecks.size ||
      this.rooms.busy ||
      this.lifeRunning ||
      this.store
        .list<Run>("runs")
        .some((run) => !run.completedAt && !terminal.has(run.status)) ||
      this.store
        .recent<{ status: string }>("timed_occurrences", 100)
        .some((item) => item.status === "running")
    )
      throw new Error(
        "请先停止或等当前任务、连接检测、登录和版本安装完成，再备份或恢复资料。",
      );
  }
  private beginDataMaintenance() {
    this.assertDataIdle();
    this.store.flushLog();
    this.maintenanceWasPaused = this.automation.snapshot().paused;
    this.maintenance = true;
    this.automation.pause();
  }
  private endDataMaintenance() {
    this.maintenance = false;
    if (!this.maintenanceWasPaused) this.automation.resume();
    this.broadcast();
    void this.schedule();
  }
  private createDataBackup(reason: BackupReason) {
    return this.backups.create(reason);
  }
  private assertSessionUsable(session: Session) {
    if (
      (session.memberId &&
        !this.store.members().some((m) => m.id === session.memberId)) ||
      this.store.get("removed_members", session.memberId ?? session.provider)
    )
      throw new Error("原成员已删除，这个话题保留为历史，请新开话题。");
    if (session.restoredHistoryOnly)
      throw new Error(
        "这个会话从备份恢复，仅保留历史。备份不包含原生上下文和工作副本，请新建任务；当前项目文件未被恢复。",
      );
  }
  private requireIdle(sessionId: string, action: string) {
    const busy =
      [...this.active.values()].some(
        (active) => active.ctx.session.id === sessionId,
      ) ||
      this.store
        .list<Run>("runs")
        .some(
          (run) =>
            run.sessionId === sessionId &&
            !run.completedAt &&
            !terminal.has(run.status),
        );
    if (busy) throw new Error(`这个会话还有任务在进行，请先停止再${action}`);
  }
  private workspaceKey(session: Session) {
    return path
      .resolve(
        session.workspace ||
          this.require<Project>("projects", session.projectId).directory,
      )
      .toLowerCase();
  }
  private async workspaceOperation<T>(
    session: Session,
    action: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.assertSessionUsable(session);
    const key = this.workspaceKey(session);
    if (this.workspaceOperations.has(key))
      throw new Error("这个工作副本正在整理，请稍后再试。");
    for (const related of this.store
      .list<Session>("sessions")
      .filter((item) => this.workspaceKey(item) === key))
      this.requireIdle(related.id, action);
    this.workspaceOperations.add(key);
    try {
      return await operation();
    } finally {
      this.workspaceOperations.delete(key);
    }
  }
  private async undoWorkspace(
    sessionId: string,
    runId: string,
    partial = false,
  ) {
    const session = this.require<Session>("sessions", sessionId),
      run = this.require<Run>("runs", runId);
    if (run.sessionId !== session.id)
      throw new Error("这一轮不属于所选会话，请回到对应的任务会话再操作。");
    return this.workspaceOperation(session, "撤销本轮", async () => {
      const project = this.require<Project>("projects", session.projectId),
        undo = () =>
          undoCheckpoint(
            session,
            run.id,
            this.store.dataDirectory,
            session.workspaceKind === "original"
              ? (paths) => assertProjectPaths(this.store, project.id, paths)
              : undefined,
          );
      const originalUndo = session.workspace
        ? await projectUndoInfo(session.workspace, runId, project.directory)
        : undefined;
      const result = await (originalUndo
        ? withProjectWrite(
            this.store,
            project.id,
            project.directory,
            async (check) => {
              const info = await checkpointInfo(
                session,
                this.store.dataDirectory,
              );
              if (!info.canUndo || info.runId !== runId) return info;
              return undoWriteback(
                session.workspace!,
                runId,
                project.directory,
                partial,
                (paths) => {
                  check();
                  assertProjectPaths(this.store, project.id, paths);
                },
                undo,
              );
            },
            true,
          )
        : session.workspaceKind === "original"
          ? withProjectWrite(
              this.store,
              project.id,
              project.directory,
              undo,
              true,
            )
          : undo());
      if (result.status !== "undone" || run.workspaceUndo?.status === "undone")
        return result;
      const at = now();
      this.store.delete("workspace_conflicts", sessionId);
      this.persistRun(run, {
        ...(run.status === "completed" ? { status: "ended" as const } : {}),
        validation: undefined,
        workspaceUndo: { status: "undone", changes: result.changes.length, at },
      });
      for (const message of this.store.list<RoomMessage>("room_messages"))
        if (
          message.link &&
          (message.link.reviewOf?.runId ?? message.link.runId) === run.id
        )
          this.store.put("room_messages", message.id, {
            ...message,
            link: {
              ...message.link,
              undoneAt: at,
              verdict: undefined,
              verdictAt: undefined,
            },
          });
      this.writeEvent(
        this.context(run, session),
        "status",
        originalUndo
          ? "这一轮的工作副本及未被再次修改的项目原文件已撤销。"
          : "这一轮在工作副本中的文件改动已撤销；较早轮次和项目原目录保留。",
        { undoOf: run.id, originalRestored: !!originalUndo },
        "derived",
      );
      if (run.origin?.threadId) {
        const threadId = run.origin.threadId,
          roomId =
            this.store.get<RoomThread>("room_threads", threadId)?.roomId ??
            "global";
        this.rooms.run(roomId, () =>
          this.roomMessage({
            id: randomUUID(),
            author: "system",
            threadId,
            text: originalUndo
              ? `${this.memberFor(session).name} 的最近一轮工作副本及未被再次修改的项目原文件已恢复。`
              : `${this.memberFor(session).name} 的最近一轮文件改动已在工作副本中撤销。`,
            system: true,
            at,
            link: {
              projectId: run.projectId,
              sessionId: session.id,
              runId: run.id,
              outcome: run.status,
              undoneAt: at,
              ...(run.origin?.reviewOf
                ? { reviewOf: run.origin.reviewOf }
                : {}),
            },
          }),
        );
      }
      this.broadcast();
      return result;
    });
  }
  private updateSession(sessionId: string, params: any) {
    const session = this.require<Session>("sessions", sessionId);
    const next: Session = { ...session };
    if (params.title !== undefined) {
      const title = String(params.title).trim();
      if (!title) throw new Error("会话名称不能为空");
      next.title = title.slice(0, 120);
      next.autoTitle = false;
    }
    if (typeof params.pinned === "boolean") next.pinned = params.pinned;
    if (typeof params.archived === "boolean") next.archived = params.archived;
    for (const field of ["model", "effort"] as const)
      if (params[field] !== undefined) {
        const value =
          params[field] === null
            ? ""
            : String(params[field]).trim().slice(0, 120);
        if (value) next[field] = value;
        else delete next[field];
      }
    this.store.put("sessions", session.id, next);
    if(params.title!==undefined){
      const link=this.store.get<{id:string}>('desk_session_links',session.id),thread=link&&this.store.get<RoomThread>('room_threads',link.id);
      if(thread)this.store.put('room_threads',thread.id,{...thread,title:next.title,autoTitle:false});
    }
    this.broadcast();
    return next;
  }
  /** Remove a session and everything recorded for it; the project folder itself is never touched. */
  private async deleteSession(
    sessionId: string,
    discard: boolean,
    options: { broadcast?: boolean } = {},
  ) {
    const session = this.require<Session>("sessions", sessionId);
    this.requireIdle(sessionId, "删除");
    if (this.workspaceOperations.has(this.workspaceKey(session)))
      throw new Error("工作副本正在整理，请稍后删除会话。");
    await this.roomRuntimes.closeSession(sessionId);
    for (const collab of this.store
      .list<Collaboration>("collaborations")
      .filter((item) => item.sessionIds.includes(sessionId))) {
      if (collab.status === "running")
        throw new Error("这个会话正在参与协作，请先暂停或等协作结束");
      if (collab.status === "paused")
        this.store.put("collaborations", collab.id, {
          ...collab,
          status: "ended",
          stage: "成员会话已删除，协作结束",
        });
    }
    if (discard) {
      const project = this.store.get<Project>("projects", session.projectId);
      if (project)
        await this.workspaceOperation(session, "删除副本", () =>
          discardWorkspace(session, project, this.store.dataDirectory),
        );
    }
    await removeCheckpoint(session.id, this.store.dataDirectory).catch(
      () => {},
    );
    const runs = this.removeSessionRecords(sessionId);
    this.memberWorkspaces?.sessionRemoved(sessionId);
    this.releaseAttachments(
      runs
        .flatMap((run) => [
          ...(run.attachments ?? []),
          ...(run.generatedImages ?? []),
        ])
        .map((item) => item.id),
    );
    if (options.broadcast !== false) this.broadcast();
    return { deleted: true, workspaceRemoved: discard };
  }
  /** Stored audit rows can be removed together with their archived messages in one transaction. */
  private removeSessionRecords(sessionId: string) {
    const runs = this.store
      .list<Run>("runs")
      .filter((run) => run.sessionId === sessionId);
    for (const run of runs) this.store.delete("runs", run.id);
    for (const approval of this.store
      .list<Approval>("approvals")
      .filter((item) => item.sessionId === sessionId))
      this.store.delete("approvals", approval.id);
    this.store.deleteEntitiesWhere(
      "outbox",
      (value) => (value as { sessionId?: string }).sessionId === sessionId,
    );
    this.store.delete("workspace_conflicts", sessionId);
    this.store.delete("blocked_sessions", sessionId);
    this.store.deleteSessionEvents(sessionId);
    this.store.delete("sessions", sessionId);
    return runs;
  }
  private async removeProject(projectId: string, discard: boolean) {
    const project = this.require<Project>("projects", projectId);
    const roomId: RoomId = `project:${projectId}`;
    if (this.memberWorkspaces.projectBusy(projectId))
      throw new Error("个人汇报仍在回答，请先停止并等待结束");
    if (
      this.store.get("room_cursors", roomId) &&
      this.rooms.run(roomId, () =>
        Boolean(this.roomRunning || this.roomChanging),
      )
    )
      throw new Error("项目会议室仍在发言或整理，请先停止并等待结束");
    if (
      this.store
        .list<ProjectFlow>("project_flows")
        .some(
          (f) =>
            f.projectId === projectId &&
            !["completed", "cancelled"].includes(f.status),
        )
    )
      throw new Error("请先在会议室结束或取消项目流程，再移除项目");
    if (
      this.projectFlow.joint
        .overviews()
        .filter((r) => r.projectId === projectId)
        .some((r) => !["completed", "stale", "cancelled"].includes(r.status))
    )
      throw new Error("请先取消或结束这个项目的共同评审和比稿，再移除项目");
    const reportRooms = new Set(
      this.store
        .list<{ id: RoomId; projectId?: string }>("personal_rooms")
        .filter((r) => r.projectId === projectId)
        .map((r) => r.id),
    );
    const sessions = this.store
      .list<Session>("sessions")
      .filter(
        (item) =>
          item.projectId === projectId ||
          (item.roomId && reportRooms.has(item.roomId)),
      );
    for (const session of sessions) this.requireIdle(session.id, "移除项目");
    if (
      this.store
        .list<Collaboration>("collaborations")
        .some(
          (item) => item.projectId === projectId && item.status === "running",
        )
    )
      throw new Error("这个项目还有协作在进行，请先暂停");
    this.projectTree.assertRemovable(projectId);
    this.removingProjects.add(projectId);
    markProjectRemoving(this.store, projectId, true);
    try {
      for (const session of sessions)
        await this.deleteSession(session.id, discard, { broadcast: false });
      if (this.store.get("room_cursors", roomId))
        await this.rooms.run(roomId, () =>
          this.resetRoomSessions({ preserveHistory: false }),
        );
      for (const hidden of this.store
        .list<Project>("projects")
        .filter((p) => p.kind === "lounge" && p.roomId === roomId))
        this.store.delete("projects", hidden.id);
      for (const hidden of this.store
        .list<Project>("projects")
        .filter(
          (p) => p.kind === "lounge" && p.roomId && reportRooms.has(p.roomId),
        ))
        this.store.delete("projects", hidden.id);
      this.memberWorkspaces.projectRemoved(projectId);
      this.rooms.forget(roomId);
      for (const collab of this.store
        .list<Collaboration>("collaborations")
        .filter((item) => item.projectId === projectId)) {
        this.store.delete("collaborations", collab.id);
        this.store.delete("workflows", collab.id);
      }
      this.store.delete("projects", projectId);
      this.broadcast();
      return { removed: true, sessions: sessions.length };
    } finally {
      this.removingProjects.delete(projectId);
      markProjectRemoving(this.store, projectId, false);
    }
  }
  /** A desktop client's own persona file, read only when the user asks to import it into a card. */
  private async importPersona(executor: string) {
    const home = process.env.USERPROFILE || process.env.HOME || "";
    const files: Record<string, string> = {
      codex: path.join(home, ".codex", "AGENTS.md"),
      dsh: path.join(home, ".dsh", "AGENTS.md"),
      claude: path.join(home, ".claude", "CLAUDE.md"),
    };
    const file = files[executor];
    if (!file) throw new Error("这个执行端没有可导入的桌面端人设");
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      throw new Error(`没有找到桌面端的人设文件：${file}`);
    }
    return {
      path: file,
      text: text.slice(0, 8000),
      truncated: text.length > 8000,
    };
  }

  /* ───────── Team chat room ───────── */
  private launchDiscussion(flow: () => Promise<void>) {
    if (this.roomRunning || this.roomChanging)
      throw new Error("聊天室仍在整理，请稍后继续");
    this.roomStopping = false;
    this.setRoomState({ active: true, mode: "discuss" });
    const task = Promise.resolve()
      .then(flow)
      .catch((error) => {
        const d = this.roomStore.roomState().discussion;
        if (d)
          this.setRoomState({
            discussion: {
              ...d,
              phase: "blocked",
              reason: (error as Error).message,
            },
          });
      })
      .finally(() => {
        this.roomRunning = undefined;
        if (!this.closed) {
          this.setRoomState({ active: false, speaking: undefined });
          this.discussion.wake();
        }
      });
    this.roomRunning = task;
    this.flowTasks.add(task);
    void task.then(() => this.flowTasks.delete(task));
  }
  private async ensureLounge() {
    const roomId = this.roomId,
      name =
        roomId === "global"
          ? "茶歇室"
          : roomId.startsWith("project:")
            ? `${this.require<Project>("projects", roomId.slice(8)).name} · 项目会议室`
            : roomId.startsWith("report:")
              ? "项目个人汇报"
              : "工位话题整理";
    const existing = this.store
      .list<Project>("projects")
      .find(
        (project) =>
          project.kind === "lounge" && (project.roomId ?? "global") === roomId,
      );
    if (existing) {
      const project = { ...existing, roomId, name };
      this.store.put("projects", project.id, project);
      return project;
    }
    const id =
      roomId === "global"
        ? "lounge"
        : `room-lounge-${createHash("sha256").update(roomId).digest("hex").slice(0, 24)}`;
    const directory = path.join(
      this.store.dataDirectory,
      roomId === "global" ? "lounge" : path.join("lounges", id),
    );
    await mkdir(directory, { recursive: true });
    const project: Project = {
      id,
      name,
      directory,
      createdAt: now(),
      collaborationPaused: false,
      kind: "lounge",
      roomId,
    };
    this.store.put("projects", project.id, project);
    return project;
  }
  private roomSessions(includeRetired = false) {
    return this.store.list<Session>("sessions").filter((session) => {
      const project = this.store.get<Project>("projects", session.projectId);
      return (
        (includeRetired || !session.roomRetiredAt) &&
        project?.kind === "lounge" &&
        (session.roomId ?? project.roomId ?? "global") === this.roomId
      );
    });
  }
  /** Speech and hand votes have separate read-only native contexts for each member. */
  private async loungeSession(
    member: MemberProfile,
    purpose?: "room-hand" | "room-image" | "room-minutes" | "room-mention",
  ) {
    const project = await this.ensureLounge();
    const threadId = this.roomStore.currentRoomThread().id;
    const existing = this.roomSessions().find(
      (session) =>
        (session.roomThreadId ?? threadId) === threadId &&
        session.purpose === purpose &&
        session.provider === member.executor &&
        (session.memberId ?? session.provider) === member.id,
    );
    if (existing) {
      if (purpose && existing.nativeId) {
        const fresh = {
          ...existing,
          nativeId: undefined,
          nativeHome: undefined,
        };
        this.store.put("sessions", existing.id, fresh);
        return fresh;
      }
      const session = {
        ...existing,
        roomId: this.roomId,
        roomThreadId: threadId,
      };
      this.store.put("sessions", session.id, session);
      return session;
    }
    const created = await this.createSession(
      project.id,
      member.executor,
      `${purpose === "room-mention" ? "点名回复" : purpose === "room-image" ? "绘图" : purpose === "room-minutes" ? "会议纪要" : purpose ? "举手" : "聊天室"} · ${member.name}`,
      false,
      member.id,
    );
    const session = {
      ...created,
      purpose,
      roomId: this.roomId,
      roomThreadId: threadId,
    };
    this.store.put("sessions", session.id, session);
    return session;
  }
  private roomMessage(message: RoomMessage) {
    const generatedImages = message.runId
      ? this.store.get<Run>("runs", message.runId)?.generatedImages
      : message.generatedImages;
    const stored = {
      ...message,
      ...(generatedImages ? { generatedImages } : {}),
      threadId: message.threadId ?? this.roomStore.currentRoomThread().id,
      authorName:
        message.authorName ??
        (message.author === "user"
          ? this.store.profile().name
          : message.author === "system"
            ? "系统"
            : this.store
                .members()
                .find((member) => member.id === message.author)?.name),
    };
    this.roomStore.put("room_messages", stored.id, stored);
    this.broadcast();
    return stored;
  }
  private setRoomState(change: Partial<RoomState>) {
    this.roomStore.put("room", "state", {
      ...this.roomStore.roomState(),
      ...change,
    });
    this.broadcast();
  }
  private roomSend(params: any) {
    if (this.roomChanging) throw new Error("聊天室正在整理话题，请稍后发送");
    if (this.roomStore.roomState().generatingImage)
      throw new Error("图片正在生成，请先等待完成或停止。");
    if (params.mode !== "discuss")
      throw new Error("聊天室已更新，请刷新界面后重新发送。");
    const attachments = resolveAttachments(
      this.store.dataDirectory,
      params.attachments,
    ).map(withoutPath);
    return this.discussion.input({
      ...params,
      materialContext: false,
      text:
        String(params.text ?? "").trim() ||
        (attachments.length ? "请看附件。" : ""),
      attachments,
    });
  }
  /** A manual, single Codex image request; ordinary discussion and automatic speech cannot start it. */
  private roomGenerateImage(params: any) {
    const state = this.roomStore.roomState(),
      d = state.discussion;
    if (
      this.roomRunning ||
      this.roomChanging ||
      state.active ||
      state.compressing
    )
      throw new Error("请先暂停讨论并等待当前发言结束，再生成图片。");
    if (d?.unknownRunId || d?.unknownRunIds?.length)
      throw new Error("上次讨论结果还待核对，请先核对并结束或继续讨论。");
    const text = String(params.text ?? "").trim();
    if (!text || text.length > 20000)
      throw new Error("请写下 1–20000 字的图片描述。");
    const member = this.store
      .members()
      .find(
        (member) =>
          member.id === String(params.memberId ?? "") &&
          member.executor === "codex",
      );
    if (!member) throw new Error("请选择使用 Codex 的绘图成员。");
    const provider = this.providers.find((info) => info.id === "codex");
    if (!provider?.available || provider.auth !== "subscription")
      throw new Error("请先连接并登录 Codex。");
    if (provider.capabilities.imageGeneration !== true)
      throw new Error(
        "当前 Codex 版本尚未确认支持绘图，请使用 AIROOM 已验证的新版 Codex 并重新检测。",
      );
    if (!this.settings.permissions.codex.network)
      throw new Error("图片生成需要 Codex 的联网权限，请先在设置里开启。");
    const attachments = resolveAttachments(
      this.store.dataDirectory,
      params.attachments,
    ).map(withoutPath);
    if (
      attachments.some(
        (file) => file.kind !== "image" || file.size > IMAGE_SEND_MAX,
      )
    )
      throw new Error("绘图参考只支持 5 MB 以内的图片。");
    const imageSession = this.roomSessions().find(
      (session) =>
        session.purpose === "room-image" &&
        (session.memberId ?? session.provider) === member.id,
    );
    const uncertain = imageSession
      ? this.store
          .list<Run>("runs")
          .filter(
            (run) =>
              run.sessionId === imageSession.id &&
              (run.status === "unknown" || run.delivery === "unknown") &&
              !run.imageGenerationAcknowledgedAt,
          )
      : [];
    if (uncertain.length && params.acknowledgeUnknown !== true)
      throw new Error(
        "上次图片请求的结果未知，请核对后明确确认再发送新请求；不会重发原请求。",
      );
    for (const run of uncertain)
      this.persistRun(run, { imageGenerationAcknowledgedAt: now() });
    if (!this.roomStore.roomMessages(1).length) {
      const thread = this.roomStore.currentRoomThread();
      this.roomStore.put("room_threads", thread.id, {
        ...thread,
        title: text.replace(/\s+/g, " ").slice(0, 64),
      });
    }
    const asked = this.roomMessage({
      id: randomUUID(),
      author: "user",
      text,
      at: now(),
      status: "done",
      imageGeneration: true,
      ...(attachments.length ? { attachments } : {}),
    });
    const message = this.roomMessage({
      id: randomUUID(),
      threadId: asked.threadId,
      author: member.id,
      text: "",
      at: now(),
      status: "speaking",
      imageGeneration: true,
      replyTo: asked.id,
    });
    this.roomStopping = false;
    this.setRoomState({
      active: true,
      mode: "chat",
      generatingImage: true,
      speaking: member.id,
    });
    const task = Promise.resolve()
      .then(async () => {
        const session = await this.loungeSession(member, "room-image");
        if (this.roomStopping || !this.alive) {
          this.roomMessage({ ...message, status: "stopped" });
          return;
        }
        const references = resolveAttachments(
          this.store.dataDirectory,
          attachments,
        );
        const prompt = `[AIROOM 图片请求]\n这次用户明确要求生成或修改一张图片。使用原生 image_gen.imagegen 图片生成工具完成。不要用字符画、SVG 或代码替代图片，不要转用 API 密钥。若有本轮参考图片，按用户要求用于修改或参考。只生成一张；失败或限流就结束，不自行重试。不要执行命令、查阅其他文件或修改项目文件，图片会由 AIROOM 自动接收保存。成功后用一句简短的话说明结果即可。\n\n[用户描述]\n${text}${references.length ? `\n\n${describeAttachments(references, { images: true, paths: false })}` : ""}`;
        const sent = (await this.send(
          session.id,
          prompt,
          "message",
          undefined,
          attachments,
          true,
        )) as { runId: string };
        this.persistRun(this.require<Run>("runs", sent.runId), {
          origin: { threadId: asked.threadId, messageId: asked.id },
        });
        this.roomMessage({ ...message, runId: sent.runId });
        const result = await this.waitForReply(sent.runId, session.id),
          run = this.require<Run>("runs", sent.runId);
        const images = run.generatedImages ?? [];
        const errors = this.store
          .runEvents(run.id)
          .filter((event) => event.runId === run.id && event.kind === "error");
        this.roomMessage({
          ...message,
          runId: run.id,
          ...result,
          ...(result.status === "done" && !images.length
            ? {
                status: "failed" as const,
                error:
                  errors.at(-1)?.text ??
                  "Codex 本轮没有返回图片，请查看活动记录。",
              }
            : {}),
          ...(images.length && result.text === "（没有说话）"
            ? { text: "图片已生成。" }
            : {}),
        });
      })
      .catch((error) => {
        this.roomMessage({
          ...(this.roomStore.get<RoomMessage>("room_messages", message.id) ??
            message),
          status: this.roomStopping ? "stopped" : "failed",
          error: (error as Error).message,
        });
      })
      .finally(() => {
        this.roomRunning = undefined;
        if (!this.closed)
          this.setRoomState({
            active: false,
            mode: state.mode,
            generatingImage: undefined,
            speaking: undefined,
          });
      });
    this.roomRunning = task;
    this.flowTasks.add(task);
    void task.then(() => this.flowTasks.delete(task));
    return { accepted: true, messageId: message.id };
  }
  private roomAttachments(member: MemberProfile, messages: RoomMessage[]) {
    return this.attachments.room(member, messages);
  }
  /** Whether a member's program takes attached images as pictures (from its last connection check). */
  private acceptsImages(provider: string) {
    return (
      this.providers.find((info) => info.id === provider)?.capabilities
        .images === true
    );
  }
  private async waitForReply(
    runId: string,
    sessionId: string,
  ): Promise<Pick<RoomMessage, "text" | "status" | "error">> {
    for (;;) {
      const run = this.require<Run>("runs", runId);
      if (
        terminal.has(run.status) ||
        (run.status === "rate_limited" && run.completedAt)
      ) {
        const events = this.store
          .runEvents(runId)
          .filter(
            (event) =>
              event.runId === runId &&
              !(event.data as { role?: string } | undefined)?.role,
          );
        const deltas = events
          .filter((event) => event.kind === "delta")
          .map((event) => event.text)
          .join("");
        const text = (
          deltas ||
          events
            .filter((event) => event.kind === "message")
            .map((event) => event.text)
            .join("\n\n")
        ).trim();
        if (run.status === "ended" || run.status === "completed")
          return { text: text || "（没有说话）", status: "done" };
        return {
          text,
          status: run.status === "stopped" ? "stopped" : "failed",
          error: run.error
            ? failureMessage(
                run.error,
                run.status === "rate_limited" ? "rate_limited" : undefined,
                run.delivery,
              )
            : RUN_STATUS_TEXT[run.status] || run.status,
        };
      }
      if (!this.alive) return { text: "", status: "stopped" };
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  /** Toggle the user's reaction on a member's message in the current topic. */
  private roomReact(messageId: string, emoji: string) {
    if (!ROOM_REACTIONS.some((item) => item.emoji === emoji))
      throw new Error("不支持这个表情");
    const message = this.roomStore.get<RoomMessage>("room_messages", messageId);
    if (
      !message ||
      (message.threadId ?? "room-main") !==
        this.roomStore.currentRoomThread().id
    )
      throw new Error("只能回应当前话题里的消息");
    if (
      message.author === "user" ||
      message.system ||
      message.status === "speaking" ||
      message.status === "passed"
    )
      throw new Error("这条消息不能添加表情");
    const reactions = toggleReaction(message.reactions, emoji, "user");
    this.roomStore.put("room_messages", message.id, { ...message, reactions });
    this.broadcast();
    return { reactions: reactions ?? {} };
  }
  private pausePendingHands() {
    for (const session of this.roomSessions().filter(
      (s) => s.purpose === "room-hand",
    ))
      this.withdrawQueued(session.id, "讨论已暂停或内容更新，排队举手已撤回");
  }
  private async cancelHands() {
    this.pausePendingHands();
    const sessions = new Set(
      this.roomSessions()
        .filter((s) => s.purpose === "room-hand")
        .map((s) => s.id),
    );
    await Promise.all(
      [...this.active.entries()]
        .filter(([, active]) => sessions.has(active.ctx.session.id))
        .map(([id]) => this.stopRun(id)),
    );
  }
  /** Hand a room conclusion to a project: a member's new or existing session gets it as a task. */
  private async roomHandoff(params: any) {
    const project = this.require<Project>(
      "projects",
      String(params.projectId ?? ""),
    );
    if (project.kind === "lounge") throw new Error("请选择一个工作项目");
    if (this.roomId !== "global" && this.roomId !== `project:${project.id}`)
      throw new Error("只能把会议室任务交给当前项目");
    const text = String(params.text ?? "").trim();
    if (!text) throw new Error("请写下要交给项目的任务");
    if (text.length > 20000) throw new Error("任务太长了，请精简后再交");
    const thread = this.roomThread(
      String(params.threadId ?? this.roomStore.currentRoomThread().id),
    );
    let session: Session;
    if (params.sessionId) {
      session = this.require<Session>("sessions", String(params.sessionId));
      if (session.projectId !== project.id)
        throw new Error("所选会话不属于这个项目");
    } else {
      const member = this.store
        .members()
        .find((item) => item.id === String(params.memberId ?? ""));
      if (!member) throw new Error("请选择一位成员");
      session = this.createSession(
        project.id,
        member.executor,
        undefined,
        typeof params.writeMode === "boolean"
          ? params.writeMode
          : this.settings.defaultWriteMode,
        member.id,
      );
    }
    const sent = (await this.send(session.id, text)) as { runId?: string };
    if (!sent?.runId) throw new Error("任务没有发出，请在项目会话里查看");
    const run = this.require<Run>("runs", sent.runId);
    this.store.put("runs", run.id, {
      ...run,
      origin: {
        threadId: thread.id,
        ...(params.messageId ? { messageId: String(params.messageId) } : {}),
      },
    });
    const member = this.memberFor(session),
      line = text.replace(/\s+/g, " ").slice(0, 60);
    this.roomMessage({
      id: randomUUID(),
      author: "system",
      threadId: thread.id,
      text: `已交给 ${member.name}（项目「${project.name}」）：${line}${text.length > 60 ? "…" : ""}`,
      at: now(),
      system: true,
      link: { projectId: project.id, sessionId: session.id, runId: run.id },
    });
    return { projectId: project.id, sessionId: session.id, runId: run.id };
  }
  /** Tell the room how a handed-over task or a review ended, in the topic it came from. */
  private reportHandoff(runId: string) {
    const run = this.store.get<Run>("runs", runId);
    if (!run?.origin?.threadId || !run.completedAt) return;
    if (run.imageGeneration) return; // The room already contains this image and its outcome, rather than a project task note.
    if (!this.store.get<RoomThread>("room_threads", run.origin.threadId))
      return;
    const session = this.store.get<Session>("sessions", run.sessionId),
      project = this.store.get<Project>("projects", run.projectId);
    if (!session || !project) return;
    const name = this.memberFor(session).name,
      review = run.origin.reviewOf,
      ok = run.status === "ended" || run.status === "completed";
    const reviewed =
        review && this.store.get<Session>("sessions", review.sessionId),
      author = reviewed ? this.memberFor(reviewed).name : "成员";
    const outcome = ok
      ? review
        ? `复核完了 ${author} 的结果，结论在下面`
        : "完成了交给 TA 的任务，结果待你验收"
      : run.status === "stopped"
        ? `的${review ? "复核" : "任务"}已停止`
        : run.status === "unknown"
          ? `的${review ? "复核" : "任务"}结果待核对`
          : `没能完成${review ? "复核" : "任务"}：${run.error ?? RUN_STATUS_TEXT[run.status] ?? run.status}`;
    const detail = ok ? this.runAnswer(run, 4000) : "";
    const threadId = run.origin.threadId,
      roomId =
        this.store.get<RoomThread>("room_threads", threadId)!.roomId ??
        "global";
    this.rooms.run(roomId, () =>
      this.roomMessage({
        id: randomUUID(),
        author: "system",
        threadId,
        text: `${name} 在项目「${project.name}」${outcome}。`,
        at: now(),
        system: true,
        ...(detail ? { detail } : {}),
        link: {
          projectId: project.id,
          sessionId: session.id,
          runId: run.id,
          outcome: run.status,
          ...(review ? { reviewOf: review } : {}),
        },
      }),
    );
  }
  /** What a member said in a run: its output text without tool activity, keeping the newest `limit` characters. */
  private runAnswer(run: Run, limit: number) {
    const parts: string[] = [];
    let streaming = false;
    for (const event of this.store
      .runEvents(run.id)
      .filter((item) => item.runId === run.id)) {
      const said =
        ["delta", "message"].includes(event.kind) && !(event.data as any)?.role;
      if (said && event.kind === "delta" && streaming)
        parts[parts.length - 1] += event.text;
      else if (said) parts.push(event.text);
      streaming = said && event.kind === "delta";
    }
    const text = parts
      .map((part) => part.trim())
      .filter(Boolean)
      .join("\n\n");
    return text.length > limit ? "…" + text.slice(-limit) : text;
  }
  /** Another member checks a finished project run read-only, working in the copy that holds its changes. */
  private async reviewRun(params: any) {
    const run = this.require<Run>("runs", String(params.runId ?? ""));
    if (
      run.workspaceUndo?.status === "undone" ||
      run.workspaceUndo?.status === "capturing"
    )
      throw new Error(
        "本轮文件改动已撤销或还原点尚未完成，请在新的任务轮次结束后复核。",
      );
    if (!["ended", "completed"].includes(run.status))
      throw new Error("这一轮还没有顺利结束，结束后再请人复核");
    const session = this.require<Session>("sessions", run.sessionId),
      project = this.require<Project>("projects", run.projectId);
    if (session.flowId)
      throw new Error("项目任务复核由负责人管理，请在项目会议室操作");
    if (this.roomId !== "global" && this.roomId !== `project:${project.id}`)
      throw new Error("不能在其他项目会议室复核这个结果");
    this.assertSessionUsable(session);
    if (project.kind === "lounge") throw new Error("聊天室里的发言不需要复核");
    const author = this.memberFor(session),
      reviewer = this.store
        .members()
        .find((item) => item.id === String(params.memberId ?? ""));
    if (!reviewer) throw new Error("请选择一位复核成员");
    if (reviewer.id === author.id) throw new Error("请另选一位成员复核");
    const copied = Boolean(
      session.workspace &&
        session.workspaceKind &&
        session.workspaceKind !== "original",
    );
    let changes = "",
      fingerprint: string | undefined;
    if (copied) {
      try {
        changes = (await diffWorkspace(session.workspace!)).text.trim();
      } catch (error) {
        changes = `（没能读取改动：${(error as Error).message}）`;
      }
    }
    // The review vouches for the files as they are now; later edits make it stale.
    if (copied) {
      try {
        fingerprint = await workspaceFingerprint(session.workspace!);
      } catch {
        /* Without a version the review runs but cannot later prove it is current. */
      }
    }
    const focus = String(params.focus ?? "")
        .trim()
        .slice(0, 4000),
      answer = this.runAnswer(run, 20000);
    const prompt = [
      `[复核请求]`,
      `请以只读方式复核 ${author.name} 在项目「${project.name}」完成的一轮任务。只检查和报告，不修改任何文件。`,
      copied
        ? `你的工作目录就是 ${author.name} 的工作副本，里面是 TA 改过的文件，可以直接打开核对。`
        : `这一轮${session.writeMode ? "没有留下工作副本" : "在只读会话中完成"}，你的工作目录是项目本身。`,
      ...(focus ? [`用户希望重点看：${focus}`] : []),
      `\n## 原任务\n${run.input.slice(0, 8000)}`,
      `\n## ${author.name} 的回答\n${answer || "（没有记录到正文）"}`,
      ...(copied
        ? [
            `\n## 文件改动\n${!changes ? "（工作副本和开始时相比没有改动）" : changes.length > 40000 ? `${changes.slice(0, 40000)}\n…（改动较多，其余请直接在工作目录里查看）` : changes}`,
          ]
        : []),
      `\n## 请这样回复\n分成三部分：**已核实**（你实际查看或运行过的依据）、**需实测**（需要运行程序或由人确认的部分）、**建议**（可选的改进）。没核对过的内容放进需实测，不要当成结论。最后单独一行写总体结论：「可以通过」或「需要修改」。`,
    ].join("\n");
    const given = params.threadId
      ? this.roomStore.get<RoomThread>("room_threads", String(params.threadId))
      : undefined;
    const thread =
      given ??
      (run.origin?.threadId
        ? this.roomStore.get<RoomThread>("room_threads", run.origin.threadId)
        : undefined);
    const created = this.createSession(
      project.id,
      reviewer.executor,
      `复核 · ${author.name}`,
      false,
      reviewer.id,
    );
    // 'original' keeps the reviewer from applying or discarding the copy it reads.
    if (copied)
      this.store.put("sessions", created.id, {
        ...this.require<Session>("sessions", created.id),
        workspace: session.workspace,
        workspaceKind: "original",
      });
    const sent = (await this.send(created.id, prompt)) as { runId?: string };
    if (!sent?.runId) throw new Error("复核请求没有发出，请在项目会话里查看");
    const started = this.require<Run>("runs", sent.runId);
    this.store.put("runs", started.id, {
      ...started,
      origin: {
        ...(thread ? { threadId: thread.id } : {}),
        ...(params.messageId ? { messageId: String(params.messageId) } : {}),
        reviewOf: {
          sessionId: session.id,
          runId: run.id,
          ...(fingerprint ? { fingerprint } : {}),
        },
      },
    });
    if (thread)
      this.roomMessage({
        id: randomUUID(),
        author: "system",
        threadId: thread.id,
        text: `已请 ${reviewer.name} 复核 ${author.name} 在项目「${project.name}」的结果。`,
        at: now(),
        system: true,
        link: {
          projectId: project.id,
          sessionId: created.id,
          runId: started.id,
        },
      });
    this.broadcast();
    return { projectId: project.id, sessionId: created.id, runId: started.id };
  }
  /** Reviews of a session whose files have changed since the reviewer looked at them are marked stale. */
  private async markStaleReviews(sessionId: string) {
    const session = this.store.get<Session>("sessions", sessionId);
    if (
      !session?.workspace ||
      !session.workspaceKind ||
      session.workspaceKind === "original"
    )
      return;
    const pending = this.store
      .list<RoomMessage>("room_messages")
      .filter(
        (message) =>
          message.link?.reviewOf?.sessionId === sessionId &&
          message.link.reviewOf.fingerprint &&
          !message.link.verdict &&
          !message.link.reviewStale,
      );
    if (!pending.length) return;
    let current: string;
    try {
      current = await workspaceFingerprint(session.workspace);
    } catch {
      return;
    }
    const at = now();
    let changed = false;
    for (const message of pending) {
      const latest = this.store.get<RoomMessage>("room_messages", message.id);
      if (
        latest?.link?.reviewOf?.fingerprint &&
        !latest.link.verdict &&
        !latest.link.reviewStale &&
        latest.link.reviewOf.fingerprint !== current
      ) {
        this.store.put("room_messages", latest.id, {
          ...latest,
          link: { ...latest.link, reviewStale: at },
        });
        changed = true;
      }
    }
    if (changed) this.broadcast();
  }
  /** The user's decision on an outcome note: accept the run, or send it back to its session with comments. */
  private async runVerdict(params: any) {
    const message = this.roomMessageRecord(String(params.messageId ?? ""));
    const link = message.link;
    if (!link?.runId || !link.outcome)
      throw new Error("这条消息没有可以验收的结果");
    if (link.verdict)
      throw new Error(
        link.verdict === "accepted" ? "已经验收通过了" : "已经打回修改了",
      );
    const target = link.reviewOf ?? {
      sessionId: link.sessionId,
      runId: link.runId,
    };
    const run = this.require<Run>("runs", target.runId),
      note = String(params.note ?? "")
        .trim()
        .slice(0, 20000);
    this.assertSessionUsable(this.require<Session>("sessions", run.sessionId));
    let result: unknown = { accepted: true };
    if (params.verdict === "accepted") {
      if (
        run.workspaceUndo?.status === "undone" ||
        run.workspaceUndo?.status === "capturing" ||
        link.undoneAt
      )
        throw new Error(
          "这一轮的文件改动已撤销或还原点尚未完成，不能验收通过。",
        );
      // Accepting on the strength of a review requires the files to be the ones the reviewer saw.
      if (link.reviewOf) {
        const authorSession = this.require<Session>(
            "sessions",
            link.reviewOf.sessionId,
          ),
          name = this.memberFor(authorSession).name;
        const stale = `复核之后 ${name} 的文件又改过，这份复核已经过期。请重新请人复核，或在 ${name} 的任务结果上直接验收。`;
        if (link.reviewStale) throw new Error(stale);
        if (link.reviewOf.fingerprint && authorSession.workspace) {
          let current: string | undefined;
          try {
            current = await workspaceFingerprint(authorSession.workspace);
          } catch {}
          if (current !== link.reviewOf.fingerprint) {
            this.roomStore.put("room_messages", message.id, {
              ...message,
              link: { ...link, reviewStale: now() },
            });
            this.broadcast();
            throw new Error(stale);
          }
        }
      }
      if (run.status === "ended")
        this.persistRun(run, {
          status: "completed",
          validation:
            note ||
            (link.reviewOf ? "复核后在聊天室验收通过" : "在聊天室验收通过"),
        });
      else if (run.status !== "completed")
        throw new Error("这一轮没有顺利结束，不能验收通过");
    } else if (params.verdict === "returned") {
      const instruction =
        note ||
        (link.reviewOf && message.detail
          ? "用户选择按以下已保存的复核意见修改，未补充意见：\n\n" +
            message.detail
          : "用户选择打回修改，未补充意见。请按原任务要求复查本轮成果，修正未满足的要求。");
      result = await this.roomHandoff({
        projectId: link.projectId,
        sessionId: target.sessionId,
        text: `验收没有通过，请根据下面的意见修改：\n\n${instruction}`,
        threadId: message.threadId,
        messageId: message.id,
      });
    } else throw new Error("未知的验收结果");
    // The task's own outcome note and its reviews' notes share the decision.
    const verdict = params.verdict as "accepted" | "returned",
      at = now();
    for (const item of this.roomStore.allRoomMessages(
      message.threadId ?? this.roomStore.currentRoomThread().id,
    ))
      if (
        item.link?.outcome &&
        !item.link.verdict &&
        (item.id === message.id ||
          (item.link.reviewOf?.runId ?? item.link.runId) === target.runId)
      )
        this.roomStore.put("room_messages", item.id, {
          ...item,
          link: { ...item.link, verdict, verdictAt: at },
        });
    this.broadcast();
    return result;
  }
  private async roomStop(preserveMinutesRequest = false) {
    if (
      this.roomId === "global" &&
      (this.lifeRunning ||
        [...this.active.values()].some((active) => active.ctx.run.automatic) ||
        this.store
          .list<Run>("runs")
          .some((run) => run.automatic && run.status === "queued"))
    )
      this.automation.pause();
    this.discussion.pause(
      "你已停止讨论，核对进展后可继续。",
      preserveMinutesRequest,
    );
    this.roomStopping = true;
    const sessions = new Set(this.roomSessions().map((session) => session.id));
    // A project task can occupy every execution slot; withdraw room runs before stopping active ones.
    for (const sessionId of sessions)
      this.withdrawQueued(sessionId, "你已停止聊天室，排队中的发言已取消");
    await Promise.all(
      [...this.active.entries()]
        .filter(([, active]) => sessions.has(active.ctx.session.id))
        .map(([id]) => this.stopRun(id)),
    );
    await Promise.all(
      [...sessions].map((id) => this.roomRuntimes.closeSession(id)),
    );
    return { stopping: true };
  }
  private async changeRoom<T>(action: () => Promise<T>) {
    if (this.roomRunning || this.roomChanging)
      throw new Error("聊天室仍在发言或整理话题，请先停止并等待结束");
    this.roomChanging = true;
    try {
      return await action();
    } finally {
      this.roomChanging = false;
    }
  }
  private async resetRoomSessions(
    options: { preserveHistory?: boolean; threadId?: string } = {},
  ) {
    const sessions = this.roomSessions(
      options.preserveHistory === false,
    ).filter(
      (session) =>
        !options.threadId ||
        (session.roomThreadId ?? this.roomStore.currentRoomThread().id) ===
          options.threadId,
    );
    for (const session of sessions) this.requireIdle(session.id, "整理话题");
    for (const session of sessions) {
      if (options.preserveHistory === false)
        await this.deleteSession(session.id, false, { broadcast: false });
      else {
        await this.roomRuntimes.closeSession(session.id);
        this.store.put("sessions", session.id, {
          ...session,
          roomThreadId:
            session.roomThreadId ?? this.roomStore.currentRoomThread().id,
          roomRetiredAt: now(),
          archived: true,
        });
      }
    }
  }
  /** Only the current topic is erased; archives remain readable. */
  private roomClear() {
    return this.changeRoom(async () => {
      const thread = this.roomStore.currentRoomThread();
      await this.resetRoomSessions({
        preserveHistory: false,
        threadId: thread.id,
      });
      const attached = this.roomStore
        .allRoomMessages(thread.id)
        .flatMap((message) => [
          ...(message.attachments ?? []),
          ...(message.generatedImages ?? []),
        ])
        .map((item) => item.id);
      this.roomStore.clearRoomThread(thread.id);
      this.releaseAttachments(attached);
      // The title came from the first message; an emptied topic goes back to the neutral name.
      // Its summary described the erased messages, so it goes too; an inherited summary stays until dropped on its own.
      const { summary: _erased, ...kept } = thread;
      this.roomStore.put("room_threads", thread.id, {
        ...kept,
        title: "当前话题",
      });
      this.setRoomState({
        active: false,
        mode: "chat",
        topic: undefined,
        speaking: undefined,
        discussion: undefined,
      });
      return { cleared: true };
    });
  }
  /** The current topic stops continuing an earlier one. Members restart from this topic's own messages,
   *  so no native session keeps the dropped summary. */
  private roomUninherit(threadId: string) {
    return this.changeRoom(async () => {
      const thread = this.roomThread(threadId);
      if (thread.id !== this.roomStore.currentRoomThread().id)
        throw new Error("只能修改当前话题");
      if (!thread.inherited) return thread;
      await this.resetRoomSessions();
      const { inherited: _dropped, ...next } = thread;
      this.roomStore.put("room_threads", thread.id, next);
      this.broadcast();
      return next;
    });
  }
  /** Archive the current topic and start a new one; optionally the new topic continues from a summary
   *  of the current topic or of an archived one (`from`), written first if missing or out of date. */
  private roomArchive(
    title: unknown,
    inherit: boolean,
    memberId: unknown,
    from?: string,
  ) {
    return this.changeRoom(async () => {
      if (this.roomId !== "global")
        throw new Error("项目会议室使用固定话题，无需归档");
      const current = this.roomStore.currentRoomThread(),
        hasMessages = this.roomStore.roomMessages(1).length > 0;
      const source = from ? this.roomThread(from) : current;
      const name =
        typeof title === "string" && title.trim()
          ? title.trim().replace(/\s+/g, " ").slice(0, 64)
          : undefined;
      if (!hasMessages && !inherit)
        throw new Error("当前话题没有消息，无需归档");
      let inherited: RoomThread["inherited"];
      if (inherit) {
        const summary = this.summaryCurrent(source)
          ? source.summary!
          : await this.compressThread(source.id, memberId);
        inherited = {
          threadId: source.id,
          title: source.id === current.id && name ? name : source.title,
          text: summary.text,
        };
      }
      await this.resetRoomSessions();
      let next: RoomThread;
      if (hasMessages) next = this.roomStore.archiveRoom(name, inherited);
      else {
        next = { ...current, inherited };
        this.roomStore.put("room_threads", current.id, next);
      }
      this.setRoomState({
        active: false,
        mode: "chat",
        topic: undefined,
        speaking: undefined,
        discussion: undefined,
      });
      this.broadcast();
      return next;
    });
  }
  /** Fold the topic into a summary. On the current topic members then start afresh from it, so long
   *  conversations stop growing their context; the messages themselves stay visible. */
  private roomCompress(threadId: string, memberId: unknown) {
    return this.changeRoom(async () => {
      const summary = await this.compressThread(threadId, memberId, true);
      if (threadId === this.roomStore.currentRoomThread().id) {
        await this.resetRoomSessions();
        if (this.roomStore.roomState().mode === "discuss")
          this.discussion.rebase();
        this.roomMessage({
          id: randomUUID(),
          author: "system",
          text: `以上内容已由 ${summary.byName ?? "成员"} 压缩成摘要；接下来大家从摘要继续。`,
          at: now(),
          system: true,
        });
      }
      this.broadcast();
      return summary;
    });
  }
  private roomRename(threadId: string, title: unknown) {
    const thread = this.roomThread(threadId);
    const name =
      typeof title === "string"
        ? title.trim().replace(/\s+/g, " ").slice(0, 64)
        : "";
    if (!name) throw new Error("话题名称不能为空");
    this.roomStore.put("room_threads", thread.id, { ...thread, title: name, autoTitle: false });
    this.broadcast();
    return { title: name };
  }
  private lastRoomMessage(threadId: string) {
    return this.roomStore
      .allRoomMessages(threadId)
      .filter((item) => item.status !== "speaking" && !item.system)
      .at(-1);
  }
  private summaryCurrent(thread: RoomThread) {
    return Boolean(
      thread.summary &&
        thread.summary.upTo === this.lastRoomMessage(thread.id)?.id,
    );
  }
  /** Remember what a topic's summary proposed: the chosen items become entries on the chosen members' cards. */
  private acceptMemories(params: any) {
    const thread = this.roomThread(String(params.threadId ?? "")),
      summary = thread.summary,
      proposed = summary?.proposals ?? [];
    if (!summary || !proposed.length)
      throw new Error("这个话题没有待确认的记忆提议");
    const given: string[] = Array.isArray(params.texts)
      ? params.texts.map((text: unknown) => String(text))
      : [];
    const texts = [...new Set(given)].filter((text) => proposed.includes(text));
    const members = this.store
      .members()
      .filter(
        (member) =>
          Array.isArray(params.memberIds) &&
          params.memberIds.includes(member.id),
      );
    if (!texts.length || !members.length)
      throw new Error("请选择要记住的内容和成员");
    const at = now(),
      origin =
        `${summary.byName ?? "成员"}提议 · 话题「${thread.title}」`.slice(
          0,
          80,
        );
    // Every card is checked against the memory limit before any is written.
    const cards = members.flatMap((member) => {
      const entries = memoryEntries(member),
        known = new Set(entries.map((entry) => entry.text));
      const added = texts
        .filter((text) => !known.has(text))
        .map((text) => ({
          id: newMemoryId(),
          text,
          source: "proposed" as const,
          origin,
          createdAt: at,
        }));
      if (!added.length) return [];
      try {
        return [
          normalizeMember(
            { ...member, memories: [...entries, ...added] },
            member,
          ),
        ];
      } catch (error) {
        throw new Error(`${member.name}：${(error as Error).message}`);
      }
    });
    for (const card of cards) this.store.put("members", card.id, card);
    const { proposals: _handled, ...rest } = summary;
    this.roomStore.put("room_threads", thread.id, { ...thread, summary: rest });
    this.broadcast();
    return { members: cards.length, items: texts.length };
  }
  /** One member reads the topic (and any earlier summary) in a short-lived session and writes the summary. */
  private async compressThread(
    threadId: string,
    memberId: unknown,
    force = false,
  ): Promise<RoomSummary> {
    const thread = this.roomThread(threadId);
    if (!force && this.summaryCurrent(thread)) return thread.summary!;
    const team = this.store.members(),
      member = team.find((item) => item.id === memberId) ?? team[0];
    const all = this.roomStore.allRoomMessages(threadId),
      cut = thread.summary?.upTo
        ? all.findIndex((item) => item.id === thread.summary!.upTo)
        : -1;
    const spoken = all
      .slice(cut + 1)
      .filter(
        (item) =>
          !item.system &&
          item.status !== "speaking" &&
          item.status !== "passed" &&
          item.text.trim(),
      );
    if (!spoken.length && thread.summary && !force) return thread.summary;
    if (!spoken.length && !thread.summary && !thread.inherited)
      throw new Error("这个话题还没有可以压缩的内容");
    const profile = this.store.profile(),
      userName = profile.name && profile.name !== "你" ? profile.name : "用户";
    const name = (item: RoomMessage) =>
      item.author === "user"
        ? userName
        : (item.authorName ??
          team.find((entry) => entry.id === item.author)?.name ??
          item.author);
    const lines = spoken.map(
      (item) =>
        `${name(item)}：${item.text}${item.reactions ? `（回应：${reactionText(item.reactions, (author) => (author === "user" ? userName : (team.find((entry) => entry.id === author)?.name ?? author)))}）` : ""}`,
    );
    let transcript = lines.join("\n\n");
    const truncated = transcript.length > 60000;
    if (truncated) transcript = transcript.slice(-60000);
    const earlier = [
      thread.inherited &&
        `它延续的上一个话题「${thread.inherited.title}」的摘要：\n${thread.inherited.text}`,
      thread.summary && `本话题此前已有的摘要：\n${thread.summary.text}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const prompt = `[AIROOM 话题压缩]\n请把${this.roomId === "global" ? "茶歇室" : "项目会议室"}的话题「${thread.title}」压缩成一份摘要。之后成员会在全新的上下文里，只凭这份摘要继续聊。\n保留：聊过的主题、达成的结论和决定、待办与分工、${userName}的偏好和要求、尚未解决的问题、各成员的重要观点（注明是谁）。省略寒暄和重复。\n用中文分条书写，不超过 800 字。直接输出摘要，不要开场白，不要使用工具，不要读写文件。\n另外，如果记录里出现了值得长期记住的、关于${userName}本人的偏好、习惯或事实（不是一次性的事务），在摘要最后另起一行写「【可记住】」，下面每行一条，每条一句话，最多 5 条；没有就不要写这一段。${truncated ? "\n（记录很长，下面只提供了最近的部分。）" : ""}${earlier ? `\n\n${earlier}` : ""}\n\n需要压缩的新记录：\n${transcript || "（没有新消息）"}`;
    const project = await this.ensureLounge();
    const created = this.createSession(
      project.id,
      member.executor,
      `话题摘要 · ${thread.title}`.slice(0, 60),
      false,
      member.id,
    );
    const session = {
      ...created,
      purpose: "room-summary" as const,
      roomId: this.roomId,
      roomThreadId: threadId,
    };
    this.store.put("sessions", session.id, session);
    this.setRoomState({ compressing: member.id });
    try {
      const sent = (await this.send(session.id, prompt)) as { runId: string };
      const result = await this.waitForReply(sent.runId, session.id);
      const reply = result.text.trim(),
        marker = /^[ \t]*【可记住】[：:]?[ \t]*/m.exec(reply);
      // Memory proposals are split off the summary; they never become part of what members read.
      const text = marker ? reply.slice(0, marker.index).trim() : reply;
      const proposals = marker
        ? [
            ...new Set(
              reply
                .slice(marker.index + marker[0].length)
                .split("\n")
                .map((line) =>
                  line.replace(/^\s*(?:[-*•·]|\d+[.)、．])\s*/, "").trim(),
                )
                .filter((line) => line && line.length <= 300),
            ),
          ].slice(0, 8)
        : [];
      if (
        result.status !== "done" ||
        !text ||
        text === "（没有说话）" ||
        isRoomPass(text)
      )
        throw new Error(
          result.status === "stopped"
            ? "压缩已停止"
            : `${member.name} 没能写出摘要${result.error ? `：${result.error}` : ""}`,
        );
      const summary: RoomSummary = {
        text: text.slice(0, 8000),
        by: member.id,
        byName: member.name,
        at: now(),
        upTo: this.lastRoomMessage(threadId)?.id,
        count: (thread.summary?.count ?? 0) + spoken.length,
        ...(proposals.length ? { proposals } : {}),
      };
      this.roomStore.put("room_threads", thread.id, {
        ...this.roomThread(thread.id),
        summary,
      });
      return summary;
    } finally {
      // The run is marked finished before its execution clears (provider confirmation follows);
      // deleting earlier fails as busy and the leftover session then blocks archiving the topic.
      const running = [...this.active.values()]
        .filter((active) => active.ctx.session.id === session.id)
        .map((active) => active.completion ?? Promise.resolve());
      if (running.length)
        await Promise.race([
          Promise.allSettled(running),
          new Promise((resolve) => setTimeout(resolve, 15000)),
        ]);
      await this.deleteSession(session.id, false, { broadcast: false }).catch(
        () => {},
      );
      if (!this.closed) this.setRoomState({ compressing: undefined });
    }
  }
  /** Delete stored attachment copies nothing refers to any more: the given ids at once, or a sweep of old leftovers. */
  private releaseAttachments(ids?: Iterable<string>) {
    this.attachments.release(ids);
  }
  private async roomDelete(threadId: string) {
    const thread = this.roomThread(threadId);
    if (
      !thread.archivedAt ||
      threadId === this.roomStore.currentRoomThread().id
    )
      throw new Error("当前话题请使用“清空当前话题”，不能删除");
    const sessions = this.roomSessions(true).filter(
      (session) => session.roomThreadId === threadId,
    );
    for (const session of sessions) {
      this.requireIdle(session.id, "删除历史话题");
      if (this.workspaceOperations.has(this.workspaceKey(session)))
        throw new Error("工作副本正在整理，请稍后删除话题。");
    }
    for (const session of sessions)
      await this.roomRuntimes.closeSession(session.id);
    const attached = this.roomStore
      .allRoomMessages(threadId)
      .flatMap((message) => [
        ...(message.attachments ?? []),
        ...(message.generatedImages ?? []),
      ])
      .map((item) => item.id);
    const removed: Run[] = [];
    this.roomStore.removeArchivedRoomThread(threadId, () => {
      for (const session of sessions)
        removed.push(...this.removeSessionRecords(session.id));
    });
    for (const session of sessions) {
      this.memberWorkspaces.sessionRemoved(session.id);
      await removeCheckpoint(session.id, this.store.dataDirectory).catch(
        () => {},
      );
    }
    this.releaseAttachments([
      ...attached,
      ...removed
        .flatMap((run) => [
          ...(run.attachments ?? []),
          ...(run.generatedImages ?? []),
        ])
        .map((item) => item.id),
    ]);
    this.broadcast();
    return { deleted: true };
  }
  private roomExport(threadId: string) {
    const thread = this.roomThread(threadId),
      messages = this.roomStore.allRoomMessages(threadId),
      team = [...this.store.members(), ...this.store.historicalMembers()];
    const name = (id: string) =>
      id === "user"
        ? this.store.profile().name
        : id === "system"
          ? "系统"
          : (team.find((member) => member.id === id)?.name ?? id);
    return {
      title: thread.title,
      content: roomMarkdown(thread, messages, name),
      count: messages.length,
    };
  }

  /** The card for a session: its chosen member, else the executor's built-in member. */
  private memberFor(
    session: Pick<Session, "provider" | "memberId">,
  ): MemberProfile {
    const members = this.store.members();
    const current=members.find(member=>member.id===(session.memberId??session.provider));
    if(current)return current.executor===session.provider?current:{...current,executor:session.provider as MemberProfile['executor'],model:undefined,effort:undefined};
    return (
      members.find(
        (member) =>
          member.id === (session.memberId ?? session.provider),
      ) ??
      this.store.get<MemberProfile>(
        "removed_members",
        session.memberId ?? session.provider,
      ) ??
      BUILTIN_MEMBERS.find((member) => member.id === session.provider) ?? {
        id: session.memberId ?? session.provider,
        executor: session.provider === "deepseek" ? "dsh" : session.provider,
        name: PROVIDER_NAMES[session.provider] ?? session.provider,
      }
    );
  }
  private projectConfiguration(
    project: Project,
    memberId: string,
  ): RequestedRunConfig {
    const member = this.store.members().find((item) => item.id === memberId);
    if (!member) throw new Error("配置中的成员不存在");
    return requestedConfig(
      project,
      member,
      this.settings,
      undefined,
      this.store.executors().find((item) => item.id === member.executor),
    );
  }
  private runConfiguration(session: Session): RequestedRunConfig {
    const member = this.memberFor(session);
    let project = this.require<Project>("projects", session.projectId);
    if (project.kind === "lounge" && project.roomId?.startsWith("project:"))
      project = this.require<Project>("projects", project.roomId.slice(8));
    if (project.kind === "lounge" && project.roomId?.startsWith("report:")) {
      const room = this.store.get<{ projectId: string }>(
        "personal_rooms",
        project.roomId,
      );
      if (room) project = this.require<Project>("projects", room.projectId);
    }
    const frozen =
      session.flowId &&
      (this.store.get<import("../shared/project-flow").ProjectFlow>(
        "project_flows",
        session.flowId,
      )?.memberConfigs?.[member.id] ??
        this.store.get<import("../shared/joint-review").JointReview>(
          "flow_joint_reviews",
          session.flowId,
        )?.memberConfigs?.[member.id]);
    if (frozen) return { ...frozen, capturedAt: now() };
    const rebound=this.store.members().find(item=>item.id===member.id)?.executor!==session.provider;
    return requestedConfig(
      rebound?{...project,memberConfigs:undefined}:project,
      member,
      this.settings,
      session.flowId ? undefined : session,
      this.store.executors().find((item) => item.id === member.executor),
    );
  }
  createSession(
    projectId: string,
    provider: ProviderId,
    title?: string,
    writeMode?: boolean,
    memberId?: string,
    purpose?: Session["purpose"],
  ): Session {
    if (this.removingProjects.has(projectId))
      throw new Error("项目正在移除，请稍后操作。");
    this.require<Project>("projects", projectId);
    const member = memberId
      ? this.store.members().find((item) => item.id === memberId)
      : undefined;
    if (memberId && !member) throw new Error("这位成员不存在，请刷新工作台");
    if (!memberId && this.store.get("removed_members", provider))
      throw new Error("这张人物卡已删除，请选择现有成员或添加新人物卡");
    if (member) provider = member.executor;
    if (!this.executorIds().includes(provider)) throw new Error("成员无效");
    const session: Session = {
      id: randomUUID(),
      projectId,
      provider,
      ...(member && (!member.builtIn || member.id !== provider) ? { memberId: member.id } : {}),
      title: title || `${member?.name ?? PROVIDER_NAMES[provider]} 对话`,
      ...(title ? {} : { autoTitle: true }),
      createdAt: now(),
      updatedAt: now(),
      revision: 1,
      writeMode: writeMode ?? this.settings.defaultWriteMode,
    };
    session.autoApprove = session.writeMode && this.settings.defaultAutoApprove;
    if (purpose) session.purpose = purpose;
    this.store.put("sessions", session.id, session);
    this.broadcast();
    return session;
  }
  private async steerActive(
    runId: string,
    text: string,
    deliveryId: string,
  ): Promise<"current" | "next-turn" | "unknown"> {
    const receipt = this.store.get<{ delivery: string }>("outbox", deliveryId);
    if (receipt)
      return receipt.delivery === "confirmed"
        ? "current"
        : receipt.delivery === "withdrawn"
          ? "next-turn"
          : "unknown";
    const active = this.active.get(runId),
      run = this.store.get<Run>("runs", runId);
    if (
      !this.alive ||
      this.maintenance ||
      !active ||
      active.stopping ||
      !run ||
      !["running", "waiting_user"].includes(run.status) ||
      !active.adapter.steer ||
      this.providers.find((info) => info.id === run.provider)?.capabilities
        .steer === false
    )
      return "next-turn";
    const entry = {
      sessionId: run.sessionId,
      runId,
      text,
      kind: "steer",
      createdAt: now(),
    };
    this.store.put("outbox", deliveryId, { ...entry, delivery: "prepared" });
    let timeout: NodeJS.Timeout | undefined;
    try {
      const accepted = await Promise.race([
        active.adapter.steer(text),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("补充投递确认超时，未重复发送。")),
            10000,
          );
        }),
      ]);
      if (!accepted) {
        this.store.put("outbox", deliveryId, {
          ...entry,
          delivery: "withdrawn",
          updatedAt: now(),
        });
        return "next-turn";
      }
      if (this.active.get(runId) !== active || active.stopping)
        throw new Error("确认补充时原运行已结束或停止，是否生效待核对。");
      this.store.put("outbox", deliveryId, {
        ...entry,
        delivery: "confirmed",
        updatedAt: now(),
      });
      this.emit(
        active.ctx,
        "message",
        text,
        { role: "user", intent: "supplement" },
        "derived",
      );
      this.emit(
        active.ctx,
        "status",
        "补充要求已传入当前轮次；正在运行的工具不会因此自动回滚",
        undefined,
        "derived",
      );
      return "current";
    } catch (error) {
      this.store.put("outbox", deliveryId, {
        ...entry,
        delivery: "unknown",
        error: (error as Error).message,
        updatedAt: now(),
      });
      this.emit(
        active.ctx,
        "warning",
        "补充要求是否送达还待核对，未重复发送。请核对活动记录和成员回复。",
        undefined,
        "derived",
      );
      return "unknown";
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  async send(
    sessionId: string,
    text: string,
    intent: "message" | "supplement" | "redirect" = "message",
    automatic?: AutomaticOrigin,
    attachments: Attachment[] = [],
    imageGeneration = false,
    flowOperationId?: string,
  ) {
    if (!this.alive) throw new Error("工作台正在退出，不能接收新任务");
    if (this.maintenance)
      throw new Error("正在备份或恢复资料，请等完成后再发送任务。");
    this.assertSessionUsable(this.require<Session>("sessions", sessionId));
    if (!text.trim() && attachments.length) text = "请看附件。";
    if (!text.trim()) throw new Error("请输入任务或问题");
    if (text.length > 200000)
      throw new Error("单次输入过长，请把材料保存为项目文件");
    let session = this.require<Session>("sessions", sessionId);
    if (this.store.get('removed_providers', session.provider)) throw new Error('这个执行端连接已删除，请重新添加连接后继续。');
    if (this.removingExecutors.has(session.provider)) throw new Error('执行端连接正在删除，请完成后再发送消息。');
    if (this.acpLogins.has(session.provider))
      throw new Error("这个执行端正在登录，请完成后再发送消息。");
    if (session.roomRetiredAt)
      throw new Error("这个聊天室会话已保留为历史，请在当前话题继续。");
    if (this.removingProjects.has(session.projectId))
      throw new Error("项目正在移除，请稍后操作。");
    if (session.flowId && !flowOperationId)
      throw new Error("这个会话属于项目任务，请通过项目会议室调整任务。");
    if (automatic) {
      if (
        (session.roomId && session.roomId !== "global") ||
        session.writeMode ||
        this.store.get<Project>("projects", session.projectId)?.kind !==
          "lounge"
      )
        throw new AutomaticDenied("自动发言只允许只读聊天室会话。");
      this.automaticAllowed(
        automatic,
        session.provider,
        session.model ||
          this.memberFor(session).model ||
          this.settings.models[session.provider],
      );
      if (this.store.get("blocked_sessions", session.id))
        throw new AutomaticDenied("成员上一轮仍待核对，未开始自动发言。");
    }
    if (this.workspaceOperations.has(this.workspaceKey(session)))
      throw new Error("工作副本正在整理，完成后再发送任务。");
    const phrase = text.trim().replace(/[。！!]+$/, "");
    if (
      /^(?:先不用聊|先别聊了|先停一停|暂停协作|这个做完(?:先)?等我看|这(?:个|轮)做完(?:先)?等我看)$/.test(
        phrase,
      )
    ) {
      const collaborations = this.store
        .list<Collaboration>("collaborations")
        .filter(
          (x) =>
            x.projectId === session.projectId &&
            x.sessionIds.includes(sessionId) &&
            x.status === "running",
        );
      for (const collaboration of collaborations)
        this.pauseCollaboration(collaboration.id);
      this.withdrawQueued(sessionId, "用户暂停后续交接或排队任务");
      this.store.put("blocked_sessions", sessionId, {
        reason: "你已暂停后续发言",
        createdAt: now(),
      });
      this.broadcast();
      return {
        delivery: "paused",
        scope: collaborations.length ? "collaboration" : "session",
        activeTaskContinues: true,
      };
    }
    if (this.store.get("blocked_sessions", sessionId)) {
      if (intent === "supplement")
        throw new Error(
          "上一轮已停止或结果待核对，请明确发送新的任务或改变方向；不会继续旧队列",
        );
      intent = "redirect";
    }
    const running = [...this.active.entries()].find(
      ([, entry]) => entry.ctx.session.id === sessionId,
    );
    if (intent === "redirect") {
      session = {
        ...session,
        revision: session.revision + 1,
        updatedAt: now(),
      };
      this.store.put("sessions", session.id, session);
      this.withdrawQueued(sessionId, "旧方向的排队要求已撤回");
      if (running) await this.stopRun(running[0]);
      session = this.require<Session>("sessions", sessionId);
      this.store.delete("blocked_sessions", sessionId);
      // Steering carries text only; a supplement with files waits for the next turn instead.
    } else if (
      intent === "supplement" &&
      running &&
      !running[1].stopping &&
      running[1].adapter.steer &&
      !attachments.length
    ) {
      const deliveryId = randomUUID(),
        delivery = await this.steerActive(running[0], text, deliveryId);
      if (delivery === "current")
        return { delivery: "current", runId: running[0] };
      if (delivery === "unknown")
        throw new Error(
          this.store.get<{ error?: string }>("outbox", deliveryId)?.error ??
            "补充投递结果待核对，未重复发送。",
        );
    }
    if (this.workspaceOperations.has(this.workspaceKey(session)))
      throw new Error("工作副本正在整理，完成后再发送任务。");
    const run: Run = {
      id: randomUUID(),
      sessionId,
      projectId: session.projectId,
      provider: session.provider,
      revision: session.revision,
      status: "queued",
      input: text,
      createdAt: now(),
      updatedAt: now(),
      bootId: this.bootId,
      delivery: "prepared",
      ...(automatic ? { automatic } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(imageGeneration ? { imageGeneration: true } : {}),
    };
    if (this.removingProjects.has(session.projectId))
      throw new Error("项目正在移除，请稍后操作。");
    if (session.writeMode) {
      assertProjectSerial(this.store, session.projectId);
      run.writeBoundary = captureProjectBoundary(this.store, session.projectId);
    }
    if (flowOperationId) run.flowOperationId = flowOperationId;
    this.store.transaction(() => {
      this.store.put("runs", run.id, run);
      this.store.put("outbox", run.id, {
        runId: run.id,
        sessionId,
        delivery: "prepared",
        createdAt: now(),
      });
      if (flowOperationId) {
        const op = this.require<FlowOperation>(
          "flow_operations",
          flowOperationId,
        );
        this.store.put("flow_operations", op.id, {
          ...op,
          state: "running",
          ...(op.runId ? { correctionRunId: run.id } : { runId: run.id }),
          updatedAt: now(),
        });
      }
    });
    this.store.put("sessions", session.id, { ...session, updatedAt: now() });
    this.broadcast();
    void this.schedule();
    return { delivery: running ? "queued" : "prepared", runId: run.id };
  }
  private async schedule() {
    if (!this.alive || this.maintenance) return;
    const pending = this.store
      .list<Run>("runs")
      .filter((x) => x.status === "queued");
    for (const run of pending) {
      if (this.active.size >= this.settings.maxParallel) break;
      if (
        [...this.active.values()].some(
          (x) => x.ctx.session.id === run.sessionId,
        )
      )
        continue;
      if (this.acpLogins.has(run.provider)) continue;
      if (run.flowOperationId) {
        const op = this.store.get<FlowOperation>(
            "flow_operations",
            run.flowOperationId,
          ),
          flow =
            op &&
            (op.jointReviewId
              ? this.store.get<{ dispatchMode: string }>(
                  "flow_joint_reviews",
                  op.jointReviewId,
                )
              : this.store.get<{ dispatchMode: string }>(
                  "project_flows",
                  op.flowId,
                )),
          session = this.store.get<Session>("sessions", run.sessionId);
        if (
          flow?.dispatchMode !== "running" ||
          !session ||
          !this.flowQuotaAllows(
            session.memberId ?? session.provider,
            (run.requestedConfig ?? this.runConfiguration(session)).model,
          )
        )
          continue;
      }
      if (this.store.get("blocked_sessions", run.sessionId)) continue;
      if (this.roomStartChecks.get(run.sessionId)?.() === false) {
        this.withdrawQueued(
          run.sessionId,
          "讨论已暂停或轮次更新，排队请求已撤回",
        );
        continue;
      }
      const session = this.require<Session>("sessions", run.sessionId);
      if (session.revision !== run.revision) {
        this.persistRun(run, { status: "stopped", delivery: "withdrawn" });
        continue;
      }
      const ctx = this.context(run, session);
      const active: Active = {
        adapter: this.adapter(run.provider),
        ctx,
        children: [],
        stopping: false,
      };
      this.active.set(run.id, active);
      const roomId =
        session.roomId ??
        (run.origin?.threadId
          ? this.store.get<RoomThread>("room_threads", run.origin.threadId)
              ?.roomId
          : undefined) ??
        "global";
      const execution = this.rooms.run(roomId, () => this.execute(active));
      active.completion = execution;
      this.executions.add(execution);
      void execution.then(
        () => this.executions.delete(execution),
        () => this.executions.delete(execution),
      );
    }
  }
  /** The project bound to a project meeting room, resolved for read-only access by room speech. */
  private projectRoomDirectory(roomId: string | undefined) {
    if (!roomId?.startsWith("project:")) return;
    const project = this.store.get<Project>("projects", roomId.slice(8));
    if (!project || project.kind) return;
    try {
      return realpathSync(project.directory);
    } catch {
      return;
    }
  }
  private context(run: Run, session: Session): AdapterContext {
    const project = this.require<Project>("projects", session.projectId);
    // Model and thinking level: the session's choice, else the member card's, else the executor default.
    const member = this.memberFor(session);
    const config = run.requestedConfig ?? this.runConfiguration(session);
    if (!run.requestedConfig) {
      run.requestedConfig = config;
      this.persistRun(run, { requestedConfig: config });
    }
    const runSettings: Settings = {
      ...this.settings,
      models: { ...this.settings.models, [run.provider]: config.model },
      efforts: { ...this.settings.efforts, [run.provider]: config.effort },
    };
    // A native session identifies conversation history, not an installed program version.
    // Subsequent turns use the currently selected executor, including after old-version cleanup.
    if (run.provider !== "deepseek")
      runSettings.permissions = {
        ...runSettings.permissions,
        [run.provider]: memberPermissions(this.settings, member, isAcpId(run.provider) ? this.store.get<AcpExecutor>("executors", run.provider) : undefined),
      };
    // The chat room is conversation only: no commands and no file changes, whatever the member's defaults.
    if (project.kind === "lounge" && run.provider !== "deepseek")
      runSettings.permissions = {
        ...runSettings.permissions,
        [run.provider]: {
          ...runSettings.permissions[run.provider],
          commands: "deny",
          fileScope: "workspace",
        },
      };
    const ctx: AdapterContext = {
      run,
      session,
      conversation: project.kind === 'lounge' ? 'room' : !session.purpose && !session.flowId && !run.flowOperationId && this.store.get('desk_session_links',session.id) ? 'desk' : undefined,
      roomProjectDirectory: project.kind === "lounge" ? this.projectRoomDirectory(project.roomId) : undefined,
      settings: runSettings,
      persona: personaInstructions(
        member,
        this.store.profile(),
        this.store.members(),
      ),
      ...(run.attachments?.length
        ? {
            attachments: run.attachments.map((item) => ({
              ...item,
              path: attachmentPath(this.store.dataDirectory, item),
            })),
          }
        : {}),
      cwd: session.workspace || project.directory,
      env: buildEnvironment(this.settings),
      deepseekKey: this.key,
      emit: (kind, text, data, fidelity) => {
        const active = this.active.get(run.id);
        if (active?.ctx !== ctx || active.replyExpired) return;
        if (
          (text.trim() &&
            ["delta", "reasoning", "plan", "tool", "output", "image"].includes(
              kind,
            )) ||
          (kind === "message" &&
            text.trim() &&
            !(data as { role?: string } | undefined)?.role)
        )
          active.replyWatchdog?.progress();
        if (
          ["subscription", "account", "api", "none"].includes(
            (data as any)?.auth,
          )
        )
          observeAccount((data as any).auth);
        if (
          (kind === "delta" ||
            (kind === "message" && (data as any)?.source === "assistant")) &&
          text.trim()
        )
          active.metrics?.mark("first-output");
        this.emit(ctx, kind, text, data, fidelity);
      },
      approve: (request) => this.requestApproval(ctx, request),
      persistNativeSession: (id, nativeHome) => {
        if (
          this.closed ||
          session.purpose === "room-hand" ||
          session.purpose === "room-image" ||
          session.purpose === "room-minutes" ||
          session.purpose === "room-mention" ||
          this.active.get(run.id)?.ctx !== ctx ||
          this.active.get(run.id)?.replyExpired
        )
          return;
        const current = this.require<Session>("sessions", session.id);
        const identity=currentIdentity();
        if (
          current.nativeId === id &&
          (!nativeHome || current.nativeHome === nativeHome) &&
          (!identity || sameMemberProgram(identity,current.executorIdentity))
        )
          return;
        this.store.put("sessions", session.id, {
          ...current,
          nativeId: id,
          ...(identity
            ? { executorIdentity: identity }
            : {}),
          ...(nativeHome ? { nativeHome } : {}),
          updatedAt: now(),
        });
        this.broadcast();
      },
      persistNativePersona: (nativeId, hash) => {
        if (this.closed || this.active.get(run.id)?.ctx !== ctx || this.active.get(run.id)?.replyExpired) return;
        const current = this.require<Session>('sessions',session.id);
        if (current.nativeId !== nativeId) return;
        if (current.nativePersona?.nativeId === nativeId && current.nativePersona.hash === hash) return;
        this.store.put('sessions',session.id,{...current,nativePersona:{nativeId,hash}});
      },
      invalidateNativeContext: () => {
        if (this.active.get(run.id)?.ctx !== ctx || this.active.get(run.id)?.replyExpired) return;
        ctx.nativeContextInvalidated = true;
        const current = this.require<Session>('sessions', session.id);
        if (current.nativeId) this.store.put('sessions', session.id, {
          ...current,
          nativeContext: { nativeId: current.nativeId, turnsSinceRefresh: 0, inputCharsSinceRefresh: 0, ...current.nativeContext, refreshRequired: true },
        });
      },
      progress: () => {
        if (this.active.get(run.id)?.ctx === ctx && !this.active.get(run.id)?.replyExpired)
          this.active.get(run.id)?.replyWatchdog?.progress();
      },
      markDelivery: (delivery, nativeTurnId) => {
        const active = this.active.get(run.id);
        if (active?.ctx !== ctx || active.stopping || active.replyExpired)
          return;
        if (delivery === "sent") active.metrics?.mark("sent");
        this.persistRun(run, {
          delivery,
          ...(nativeTurnId ? { nativeTurnId } : {}),
        });
        this.store.put("outbox", run.id, {
          runId: run.id,
          sessionId: session.id,
          delivery,
          nativeTurnId,
          updatedAt: now(),
        });
      },
      registerProcess: (child) => {
        const active = this.active.get(run.id);
        if (active?.ctx !== ctx || active.replyExpired) {
          this.owned(child);
          void stopOwned(child, 1000).catch(() => {});
          return;
        }
        active?.children.push(child);
        if (active?.lease?.cached) active.lease.children.add(child);
        if (active?.metrics) active.metrics.processes++;
        this.owned(child);
      },
      recordTiming: (phase) => this.active.get(run.id)?.metrics?.mark(phase),
      recordConfig: (value) => {
        if (
          this.active.get(run.id)?.ctx !== ctx ||
          this.active.get(run.id)?.replyExpired
        )
          return;
        const current = this.require<Run>("runs", run.id);
        this.persistRun(run, {
          effectiveConfig: {
            ...current.effectiveConfig,
            ...redact(value),
            at: now(),
          },
        });
      },
      recordRuntime: (stage, conditions) =>
        this.active.get(run.id)?.metrics?.decision(stage, conditions),
    };
    const fresh = this.roomContextInputs.get(session.id);
    if (fresh) {
      const rebuildInput = (canRemember: boolean, refreshRules = false) => {
        if (
          this.active.get(run.id)?.ctx !== ctx ||
          this.active.get(run.id)?.replyExpired
        )
          throw new Error("这轮聊天室回复已结束或隔离，不能重新发送。");
        const text = fresh(canRemember, refreshRules),
          attachments = this.roomContextAttachments.get(session.id)?.();
        ctx.run.input = text;
        if (attachments) {
          ctx.run.attachments = attachments;
          ctx.attachments = attachments.length ? attachments.map((item) => ({
            ...item,
            path: attachmentPath(this.store.dataDirectory, item),
          })) : undefined;
        }
        this.store.put("runs", run.id, {
          ...this.require<Run>("runs", run.id),
          input: text,
          ...(attachments ? { attachments } : {}),
        });
        this.emit(
          ctx,
          "status",
          refreshRules ? "已补齐本轮会议规则，继续读取未读消息。" : "成员重新开始了聊天，已补齐本次讨论记录，可以继续接话。",
          undefined,
          "derived",
        );
        return text;
      };
      ctx.freshInput = (canRemember) => rebuildInput(canRemember);
      ctx.refreshInput = () => rebuildInput(true, true);
    }
    return ctx;
  }
  private async execute(active: Active) {
    const ctx = active.ctx,
      report = newCompatibility(ctx.run.provider, "run", ctx.settings);
    Object.assign(report, {
      runId: ctx.run.id,
      sessionId: ctx.session.id,
      restore: ctx.session.nativeId ? "current-version" : "new",
    });
    this.persistRun(ctx.run, { compatibilityReportId: report.id });
    this.rememberCompatibility(report);
    try {
      await withCompatibility(
        report,
        () => this.executeWithContext(active),
      );
    } finally {
      const run = this.store.get<Run>("runs", ctx.run.id);
      report.completedAt = now();
      report.delivery = run?.delivery;
      report.effectiveConfig = run?.effectiveConfig;
      report.outcome =
        run?.status === "ended"
          ? "passed"
          : run?.status === "unknown"
            ? "unknown"
            : run?.status === "stopped"
              ? "stopped"
              : "failed";
      report.error = run?.error;
      this.rememberCompatibility(report);
      if (run && report.identity.path)
        this.persistRun(ctx.run, { executorIdentity: report.identity });
      const info = this.providers.find((item) => item.id === ctx.run.provider);
      if (info && !this.closed)
        this.publishProvider({ ...info, lastRunCompatibility: report });
    }
  }
  private executeWithContext(active: Active) {
    const engine = this;
    return executeRun({
      store: this.store,
      get settings() { return engine.settings; },
      get alive() { return engine.alive; },
      get closed() { return engine.closed; },
      active: this.active,
      roomStartChecks: this.roomStartChecks,
      roomRuntimes: this.roomRuntimes,
      automaticBudget: this.automaticBudget,
      deferredProbeRetries: this.deferredProbeRetries,
      probeRevisions: this.probeRevisions,
      timing: this.timing,
      require: this.require.bind(this),
      persistRun: this.persistRun.bind(this),
      emit: this.emit.bind(this),
      acceptsImages: this.acceptsImages.bind(this),
      automaticAllowed: this.automaticAllowed.bind(this),
      stopRun: this.stopRun.bind(this),
      flushRun: this.flushRun.bind(this),
      blockSession: this.blockSession.bind(this),
      expireApprovals: this.expireApprovals.bind(this),
      confirmProvider: this.confirmProvider.bind(this),
      probe: this.probe.bind(this),
      reportHandoff: this.reportHandoff.bind(this),
      markStaleReviews: this.markStaleReviews.bind(this),
      broadcast: this.broadcast.bind(this),
      schedule: this.schedule.bind(this),
    }, active);
  }
  private requestApproval(
    ctx: AdapterContext,
    request: Parameters<AdapterContext["approve"]>[0],
  ): Promise<{ choice: string; answers?: unknown }> {
    if (
      !this.alive ||
      !this.active.has(ctx.run.id) ||
      this.active.get(ctx.run.id)?.stopping ||
      this.active.get(ctx.run.id)?.replyExpired
    )
      return Promise.reject(new Error("本轮已停止或结束，不再受理新的审批"));
    const approval: Approval = {
      ...redact(request),
      id: randomUUID(),
      runId: ctx.run.id,
      sessionId: ctx.session.id,
      provider: ctx.run.provider,
      state: "pending",
      createdAt: now(),
    };
    // "帮我批准": answer with the member's own allow option when the user set a rule for this session.
    const session = this.store.get<Session>("sessions", ctx.session.id);
    const room = session?.roomId && this.rooms.get(session.roomId).store;
    const discussion = room?.roomState().discussion;
    const skipQuestion =
      approval.type === "question" &&
      session &&
      this.store.get<Project>("projects", session.projectId)?.kind ===
        "lounge" &&
      !["room-image", "room-summary", "room-minutes"].includes(
        session.purpose ?? "",
      ) &&
      session.roomThreadId === room?.currentRoomThread().id &&
      discussion?.style === "chat" &&
      ["talking", "closing"].includes(discussion.phase) &&
      approval.options.find((option) =>
        ["cancel", "decline", "skip", "reject"].includes(option.id),
      );
    if (skipQuestion && room && discussion) {
      const memberId = session!.memberId ?? session!.provider,
        messageId = randomUUID();
      const text = approval.detail.trim() || approval.title;
      this.store.transaction(() => {
        this.store.put("approvals", approval.id, {
          ...approval,
          state: "expired",
        });
        room.put("room_messages", messageId, {
          id: messageId,
          threadId: room.currentRoomThread().id,
          author: memberId,
          authorName: this.memberFor(session!).name,
          text,
          status: "done",
          at: now(),
          discussionId: discussion.id,
          discussionRevision: discussion.revision,
        });
        const optional = {
          id: `${messageId}:q0`,
          from: memberId,
          to: "user",
          text,
          messageId,
        };
        const questions = [
          ...discussion.questions.filter((q) => q.to !== "user"),
          ...discussion.questions.filter((q) => q.to === "user").slice(-63),
          optional,
        ];
        room.put("room", "state", {
          ...room.roomState(),
          discussion: { ...discussion, questions },
        });
      });
      this.emit(
        ctx,
        "question",
        text,
        { ...approval, state: "expired" },
        "native",
      );
      this.emit(
        ctx,
        "status",
        "闲聊问题已保留，你可以稍后回答；没有代填答案，大家继续聊天。",
        undefined,
        "derived",
      );
      this.broadcast();
      return Promise.resolve({ choice: skipQuestion.id });
    }
    const rule =
      approval.type === "approval" &&
      approval.allowChoice &&
      approval.options.some((x) => x.id === approval.allowChoice)
        ? session?.autoApprove
          ? "本会话全部自动批准"
          : approval.category &&
              session?.approvalRules?.includes(approval.category)
            ? `本会话允许此类：${approval.categoryLabel || approval.category}`
            : undefined
        : undefined;
    if (rule) {
      this.store.put("approvals", approval.id, {
        ...approval,
        state: "answered",
        autoApproved: rule,
        answeredChoice: approval.allowChoice,
      });
      this.emit(
        ctx,
        "status",
        `已按你的设置自动批准（${rule}）：${approval.title}`,
        { approvalId: approval.id, rule },
        "derived",
      );
      this.broadcast();
      return Promise.resolve({ choice: approval.allowChoice! });
    }
    this.store.put("approvals", approval.id, approval);
    const reply = new Promise<{ choice: string; answers?: unknown }>(
      (resolve, reject) => this.approvals.set(approval.id, { resolve, reject }),
    );
    this.persistRun(ctx.run, { status: "waiting_user" });
    this.active.get(ctx.run.id)?.replyWatchdog?.waitForUser();
    this.emit(
      ctx,
      approval.type === "question" ? "question" : "approval",
      approval.detail,
      approval,
      "native",
    );
    this.broadcast();
    return reply;
  }
  private answer(params: any) {
    const approval = this.require<Approval>("approvals", String(params.id));
    const pending = this.approvals.get(approval.id);
    const run = this.require<Run>("runs", approval.runId);
    const session = this.require<Session>("sessions", approval.sessionId);
    if (
      approval.state !== "pending" ||
      !pending ||
      this.active.get(run.id)?.stopping ||
      session.revision !== run.revision
    )
      throw new Error(
        "这项审批或问题已失效，不能使用旧答案。请刷新会话，查看当前待回答的问题。",
      );
    // AIROOM's own controls translate to the member's native allow/deny option.
    let choice = String(params.choice || "answer");
    let stopAfter = false;
    if (
      choice.startsWith("airoom:") &&
      !approval.options.some((option) => option.id === choice)
    ) {
      if (
        !approval.allowChoice ||
        !approval.options.some((x) => x.id === approval.allowChoice)
      )
        throw new Error("这个请求没有可代为批准的原生选项");
      if (choice === "airoom:allow-category" && approval.category)
        this.store.put("sessions", session.id, {
          ...session,
          approvalRules: [
            ...new Set([...(session.approvalRules ?? []), approval.category]),
          ],
        });
      else if (choice === "airoom:allow-all")
        this.store.put("sessions", session.id, {
          ...session,
          autoApprove: true,
        });
      else if (choice === "airoom:deny-stop") {
        if (!approval.denyChoice) throw new Error("这个请求没有可用的拒绝选项");
        stopAfter = true;
      } else throw new Error("未知的审批选项");
      choice = stopAfter ? approval.denyChoice! : approval.allowChoice;
    } else if (
      approval.options.length &&
      !approval.options.some((x) => x.id === choice)
    )
      throw new Error("请选择执行端实际提供的选项");
    this.store.put("approvals", approval.id, {
      ...approval,
      state: "answered",
      answeredChoice: choice,
    });
    this.approvals.delete(approval.id);
    this.persistRun(run, { status: "running" });
    this.active.get(run.id)?.replyWatchdog?.userAnswered();
    pending.resolve({ choice, answers: params.answers });
    if (stopAfter) void this.stopRun(run.id).catch(() => {});
    this.broadcast();
    return { answered: true };
  }
  private expireApprovals(runId: string) {
    for (const approval of this.store
      .list<Approval>("approvals")
      .filter((x) => x.runId === runId && x.state === "pending")) {
      this.store.put("approvals", approval.id, {
        ...approval,
        state: "expired",
      });
      this.approvals
        .get(approval.id)
        ?.reject(new Error("本轮已停止或结束，原审批已失效"));
      this.approvals.delete(approval.id);
    }
  }
  private withdrawQueued(sessionId: string, reason: string) {
    for (const queued of this.store
      .list<Run>("runs")
      .filter((x) => x.sessionId === sessionId && x.status === "queued")) {
      this.persistRun(queued, {
        status: "stopped",
        delivery: "withdrawn",
        error: reason,
        completedAt: now(),
      });
      const outbox = this.store.get<Record<string, unknown>>(
        "outbox",
        queued.id,
      );
      if (outbox)
        this.store.put("outbox", queued.id, {
          ...outbox,
          delivery: "withdrawn",
          updatedAt: now(),
        });
    }
  }
  private blockSession(sessionId: string, runId: string, reason: string) {
    const session = this.require<Session>("sessions", sessionId),
      run = this.require<Run>("runs", runId);
    if (session.revision !== run.revision) return; // A late old-direction result cannot withdraw the new direction.
    this.store.put("blocked_sessions", sessionId, {
      runId,
      reason,
      createdAt: now(),
    });
    this.withdrawQueued(sessionId, reason);
  }
  async stopRun(runId: string) {
    const run = this.require<Run>("runs", runId);
    const active = this.active.get(runId);
    if (!active && run.status !== "queued") return;
    this.blockSession(run.sessionId, run.id, "用户停止成员，旧队列不会继续");
    if (run.status === "queued" && !active) {
      this.persistRun(run, {
        status: "stopped",
        delivery: "withdrawn",
        completedAt: now(),
      });
      return;
    }
    if (!active) return;
    if (active.stopPromise) return active.stopPromise;
    active.stopping = true;
    this.persistRun(run, { status: "stopping" });
    this.expireApprovals(runId);
    this.emit(
      active.ctx,
      "status",
      "已收到停止要求，正在等待成员程序取消本轮并退出。",
      undefined,
      "derived",
    );
    active.stopPromise = (async () => {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(
          () => resolve("timeout"),
          this.settings.stopTimeoutMs,
        );
      });
      const cancellation = Promise.resolve()
        .then(() => active.adapter.stop())
        .catch((error) => {
          if (!this.closed)
            this.emit(
              active.ctx,
              "warning",
              `取消失败，继续核对进程：${(error as Error).message}`,
              undefined,
              "derived",
            );
        });
      const finished = Promise.all([
        cancellation,
        active.completion ?? Promise.resolve(),
      ]);
      const outcome = await Promise.race([finished, timeout]);
      if (timer) clearTimeout(timer);
      if (outcome === "timeout") {
        await Promise.all(
          active.children.map((child) =>
            stopOwned(child, 2000).catch((error) =>
              this.emit(
                active.ctx,
                "warning",
                (error as Error).message,
                undefined,
                "derived",
              ),
            ),
          ),
        );
        if (this.active.has(runId))
          this.emit(
            active.ctx,
            "warning",
            "成员程序尚未确认完全停止。请查看活动记录；确认前不会启动新任务。",
            undefined,
            "derived",
          );
      }
    })();
    return active.stopPromise;
  }
  private memberStopPreview(memberId: string) {
    if (!this.store.members().some((m) => m.id === memberId))
      throw new Error("这位成员不存在，请刷新团队。");
    const runs = this.store
      .list<Run>("runs")
      .filter((run) => {
        const session = this.store.get<Session>("sessions", run.sessionId);
        return (
          session &&
          (session.memberId ?? session.provider) === memberId &&
          (this.active.has(run.id) ||
            (!run.completedAt &&
              ["queued", "running", "waiting_user", "stopping"].includes(
                run.status,
              )))
        );
      })
      .map((run) => {
        const session = this.store.get<Session>("sessions", run.sessionId)!,
          project = this.store.get<Project>("projects", session.projectId),
          roomId = session.roomId ?? project?.roomId;
        const location =
          roomId === "global"
            ? "茶歇室"
            : roomId?.startsWith("roundtable:")
              ? "圆桌"
              : roomId?.startsWith("project:")
                ? "项目会议室"
                : roomId?.startsWith("report:")
                  ? "个人汇报"
                  : this.store.get("desk_session_links", session.id) ||
                      roomId?.startsWith("desk:")
                    ? "个人工位"
                    : run.flowOperationId
                      ? "项目工作"
                      : "单人对话";
        return {
          runId: run.id,
          sessionId: session.id,
          status: run.status,
          title: session.title,
          projectName: project?.kind ? undefined : project?.name,
          location,
          updatedAt: run.updatedAt,
        };
      })
      .sort((a, b) => a.runId.localeCompare(b.runId));
    return {
      memberId,
      runs,
      token: createHash("sha256")
        .update(JSON.stringify(runs.map(({ updatedAt, ...run }) => run)))
        .digest("hex"),
    };
  }
  private async stopMember(params: Record<string, unknown>) {
    const memberId = String(params.memberId),
      preview = this.memberStopPreview(memberId);
    if (params.confirm !== true || params.token !== preview.token)
      throw new Error("这位成员的运行已变化，请重新查看列表并确认中止。");
    this.memberWorkspaces.cancelPending(memberId);
    for (const state of this.store.list<RoomState>("room_states")) {
      const roomId = state.roomId ?? "global";
      // Historical states may outlive their project, topic or personal room.
      // They must never block cancellation of this member's live runs.
      try { this.store.validateRoomId(roomId); } catch { continue; }
      if (
        state.discussion?.members.includes(memberId) ||
        state.discussion?.mentionQueue?.some((q) => q.memberId === memberId)
      )
        this.rooms.run(roomId, () => this.discussion.stopMember(memberId));
    }
    await Promise.all(preview.runs.map((run) => this.stopRun(run.runId)));
    await Promise.all(
      preview.runs.map((run) => this.roomRuntimes.closeSession(run.sessionId)),
    );
    this.broadcast();
    return {
      requested: preview.runs.length,
      remaining: this.memberStopPreview(memberId).runs,
    };
  }
  async stopAll() {
    for (const id of this.executorLoginAdapters.keys())
      this.executorLoginStates.set(id, {
        phase: "cancelled",
        message: "登录已取消。",
      });
    await Promise.allSettled(
      [...this.executorLoginAdapters.values()].map((adapter) => adapter.stop()),
    );
    this.memberWorkspaces?.cancelPending();
    this.projectFlow?.pauseAll();
    if (this.alive) this.automation.pause();
    for (const state of this.store.list<RoomState>("room_states")) {
      const id = state.roomId ?? "global";
      // Only discussion rooms participate here; personal room shutdown is
      // handled by the run/session cancellation below.
      if (id !== "global" && !id.startsWith("project:") && !id.startsWith("roundtable:")) continue;
      try { this.store.validateRoomId(id); } catch { continue; }
      this.rooms.run(id, () => {
        this.discussion.pause("你已全部停止，等待明确继续。");
        this.roomStopping = true;
      });
    }
    for (const collab of this.store
      .list<Collaboration>("collaborations")
      .filter((x) => x.status === "running"))
      this.pauseCollaboration(collab.id);
    for (const sessionId of new Set(
      this.store
        .list<Run>("runs")
        .filter((x) => x.status === "queued")
        .map((x) => x.sessionId),
    ))
      this.withdrawQueued(sessionId, "用户全部停止，旧队列不会继续");
    await Promise.all([...this.active.keys()].map((id) => this.stopRun(id)));
    await this.roomRuntimes.closeAll();
  }
  async startCollaboration(_params: any) {
    throw new Error(
      "旧协作记录只供阅读；共同评审请在圆桌开新议题，项目工作请在会议室启动流程。",
    );
  }
  pauseCollaboration(id: string) {
    return this.legacyCollaborations.pause(id);
  }
  resumeCollaboration(id: string) {
    return this.legacyCollaborations.resume(id);
  }
  private async diagnostics() {
    const directory = path.join(this.store.dataDirectory, "diagnostics");
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, `airoom-${Date.now()}.json`);
    // Interface errors the window recorded (newest last), so a blank or broken panel can be traced.
    const rendererErrors = await readFile(
      path.join(this.store.dataDirectory, "logs", "renderer-errors.log"),
      "utf8",
    ).then(
      (text) =>
        text
          .trim()
          .split("\n")
          .filter(Boolean)
          .slice(-50)
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return line;
            }
          }),
      () => [],
    );
    const roomRuntime = await readFile(
      path.join(this.store.dataDirectory, "logs", "room-runtime.jsonl"),
      "utf8",
    ).then(
      (text) =>
        text
          .trim()
          .split("\n")
          .filter(Boolean)
          .slice(-100)
          .flatMap((line) => {
            try {
              return [JSON.parse(line)];
            } catch {
              return [];
            }
          }),
      () => [],
    );
    await writeFile(
      file,
      JSON.stringify(
        redact({
          exportedAt: now(),
          bootId: this.bootId,
          // Diagnostics keep the full run records the workbench snapshot omits.
          snapshot: { ...this.snapshot(), runs: this.store.list<Run>("runs") },
          rendererErrors,
          roomRuntime,
          // Why flow replies needed a format correction, without the reply text.
          formatCorrections: formatCorrectionSummary(this.store),
        }),
        null,
        2,
      ),
    );
    return { path: file };
  }
  async close() {
    if (this.closing) return this.closing;
    this.alive = false;
    for (const id of this.executorIds()) this.cancelProbeRetry(id);
    const timersClosed = this.automation.close();
    this.closing = (async () => {
      await this.stopAll();
      await timersClosed;
      await this.projectFlow.close();
      await Promise.allSettled([...this.executions, ...this.flowTasks]);
      for (const key of [...this.buffers.keys()]) this.flush(key);
      await disposeOwned();
      await Promise.allSettled([...this.loginChecks]);
      this.closed = true;
      if (this.fingerprints) setProgramFingerprintStore(undefined, this.fingerprints);
      this.store.close();
    })();
    return this.closing;
  }
}
