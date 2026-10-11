import { realpathSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { Settings } from '../shared/types';
import { nodeRuntimeEnvironment } from './node-runtime';

const sensitiveKey = /^(?:.*[_-])?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|oauth[_-]?token|auth[_-]?token|token|authorization|password|passwd|secret|credentials|cookie|set-cookie)$/i;
const knownSecrets = new Set(Object.entries(process.env).filter(([key,value]) => sensitiveKey.test(key) && value && value.length >= 8).map(([,value])=>value!));

/** Register runtime credentials so plain-text echoes are also redacted. Retained for this process lifetime to cover delayed output. */
export function registerSecret(value:string):void {
  if (value.length>=8 && value.length<=16384) knownSecrets.add(value);
}

/** Remove credentials before persisting or forwarding diagnostic material. */
export function redact<T>(value:T):T {
  // Only ancestors count as cycles; the same object shared by siblings (e.g. one options array) is fine.
  const ancestors = new Set<object>();
  function visit(item:unknown, depth=0):unknown {
    if (depth > 40) return '[depth limited]';
    if (typeof item === 'string') {
      let result = item.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[credential redacted]')
        .replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]{12,}\b/g, '[credential redacted]')
        .replace(/(https?:\/\/)[^\s/:]+:[^\s/@]+@/gi, '$1[credential redacted]@')
        .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|oauth[_-]?token|auth[_-]?token|password|secret)\s*[=:]\s*["']?)[^\s,"';]+/gi, '$1[credential redacted]');
      for (const secret of knownSecrets) result = result.split(secret).join('[credential redacted]');
      return result;
    }
    if (item === null || typeof item !== 'object') return item;
    if (ancestors.has(item)) return '[circular]';
    ancestors.add(item);
    try {
      if (Array.isArray(item)) return item.map(entry=>visit(entry,depth+1));
      const result:Record<string,unknown> = {};
      for (const [key,entry] of Object.entries(item)) result[key] = sensitiveKey.test(key) ? '[credential redacted]' : visit(entry,depth+1);
      return result;
    } finally { ancestors.delete(item); }
  }
  return visit(value) as T;
}

function contained(root:string, target:string) {
  const relative = path.relative(root,target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Validate both lexical paths and any existing symlinks/junctions. */
export function resolveSafePath(root:string, relative=''):string {
  if (typeof relative !== 'string' || relative.includes('\0') || path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative) || relative.includes(':')) throw new Error('文件路径必须在所选工作区内。');
  const realRoot = realpathSync(root);
  const candidate = path.resolve(realRoot,relative);
  if (!contained(realRoot,candidate)) throw new Error('文件路径超出所选工作区。');
  let ancestor=candidate;
  while (!existsSync(ancestor)) {
    const parent=path.dirname(ancestor);
    if (parent===ancestor) throw new Error('无法校验文件路径。');
    ancestor=parent;
  }
  if (!contained(realRoot,realpathSync(ancestor))) throw new Error('文件链接指向工作区之外。');
  return candidate;
}

export function validateProxyUrl(value:string):URL {
  let url:URL;
  try { url=new URL(value); } catch { throw new Error('代理地址无效，请填写完整的 HTTP 或 HTTPS 地址。'); }
  if (!['http:','https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('代理地址只支持不含账户密码的 HTTP 或 HTTPS 地址。');
  return url;
}

export function buildEnvironment(settings:Settings):NodeJS.ProcessEnv {
  const env:NodeJS.ProcessEnv={...process.env};
  for (const key of Object.keys(env)) {
    if (/^(?:http_proxy|https_proxy|all_proxy|npm_config_proxy|npm_config_https_proxy|anthropic_api_key|anthropic_auth_token|claude_code_resume_interrupted_turn)$/i.test(key)) delete env[key];
  }
  if (settings.networkMode==='proxy') {
    const proxy=validateProxyUrl(settings.proxyUrl).toString();
    env.HTTP_PROXY=proxy; env.HTTPS_PROXY=proxy;env.npm_config_proxy=proxy;env.npm_config_https_proxy=proxy;
  }
  const bypass=Object.entries(env).filter(([key])=>/^no_proxy$/i.test(key)).flatMap(([,value])=>(value??'').split(',')).map(value=>value.trim()).filter(Boolean);
  for (const key of Object.keys(env)) if (/^no_proxy$/i.test(key)) delete env[key];
  env.NO_PROXY=[...new Set([...bypass,'localhost','127.0.0.1','::1','[::1]'])].join(',');
  env.AIROOM_CLAUDE_AUTH_MODE=settings.claudeAuthMode==='api'?'api':'subscription';
  env.npm_config_registry=settings.npmRegistry==='npmmirror'?'https://registry.npmmirror.com/':'https://registry.npmjs.org/';
  return nodeRuntimeEnvironment(settings,env);
}
