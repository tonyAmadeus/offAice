import type { ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export function officialLoginUrl(provider: string, value: string): string | undefined {
  try {
    const url = new URL(value);
    const domains = provider === 'claude' ? ['anthropic.com', 'claude.ai', 'claude.com'] : provider === 'codex' ? ['openai.com', 'chatgpt.com'] : [];
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return;
    if (domains.some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain))) return url.href;
  } catch { /* Only a complete official HTTPS address can be opened. */ }
}

/** Handles split UTF-8 output; exposes fixed messages, never CLI text or OAuth secrets. */
export function loginOutput(provider: string, open: (url: string) => void, status: (text: string) => void) {
  const decoder = new StringDecoder('utf8');
  let buffer = '', opened = false;
  function parse(final = false) {
    for (const match of buffer.matchAll(/https:\/\/[^\s<>"'\x1b]+(?=[\s<>"'\x1b]|$)/g)) {
      if (!final && match.index! + match[0].length === buffer.length) continue;
      const url = officialLoginUrl(provider, match[0]);
      if (url && !opened) { opened = true; open(url); status('官方登录页面已打开，请在浏览器完成授权。'); }
    }
    if (/Paste code here if prompted|paste.*(?:authorization|authentication).*code/i.test(buffer)) status('如果官方网页显示授权码，请粘贴到下方输入框后提交。');
    if (/login successful|successfully logged in/i.test(buffer)) status('官方执行端报告登录完成，正在等待退出并重新检测。');
    // Retain only a potentially unfinished URL or prompt; no raw output is emitted.
    const newline = buffer.lastIndexOf('\n');
    if (newline >= 0) buffer = buffer.slice(newline + 1);
    buffer = buffer.slice(-32768);
  }
  return { write(chunk: Buffer) { buffer += decoder.write(chunk); parse(); }, end() { buffer += decoder.end(); parse(true); buffer = ''; } };
}

export function submitClaudeLoginCode(child: ChildProcess | undefined, value: unknown): Promise<void> {
  const code = typeof value === 'string' ? value.trim() : '';
  if (!code || code.length > 4096 || !/^[A-Za-z0-9._~+=/#-]+$/.test(code)) throw new Error('请粘贴官方网页提供的单行授权码。');
  if (!child || child.exitCode !== null || child.killed || !child.stdin?.writable) throw new Error('Claude 登录已结束或尚未开始，请先点击登录。');
  return new Promise((resolve, reject) => child.stdin!.write(code + '\n', error => error ? reject(new Error('授权码未能送达登录进程，请重新登录。')) : resolve()));
}
