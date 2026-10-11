import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { stopOwned } from '../process-supervisor';
import { object, spawnCli, type CliCommand } from './common';
import { claudeDebugArgs } from './claude-debug';

function usageProjection(value:unknown){
  const rows=object(object(value).rate_limits).limits;
  if(!Array.isArray(rows)||rows.length>40)return {rate_limits:null};
  return {rate_limits:{limits:rows.flatMap(raw=>{
    const row=object(raw),name=object(object(row.scope).model).display_name;
    if(!['session','weekly_all','weekly_scoped'].includes(row.kind)||typeof row.percent!=='number'||!Number.isFinite(row.percent)||row.percent<0||row.percent>100)return [];
    return [{kind:row.kind,percent:row.percent,resets_at:typeof row.resets_at==='string'&&Number.isFinite(Date.parse(row.resets_at))?new Date(row.resets_at).toISOString():null,
      severity:['normal','warning','critical'].includes(row.severity)?row.severity:'normal',
      ...(typeof name==='string'&&name.length<=80?{scope:{model:{display_name:name}}}:{})}];
  })}};
}

/** Native /usage is a local command, not a model request. Confirm the built-in marker before sending it.
 * The official SDK exposes usage_report on its assistant packet and local_command on the result.
 * No credentials, transcript costs, rendered command text, tools or session persistence are used here. */
export async function claudeAccountUsage(command: CliCommand, env: NodeJS.ProcessEnv, cwd: string, timeoutMs=15_000): Promise<{usage:unknown;checkedAt:string}|undefined> {
  const child=spawnCli(command,[...claudeDebugArgs(env,'usage'),'--restricted','-p','--verbose','--input-format','stream-json','--output-format','stream-json','--no-session-persistence','--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}'],{env,cwd});
  const requestId=randomUUID(),decoder=new StringDecoder('utf8');
  let buffer='',bytes=0,sent=false,settled=false,report:unknown,reportedAt:string|undefined;
  let resolveResult!:(value:{usage:unknown;checkedAt:string}|undefined)=>void;
  const result=new Promise<{usage:unknown;checkedAt:string}|undefined>(done=>{resolveResult=done;});
  const finish=(value:{usage:unknown;checkedAt:string}|undefined)=>{if(!settled){settled=true;resolveResult(value);}};
  const timer=setTimeout(()=>finish(undefined),timeoutMs);
  const write=(packet:unknown)=>{if(!child.stdin?.writable){finish(undefined);return;}child.stdin.write(JSON.stringify(packet)+'\n');};
  child.stdin?.on('error',()=>finish(undefined));
  child.once('error',()=>finish(undefined));child.once('close',()=>finish(undefined));
  child.stderr?.on('data',()=>{});
  child.stdout?.on('data',(chunk:Buffer)=>{
    if(settled)return;
    bytes+=chunk.length;if(bytes>2*1024*1024){finish(undefined);return;}
    buffer+=decoder.write(chunk);
    while(buffer.includes('\n')){
      if(settled)return;
      const index=buffer.indexOf('\n'),line=buffer.slice(0,index).trim();buffer=buffer.slice(index+1);if(!line)continue;
      let packet:Record<string,any>;try{packet=object(JSON.parse(line));}catch{finish(undefined);return;}
      if(packet.type==='control_response'&&packet.response?.request_id===requestId&&!sent){
        const response=object(packet.response);
        if(response.subtype!=='success'||!Array.isArray(response.response?.commands)||!response.response.commands.some((item:any)=>item?.name==='usage'&&item.builtin===true)){finish(undefined);return;}
        sent=true;write({type:'user',uuid:randomUUID(),parent_tool_use_id:null,session_id:'',message:{role:'user',content:'/usage'}});
      }else if(packet.type==='control_request'){
        // A read-only account query must never authorize an unexpected tool or question.
        write({type:'control_response',response:{subtype:'error',request_id:packet.request_id,error:'Account usage query does not permit tools.'}});finish(undefined);return;
      }else if(sent&&packet.type==='assistant'){
        if(packet.message?.content?.some((item:any)=>item?.type==='tool_use')){finish(undefined);return;}
        if(packet.usage_report){report=usageProjection(packet.usage_report);reportedAt=new Date().toISOString();}
      }else if(sent&&packet.type==='result'){
        finish(packet.subtype==='success'&&!packet.is_error&&packet.local_command==='usage'&&packet.num_turns===0?{usage:report,checkedAt:reportedAt??new Date().toISOString()}:undefined);return;
      }
    }
  });
  try{write({type:'control_request',request_id:requestId,request:{subtype:'initialize'}});return await result;}
  finally{clearTimeout(timer);await stopOwned(child,1000);}
}
