import {FLOW_CONTRACTS} from './flow-contract';
import {FLOW_LIMITS,FlowError} from './project-flow';

type Fields=Record<string,unknown>;
type Transform=(value:unknown)=>unknown;
const formatProblem=Symbol('flow format conflict');
const inferredCommand=Symbol('unlabelled command evidence');
export const hasInferredCommand=(value:object)=>Boolean((value as {[inferredCommand]?:boolean})[inferredCommand]);
const metadata=<T extends object>(source:object,target:T):T=>Object.assign(target,Object.fromEntries(Object.getOwnPropertySymbols(source).map(key=>[key,(source as Record<symbol,unknown>)[key]])));
/** A repair of another field must not erase an original command claim or its verification boundary. */
export function retainCommandProvenance(original:unknown,corrected:unknown):unknown{
  if(!original||typeof original!=='object'||!corrected||typeof corrected!=='object')return corrected;
  const before=(original as Fields).evidence,after=(corrected as Fields).evidence;
  if(!Array.isArray(before)||!before.some(item=>item&&typeof item==='object'&&hasInferredCommand(item)))return corrected;
  const evidence=Array.isArray(after)?[...after]:[],used=new Set<number>();
  for(const [index,prior] of before.entries()){
    if(!prior||typeof prior!=='object'||!hasInferredCommand(prior))continue;
    let found=!used.has(index)&&evidence[index]&&typeof evidence[index]==='object'&&(evidence[index].command===prior.command||evidence[index].result===prior.result)?index:-1;
    if(found<0)found=evidence.findIndex((item,index)=>!used.has(index)&&item&&typeof item==='object'&&item.command===prior.command);
    const item=metadata(prior,{...(found<0?{}:evidence[found]),kind:'inspection',command:prior.command}) as Fields;
    for(const key of ['description','result'])if(typeof prior[key]==='string')item[key]=prior[key];
    if(prior.exitCode===undefined)delete item.exitCode;else item.exitCode=prior.exitCode;
    used.add(found<0?evidence.length:found);if(found<0)evidence.push(item);else evidence[found]=item;
  }
  return {...corrected as Fields,evidence};
}
const deferredProblem=(value:unknown)=>value&&typeof value==='object'?(value as {[formatProblem]?:FlowError})[formatProblem]:undefined;
const token=(value:string)=>value.trim().toLowerCase().replace(/[\s_-]/g,'');
const blank=(value:unknown)=>value==null||typeof value==='string'&&!value.trim()||Array.isArray(value)&&!value.length||typeof value==='object'&&value!==null&&!Object.keys(value).length;
const enumValue=(values:string[]):Transform=>value=>typeof value==='string'?values.find(option=>token(option)===token(value))??value:value;
const boolean:Transform=value=>typeof value==='string'&&/^(true|false)$/i.test(value.trim())?value.trim().toLowerCase()==='true':value;
const integer:Transform=value=>typeof value==='string'&&/^-?(?:0|[1-9]\d*)$/.test(value.trim())&&Number.isSafeInteger(Number(value))?Number(value):value;
const scalarRules:Record<string,Transform>={
  verified:boolean,resolved:boolean,requiresUserAcceptance:boolean,review:boolean,affectsAcceptance:boolean,exitCode:integer,
  kind:enumValue(['check','judge','owner','verified','suspected','suggestion','command','quote','inspection','source','tool','tool-result']),
  severity:enumValue(['blocking','should-fix','optional']),rating:enumValue(['meets','partly','not']),
  stance:enumValue(['agree','dispute','fixed-new-version']),action:enumValue(['accept','defer','reject']),
  verdict:enumValue(['pass','changes_requested','inconclusive','uphold-author','uphold-review']),
  source:enumValue(['reported','observed']),disposition:enumValue(['noted','answered','in-scope-fix','scope-change','needs-user']),
};
const textFields=new Set(['summary','userSummary','proposal','synthesis','description','result','title','location','excerpt','command','evidence','request','reason','instruction','text','criterion','goal','objective','scope','scopeReason','validationSummary','nextRoundSummary','userDecisionNeeded','outOfScopeExplanation']);
const comparison=(key:string,value:unknown)=>{const transform=Object.hasOwn(scalarRules,key)?scalarRules[key]:Object.hasOwn(transforms,key)?transforms[key]:undefined;return transform?transform(value):typeof value==='string'?value.trim():value;};
/** Two spellings of one field with different content. A model cannot pick a side for the member,
 * so the flows skip the format correction and leave the reply to the user. */
export const AMBIGUOUS_FIELDS='AMBIGUOUS_FIELDS';
/** Shown in place of a command result the member did not write; it states the absence, not an outcome. */
export const COMMAND_RESULT_MISSING='（成员未单独写明运行结果）';

/** Only spelling and empty placeholders are normalized. Conflicting aliases are never guessed. */
function record(value:unknown,allowed:string[],optional:string[]=[],aliases:Record<string,string>={}):unknown{
  if(!value||typeof value!=='object'||Array.isArray(value))return value;
  const names=new Map(allowed.map(key=>[token(key),key])),result=new Map<string,unknown>();
  for(const [original,item] of Object.entries(value)){
    const spelling=token(original),key=names.get(spelling)??(Object.hasOwn(aliases,spelling)?aliases[spelling]:undefined)??original;
    if(!allowed.includes(key)&&blank(item)||optional.includes(key)&&(item==null||typeof item==='string'&&!item.trim()))continue;
    if(result.has(key)){
      const prior=result.get(key);
      // A valid text alias wins over the same literal in an invalid primitive type.
      if(textFields.has(key)&&typeof prior!==typeof item){
        const text=typeof prior==='string'?prior:typeof item==='string'?item:undefined,other=typeof prior==='string'?item:prior;
        if(text!==undefined&&['number','boolean'].includes(typeof other)&&text.trim()===String(other)){result.set(key,text);continue;}
      }
      if(JSON.stringify(comparison(key,prior))!==JSON.stringify(comparison(key,item)))throw new FlowError(AMBIGUOUS_FIELDS,`同义字段 ${key} 重复且内容不一致，请保留原意并明确填写一次。`);
      continue;
    }
    result.set(key,item);
  }
  return metadata(value,Object.fromEntries(result));
}
function fields(value:unknown,transforms:Record<string,Transform>):unknown{
  if(!value||typeof value!=='object'||Array.isArray(value))return value;
  return metadata(value,Object.fromEntries(Object.entries(value).map(([key,item])=>[key,Object.hasOwn(transforms,key)?transforms[key](item):item])));
}
/** A single item stays one item; strings are never split or interpreted as instructions. */
const list=(transform:Transform=value=>value):Transform=>value=>{
  if(value===undefined)return value;
  // null, "" and {} all mean "nothing here"; wrapping {} would invent one empty item.
  if(value===null||!Array.isArray(value)&&blank(value))return [];
  if(Array.isArray(value)&&value.length>FLOW_LIMITS.tasks)return value;
  const items=Array.isArray(value)?value:typeof value==='string'||typeof value==='object'?[value]:undefined;
  return items?items.map(transform):value;
};
const strings=list();
const criteria=list(value=>fields(record(value,['text','kind']),{kind:enumValue(['check','judge','owner'])}));
const result=list(value=>{
  const normalized=fields(record(value,['criterion','verified','evidence']),{verified:boolean});
  if(normalized&&typeof normalized==='object'&&!Array.isArray(normalized)){
    const item=normalized as Fields;
    if(item.verified==null)item.verified=false;
    if(item.evidence==null)item.evidence='';
  }
  return normalized;
});
const findings=list(value=>{
  const normalized=fields(record(value,['location','kind','severity','evidence','request','previousFindingId','candidate'],['previousFindingId','candidate']),{
    kind:enumValue(['verified','suspected','suggestion']),severity:enumValue(['blocking','should-fix','optional']),
  });
  if(normalized&&typeof normalized==='object'&&!Array.isArray(normalized)){
    const finding=normalized as Fields;
    if(finding.location==null||typeof finding.location==='string'&&!finding.location.trim())finding.location='未注明位置';
    if(finding.request==null||typeof finding.request==='string'&&!finding.request.trim())finding.request='';
    if(['suspected','suggestion'].includes(String(finding.kind))&&finding.evidence==null)finding.evidence='';
  }
  return normalized;
});
const evidence=list(value=>{
  const normalized=fields(record(value,['kind','description','command','exitCode','result','eventIds','source','title','location','excerpt'],['command','exitCode','eventIds','source','title','location','excerpt']),{
    kind:enumValue(['command','quote','inspection','source','tool','tool-result']),exitCode:integer,eventIds:strings,source:enumValue(['reported','observed']),
  });
  if(!normalized||typeof normalized!=='object'||Array.isArray(normalized))return normalized;
  const e=normalized as Fields;
  // The existing fields identify the representation, never whether the claim is true.
  if(e.kind==null){
    const command=typeof e.command==='string'&&Boolean(e.command.trim()),source=e.location!==undefined||e.excerpt!==undefined;
    // Preserve the observation and its inferred type; execution still requires native evidence.
    if(command&&!source){e.kind='inspection';Object.assign(e,{[inferredCommand]:true});if(blank(e.description)&&blank(e.result))e.description=e.command;}
    else if(!command&&typeof e.location==='string'&&typeof e.excerpt==='string')e.kind='source';
    else if(!command&&!source&&(typeof e.description==='string'||typeof e.result==='string'))e.kind='inspection';
  }
  if(e.kind==='tool'||e.kind==='tool-result')e.kind='inspection';
  // Reuse the full existing observation; never ask a model to invent a missing result. A command's
  // result is what running it showed, so its description is never copied into it.
  if(e.kind==='command'&&blank(e.result)&&typeof e.description==='string'&&e.description.trim())e.result=COMMAND_RESULT_MISSING;
  if(e.kind==='inspection'||e.kind==='quote'){
    if(blank(e.result)&&typeof e.description==='string'&&e.description.trim())e.result=e.description;
    if(blank(e.description)&&typeof e.result==='string'&&e.result.trim())e.description=e.result;
  }
  return e;
});
const transforms:Record<string,Transform>={
  deliverables:strings,unverifiedItems:strings,remainingIssues:strings,strengths:strings,completedTaskKeys:strings,
  acceptanceCriteria:criteria,completionCriteria:criteria,criteriaResults:result,completionResults:result,findings,evidence,
  verificationComplete:boolean,inScope:boolean,
  verdict:enumValue(['pass','changes_requested','inconclusive']),mode:enumValue(['as-planned','adjusted','replan']),outcome:enumValue(['confirmed','refuted','inconclusive']),
  findingIds:strings,
  rounds:list(value=>fields(record(value,['key','title','goal','requiresUserAcceptance','completionCriteria','reviewLevel'],['key','requiresUserAcceptance','completionCriteria','reviewLevel']),{
    requiresUserAcceptance:boolean,completionCriteria:criteria,reviewLevel:enumValue(['high','medium','low']),
  })),
  tasks:list(value=>fields(record(value,['key','roundKey','title','memberId','goal','inputs','completionCriteria','dependencies','allowedPaths','reviewerMemberId','review','reuse'],['key','roundKey','inputs','dependencies','reviewerMemberId','review','reuse']),{
    inputs:strings,dependencies:strings,allowedPaths:strings,completionCriteria:criteria,review:boolean,
  })),
  allowedPaths:strings,
  previousFindingChecks:list(value=>fields(record(value,['findingId','resolved','evidence']),{resolved:boolean})),
  disputes:list(value=>record(value,['findingId','reason'])),
  assessments:list(value=>fields(record(value,['criterion','rating','reason'],[],{assessment:'rating'}),{rating:enumValue(['meets','partly','not'])})),
  responses:list(value=>fields(record(value,['findingId','findingIndex','stance','reason','evidence','newSubmissionId'],['findingId','findingIndex','evidence','newSubmissionId']),{
    stance:enumValue(['agree','dispute','fixed-new-version']),
  })),
  dispositions:list(value=>fields(record(value,['findingId','findingIndex','action','reason'],['findingId','findingIndex']),{action:enumValue(['accept','defer','reject'])})),
  disagreements:list(value=>fields(record(value,['findingIds','findingIndexes','reason','affectsAcceptance'],['findingIds','findingIndexes']),{findingIds:strings,affectsAcceptance:boolean})),
  verificationRequests:list(value=>fields(record(value,['findingIds','findingIndexes','instruction','memberId'],['findingIds','findingIndexes','memberId']),{findingIds:strings})),
  taskAdjustments:list(value=>fields(record(value,['taskId','goal','inputs','completionCriteria'],['goal','inputs','completionCriteria']),{inputs:strings,completionCriteria:criteria})),
  meetingResponses:list(value=>fields(record(value,['messageId','disposition','summary','paths']),{
    disposition:enumValue(['noted','answered','in-scope-fix','scope-change','needs-user']),paths:strings,
  })),
  rulings:list(value=>fields(record(value,['findingId','verdict','reason']),{verdict:enumValue(['uphold-author','uphold-review','inconclusive'])})),
};

/** Applied before both validation and correction guards, leaving the stored native reply intact. */
export function normalizeFlowPayload(value:unknown,kind:string,deferErrors=false):unknown{
  const contract=FLOW_CONTRACTS[kind];if(!contract)return value;
  const deferred=deferredProblem(value);if(deferred){if(!deferErrors)throw deferred;return value;}
  try{return fields(record(value,contract.allowed,contract.allowed.filter(key=>!contract.required.includes(key))),transforms);}
  catch(error){
    if(!deferErrors||!(error instanceof FlowError)||!value||typeof value!=='object'||Array.isArray(value))throw error;
    // Parsing must retain the actual original for prose/meaning guards, even when its aliases conflict.
    return {...value,[formatProblem]:error};
  }
}
export function assertFlowFormatUnambiguous(value:unknown){
  const error=deferredProblem(value);
  if(error)throw new FlowError('FORMAT_MEANING_CHANGED','格式补正不能替原回复选择矛盾的字段。'+error.message);
}

/** Repair nonsemantic syntax without changing decoded text or guessing missing quotes/brackets. */
export function parseCompatibleJson(raw:string):unknown{
  try{return JSON.parse(raw);}catch{}
  let normalized='',quoted=false,escaped=false;
  for(let index=0;index<raw.length;index++){
    const char=raw[index];
    if(quoted){normalized+=!escaped&&['\n','\r','\t'].includes(char)?JSON.stringify(char).slice(1,-1):char;if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false;continue;}
    if(char==='"')quoted=true;
    if(char===','){let next=index+1;while(/\s/.test(raw[next]??'')&&next<raw.length)next++;if(raw[next]==='}'||raw[next]===']')continue;}
    normalized+=char;
  }
  return JSON.parse(normalized);
}
