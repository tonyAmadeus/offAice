import {peerReviewTargets,type JointOpinion,type JointReviewDetail} from '../shared/joint-review';
import type {Evidence} from '../shared/project-flow';
import type {RoundtableTopic} from '../shared/roundtable';

/** Keep each observation once. These are prompt projections; saved replies remain unchanged. */
function evidence(items:Evidence[]){return items.map(e=>({...e,
  description:e.description===e.result||e.description===e.title?undefined:e.description,
  result:e.kind==='source'&&e.result===e.excerpt?undefined:e.result,
}));}
export function roundtableDiscussionFacts(topic:RoundtableTopic,detail:JointReviewDetail,name:(id:string)=>string){
  const {review,slots}=detail;
  const opinion=(value:JointOpinion)=>{
    const shared=value.findings.filter(f=>review.findings.some(saved=>saved.id===f.id&&
      (['location','kind','severity','evidence','request','previousFindingId'] as const).every(key=>saved[key]===f[key]))),ids=new Set(shared.map(f=>f.id)),unique=value.findings.filter(f=>!ids.has(f.id));
    return {...value,evidence:evidence(value.evidence),findings:unique.length?unique:undefined,findingIds:shared.map(f=>f.id)};
  };
  const conclusion:Record<string,unknown>|undefined=review.conclusion?{...review.conclusion}:undefined;
  if(conclusion&&JSON.stringify(conclusion.dispositions)===JSON.stringify(review.dispositions)){
    delete conclusion.dispositions;conclusion.dispositionsReference='dispositions';
  }
  return {
    requirement:topic.material.text??'',
    opinions:slots.filter(s=>['independent','peer'].includes(s.stage)&&s.status==='completed').map(s=>({
      memberId:s.memberId,memberName:name(s.memberId),stage:s.stage,
      ...(s.stage==='peer'?{targets:peerReviewTargets(s,slots).map(target=>({...target,memberName:name(target.memberId)}))}:{}),
      opinion:s.stage==='independent'?{...opinion(s.opinion!),proposal:undefined,proposalReference:'roundtable-candidate:'+s.id}:opinion(s.opinion!),acceptedByUser:s.acceptedByUser,
    })),
    skipped:slots.filter(s=>s.skippedByUser).map(s=>({memberId:s.memberId,stage:s.stage,reason:s.skippedByUser})),
    // Discussion is public: say whose candidate each anonymous peer finding was about.
    findings:review.findings.map(f=>{const target=f.targetSlotId?slots.find(s=>s.id===f.targetSlotId):undefined;return target?{...f,targetMemberId:target.memberId,targetMemberName:name(target.memberId)}:f;}),responses:review.responses,dispositions:review.dispositions,
    verification:slots.filter(s=>s.verification).map(s=>({...s.verification!,evidence:evidence(s.verification!.evidence)})),
    selectedSlotId:review.selectedSlotId,conclusion,outcome:review.outcome,
  };
}
