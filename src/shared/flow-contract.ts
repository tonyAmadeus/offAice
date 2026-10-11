/** Top-level payload contract shared by prompt generation and validation; nested evidence stays strict. */
const schema=(required:string[],optional:string[]=[])=>({required,allowed:[...required,...optional]});
const review=schema(['verdict','verificationComplete','criteriaResults','findings','evidence'],['previousFindingChecks','assessments','strengths']);
const opinion=schema(['summary'],['findings','unverifiedItems','proposal','evidence','userSummary']);
export const FLOW_CONTRACTS:Record<string,ReturnType<typeof schema>>={
  plan:schema(['objective','scope','deliverables','acceptanceCriteria','rounds','tasks']),
  submission:schema(['summary','evidence','completionResults'],['userSummary','outOfScopeExplanation','disputes']),
  review,'integration-check':review,'peer-review':review,'requested-check':review,
  'round-report':schema(['summary','completedTaskKeys','deliverables','validationSummary'],['remainingIssues','nextRoundSummary','userDecisionNeeded','meetingResponses']),
  'next-round':schema(['mode'],['summary','taskAdjustments','completionCriteria']),
  'task-addition':schema(['completionCriteria','allowedPaths','inScope','scopeReason']),
  'task-rearrange':schema(['memberId','goal','completionCriteria','reason']),
  adjudication:schema(['rulings']),
  'joint-independent':opinion,'joint-peer':opinion,
  'author-response':schema(['responses']),
  'joint-summary':schema(['summary'],['dispositions','disagreements','verificationRequests','recommendedSlotId','synthesis','userSummary']),
  verification:schema(['outcome','summary'],['findingIds','evidence']),
};
export function contractHint(kind:string){const contract=FLOW_CONTRACTS[kind];return contract?`本用途 payload 必需字段：${contract.required.join('、')}；允许字段：${contract.allowed.join('、')}。`:'';}
