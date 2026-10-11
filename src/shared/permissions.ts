import type { AcpExecutor, MemberPermissions, MemberProfile, PermissionMember, Settings } from './types';
import { ACP_DEFAULT_PERMISSIONS, DEFAULT_SETTINGS } from './defaults';

export function executorPermissions(settings: Settings, id: PermissionMember, executor?: AcpExecutor): MemberPermissions {
  return settings.permissions[id] ?? executor?.permissions ?? DEFAULT_SETTINGS.permissions[id] ?? ACP_DEFAULT_PERMISSIONS;
}

export function memberPermissions(settings: Settings, member: Pick<MemberProfile, 'id' | 'executor'>, executor?: AcpExecutor): MemberPermissions {
  return { ...executorPermissions(settings, member.executor, executor), ...settings.memberPermissions?.[member.id] };
}

/** Validate each override; absent fields keep inheriting, including after a default changes. */
export function normalizeMemberPermissions(value: unknown, members?: Set<string>): NonNullable<Settings['memberPermissions']> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('人物权限设置无效');
  const result: NonNullable<Settings['memberPermissions']> = {};
  for (const [id, raw] of Object.entries(value)) {
    if (members && !members.has(id)) throw new Error('权限对应的人物已不存在，请刷新设置');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('人物权限覆盖无效');
    const patch: Partial<MemberPermissions> = {};
    for (const [key, choice] of Object.entries(raw)) {
      if (key === 'commands' && ['ask', 'auto', 'deny'].includes(choice as string)) patch.commands = choice as MemberPermissions['commands'];
      else if (key === 'fileScope' && ['workspace', 'any'].includes(choice as string)) patch.fileScope = choice as MemberPermissions['fileScope'];
      else if (key === 'network' && typeof choice === 'boolean') patch.network = choice;
      else throw new Error('人物权限选项无效：' + key);
    }
    if (Object.keys(patch).length) result[id] = patch;
  }
  return result;
}
