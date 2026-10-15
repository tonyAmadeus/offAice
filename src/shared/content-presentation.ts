const labels:Record<string,string>={title:'标题',concept:'构思',visualDirection:'视觉风格',storyboard:'分镜',scenes:'场景',duration:'时长',durationSeconds:'时长（秒）',time:'时间',action:'动作',description:'说明',characters:'角色',deliverables:'成果',implementation:'制作方案',technicalPlan:'制作方案',steps:'步骤',nextSteps:'下一步',notes:'说明',summary:'概要',proposal:'方案',synthesis:'综合方案',objective:'目标',scope:'范围',acceptanceCriteria:'交付要求',rounds:'工作阶段',tasks:'任务',goal:'目标',inputs:'输入材料',completionCriteria:'完成要求',allowedPaths:'文件范围',text:'内容',name:'名称',role:'角色',palette:'配色',fps:'帧率',aspectRatio:'画幅',music:'音乐',soundEffects:'音效',constraints:'要求',implementationNotes:'制作说明',openQuestions:'待确认事项',visuals:'画面',dialogue:'对白',narration:'旁白',animation:'动画',background:'背景',frameRange:'帧区间'};
const internal=new Set(['protocol','version','kind','turn','revision','slotId','recommendedSlotId','sessionId','runId','operationId','artifactId','fingerprint','baselineId','eventIds','evidence','criteriaResults','verificationComplete','validationSummary','systemNotes','source','provenance','inputLimits','id','key','projectId','flowId','planId','roundId','memberId','reviewerMemberId','createdAt','updatedAt','status','dependencies','roundKey']);
/** A display projection, never a replacement for saved evidence or protocol validation. */
export function contentMarkdown(value:unknown,depth=2):string{
  if(typeof value==='string')return value;
  if(value===null||value===undefined)return '';
  if(typeof value!=='object')return String(value);
  if(Array.isArray(value))return value.map((item,index)=>typeof item==='object'?`### ${index+1}\n\n${contentMarkdown(item,Math.min(depth+1,6))}`:`- ${contentMarkdown(item,depth)}`).join('\n\n');
  const object=value as Record<string,unknown>;
  if(object.protocol==='airoom.project-flow'&&object.payload)return contentMarkdown(object.payload,depth);
  const payload='body' in object||'proposal' in object||'synthesis' in object||'userSummary' in object||'summary' in object&&('findings' in object||'evidence' in object||Object.keys(object).length===1);
  if(payload)for(const key of ['body','proposal','synthesis','userSummary','summary'])if(object[key]!==undefined&&object[key]!==null&&object[key]!=='')return contentMarkdown(object[key],depth);
  return Object.entries(object).filter(([key])=>!internal.has(key)).map(([key,item])=>{
    const body=contentMarkdown(item,Math.min(depth+1,6));return body?`${'#'.repeat(depth)} ${labels[key]??key}\n\n${body}`:'';
  }).filter(Boolean).join('\n\n');
}
export function readableContent(text:string){
  const trimmed=text.trim(),fence=trimmed.match(/^```(?:json)?\s*\n([\s\S]*)\n```$/i),raw=fence?.[1]??trimmed;
  if(!raw.startsWith('{')&&!raw.startsWith('['))return text;
  try{const value=JSON.parse(raw);return contentMarkdown(value)||'暂无可展示的正文。';}catch{return text;}
}
const RUN_STATUS:Record<string,string>={rate_limited:'额度用完',failed:'运行失败',blocked:'被拦下',aborted:'中途停止',unknown:'结果未知',stopped:'已停止'};
/** Errors written for members and the program, rephrased for the person reading the card. The saved text is unchanged. */
export function plainFlowError(text:string|undefined){
  if(!text)return '';
  const correction=/^格式补正([^。]*)。/.exec(text);
  if(correction)return `成员整理回复格式时${correction[1].replace(/^不能/,'试图')}，这次整理没有被采用。`;
  if(text.startsWith('最后的 JSON 回复不完整'))return '成员交回的结果格式不完整（常见是结尾少了括号），这次没有收下。';
  if(text.startsWith('命令声明没有相符的实际完成记录'))return '成员写的命令在实际运行记录里找不到对应，这份意见暂未采用。';
  const run=/^成员运行未完成：([a-z_]+)；未自动重发。$/.exec(text);
  if(run)return run[1]==='rate_limited'?'成员的额度用完了，这次没有做完，也没有自动重发。额度恢复后可以点“接着做”。':`成员这次没有做完（${RUN_STATUS[run[1]]??run[1]}），没有自动重发。`;
  return text;
}
/** Joins items that may already end in punctuation without doubling it (no “。、” or “。；”). */
export function joinClauses(items:readonly string[],separator:string){
  return items.map(item=>item.trim().replace(/[。；，、.;,]+$/,'')).filter(Boolean).join(separator);
}
