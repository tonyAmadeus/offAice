import type { MemberProfile, RoomMessage } from './types';
import { discussionObject, DiscussionFormatError } from './discussion-format';
import { roomReaction } from './room';
/** Room control is private structured data, never inferred from the visible prose. */
export type DiscussionPhase = 'talking' | 'raising' | 'awaiting-host' | 'closing' | 'summarizing' | 'idle' | 'waiting_user' | 'paused' | 'blocked' | 'budget';
/** chat (闲聊): open-ended; members may answer with just an emoji, and suggest winding down only after a good stretch of talk.
 *  work (开会): one seated response round per human message, followed by optional one-time supplements and a human wait.
 *  Settings default to unlimited chat and two formal speeches per seated meeting member. */
export type DiscussionStyle = 'chat' | 'work';
export interface DiscussionQuestion { id: string; from: string; to: string; text: string; messageId: string; answeredBy?: string; expiredBy?: string }
/** Expiry records a missed casual question without pretending it was answered. */
export const pendingDiscussionQuestion = (q: DiscussionQuestion) => !q.answeredBy && !q.expiredBy;
export interface HandVote { want: 0 | 1 | 2 | 3; why: string }
export interface HandBallot extends Partial<HandVote> { runId?: string; status: 'pending' | 'done' | 'invalid' | 'failed' | 'stopped'; error?: string; limited?: boolean }
export interface HandRound {
  id: string; revision: number; status: 'collecting' | 'waiting' | 'done' | 'stale' | 'stopped' | 'failed';
  ballots: Record<string, HandBallot>; selected?: string; fallback?: boolean;
}
export interface RoomDiscussion {
  id: string; members: string[]; phase: DiscussionPhase; revision: number; style?: DiscussionStyle;
  seen: Record<string, number>; lastSpoke: Record<string, number>; priority: string[]; handoff?: string;
  passed?: string[]; relevant?: string[];
  meetingRound?:{messageId:string;pending:string[];mentionedOnly:boolean;handSelection?:boolean;waitAfterRound?:boolean;supplemented?:string[]};meetingCursor?:string;stoppedMembers?:string[];
  /** Isolate unsuccessful members across rounds. Only an explicit resume retries them. */
  skippedMembers?:Record<string,{reason:string;runId?:string;unknown?:boolean;limited?:boolean}>;
  callUsage?:import('./call-usage').CallUsage;
  calls: number; limit: number; allowance: number; minutes: number; deadline: number;
  /** Auxiliary requests remain in calls; new settings limit only formal speech per human round. */
  budgetKind?: 'speech' | 'calls'; speechCalls?:number;
  handRaise?: boolean; handCalls?: number; handRound?: HandRound;
  hostPick?: boolean; hostWaitStartedAt?: number;
  questions: DiscussionQuestion[]; reviewRequired: string[]; noProgress: number;
  latestUserId: string; reason?: string; unknownRunId?: string; unknownRunIds?: string[]; acknowledgedRunIds?: string[];
  mentionQueue?:{memberId:string;messageId:string}[]; workWaiting?:boolean;
  proposal?: { id: string; revision: number; proposer: string; accepted: string[]; skipped?:string[] };
  /** Remarks since the user last spoke or since the last proposal to wind down; a chat may propose only after enough of them. */
  sinceProposal?: number;
  /** Call count of the last emoji added alongside a remark; keeps them occasional. */
  emojiAt?: number;
  /** Call count at which the current meeting round began; hands go up once everyone has spoken since. */
  roundFrom?: number;
  /** A separate, read-only call after unanimous meeting closure. Never used by casual chat. */
  meetingMinutes?: { proposalId: string; memberId: string; status: 'pending' | 'running' | 'done' | 'failed' | 'stopped' | 'stale'; messageId?: string; runId?: string; error?: string; source?:'user'; interruptedSpeech?:boolean };
  endedBy?: 'user' | 'members'; endedAt?: string;
}
export function hasMeetingRemarks(d:RoomDiscussion|undefined,messages:RoomMessage[]){return Boolean(d&&d.style!=='chat'&&d.phase!=='idle'&&messages.some(m=>m.discussionId===d.id&&d.members.includes(m.author)&&m.status==='done'&&m.text.trim()&&!m.system&&!m.discussionControl&&!m.discussionStale));}
export interface DiscussionReply {
  version: 1; turn: string; revision: number;
  action: 'speak' | 'pass' | 'react' | 'propose' | 'accept' | 'reject' | 'ask_user';
  body: string; replyTo?: string; next?: string; proposalId?: string;
  /** One of ROOM_REACTIONS: the whole answer for react, an optional extra on speak. */
  emoji?: string;
  questions?: { to: string; text: string }[]; answers?: string[];
  /** Internal diagnostics, never copied from model-supplied fields. */
  formatWarnings?: string[]; reviewQuestions?: boolean;
}
export const DISCUSSION_LABELS: Record<DiscussionPhase, string> = {
  talking: '自由讨论中', raising: '大家正在举手', 'awaiting-host': '等你点名', closing: '正在核对收尾', summarizing: '正在整理会议纪要', idle: '本次讨论已自然结束',
  waiting_user: '等你说话', paused: '已暂停', blocked: '等待核对', budget: '达到讨论预算，已暂停',
};
export function parseDiscussionReply(text: string, turn: string, revision: number): DiscussionReply {
  const value = discussionObject(text);
  const keys = ['version','turn','revision','action','body','replyTo','next','proposalId','questions','answers','emoji'];
  for (const [key,expected] of Object.entries({version:1,turn,revision})) {
    if (value[key] === undefined) throw new DiscussionFormatError('讨论控制信息缺少必需的轮次字段。', true);
    if (value[key] !== expected) throw new DiscussionFormatError('讨论控制信息与当前轮次不符，请核对后继续。');
  }
  if (!['speak','pass','react','propose','accept','reject','ask_user'].includes(value.action) || typeof value.body !== 'string' || value.body.length > 12000) throw new DiscussionFormatError('讨论动作或正文格式无效。', true);
  const silent = ['pass','react','accept'].includes(value.action);
  if (silent ? value.body.trim() !== '' : !value.body.trim()) throw new DiscussionFormatError('发言与讨论动作不一致。', true);
  if (silent && (value.next || value.questions !== undefined && (!Array.isArray(value.questions) || value.questions.length) || value.answers !== undefined && (!Array.isArray(value.answers) || value.answers.length))) throw new DiscussionFormatError('沉默或收尾确认不能同时提出新的调度要求。');
  const reply: DiscussionReply = { version:1,turn,revision,action:value.action,body:value.body,formatWarnings:[] };
  const warn = (text:string) => reply.formatWarnings!.push(text);
  if (reply.action === 'react') {
    const emoji = typeof value.emoji === 'string' ? roomReaction(value.emoji) : undefined;
    if (!emoji) throw new DiscussionFormatError('表情回应只能使用 👍 ❤️ 😄 👀 ❓ 之一。', true);
    reply.emoji = emoji;
  } else if (value.emoji !== undefined) {
    const emoji = reply.action === 'speak' && typeof value.emoji === 'string' ? roomReaction(value.emoji) : undefined;
    if (emoji) reply.emoji = emoji; else warn('已忽略无法使用的表情');
  }
  if (Object.keys(value).some(key => !keys.includes(key))) warn('已忽略额外的控制字段');
  for (const key of ['replyTo','next','proposalId'] as const) if (value[key] !== undefined) {
    if (typeof value[key] === 'string' && value[key].trim() && value[key].length <= 160) reply[key] = value[key];
    else if (key === 'proposalId' && ['accept','reject'].includes(reply.action)) throw new DiscussionFormatError('收尾确认缺少有效的提议关联。');
    else warn(`已忽略无效的 ${key} 关联`);
  }
  if (value.questions !== undefined) {
    reply.questions = [];
    if (!Array.isArray(value.questions) || value.questions.length > 8) { warn('待答问题格式或数量无效，需要再次核对'); reply.reviewQuestions = true; }
    if (Array.isArray(value.questions)) for (const q of value.questions.slice(0,8)) {
      if (q && typeof q.to === 'string' && q.to.trim() && q.to.length <= 160 && typeof q.text === 'string' && q.text.trim() && q.text.length <= 2000) reply.questions.push({to:q.to,text:q.text.trim()});
      else { warn('已忽略无法识别的待答问题，需要再次核对'); reply.reviewQuestions = true; }
    }
  }
  if (value.answers !== undefined) {
    if (!Array.isArray(value.answers) || value.answers.length > 64) warn('已忽略无效或超量的回答关联');
    reply.answers = Array.isArray(value.answers) ? [...new Set(value.answers.slice(0,64).filter((id:unknown):id is string => typeof id === 'string' && id.length > 0 && id.length <= 160))] : [];
    if (Array.isArray(value.answers) && reply.answers.length !== value.answers.length) warn('已忽略无效或重复的回答关联');
  }
  return reply;
}

/** Explicit obligations win; otherwise personality, relevance and time since speaking weight the draw. */
export function requiredDiscussionSpeaker(d: RoomDiscussion): string | undefined {
  const eligible=(id:string)=>d.members.includes(id)&&!d.stoppedMembers?.includes(id)&&!d.skippedMembers?.[id];
  if(d.style!=='chat'&&d.meetingRound){if(d.phase==='talking')return d.meetingRound.pending.find(eligible)??d.priority.find(eligible);if(d.phase==='closing'&&d.proposal)return d.members.find(id=>eligible(id)&&!d.proposal!.accepted.includes(id)&&!d.proposal!.skipped?.includes(id));}
  return d.priority.find(eligible) ?? d.questions.find(q => pendingDiscussionQuestion(q) && eligible(q.to))?.to ?? d.reviewRequired.find(eligible) ??
    (d.phase === 'closing' && d.proposal ? d.members.find(id => eligible(id)&&!d.proposal!.accepted.includes(id)&&!d.proposal!.skipped?.includes(id)) : undefined);
}
export function nextDiscussionSpeaker(d: RoomDiscussion, profiles: Pick<MemberProfile,'id'|'talkativeness'>[] = [], random: () => number = Math.random, quotas:Record<string,number>={}): string {
  const directed = requiredDiscussionSpeaker(d);
  if (directed) return directed;
  if(d.style!=='chat'&&d.meetingRound){const from=d.meetingCursor?d.members.indexOf(d.meetingCursor):-1;return [...d.members.slice(from+1),...d.members.slice(0,from+1)].find(id=>(quotas[id]??1)>0&&!d.stoppedMembers?.includes(id)&&!d.skippedMembers?.[id])??'';}
  const last = [...d.members].sort((a,b) => (d.lastSpoke[b] ?? -1) - (d.lastSpoke[a] ?? -1))[0];
  const available=d.members.filter(id=>(quotas[id]??1)>0&&!d.stoppedMembers?.includes(id)&&!d.skippedMembers?.[id]);
  let candidates = available.filter(id => !d.passed?.includes(id));
  if (!candidates.length) candidates = available;
  // A meeting goes round the table: whoever has waited longest, in seating order. Being handed the word only breaks a tie,
  // so two members passing it back and forth cannot skip the others; a direct question still goes first (above).
  if (d.style !== 'chat' && candidates.length) {
    const waited = (id:string) => d.lastSpoke[id] ?? -1;
    return candidates.reduce((best,id) => waited(id) < waited(best) || waited(id) === waited(best) && id === d.handoff ? id : best);
  }
  if (candidates.length > 1 && d.lastSpoke[last] !== undefined) candidates = candidates.filter(id => id !== last);
  const weighted = candidates.map(id => {
    const preference = profiles.find(p => p.id === id)?.talkativeness ?? 'normal';
    const personality = preference === 'quiet' ? 0.6 : preference === 'chatty' ? 1.6 : 1;
    const age = Math.max(1, d.calls - (d.lastSpoke[id] ?? -1));
    const relevance = d.handoff === id ? 3 : d.relevant?.includes(id) ? 1.8 : 1;
    return { id, weight: personality * (1 + Math.sqrt(age)) * relevance * (quotas[id]??1) };
  });
  const value = random(), unit = Number.isFinite(value) ? Math.max(0,Math.min(1-Number.EPSILON,value)) : 0;
  let draw = unit * weighted.reduce((sum,p) => sum+p.weight,0);
  for (const item of weighted) { draw -= item.weight; if (draw < 0) return item.id; }
  return weighted.at(-1)?.id ?? '';
}

export function parseHandVote(text: string): HandVote {
  let value: any; try { value = discussionObject(text); } catch { throw new Error('举手回复格式无效，本次意愿未采用。'); }
  if (!value || Array.isArray(value) ||
    !Number.isInteger(value.want) || value.want < 0 || value.want > 3 || typeof value.why !== 'string' || !value.why.trim() || value.why.length > 200) throw new Error('举手意愿须为 0–3，理由须为一句简短文字。');
  return { want: value.want, why: value.why.trim() };
}

/** Hand votes only choose a speaker; they carry no authority to answer questions or end the topic. */
export function chooseHandSpeaker(d: RoomDiscussion, votes: Record<string, HandBallot>, profiles: Pick<MemberProfile,'id'|'talkativeness'>[] = [], random: () => number = Math.random, quotas:Record<string,number>={}) {
  const eligible=d.members.filter(id => !['failed','stopped'].includes(votes[id]?.status)&&(quotas[id]??1)>0);
  if(!eligible.length)return {selected:undefined,fallback:true};
  const score=(id:string)=>votes[id]?.status==='done'?(votes[id].want??0)*(quotas[id]??1):0;
  const highest = Math.max(0,...eligible.map(score));
  const candidates = highest ? eligible.filter(id => score(id)===highest) : eligible;
  const selection = { ...d, ...(highest ? {style:'chat' as const} : {}), priority: [], questions: [], reviewRequired: [], passed: [...d.members.filter(id => !candidates.includes(id)),...(highest?[]:(d.passed??[]).filter(id=>candidates.includes(id)))], handoff: highest?undefined:d.handoff };
  // A normal pass cannot put every eligible member back behind failed votes.
  if(candidates.every(id=>selection.passed.includes(id)))selection.passed=d.members.filter(id=>!candidates.includes(id));
  return { selected: nextDiscussionSpeaker(selection,profiles,random,quotas), fallback: highest === 0 };
}

// Only standalone direct commands count; quotes, questions and examples stay ordinary chat.
export function discussionCommand(text: string): 'pause' | 'resume' | undefined {
  const phrase = text.trim().replace(/[。！!]+$/u, '');
  if (/^(?:先停一停|先停一下|先别聊了|暂停讨论|暂停自由讨论|停止讨论|别聊了|你们先停一下)$/.test(phrase)) return 'pause';
  if (/^(?:继续讨论|继续聊吧|接着聊|恢复讨论|恢复自由讨论)$/.test(phrase)) return 'resume';
}

/** A direct human instruction to wait after this response round; quoted examples carry no control. */
export function waitAfterMeetingRound(text:string){
  const direct=text.replace(/```[\s\S]*?```|“[^”]*”|「[^」]*」|"(?:\\.|[^"\\])*"/g,'');
  return /(?:这|本)轮(?:答|回答|发言)完(?:后)?[，,\s]*(?:先)?(?:等|等待)我(?:的)?(?:下一条|下一个)(?:问题|消息|提问)/u.test(direct)||/\bafter (?:this|the) round[,\s]+wait for my next (?:question|message)\b/i.test(direct);
}
