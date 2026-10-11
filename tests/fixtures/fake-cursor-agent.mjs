import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
if(process.argv.slice(2).join(' ')!=='--disable-auto-update acp')throw Error('Cursor must use its pinned ACP launch');
if(!process.env.CURSOR_CONFIG_DIR||!process.env.CURSOR_DATA_DIR||process.env.CURSOR_API_KEY||process.env.CURSOR_AUTH_TOKEN)throw Error('Cursor profile isolation failed');
const send=packet=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...packet})+'\n'),reply=(packet,result)=>send({id:packet.id,result}),log=packet=>appendFileSync(process.env.FIXTURE_CALLS,JSON.stringify(packet)+'\n');
let prompt;
createInterface({input:process.stdin}).on('line',line=>{
  const p=JSON.parse(line);log(p);
  if(p.method==='initialize')return reply(p,{protocolVersion:1,agentInfo:{name:'Cursor CLI'},agentCapabilities:{loadSession:true,promptCapabilities:{image:true}},authMethods:[{id:'cursor_login',name:'Cursor Login'}]});
  if(p.method==='session/new'||p.method==='session/load')return reply(p,{sessionId:'cursor-session',models:{currentModelId:'fast',availableModels:[{modelId:'fast',name:'Fast'},{modelId:'deep',name:'Deep'}]}});
  if(p.method==='session/set_model')return reply(p,{});
  if(p.method==='session/prompt'){
    prompt=p;
    if(process.env.FIXTURE_MODE==='quota')return send({id:p.id,error:{code:-32001,message:'You have hit your usage limit'}});
    send({method:'session/update',params:{sessionId:'cursor-session',update:{sessionUpdate:'tool_call',toolCallId:'read1',title:'Read source',kind:'read',status:'pending'}}});
    if(process.env.FIXTURE_MODE==='disconnect')return process.exit(1);
    send({id:'permission',method:'session/request_permission',params:{sessionId:'cursor-session',toolCall:{toolCallId:'read1',kind:'read'},options:[{optionId:'once',kind:'allow_once',name:'允许一次'},{optionId:'deny',kind:'reject_once',name:'拒绝'}]}});return;
  }
  if(p.id==='permission'){
    send({method:'cursor/update_todos',params:{toolCallId:'todo1',todos:[{id:'a',content:'检查源文件',status:'in_progress'}],merge:false}});
    send({id:'question',method:'cursor/ask_question',params:{toolCallId:'ask1',title:'确认方向',questions:[{id:'style',prompt:'选择方向',options:[{id:'brief',label:'简洁'},{id:'full',label:'完整'}]}]}});return;
  }
  if(p.id==='question'){send({id:'plan',method:'cursor/create_plan',params:{toolCallId:'plan1',name:'实施计划',plan:'先检查，再修改。'}});return;}
  if(p.id==='plan'){
    send({method:'session/update',params:{sessionId:'cursor-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Cursor 完成'}}}});
    send({method:'session/update',params:{sessionId:'cursor-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'本轮回复。'}}}});
    reply(prompt,{stopReason:'end_turn'});return;
  }
  if(p.method==='session/cancel'&&prompt)return reply(prompt,{stopReason:'cancelled'});
  if(p.id!==undefined&&p.method)reply(p,{});
});
