/** Extractive summaries only: preserve both ends, identify omissions, never invent consensus. */
export function historyExcerpt(text:string,limit:number){
  if(text.length<=limit)return text;
  let notice=`\n[历史摘录：原文 ${text.length} 字符，中段省略；不能据此声称已核实全文]\n`;
  if(notice.length>limit)notice='[摘录]'.slice(0,Math.max(0,limit));
  const room=Math.max(0,limit-notice.length),head=Math.ceil(room*.65);
  return text.slice(0,head)+notice+text.slice(text.length-(room-head));
}
type Message={id:string;text:string;material?:boolean;[key:string]:unknown};
/** Prepared discussion material (a roundtable's opinions, findings and verdicts). meetingMaterial already
 * fits it to this size by structure, so the per-message history limit must not cut it again mid-JSON. */
export const MATERIAL_CHARS=32000;
/** IDs and unread ordering survive compression; duplicate content is carried once per request. */
export function meetingHistory<T extends Message>(view:{messages:T[];references:T[];recent:T[];background:unknown[]}){
  const ids=new Set<string>(),texts=new Map<string,string>(),notes:string[]=[];
  const count=view.messages.length+view.references.length+view.recent.length;
  const limit=Math.max(320,Math.min(6000,Math.floor(30000/Math.max(1,count))));
  const latestUser=[...view.messages].reverse().find(m=>m.author==='user')?.id;
  const group=(items:T[])=>items.flatMap<T & {duplicateOf?:string;contextExcerpt?:boolean;originalChars?:number}>(item=>{
    if(ids.has(item.id))return [];ids.add(item.id);
    const duplicate=texts.get(item.text);
    if(duplicate)return [{...item,text:`[与消息 ${duplicate} 的正文相同，见该条材料；作者身份仍以本条为准]`,duplicateOf:duplicate}];
    texts.set(item.text,item.id);
    const text=historyExcerpt(item.text,item.material?MATERIAL_CHARS:item.id===latestUser?Math.max(limit,20000):limit);
    if(text!==item.text)notes.push(item.id);
    return [{...item,text,...(text!==item.text?{contextExcerpt:true,originalChars:item.text.length}:{})}];
  });
  const messages=group(view.messages),references=group(view.references),recent=group(view.recent);
  const background=view.background.flatMap(item=>{
    if(!item||typeof item!=='object')return [];
    const value=item as {title?:string;text?:string};if(!value.text||texts.has(value.text))return [];
    texts.set(value.text,'background');return [{...value,text:historyExcerpt(value.text,4000)}];
  });
  return {messages,references,recent,background,historyNote:notes.length?'带 contextExcerpt 的历史仅提供首尾摘录；完整原文仍保留在话题记录中。不能把摘录、重复内容或先发言当成共识或投票。':undefined};
}

/** What the discussion decides on: findings, how they were handled, checks and the conclusion. */
const CORE_KEYS=new Set(['requirement','findings','responses','dispositions','verification','conclusion','skipped']);
/** Keep JSON valid and within budget. Long opinion and candidate texts are excerpted first; findings,
 * dispositions, verification and the conclusion only when that is still not enough. Both ends survive. */
export function meetingMaterial(value:unknown,budget=MATERIAL_CHARS-500){
  budget=Math.max(2,Math.floor(budget));
  const original=JSON.stringify(value),originalChars=original.length;
  const shrink=(item:unknown,limit:number,coreLimit:number,core=false):unknown=>{
    if(typeof item==='string')return historyExcerpt(item,core?coreLimit:limit);
    if(Array.isArray(item))return item.map(child=>shrink(child,limit,coreLimit,core));
    if(item&&typeof item==='object')return Object.fromEntries(Object.entries(item).map(([key,child])=>[key,/^(?:id|.*Ids?|kind|severity|action|outcome|verdict|stage)$/.test(key)?child:shrink(child,limit,coreLimit,core||CORE_KEYS.has(key))]));
    return item;
  };
  let material=value;
  const steps:[number,number][]=[[8000,Infinity],[4000,Infinity],[2000,Infinity],[1000,Infinity],[500,4000],[250,2000],[250,1000],[250,500],[125,250],[80,125],[64,80]];
  for(const [limit,coreLimit] of steps){
    if(JSON.stringify(material).length<=budget)break;
    material=shrink(value,limit,coreLimit);
  }
  // Metadata alone can exceed the budget. Keep whole head/tail entries, never slice JSON or IDs,
  // and explicitly identify omitted lists so excerpts cannot masquerade as complete evidence.
  const compact=(item:unknown,cap:number,path:string,omitted:{path:string;total:number;retained:number}[]):unknown=>{
    if(Array.isArray(item)){
      const head=Math.ceil(cap*.65),entries=item.length>cap?[...item.slice(0,head),...(cap-head?item.slice(-(cap-head)):[])]:item;
      if(item.length>entries.length)omitted.push({path,total:item.length,retained:entries.length});
      return entries.map((entry,index)=>compact(entry,cap,path+'['+index+']',omitted));
    }
    if(item&&typeof item==='object')return Object.fromEntries(Object.entries(item).map(([key,child])=>[key,compact(child,cap,path?path+'.'+key:key,omitted)]));
    return item;
  };
  const shortened=material;
  for(const cap of [80,40,20,10,5,2,1,0]){
    if(JSON.stringify(material).length<=budget)break;
    const omitted:{path:string;total:number;retained:number}[]=[],content=compact(shortened,cap,'',omitted);
    material={contextExcerpt:{notice:'部分条目未提供，完整记录仍在议题中；不能据此声称已核实全部材料。',omitted},material:content};
  }
  if(JSON.stringify(material).length>budget){
    material={contextExcerpt:true,notice:'本次仅提供材料引用，请核对议题完整记录，不能视为已核实全文。',originalChars};
    if(JSON.stringify(material).length>budget)material=budget>=23?{contextExcerpt:true}:{};
  }
  const sentChars=JSON.stringify(material).length;
  return {material,truncated:JSON.stringify(material)!==original,originalChars,sentChars};
}
