/** Configured external AI programs. The historical acp- ID prefix also covers reviewed native CLI adapters. */
export type AcpExecutorId = `acp-${string}`;
export type ProviderId = 'codex' | 'claude' | 'dsh' | 'deepseek' | AcpExecutorId;
export type RunStatus = 'queued' | 'running' | 'waiting_user' | 'rate_limited' | 'stopping' | 'stopped' | 'ended' | 'completed' | 'interrupted' | 'unknown' | 'failed';
export type EventKind = 'message' | 'delta' | 'reasoning' | 'plan' | 'tool' | 'output' | 'approval' | 'question' | 'status' | 'usage' | 'warning' | 'error' | 'session' | 'image';
/** User-adjustable execution boundary for one member; applied on each new run. */
export interface MemberPermissions {
  /** ask: request command approval where supported · auto: execute automatically · deny: no command tools. */
  commands: 'ask' | 'auto' | 'deny';
  /** workspace restricts file tools/writes; native commands may still read outside it. */
  fileScope: 'workspace' | 'any';
  network: boolean;
}
export type PermissionMember = 'codex' | 'claude' | 'dsh' | AcpExecutorId;
export interface AcpExecutor {
  id: AcpExecutorId;
  /** Shown wherever the built-ins show "Claude", "Codex" or "DeepSeek Harness". */
  name: string;
  /** Absolute path to the program: an .exe, a Node script, or an npm .cmd shim (resolved to its script). */
  command: string;
  args: string[];
  /** Extra environment for the program only, e.g. its own config directory. */
  env: Record<string, string>;
  /** Names of variables kept encrypted outside the database (API keys, tokens); their values never reach the renderer. */
  secretKeys?: string[];
  permissions: MemberPermissions;
  model?: string;
  createdAt: string;
  /** Set by the reviewed catalog installer; manual edits detach managed version tracking. */
  catalogId?: import('./executor-catalog').CatalogId;
  authentication?: string;
}
export interface Settings {
  networkMode: 'tun' | 'proxy'; proxyUrl: string;
  npmRegistry?: 'official' | 'npmmirror';
  nodeRuntime?: 'bundled' | 'local';
  claudeAuthMode?: 'subscription' | 'api';
  paths: Partial<Record<ProviderId, string>>;
  models: Partial<Record<ProviderId, string>>;
  /** Thinking level per member; empty means the model default. */
  efforts: Partial<Record<ProviderId, string>>;
  deepseekEnabled: boolean; deepseekBaseUrl: string;
  dshProfile: string; maxParallel: number;
  stopTimeoutMs: number; defaultWriteMode: boolean;
  /** Background speech is independently opt-in; explicit user conversations keep their own budgets. */
  automationPolicies?: import('./automation').AutomaticPolicies;
  dailyLife?: import('./automation').DailyLifeOptions;
  discussionCallLimits?: import('./discussion-budget').DiscussionCallLimits;
  /** New write-capable sessions answer native operation approvals automatically; questions still wait. */
  defaultAutoApprove: boolean;
  maxRunMinutes: number; deepseekMaxRequests: number;
  permissions: Record<PermissionMember, MemberPermissions>;
  /** Per-person overrides. Missing fields inherit the executor's defaults. */
  memberPermissions?: Record<string, Partial<MemberPermissions>>;
}
/** A model the member advertised (or a known alias), with the thinking levels it accepts. */
export interface ModelOption { id: string; label: string; efforts: string[]; defaultEffort?: string; isDefault?: boolean; description?: string; aliases?: string[]; effortSource?: 'reported' | 'documented' | 'unreported' | 'unsupported' }
export interface ProviderInfo {
  compatibility?: import('./compatibility').CompatibilityReport;
  lastRunCompatibility?: import('./compatibility').CompatibilityReport;
  installationRequired?:boolean;
  id: ProviderId; name: string; available: boolean; auth: 'subscription' | 'account' | 'api' | 'none' | 'unknown';
  version?: string; path?: string; model?: string; detail: string;
  capabilities: { steer: boolean; cancel: 'native' | 'process' | 'request'; streaming: boolean; write: boolean; history: boolean;
    /** The program receives attached images as pictures; otherwise the member is told it cannot see them. */
    images?: boolean;
    /** Native image generation, distinct from accepting image inputs. */
    imageGeneration?: boolean };
  quota?: unknown; quotaCheckedAt?: string; checkedAt?: string; stale?: boolean; authDirectory?: string;
  /** A transient check gets one retry; a verified native reply can also confirm connectivity. */
  connectionCheck?: { source: 'probe' | 'run'; retryAttempt?: number; retryAt?: string; runId?: string };
  /** Selectable models; empty when the member cannot list them (custom input stays available). */
  modelOptions?: ModelOption[];
  /** Configurability, independent of account availability. */
  configuration?: { model: boolean; effort: 'reported' | 'documented' | 'unreported' | 'unsupported'; detail?: string };
  /** Membership in the diagnostic compatibility baseline; never a connection or task verdict. */
  verified?: boolean;
  runtimeReady?: boolean;
  nodeRuntime?: import('./executor-catalog').NodeRuntimeInfo;
  windowsSandbox?: { ready: boolean; mode: 'unelevated'; detail?: string };
  permissionSupport?: { commandReadIsolation: false; commandWriteIsolation: 'native' | 'approval-only' | 'none'; networkIsolation: 'commands-disabled' | 'partial' | 'none' };
}
/** Account windows reported by a member's own program; absent numbers mean unknown. */
export interface QuotaWindow {
  id: string; label: string; usedPercent?: number; resetsAt?: number;
  exhausted?: boolean; warning?: boolean; checkedAt: string;
}
/** Decimal strings from the official account service; recharge and gifts stay separate. */
export interface AccountWallet { currency: 'CNY' | 'USD'; balance: string }
export interface AccountBalance {
  status: 'ready' | 'unavailable'; wallets: AccountWallet[]; bonusWallets: AccountWallet[]; checkedAt: string;
  /** Native account service confirmed the login is gone; network failures leave this unset. */
  signedOut?: boolean;
}
export interface MemberQuota {
  provider: ProviderId; windows: QuotaWindow[]; checkedAt: string;
  source: 'probe' | 'event';
  /** Account/config file metadata only; no credentials. */
  accountStamp?: string;
  balance?: AccountBalance;
  /** Result of an explicit read-only subscription query; unavailable is distinct from an expired sample. */
  queryStatus?: 'ready' | 'unavailable';
}
export type RoomId = 'global' | `project:${string}` | `desk:${string}` | `report:${string}:${string}` | `roundtable:${string}`;
export interface Project { id: string; name: string; directory: string; createdAt: string; collaborationPaused: boolean; /** Private conversations use hidden execution directories. */ kind?: 'lounge' | 'desk' | 'roundtable'; roomId?: RoomId }
export interface Project { /** Saved participants of this project's meeting room. */ memberIds?: string[] }
export interface Project { memberConfigs?: Record<string, import('./executor-config').ConfigSelection>; memberConfigRevision?: number }
export interface Project { /** Optional detailed logs under .airoom/logs; independent from H3 project records. */ writeWorkLogs?:boolean }
export interface Project { /** Independent default-off H3 record export. */ projectRecordToFolder?:boolean }
export interface Project { /** Logical ownership does not change the filesystem directory. */ parentId?:string;order?:number;hierarchyRevision?:number;/** Explicit relative write paths; absent means the entire directory. */ writeScopes?:string[] }
/** Frozen physical boundaries survive pauses and restarts; history without one remains conservative. */
export interface WriteBoundary {directoryKey:string;writeScopes:string[];scopeKeys:string[]}
export interface Run {writeBoundary?:WriteBoundary}
/** A file the user attached, copied into AIROOM's data folder as attachments/<id>/<name>; the original is untouched. */
export interface Attachment { id: string; name: string; kind: 'image' | 'text' | 'file'; mime: string; size: number }
/** A generated picture stored locally; native payloads and arbitrary paths never enter the snapshot. */
export interface GeneratedImage extends Attachment {
  nativeItemId: string; nativeTurnId: string; generatedAt: string;
  revisedPrompt?: string; transparentBackground?: boolean;
}
/** Parts of the day a member's routine describes (see ROUTINE_PERIODS for hours). */
export type RoutinePeriod = 'morning' | 'afternoon' | 'evening' | 'night';
/** A member's relation to another member, by id. */
export interface MemberRelation { memberId: string; text: string }
/** One thing a member keeps in mind, with where it came from. */
export interface MemoryEntry {
  id: string; text: string;
  /** manual: written by the user; imported: from a desktop client's memory; proposed: suggested by a member and accepted by the user. */
  source: 'manual' | 'imported' | 'proposed';
  /** Where it came from, in words, e.g. "Codex 记忆摘要" or "Gptia · 话题「周末计划」". */
  origin?: string;
  createdAt: string; updatedAt?: string;
  /** Kept on the card but not sent to the member. */
  off?: boolean;
}
/** A teammate: a character on top of one executor. Built-ins use the executor id as their id. */
export interface MemberProfile {
  id: string; executor: PermissionMember; name: string;
  /** How this member addresses the user; empty means the user's own name. */
  userTitle?: string;
  /** Personality, voice and role; injected into the member's system instructions every turn. */
  persona?: string;
  /** Speaking preference in free discussion; omitted cards use normal. */
  talkativeness?: 'quiet' | 'normal' | 'chatty';
  /** Things the user wants this member to keep in mind, as one text: the entries that are on, joined.
   *  Kept for older readers; `memories` is the source of truth once present. */
  memory?: string;
  /** Things the user wants this member to keep in mind, one per entry with its origin. */
  memories?: MemoryEntry[];
  /** What the member is usually doing in each part of the day; shown as their status, never claimed as real work. */
  routine?: Partial<Record<RoutinePeriod, string>>;
  /** Small habits shown while idle, e.g. "转笔". */
  quirks?: string[];
  /** How this member relates to teammates; given to the member as part of their persona. */
  relations?: MemberRelation[];
  motto?: string; color?: string;
  /** File names in the AIROOM asset store; absent means the built-in artwork. */
  portrait?: string; avatar?: string;
  /** Display size relative to the portrait's default framing; the original image is unchanged. */
  portraitScale?: number;
  /** Portrait shift from its default framing, as fractions of the frame's width and height. */
  portraitOffset?: { x: number; y: number };
  /** Avatar crop from the portrait when no avatar image is set (fractions of the artwork). */
  face?: { x: number; y: number; zoom: number };
  /** Crop of an uploaded avatar image; absent means the whole image fills the circle. */
  avatarFace?: { x: number; y: number; zoom: number };
  model?: string; effort?: string;
  /** Presentation only: omit this card from the home page and team sidebar. */
  cardHidden?: boolean;
  builtIn?: boolean; createdAt?: string;
}
/** The identity attached to historical conversations after a card is deleted; no live persona or model settings. */
export type MemberIdentity = Pick<MemberProfile,'id'|'executor'|'name'|'color'|'portrait'|'avatar'|'portraitScale'|'portraitOffset'|'face'|'avatarFace'|'builtIn'>;
export interface UserProfile { name: string; avatar?: string }
/** A room note about project work. It opens the session; the note reporting how a run ended also carries the user's decision. */
export interface RoomLink { projectId: string; sessionId: string; runId?: string;
  /** File edits from this run were undone in its work copy. */
  undoneAt?: string;
  /** How the run ended (outcome notes only). */
  outcome?: RunStatus;
  /** The run reviewed another member's run; its findings can be sent back to that session.
   *  fingerprint: the author's work copy as the reviewer found it (workspaceFingerprint). */
  reviewOf?: { sessionId: string; runId: string; fingerprint?: string };
  /** The author's files changed after this review began; it no longer vouches for them. */
  reviewStale?: string;
  /** The user's decision in the room: accepted, or sent back with comments. */
  verdict?: 'accepted' | 'returned'; verdictAt?: string }
export interface RoomMessage { id: string; author: string; authorName?: string; threadId?: string; text: string; at: string; runId?: string;
  /** An immutable version of the saved project facts, displayed without a model call. */
  memberReport?: import('./project-workbench').MemberReport;
  /** Previous saved facts folded into one report card; original messages remain in storage. */
  memberReportVersions?: {messageId:string;at:string;report:import('./project-workbench').MemberReport}[];
  flowReport?: {flowId:string;roundId:string;integrationId:string};
  jointReview?: {jointReviewId:string};
  roundtable?: {topicId:string;kind:'material'|'candidate'|'conclusion';slotId?:string;conclusionId?:string};
  taskRequest?:boolean;
  /** An independent reply to a working member; never a new project requirement. */
  intent?:'readonly-question';
  roomId?:RoomId;
  flowPlan?: {flowId:string;planId:string;version:number};
  flowDecision?: {flowId:string;decisionId:string;revision:number;status:import('./project-flow').Decision['status']};
  scheduled?: { jobId:string;occurrenceId:string };
  automatic?: import('./automation').AutomaticOrigin;
  /** A room note that opens a project session (handed-over tasks, reviews and their outcome). */
  link?: RoomLink;
  /** The end of the member's answer on an outcome note, shown folded. Members never get system notes as room context. */
  detail?: string; status?: 'speaking' | 'done' | 'passed' | 'failed' | 'stopped'; error?: string; system?: boolean; kind?: 'summary'; allowPass?: boolean;
  /** Program-prepared discussion material: included in member context, hidden from the conversation. */
  contextOnly?: boolean;
  discussionId?: string; discussionRevision?: number; discussionTurn?: string; discussionControl?: boolean; discussionStale?: boolean; inReplyTo?: string;
  /** Emoji reactions on this message: emoji -> authors ('user' or a member id), in the order they reacted. */
  reactions?: Record<string, string[]>;
  /** A member turn answered only with this emoji; it is shown on `replyTo` instead of as a message. */
  reaction?: string;
  /** The user message that started the turn a member message belongs to. */
  replyTo?: string;
  /** Files the user attached (copies in AIROOM's data folder). */
  attachments?: Attachment[];
  generatedImages?: GeneratedImage[];
  imageGeneration?: boolean }
export interface RoomSummary { text: string; by: string; byName?: string; at: string; upTo?: string; count: number;
  /** Things about the user the summarizer thought worth remembering; they wait for the user to accept or dismiss them. */
  proposals?: string[] }
export interface RoomThread {
  id: string; title: string; createdAt: string; archivedAt?: string;
  /** Only generated titles may be replaced by the first user message. */
  autoTitle?: boolean;
  roomId?: RoomId; projectId?: string;
  /** A member's condensed version of this topic up to message `upTo`; later turns start from it. */
  summary?: RoomSummary;
  /** The summary of the topic this one continues; every member gets it as background. */
  inherited?: { threadId: string; title: string; text: string };
  /** Messages in the topic (derived for listings, never stored). */
  count?: number;
}
export interface RoomHistory { threadId: string; messages: RoomMessage[]; hasMore: boolean; before?: string; readToken?: string }
export interface RoomState { active: boolean; mode: 'chat' | 'meeting' | 'discuss'; discussion?: import('./discussion').RoomDiscussion; topic?: string; speaking?: string; round?: number; rounds?: number;
  roomId?: RoomId; revision?: number;
  generatingImage?: boolean;
  /** The member condensing a topic right now. */
  compressing?: string }
export interface Session {
  executorIdentity?: import('./compatibility').ExecutorIdentity;
  id: string; projectId: string; provider: ProviderId; title: string; nativeId?: string; nativeHome?: 'shared' | 'airoom';
  roomId?: RoomId; roomThreadId?: string;
  /** Acknowledged persona in this exact native history; never used after a native reset. */
  nativePersona?: { nativeId: string; hash: string };
  /** Refresh only after confirmed turns; a native compaction invalidates the next incremental prompt. */
  nativeContext?: { nativeId: string; turnsSinceRefresh: number; inputCharsSinceRefresh: number; refreshRequired?: boolean };
  /** Retained audit history after a room starts fresh; never reused for another turn. */
  roomRetiredAt?:string;
  workspaceSource?: {sessionId:string;runId:string;fingerprint:string;at:string};
  /** Backups omit native context and task copies; these restored sessions are readable history. */
  restoredHistoryOnly?: boolean;
  createdAt: string; updatedAt: string; revision: number; writeMode: boolean;
  workspace?: string; workspaceKind?: 'worktree' | 'copy' | 'original';
  /** Private room sessions keep summary and hand-raising control out of ordinary speech. */
  purpose?: 'room-summary' | 'room-hand' | 'room-image' | 'room-minutes' | 'room-mention' | 'flow-task' | 'flow-plan' | 'flow-review' | 'flow-integration';
  flowId?: string;
  /** AIROOM answers every approval in this session with the member's allow option. */
  autoApprove?: boolean;
  /** Approval categories (e.g. command, fileChange, WebFetch) AIROOM allows for the rest of this session. */
  approvalRules?: string[];
  /** The title was generated, not chosen; lists show the first task instead. */
  autoTitle?: boolean;
  /** Kept at the top of the session list. */
  pinned?: boolean;
  /** Hidden from the main list; restorable. */
  archived?: boolean;
  /** The character this session talks to; absent means the executor's built-in member. */
  memberId?: string;
  /** Per-session model / thinking level; absent means the member default from settings. */
  model?: string;
  effort?: string;
}
export interface Run {
  compatibilityReportId?: string;
  executorIdentity?: import('./compatibility').ExecutorIdentity;
  requestedConfig?: import('./executor-config').RequestedRunConfig;
  effectiveConfig?: import('./executor-config').EffectiveRunConfig;
  id: string; sessionId: string; projectId: string; provider: ProviderId; revision: number;
  status: RunStatus; input: string; createdAt: string; updatedAt: string; completedAt?: string;
  nativeTurnId?: string; bootId: string; delivery: 'prepared' | 'sent' | 'confirmed' | 'unknown' | 'withdrawn';
  validation?: string; error?: string;
  stopReason?: 'failed' | 'rate_limited' | 'blocked' | 'aborted';
  /** A task handed over from the team room (its outcome is reported back to that topic), or a review of another run. */
  origin?: { threadId?: string; messageId?: string; discussionId?:string;callKind?:'normal'|'correction'|'retry'; reviewOf?: { sessionId: string; runId: string; fingerprint?: string } };
  /** Files given with this turn: texts inline, images as pictures where the program accepts them, others by path. */
  attachments?: Attachment[];
  generatedImages?: GeneratedImage[];
  /** A user explicitly requested one image in the room; automatic speech never grants this. */
  imageGeneration?: boolean;
  imageGenerationAcknowledgedAt?: string;
  /** The recent writable run's file checkpoint; stored without file contents in UI records. */
  workspaceUndo?: { status: 'capturing' | 'available' | 'none' | 'undone' | 'superseded' | 'unavailable'; changes?: number; reason?: string; at?: string };
  automatic?: import('./automation').AutomaticOrigin;
  flowOperationId?: string;
}
export interface TimelineEvent {
  id: string; runId: string; sessionId: string; provider: ProviderId; at: string;
  kind: EventKind; text: string; data?: unknown; fidelity: 'native' | 'derived' | 'lossy';
}
export interface Approval {
  id: string; runId: string; sessionId: string; provider: ProviderId;
  type: 'approval' | 'question'; title: string; detail: string;
  options: { id: string; label: string; kind?: string }[]; questions?: unknown;
  state: 'pending' | 'answered' | 'expired'; createdAt: string;
  /** Native option that allows this one request; enables AIROOM's session-level controls. */
  allowChoice?: string; denyChoice?: string;
  /** What kind of action this is, so a session rule can cover later requests of the same kind. */
  category?: string; categoryLabel?: string;
  /** Set when AIROOM answered on the user's behalf, with the rule that did it. */
  autoApproved?: string; answeredChoice?: string;
}
export interface Artifact { name: string; path: string; relativePath: string; size: number; modifiedAt: string; directory: boolean }
export interface Collaboration {
  id: string; projectId: string; topic: string; members: ProviderId[]; lead: ProviderId;
  mode: 'relay' | 'council'; status: 'running' | 'paused' | 'ended' | 'failed';
  stage: string; sessionIds: string[]; createdAt: string;
}
export interface Snapshot {
  /** Transport ordering only; never persisted as user or model content. */
  sync?:{epoch:string;revision:number};
  roundtable?: {currentTopicId?:string;topics:import('./roundtable').RoundtableOverview[]};
  workLogFailures?:{projectId:string;roundId:string}[];
  projectFlows?: import('./project-flow').FlowOverview[];
  jointReviews?: {id:string;projectId:string;revision:number;status:import('./joint-review').JointReview['status'];stage:import('./joint-review').JointStage;dispatchMode:'running'|'paused';needsUser:boolean;quotaWaiting?:boolean}[];
  attention?: import('./attention').AttentionSummary;
  projects: Project[]; sessions: Session[]; runs: Run[]; events: TimelineEvent[];
  approvals: Approval[]; providers: ProviderInfo[]; settings: Settings;
  collaborations: Collaboration[]; dataDirectory: string; backendReady: boolean;
  /** Changes only when a backup replaces the local database; separates stale browser drafts. */
  restoreEpoch?:string;
  deepseekKeyConfigured: boolean;
  /** A long-lived Claude subscription token is saved (the value never leaves the desktop and Claude processes). */
  claudeTokenConfigured?: boolean;
  claudeApiKeyConfigured?: boolean;
  members: MemberProfile[];
  /** Display identities for retained history; these are not selectable active members. */
  removedMembers?: MemberIdentity[];
  /** Programs connected over ACP; absent in snapshots from older backends. */
  executors?: AcpExecutor[]; profile: UserProfile;
  /** Shared by all character cards using the same executor account. */
  quotas?: Partial<Record<ProviderId, MemberQuota>>;
  automation?: import('./automation').AutomationSnapshot;
  room: { messages: RoomMessage[]; state: RoomState; currentThreadId?: string; threads?: RoomThread[]; hasMore?: boolean; before?: string };
  rooms?: {roomId:RoomId;projectId?:string;memberId?:string;kind?:'desk'|'report';unread?:boolean;pending?:boolean;folder?:string;folderKey?:string;sessionId?:string;revision:number;currentThreadId:string;state:Pick<RoomState,'active'|'mode'|'speaking'|'compressing'|'generatingImage'>}[];
}
export interface SnapshotPatch {
  type:'snapshot-patch';sync:{epoch:string;revision:number};baseRevision:number;
  changes:Partial<Snapshot>;removed:(keyof Snapshot)[];
  rows:Record<string,{upsert:Record<string,unknown>[];removed:string[];order?:string[]}>;
}
export type PushEvent = { type: 'snapshot'; snapshot: Snapshot } | SnapshotPatch | { type: 'event'; event: TimelineEvent } | { type: 'backend'; ready: boolean; message?: string } | {type:'executor-login';id:string;state:import('./executor-catalog').CatalogLoginState};
export interface AiroomBridge {
  invoke<T = unknown>(method: string, params?: unknown): Promise<T>;
  onEvent(listener: (event: PushEvent) => void): () => void;
  pathForFile?(file: File): string;
}
export interface AdapterContext {
  recordConfig?(config: Omit<import('./executor-config').EffectiveRunConfig, 'at'>): void;
  run: Run; session: Session; settings: Settings; cwd: string; env: NodeJS.ProcessEnv;
  /** Positively identified chat surfaces. Flow tasks keep their complete task briefing. */
  conversation?: 'desk' | 'room';
  /** Only the conversation runtime pool grants this lease; flow tasks close their process. */
  roomRuntime?: boolean;
  /** Diagnostic timing only; never adds protocol metadata to chat messages. */
  recordTiming?(phase: string): void;
  /** Boolean/numeric protocol decisions only, written to the runtime diagnostic log. */
  recordRuntime?(stage: string, conditions: Record<string, boolean | number | string | null>): void;
  /** Character instructions from the member's card (name, how to address the user, persona, memory). */
  /** Attached files for this turn with their stored paths; images go to programs that accept them. */
  attachments?: (Attachment & { path: string })[];
  persona?: string;
  emit(kind: EventKind, text: string, data?: unknown, fidelity?: TimelineEvent['fidelity']): void;
  approve(request: Omit<Approval, 'id' | 'runId' | 'sessionId' | 'provider' | 'state' | 'createdAt'>): Promise<{ choice: string; answers?: unknown }>;
  persistNativeSession(id: string, nativeHome?: 'shared' | 'airoom'): void;
  persistNativePersona?(nativeId: string, hash: string): void;
  invalidateNativeContext?(): void;
  nativeContextInvalidated?: boolean;
  /** Verified native generation activity, without adding repeated timeline entries. */
  progress?(): void;
  /** A newly created native session needs room history again; false means it cannot retain it next turn. */
  freshInput?(canRemember: boolean): string;
  /** Refresh complete room rules while keeping the acknowledged history cursor. */
  refreshInput?(): string;
  markDelivery(state: Run['delivery'], nativeTurnId?: string): void;
  registerProcess(child: import('node:child_process').ChildProcess): void;
  deepseekKey?: string;
}
export interface AdapterResult { stopped?: boolean; unknown?: boolean; unknownReason?: string; usage?: unknown; summary?: string; failure?: { kind: 'failed' | 'rate_limited' | 'blocked' | 'aborted'; message: string } }
export interface Adapter {
  readonly supportsRuntimeReuse?: boolean;
  runtimeFingerprint?(context: AdapterContext): string | Promise<string>;
  canReuse?(): boolean;
  /** Close a leased runtime, including idle processes. Distinct from cancelling a turn. */
  dispose?(): Promise<void>;
  probe(settings: Settings, env: NodeJS.ProcessEnv): Promise<ProviderInfo>;
  /** Read-only account check, without interrupting a chat runtime or sending a model prompt. */
  accountBalance?(settings: Settings, env: NodeJS.ProcessEnv): Promise<AccountBalance>;
  accountQuota?(settings: Settings, env: NodeJS.ProcessEnv): Promise<{payload:unknown;checkedAt:string;signedOut?:boolean}>;
  start(context: AdapterContext, text: string): Promise<AdapterResult>;
  stop(): Promise<void>;
  steer?(text: string): Promise<boolean>;
}
declare global { interface Window { airoom: AiroomBridge } }
