import { useState } from 'react';
import { Download, FolderOpen, ImagePlus, LoaderCircle } from 'lucide-react';
import type { Attachment, GeneratedImage, Snapshot } from '../shared/types';
import { IMAGE_SEND_MAX } from '../shared/attachments';
import { AttachButton, AttachmentTray, attachmentUrl, useAttachments } from './attachments';
import { Modal } from './modals';
import { useTeam } from './members';
import type { Invoke } from './ui';

export function GeneratedImages({ images, invoke, onEdit }: { images?: GeneratedImage[]; invoke: Invoke; onEdit?: (image:GeneratedImage)=>void }) {
  const [preview,setPreview]=useState<GeneratedImage>(),[saved,setSaved]=useState<string>();
  if(!images?.length)return null;
  const save=(image:GeneratedImage)=>void invoke<{saved:boolean}>('attachment.save',{id:image.id,name:image.name}).then(result=>{if(result.saved)setSaved(image.id);}).catch(()=>{});
  return <div className="generated-images" aria-label="生成的图片">{images.map(image=><div className="generated-image" key={image.id}>
    <button type="button" className="generated-image-preview" aria-label="查看生成图片大图" onClick={()=>setPreview(image)}><img src={attachmentUrl(image)} alt="生成的图片" loading="lazy" /></button>
    <div className="generated-image-actions"><button type="button" className="link-button" onClick={()=>save(image)}><Download size={13}/>{saved===image.id?'已保存':'保存图片'}</button><button type="button" className="link-button" onClick={()=>void invoke('attachment.reveal',{id:image.id,name:image.name}).catch(()=>{})}><FolderOpen size={13}/>查看位置</button>{onEdit&&<button type="button" className="link-button" onClick={()=>onEdit(image)}><ImagePlus size={13}/>修改这张图</button>}</div>
  </div>)}{preview&&<Modal title="图片预览" onClose={()=>setPreview(undefined)} className="generated-image-modal"><div className="generated-image-full"><img src={attachmentUrl(preview)} alt="生成的图片大图"/></div><footer className="modal-footer"><button type="button" className="primary-button" onClick={()=>save(preview)}><Download size={14}/>保存图片</button></footer></Modal>}</div>;
}

/** The explicit button is the permission to generate; ordinary/automatic room speech stays text-only. */
export function ImageGenerationDialog({snapshot,invoke,text,attachments,onClose,onSent}:{snapshot:Snapshot;invoke:Invoke;text:string;attachments:Attachment[];onClose:()=>void;onSent:()=>void}){
  const team=useTeam(),members=team.members.filter(member=>member.executor==='codex');
  const [description,setDescription]=useState(text),[memberId,setMemberId]=useState(members[0]?.id??''),[sending,setSending]=useState(false);
  const attach=useAttachments(invoke,attachments);
  const provider=snapshot.providers.find(info=>info.id==='codex');
  const invalid=attach.items.some(file=>file.kind!=='image'||file.size>IMAGE_SEND_MAX);
  const available=snapshot.backendReady&&provider?.available&&provider.auth==='subscription'&&provider.capabilities.imageGeneration===true;
  async function generate(){
    if(!description.trim()||sending||invalid||!available)return;
    const sessionIds=new Set(snapshot.sessions.filter(session=>session.purpose==='room-image'&&(session.memberId??session.provider)===memberId).map(session=>session.id));
    const uncertain=snapshot.runs.some(run=>sessionIds.has(run.sessionId)&&(run.status==='unknown'||run.delivery==='unknown')&&!run.imageGenerationAcknowledgedAt);
    if(uncertain&&!window.confirm('上次图片请求的结果未知。请先核对聊天内容和活动记录。确认后将发送这次新请求，不会重发上次请求。'))return;
    setSending(true);
    try{await invoke('room.generateImage',{text:description.trim(),memberId,attachments:attach.items,acknowledgeUnknown:uncertain});onSent();}catch{}finally{setSending(false);}
  }
  return <Modal title="生成图片" subtitle="使用 Codex 额度，一次生成一张。生成后会显示在当前聊天里。" onClose={()=>{if(!sending)onClose();}}>
    <div className="modal-body image-generation-form">
      <label>绘图成员<select aria-label="绘图成员" value={memberId} onChange={event=>setMemberId(event.target.value)} disabled={sending}>{members.map(member=><option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
      <label>画面描述<textarea aria-label="画面描述" autoFocus rows={5} maxLength={20000} value={description} onChange={event=>setDescription(event.target.value)} placeholder="例如：画一只坐在窗边喝茶的小猫，温暖的水彩风格。也可以附上图片，说明想修改什么。" disabled={sending}/></label>
      <div className={`image-generation-references ${attach.dragging?'dragging':''}`} {...attach.dropTarget}><AttachButton onPick={()=>void attach.pick()} busy={attach.busy} disabled={sending} title="添加参考图片"/><span>可添加或拖入参考图片（每张不超过 5 MB）</span><AttachmentTray items={attach.items} onRemove={attach.remove}/></div>
      {invalid&&<p className="room-error" role="alert">请移除非图片附件或超过 5 MB 的图片。</p>}
      {!available&&<p role="alert">请先连接支持绘图的新版 Codex。</p>}
    </div>
    <footer className="modal-footer"><button type="button" className="secondary-button" onClick={onClose} disabled={sending}>取消</button><button type="button" className="primary-button" onClick={()=>void generate()} disabled={!available||!memberId||!description.trim()||invalid||attach.busy||sending||snapshot.room.state.active}>{sending?<LoaderCircle size={15} className="spin"/>:<ImagePlus size={15}/>}开始生成</button></footer>
  </Modal>;
}
