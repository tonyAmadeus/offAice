import type { AcpExecutor, AcpExecutorId, MemberPermissions, MemberProfile, PermissionMember, Settings, ProviderId, UserProfile } from './types';
import { activeMemoryText, memoryEntries, normalizeMemories } from './memory';
import { normalizeLife, relationLines } from './life';
export const PROVIDER_NAMES: Record<ProviderId,string> = { codex:'Codex', claude:'Claude', dsh:'DeepSeek Harness', deepseek:'DeepSeek API' };
export const isAcpId = (id: unknown): id is AcpExecutorId => typeof id === 'string' && /^acp-[a-z0-9]{8,32}$/.test(id);
/** Connected programs show their own name wherever a built-in executor's name would appear. */
export function rememberExecutors(executors: Pick<AcpExecutor, 'id' | 'name'>[] = []) {
  for (const key of Object.keys(PROVIDER_NAMES)) if (isAcpId(key)) delete PROVIDER_NAMES[key];
  for (const executor of executors) PROVIDER_NAMES[executor.id] = executor.name;
}
/** Shown in place of an encrypted value; saving it unchanged keeps the stored secret. */
export const SECRET_PLACEHOLDER = '（已加密保存）';
/** Variables whose names suggest a credential are encrypted with the system's credential protection. */
export const isSecretName = (name: string) => /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|AUTH)/i.test(name);
/** Split a program's variables into plain ones and secrets; a placeholder keeps the stored secret, a removed line drops it. */
export function splitSecretEnv(env: Record<string, unknown>, stored: Record<string, string> = {}) {
  const plain: Record<string, string> = {}, secrets: Record<string, string> = {};
  for (const [key, raw] of Object.entries(env)) {
    const value = String(raw ?? '');
    if (!isSecretName(key)) { plain[key] = value; continue; }
    const resolved = value === SECRET_PLACEHOLDER ? stored[key] : value;
    if (resolved) secrets[key] = resolved;
  }
  return { plain, secrets };
}
export const ACP_DEFAULT_PERMISSIONS: MemberPermissions = { commands:'ask', fileScope:'workspace', network:true };
/** Accept a program's connection settings from the renderer: known fields only, sizes bounded. */
export function normalizeExecutor(value: unknown, existing?: AcpExecutor, newId?: AcpExecutorId): AcpExecutor {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const text = (input: unknown, max: number) => typeof input === 'string' ? input.trim().slice(0, max) : '';
  const name = text(source.name, 40) || existing?.name || '';
  if (!name) throw new Error('请给这个 AI 程序起个名字');
  const command = text(source.command, 1024);
  if (!command) throw new Error('请填写程序路径');
  const args = (Array.isArray(source.args) ? source.args : typeof source.args === 'string' ? splitArgs(source.args) : []).map(item => String(item)).filter(Boolean).slice(0, 40).map(item => item.slice(0, 1024));
  const env: Record<string, string> = {};
  const given = source.env && typeof source.env === 'object' ? source.env as Record<string, unknown> : typeof source.env === 'string' ? parseEnv(source.env) : {};
  for (const [key, val] of Object.entries(given).slice(0, 40)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) throw new Error(`环境变量名无效：${key}`);
    if (/^(ELECTRON_RUN_AS_NODE|NODE_OPTIONS|PATH|PATHEXT|COMSPEC|SYSTEMROOT|WINDIR)$/i.test(key)) throw new Error(`为了安全，不能在这里修改 ${key}`);
    env[key] = String(val ?? '').slice(0, 4096);
  }
  const permissions = normalizePermissionSet(source.permissions, existing?.permissions ?? ACP_DEFAULT_PERMISSIONS);
  const managed=existing?.catalogId&&command===existing.command&&JSON.stringify(args)===JSON.stringify(existing.args);
  if(existing?.catalogId&&!managed)throw new Error('清单执行端的程序和启动参数由版本管理维护；请从清单切换版本，或手动添加另一个连接。');
  return { id: existing?.id ?? newId!, name, command, args, env, permissions, model: text(source.model, 120) || undefined, createdAt: existing?.createdAt ?? new Date().toISOString(),...(managed?{catalogId:existing.catalogId,authentication:existing.authentication}:{}) };
}
/** Split a command line the way a user types it: spaces separate, double quotes group. */
export function splitArgs(line: string): string[] {
  const result: string[] = []; let current = '', quoted = false, started = false;
  for (const char of line) {
    if (char === '"') { quoted = !quoted; started = true; }
    else if (/\s/.test(char) && !quoted) { if (started) result.push(current); current = ''; started = false; }
    else { current += char; started = true; }
  }
  if (started) result.push(current);
  return result;
}
export const joinArgs = (args: string[]) => args.map(arg => /[\s"]/.test(arg) || !arg ? `"${arg.replace(/"/g, '')}"` : arg).join(' ');
export function parseEnv(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) { const trimmed = line.trim(); if (!trimmed || trimmed.startsWith('#')) continue; const at = trimmed.indexOf('='); if (at <= 0) throw new Error(`环境变量需要写成 名称=值：${trimmed.slice(0, 40)}`); result[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim(); }
  return result;
}
export const DEFAULT_SETTINGS: Settings = {
  networkMode:'tun', proxyUrl:'http://127.0.0.1:7897', npmRegistry:'official',nodeRuntime:'bundled',claudeAuthMode:'subscription',paths:{}, models:{}, efforts:{},
  deepseekEnabled:true, deepseekBaseUrl:'https://api.deepseek.com', dshProfile:'airoom',
  maxParallel:3, stopTimeoutMs:10000, defaultWriteMode:true, defaultAutoApprove:true,
  maxRunMinutes:30, deepseekMaxRequests:12,
  // Personal, unattended work: normal-user full access, with task copies, logs and stop controls retained.
  permissions:{ codex:{commands:'auto',fileScope:'any',network:true}, claude:{commands:'auto',fileScope:'any',network:true}, dsh:{commands:'auto',fileScope:'any',network:true} }
};
/** Apply the user's automatic-work preset without changing account paths, models or the network route. */
export function automaticWorkSettings(settings: Settings): Settings {
  return { ...settings, defaultWriteMode:true, defaultAutoApprove:true, permissions:{ ...normalizePermissions(settings.permissions), ...normalizePermissions(undefined) } };
}
export const PERMISSION_MEMBERS: PermissionMember[] = ['codex','claude','dsh'];
/** The team as it ships; a saved card with the same id overrides any field. */
export const BUILTIN_MEMBERS: MemberProfile[] = [
  { id:'claude', executor:'claude', name:'Claudia', motto:'翻开书，先把问题想清楚。', color:'#d9692f', builtIn:true },
  { id:'codex', executor:'codex', name:'Gptia', motto:'交给我，代码我来理顺。', color:'#7b6fd6', builtIn:true },
  { id:'dsh', executor:'dsh', name:'DS', motto:'收到！马上开工～', color:'#3c66d9', builtIn:true },
];
export const DEFAULT_PROFILE: UserProfile = { name:'你' };
export const PORTRAIT_SCALE = { min:0.25, max:2.5, step:0.05, default:1 };
const bounded = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0, max) : undefined;
/** Entries, plus the joined text older readers use; a card without either gets neither. */
function memoryFields(source: Record<string, unknown>, existing?: MemberProfile): Pick<MemberProfile, 'memory' | 'memories'> {
  const entries = normalizeMemories(source.memories, source.memory, existing?.createdAt ?? new Date().toISOString());
  return entries ? { memories: entries, memory: activeMemoryText(entries) || undefined } : {};
}
/** Accept a card from the renderer: known fields only, sizes bounded, artwork independent from the executor. */
export function normalizeMember(value: unknown, existing?: MemberProfile, newId?: string): MemberProfile {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const builtIn = BUILTIN_MEMBERS.find(member => member.id === (existing?.id ?? source.id));
  const executor = source.executor === undefined ? existing?.executor ?? builtIn?.executor : (PERMISSION_MEMBERS.includes(source.executor as PermissionMember) || isAcpId(source.executor) ? source.executor as PermissionMember : undefined);
  if (!executor) throw new Error('请选择这位成员使用的执行端');
  const name = bounded(source.name, 40) ?? existing?.name ?? builtIn?.name ?? '';
  if (!name) throw new Error('成员名称不能为空');
  const record = (input: unknown) => input && typeof input === 'object' ? input as Record<string, unknown> : undefined;
  const face = record(source.face), avatarFace = record(source.avatarFace), offset = record(source.portraitOffset);
  const clamp = (input: unknown, min: number, max: number, fallback: number) => { const number = Number(input); return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback; };
  const file = (input: unknown) => typeof input === 'string' && /^[a-f0-9-]{8,64}\.(png|jpe?g|webp|gif)$/i.test(input) ? input : undefined;
  return {
    id: existing?.id ?? builtIn?.id ?? newId ?? '', executor, name,
    templateId: ['claude','codex','dsh'].includes(String(source.templateId)) ? source.templateId as 'claude'|'codex'|'dsh' : existing?.templateId,
    userTitle: bounded(source.userTitle, 40) || undefined, persona: bounded(source.persona, 8000) || undefined, ...memoryFields(source, existing), ...normalizeLife(source, existing?.id ?? builtIn?.id ?? newId ?? ''),
    talkativeness: source.talkativeness === 'quiet' || source.talkativeness === 'chatty' ? source.talkativeness : 'normal',
    motto: bounded(source.motto, 80) || undefined, color: typeof source.color === 'string' && /^#[0-9a-f]{6}$/i.test(source.color) ? source.color : undefined,
    portrait: file(source.portrait), avatar: file(source.avatar),
    portraitScale: typeof source.portraitScale === 'number' && Number.isFinite(source.portraitScale) ? clamp(source.portraitScale, PORTRAIT_SCALE.min, PORTRAIT_SCALE.max, PORTRAIT_SCALE.default) : undefined,
    face: face ? { x: clamp(face.x, 0, 1, 0.5), y: clamp(face.y, 0, 1, 0.12), zoom: clamp(face.zoom, 1, 8, 3.5) } : undefined,
    portraitOffset: offset ? { x: clamp(offset.x, -1, 1, 0), y: clamp(offset.y, -1, 1, 0) } : undefined,
    avatarFace: avatarFace ? { x: clamp(avatarFace.x, 0, 1, 0.5), y: clamp(avatarFace.y, 0, 1, 0.5), zoom: clamp(avatarFace.zoom, 1, 8, 1) } : undefined,
    model: bounded(source.model, 120) || undefined, effort: bounded(source.effort, 40) || undefined,
    cardHidden: existing ? existing.cardHidden === true : source.cardHidden === true,
    builtIn: Boolean(builtIn), createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
}
/** What the member is told about who they are; it shapes voice and address, never permissions. */
export function personaInstructions(member: MemberProfile, profile: UserProfile, team: MemberProfile[] = []): string {
  const lines = [`你在 AIROOM 团队里的名字是「${member.name}」。`];
  const title = member.userTitle || (profile.name && profile.name !== '你' ? profile.name : '');
  if (title) lines.push(`称呼用户为「${title}」。`);
  if (member.persona) lines.push(`人设与说话风格（用户设定）：\n${member.persona}`);
  lines.push(member.talkativeness === 'quiet' ? '自由讨论时偏安静：有关键补充或被问到才接话，没有新内容可以沉默。' : member.talkativeness === 'chatty' ? '自由讨论时积极接话：愿意提问、回应他人，但不要重复观点或为了续聊强行找话题。' : '自由讨论时发言适中：有新内容就参与，没有补充可以沉默。');
  const relations = relationLines(member, team);
  if (relations.length) lines.push(`你和团队里其他成员的关系（用户设定）：\n${relations.join('\n')}`);
  const remembered = memoryEntries(member).filter(entry => !entry.off).map(entry => `- ${entry.text}`);
  if (remembered.length) lines.push(`用户希望你长期记住的事：\n${remembered.join('\n')}`);
  lines.push('以上设定只影响身份、语气和称呼，不改变任务要求、权限和安全规则。');
  return lines.join('\n');
}
/** Fill gaps from older saved settings and reject unknown values instead of trusting them. */
export function normalizePermissions(value: unknown): Record<PermissionMember, MemberPermissions> {
  const source = value && typeof value === 'object' ? value as Record<string, Partial<MemberPermissions>> : {};
  const result = {} as Record<PermissionMember, MemberPermissions>;
  for (const member of PERMISSION_MEMBERS) result[member] = normalizePermissionSet(source[member], DEFAULT_SETTINGS.permissions[member]);
  for (const id of Object.keys(source)) if (isAcpId(id)) result[id] = normalizePermissionSet(source[id], ACP_DEFAULT_PERMISSIONS);
  return result;
}
export function normalizePermissionSet(value: unknown, fallback: MemberPermissions): MemberPermissions {
  const given = value && typeof value === 'object' ? value as Partial<MemberPermissions> : {};
  return {
    commands: given.commands === 'ask' || given.commands === 'auto' || given.commands === 'deny' ? given.commands : fallback.commands,
    fileScope: given.fileScope === 'workspace' || given.fileScope === 'any' ? given.fileScope : fallback.fileScope,
    network: typeof given.network === 'boolean' ? given.network : fallback.network,
  };
}
