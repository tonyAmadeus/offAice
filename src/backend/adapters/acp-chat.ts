import type { AcpExecutor, AdapterContext } from '../../shared/types';
import { plainRoomSpeech } from './chat-policy';

/** Invocation-only overrides: never edit the user's provider, memory or project config. */
export function acpChatLaunch(executor: AcpExecutor, env: NodeJS.ProcessEnv, context?: AdapterContext) {
  const args=[...executor.args];
  if(!context||!plainRoomSpeech(context))return {args,env};
  if(executor.catalogId==='qoder'){
    args.push('--tools','','--strict-mcp-config','--mcp-config',JSON.stringify({mcpServers:{}}));
  }
  if(executor.catalogId==='opencode'&&env.OPENCODE_CONFIG_CONTENT){
    let config:unknown;
    try{config=JSON.parse(env.OPENCODE_CONFIG_CONTENT);}catch{throw new Error('OpenCode 临时配置无法解析，请检查连接设置；任务尚未发送。');}
    if(!config||typeof config!=='object'||Array.isArray(config))throw new Error('OpenCode 临时配置无效，请检查连接设置；任务尚未发送。');
  }
  // Qoder CN and OpenCode keep native tools until real account turns verify these switches.
  // Kimi/Cursor have no verified per-invocation no-tools switch for resumed ACP
  // sessions. Keep native history/agent definitions; benefit from shared reuse/config.
  return {args,env};
}
