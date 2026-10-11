import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { buildEnvironment } from '../src/backend/security';
import { claudeEnvironment } from '../src/backend/adapters/claude';
import { resolveCli, spawnCli } from '../src/backend/adapters/common';
import { stopOwned } from '../src/backend/process-supervisor';
import { DEFAULT_SETTINGS } from '../src/shared/defaults';

const option=(name:string)=>process.argv.find(value=>value.startsWith(`--${name}=`))?.slice(name.length+3);
const profile=option('profile');if(!profile||!path.isAbsolute(profile))throw new Error('Pass --profile=<absolute AIROOM data directory>.');
const output=path.resolve(option('out')??'.test-cache/runtime-optimization/claude-stream-probe.json');
mkdirSync(path.dirname(output),{recursive:true});
const db=new DatabaseSync(path.join(profile,'airoom.sqlite'),{readOnly:true});
const row=db.prepare("SELECT value FROM entities WHERE entity='settings' AND id='main'").get() as {value:string}|undefined;db.close();
const saved=row?JSON.parse(row.value):{};
const env=claudeEnvironment({...buildEnvironment({...DEFAULT_SETTINGS,...saved}),AIROOM_APP_ROOT:process.cwd(),AIROOM_CLAUDE_HOME:path.join(profile,'native','claude'),AIROOM_NODE_EXE:process.execPath});
const command=resolveCli('claude',{...DEFAULT_SETTINGS,...saved},env);
const child=spawnCli(command,['--restricted','-p','--verbose','--input-format','stream-json','--output-format','stream-json','--replay-user-messages','--include-partial-messages','--tools','','--permission-prompts','none'],{cwd:path.dirname(output),env});
const records:any[]=[];let current='',count=0,acknowledged=false,session='';
const streamOwners=new Map<string,string|undefined>();
const report={at:new Date().toISOString(),kind:'claude-serial-input-correlation',completed:0,records};
const send=()=>{current=randomUUID();acknowledged=false;streamOwners.clear();count++;child.stdin!.write(JSON.stringify({type:'user',uuid:current,session_id:session,parent_tool_use_id:null,message:{role:'user',content:[{type:'text',text:`只回复“收到 ${count}”，不使用工具。`}]}})+'\n');};
const lines=createInterface({input:child.stdout!});
lines.on('line',line=>{
  try{
    const value=JSON.parse(line);session=value.session_id??session;
    if(value.type==='user'&&value.uuid===current)acknowledged=true;
    let reference=value.user_message_uuid;
    if(value.type==='stream_event'){
      const key=value.parent_tool_use_id??'main';
      if(value.event?.type==='message_start')streamOwners.set(key,reference);else reference??=streamOwners.get(key);
      if(value.event?.type==='message_stop')streamOwners.delete(key);
    }
    if(['assistant','stream_event'].includes(value.type))records.push({type:value.type,event:value.event?.type,index:count,keys:Object.keys(value).sort(),user_message_uuid:value.user_message_uuid??null,inputReference:reference??null,matchesInput:reference===current});
    if(value.type==='result'){
      records.push({type:'result',keys:Object.keys(value).sort(),uuid:value.uuid??null,session_id:value.session_id??null,acknowledged,subtype:value.subtype,
        inputReference:value.input_uuid??value.user_message_uuid??value.request_id??value.turn_id??null,matchesInput:value.user_message_uuid===current,references:value.user_message_uuids??null});
      report.completed++;if(report.completed<2)send();else child.stdin?.end();
    }
  }catch{/* Record the absence of completion rather than printing raw native output. */}
});
child.stderr?.resume();
const timer=setTimeout(()=>{void stopOwned(child,3000);},60000);timer.unref();
try{send();await new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('close',()=>resolve());});}
finally{clearTimeout(timer);lines.close();await stopOwned(child,3000);writeFileSync(output,JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify({completed:report.completed,resultsMatchInput:records.filter(value=>value.type==='result').every(value=>value.matchesInput),streamMatchesInput:records.filter(value=>value.type==='stream_event').every(value=>value.matchesInput)}));
