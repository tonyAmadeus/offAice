import type {Attachment,RoomId} from './types';

/** A thread belongs to one room and, for desks, one folder. No draft can move between them. */
export interface ComposerScope {roomId:RoomId;threadId:string;restoreEpoch?:string}
export interface ComposerDraft {text:string;attachments:Attachment[];replyTo?:string;workIntent?:'ask'|'add'|'supplement'}
export interface ComposerDraftRecord extends ComposerScope {id:string;value:ComposerDraft;updatedAt:string}
export const composerDraftId=(scope:ComposerScope)=>JSON.stringify([scope.roomId,scope.threadId]);
export const emptyComposerDraft=():ComposerDraft=>({text:'',attachments:[]});
export const hasComposerDraft=(value:ComposerDraft)=>Boolean(value.text||value.attachments.length||value.replyTo||value.workIntent&&value.workIntent!=='ask');

/** Remove a confirmed submission while preserving edits made before its receipt arrived. */
export function remainingComposerDraft(current:ComposerDraft,sent:ComposerDraft):ComposerDraft{
  const prefix=current.text.startsWith(sent.text)?sent.text:sent.text.trim();
  const text=prefix&&current.text.startsWith(prefix)?current.text.slice(prefix.length):current.text;
  const sentIds=new Set(sent.attachments.map(item=>item.id));
  return {...current,text,attachments:current.attachments.filter(item=>!sentIds.has(item.id)),
    replyTo:current.replyTo===sent.replyTo?undefined:current.replyTo,
    workIntent:current.workIntent===sent.workIntent?undefined:current.workIntent};
}
