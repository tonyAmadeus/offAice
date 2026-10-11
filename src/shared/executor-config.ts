import type { AcpExecutor, MemberProfile, Project, Session, Settings } from './types';

/** Undefined inherits the next level; null explicitly selects the program's default. */
export interface ConfigSelection { model?: string | null; effort?: string | null }
export type ConfigSource = 'project' | 'session' | 'member' | 'executor' | 'default';
export interface RequestedRunConfig {
  model?: string; effort?: string; modelSource: ConfigSource; effortSource: ConfigSource;
  capturedAt: string; projectConfigRevision?: number;
}
export type ConfigStatus = 'reported' | 'accepted' | 'unreported' | 'default' | 'rejected';
export interface EffectiveRunConfig { model?: string; effort?: string; modelStatus?: ConfigStatus; effortStatus?: ConfigStatus; source: string; at: string }

export function normalizeConfigSelection(value: unknown): ConfigSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('成员配置必须是模型和思考程度的对象');
  const result: ConfigSelection = {};
  for (const [key, raw] of Object.entries(value)) {
    if (key !== 'model' && key !== 'effort') throw new Error('未知的成员配置项：' + key);
    if (raw !== null && typeof raw !== 'string') throw new Error('模型和思考程度必须是文本或程序默认');
    if (raw === null) result[key] = null;
    else { const text = raw.trim(); if (text.length > 200) throw new Error('模型或思考程度名称过长'); if (text) result[key] = text; }
  }
  return result;
}

export function requestedConfig(project: Pick<Project, 'memberConfigs' | 'memberConfigRevision'>, member: MemberProfile, settings: Settings, session?: Pick<Session, 'model' | 'effort'>, executor?: AcpExecutor): RequestedRunConfig {
  const selection = project.memberConfigs?.[member.id];
  const resolve = (key: 'model' | 'effort'): { value?: string; source: ConfigSource } => {
    if (session?.[key]) return { value: session[key], source: 'session' };
    if (selection && Object.hasOwn(selection, key)) return { value: selection[key] ?? undefined, source: selection[key] === null ? 'default' : 'project' };
    if (member[key]) return { value: member[key], source: 'member' };
    const value = key === 'model' ? (Object.hasOwn(settings.models ?? {}, member.executor) ? settings.models[member.executor] : executor?.model) : settings.efforts?.[member.executor];
    return { value: value || undefined, source: value ? 'executor' : 'default' };
  };
  const model = resolve('model'), effort = resolve('effort');
  return { model: model.value, effort: effort.value, modelSource: model.source, effortSource: effort.source, capturedAt: new Date().toISOString(), projectConfigRevision: project.memberConfigRevision };
}

export function effectiveConfigText(request: RequestedRunConfig | undefined, effective: EffectiveRunConfig | undefined) {
  if (!request) return '这次运行未记录配置';
  const show = (key: 'model' | 'effort') => {
    const value = effective?.[key], status = effective?.[key === 'model' ? 'modelStatus' : 'effortStatus'];
    if (status === 'rejected') return '所选配置被拒绝';
    if (status === 'reported' && value) return value;
    if (status === 'accepted') return '已接受请求，实际值未报告';
    return request[key] ? '实际值未报告' : '程序默认，实际值未报告';
  };
  return '请求：' + (request.model || '程序默认') + ' · ' + (request.effort || '默认思考程度') + '；实际：' + show('model') + ' · ' + show('effort');
}
