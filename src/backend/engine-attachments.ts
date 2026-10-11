import type { MemberProfile, RoomMessage, Run } from '../shared/types';
import { ATTACHMENTS_MAX, IMAGE_SEND_MAX } from '../shared/attachments';
import { describeAttachments, pruneAttachments, resolveAttachments, withoutPath, type StoredAttachment } from './attachments';
import type { Store } from './store';
import type {ComposerDraftRecord} from '../shared/composer-draft';

/** Material collection and attachment lifetime, separate from room scheduling. */
export class EngineAttachments {
  constructor(private store:Store,private acceptsImages:(provider:string)=>boolean){}

  room(member:MemberProfile,messages:RoomMessage[]){
    const unique=new Map(messages.flatMap(message=>[...message.attachments??[],...message.generatedImages??[]]).map(item=>[item.id,item]));
    const files:StoredAttachment[]=[...unique.values()].flatMap(item=>resolveAttachments(this.store.dataDirectory,[item]));
    const seesImages=this.acceptsImages(member.executor);
    // History can contain many files; bound pictures and describe each omitted one.
    const images=seesImages?files.filter(item=>item.kind==='image'&&item.size<=IMAGE_SEND_MAX).slice(-ATTACHMENTS_MAX).map(withoutPath):[];
    return {text:describeAttachments(files,{images:seesImages,paths:false,source:'room',imageIds:new Set(images.map(item=>item.id))}),images};
  }

  release(ids?:Iterable<string>){
    try{
      const referenced=new Set<string>();
      for(const draft of this.store.list<ComposerDraftRecord>('composer_drafts'))for(const item of draft.value.attachments)referenced.add(item.id);
      for(const message of this.store.list<RoomMessage>('room_messages'))for(const item of [...message.attachments??[],...message.generatedImages??[]])referenced.add(item.id);
      for(const run of this.store.list<Run>('runs'))for(const item of [...run.attachments??[],...run.generatedImages??[]])referenced.add(item.id);
      pruneAttachments(this.store.dataDirectory,referenced,ids?{only:ids}:{});
    }catch{/* Cleanup must never block the operation that released the files. */}
  }
}
