import type {AdapterContext} from '../../shared/types';

type Packet={id?:number|string;method?:string;params?:any};
interface CursorClient {
  context?:AdapterContext;
  sessionId?:string;
  active:()=>boolean;
  reply:(result:unknown,error?:{code:number;message:string})=>void;
}
/** Cursor's documented ACP extensions are client requests, not executable instructions. */
export async function cursorClientRequest(packet:Packet,client:CursorClient):Promise<boolean>{
  const {context,reply}=client,params=packet.params??{},request=packet.id!==undefined;
  if(!['cursor/ask_question','cursor/create_plan','cursor/update_todos','cursor/task','cursor/generate_image'].includes(packet.method??''))return false;
  const active=()=>!!context&&client.active()&&(!params.sessionId||params.sessionId===client.sessionId);
  if(!active()){if(request)reply({outcome:{outcome:'cancelled'}});return true;}
  if(!request){
    if(packet.method==='cursor/update_todos'&&Array.isArray(params.todos))context!.emit('plan',params.todos.slice(0,128).map((todo:any)=>`${todo.status==='completed'?'✓':todo.status==='in_progress'?'…':'·'} ${String(todo.content??'').slice(0,4000)}`).join('\n'),params,'native');
    else if(packet.method==='cursor/task')context!.emit('tool',String(params.description??'Cursor 子任务').slice(0,4000),params,'native');
    else if(packet.method==='cursor/generate_image')context!.emit('tool',String(params.description??'Cursor 生成图片').slice(0,4000),params,'native');
    return true;
  }
  if(packet.method==='cursor/ask_question'){
    const questions=params.questions;
    if(!Array.isArray(questions)||!questions.length||questions.length>16||questions.some((q:any)=>typeof q.id!=='string'||!q.id||typeof q.prompt!=='string'||!Array.isArray(q.options)||!q.options.length||q.options.length>64||q.options.some((o:any)=>typeof o.id!=='string'||!o.id||typeof o.label!=='string'))){reply(undefined,{code:-32602,message:'Invalid Cursor questions'});return true;}
    const answer=await context!.approve({type:'question',title:String(params.title??'Cursor 想确认几个问题').slice(0,4000),detail:questions.map((q:any)=>q.prompt).join('\n'),questions:questions.map((q:any)=>({id:q.id,question:q.prompt,options:q.options.map((o:any)=>({label:o.label})),multiSelect:!!q.allowMultiple})),options:[{id:'answer',label:'提交回答'},{id:'skip',label:'跳过'}]});
    if(!active()){reply({outcome:{outcome:'cancelled'}});return true;}
    if(answer.choice!=='answer'){reply({outcome:{outcome:'skipped'}});return true;}
    const values=answer.answers&&typeof answer.answers==='object'?answer.answers as Record<string,unknown>:{},answers=[];
    for(const question of questions){
      const value=values[question.id],selected=Array.isArray(value)?value:typeof value==='string'&&value.trim()?[value]:[];
      const options=selected.map((label:unknown)=>question.options.find((option:any)=>option.label===label||option.id===label));
      if(!selected.length||options.some((option:any)=>!option)||!question.allowMultiple&&options.length>1){
        // The official schema only accepts option IDs. Keep a free-text reply as a visible skip reason.
        const text=Object.values(values).flat().filter(value=>typeof value==='string').join('；').slice(0,8000);
        if(text)context!.emit('status','Cursor 提问只接受所列选项；自定义回答已作为补充说明传回。',undefined,'derived');
        reply({outcome:{outcome:'skipped',...(text?{reason:'用户补充：'+text}:{})}});return true;
      }
      answers.push({questionId:question.id,selectedOptionIds:[...new Set(options.map((option:any)=>String(option.id)))]});
    }
    reply({outcome:{outcome:'answered',answers}});return true;
  }
  if(packet.method==='cursor/create_plan'){
    if(typeof params.plan!=='string'||params.plan.length>250_000){reply(undefined,{code:-32602,message:'Invalid Cursor plan'});return true;}
    context!.emit('plan',params.plan,params,'native');
    const answer=await context!.approve({type:'approval',title:String(params.name??'Cursor 请求确认计划').slice(0,4000),detail:[params.overview,params.plan].filter(value=>typeof value==='string').join('\n\n'),options:[{id:'accept',label:'接受计划'},{id:'reject',label:'退回计划'}],allowChoice:'accept',denyChoice:'reject',category:'plan',categoryLabel:'确认计划'});
    reply({outcome:{outcome:!active()?'cancelled':answer.choice==='accept'?'accepted':'rejected'}});return true;
  }
  reply(undefined,{code:-32601,message:'Cursor extension is notification-only'});return true;
}
