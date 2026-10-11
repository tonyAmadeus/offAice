import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import type { AdapterContext } from '../../shared/types';
import { IMAGE_SEND_MAX } from '../../shared/attachments';

/** Recheck stored copies before delivery; a missing picture must not be described as attached. */
function images(context: AdapterContext) {
  return (context.attachments ?? []).filter(item => item.kind === 'image' && item.size <= IMAGE_SEND_MAX).map(item => {
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(item.mime)) throw new Error(`图片「${item.name}」的格式不受支持，请重新添加。`);
    try {
      const info = statSync(item.path);
      if (!info.isFile() || info.size !== item.size || info.size > IMAGE_SEND_MAX) throw new Error();
      accessSync(item.path, constants.R_OK);
    } catch { throw new Error(`图片「${item.name}」已不存在、无法读取或已改变，请重新添加。`); }
    return item;
  });
}

/** Codex app-server reads an explicitly attached local picture as part of this turn's input. */
export function codexImages(context: AdapterContext) {
  return images(context).map(item => ({ type: 'localImage' as const, path: item.path }));
}

/** ACP inline images are canonical base64; capability is checked on the actual connection, including reuse. */
export function acpPrompt(context: AdapterContext, text: string, supportsImages: boolean) {
  const attached = images(context);
  if (attached.length && !supportsImages) {
    const note = '本次实际连接没有声明支持图片输入，图片内容没有随消息发送。不要猜测图里有什么；需要时请用户描述，或重新检测支持看图的程序。';
    context.emit('warning', note, undefined, 'derived');
    return [{ type: 'text' as const, text: `${text}\n\n[本轮附件投递说明]\n${note}` }];
  }
  return [{ type: 'text' as const, text }, ...attached.map(item => {
    let data: Buffer;
    try { data = readFileSync(item.path); } catch { throw new Error(`图片「${item.name}」无法读取，请重新添加。`); }
    if (data.length !== item.size) throw new Error(`图片「${item.name}」已改变，请重新添加。`);
    return { type: 'image' as const, mimeType: item.mime, data: data.toString('base64') };
  })];
}
