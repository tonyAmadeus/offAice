import { useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { File as FileIcon, FileText, FolderOpen, LoaderCircle, Plus, X } from 'lucide-react';
import type { Attachment } from '../shared/types';
import { ATTACHMENTS_MAX, ATTACHMENT_MAX_BYTES, IMAGE_SEND_MAX, sizeText } from '../shared/attachments';
import type { Invoke } from './ui';

/** Attached images are served from AIROOM's own store by id and stored name. */
export const attachmentUrl = (item: Pick<Attachment, 'id' | 'name'>) => `airoom-asset://local/attachments/${item.id}/${encodeURIComponent(item.name)}`;

/** Files waiting to go with the next message: picked with "+", or dropped onto the composer. */
export function useAttachments(invoke: Invoke, initial: Attachment[] = [],controlled?:{items:Attachment[];update:(change:(previous:Attachment[])=>Attachment[])=>void}) {
  // A count, not a flag: overlapping picks, drops and pastes each keep the composer busy until the last one finishes.
  const [localItems, setLocalItems] = useState<Attachment[]>(initial), [pending, setPending] = useState(0), [dragging, setDragging] = useState(false);
  const busy = pending > 0, reserved = useRef(0);
  const items=controlled?.items??localItems,setItems=controlled?.update??setLocalItems;
  const add = (added: Attachment[] | undefined) => { if (added?.length) setItems(previous => [...previous, ...added.filter(item => !previous.some(old => old.id === item.id))].slice(0, ATTACHMENTS_MAX)); };
  async function run(task: () => Promise<Attachment[] | undefined>) { setPending(count => count + 1); try { add(await task()); } catch {} finally { setPending(count => count - 1); } }
  const pick = () => run(() => invoke<Attachment[]>('attachment.pick'));
  async function drop(event: DragEvent) {
    setDragging(false);
    const files = [...event.dataTransfer.files];
    if (!files.length) return;
    event.preventDefault();
    const paths = files.map(file => window.airoom?.pathForFile?.(file) ?? '').filter(Boolean);
    if (!paths.length) return;
    await run(() => invoke<Attachment[]>('attachment.import', { paths }));
  }
  /** Images pasted into the message box. Never cancels the native paste, so any text copied with the image still lands. */
  function paste(event: ClipboardEvent) {
    // Some sources list the pasted file only under items, not files.
    const files = [...event.clipboardData.files];
    if (!files.length) for (const item of event.clipboardData.items) { const file = item.kind === 'file' ? item.getAsFile() : null; if (file) files.push(file); }
    const pictures = files.filter(file => file.type.startsWith('image/')), images = pictures.filter(file => PASTE_TYPES.has(file.type));
    const notes: string[] = [];
    if (images.length < pictures.length) notes.push('只能贴上 PNG、JPEG、WebP 或 GIF 图片，其他格式没有附上。');
    // Count slots already promised to pastes still importing, so two quick pastes cannot both claim the last one.
    const room = ATTACHMENTS_MAX - items.length - reserved.current;
    const fitting = images.filter(file => file.size > 0 && file.size <= ATTACHMENT_MAX_BYTES);
    if (images.some(file => file.size === 0)) notes.push('有图片是空的，没有附上。');
    if (images.some(file => file.size > ATTACHMENT_MAX_BYTES)) notes.push(`有图片超过 ${sizeText(ATTACHMENT_MAX_BYTES)}，没有附上。`);
    const taken = fitting.slice(0, Math.max(room, 0));
    if (taken.length < fitting.length) notes.push(`附件最多 ${ATTACHMENTS_MAX} 个，多出的图片没有附上。`);
    if (taken.some(file => file.size > IMAGE_SEND_MAX)) notes.push(`超过 ${sizeText(IMAGE_SEND_MAX)} 的图片会附上，但成员看不到图片内容，只会收到文字说明。`);
    if (notes.length) window.alert(notes.join('\n'));
    // One image per request, read only when its turn comes, so at most one image is held in memory at a time.
    reserved.current += taken.length;
    void (async () => { for (const file of taken) await run(async () => {
      try {
        let data: string;
        try { data = await base64(file); } catch { window.alert('读取贴上的图片失败，请再试一次。'); return []; }
        return await invoke<Attachment[]>('attachment.importPasted', { images: [{ type: file.type, data }] });
      } finally { reserved.current -= 1; }
    }); })();
  }
  const dropTarget = {
    onDragOver: (event: DragEvent) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragging(true); } },
    onDragLeave: () => setDragging(false),
    onDrop: (event: DragEvent) => void drop(event),
  };
  return { items, busy, dragging, pick, paste, dropTarget, remove: (id: string) => setItems(previous => previous.filter(item => item.id !== id)), clear: () => setItems(() => []) };
}

const PASTE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const base64 = (file: Blob) => new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, '')); reader.onerror = () => reject(reader.error); reader.onabort = () => reject(new Error('aborted')); reader.readAsDataURL(file); });

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
