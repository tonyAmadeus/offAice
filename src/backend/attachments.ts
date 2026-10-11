import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Attachment } from '../shared/types';
import { ATTACHMENTS_MAX, ATTACHMENT_MAX_BYTES, IMAGE_SEND_MAX, TEXT_INLINE_MAX, TEXT_INLINE_TOTAL, attachmentKind, attachmentMime, isAttachmentId, safeAttachmentName, sizeText } from '../shared/attachments';

export type StoredAttachment = Attachment & { path: string };
export const attachmentPath = (dataDirectory: string, attachment: Pick<Attachment, 'id' | 'name'>) => path.join(dataDirectory, 'attachments', attachment.id, attachment.name);

/** Copy files the user picked or dropped into AIROOM's own store; the originals are never changed. */
export function importAttachments(dataDirectory: string, value: unknown): Attachment[] {
  const sources = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && path.isAbsolute(item)) : [];
  if (!sources.length) throw new Error('没有收到可以附上的文件');
  if (sources.length > ATTACHMENTS_MAX) throw new Error(`一次最多附 ${ATTACHMENTS_MAX} 个文件`);
  const checked = sources.map(source => {
    let info;
    try { info = statSync(source); } catch { throw new Error(`找不到文件：${path.basename(source)}`); }
    if (!info.isFile()) throw new Error(`「${path.basename(source)}」不是文件，文件夹不能直接附上`);
    if (info.size > ATTACHMENT_MAX_BYTES) throw new Error(`「${path.basename(source)}」超过 ${sizeText(ATTACHMENT_MAX_BYTES)}，请换一个小一些的文件`);
    return { source, size: info.size };
  });
  return checked.map(({ source, size }) => {
    const id = randomUUID(), name = safeAttachmentName(path.basename(source));
    mkdirSync(path.join(dataDirectory, 'attachments', id), { recursive: true });
    copyFileSync(source, attachmentPath(dataDirectory, { id, name }));
    return { id, name, kind: attachmentKind(name), mime: attachmentMime(name), size };
  });
}

/** Accept attachment records from the renderer: only copies already in the store; kind and size come from disk. */
export function resolveAttachments(dataDirectory: string, value: unknown): StoredAttachment[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('附件格式无效');
  if (value.length > ATTACHMENTS_MAX) throw new Error(`一次最多附 ${ATTACHMENTS_MAX} 个文件`);
  const seen = new Set<string>();
  return value.flatMap(item => {
    const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const id = record.id, name = typeof record.name === 'string' ? record.name : '';
    if (!isAttachmentId(id) || !name || safeAttachmentName(name) !== name) throw new Error('附件无效，请重新添加');
    if (seen.has(id)) return [];
    seen.add(id);
    const file = attachmentPath(dataDirectory, { id, name });
    let size: number;
    try { const info = statSync(file); if (!info.isFile()) throw new Error(); size = info.size; } catch { throw new Error(`附件「${name}」已不存在，请重新添加`); }
    return [{ id, name, kind: attachmentKind(name), mime: attachmentMime(name), size, path: file }];
  });
}
/** Remove stored copies no message or turn refers to. `only` limits it to ids just released; otherwise
 *  copies younger than `graceMs` stay, since they may still be waiting in a composer. */
export function pruneAttachments(dataDirectory: string, referenced: Set<string>, options: { only?: Iterable<string>; graceMs?: number; now?: number } = {}): number {
  const root = path.join(dataDirectory, 'attachments');
  let ids: string[];
  try { ids = options.only ? [...new Set(options.only)] : readdirSync(root); } catch { return 0; }
  let removed = 0;
  for (const id of ids) {
    if (!isAttachmentId(id) || referenced.has(id)) continue;
    const directory = path.join(root, id);
    try {
      if (!options.only && (options.now ?? Date.now()) - statSync(directory).mtimeMs < (options.graceMs ?? 24 * 3600_000)) continue;
      rmSync(directory, { recursive: true, force: true }); removed++;
    } catch { /* Already gone, or in use: the next sweep retries. */ }
  }
  return removed;
}
export const withoutPath = ({ path: _path, ...attachment }: StoredAttachment): Attachment => attachment;

function readInlineText(attachment: StoredAttachment): string | undefined {
  if (attachment.size > TEXT_INLINE_MAX) return undefined;
  let buffer: Buffer;
  try { buffer = readFileSync(attachment.path); } catch { return undefined; }
  if (buffer.includes(0)) return undefined;
  return buffer.toString('utf8').replace(/^﻿/, '');
}

/** What a member is told about the files: text inline within limits, images as pictures or an honest note, others by path. */
export function describeAttachments(attachments: StoredAttachment[], options: { images: boolean; paths: boolean; imageIds?: ReadonlySet<string>; source?: 'room' }): string {
  if (!attachments.length) return '';
  const lines: string[] = [], blocks: string[] = [];
  let inlined = 0;
  for (const item of attachments) {
    const where = options.paths ? `：${item.path}` : '';
    if (item.kind === 'image') {
      if (!options.images) lines.push(`- ${item.name}（图片）：你当前的程序收不到图片内容，不要猜测图里有什么；需要时请用户描述。${where}`);
      else if (item.size > IMAGE_SEND_MAX) lines.push(`- ${item.name}（图片，${sizeText(item.size)}，太大没有附上）${where}`);
      else if (options.imageIds && !options.imageIds.has(item.id)) lines.push(`- ${item.name}（图片，本轮图片数量已达上限，没有附上）：不要猜测图里有什么，需要时请用户单独发送。`);
      else lines.push(`- ${item.name}（图片，已随消息附上）`);
      continue;
    }
    const text = item.kind === 'text' && inlined + item.size <= TEXT_INLINE_TOTAL ? readInlineText(item) : undefined;
    if (text !== undefined) {
      inlined += item.size;
      lines.push(`- ${item.name}（文本，内容在下方）`);
      blocks.push(`#### ${item.name}\n\`\`\`\n${text}\n\`\`\``);
    } else if (options.paths) lines.push(`- ${item.name}（${sizeText(item.size)}${item.kind === 'text' ? '，内容较长' : ''}）${where}`);
    else lines.push(`- ${item.name}（${sizeText(item.size)}）：聊天室里无法打开这个文件，需要时请用户说明内容。`);
  }
  return `[${options.source==='room'?'聊天室图片与文件':'用户附上的文件'}]\n${lines.join('\n')}${blocks.length ? `\n\n${blocks.join('\n\n')}` : ''}`;
}
