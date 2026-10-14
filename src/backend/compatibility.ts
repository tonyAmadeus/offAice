import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, existsSync, statSync, openSync, readSync, closeSync, createReadStream } from 'node:fs';
import path from 'node:path';
import { ADAPTER_CONTRACT_VERSION, type CompatibilityReport, type ExecutorIdentity } from '../shared/compatibility';
import type { Settings, ProviderId } from '../shared/types';
import { redact } from './security';
import { nodeRuntimeInfo } from './node-runtime';

const context = new AsyncLocalStorage<{report: CompatibilityReport; expected?: ExecutorIdentity}>();
export function observeNodeRuntime(env:NodeJS.ProcessEnv){
  const report=context.getStore()?.report,source=env.AIROOM_NODE_SOURCE;
  if(report&&['bundled','local','portable'].includes(source??''))report.nodeRuntime={source:source as 'bundled'|'local'|'portable',version:env.AIROOM_NODE_VERSION??process.versions.node,available:true,...(source==='portable'?{detail:'DSH 原生加载器使用经过官方 SHA-256 校验的标准 Node.js。'}:{})};
}
export function newCompatibility(provider: ProviderId, trigger: CompatibilityReport['trigger'], settings: Settings): CompatibilityReport {
  let proxyHost: string | undefined;
  if(settings.networkMode!=='tun')try{proxyHost=new URL(settings.proxyUrl).hostname;}catch{}
  return {id:randomUUID(),provider,trigger,startedAt:new Date().toISOString(),outcome:'running',
    identity:{adapterVersion:ADAPTER_CONTRACT_VERSION,protocol:provider==='codex'?'codex-app-server':provider==='claude'?'claude-native':provider==='deepseek'?'http':'acp'},
    stages:[],configuration:{model:settings.models[provider],effort:settings.efforts[provider]},network:{mode:settings.networkMode,proxyHost,tunVerified:false},nodeRuntime:nodeRuntimeInfo(settings)};
}
export function withCompatibility<T>(report: CompatibilityReport, action:()=>Promise<T>, expected?:ExecutorIdentity) {
  return context.run({report,expected},action);
}
export function currentIdentity(){const value=context.getStore()?.report.identity;return value?.path?{...value}:undefined;}
export function observeAccount(account:string){const scope=context.getStore();if(scope)scope.report.account=account;}
export function observeVersion(version:string){
  const scope=context.getStore();if(!scope)return;
  const value=String(redact(version)).trim().slice(0,200),expected=scope.expected;
  scope.report.identity.version=value;scope.report.identity.versionSource='native';
  const normalized=(text:string)=>text.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0]??text;
  if(expected?.versionSource==='native'&&expected.version&&normalized(expected.version)!==normalized(value))throw new Error('原会话绑定的原生执行端版本已改变，恢复已停止。');
}
export function observeArguments(args:string[]){
  const scope=context.getStore();if(!scope)return;
  const digest=createHash('sha256').update(JSON.stringify(args)).digest('hex');scope.report.identity.argumentsDigest=digest;
  if(scope.expected?.argumentsDigest&&scope.expected.argumentsDigest!==digest)throw new Error('原会话的启动参数已改变，恢复已停止；请恢复原配置或明确新建会话。');
}
export function compatibilitySync<T>(stage:string,action:()=>T):T{
  const scope=context.getStore(),start=Date.now();let error:unknown;
  try{return action();}catch(cause){error=cause;throw cause;}finally{if(scope){scope.report.stages.push({stage,startedAt:new Date(start).toISOString(),durationMs:Date.now()-start,outcome:error?'failed':'passed',...(error?{error:String(redact((error as Error).message)).slice(0,2500)}:{})});if(scope.report.stages.length>100)scope.report.stages.shift();}}
}
export function observeProtocol(version: string){const scope=context.getStore();if(!scope)return;scope.report.identity.protocolVersion=version;if(scope.expected?.protocolVersion&&scope.expected.protocolVersion!==version)throw new Error('原会话协议版本不匹配，未新建上下文继续执行。');}
type ProgramIdentity=Pick<ExecutorIdentity,'path'|'digest'|'version'|'versionSource'>;
/** A digest is reused only while the file keeps its size, timestamps, file id and manifest. */
export type ProgramFingerprint={size:string;mtimeNs:string;ctimeNs:string;ino:string;manifest:string;digest:string};
export type ProgramFingerprintStore={get(file:string):ProgramFingerprint|undefined;put(file:string,value:ProgramFingerprint):void};
let fingerprintStore:ProgramFingerprintStore|undefined;
const fingerprints=new Map<string,ProgramFingerprint>();
/** Executables are hundreds of MB. Keep their digests across launches; the store's owner clears it on close. */
export function setProgramFingerprintStore(store?:ProgramFingerprintStore,owner?:ProgramFingerprintStore){
  if(owner&&fingerprintStore!==owner)return;
  fingerprintStore=store;fingerprints.clear();
}
function programManifest(resolved:string){
  let directory=path.dirname(resolved),version:string|undefined,packageBytes=Buffer.alloc(0);
  for(let i=0;i<5;i++){
    const manifest=path.join(directory,'package.json');
    if(existsSync(manifest)){packageBytes=readFileSync(manifest);try{version=JSON.parse(packageBytes.toString()).version;}catch{}break;}
    const parent=path.dirname(directory);if(parent===directory)break;directory=parent;
  }
  return {version,packageBytes};
}
function programStamp(resolved:string,packageBytes:Buffer){
  const info=statSync(resolved,{bigint:true});
  return {size:String(info.size),mtimeNs:String(info.mtimeNs),ctimeNs:String(info.ctimeNs),ino:String(info.ino),manifest:createHash('sha256').update(packageBytes).digest('hex')};
}
const sameStamp=(a:Omit<ProgramFingerprint,'digest'>,b:Omit<ProgramFingerprint,'digest'>)=>a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs&&a.ino===b.ino&&a.manifest===b.manifest;
function rememberFingerprint(resolved:string,value:ProgramFingerprint){
  fingerprints.set(resolved,value);
  try{fingerprintStore?.put(resolved,value);}catch{/* The digest stays valid in memory. */}
}
function identityOf(resolved:string,digest:string,version?:string):ProgramIdentity{
  return {path:resolved,digest,...(version?{version,versionSource:'manifest' as const}:{})};
}
/** Read the same file identity used by probes and runs without starting the program. `fresh` ignores the fingerprint cache. */
export function readProgramIdentity(file: string, fresh=false): ProgramIdentity {
  const resolved=realpathSync(file),{version,packageBytes}=programManifest(resolved),stamp=programStamp(resolved,packageBytes);
  const known=fresh?undefined:fingerprints.get(resolved)??fingerprintStore?.get(resolved);
  if(known&&sameStamp(known,stamp)){fingerprints.set(resolved,known);return identityOf(resolved,known.digest,version);}
  const hash=createHash('sha256'),handle=openSync(resolved,'r'),buffer=Buffer.allocUnsafe(1<<20);
  try{for(let read;(read=readSync(handle,buffer,0,buffer.length,null))>0;)hash.update(buffer.subarray(0,read));}finally{closeSync(handle);}
  const digest=hash.update(packageBytes).digest('hex');
  if(sameStamp(stamp,programStamp(resolved,packageBytes)))rememberFingerprint(resolved,{...stamp,digest});
  return identityOf(resolved,digest,version);
}
/** Recompute the digest from the file without blocking the backend; used where a bound identity must be proven. */
export async function verifyProgramIdentity(file: string): Promise<ProgramIdentity> {
  const resolved=realpathSync(file),{version,packageBytes}=programManifest(resolved),stamp=programStamp(resolved,packageBytes),hash=createHash('sha256');
  for await (const chunk of createReadStream(resolved,{highWaterMark:1<<20}))hash.update(chunk as Buffer);
  const digest=hash.update(packageBytes).digest('hex');
  if(sameStamp(stamp,programStamp(resolved,packageBytes)))rememberFingerprint(resolved,{...stamp,digest});
  return identityOf(resolved,digest,version);
}
/** Check a candidate against the identity it was inspected with, hashing the whole file again off the critical path. */
export async function confirmProgram(file: string) {
  observeProgram(file, await verifyProgramIdentity(file));
}
/** Observe the resolved entry before it is started; never infer a historical version from today's settings. */
export function observeProgram(file: string, observed?: ProgramIdentity) {
  const scope=context.getStore();if(!scope)return;
  const {path:resolved,digest,version}=observed??readProgramIdentity(file,Boolean(scope.expected));
  const same=scope.report.identity.path===resolved&&scope.report.identity.digest===digest&&scope.report.identity.versionSource==='native';
  Object.assign(scope.report.identity,{path:resolved,digest,...(!same&&version?{version,versionSource:'manifest' as const}:{})});
  const expected=scope.expected;
  if(expected&&(path.resolve(expected.path??'')!==path.resolve(resolved!)||expected.digest!==digest||expected.adapterVersion!==ADAPTER_CONTRACT_VERSION))throw new Error('原会话绑定的执行端文件或适配器版本已改变，恢复已停止；请恢复原版本，或明确新建会话。');
}
export function stageFor(method: string) {
  if(method==='initialize')return 'initialize';
  if(/resume|load/.test(method))return 'session-load';
  if(/account|authenticate/.test(method))return 'account';
  if(/config|model/.test(method))return 'configuration';
  if(/cancel|interrupt/.test(method))return 'cancel';
  if(/close/.test(method))return 'close';
  if(/prompt|turn\/start/.test(method))return 'dispatch';
  if(/session\/new|thread\/start/.test(method))return 'session-new';
  return method;
}
export async function compatibilityStep<T>(stage:string,action:()=>Promise<T>,method?:string,timeoutMs?:number):Promise<T>{
  const scope=context.getStore();if(!scope)return action();
  const start=Date.now(),startedAt=new Date(start).toISOString();let error:unknown;
  try{return await action();}catch(cause){error=cause;throw cause;}finally{
    const entry={stage,method,startedAt,durationMs:Date.now()-start,timeoutMs,outcome:error?'failed' as const:'passed' as const,
      ...(error?{error:String(redact(error instanceof Error?error.message:String(error))).slice(0,2500),code:(error as {code?:number|string}).code}:{})};
    scope.report.stages.push(entry);if(scope.report.stages.length>100)scope.report.stages.splice(0,scope.report.stages.length-100);
  }
}
