import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

const kind=process.env.FAKE_RUNTIME_KIND??'codex',directory=process.env.FAKE_RUNTIME_LOG;
if(directory)mkdirSync(directory,{recursive:true});
const log=value=>{if(directory)appendFileSync(path.join(directory,'runtime.jsonl'),JSON.stringify({pid:process.pid,kind,...value})+'\n');};
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
if(process.argv.includes('--version')){log({method:'version'});console.log(kind==='codex'?'codex-cli 0.160.0':'2.1.288');process.exit(0);}
if(process.argv.includes('auth')){log({method:'auth'});console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty'}));process.exit(0);}
const capabilities=kind==='claude'&&!process.argv.includes('--include-partial-messages');
log({method:capabilities?'capabilities':'spawn',args:process.argv.slice(2)});
let sessions=0,turns=0,current,previous;
const roomReply=(text,number)=>{if(!text.includes('\nAIROOM_CONTEXT\n'))return '收到 '+number;const input=JSON.parse(text.split('\nAIROOM_CONTEXT\n')[1]);return JSON.stringify({version:1,turn:input.turn,revision:input.revision,action:'speak',body:'收到 '+number});};
const update=(sid,text)=>send({method:'session/update',params:{sessionId:sid,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}});
const end=turn=>{
 if(kind==='codex')send({method:'turn/completed',params:{threadId:turn.sid,turn:{id:turn.turn,status:'completed'}}});
 else{if(kind==='dsh')send({method:'airoom/turnEnd',params:{sessionId:turn.sid,turn:turn.number,kind:'completed'}});send({id:turn.id,result:{stopReason:'end_turn'}});}
};
createInterface({input:process.stdin}).on('line',raw=>{
 const message=JSON.parse(raw),{id,method,params}=message;
 if(kind==='claude'){
   if(message.type==='control_request'&&message.request?.subtype==='initialize'){
     log({method:'configuration-initialize'});
     send({type:'control_response',response:{subtype:'success',request_id:message.request_id,response:{models:[{value:'default',displayName:'Default',supportsEffort:true,supportedEffortLevels:['low','high']}]}}});return;
   }
   const text=message.message.content.find(block=>block.type==='text')?.text,number=++turns,modern=process.env.FAKE_RUNTIME_CORRELATION!=='legacy',reference=modern?{user_message_uuid:message.uuid}:{};
   log({method:'input',uuid:message.uuid,text,content:message.message.content});send({type:'system',subtype:'init',session_id:'claude-fixture',apiKeySource:'none'});send(message);
   if(previous){send(previous.result);send({type:'stream_event',user_message_uuid:previous.inputUuid,event:{type:'message_start',message:{id:'previous-message'}}});send({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'STALE'}}});send({type:'stream_event',event:{type:'message_stop'}});send({type:'assistant',message:{id:'previous-message',content:[{type:'text',text:'STALE'}]}});}
   if(text.includes('CRASH')){process.exit(17);return;}
   if(text.includes('HANG')||text.includes('NO_CANCEL'))return;
   if(text.includes('NO_REF')){send({type:'result',uuid:randomUUID(),subtype:'success',is_error:false,result:'UNMATCHED'});return;}
   if(text.includes('QUOTA')){send({type:'result',uuid:randomUUID(),session_id:'claude-fixture',...reference,subtype:'error_during_execution',is_error:true,errors:['429 usage limit']});return;}
   if(text.includes('ORPHAN_FRAME')){send({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'UNMATCHED'}}});return;}
   const messageId=`message-${number}`,idOnly=text.includes('ID_ONLY');
   send({type:'stream_event',session_id:'claude-fixture',...reference,event:{type:'message_start',message:{id:messageId}}});
   if(text.includes('UNOWNED_ASSISTANT')){send({type:'assistant',session_id:'claude-fixture',message:{id:'unowned-message',content:[{type:'text',text:'UNMATCHED'}]}});return;}
   if(text.includes('WRONG_PARENT')){send({type:'assistant',session_id:'claude-fixture',parent_tool_use_id:'another-child',message:{id:messageId,content:[{type:'text',text:'UNMATCHED'}]}});return;}
   if(text.includes('WRONG_SESSION')){send({type:'stream_event',session_id:'foreign-session',...reference,event:{type:'message_start',message:{id:'foreign-message'}}});send({type:'assistant',session_id:'claude-fixture',message:{id:'foreign-message',content:[{type:'text',text:'UNMATCHED'}]}});return;}
   send({type:'stream_event',session_id:'claude-fixture',event:{type:'content_block_delta',delta:{type:'text_delta',text:roomReply(text,number)}}});
   send({type:'stream_event',session_id:'claude-fixture',event:{type:'message_stop'}});
   send({type:'assistant',session_id:'claude-fixture',...(idOnly?{}:reference),parent_tool_use_id:null,message:{id:messageId,content:[{type:'text',text:roomReply(text,number)}]}});
   const result={type:'result',uuid:randomUUID(),session_id:'claude-fixture',...reference,...(modern?{user_message_uuids:[message.uuid]}:{}),subtype:'success',is_error:false,result:`收到 ${number}`,usage:{input_tokens:1,output_tokens:1}};
   send(result);send(result);previous={result,inputUuid:message.uuid};return;
 }
 log({method,id,params});
 if(method==='initialize')return send({id,result:{protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:{resume:true},promptCapabilities:{image:process.env.FAKE_RUNTIME_IMAGES==='1'?true:process.env.FAKE_RUNTIME_IMAGES==='string'?'true':false}}}});
if(method==='model/list')return send({id,result:{data:process.env.FAKE_RUNTIME_MODELS==='1'?[{model:'fixture-model',supportedReasoningEfforts:[{reasoningEffort:'low'}]}]:[]}});
 if(method==='account/read')return send({id,result:{account:{type:'chatgpt'}}});
 if(method==='config/read')return send({id,result:{config:{model_provider:'openai'}}});
 if(method==='windowsSandbox/readiness')return send({id,result:{status:'ready'}});
 if(method==='thread/start')return send({id,result:{thread:{id:`thread-${++sessions}`,modelProvider:'openai'}}});
 if(method==='thread/resume')return send({id,result:{thread:{id:params.threadId,modelProvider:'openai'}}});
 if(method==='session/new')return send({id,result:{sessionId:`session-${++sessions}`,configOptions:[{id:'reasoning_effort',category:'thought_level',type:'select',currentValue:'low',options:[{value:'low',name:'Low'}]}]}});
 if(method==='session/resume'||method==='session/load')return send({id,result:{sessionId:params.sessionId,configOptions:[{id:'reasoning_effort',category:'thought_level',type:'select',currentValue:'low',options:[{value:'low',name:'Low'}]}]}});
 if(['session/set_config_option','session/set_model','session/close','thread/unsubscribe'].includes(method))return send({id,result:{}});
 if(method==='turn/interrupt'||method==='session/cancel'){
   if(current?.text.includes('NO_CANCEL'))return;
   if(method==='turn/interrupt')send({id,result:{}});
   if(current){clearTimeout(current.timer);if(kind==='codex')send({method:'turn/completed',params:{threadId:current.sid,turn:{id:current.turn,status:'interrupted'}}});else send({id:current.id,result:{stopReason:'cancelled'}});}
   return;
 }
 if(method==='turn/start'||method==='session/prompt'){
   const number=++turns,sid=params.threadId??params.sessionId,text=(params.input??params.prompt)[0].text;
   const turn={id,sid,turn:`turn-${number}`,number,text};
   if(text.includes('QUOTA')){send({id,error:{code:429,message:'429 usage limit'}});return;}
   if(kind==='acp'&&text.includes('EMPTY_END')){
     if(text.includes('TOOL'))send({method:'session/update',params:{sessionId:sid,update:{sessionUpdate:'tool_call',toolCallId:'empty-tool',title:'tool',kind:'read',status:text.includes('DONE')?'completed':'in_progress'}}});
     send({id,result:{stopReason:'end_turn'}});return;
   }
   if(previous){const old=previous;end(old);setTimeout(()=>end(old),15);if(kind==='codex'){send({method:'turn/started',params:{threadId:old.sid,turn:{id:old.turn}}});send({method:'item/agentMessage/delta',params:{threadId:old.sid,turnId:old.turn,itemId:'old',delta:'STALE'}});if(old.image)send({method:'item/completed',params:{threadId:old.sid,turnId:old.turn,item:old.image}});}}
   if(kind==='codex')send({id,result:{turn:{id:turn.turn,status:'inProgress'}}});
   else if(kind==='dsh')send({method:'airoom/turnStart',params:{sessionId:sid,turn:number}});
   current=turn;
   if(kind==='codex'&&text.includes('NO_REF')){send({method:'item/agentMessage/delta',params:{threadId:sid,itemId:'unmatched',delta:'UNMATCHED'}});return;}
   if(text.includes('HANG')||text.includes('NO_CANCEL'))return;
   if(text.includes('CRASH')){setTimeout(()=>process.exit(17),25);return;}
   turn.timer=setTimeout(()=>{
     if(kind==='codex'){
       if(text.includes('IMAGE_GEN')){
         const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6toAAAAAASUVORK5CYII=';
         const failed=text.includes('IMAGE_GEN_LIMIT');
         const large=text.includes('IMAGE_GEN_LARGE')?Buffer.concat([Buffer.from(png,'base64'),Buffer.alloc(13*1024*1024)]).toString('base64'):png;
         const item={id:`image-${number}`,type:'imageGeneration',status:failed?'failed':'completed',result:failed?'':large,revisedPrompt:'a test image',savedPath:'/untrusted/generated.png',...(failed?{failure:{type:'usageLimitExceeded',resetsAt:1893456000}}:{})};
         send({method:'item/started',params:{threadId:sid,turnId:turn.turn,item:{...item,status:'in_progress',result:''}}});
         if(text.includes('IMAGE_GEN_NO_THREAD')){send({method:'item/completed',params:{turnId:turn.turn,item}});return;}
         if(text.includes('IMAGE_GEN_NO_TURN')){send({method:'item/completed',params:{threadId:sid,item}});return;}
         send({method:'item/completed',params:{threadId:'wrong-thread',turnId:turn.turn,item}});
         send({method:'item/completed',params:{threadId:sid,turnId:'wrong-turn',item}});
         send({method:'item/completed',params:{threadId:sid,turnId:turn.turn,item}});
         send({method:'item/completed',params:{threadId:sid,turnId:turn.turn,item}});
         turn.image=item;
       }
       send({method:'item/completed',params:{threadId:sid,turnId:turn.turn,item:{id:`reply-${number}`,type:'agentMessage',text:roomReply(text,number),phase:'final_answer'}}});
       send({method:'item/completed',params:{threadId:sid,turnId:turn.turn,item:{id:`reply-${number}`,type:'agentMessage',text:roomReply(text,number),phase:'final_answer'}}});
     }else update(sid,roomReply(text,number));
     end(turn);end(turn);previous=turn;current=undefined;
     if(text.includes('LATE_BODY'))setTimeout(()=>update(sid,'STALE'),30);
   },40);
 }
}).on('close',()=>process.exit(0));
