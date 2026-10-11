import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readFile, rm, appendFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { IMAGE_SEND_MAX } from '../src/shared/attachments';
import { CodexAdapter } from '../src/backend/adapters/codex';
import { ClaudeAdapter, invalidateClaudeChecks } from '../src/backend/adapters/claude';
import { DshAdapter } from '../src/backend/adapters/dsh';
import { AcpAdapter } from '../src/backend/adapters/acp';
import { DEFAULT_SETTINGS } from '../src/shared/defaults';
import type { Adapter, AdapterContext, ProviderId, Run, Session } from '../src/shared/types';
import { Engine } from '../src/backend/engine';
import { runtimeFingerprint } from '../src/backend/runtime-pool';
import { acknowledgedNativeContext } from '../src/backend/native-context';

const base=path.resolve('.test-cache/runtime-tests');
async function fixture(){await mkdir(base,{recursive:true});const directory=await mkdtemp(path.join(base,'case-')),file=path.join(directory,'member.mjs');await copyFile(path.resolve('tests/fixtures/fake-room-runtime.mjs'),file);return {directory,file,cleanup:async()=>{assert.ok(directory.startsWith(base+path.sep));await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});}};}
const kind=(provider:ProviderId)=>provider.startsWith('acp-')?'acp':provider;
function make(provider:ProviderId,file:string):Adapter{
  if(provider==='codex')return new CodexAdapter();if(provider==='claude')return new ClaudeAdapter();
  if(provider.startsWith('acp-'))return new AcpAdapter({id:provider as `acp-${string}`,name:'Test ACP',command:file,args:[],env:{},permissions:{commands:'deny',fileScope:'workspace',network:true},createdAt:''});
  const adapter=new DshAdapter(),native=adapter as any;
  native.accountStatus=async()=>({authenticated:true});native.prepare=async(_file:any,_settings:any,env:any)=>({home:path.dirname(file),env,name:'fixture',patchFile:file});return adapter;
}
function context(provider:ProviderId,directory:string,file:string,session?:Session,extraEnv:NodeJS.ProcessEnv={}){
  const events:any[]=[],children:ChildProcess[]=[],created=new Date().toISOString();
  const ctx:AdapterContext={cwd:directory,settings:{...DEFAULT_SETTINGS,models:{},efforts:{},paths:{[provider]:file},permissions:{...DEFAULT_SETTINGS.permissions,[provider]:{commands:'deny',fileScope:'workspace',network:true}}},
    env:{...process.env,AIROOM_APP_ROOT:process.cwd(),AIROOM_NODE_EXE:process.execPath,AIROOM_CODEX_HOME:path.join(directory,'codex-home'),AIROOM_CLAUDE_HOME:path.join(directory,'claude-home'),AIROOM_DSH_HOME:path.join(directory,'dsh-home'),AIROOM_ACP_HOME:path.join(directory,'acp-home'),FAKE_RUNTIME_KIND:kind(provider),FAKE_RUNTIME_LOG:directory,...extraEnv},
    session:session??{id:randomUUID(),projectId:'room',provider,title:'test',revision:1,writeMode:false,createdAt:created,updatedAt:created},
    run:{id:randomUUID(),sessionId:session?.id??'s',projectId:'room',provider,revision:1,status:'running',delivery:'prepared',input:'',bootId:'test',createdAt:created,updatedAt:created},roomRuntime:true,
    emit(type,text,data){events.push({type,text,data});},async approve(){return {choice:'deny'};},persistNativeSession(id,home){ctx.session.nativeId=id;ctx.session.nativeHome=home;},persistNativePersona(nativeId,hash){ctx.session.nativePersona={nativeId,hash};},markDelivery(state,id){ctx.run.delivery=state;ctx.run.nativeTurnId=id;},registerProcess(child){children.push(child);}};
  return {ctx,events,children};
}
const log=async(directory:string)=>(await readFile(path.join(directory,'runtime.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));

test('room runtimes invalidate a tool-free lease for image/workflow runs even within the same conversation',async()=>{
  const f=await fixture();
  try{
    const h=context('acp-12345678',f.directory,f.file);h.ctx.conversation='room';const ordinary=runtimeFingerprint(h.ctx);
    h.ctx.run.imageGeneration=true;assert.notEqual(runtimeFingerprint(h.ctx),ordinary);
    h.ctx.run.imageGeneration=false;h.ctx.run.flowOperationId='operation';assert.notEqual(runtimeFingerprint(h.ctx),ordinary);
    h.ctx.run.flowOperationId=undefined;assert.equal(runtimeFingerprint(h.ctx),ordinary);
  }finally{await f.cleanup();}
});

test('ACP empty completion stays unknown and retires the runtime; only completed tools can substantiate a tool-only result',async()=>{
  const f=await fixture(),provider='acp-12345678',adapter=make(provider,f.file);
  try{
    const h=context(provider,f.directory,f.file);await adapter.start(h.ctx,'hello');const persona=h.ctx.session.nativePersona;
    for(const prompt of ['EMPTY_END','EMPTY_END_TOOL','EMPTY_END_TOOL_DONE']){
      const result=await adapter.start(h.ctx,prompt),completed=prompt.endsWith('DONE');
      assert.equal(!!result.unknown,!completed);assert.equal(h.ctx.run.delivery,completed?'confirmed':'unknown');assert.equal(adapter.canReuse?.(),completed);
      if(!completed)assert.deepEqual(h.ctx.session.nativePersona,persona,'unknown results do not commit persona delivery');
    }
    const calls=(await log(f.directory)).filter(e=>e.method==='session/prompt');assert.equal(calls.length,4,'unknown completions are not resent');
  }finally{await adapter.dispose?.();await f.cleanup();}
});

test('Claude ordinary room speech starts without MCP helpers or task tools; desk tasks retain both',async()=>{
  const f=await fixture(),adapter=new ClaudeAdapter();
  try{
    const h=context('claude',f.directory,f.file);h.ctx.conversation='room';h.ctx.persona='记忆：保留待办A';await adapter.start(h.ctx,'hello');await adapter.dispose();
    h.ctx.conversation='desk';await adapter.start(h.ctx,'continue');
    const starts=(await log(f.directory)).filter(e=>e.method==='spawn').map(e=>e.args);
    assert.equal(starts[0][starts[0].indexOf('--tools')+1],'');assert.deepEqual(JSON.parse(starts[0][starts[0].indexOf('--mcp-config')+1]),{mcpServers:{}});
    assert.ok(!starts[0].includes('--permission-prompt-tool'));assert.match(starts[0][starts[0].indexOf('--append-system-prompt')+1],/保留待办A/);
    assert.match(starts[1][starts[1].indexOf('--tools')+1],/Read/);assert.ok(starts[1].includes('--permission-prompt-tool'));assert.ok(JSON.parse(starts[1][starts[1].indexOf('--mcp-config')+1]).mcpServers.airoom);
    assert.equal(h.ctx.session.nativeId,'claude-fixture');
  }finally{await adapter.dispose();await f.cleanup();}
});

test('Codex room startup omits unused tools and caches a reported catalogue only within the verified process',async()=>{
  const f=await fixture(),adapter=new CodexAdapter();
  try{
    const h=context('codex',f.directory,f.file,undefined,{FAKE_RUNTIME_MODELS:'1'});h.ctx.conversation='room';h.ctx.settings.models={codex:'fixture-model'};h.ctx.settings.permissions.codex.commands='auto';
    await adapter.start(h.ctx,'hello');await adapter.start(h.ctx,'continue');
    let calls=await log(f.directory);assert.equal(calls.filter(e=>e.method==='model/list').length,1);const config=calls.find(e=>e.method==='thread/start').params.config;
    assert.equal(config['features.shell_tool'],false);assert.equal(config['features.unified_exec'],false);assert.equal(config.web_search,'disabled');
    await adapter.dispose();h.ctx.conversation='desk';await adapter.start(h.ctx,'continue');calls=await log(f.directory);assert.equal(calls.filter(e=>e.method==='model/list').length,2);
    const taskConfig=calls.filter(e=>e.method==='thread/resume').at(-1).params.config??{};assert.equal(taskConfig['features.shell_tool'],undefined);assert.equal(taskConfig.web_search,undefined);
  }finally{await adapter.dispose();await f.cleanup();}
});
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6toAAAAAASUVORK5CYII=','base64');
async function picture(directory:string,name='示例 图片.png',data=png){
  const file=path.join(directory,name);await writeFile(file,data);
  return {id:randomUUID(),name,kind:'image' as const,mime:name.endsWith('.gif')?'image/gif':'image/png',size:data.length,path:file};
}
async function waitFor(read:()=>boolean,label:string,ms=10000){const until=Date.now()+ms;while(!read()){if(Date.now()>until)assert.fail(label);await new Promise(resolve=>setTimeout(resolve,10));}}

test('ACP native history receives changed persona and memory once without resetting the conversation',async()=>{
  const f=await fixture(),provider='acp-12345678',adapter=make(provider,f.file);
  try{
    const h=context(provider,f.directory,f.file);h.ctx.persona='原有记忆：待办A';await adapter.start(h.ctx,'hello');const native=h.ctx.session.nativeId;
    h.ctx.session.nativeContext=acknowledgedNativeContext(h.ctx.session,5,true,false);
    await adapter.start(h.ctx,'continue');h.ctx.persona='更新记忆：决定B';await adapter.start(h.ctx,'updated');await adapter.start(h.ctx,'again');
    const packets=(await log(f.directory)).filter(e=>e.method==='session/prompt').map(e=>e.params.prompt[0].text);
    assert.match(packets[0],/原有记忆/);assert.equal(packets[1],'continue');assert.match(packets[2],/替换此前全部设定；未列出的旧记忆不再适用/);assert.match(packets[2],/更新记忆：决定B/);assert.ok(!packets[2].includes('待办A'));assert.equal(packets[3],'again');assert.equal(h.ctx.session.nativeId,native);
  }finally{await adapter.dispose?.();await f.cleanup();}
});

for(const provider of ['codex','claude','dsh','acp-12345678'] as ProviderId[]){
  test(`${provider}: pictures belong to the current native turn across process reuse`,{timeout:60000},async()=>{
    const f=await fixture(),adapter=make(provider,f.file);
    try{
      const first=await picture(f.directory),second=await picture(f.directory,'下一轮.gif',Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64'));
      let session:Session|undefined;
      for(const [index,attachment] of [first,second,undefined].entries()){
        const h=context(provider,f.directory,f.file,session,{FAKE_RUNTIME_IMAGES:'1'});
        h.ctx.attachments=attachment?[attachment,{...first,id:randomUUID(),name:'过大的图片.png',size:IMAGE_SEND_MAX+1}]:undefined;
        const result=await adapter.start(h.ctx,`图片轮次 ${index}`);session=h.ctx.session;
        assert.ok(!result.unknown&&!result.failure);assert.equal(h.ctx.run.delivery,'confirmed');assert.ok(adapter.canReuse?.());
      }
      const records=await log(f.directory),packets=records.filter(e=>provider==='claude'?e.method==='input':['turn/start','session/prompt'].includes(e.method));
      assert.equal(records.filter(e=>e.method==='spawn').length,1);assert.equal(packets.length,3);
      for(const [index,attachment] of [first,second,undefined].entries()){
        const blocks=packets[index].content??packets[index].params.input??packets[index].params.prompt;
        const images=blocks.filter((block:any)=>['localImage','image'].includes(block.type));
        assert.equal(images.length,attachment?1:0,'no old or oversized picture is attached');
        if(!attachment)continue;
        if(provider==='codex')assert.deepEqual(images[0],{type:'localImage',path:attachment.path});
        else if(provider==='claude')assert.deepEqual(images[0],{type:'image',source:{type:'base64',media_type:attachment.mime,data:(await readFile(attachment.path)).toString('base64')}});
        else assert.deepEqual(images[0],{type:'image',mimeType:attachment.mime,data:(await readFile(attachment.path)).toString('base64')});
      }
    }finally{await adapter.dispose?.();await f.cleanup();}
  });
}

for(const provider of ['dsh','acp-12345678'] as ProviderId[]){
  test(`${provider}: image capability must be explicitly true and unsupported inputs carry an honest note`,{timeout:60000},async()=>{
    const f=await fixture(),adapter=make(provider,f.file);
    try{
      const attachment=await picture(f.directory);
      for(const advertised of ['0','string','1']){
        const h=context(provider,f.directory,f.file,undefined,{FAKE_RUNTIME_IMAGES:advertised});
        const info=await adapter.probe(h.ctx.settings,h.ctx.env);assert.equal(info.capabilities.images,advertised==='1');
        h.ctx.attachments=[attachment];
        const result=await adapter.start(h.ctx,'核对图片');assert.ok(!result.failure&&!result.unknown);
        const packet=(await log(f.directory)).filter(e=>e.method==='session/prompt').at(-1);
        assert.equal(packet.params.prompt.filter((block:any)=>block.type==='image').length,advertised==='1'?1:0);
        if(advertised!=='1'){assert.match(packet.params.prompt[0].text,/图片内容没有随消息发送/);assert.ok(h.events.some(e=>e.type==='warning'));}
        await adapter.dispose?.();
      }
    }finally{await adapter.dispose?.();await f.cleanup();}
  });
}

for(const provider of ['codex','dsh','acp-12345678'] as ProviderId[]){
  test(`${provider}: missing or changed pictures fail before native prompt delivery`,{timeout:60000},async()=>{
    const f=await fixture(),adapter=make(provider,f.file);
    try{
      const attachment=await picture(f.directory);
      for(const missing of [false,true]){
        const h=context(provider,f.directory,f.file,undefined,{FAKE_RUNTIME_IMAGES:'1'});
        h.ctx.attachments=[{...attachment,...(missing?{path:path.join(f.directory,'不存在.png')}:{size:attachment.size+1})}];
        await assert.rejects(adapter.start(h.ctx,'核对图片'),/请重新添加/);assert.equal(h.ctx.run.delivery,'prepared');
        assert.equal((await log(f.directory)).filter(e=>['turn/start','session/prompt'].includes(e.method)).length,0);
      }
    }finally{await adapter.dispose?.();await f.cleanup();}
  });
}

for(const provider of ['codex','claude','dsh','acp-12345678'] as ProviderId[]){
  test(`${provider}: warm turns reject late/duplicate completions and emit only current speech`,{timeout:60000},async()=>{
    const f=await fixture(),adapter=make(provider,f.file);let session:Session|undefined;
    try{
      for(let index=1;index<=3;index++){
        const h=context(provider,f.directory,f.file,session);const result=await adapter.start(h.ctx,`turn ${index}`);session=h.ctx.session;
        assert.ok(!result.unknown&&!result.failure&&!result.stopped,JSON.stringify(result));assert.ok(adapter.canReuse?.());
        assert.equal(h.events.filter(e=>e.type==='delta'||e.type==='message'&&e.data?.source==='assistant').map(e=>e.text).join(''),`收到 ${index}`);
        if(provider==='codex')assert.equal(h.ctx.run.nativeTurnId,`turn-${index}`);
      }
      assert.equal((await log(f.directory)).filter(e=>e.method==='spawn').length,1);
      if(provider==='claude'){const records=await log(f.directory);assert.equal(records.filter(e=>e.method==='version').length,1);assert.equal(records.filter(e=>e.method==='auth').length,1);assert.equal(records.filter(e=>e.method==='configuration-initialize').length,1,'warm turns reuse the prompt-free capability check');}
    }finally{await adapter.dispose?.();await f.cleanup();}
  });
  test(`${provider}: hand ballots share no native context and crashes never resend`,{timeout:60000},async()=>{
    const f=await fixture(),adapter=make(provider,f.file);let session:Session|undefined;
    try{
      for(let index=1;index<=2;index++){const h=context(provider,f.directory,f.file,session);h.ctx.session.purpose='room-hand';await adapter.start(h.ctx,`ballot ${index}`);session=h.ctx.session;}
      const entries=await log(f.directory),prompts=entries.filter(e=>['turn/start','session/prompt','input'].includes(e.method));
      if(provider==='claude')assert.equal(entries.filter(e=>e.method==='spawn').length,2);
      else assert.notEqual(prompts[0].params.threadId??prompts[0].params.sessionId,prompts[1].params.threadId??prompts[1].params.sessionId);
      const h=context(provider,f.directory,f.file);let result;try{result=await adapter.start(h.ctx,'CRASH');}catch{result={unknown:['sent','confirmed','unknown'].includes(h.ctx.run.delivery)};}
      assert.equal(result.unknown,true);assert.equal(adapter.canReuse?.(),false);
      assert.equal((await log(f.directory)).filter(e=>['turn/start','session/prompt'].includes(e.method)&&JSON.stringify(e.params).includes('CRASH')||e.method==='input'&&e.text==='CRASH').length,1);
    }finally{await adapter.dispose?.();await f.cleanup();}
  });
  test(`${provider}: cancellation, configuration/version changes and rate rejection retire the process`,{timeout:60000},async()=>{
    const f=await fixture(),adapter=make(provider,f.file);
    try{
      const first=context(provider,f.directory,f.file);await adapter.start(first.ctx,'one');
      const changed=context(provider,f.directory,f.file,first.ctx.session);changed.ctx.settings.efforts={[provider]:'low'};await adapter.start(changed.ctx,'two');
      assert.equal((await log(f.directory)).filter(e=>e.method==='spawn').length,2);
      await appendFile(f.file,'\n// Updated program\n');const version=context(provider,f.directory,f.file,changed.ctx.session);version.ctx.settings=changed.ctx.settings;await adapter.start(version.ctx,'three');
      assert.equal((await log(f.directory)).filter(e=>e.method==='spawn').length,3);
      const pending=context(provider,f.directory,f.file,version.ctx.session);pending.ctx.settings=version.ctx.settings;const work=adapter.start(pending.ctx,'HANG');
      await waitFor(()=>pending.ctx.run.delivery==='sent'||pending.ctx.run.delivery==='confirmed','prompt sent');await adapter.stop();assert.equal((await work).stopped,true);assert.equal(adapter.canReuse?.(),false);
      const next=context(provider,f.directory,f.file,pending.ctx.session);const result=await adapter.start(next.ctx,'QUOTA');assert.equal(result.failure?.kind,'rate_limited');assert.equal(next.ctx.run.delivery,'confirmed');assert.equal(adapter.canReuse?.(),false);
    }finally{await adapter.dispose?.();await f.cleanup();}
  });
}
test('Claude falls back for legacy results, refuses uncorrelated warm output and manual checks bypass cache',{timeout:60000},async()=>{
  const f=await fixture();invalidateClaudeChecks();
  const adapter=new ClaudeAdapter();
  try{
    let session:Session|undefined;
    for(let i=0;i<2;i++){const h=context('claude',f.directory,f.file,session,{FAKE_RUNTIME_CORRELATION:'legacy'});await adapter.start(h.ctx,'hello');session=h.ctx.session;assert.equal(adapter.canReuse(),false);}
    assert.equal((await log(f.directory)).filter(e=>e.method==='spawn').length,2);assert.equal((await log(f.directory)).filter(e=>e.method==='version').length,1);
    const first=context('claude',f.directory,f.file);await adapter.start(first.ctx,'hello');assert.ok(adapter.canReuse());
    const missing=context('claude',f.directory,f.file,first.ctx.session);const result=await adapter.start(missing.ctx,'NO_REF');assert.equal(result.unknown,true);assert.ok(!missing.events.some(e=>e.text.includes('UNMATCHED')));assert.equal(adapter.canReuse(),false);
    const restarted=context('claude',f.directory,f.file,missing.ctx.session);await adapter.start(restarted.ctx,'hello');assert.ok(adapter.canReuse());
    const orphan=context('claude',f.directory,f.file,restarted.ctx.session);assert.equal((await adapter.start(orphan.ctx,'ORPHAN_FRAME')).unknown,true);assert.ok(!orphan.events.some(e=>e.text.includes('UNMATCHED')));assert.equal(adapter.canReuse(),false);
    await adapter.probe(first.ctx.settings,first.ctx.env);await adapter.probe(first.ctx.settings,first.ctx.env);
    assert.equal((await log(f.directory)).filter(e=>e.method==='version').length,4);
  }finally{await adapter.dispose();invalidateClaudeChecks();await f.cleanup();}
});

test('runtime fingerprints react to permissions, persona, network, native account and convention changes',async()=>{
  const f=await fixture();
  try{
    const {ctx}=context('claude',f.directory,f.file),stamp=runtimeFingerprint(ctx);
    for(const changed of [
      {...ctx,persona:'New member card'}, {...ctx,session:{...ctx.session,writeMode:true}},
      {...ctx,settings:{...ctx.settings,proxyUrl:'http://127.0.0.1:8787'}},
      {...ctx,settings:{...ctx.settings,permissions:{...ctx.settings.permissions,claude:{commands:'ask' as const,fileScope:'any' as const,network:false}}}},
      {...ctx,env:{...ctx.env,AIROOM_NODE_EXE:'different-node.exe'}},
    ])assert.notEqual(runtimeFingerprint(changed),stamp);
    await writeFile(path.join(f.directory,'CLAUDE.md'),'A new project convention');assert.notEqual(runtimeFingerprint(ctx),stamp);
    const convention=runtimeFingerprint(ctx);await mkdir(ctx.env.AIROOM_CLAUDE_HOME!,{recursive:true});
    await writeFile(path.join(ctx.env.AIROOM_CLAUDE_HOME!,'.credentials.json'),'{}');assert.notEqual(runtimeFingerprint(ctx),convention);
  }finally{await f.cleanup();}
});

test('Claude correlates UUID-less committed text only by an owned message ID in the same parent stream',{timeout:60000},async()=>{
  const f=await fixture(),adapter=new ClaudeAdapter();
  try{
    let session:Session|undefined;
    for(let index=1;index<=3;index++){
      const h=context('claude',f.directory,f.file,session),decisions:any[]=[];
      h.ctx.recordRuntime=(stage,conditions)=>decisions.push({stage,...conditions});
      const result=await adapter.start(h.ctx,'ID_ONLY');session=h.ctx.session;
      assert.ok(!result.unknown&&!result.failure);assert.ok(adapter.canReuse());
      assert.equal(h.events.filter(e=>e.type==='delta'||e.type==='message'&&e.data?.source==='assistant').map(e=>e.text).join(''),`收到 ${index}`);
      assert.ok(decisions.some(d=>d.stage==='claude-retention'&&d.matchedAssistantMessages===1&&d.keep&&d.streamCorrelation));
    }
    assert.equal((await log(f.directory)).filter(e=>e.method==='spawn').length,1);
    for(const prompt of ['UNOWNED_ASSISTANT','WRONG_PARENT','WRONG_SESSION']){
      const h=context('claude',f.directory,f.file,session);assert.equal((await adapter.start(h.ctx,prompt)).unknown,true);
      assert.ok(!h.events.some(e=>e.text.includes('UNMATCHED')));assert.equal(adapter.canReuse(),false);
      const next=context('claude',f.directory,f.file,h.ctx.session);await adapter.start(next.ctx,'ID_ONLY');session=next.ctx.session;
      assert.ok(adapter.canReuse());
    }
  }finally{await adapter.dispose();await f.cleanup();}
});

test('Codex refuses unscoped warm events instead of showing them in the new turn',{timeout:30000},async()=>{
  const f=await fixture(),adapter=new CodexAdapter();
  try{
    const first=context('codex',f.directory,f.file);await adapter.start(first.ctx,'hello');
    const second=context('codex',f.directory,f.file,first.ctx.session);assert.equal((await adapter.start(second.ctx,'NO_REF')).unknown,true);
    assert.ok(!second.events.some(e=>e.text.includes('UNMATCHED')));assert.equal(adapter.canReuse(),false);
  }finally{await adapter.dispose();await f.cleanup();}
});

for(const provider of ['dsh','acp-12345678'] as ProviderId[])test(`${provider}: speech after a final prompt response retires the unsafe runtime`,{timeout:30000},async()=>{
  const f=await fixture(),adapter=make(provider,f.file);
  try{
    const first=context(provider,f.directory,f.file);await adapter.start(first.ctx,'LATE_BODY');
    await waitFor(()=>!adapter.canReuse?.(),'late idle speech retires runtime');assert.ok(!first.events.some(e=>e.text.includes('STALE')));
    const next=context(provider,f.directory,f.file,first.ctx.session);await adapter.start(next.ctx,'hello');assert.equal((await log(f.directory)).filter(e=>e.method==='spawn').length,2);
  }finally{await adapter.dispose?.();await f.cleanup();}
});

test('engine desk chat reuses a verified native process and retires it on stop without losing its session',{timeout:60000},async()=>{
  const f=await fixture(),children:ChildProcess[]=[],nativeEnv=context('codex',f.directory,f.file).ctx.env;
  const keys=['AIROOM_CODEX_HOME','AIROOM_NODE_EXE','FAKE_RUNTIME_KIND','FAKE_RUNTIME_LOG'],previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  for(const key of keys)process.env[key]=nativeEnv[key];
  const engine=new Engine(path.join(f.directory,'data'),()=>{},child=>children.push(child),()=>new CodexAdapter());engine.settings={...engine.settings,paths:{codex:f.file}};
  try{
    await engine.invoke('desk.open',{memberId:'codex'});await engine.invoke('desk.topic',{memberId:'codex'});
    const desk=await engine.invoke('desk.open',{memberId:'codex'}) as {sessionId:string};
    const send=async(text:string)=>{const {runId}=await engine.send(desk.sessionId,text) as {runId:string};await waitFor(()=>engine.store.get<Run>('runs',runId)?.status==='ended','desk completion');return runId;};
    await send('hello');const native=engine.store.get<Session>('sessions',desk.sessionId)!.nativeId;await send('continue');
    assert.equal((await log(f.directory)).filter(e=>e.method==='spawn').length,1);assert.equal(engine.store.get<Session>('sessions',desk.sessionId)!.nativeId,native);
    const records=(await readFile(path.join(f.directory,'data/logs/room-runtime.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.equal(records[1].reused,true);assert.equal(records[1].processes,0);
    await engine.invoke('all.stop');assert.ok(children.every(child=>child.exitCode!==null||child.signalCode!==null));
    await send('continue after stop');assert.equal((await log(f.directory)).filter(e=>e.method==='spawn').length,2);assert.equal(engine.store.get<Session>('sessions',desk.sessionId)!.nativeId,native);
  }finally{await engine.close();for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}await f.cleanup();}
});

test('engine reuses room programs, keeps project runs separate and clears warm processes on configuration/stop/exit',{timeout:60000},async()=>{
  const f=await fixture(),children:ChildProcess[]=[],nativeEnv=context('codex',f.directory,f.file).ctx.env;
  const previous=Object.fromEntries(['AIROOM_CODEX_HOME','AIROOM_CLAUDE_HOME','AIROOM_DSH_HOME','AIROOM_ACP_HOME','AIROOM_NODE_EXE','FAKE_RUNTIME_KIND','FAKE_RUNTIME_LOG'].map(key=>[key,process.env[key]]));
  for(const key of Object.keys(previous))process.env[key]=nativeEnv[key];
  const engine=new Engine(path.join(f.directory,'data'),()=>{},child=>children.push(child),()=>new CodexAdapter());
  engine.settings={...engine.settings,paths:{codex:f.file}};
  const chat=async()=>{const d=engine.store.roomState().discussion;await engine.invoke('room.send',{mode:'discuss',style:'chat',maxCalls:1,maxMinutes:0,text:'hello',memberIds:['codex']});await waitFor(()=>!engine.store.roomState().active,'input completion');if(d&&engine.store.roomState().discussion?.phase==='budget')await engine.invoke('room.resume',{maxCalls:1});await waitFor(()=>!engine.store.roomState().active,'room completion');};
  try{
    await chat();await chat();assert.equal((await log(f.directory)).filter(e=>e.method==='spawn').length,1);
    const records=(await readFile(path.join(f.directory,'data','logs','room-runtime.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.equal(records[1].reused,true);assert.equal(records[1].processes,0);
    assert.equal(records[1].decisions['engine-retention'].keep,true);assert.equal(records[1].decisions['pool-retention'].retained,true);
    const project=await engine.invoke('project.create',{directory:f.directory}) as {id:string};const s=engine.createSession(project.id,'codex',undefined,false);
    for(let i=0;i<2;i++){const {runId}=await engine.send(s.id,'project') as {runId:string};await waitFor(()=>engine.store.get<Run>('runs',runId)?.status==='ended','project completion');}
    assert.equal((await log(f.directory)).filter(e=>e.method==='spawn').length,3);
    await engine.invoke('team.save',{member:{id:'codex',persona:'Changed persona'}});await chat();assert.equal((await log(f.directory)).filter(e=>e.method==='spawn').length,4);
    await engine.invoke('all.stop');assert.ok(children.every(child=>child.exitCode!==null||child.signalCode!==null));
    await chat();assert.equal((await log(f.directory)).filter(e=>e.method==='spawn').length,5);
    await engine.invoke('internal.provider.invalidate',{provider:'codex'});assert.ok(children.every(child=>child.exitCode!==null||child.signalCode!==null));
    await chat();assert.equal((await log(f.directory)).filter(e=>e.method==='spawn').length,6);
    engine.settings.stopTimeoutMs=100;
    await engine.invoke('room.send',{mode:'discuss',style:'chat',maxCalls:1,maxMinutes:0,text:'NO_CANCEL',memberIds:['codex']});await engine.invoke('room.resume',{maxCalls:1});
    await waitFor(()=>engine.store.list<Run>('runs').some(run=>run.status==='running'&&run.input.includes('NO_CANCEL')&&run.delivery==='confirmed'),'uncancellable warm turn');
    await engine.invoke('room.stop');await waitFor(()=>!engine.store.roomState().active,'forced process cleanup');
    assert.ok(children.every(child=>child.exitCode!==null||child.signalCode!==null));
    assert.equal((await log(f.directory)).filter(e=>e.method==='turn/start'&&e.params.input[0].text.includes('NO_CANCEL')).length,1);
    const exported=await engine.invoke('diagnostics.export') as {path:string};assert.ok(JSON.parse(await readFile(exported.path,'utf8')).roomRuntime.length>=4);
  }finally{await engine.close();assert.ok(children.every(child=>child.exitCode!==null||child.signalCode!==null));for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}await f.cleanup();}
});
