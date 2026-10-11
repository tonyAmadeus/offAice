import type { AcpExecutor, ProviderId } from './types';
import { isAcpId } from './defaults';
import { ALL_EXECUTOR_CATALOG } from './executor-catalog';

/** Adapter ownership, program source and wire protocol are different facts. */
export function executorConnection(id: ProviderId, executor?: Pick<AcpExecutor, 'catalogId'>) {
  if (id === 'deepseek') return { integration: 'API 直连', protocol: 'HTTPS API', source: '远程服务' };
  if (!isAcpId(id)) return { integration: '内置适配', protocol: id === 'codex' ? 'Codex App Server' : id === 'claude' ? 'Claude Code JSON 流' : 'ACP + DSH 权限插件', source: '官方 CLI，清单下载或本机安装' };
  const entry = ALL_EXECUTOR_CATALOG.find(item => item.id === executor?.catalogId);
  return { integration: '外接适配', protocol: entry?.adapter === 'zcode' ? 'ZCode 原生 CLI JSON' : 'ACP', source: entry ? '官方清单管理' : '手动连接' };
}

export function connectionLabel(id: ProviderId, executor?: Pick<AcpExecutor, 'catalogId'>) {
  const value = executorConnection(id, executor);
  return `${value.integration} · ${value.protocol} · ${value.source}`;
}
