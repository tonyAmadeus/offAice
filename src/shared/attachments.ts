import type { Attachment } from './types';

export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
export const ATTACHMENTS_MAX = 10;
/** Text files are given to members inline up to this size each, and this much in one turn. */
export const TEXT_INLINE_MAX = 30_000, TEXT_INLINE_TOTAL = 60_000;
/** Images larger than this are not sent as pictures (the models' own limit is around 5 MB). */
export const IMAGE_SEND_MAX = 5 * 1024 * 1024;

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'json', 'jsonl', 'csv', 'tsv', 'log', 'yaml', 'yml', 'xml', 'html', 'htm', 'css', 'scss', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'swift', 'sh', 'ps1', 'bat', 'cmd', 'ini', 'toml', 'cfg', 'conf', 'sql', 'vue', 'svelte', 'lua', 'r', 'tex', 'srt']);

export const extensionOf = (name: string) => (/\.([^.\\/]+)$/.exec(name)?.[1] ?? '').toLowerCase();
export function attachmentKind(name: string): Attachment['kind'] {
  const extension = extensionOf(name);
  return IMAGE_TYPES[extension] ? 'image' : TEXT_EXTENSIONS.has(extension) ? 'text' : 'file';
}
export const attachmentMime = (name: string) => IMAGE_TYPES[extensionOf(name)] ?? (attachmentKind(name) === 'text' ? 'text/plain' : 'application/octet-stream');
/** A stored copy is named by a random id and the original's base name, minus anything unsafe for a path. */
export const isAttachmentId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
export function safeAttachmentName(name: string) {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim().slice(0, 120);
  return cleaned || 'file';
}
export function sizeText(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
