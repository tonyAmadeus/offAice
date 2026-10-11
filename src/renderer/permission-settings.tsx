import type { MemberPermissions, PermissionMember, Settings, Snapshot } from '../shared/types';
import { automaticWorkSettings, isAcpId, PROVIDER_NAMES } from '../shared/defaults';
import { executorPermissions, memberPermissions } from '../shared/permissions';
import { connectionLabel } from '../shared/executor-connection';
import { Avatar, useTeam } from './members';

const commands = [['auto', '自动执行'], ['ask', '严格审批'], ['deny', '禁止']] as const;
const scopes = [['workspace', '仅限工作区'], ['any', '不限制']] as const;
const networks = [[true, '允许'], [false, '禁止']] as const;
const permissionText = (value: MemberPermissions) => `${commands.find(item => item[0] === value.commands)?.[1]} · ${value.fileScope === 'any' ? '文件范围不限制' : '仅限工作区'} · ${value.network ? '允许联网' : '禁止联网'}`;

export function PermissionSettings({ snapshot, settings, setSettings }: { snapshot: Snapshot; settings: Settings; setSettings: (update: (previous: Settings) => Settings) => void }) {
  const team = useTeam();
  const executors: PermissionMember[] = ['claude', 'codex', 'dsh', ...(snapshot.executors ?? []).map(item => item.id)];
  const update = (id: PermissionMember, patch: Partial<MemberPermissions>) => setSettings(previous => ({ ...previous, permissions: { ...previous.permissions, [id]: { ...executorPermissions(previous, id, snapshot.executors?.find(item => item.id === id)), ...patch } } }));
  const override = (id: string, key: keyof MemberPermissions, raw: string) => setSettings(previous => {
    const values = { ...previous.memberPermissions }, patch = { ...values[id] };
    if (raw === 'inherit') delete patch[key];
    else Object.assign(patch, { [key]: key === 'network' ? raw === 'true' : raw });
    if (Object.keys(patch).length) values[id] = patch; else delete values[id];
    return { ...previous, memberPermissions: values };
  });
  return <>
    <div className="settings-section-heading"><h3>成员权限</h3></div>
    <p className="settings-description">人物默认继承执行端权限，也可以逐项单独覆盖。修改从下一轮任务开始生效；只读会话保持只读。</p>
    <label className="toggle-row"><span><strong>新工作会话自动批准操作</strong><small>自动处理操作审批并记录；用户问题仍按会话规则处理。</small></span><input type="checkbox" checked={settings.defaultAutoApprove} onChange={event => setSettings(previous => ({ ...previous, defaultAutoApprove: event.target.checked }))} /></label>
    <button className="button small secondary settings-inline-action" onClick={() => setSettings(previous => automaticWorkSettings(previous))}>使用自动工作设置</button>
    <div className="settings-section-heading"><h3>执行端默认权限</h3></div>
    {executors.map(id => {
      const executor = snapshot.executors?.find(item => item.id === id), value = executorPermissions(settings, id, executor);
      return <section className={`permission-card member-${id}`} key={id} aria-label={PROVIDER_NAMES[id] + ' 默认权限'}>
        <div className="permission-heading"><strong>{PROVIDER_NAMES[id]}</strong><small>{team.members.filter(member => member.executor === id).map(member => member.name).join('、')}</small></div>
        <p className="provider-detail">{connectionLabel(id, executor)}</p>
        <div className="permission-row"><span className="permission-label">执行命令</span><div className="segmented" role="radiogroup" aria-label={PROVIDER_NAMES[id] + ' 执行命令'}>{commands.map(([choice, label]) => <button type="button" role="radio" aria-checked={value.commands === choice} className={value.commands === choice ? 'selected' : ''} key={choice} onClick={() => update(id, { commands: choice })}>{label}</button>)}</div></div>
        <div className="permission-row"><span className="permission-label">文件范围</span><div className="segmented" role="radiogroup" aria-label={PROVIDER_NAMES[id] + ' 文件范围'}>{scopes.map(([choice, label]) => <button type="button" role="radio" aria-checked={value.fileScope === choice} className={value.fileScope === choice ? 'selected' : ''} key={choice} onClick={() => update(id, { fileScope: choice })}>{label}</button>)}</div></div>
        <div className="permission-row"><span className="permission-label">联网</span><div className="segmented" role="radiogroup" aria-label={PROVIDER_NAMES[id] + ' 联网'}>{networks.map(([choice, label]) => <button type="button" role="radio" aria-checked={value.network === choice} className={value.network === choice ? 'selected' : ''} key={String(choice)} onClick={() => update(id, { network: choice })}>{label}</button>)}</div></div>
        {executor?.catalogId === 'zcode' ? <small>ZCode 写入需要自动执行、文件范围不限制和联网；其他组合可用于只读对话。</small> : <small>{isAcpId(id) ? '权限控制取决于执行端提供的能力；AIROOM 只处理它发来的操作请求。' : id === 'claude' ? 'Claude Code 没有命令沙箱；工作区范围下的命令仍需批准。' : '文件范围不限制时，任务可访问工作副本以外的文件。'} 会话自动批准规则仍会处理允许范围内的审批。</small>}
      </section>;
    })}
    <div className="settings-section-heading"><h3>人物单独权限</h3></div>
    {team.members.map(member => {
      const executor = snapshot.executors?.find(item => item.id === member.executor), base = executorPermissions(settings, member.executor, executor);
      const patch = settings.memberPermissions?.[member.id] ?? {}, actual = memberPermissions(settings, member.card, executor);
      return <section className="permission-card" key={member.id} aria-label={member.name + ' 单独权限'}>
        <div className="permission-heading"><Avatar member={member} size={28} /><strong>{member.name}</strong><small>{PROVIDER_NAMES[member.executor]}{member.card.cardHidden ? ' · 已隐藏' : ''}</small></div>
        <label className="field">执行命令<select aria-label={member.name + ' 单独执行命令'} value={patch.commands ?? 'inherit'} onChange={event => override(member.id, 'commands', event.target.value)}><option value="inherit">继承执行端 · {commands.find(item => item[0] === base.commands)?.[1]}</option>{commands.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="field">文件范围<select aria-label={member.name + ' 单独文件范围'} value={patch.fileScope ?? 'inherit'} onChange={event => override(member.id, 'fileScope', event.target.value)}><option value="inherit">继承执行端 · {base.fileScope === 'any' ? '不限制' : '仅限工作区'}</option>{scopes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="field">联网<select aria-label={member.name + ' 单独联网'} value={patch.network === undefined ? 'inherit' : String(patch.network)} onChange={event => override(member.id, 'network', event.target.value)}><option value="inherit">继承执行端 · {base.network ? '允许' : '禁止'}</option>{networks.map(([value, label]) => <option key={String(value)} value={String(value)}>{label}</option>)}</select></label>
        <p className="provider-detail">当前生效：{permissionText(actual)}</p>
      </section>;
    })}
  </>;
}
