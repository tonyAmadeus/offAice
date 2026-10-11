import { realAccountTestEnvironment } from './guard.mjs';
const accountEnv=realAccountTestEnvironment();
for(const key of Object.keys(process.env))if(!(key in accountEnv))delete process.env[key];
Object.assign(process.env,accountEnv);
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Engine } from '../../src/backend/engine';
import { ClaudeAdapter } from '../../src/backend/adapters/claude';
import { disposeOwned } from '../../src/backend/process-supervisor';
import type { Run } from '../../src/shared/types';

// Exercise the same room.send / room.clear / Engine path as the desktop, using an isolated database.
// The live profile is opened read-only; credentials stay with the official CLI and are never read here.
const option=(name:string)=>process.argv.find(value=>value.startsWith(`--${name}=`))?.slice(name.length+3);
const profile=option('profile');
if(!profile||!path.isAbsolute(profile))throw new Error('Pass --profile=<absolute AIROOM data directory>.');
const output=path.resolve(option('out')??'.test-cache/claude-room-engine');
mkdirSync(output,{recursive:true});
if(existsSync(path.join(output,'airoom.sqlite')))throw new Error('Use a fresh output directory to measure new room sessions.');
const db=new DatabaseSync(path.join(profile,'airoom.sqlite'),{readOnly:true});
const rows=db.prepare("SELECT entity,id,value FROM entities WHERE entity IN ('settings','members','profile')").all() as {entity:string;id:string;value:string}[];
db.close();
const previous=Object.fromEntries(['AIROOM_APP_ROOT','AIROOM_NODE_EXE','AIROOM_JOB_HELPER','AIROOM_CLAUDE_HOME'].map(key=>[key,process.env[key]]));
Object.assign(process.env,{AIROOM_APP_ROOT:process.cwd(),AIROOM_NODE_EXE:process.execPath,
  AIROOM_JOB_HELPER:path.resolve('scripts/windows-job.ps1'),AIROOM_CLAUDE_HOME:path.join(profile,'native','claude')});
const protocol:Record<string,Record<string,number>>={};
const unreferenced:unknown[]=[];
const engine=new Engine(output,()=>{},()=>{},id=>{
  if(id!=='claude')throw new Error('This diagnostic only sends to Claude.');
  const adapter=new ClaudeAdapter(),original=(adapter as any).event,owners=new Map<string,string>();
  (adapter as any).event=function(value:any){
    const runId=(this as any).context?.run.id??'idle';
    const key=[value.type,value.event?.type??value.subtype??'',value.user_message_uuid?'reference':'unreferenced'].join('/');
    protocol[runId]??={};protocol[runId][key]=(protocol[runId][key]??0)+1;
    if(value.type==='stream_event'&&value.event?.type==='message_start'&&value.event.message?.id&&value.user_message_uuid)owners.set(value.event.message.id,value.user_message_uuid);
    if(value.type==='assistant'&&!value.user_message_uuid)unreferenced.push({runId,keys:Object.keys(value).sort(),messageKeys:Object.keys(value.message??{}).sort(),blocks:value.message?.content?.map((block:any)=>block.type),messageIdPresent:!!value.message?.id,ownedMessage:owners.get(value.message?.id)===(this as any).inputUuid});
    return original.call(this,value);
  };
  return adapter;
});
for(const row of rows)engine.store.put(row.entity,row.id,JSON.parse(row.value));
engine.settings=engine.store.get('settings','main')!;
const untilIdle=async()=>{const deadline=Date.now()+120000;while(engine.store.roomState().active){if(Date.now()>deadline)throw new Error('Room turn timed out; no automatic retry.');await new Promise(resolve=>setTimeout(resolve,100));}};
try{
  for(let topic=1;topic<=Math.max(1,Math.min(2,Number(option('topics')??2)));topic++){
    if(topic>1)await engine.invoke('room.clear');
    for(let turn=1;turn<=Math.max(1,Math.min(3,Number(option('turns')??3)));turn++){
      await engine.invoke('room.send',{text:`这是聊天室性能测试第 ${turn} 轮，只回复“收到 ${turn}”，不要使用工具。`,memberIds:['claude']});
      await untilIdle();
      const run=engine.store.list<Run>('runs').at(-1)!;
      if(run.status!=='ended')throw new Error(`Room run ${run.status}; no automatic retry.`);
      const record=JSON.parse(readFileSync(path.join(output,'logs','room-runtime.jsonl'),'utf8').trim().split('\n').at(-1)!);
      console.log(JSON.stringify({topic,turn,...record}));
    }
  }
}finally{
  await engine.close();await disposeOwned();
  writeFileSync(path.join(output,'protocol-shapes.json'),JSON.stringify(protocol,null,2)+'\n');
  writeFileSync(path.join(output,'unreferenced-shapes.json'),JSON.stringify(unreferenced,null,2)+'\n');
  for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
}
