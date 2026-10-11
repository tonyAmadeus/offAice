import { fetch, ProxyAgent, Agent } from 'undici';
import { validateProxyUrl } from './security';
import type { Settings } from '../shared/types';

export async function checkNetwork(settings:Settings) {
  const proxy=settings.networkMode==='proxy' ? new ProxyAgent(validateProxyUrl(settings.proxyUrl).toString()) : undefined;
  const direct=new Agent();
  try {
    const deepseek=new URL(settings.deepseekBaseUrl);
    if (!['http:','https:'].includes(deepseek.protocol) || deepseek.username || deepseek.password || deepseek.search || deepseek.hash) throw new Error('DeepSeek 服务地址必须是不含凭据的 HTTP 或 HTTPS 地址。');
    const hosts=['https://api.anthropic.com/','https://chatgpt.com/',deepseek.toString()];
    const results=await Promise.all(hosts.map(async url=>{
      const started=Date.now();
      try {
        const local=['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname);
        const response=await fetch(url,{method:'HEAD',redirect:'manual',signal:AbortSignal.timeout(8000),dispatcher:local?direct:proxy??direct});
        await response.body?.cancel();
        return {url,reached:true,status:response.status,elapsedMs:Date.now()-started,detail:response.status===403?'已收到服务器响应；访问被拒绝，不能据此证明登录或模型调用可用。':'已收到服务器响应；未进行付费模型调用。'};
      } catch(error) {
        const cause=error instanceof Error && error.cause instanceof Error ? `：${error.cause.message}` : '';
        return {url,reached:false,elapsedMs:Date.now()-started,detail:error instanceof Error ? error.message+cause:'连接失败'};
      }
    }));
    return {mode:settings.networkMode,route:settings.networkMode==='proxy'?validateProxyUrl(settings.proxyUrl).origin:'系统网络（依赖当前 TUN；应用无法据此独立确认 TUN 已启用）',results,checkedAt:new Date().toISOString()};
  } finally { await Promise.all([direct.close(),proxy?.close()]); }
}
