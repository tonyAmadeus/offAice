import { useState, type DragEvent } from 'react';
import { File as FileIcon, FileText, FolderOpen, LoaderCircle, Plus, X } from 'lucide-react';
import type { Attachment } from '../shared/types';
import { ATTACHMENTS_MAX, sizeText } from '../shared/attachments';
import type { Invoke } from './ui';

/** Attached images are served from AIROOM's own store by id and stored name. */
export const attachmentUrl = (item: Pick<Attachment, 'id' | 'name'>) => `airoom-asset://local/attachments/${item.id}/${encodeURIComponent(item.name)}`;

/** Files waiting to go with the next message: picked with "+", or dropped onto the composer. */
export function useAttachments(invoke: Invoke, initial: Attachment[] = [],controlled?:{items:Attachment[];update:(change:(previous:Attachment[])=>Attachment[])=>void}) {
  const [localItems, setLocalItems] = useState<Attachment[]>(initial), [busy, setBusy] = useState(false), [dragging, setDragging] = useState(false);
  const items=controlled?.items??localItems,setItems=controlled?.update??setLocalItems;
  const add = (added: Attachment[] | undefined) => { if (added?.length) setItems(previous => [...previous, ...added.filter(item => !previous.some(old => old.id === item.id))].slice(0, ATTACHMENTS_MAX)); };
  async function pick() { setBusy(true); try { add(await invoke<Attachment[]>('attachment.pick')); } catch {} finally { setBusy(false); } }
  async function drop(event: DragEvent) {
    setDragging(false);
    const files = [...event.dataTransfer.files];
    if (!files.length) return;
    event.preventDefault();
    const paths = files.map(file => window.airoom?.pathForFile?.(file) ?? '').filter(Boolean);
    if (!paths.length) return;
    setBusy(true); try { add(await invoke<Attachment[]>('attachment.import', { paths })); } catch {} finally { setBusy(false); }
  }
  const dropTarget = {
    onDragOver: (event: DragEvent) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragging(true); } },
    onDragLeave: () => setDragging(false),
    onDrop: (event: DragEvent) => void drop(event),
  };
  return { items, busy, dragging, pick, dropTarget, remove: (id: string) => setItems(previous => previous.filter(item => item.id !== id)), clear: () => setItems(() => []) };
}

export function AttachButton({ onPick, busy, disabled, title = '添加图片或文件（也可以直接拖进来）' }: { onPick: () => void; busy: boolean; disabled?: boolean; title?: string }) {
  return <button type="button" className="icon-button attach-button" aria-label="添加图片或文件" title={title} disabled={busy || disabled} onClick={onPick}>{busy ? <LoaderCircle size={16} className="spin" /> : <Plus size={17} />}</button>;
}

const kindIcon = (item: Attachment) => item.kind === 'text' ? <FileText size={16} /> : <FileIcon size={16} />;

/** The files about to be sent, each removable. */
export function AttachmentTray({ items, onRemove }: { items: Attachment[]; onRemove: (id: string) => void }) {
  if (!items.length) return null;
  return <div className="attachment-tray" aria-label="待发送的附件">{items.map(item => <span className="attachment-chip" key={item.id}>
    {item.kind === 'image' ? <img src={attachmentUrl(item)} alt="" /> : <span className="attachment-icon">{kindIcon(item)}</span>}
    <span className="attachment-meta"><strong title={item.name}>{item.name}</strong><small>{sizeText(item.size)}</small></span>
    <button type="button" aria-label={`移除附件 ${item.name}`} onClick={() => onRemove(item.id)}><X size={12} /></button>
  </span>)}</div>;
}

/** Files on a sent message: pictures shown, other files named; either can be shown in Explorer. */
export function AttachmentList({ items, invoke, align = 'start' }: { items?: Attachment[]; invoke: Invoke; align?: 'start' | 'end' }) {
  if (!items?.length) return null;
  const reveal = (item: Attachment) => void invoke('attachment.reveal', { id: item.id, name: item.name }).catch(() => {});
  return <div className={`attachment-list ${align}`}>{items.map(item => item.kind === 'image'
    ? <button type="button" key={item.id} className="attachment-image" title={`${item.name} · 在文件夹中显示`} onClick={() => reveal(item)}><img src={attachmentUrl(item)} alt={item.name} /></button>
    : <span key={item.id} className="attachment-chip sent"><span className="attachment-icon">{kindIcon(item)}</span><span className="attachment-meta"><strong title={item.name}>{item.name}</strong><small>{sizeText(item.size)}</small></span>
      <button type="button" aria-label={`在文件夹中显示 ${item.name}`} title="在文件夹中显示" onClick={() => reveal(item)}><FolderOpen size={13} /></button></span>)}</div>;
}
