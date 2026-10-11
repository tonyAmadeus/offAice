import type {RoomMessage} from '../shared/types';
import {composerDraftId,hasComposerDraft,type ComposerScope,type ComposerDraft,type ComposerDraftRecord} from '../shared/composer-draft';
import {resolveAttachments,withoutPath} from './attachments';
import type {Store} from './store';

/** Drafts are local records only: saving and restoring never schedules a member. */
export class ComposerDrafts {
  constructor(private store:Store){}
  private scope(params:ComposerScope):ComposerScope{
    if((params.restoreEpoch??'')!==(this.store.get<{at:string}>('restore_info','main')?.at??''))throw new Error('本机资料已恢复，请刷新后再保存草稿。');
    const roomId=this.store.validateRoomId(params.roomId),threadId=String(params.threadId??'');
    this.store.roomThread(threadId,roomId);
    return {roomId,threadId};
  }
  get(params:ComposerScope){
    const scope=this.scope(params);
    return this.store.get<ComposerDraftRecord>('composer_drafts',composerDraftId(scope))?.value??null;
  }
  save(params:ComposerScope&{value:ComposerDraft}){
    const scope=this.scope(params),id=composerDraftId(scope),input=params.value;
    if(!input||typeof input.text!=='string'||input.text.length>200000)throw new Error('草稿内容无效或过长');
    const attachments=resolveAttachments(this.store.dataDirectory,input.attachments).map(withoutPath);
    const reply=input.replyTo?this.store.get<RoomMessage>('room_messages',String(input.replyTo)):undefined;
    const value:ComposerDraft={text:input.text,attachments,...(reply?.threadId===scope.threadId&&(reply.roomId??'global')===scope.roomId?{replyTo:reply.id}:{}),...(['ask','add','supplement'].includes(input.workIntent??'')?{workIntent:input.workIntent}:{})};
    const old=this.store.get<ComposerDraftRecord>('composer_drafts',id);
    if(hasComposerDraft(value))this.store.put('composer_drafts',id,{...scope,id,value,updatedAt:new Date().toISOString()} satisfies ComposerDraftRecord);
    else this.store.delete('composer_drafts',id);
    return {saved:true,released:old?.value.attachments.filter(item=>!attachments.some(next=>next.id===item.id)).map(item=>item.id)??[]};
  }
}
