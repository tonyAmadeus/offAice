import { observeNodeRuntime } from '../compatibility';
import { compatibilityStep, stageFor, observeProgram, observeVersion, compatibilitySync } from '../compatibility';
import { type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { stripVTControlCharacters } from 'node:util';
import type { ProviderId, Settings } from '../../shared/types';
import { spawnOwned, stopOwned } from '../process-supervisor';
import { NativeResponseError } from '../adapter-failure';
import { windowsConsoleArguments } from '../windows-console';

export interface CliCommand { command: string; prefix: string[]; path: string }
const PACKAGES: Partial<Record<ProviderId, string>> = { codex: '@openai/codex', claude: '@anthropic-ai/claude-code' };

function packageEntry(directory: string, provider: ProviderId): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[provider];
    if (typeof bin === 'string' && existsSync(join(directory, bin))) return resolve(directory, bin);
  } catch { /* An absent package is a normal discovery outcome. */ }
}

function executable(path: string, provider: ProviderId): CliCommand | undefined {
  if (!existsSync(path)) return;
  const extension = extname(path).toLowerCase();
  if (['.js', '.mjs', '.cjs'].includes(extension)) return { command: process.execPath, prefix: [path], path };
  if (extension === '.cmd' || extension === '.ps1' || extension === '.bat') {
    // Resolve npm wrappers to their actual package entry without invoking a shell.
    const name = PACKAGES[provider];
    if (!name) return;
    for (const base of [join(dirname(path), 'node_modules', name), join(dirname(path), '..', name)]) {
      const entry = packageEntry(base, provider);
      if (entry) return executable(entry, provider);
    }
    return;
  }
  return { command: path, prefix: [], path };
}

export function resolveCliEntry(provider: ProviderId, settings: Settings, env: NodeJS.ProcessEnv, workspace = env.AIROOM_APP_ROOT ?? process.env.AIROOM_APP_ROOT ?? process.cwd()): CliCommand {
  const configured = settings.paths[provider];
  if (configured) {
    const path = isAbsolute(configured) ? configured : resolve(workspace, configured);
    const command = executable(path, provider);
    if (!command) throw new Error(`${provider} 配置的路径不可用；请选择独立安装的可执行文件或 JavaScript 入口。`);
    return command;
  }
  if (provider === 'claude' && process.platform === 'win32' && env.APPDATA) {
    const entry = packageEntry(join(env.APPDATA, 'npm', 'node_modules', PACKAGES.claude!), provider);
    const globalCommand = entry && executable(entry, provider);
    if (globalCommand) return globalCommand;
  }
  const packageName = PACKAGES[provider];
  if (packageName) {
    let directory = workspace;
    while (true) {
      const entry = packageEntry(join(directory, 'node_modules', packageName), provider);
      if (entry) return executable(entry, provider)!;
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  const searchPath = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  const names = process.platform === 'win32' ? [`${provider}.exe`, `${provider}.cmd`, `${provider}.ps1`] : [provider];
  for (const directory of searchPath.split(delimiter)) {
    if (!directory) continue;
    // Desktop applications' versioned internal bins are not a stable installation.
    if (/[/\\](?:OpenAI[/\\]Codex[/\\]bin|Claude(?:[/\\]app-[^/\\]+)?)(?:[/\\]|$)/i.test(directory)) continue;
    for (const name of names) {
      const command = executable(join(directory.replace(/^"|"$/g, ''), name), provider);
      if (command) return command;
    }
  }
  throw new Error(`未找到独立安装的 ${provider} CLI。请在设置中选择官方安装路径。`);
}

export function resolveCli(...args: Parameters<typeof resolveCliEntry>): CliCommand {
  return compatibilitySync('resolve',()=>{const result=resolveCliEntry(...args);observeProgram(result.path);return result;});
}

/** What a hosting Claude app (the desktop app, an SDK host) injects into its own sessions. When AIROOM is started from
 * inside one, these would make member CLIs believe they are hosted too: leaving login refresh to a host that is not
 * there, and acting for the host's account and session. User settings such as CLAUDE_CODE_GIT_BASH_PATH are kept. */
const CLAUDE_HOST_SESSION = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK_VERSION|CLAUDE_PREVIEW_CLASSIFIER_FLOOR|CLAUDE_CODE_(?:SDK_\w+|MESSAGING_\w+|ENTRYPOINT|EXECPATH|ACCOUNT_UUID|ORGANIZATION_UUID|USER_EMAIL|OAUTH_SCOPES|OAUTH_REFRESH_TOKEN|SESSION_ID|HOST_SESSION_ID|CHILD_SESSION|SESSION_ATTENDED|DESKTOP_APP_VERSION|EMIT_TOOL_USE_SUMMARIES|ENABLE_ASK_USER_QUESTION_TOOL|ENABLE_SDK_FILE_CHECKPOINTING|REPORT_FINDINGS|EAGER_FLUSH|DISABLE_CRON|DISABLE_TERMINAL_TITLE|TERMINAL_MCP_TOOLS))$/i;

/** Host session/auth/transport markers observed in the bundled Codex 0.160 launcher and native runtime.
 * Keep user settings (CA certificate, installer/package settings) and AIROOM's home/state directory. */
const CODEX_HOST_SESSION = /^(CODEX_(?:THREAD_ID|SESSION_ID|ACCESS_TOKEN|CONNECTORS_TOKEN|AUTH|AUTHAPI_BASE_URL|APP_SERVER_(?:CHATGPT_BASE_URL|LOGIN_CLIENT_ID|LOGIN_ISSUER)|AGENT_IDENTITY_\w+|REFRESH_TOKEN_URL_OVERRIDE|REVOKE_TOKEN_URL_OVERRIDE|SANDBOX(?:_\w+)?|WINDOWS_SANDBOX_\w+|NETWORK_(?:PROXY_\w+|ALLOW_LOCAL_BINDING|POLICY_VIOLATION)|EXEC_SERVER_\w+|DAEMON_\w+|INTERNAL_(?:ORIGINATOR_OVERRIDE|APP_SERVER_REMOTE_CONTROL_DISABLED)|SQLITE_HOME|PERMISSION_PROFILE|STARTING_DIFF|SNAPSHOT_POSIX_STARTUP)|OPENAI_(?:FEDERATION_RULE_ID|IDENTITY_TOKEN_FILE))$/i;
export function subscriptionEnvironment(provider: 'codex' | 'claude', source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...source };
  const forbidden = provider === 'claude'
    ? /^(ANTHROPIC_(?:API_KEY|AUTH_TOKEN|BASE_URL|MODEL)|CLAUDE_CODE_(?:OAUTH_TOKEN|OAUTH_TOKEN_FILE_DESCRIPTOR|USE_BEDROCK|USE_VERTEX|USE_FOUNDRY|RESUME_INTERRUPTED_TURN|SIMPLE)|CLAUDE_CONFIG_PROFILE|ANTHROPIC_PROFILE)$/i
    : /^(OPENAI_(?:API_KEY|BASE_URL)|CODEX_API_KEY|CODEX_THREAD_ID)$/i;
  for (const key of Object.keys(result)) if (forbidden.test(key) || (provider === 'claude' ? CLAUDE_HOST_SESSION : CODEX_HOST_SESSION).test(key)) delete result[key];
  for (const key of Object.keys(result)) if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete result[key];
  // The user decides when Claude updates (settings → 版本); runs started by AIROOM never self-update.
  if (provider === 'claude') result.DISABLE_AUTOUPDATER = '1';
  // Background work outlives turn boundaries and can replay notices on --resume.
  // Keep work in the foreground, including when room turns reuse a process.
  if (provider === 'claude') result.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';
  return result;
}

export function prepareCliLaunch(command: CliCommand, args: string[], source: NodeJS.ProcessEnv) {
  const env = { ...source };
  observeNodeRuntime(env);
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete env[key];
  const runner = command.prefix.length && env.AIROOM_NODE_EXE ? env.AIROOM_NODE_EXE : command.command;
  const argv = [...(command.prefix.length ? windowsConsoleArguments() : []), ...command.prefix, ...args];
  if (command.prefix.length && process.versions.electron && resolve(runner).toLowerCase() === resolve(process.execPath).toLowerCase()) {
    env.ELECTRON_RUN_AS_NODE = '1';
    // Managed Node CLIs fork process.execPath and need Node mode in their child tree.
    // Other launchers retain the existing clean environment for native desktop tools.
    if(env.AIROOM_NODE_CHILD_MODE!=='1')argv.unshift('--import', 'data:text/javascript,delete%20process.env.ELECTRON_RUN_AS_NODE');
  }
  return { command: runner, args: argv, env };
}

export function spawnCli(command: CliCommand, args: string[], options: SpawnOptions): ChildProcess {
  const launch = prepareCliLaunch(command, args, options.env ?? process.env);
  return spawnOwned(launch.command, launch.args, { cwd: String(options.cwd ?? process.cwd()), env: launch.env });
}

function collectCommandRaw(command: CliCommand, args: string[], env: NodeJS.ProcessEnv, cwd?: string, timeoutMs = 20000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawnCli(command, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { void stopOwned(child, 5000); reject(new Error('执行端状态检查超时；没有发出工作任务。')); }, timeoutMs);
    child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (data: string) => { stdout = (stdout + data).slice(-1024 * 1024); });
    child.stderr?.on('data', (data: string) => { stderr = (stderr + data).slice(-32768); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolvePromise({ code, stdout, stderr }); });
  });
}

export function collectCommand(...args:Parameters<typeof collectCommandRaw>):ReturnType<typeof collectCommandRaw>{
  const stage=args[1].includes('--version')?'version':args[1].includes('auth')?'account':'native-command';
  return compatibilityStep(stage,async()=>{const result=await collectCommandRaw(...args);if(stage==='version'&&result.code===0)observeVersion(result.stdout);return result;},undefined,args[4]??20000);
}

export type RpcId = number | string;
export interface RpcMessage { id?: RpcId; method?: string; params?: any; result?: any; error?: { code?: number; message?: string; data?: any }; jsonrpc?: string }
export class JsonLineRpc {
  private sequence = 0;
  private pending = new Map<RpcId, { method: string; resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private decoder = new StringDecoder('utf8');
  private buffer = '';
  private closed = false;
  onIncoming?: (message: RpcMessage) => Promise<void>;
  onResponse?: (message: RpcMessage, method: string) => void;
  onNotification?: (method: string, params: any) => void;
  onRequest?: (message: RpcMessage) => Promise<any>;
  onMalformed?: (line: string) => void;
  onClose?: (error: Error) => void;
  constructor(readonly child: ChildProcess, private includeHeader = false, private maxMessageLength = 16 * 1024 * 1024) {
    child.stdout?.on('data', (data: Buffer) => this.feed(this.decoder.write(data)));
    child.stdout?.on('end', () => this.feed(this.decoder.end()));
    child.once('error', error => this.close(error));
    child.once('close', (code, signal) => this.close(new Error(`执行端连接已关闭（${signal ?? code ?? '未知'}）。`)));
    child.stdin?.on('error', error => this.close(error));
  }
  get isOpen(): boolean { return !this.closed && this.child.exitCode === null && this.child.signalCode === null && !!this.child.stdin?.writable; }
  private feed(chunk: string): void {
    if(this.closed)return;
    this.buffer += chunk;
    if (this.buffer.length > this.maxMessageLength) { this.close(new Error('执行端返回了超过限制的协议消息。')); this.child.kill(); return; }
    while (true) {
      const index = this.buffer.indexOf('\n');
      if (index < 0) break;
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let receiving: { reject(error: Error): void } | undefined;
      try {
        let message: RpcMessage;
        try { message = JSON.parse(line); } catch { this.onMalformed?.(line); continue; }
        if (typeof message?.method === 'string') {
          if (this.onIncoming) {
            void Promise.resolve(this.onIncoming(message)).catch(error => this.close(error instanceof Error ? error : new Error(String(error))));
            continue;
          }
          if (message.id !== undefined) {
            Promise.resolve().then(() => this.onRequest ? this.onRequest(message) : Promise.reject(new Error(`不支持的执行端请求：${message.method}`)))
              .then(result => this.respond(message.id!, result), error => this.respondError(message.id!, -32603, error instanceof Error ? error.message : String(error)))
              .catch(() => { /* A stopped connection cannot receive a response. */ });
          } else this.onNotification?.(message.method, message.params);
        } else if (message?.id !== undefined) {
          const entry = this.pending.get(message.id);
          if (!entry) continue;
          receiving = entry;
          this.pending.delete(message.id); clearTimeout(entry.timer);
          this.onResponse?.(message,entry.method);
          if (message.error) entry.reject(new NativeResponseError(message.error.message ?? `协议错误 ${message.error.code}`,message.error.code,message.error.data));
          else entry.resolve(message.result);
        } else this.onMalformed?.(line);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        receiving?.reject(failure);
        this.close(failure);
        return;
      }
    }
  }
  send(message: RpcMessage): void {
    if (this.closed || !this.child.stdin?.writable) throw new Error('执行端连接不可写。');
    this.child.stdin.write(JSON.stringify(this.includeHeader ? { jsonrpc: '2.0', ...message } : message) + '\n');
  }
  request(method: string, params: unknown, timeoutMs = 20000): Promise<any> {
    return compatibilityStep(stageFor(method),()=>this.requestRaw(method,params,timeoutMs),method,timeoutMs);
  }
  private requestRaw(method: string, params: unknown, timeoutMs: number): Promise<any> {
    const id = ++this.sequence;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} 等待响应超时。`)); }, timeoutMs);
      this.pending.set(id, { method, resolve: resolvePromise, reject, timer });
      try { this.send({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  notify(method: string, params: unknown = {}): void { this.send({ method, params }); }
  respond(id: RpcId, result: unknown): void { this.send({ id, result }); }
  respondError(id: RpcId, code: number, message: string): void { this.send({ id, error: { code, message } }); }
  close(error = new Error('执行端连接已关闭。')): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
    // Connection failures belong to the affected adapter, not the worker's uncaught-exception handler.
    try { this.onClose?.(error); } catch { /* Pending requests already retain the original failure. */ }
  }
}

export function object(value: unknown): Record<string, any> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}; }
export function errorText(error: unknown): string { return stripVTControlCharacters(error instanceof Error ? error.message : String(error)); }
export function describe(value: unknown): string { return typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2); }
