import {applySnapshotPatch,acceptSnapshot} from '../shared/snapshot-sync';
import { OPENABLE_DOCUMENT } from '../shared/round-results';
import { catalogEntry, catalogProvider } from '../shared/executor-catalog';
import { app, BrowserWindow, dialog, ipcMain, shell, screen, utilityProcess, MessageChannelMain, safeStorage, Tray, Menu, nativeImage, nativeTheme, powerMonitor, protocol, net, type UtilityProcess } from 'electron';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { RENDERER_METHODS } from '../shared/rpc-methods';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildEnvironment, redact, registerSecret, resolveSafePath } from '../backend/security';
import { getCodexBrowserLoginLaunch } from '../backend/adapters/codex';
import { CLAUDE_TOKEN_PATTERN, getClaudeLoginLaunch } from '../backend/adapters/claude';
import { DshAdapter } from '../backend/adapters/dsh';
import { createInterface } from 'node:readline';
import { spawnOwned, stopOwned, type Ownership } from '../backend/process-supervisor';
import { DEFAULT_SETTINGS, SECRET_PLACEHOLDER, isAcpId, isSecretName, parseEnv, splitSecretEnv } from '../shared/defaults';
import type { AcpExecutor, Project, ProviderInfo, Session, Snapshot, Settings } from '../shared/types';
type Lookup = { session?: Session; project?: Project };
import { assertNormalIntegrity } from './integrity';
import { loginOutput, submitClaudeLoginCode } from './login-output';
import {officialExecutorLoginUrl} from '../backend/official-login';
import {LoginBrowserGate} from './login-browser';
import {codexBrowserLogin} from './codex-login';
import {ProviderLoginState} from './provider-login-state';
import { rpcTimeout,rpcTimeoutMessage } from './rpc-timeouts';
import {BackendReadiness} from './backend-readiness';
import { isAttachmentId, safeAttachmentName } from '../shared/attachments';
import { AUTOMATION_PAUSE_FILE } from '../shared/automation';
import { BackupRestorer, recoverInterruptedRestore, RestoreFailure } from '../backend/backup-restore';
import type { BackupEntry } from '../shared/backup';
import { acceptRunningVersion, runningVersion } from './version';

// Check before touching user data, starting workers, or opening a login.
try { assertNormalIntegrity(); }
catch (error) {
  dialog.showErrorBox('AIROOM 运行权限不正确', String(error instanceof Error ? error.message : error));
  app.exit(1);
  throw error;
}

const dist = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(dist);
// Avoid Electron's lazy userData lookup before configuring a writable profile.
// User-profile storage avoids MSIX AppData redirection by desktop agent hosts.
const dailyData = path.join(process.env.USERPROFILE || app.getPath('home'), '.airoom', 'data');
const dataDirectory = process.env.AIROOM_DATA_DIR || (app.isPackaged ? dailyData : path.join(root, '.airoom'));
// Electron's native instance lock is scoped to userData. Keep it stable across
// development, packaged copies and launchers with different AIROOM_DATA_DIRs.
const instanceDirectory = path.join(dailyData, 'electron');
mkdirSync(dataDirectory, { recursive: true });
mkdirSync(instanceDirectory, { recursive: true });
const startupLog = path.join(dataDirectory, 'startup.log');
const rendererLog = path.join(dataDirectory, 'logs', 'renderer-errors.log');
/** Interface failures caught in the window; kept small, redacted, and included in diagnostics exports. */
function logRendererError(params: any) {
  const text = (value: unknown, max: number) => typeof value === 'string' ? redact(value).slice(0, max) : '';
  const entry = { at: new Date().toISOString(), area: text(params?.area, 80), message: text(params?.message, 2000), stack: text(params?.stack, 6000), componentStack: text(params?.componentStack, 4000) };
  try {
    mkdirSync(path.dirname(rendererLog), { recursive: true });
    // Keep the newest half once the file passes 1 MB.
    if (existsSync(rendererLog) && statSync(rendererLog).size > 1024 * 1024) writeFileSync(rendererLog, readFileSync(rendererLog, 'utf8').slice(-512 * 1024));
    appendFileSync(rendererLog, JSON.stringify(entry) + '\n');
  } catch { /* Logging must never break the window. */ }
  return { logged: true };
}
function logStartup(message: string) { try { appendFileSync(startupLog, `${new Date().toISOString()} ${redact(message)}\n`); } catch { /* stderr remains available to the launcher. */ } }
function startupFailed(error: unknown) {
  const message = redact(error instanceof Error ? error.stack || error.message : String(error));
  logStartup(message);
  dialog.showErrorBox('AIROOM 启动失败', `${message}\n\n启动日志：${startupLog}`);
  app.exit(1);
}
logStartup(`starting pid=${process.pid} packaged=${app.isPackaged} data=${dataDirectory}`);
mkdirSync(path.join(dataDirectory, 'electron', 'session'), { recursive: true });
const nativeTemp = path.join(dataDirectory, 'process-temp');
mkdirSync(nativeTemp, { recursive: true });
process.env.TEMP = nativeTemp;
process.env.TMP = nativeTemp;
app.setPath('userData', instanceDirectory);
app.setPath('sessionData', path.join(dataDirectory, 'electron', 'session'));
app.setAppLogsPath(path.join(dataDirectory, 'logs'));
app.commandLine.appendSwitch('disable-http-cache');
process.env.AIROOM_APP_ROOT = root;
process.env.AIROOM_JOB_HELPER = path.join(dist, 'windows-job.ps1');
process.env.AIROOM_CODEX_STATE_DIR = path.join(dataDirectory, 'native', 'codex', 'sqlite');
process.env.AIROOM_CODEX_HOME = path.join(dataDirectory, 'native', 'codex', 'home');
process.env.AIROOM_DSH_HOME = path.join(dataDirectory, 'native', 'dsh');
process.env.AIROOM_CLAUDE_HOME = path.join(dataDirectory, 'native', 'claude');
process.env.AIROOM_ACP_HOME = path.join(dataDirectory, 'native', 'acp');
const nodeCandidates = [process.env.AIROOM_NODE_EXE, path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe')];
process.env.AIROOM_LOCAL_NODE_EXE = nodeCandidates.find(value => value && existsSync(value) && existsSync(path.join(path.dirname(value),'node_modules/npm/bin/npm-cli.js')));
process.env.AIROOM_BUNDLED_NODE_EXE=process.execPath;
process.env.AIROOM_BUNDLED_NODE_VERSION=process.versions.node;
process.env.AIROOM_NODE_EXE=process.execPath;
process.env.AIROOM_DATA_DIRECTORY=dataDirectory;

let window: BrowserWindow | undefined;
let worker: UtilityProcess | undefined;
let port: Electron.MessagePortMain | undefined;
let tray: Tray | undefined;
let ready = false, quitting = false, nextId = 0;
const backendReadiness=new BackendReadiness();
let backendGeneration=0;
let lastSnapshot: Snapshot | undefined;
const backups=new BackupRestorer(dataDirectory);
let restoring=false,quitAfterRestore=false;
const guardians = new Map<number, Ownership>();
const loginChildren = new Map<string, import('node:child_process').ChildProcess>();
const loginStarting = new Set<string>();
const providerLoginState=new ProviderLoginState(provider=>{const child=loginChildren.get(provider);if(child)void stopOwned(child,1500);});
const loginBrowserGate=new LoginBrowserGate();
const pending = new Map<number, { resolve: (value: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout;method:string;startedAt:number }>();
const push = (event: unknown) => { if (window && !window.isDestroyed()) window.webContents.send('airoom:event', event); };
function setBackendReady(value: boolean) {
  ready = value;
  if (lastSnapshot) lastSnapshot = { ...lastSnapshot, backendReady: value };
}

async function request(method: string, params?: unknown, timeout = 45000): Promise<any> {
  const requestedWorker=worker,requestedPort=port,generation=backendGeneration,startedAt=Date.now(),deadline=startedAt+timeout;
  const timedOut=()=>{logStartup(`rpc-timeout method=${method} durationMs=${Date.now()-startedAt} generation=${generation}`);return new Error(rpcTimeoutMessage(method));};
  if(method==='snapshot'&&!ready&&worker&&port)await backendReadiness.wait(generation,timeout);
  if(requestedWorker!==worker||requestedPort!==port)throw new Error('执行服务已切换，本次状态读取已取消。');
  backendReadiness.assertReady(generation);
  if (!worker || !port || !ready) return Promise.reject(new Error('执行服务尚未就绪，请稍候或重新打开应用'));
  const remaining=deadline-Date.now();
  if(remaining<=0)throw timedOut();
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(timedOut()); }, remaining);
    pending.set(id, { resolve, reject, timer,method,startedAt });
    port!.postMessage({ id, method, params });
  });
}
function stopBackend() {
  backendReadiness.fail(backendGeneration,'执行服务已停止，请重启后端后核对记录。');
  // Kill the held UtilityProcess handle, never a potentially recycled PID.
  // Every guardian holds the worker's native parent handle and closes its Job on that parent's exit.
  worker?.kill(); setBackendReady(false);
}
async function emergencyStop() {
  loginBrowserGate.clear();
  // Keep a human stop durable even if the worker cannot receive its control message.
  try { mkdirSync(dataDirectory,{recursive:true});writeFileSync(path.join(dataDirectory,AUTOMATION_PAUSE_FILE),'paused',{flag:'wx'}); } catch(error) { if((error as NodeJS.ErrnoException).code!=='EEXIST')try{appendFileSync(path.join(dataDirectory,'launch-stop.log'),`Automatic pause marker failed: ${String(error)}\n`);}catch{/* Stopping still takes precedence. */} }
  for(const provider of new Set([...loginStarting,...loginChildren.keys()]))providerLoginState.cancel(provider);
  await Promise.allSettled([...loginChildren.values()].map(child => stopOwned(child, 2000)));
  loginChildren.clear();
  if (ready) {
    try { return await request('all.stop', {}, 2500); } catch { /* Close only the recorded AIROOM-owned descendants. */ }
  }
  stopBackend();
  push({ type: 'backend', ready: false, message: '执行服务已强制停止；旧任务结果待核对，未自动重发。重新打开应用即可恢复记录。' });
  return { received: true, detail: '执行服务与本应用的成员已停止，旧结果待核对' };
}
function secretFile() { return path.join(dataDirectory, 'deepseek.secret'); }
/** Claude's long-lived subscription token from `claude setup-token`, encrypted with the system's credential protection. */
function claudeTokenFile() { return path.join(dataDirectory, 'claude-token.secret'); }
const claudeApiFile=()=>path.join(dataDirectory,'secrets','claude-api.secret');
function storedClaudeApiKey(){
  if(!safeStorage.isEncryptionAvailable()||!existsSync(claudeApiFile()))return;
  try{const value=safeStorage.decryptString(readFileSync(claudeApiFile()));registerSecret(value);return value;}catch{return;}
}
function storedClaudeToken(): string | undefined {
  if (!existsSync(claudeTokenFile()) || !safeStorage.isEncryptionAvailable()) return;
  try { const value = safeStorage.decryptString(readFileSync(claudeTokenFile())); registerSecret(value); return value; } catch { return; }
}
/* Connected programs' API keys and tokens: encrypted per program with the system's credential protection. */
const acpSecretDirectory = path.join(dataDirectory, 'secrets');
const acpSecretFile = (id: string) => path.join(acpSecretDirectory, `${id}.secret`);
function readAcpSecrets(id: string): Record<string, string> {
  if (!isAcpId(id) || !existsSync(acpSecretFile(id)) || !safeStorage.isEncryptionAvailable()) return {};
  try {
    const value = JSON.parse(safeStorage.decryptString(readFileSync(acpSecretFile(id))));
    const secrets: Record<string, string> = {};
    for (const [key, item] of Object.entries(value ?? {})) if (typeof item === 'string') { secrets[key] = item; registerSecret(item); }
    return secrets;
  } catch { return {}; }
}
function allAcpSecrets() {
  const result: Record<string, Record<string, string>> = {};
  try { for (const name of readdirSync(acpSecretDirectory)) { const id = name.replace(/\.secret$/, ''); if (name.endsWith('.secret') && isAcpId(id)) result[id] = readAcpSecrets(id); } } catch { /* No programs with secrets yet. */ }
  return result;
}
function writeAcpSecrets(id: string, secrets: Record<string, string>) {
  if (!isAcpId(id)) return;
  if (!Object.keys(secrets).length) { rmSync(acpSecretFile(id), { force: true }); return; }
  mkdirSync(acpSecretDirectory, { recursive: true });
  writeEncryptedSecret(acpSecretFile(id),JSON.stringify(secrets));
}
function writeEncryptedSecret(file:string,value:string){
  if(!safeStorage.isEncryptionAvailable())throw new Error('系统凭据加密不可用，没有保存密钥。');
  const encrypted=safeStorage.encryptString(value),temporary=file+'.'+randomUUID()+'.tmp';
  mkdirSync(path.dirname(file),{recursive:true});
  try{writeFileSync(temporary,encrypted);renameSync(temporary,file);}finally{rmSync(temporary,{force:true});}
}
/** Secrets are split off here, before anything reaches the backend database. */
async function saveExecutor(params: any) {
  const given = params?.executor && typeof params.executor === 'object' ? params.executor : {};
  const env = typeof given.env === 'string' ? parseEnv(given.env) : given.env && typeof given.env === 'object' ? given.env : {};
  const { plain, secrets } = splitSecretEnv(env, typeof given.id === 'string' ? readAcpSecrets(given.id) : {});
  if (Object.keys(secrets).length && !safeStorage.isEncryptionAvailable()) throw new Error('系统凭据加密不可用，没有保存密钥；请先去掉名称带 KEY、TOKEN、SECRET 等的变量');
  for (const value of Object.values(secrets)) registerSecret(value);
  const saved = await request('executor.save', { executor: { ...given, env: plain }, secrets }, 60_000) as AcpExecutor;
  writeAcpSecrets(saved.id, secrets);
  return saved;
}
/** After start: encrypt plaintext secrets an older version stored, and drop files of removed programs. */
async function tidyAcpSecrets() {
  try {
    const snapshot = await request('internal.lookup', { executors: true }) as Pick<Snapshot, 'executors'>;
    for (const executor of snapshot.executors ?? []) if (Object.keys(executor.env ?? {}).some(isSecretName) && safeStorage.isEncryptionAvailable()) await saveExecutor({ executor: { ...executor, env: { ...executor.env, ...Object.fromEntries((executor.secretKeys ?? []).map(key => [key, SECRET_PLACEHOLDER])) } } });
    const known = new Set((snapshot.executors ?? []).map(executor => executor.id));
    for (const id of Object.keys(allAcpSecrets())) if (!known.has(id as AcpExecutor['id'])) rmSync(acpSecretFile(id), { force: true });
  } catch (error) { logStartup(`acp secrets tidy failed: ${(error as Error).message}`); }
}
function storedKey(): string | undefined {
  if (!existsSync(secretFile()) || !safeStorage.isEncryptionAvailable()) return;
  try { const value = safeStorage.decryptString(readFileSync(secretFile())); registerSecret(value); return value; } catch { return; }
}
function startBackend() {
  setBackendReady(false);const generation=backendGeneration=backendReadiness.start();
  logStartup(`backend-starting generation=${generation}`);
  push({type:'backend',ready:false,message:'执行服务正在启动，准备好后即可操作。'});
  const env = buildEnvironment(lastSnapshot?.settings || DEFAULT_SETTINGS);
  const channel = new MessageChannelMain(); port = channel.port1;
  worker = utilityProcess.fork(path.join(dist, 'worker.mjs'), [], { cwd: root, env, serviceName: 'AIROOM 执行服务', stdio: 'pipe' });
  const ownWorker=worker,ownPort=port;let resyncPending=false;
  worker.stderr?.on('data', data => {if(worker!==ownWorker)return;const text = redact(String(data)); if (!/ExperimentalWarning|Use .--trace-warnings/.test(text)) push({ type: 'backend', ready, message: text.slice(-2000) }); });
  worker.on('spawn', () => {if(worker===ownWorker)ownWorker.postMessage({ type: 'connect', dataDirectory, key: storedKey(), claudeToken: storedClaudeToken(), claudeApiKey: storedClaudeApiKey(), acpSecrets: allAcpSecrets() }, [channel.port2]);});
  port.on('message', event => {
    if(worker!==ownWorker||port!==ownPort||!backendReadiness.current(generation))return;
    const packet = event.data;
    if (packet.id) { const item = pending.get(packet.id); if (!item) return; clearTimeout(item.timer); pending.delete(packet.id);const duration=Date.now()-item.startedAt;if(duration>=1500)logStartup(`rpc-slow method=${item.method} durationMs=${duration} outcome=${packet.error?'failed':'completed'} generation=${generation}`); packet.error ? item.reject(new Error(packet.error)) : item.resolve(packet.result); return; }
    if (packet.type === 'ownership') { packet.info.closed ? guardians.delete(packet.info.pid) : guardians.set(packet.info.pid, packet.info); return; }
    if (packet.type === 'ready') {if(!backendReadiness.markReady(generation))return;setBackendReady(true);logStartup(`backend-ready generation=${generation} pid=${ownWorker.pid}`);push({ type: 'backend', ready: true }); notifyRoomVisibility(); void checkConnectivity(); void tidyAcpSecrets(); return; }
    if (packet.type === 'push') { if(packet.event.type==='executor-login'){const url=loginBrowserGate.accept(packet.event.id,packet.event.state);if(url)void shell.openExternal(url).catch(()=>push({type:'backend',ready,message:'官方授权页未能打开，请点击“打开官方授权页面”重试。'}));return;}if (packet.event.type === 'snapshot') {lastSnapshot={...(lastSnapshot?acceptSnapshot(lastSnapshot,packet.event.snapshot):packet.event.snapshot),backendReady:ready};push({...packet.event,snapshot:lastSnapshot});}
      else if(packet.event.type==='snapshot-patch'){
        const next=lastSnapshot&&applySnapshotPatch(lastSnapshot,packet.event);
        if(next){lastSnapshot={...next,backendReady:ready};push(packet.event);}
        else if(!resyncPending){resyncPending=true;void request('snapshot').then(snapshot=>{if(worker===ownWorker&&backendReadiness.current(generation)){lastSnapshot={...snapshot,backendReady:ready};push({type:'snapshot',snapshot:lastSnapshot!});}}).catch(()=>{}).finally(()=>{resyncPending=false;});}
      }else push(packet.event);return; }
    if (packet.type === 'fatal') {logStartup(`backend-fatal generation=${generation} ${packet.error}`);stopBackend();push({ type: 'backend', ready: false, message: packet.error }); }
  }); port.start();
  worker.on('exit', code => {
    logStartup(`backend-exit generation=${generation} pid=${ownWorker.pid} code=${code} current=${worker===ownWorker}`);
    if(worker!==ownWorker||port!==ownPort)return;
    backendReadiness.fail(generation,'执行服务已退出，请重启后端并核对中断记录。');
    setBackendReady(false); guardians.clear();
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('执行服务已退出；未自动重发任务')); } pending.clear();
    if (!quitting) push({ type: 'backend', ready: false, message: '执行服务已退出；重新打开应用后核对中断记录。' });
  });
}
async function checkConnectivity() {
  if (!ready) return;
  const generation=backendGeneration;
  try {
    const result = await request('network.check', {}, 15000);
    if(!backendReadiness.current(generation)||!ready)return;
    const failed = result.results.filter((entry: any) => !entry.reached);
    if (failed.length) push({ type: 'backend', ready, message: `部分服务连通性检查失败（${failed.map((entry: any) => new URL(entry.url).hostname).join('、')}）。请确认 TUN；可在设置中单独查看结果或选备用代理。其他成员仍可使用。` });
  } catch (error) { if(backendReadiness.current(generation)&&ready)push({ type: 'backend', ready, message: `连通性检测未完成：${redact((error as Error).message)}` }); }
}
async function restartBackend() {
  const old = worker;
  await emergencyStop();
  if (ready) try { await request('internal.close', {}, 4000); } catch { stopBackend(); }
  if (old?.pid) await new Promise<void>(resolve => { old.once('exit', () => resolve()); setTimeout(resolve, 4000).unref(); old.kill(); });
  port?.close(); worker = undefined; port = undefined; ready = false;
  startBackend();
  return { detail: '执行服务正在重新启动，旧任务会保留为中断或待核对，不会重发。' };
}
async function restoreData(params:any){
  if(params?.confirm!==true||typeof params?.token!=='string')throw new Error('请先预览、校验备份并明确确认恢复。');
  if(restoring)throw new Error('资料正在恢复，请等待本次操作完成。');
  if(loginChildren.size||loginStarting.size)throw new Error('成员登录仍在进行，请完成或结束登录后再恢复。');
  restoring=true;let paused=false,closed=false,closingWorker:UtilityProcess|undefined;
  try{
    await backups.verifyPrepared(params.token);
    await request('internal.restore.begin');paused=true;
    const before=await request('internal.backup.beforeRestore',{},rpcTimeout('backup.create')) as BackupEntry;
    await backups.verifyPrepared(params.token);
    closingWorker=worker;closed=true;
    await request('internal.close',{},30000);
    await waitRestoreWorkerExit(closingWorker,15000);
    port?.close();port=undefined;worker=undefined;ready=false;
    const result=await backups.apply(params.token,before.id);
    lastSnapshot=undefined;startBackend();
    const deadline=Date.now()+45000;while(!ready&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));
    return ready?result:{...result,detail:'资料已恢复，但执行服务尚未就绪。请重新启动应用；自动功能保持暂停。'};
  }catch(error){
    if(closed){
      if(closingWorker?.pid){closingWorker.kill();try{await waitRestoreWorkerExit(closingWorker,5000);}catch{ready=false;throw new Error('原执行服务退出尚未确认，未启动新的执行服务。请退出并重新打开应用后核对恢复记录。');}}
      if(!(error instanceof RestoreFailure&&error.requiresRepair)){port?.close();port=undefined;worker=undefined;ready=false;lastSnapshot=undefined;startBackend();}
      else push({type:'backend',ready:false,message:error.message});
    }else if(paused&&ready)await request('internal.restore.cancel').catch(()=>{});
    throw error;
  }finally{restoring=false;if(quitAfterRestore){quitAfterRestore=false;app.quit();}}
}
async function waitRestoreWorkerExit(target:UtilityProcess|undefined,timeout:number){
  if(!target?.pid)return;
  await new Promise<void>((resolve,reject)=>{const exited=()=>{clearTimeout(timer);resolve();};const timer=setTimeout(()=>{target.removeListener('exit',exited);reject(new Error('原执行服务还未退出，没有替换数据。'));},timeout);target.once('exit',exited);if(!target.pid){target.removeListener('exit',exited);clearTimeout(timer);resolve();}});
}
async function login(provider: string) {
  const generation=backendGeneration;
  backendReadiness.assertReady(generation);
  if (!['codex', 'claude', 'dsh'].includes(provider)) throw new Error('DeepSeek API 请使用设置中的密钥入口');
  if (loginChildren.has(provider)||loginStarting.has(provider)||providerLoginState.active(provider)) return { detail: '登录正在进行，请完成或取消当前登录。' };
  const settings = lastSnapshot?.settings || DEFAULT_SETTINGS;
  const token=providerLoginState.begin(provider);
  loginStarting.add(provider);
  // Return immediately so the window can show progress and cancellation while discovery runs.
  void (async()=>{let loginHeld=false;try{
  await request('internal.provider.loginBegin',{provider});
  loginHeld=true;
  if(!providerLoginState.active(provider))return;
  const launch = provider==='dsh' ? await new DshAdapter().accountLaunch(settings,buildEnvironment(settings),'login') : (provider === 'codex' ? getCodexBrowserLoginLaunch : getClaudeLoginLaunch)(settings, buildEnvironment(settings));
  backendReadiness.assertReady(generation);
  if(!providerLoginState.active(provider))return;
  const child = spawnOwned(launch.command, launch.args, { cwd: 'cwd' in launch ? String(launch.cwd) : root, env: launch.env }); loginChildren.set(provider, child);
  loginStarting.delete(provider);
  let opened = false;
  let loginSucceeded=false;
  const open = (url:string) => { if(!opened&&providerLoginState.update(provider,token,{phase:'waiting',message:'请在浏览器完成授权，也可以重新打开授权页或取消。',url})){opened=true;void shell.openExternal(url).catch(()=>push({type:'backend',ready,message:'官方登录页面未能打开，请点击“打开官方授权页面”重试。'}));} };
  const show = (text:string) => {if(/报告登录完成/.test(text))loginSucceeded=true;push({type:'backend',ready,message:`${provider} 登录：${text}`});};
  if(provider==='codex'){
    child.stderr?.resume();
    void codexBrowserLogin(child,open,5*60_000).then(()=>{loginSucceeded=true;}).catch(()=>{loginSucceeded=false;show('官方授权尚未完成，请在设置中重新发起。');}).finally(()=>void stopOwned(child,1500));
  }else if(provider==='dsh'){
    const lines=createInterface({input:child.stdout!});
    lines.on('line',line=>{
      if(!line.startsWith('AIROOM_DSH_ACCOUNT '))return;
      try{
        const value=JSON.parse(line.slice(19));
        if(value.type==='login-url'&&!opened){const url=new URL(value.url);if(url.origin==='https://platform.deepseek.com'&&url.pathname==='/dsh/authorize'&&!url.username&&!url.password)open(url.href);}
        else if(value.type==='phase')push({type:'backend',ready,message:`DSH 独立登录：${value.phase}${value.code?'（'+value.code+'）':''}`});
        else if(value.type==='status'){loginSucceeded=value.authenticated===true;push({type:'backend',ready,message:value.authenticated?'DSH 独立账号已登录':'DSH 登录状态：'+value.state});}
      }catch{push({type:'backend',ready,message:'DSH 登录组件返回无效状态'});}
    });
    child.stderr?.resume();child.once('close',()=>lines.close());
  }else{for(const stream of [child.stdout,child.stderr]){const output=loginOutput(provider,open,show);stream?.on('data',(chunk:Buffer)=>output.write(chunk));stream?.on('end',()=>output.end());}}
  child.on('error',()=>providerLoginState.update(provider,token,{phase:'failed',message:'官方登录程序启动失败，请检查程序路径。'}));
  child.once('close',code=>{
    if(loginChildren.get(provider)!==child)return;
    loginChildren.delete(provider);
    const completed=loginSucceeded&&(provider==='codex'||code===0);
    // DSH stores its grant before the login process finishes its own profile read, so an
    // unfinished DSH login is settled by the connection check rather than by the exit code.
    const unfinished='官方登录没有完成，可以重新登录。',recheck=!completed&&provider==='dsh'&&ready;
    const accepted=providerLoginState.update(provider,token,{phase:completed?'completed':'failed',message:completed?'官方程序报告登录完成，正在检查连接。':recheck?'登录程序没有报告完成，正在核对账号是否已经登录…':unfinished});
    if(ready)void request('internal.provider.loginEnd',{provider}).then(async()=>{
      if(!accepted||!completed&&!recheck)return;
      // The first check after a fresh install starts the program cold: give it the probe budget.
      const infos=await request('provider.probe',{provider},rpcTimeout('provider.probe')) as ProviderInfo[];
      const info=infos.find(item=>item.id===provider);
      // The program can report an unfinished login after the account was already stored.
      if(!completed){providerLoginState.settleUnfinished(provider,token,info?.available?{phase:'completed',message:'账号已经登录，连接检查通过。'}:{phase:'failed',message:unfinished});return;}
      providerLoginState.checked(provider,token,info?.available?'官方授权已完成，连接检查通过。':`官方授权已完成，连接检查未通过：${info?.detail||'请重新检测连接。'}`);
    }).catch(()=>{if(completed)providerLoginState.checked(provider,token,'官方授权已完成，连接检查还没有结果，请稍后重新检测连接。');else providerLoginState.settleUnfinished(provider,token,{phase:'failed',message:unfinished});});
  });
  }catch(error){providerLoginState.update(provider,token,{phase:'failed',message:`登录启动失败：${redact(error instanceof Error?error.message:String(error))}`});}
  finally{if(!loginChildren.has(provider)){loginStarting.delete(provider);if(loginHeld&&ready)void request('internal.provider.loginEnd',{provider}).catch(()=>{});}}
  })();
  return { started: true, detail: '正在准备官方登录，可在下方查看进度或取消。' };
}
const methods = new Set<string>(RENDERER_METHODS);
function registerIpc() {
  ipcMain.handle('airoom:invoke', async (event, method: string, params: any) => {
    if (event.sender !== window?.webContents || event.senderFrame !== event.sender.mainFrame || !methods.has(method)) throw new Error('不允许的工作台请求');
    if(restoring&&!['snapshot','renderer.error','window.show','window.attention'].includes(method))throw new Error('正在恢复资料，请等待恢复完成。');
    if(method==='backup.create'&&(loginChildren.size||loginStarting.size))throw new Error('成员登录仍在进行，请完成或结束登录后再备份。');
    if(method==='backup.prepare')return backups.prepare(String(params?.id));
    if(method==='backup.delete'){
      if(params?.confirm!==true)throw new Error('请先确认删除这份备份。');
      backups.assertRemovable(String(params?.id));
    }
    if(method==='backup.cancel')return backups.cancel(String(params?.token));
    if(method==='backup.restore')return restoreData(params);
    if (method === 'all.stop') return emergencyStop();
    if (method === 'backend.restart') return restartBackend();
    if (method === 'renderer.error') return logRendererError(params);
    if (method === 'executor.save') return saveExecutor(params);
    if(method==='executor.authenticate'){
      const executor=lastSnapshot?.executors?.find(item=>item.id===params?.id);
      if(!executor?.catalogId)return request(method,params,rpcTimeout(method));
      loginBrowserGate.begin(executor.id,executor.catalogId);
      try{return await request(method,params,rpcTimeout(method));}finally{loginBrowserGate.finish(executor.id);}
    }
    if(method==='executor.cancelLogin'){loginBrowserGate.finish(String(params?.id));return request(method,params,rpcTimeout(method));}
    if(method==='executor.openLogin'){
      const executor=lastSnapshot?.executors?.find(item=>item.id===params?.id);
      const state=await request('executor.loginStatus',{id:executor?.id}) as {phase?:string;url?:string}|undefined;
      const url=executor?.catalogId&&state?.phase==='waiting'&&state.url?officialExecutorLoginUrl(executor.catalogId,state.url):undefined;
      if(!url)throw new Error('官方登录链接尚未准备好或已经过期，请重新登录。');
      await shell.openExternal(url);return {opened:true};
    }
    if(method==='catalog.openLink'){
      const entry=catalogEntry(params?.id),field=params?.kind;
      if(!['homepage','licenseUrl','termsUrl'].includes(field))throw new Error('只能打开清单中的官方链接。');
      await shell.openExternal(entry[field as 'homepage'|'licenseUrl'|'termsUrl']);return {opened:true};
    }
    if(method==='catalog.credentials'){
      const entry=catalogEntry(params?.id),id=catalogProvider(entry.id),auth=entry.authentication.find(item=>item.id===params?.authentication);
      if(!isAcpId(id)||!auth)throw new Error('清单登录方式无效。');
      const previous=lastSnapshot?.executors?.find(executor=>executor.id===id);
      if(auth.kind==='api'&&previous?.authentication!==auth.id&&params.value===undefined&&!params.clear)throw new Error('切换订阅或 API 提供方时，请填写该登录方式对应的密钥。');
      const stored=readAcpSecrets(id),secrets:Record<string,string>={};
      for(const key of auth.secretKeys??[]){const value=params.clear?'':params.value===undefined?stored[key]:String(params.value).trim();if(value)secrets[key]=value;}
      if(Object.keys(secrets).length&&!safeStorage.isEncryptionAvailable())throw new Error('系统凭据加密不可用，没有保存密钥。');
      for(const value of Object.values(secrets))registerSecret(value);
      writeAcpSecrets(id,secrets);
      try{return await request('catalog.credentials',{id:entry.id,authentication:auth.id,model:params.model,baseUrl:params.baseUrl,clear:params.clear===true,secrets},60_000);}catch(error){writeAcpSecrets(id,stored);throw error;}
    }
    if(method==='claudeApiKey.set'){
      const value=String(params?.value??'').trim();if(value.length>4096||value&&/[\r\n\0]/.test(value))throw new Error('API Key 格式无效。');
      if(value&&!safeStorage.isEncryptionAvailable())throw new Error('系统凭据加密不可用，没有保存密钥。');
      if(value){registerSecret(value);writeEncryptedSecret(claudeApiFile(),value);}else rmSync(claudeApiFile(),{force:true});
      await request('internal.claudeApiKey',{value:value||undefined});await request('internal.provider.invalidate',{provider:'claude'});void request('provider.probe',{provider:'claude'}).catch(()=>{});return {saved:!!value};
    }
    if (method === 'executor.delete') { const result = await request('executor.delete', params); if (typeof params?.id === 'string') writeAcpSecrets(params.id, {}); return result; }
    if (method === 'dialog.program') {
      const result = await dialog.showOpenDialog(window!, { properties: ['openFile'], title: '选择 AI 程序', filters: [{ name: '程序或脚本', extensions: ['exe', 'cmd', 'js', 'mjs', 'cjs'] }, { name: '所有文件', extensions: ['*'] }] });
      return result.canceled ? null : result.filePaths[0];
    }
    if (method === 'dialog.directory') { const result = await dialog.showOpenDialog(window!, { properties: ['openDirectory'], title: '选择项目目录' }); return result.canceled ? null : result.filePaths[0]; }
    if (method === 'provider.login') return login(params?.provider);
    if(method==='provider.loginStatus')return providerLoginState.get(String(params?.provider));
    if(method==='provider.openLogin'){
      const state=providerLoginState.get(String(params?.provider));
      if(state?.phase!=='waiting'||!state.url)throw new Error('官方授权链接尚未准备好或已过期，请重新登录。');
      await shell.openExternal(state.url);return {opened:true};
    }
    if(method==='provider.cancelLogin'){
      const provider=String(params?.provider);providerLoginState.cancel(provider);
      const child=loginChildren.get(provider);if(child)await stopOwned(child,1500);
      else if(!loginStarting.has(provider)&&ready)await request('internal.provider.loginEnd',{provider});
      return {cancelled:true};
    }
    if(method==='provider.logout'){
      const provider=String(params?.provider);
      if(loginChildren.has(provider)||loginStarting.has(provider))throw new Error('请先取消当前登录，再登出。');
      const result=await request('provider.logout',{provider},90_000);
      if(provider==='claude'){rmSync(claudeTokenFile(),{force:true});await request('internal.claudeToken',{value:undefined});}
      providerLoginState.clear(provider);return result;
    }
    if (method === 'provider.loginCode') {
      if(params?.provider!=='claude')throw new Error('该成员不使用授权码输入');
      await submitClaudeLoginCode(loginChildren.get('claude'),params?.code);return {submitted:true};
    }
    if (method === 'provider.tokenLogin') { if (params?.provider !== 'claude') throw new Error('只有 Claude 使用长期令牌登录'); if(!storedClaudeToken())throw new Error('请通过官方 Claude Code 登录，或选择 API Key。'); return login('claude'); }
    if (method === 'secret.set' && params?.provider === 'claude') {
      const value = String(params?.value || '').trim();
      if(value&&!storedClaudeToken())throw new Error('请通过官方 Claude Code 登录，或选择 API Key。');
      if (value && !CLAUDE_TOKEN_PATTERN.test(value)) throw new Error('这不像 Claude 长期令牌。请复制令牌窗口里以 sk-ant- 开头的整行。');
      if (value && !safeStorage.isEncryptionAvailable()) throw new Error('系统凭据加密不可用，未保存令牌');
      if (value) { registerSecret(value); writeFileSync(claudeTokenFile(), safeStorage.encryptString(value)); } else rmSync(claudeTokenFile(), { force: true });
      await request('internal.claudeToken', { value: value || undefined }); await request('internal.provider.invalidate', { provider: 'claude' });
      await request('provider.probe', { provider: 'claude' }).catch(() => {}); return { saved: Boolean(value), cleared: !value };
    }
    if (method === 'secret.set') {
      if (params?.provider !== 'deepseek') throw new Error('首版仅保存 DeepSeek 备用密钥');
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭据加密不可用，未保存密钥');
      const value = String(params?.value || '').trim(); registerSecret(value);
      writeFileSync(secretFile(), safeStorage.encryptString(value));
      await request('internal.key', { value }); await Promise.all([request('provider.probe', { provider: 'deepseek' }), request('provider.probe', { provider: 'dsh' })]); return { saved: true };
    }
    if (method === 'project.openPath') {
      const resolved = await request('project.openPath', params) as {root:string;relativePath:string;target:string;mode:'open'|'reveal';source?:'submitted'};
      if (resolved.source === 'submitted') {
        // A round's submitted copy lives in AIROOM's own flow workspaces; it is only shown in Explorer.
        const workspaces = realpathSync(path.join(dataDirectory, 'workspaces')), root = realpathSync(resolved.root);
        if (path.dirname(root).toLowerCase() !== workspaces.toLowerCase() || !path.basename(root).startsWith('flow-')) throw new Error('无法核对成果副本位置。');
        const target = resolveSafePath(root, resolved.relativePath);
        if (target !== resolved.target || !statSync(target).isFile()) throw new Error('成果副本已改变，请重新读取成果。');
        shell.showItemInFolder(target); return {revealed:true};
      }
      const { project } = await request('internal.lookup', { projectId: params.projectId }) as Lookup;
      if (!project) throw new Error('项目不存在。');
      const target = resolveSafePath(project.directory, resolved.relativePath);
      if (target !== resolved.target || resolveSafePath(project.directory) !== resolved.root || !statSync(target).isFile()) throw new Error('项目路径已改变，请重新打开。');
      if (resolved.mode === 'reveal' || !OPENABLE_DOCUMENT.test(target)) { shell.showItemInFolder(target); return {revealed:true}; }
      const error = await shell.openPath(target); if (error) throw new Error(error); return {opened:true};
    }
    if (method === 'artifact.open') {
      const { session, project: owner } = await request('internal.lookup', { sessionId: params?.sessionId }) as Lookup; if (!session) throw new Error('会话不存在');
      if(session.restoredHistoryOnly)throw new Error('恢复的会话仅保留历史，产物和工作副本未备份，请新建任务。');
      const project = owner!;
      const relative = String(params.relativePath || ''); const output = relative.startsWith('@artifacts/');
      const target = resolveSafePath(output ? path.join(dataDirectory, 'artifacts', session.id) : session.workspace || project.directory, output ? relative.slice(11) : relative);
      if (!/\.(?:txt|md|json|ya?ml|csv|log|png|jpe?g|webp|gif|pdf|docx|xlsx|pptx)$/i.test(target)) { shell.showItemInFolder(target); return { revealed: true, detail: '已在文件夹中显示产物，执行类文件不会从工作台直接运行' }; }
      const error = await shell.openPath(target); if (error) throw new Error(error); return { opened: true };
    }
    // Desktop affordances: taskbar attention while unfocused, focus from a notification, save an export.
    if (method === 'window.attention') { if (window && !window.isDestroyed() && !window.isFocused()) window.flashFrame(true); return { flashed: true }; }
    if (method === 'window.show') { showMainWindow('notification'); window?.flashFrame(false); return { shown: true }; }
    if (method === 'file.save') {
      const content = String(params?.content ?? ''); if (content.length > 20 * 1024 * 1024) throw new Error('导出内容过大');
      const name = String(params?.name ?? 'AIROOM 对话.md').replace(/[\\/:*?"<>|\r\n]+/g, ' ').slice(0, 120) || 'AIROOM 对话.md';
      const result = await dialog.showSaveDialog(window!, { title: String(params?.title??'导出对话').slice(0,80), defaultPath: path.join(app.getPath('documents'), name), filters: [{ name: 'Markdown', extensions: ['md'] }, { name: '文本', extensions: ['txt'] }] });
      if (result.canceled || !result.filePath) return { saved: false };
      writeFileSync(result.filePath, content, 'utf8'); return { saved: true, path: result.filePath };
    }
    if (method === 'attachment.pick') {
      // Files the user picks are copied into AIROOM's attachment store by the backend; the originals stay put.
      const result = await dialog.showOpenDialog(window!, { title: '选择要附上的图片或文件', properties: ['openFile', 'multiSelections'], filters: [{ name: '所有文件', extensions: ['*'] }, { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] });
      if (result.canceled || !result.filePaths.length) return [];
      return request('attachment.import', { paths: result.filePaths }, rpcTimeout('attachment.import'));
    }
    if (method === 'attachment.reveal') {
      // Points Explorer at the stored copy; nothing is opened or run.
      const id = params?.id, name = typeof params?.name === 'string' ? params.name : '';
      if (!isAttachmentId(id) || !name || safeAttachmentName(name) !== name) throw new Error('附件无效');
      const file = path.join(dataDirectory, 'attachments', id, name);
      if (!existsSync(file)) throw new Error('附件已不存在');
      shell.showItemInFolder(file); return { shown: true };
    }
    // The running build and its deployment record sit next to AIROOM.exe.
    if (method === 'app.version') return runningVersion(path.dirname(process.execPath), app.isPackaged);
    if (method === 'app.accept') return acceptRunningVersion(path.dirname(process.execPath), app.isPackaged);
    if (method === 'attachment.save') {
      const id=params?.id,name=typeof params?.name==='string'?params.name:'';
      if(!isAttachmentId(id)||!name||safeAttachmentName(name)!==name||!/\.(png|jpe?g|webp|gif)$/i.test(name))throw new Error('图片无效');
      const source=resolveSafePath(dataDirectory,path.join('attachments',id,name));
      if(!statSync(source).isFile())throw new Error('图片已不存在');
      const extension=path.extname(name).slice(1);
      const result=await dialog.showSaveDialog(window!,{title:'保存图片',defaultPath:path.join(app.getPath('pictures'),name),filters:[{name:'图片',extensions:[extension]}],properties:['showOverwriteConfirmation']});
      if(result.canceled||!result.filePath)return {saved:false};
      copyFileSync(source,result.filePath);return {saved:true,path:result.filePath};
    }
    if (method === 'asset.import') {
      // Portraits and avatars the user picks are copied into AIROOM's own asset store; the original stays put.
      const result = await dialog.showOpenDialog(window!, { title: '选择图片', properties: ['openFile'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] });
      if (result.canceled || !result.filePaths[0]) return { file: null };
      const source = result.filePaths[0], extension = path.extname(source).slice(1).toLowerCase();
      if (!['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension)) throw new Error('请选择 PNG、JPG、WebP 或 GIF 图片');
      if (statSync(source).size > 8 * 1024 * 1024) throw new Error('图片太大了，请选择 8 MB 以内的图片');
      const directory = path.join(dataDirectory, 'assets'); mkdirSync(directory, { recursive: true });
      const file = `${randomUUID()}.${extension}`; copyFileSync(source, path.join(directory, file));
      return { file };
    }
    if (method === 'desk.folder') {
      const result=await request('desk.folder',params) as {directory:string};
      const error=await shell.openPath(result.directory);if(error)throw new Error(error);return {opened:true,...result};
    }
    if (method === 'workspace.open') {
      // Opens the session's own work copy (or the project) in Explorer; nothing inside it is executed.
      const { session, project } = await request('internal.lookup', { sessionId: params?.sessionId }) as Lookup; if (!session) throw new Error('会话不存在');
      if(session.restoredHistoryOnly)throw new Error('恢复的会话仅保留历史，工作副本未备份，请新建任务。');
      const directory = session.workspace || project?.directory;
      if (!directory) throw new Error('这个会话还没有工作目录');
      const error = await shell.openPath(directory); if (error) throw new Error(error); return { opened: true, directory };
    }
    // Installing a member downloads a full package (can take minutes); version checks reach npm.
    const result = await request(method, params, rpcTimeout(method));
    if (method === 'settings.save') { /* Execution children get the latest isolated environment from Engine. */ }
    return result;
  });
}
function showMainWindow(reason: string) {
  if (!window || window.isDestroyed()) { logStartup(`show-pending ${reason}`); return; }
  if (window.isMinimized()) window.restore();
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const bounds = window.getBounds();
  if (!window.isMaximized() && (bounds.x < area.x || bounds.y < area.y || bounds.x + bounds.width > area.x + area.width || bounds.y + bounds.height > area.y + area.height)) {
    const width = Math.min(bounds.width, area.width), height = Math.min(bounds.height, area.height);
    window.setMinimumSize(Math.min(1000, area.width), Math.min(700, area.height));
    window.setBounds({ x: area.x + Math.floor((area.width - width) / 2), y: area.y + Math.floor((area.height - height) / 2), width, height });
  }
  window.setSkipTaskbar(false);
  window.show(); window.moveTop(); window.focus();
  notifyRoomVisibility();
  logStartup(`window-visible ${JSON.stringify({ reason, visible: window.isVisible(), minimized: window.isMinimized(), focused: window.isFocused(), bounds: window.getBounds() })}`);
}
function notifyRoomVisibility(){
  if(ready&&window&&!window.isDestroyed())void request('internal.room.opened',{visible:window.isVisible()&&!window.isMinimized()},10_000).catch(()=>{});
}
function createWindow() {
  const iconPath=path.join(dist,'airoom.ico'),icon=nativeImage.createFromPath(path.join(dist,'airoom.png'));
  if (icon.isEmpty()) throw new Error('AIROOM 窗口图标缺失，请使用完整程序包。');
  window = new BrowserWindow({ width: 1480, height: 970, minWidth: 1000, minHeight: 700, title: 'AIROOM', icon, backgroundColor: nativeTheme.shouldUseDarkColors ? '#1a1613' : '#f6f0e7', show: false, webPreferences: { preload: path.join(dist, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  if(process.platform==='win32')window.setAppDetails({appId:'local.airoom.desktop',appIconPath:iconPath,appIconIndex:0,relaunchCommand:app.isPackaged?`"${process.execPath}"`:`"${process.execPath}" "${root}"`,relaunchDisplayName:'AIROOM'});
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  void window.loadFile(path.join(dist, 'renderer', 'index.html')).catch(startupFailed);
  window.once('ready-to-show', () => { showMainWindow('ready'); if (lastSnapshot) push({ type: 'snapshot', snapshot: lastSnapshot }); });
  window.on('show',notifyRoomVisibility);window.on('hide',notifyRoomVisibility);window.on('minimize',notifyRoomVisibility);window.on('restore',notifyRoomVisibility);window.on('focus',notifyRoomVisibility);
  window.webContents.on('render-process-gone', (_event, details) => { if (!quitting) startupFailed(new Error(`界面进程退出：${details.reason} (${details.exitCode})`)); });
  window.on('close', event => { if (!quitting) { event.preventDefault(); window!.hide(); logStartup('window-hidden-to-tray'); } });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
}
function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(dist,'airoom.png')).resize({width:16,height:16})); tray.setToolTip('AIROOM');
  tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开工作台', click: () => showMainWindow('tray-menu') }, { label: '停止所有成员', click: () => { void emergencyStop(); } }, { type: 'separator' }, { label: '退出 AIROOM', click: () => app.quit() }]));
  tray.on('double-click', () => showMainWindow('tray-double-click'));
}
// Uploaded portraits and avatars are served read-only from the asset store, by name only.
protocol.registerSchemesAsPrivileged([{ scheme: 'airoom-asset', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
function serveAssets() {
  protocol.handle('airoom-asset', request => {
    const name = decodeURIComponent(new URL(request.url).pathname.replace(/^\//, ''));
    // Attached images are served from their own store, by id and stored name only.
    const attached = /^attachments\/([a-f0-9-]{36})\/([^/\\]+)$/.exec(name);
    if (attached) {
      if (!/\.(png|jpe?g|webp|gif)$/i.test(attached[2]) || safeAttachmentName(attached[2]) !== attached[2]) return new Response('not found', { status: 404 });
      return net.fetch(pathToFileURL(path.join(dataDirectory, 'attachments', attached[1], attached[2])).toString());
    }
    if (!/^[a-f0-9-]{8,64}\.(png|jpe?g|webp|gif)$/i.test(name)) return new Response('not found', { status: 404 });
    return net.fetch(pathToFileURL(path.join(dataDirectory, 'assets', name)).toString());
  });
}
// Windows shows desktop notifications under this identity (same as the packaged appId).
app.setAppUserModelId('local.airoom.desktop');
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => showMainWindow('second-instance'));
  app.whenReady().then(async () => { await recoverInterruptedRestore(dataDirectory);serveAssets(); registerIpc(); createWindow(); createTray(); startBackend(); powerMonitor.on('resume', () => { void checkConnectivity(); }); }).catch(startupFailed);
  app.on('before-quit', event => {
    if(restoring){event.preventDefault();quitAfterRestore=true;return;}
    if (quitting) return; event.preventDefault(); quitting = true;
    void (async () => { await emergencyStop(); if (ready) try { await request('internal.close', {}, 5000); } catch { stopBackend(); } tray?.destroy(); app.exit(0); })();
  });
}
