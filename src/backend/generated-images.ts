import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { GeneratedImage } from '../shared/types';
import { ATTACHMENT_MAX_BYTES } from '../shared/attachments';
import { attachmentPath } from './attachments';

export const GENERATED_IMAGE_MAX_BYTES = ATTACHMENT_MAX_BYTES;
export const GENERATED_IMAGES_MAX = 10;

/** Accept native image bytes, never a model-supplied file path or URL. */
export function storeGeneratedImage(dataDirectory: string, value: unknown): GeneratedImage {
  const item = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (typeof item.nativeItemId !== 'string' || !item.nativeItemId || item.nativeItemId.length > 256 ||
      typeof item.nativeTurnId !== 'string' || !item.nativeTurnId || item.nativeTurnId.length > 256) throw new Error('生成图片缺少本轮的编号。');
  if (typeof item.result !== 'string' || !item.result) throw new Error('Codex 没有返回图片内容。');
  // Bound the string before allocating a decoded buffer; Buffer.from alone silently accepts invalid base64.
  if (item.result.length > Math.ceil(GENERATED_IMAGE_MAX_BYTES / 3) * 4) throw new Error('生成的图片超过 20 MB，未保存。');
  const encoded = item.result.trim();
  if (!encoded || encoded.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('生成图片的内容格式不完整，未保存。');
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > GENERATED_IMAGE_MAX_BYTES || bytes.toString('base64') !== encoded) throw new Error('生成图片的内容格式不完整，未保存。');
  const type = bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString('ascii',12,16)==='IHDR'
    ? { extension:'png', mime:'image/png' }
    : bytes.length >= 4 && bytes[0]===255 && bytes[1]===216 && bytes[2]===255 && bytes.at(-2)===255 && bytes.at(-1)===217
    ? { extension:'jpg', mime:'image/jpeg' }
    : bytes.length >= 16 && bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WEBP'
    ? { extension:'webp', mime:'image/webp' } : undefined;
  if (!type) throw new Error('返回的内容不是支持的 PNG、JPG 或 WebP 图片，未保存。');
  const image: GeneratedImage = {
    id:randomUUID(), name:`AIROOM-图片.${type.extension}`, kind:'image', mime:type.mime, size:bytes.length,
    nativeItemId:item.nativeItemId, nativeTurnId:item.nativeTurnId, generatedAt:new Date().toISOString(),
    ...(typeof item.revisedPrompt==='string'?{revisedPrompt:item.revisedPrompt.slice(0,20000)}:{}),
    ...(typeof item.transparentBackground==='boolean'?{transparentBackground:item.transparentBackground}:{}),
  };
  mkdirSync(path.join(dataDirectory,'attachments',image.id),{recursive:true});
  writeFileSync(attachmentPath(dataDirectory,image),bytes,{flag:'wx'});
  return image;
}
