import { ModelPicker } from './model-picker';
import { connectionLabel } from '../shared/executor-connection';
import { executorPermissions } from '../shared/permissions';
import { CatalogLogin, CatalogVersionPanel } from './executor-catalog';
import { CompatibilityDetails } from './compatibility';
import { useState } from 'react';
import { FolderOpen, Info, KeyRound, LoaderCircle, Pencil, Plug, RefreshCw, Save, Trash2 } from 'lucide-react';
import { SECRET_PLACEHOLDER, joinArgs } from '../shared/defaults';
import type { AcpExecutor, MemberPermissions, ProviderInfo, Settings, Snapshot } from '../shared/types';
import { Avatar, useTeam } from './members';
import { dateTime, providerSummary, runnable, type Invoke, type Notify } from './ui';

/** What the user edits; arguments and environment stay as typed until saved. */
export interface AcpDraft { name: string; command: string; args: string; env: string }
export const emptyAcpDraft: AcpDraft = { name: '', command: '', args: '', env: '' };
export const acpDraftOf = (executor: AcpExecutor): AcpDraft => ({ name: executor.name, command: executor.command, args: joinArgs(executor.args), env: [...Object.entries(executor.env).map(([key, value]) => `${key}=${value}`), ...(executor.secretKeys ?? []).map(key => `${key}=${SECRET_PLACEHOLDER}`)].join('\n') });

/** Program, arguments and environment for an ACP connection. */
export function AcpFields({ value, onChange, invoke, nameHint, managed=false }: { value: AcpDraft; onChange: (value: AcpDraft) => void; invoke: Invoke; nameHint?: string;managed?:boolean }) {
  const set = (patch: Partial<AcpDraft>) => onChange({ ...value, ...patch });
  async function browse() { try { const file = await invoke<string | null>('dialog.program'); if (file) set({ command: file }); } catch {} }
  return <div className="acp-fields">
    <label className="field">程序名称<input aria-label="程序名称" value={value.name} maxLength={40} onChange={event => set({ name: event.target.value })} placeholder={nameHint || '例如：Gemini CLI'} /><small>显示在成员卡和会话里，就像 Claude、Codex 一样。</small></label>
    <div className="field">程序路径
      <span className="input-with-button"><input readOnly={managed} aria-label="程序路径" value={value.command} onChange={event => set({ command: event.target.value })} placeholder="例如：gemini，或 C:\…\agent.exe" spellCheck={false} /><button type="button" className="button small secondary" disabled={managed} onClick={() => void browse()}><FolderOpen size={13} />浏览</button></span>
      <small>可以填程序名（在系统 PATH 里查找）、.exe，或 Node 脚本；npm 安装的 .cmd 会自动换成它指向的脚本，不经过命令行解释器。</small></div>
    <label className="field">启动参数<input readOnly={managed} aria-label="启动参数" value={value.args} onChange={event => set({ args: event.target.value })} placeholder="让程序进入 ACP 模式的参数，例如 --experimental-acp" spellCheck={false} /><small>含空格的参数用双引号括起来。</small></label>
    <label className="field">环境变量 <span className="optional">可选，每行一个 名称=值</span><textarea aria-label="环境变量" rows={2} value={value.env} onChange={event => set({ env: event.target.value })} placeholder={'例如：给它单独的配置目录\nGEMINI_CLI_HOME=D:\\airoom-gemini'} spellCheck={false} /><small>只传给这个程序。名称里带 KEY、TOKEN、SECRET、PASSWORD 的变量（例如 GEMINI_API_KEY）会用系统加密单独保存，之后只显示“{SECRET_PLACEHOLDER}”；不改这一项就保留原值，删掉这一行就删除密钥。</small></label>
    <div className="info-card"><Info size={17} /><p>AIROOM 通过 ACP（Agent Client Protocol）和程序对话：它在标准输入输出里收发消息。程序需要支持 ACP，例如 Gemini CLI（参数 --experimental-acp）。登录由程序自己完成，AIROOM 不接收你的账号密码。</p></div>
  </div>;
}

const COMMANDS: { id: MemberPermissions['commands']; label: string }[] = [{ id: 'ask', label: '每次询问' }, { id: 'auto', label: '自动允许' }, { id: 'deny', label: '禁止' }];

/** A connected program in settings: checked, signed in and configured like the built-in executors. */
export function AcpConnection({ executor, info, snapshot, invoke, notify, settings, setSettings }: { settings: Settings; setSettings: (update: (previous: Settings) => Settings) => void; executor: AcpExecutor; info?: ProviderInfo; snapshot: Snapshot; invoke: Invoke; notify: Notify }) {
  const team = useTeam();
  const users = team.members.filter(member => member.executor === executor.id);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<AcpDraft>(() => acpDraftOf(executor));
  const [permissions, setPermissions] = useState<MemberPermissions>(() => executorPermissions(settings, executor.id, executor));
  const [busy, setBusy] = useState<'save' | 'check' | 'login' | 'delete' | null>(null);
  const ready = runnable(info);
  async function act(kind: NonNullable<typeof busy>, action: () => Promise<unknown>) { setBusy(kind); try { await action(); } catch {} finally { setBusy(null); } }
  const save = () => act('save', async () => { await invoke('executor.save', { executor: { id: executor.id, ...draft, permissions, model: Object.hasOwn(settings.models, executor.id) ? settings.models[executor.id] : executor.model } }, `${draft.name || executor.name} 的连接已保存，正在重新检测。`); setSettings(previous => ({ ...previous, permissions: { ...previous.permissions, [executor.id]: permissions } })); setEditing(false); });
  const check = () => act('check', () => invoke('provider.probe', { provider: executor.id }));
  const login = () => act('login', async () => { notify(`已请 ${executor.name} 发起登录；如果打开了浏览器，请在那里完成。`); const result = await invoke<{ detail: string }>('executor.authenticate', { id: executor.id }); notify(result.detail); });
  const remove = () => { if (window.confirm(`删除外接程序「${executor.name}」的连接？已有会话的记录会保留，但不能再继续。`)) void act('delete', () => invoke('executor.delete', { id: executor.id }, '外接程序已删除。')); };
  return <section className="provider-settings acp-connection" aria-label={`${executor.name} 的连接`}>
    <div className="provider-settings-heading">
      {users[0] ? <Avatar member={users[0]} size={42} mood={ready ? 'resting' : info ? 'offline' : 'away'} /> : <span className="acp-icon"><Plug size={20} /></span>}
      <div><strong>{executor.name} <em className="acp-badge">{connectionLabel(executor.id, executor)}</em> <small>{users.map(member => member.name).join('、') || '还没有成员使用'}</small></strong><span className={ready ? 'ready-text' : ''}>{providerSummary(info)}{info?.version ? ` · ${info.version}` : ''}</span></div>
      <button type="button" className="button small quiet" disabled={Boolean(busy) || !snapshot.backendReady} onClick={() => void check()}>{busy === 'check' ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}检查</button>
      {!executor.catalogId&&<button type="button" className="button small secondary" disabled={Boolean(busy) || !snapshot.backendReady} onClick={() => void login()}>{busy === 'login' ? <LoaderCircle size={12} className="spin" /> : <KeyRound size={12} />}{busy === 'login' ? '等待登录完成…' : '登录'}</button>}
      {!executor.catalogId&&busy==='login'&&<button type="button" className="button small quiet" onClick={()=>void invoke('executor.cancelLogin',{id:executor.id}).catch(()=>{})}>取消登录</button>}
      <button type="button" className="button small quiet" aria-expanded={editing} onClick={() => setEditing(value => !value)}><Pencil size={12} />{editing ? '收起' : '设置'}</button>
    </div>
    <p className="provider-detail">{info?.detail ?? '尚未检查。'}</p>
    {executor.catalogId&&<CatalogLogin executor={executor} snapshot={snapshot} invoke={invoke} notify={notify}/>}
    {executor.catalogId&&<CatalogVersionPanel executor={executor} snapshot={snapshot} invoke={invoke}/>}
    <CompatibilityDetails provider={executor.id} info={info} available={snapshot.backendReady} load={provider=>invoke('provider.compatibility',{provider})}/>
    {!editing && <p className="provider-detail acp-command"><code>{info?.path ?? executor.command}{executor.args.length ? ` ${joinArgs(executor.args)}` : ''}</code></p>}
    {editing && <div className="acp-editor">
      <AcpFields value={draft} onChange={setDraft} invoke={invoke} managed={!!executor.catalogId}/>{executor.catalogId&&<p className="provider-detail">程序与启动参数由清单版本管理维护。要修改它们，可以手动添加另一个连接。</p>}
      <div className="field">遇到操作请求时<div className="segmented" role="radiogroup" aria-label={`${executor.name} 操作请求`}>{COMMANDS.map(choice => <button type="button" role="radio" aria-checked={permissions.commands === choice.id} key={choice.id} className={permissions.commands === choice.id ? 'selected' : ''} onClick={() => setPermissions(previous => ({ ...previous, commands: choice.id }))}>{choice.label}</button>)}</div>
        <small>“禁止”会拒绝它发来的执行命令请求。程序不发请求就直接做的事，AIROOM 无法拦截；只读会话会拒绝它发来的修改和命令请求。</small></div>
      <div className="field">文件范围<div className="segmented" role="radiogroup" aria-label={`${executor.name} 文件范围`}>{([['workspace', '仅限工作区'], ['any', '不限制']] as const).map(([value, label]) => <button type="button" role="radio" aria-checked={permissions.fileScope === value} key={value} onClick={() => setPermissions(previous => ({ ...previous, fileScope: value }))}>{label}</button>)}</div></div>
      <div className="field">联网<div className="segmented" role="radiogroup" aria-label={`${executor.name} 联网`}>{([[true, '允许'], [false, '拒绝联网请求']] as const).map(([value, label]) => <button type="button" role="radio" aria-checked={permissions.network === value} key={label} className={permissions.network === value ? 'selected' : ''} onClick={() => setPermissions(previous => ({ ...previous, network: value }))}>{label}</button>)}</div></div>
      <div className="acp-editor-actions">
        <button type="button" className="button small quiet danger" disabled={Boolean(busy) || users.length > 0} title={users.length ? '先删除使用这个程序的成员，或让他们改用其他程序' : undefined} onClick={remove}><Trash2 size={12} />删除连接</button>
        <span className="spacer" />
        <button type="button" className="button small quiet" onClick={() => { setDraft(acpDraftOf(executor)); setPermissions(executorPermissions(settings, executor.id, executor)); setEditing(false); }}>取消</button>
        <button type="button" className="button small primary" disabled={Boolean(busy) || !draft.name.trim() || !draft.command.trim() || !snapshot.backendReady} onClick={() => void save()}>{busy === 'save' ? <LoaderCircle size={12} className="spin" /> : <Save size={12} />}保存连接</button>
      </div>
    </div>}
    <ModelPicker provider={executor.id} info={info} settings={settings} setSettings={setSettings} invoke={invoke} />
    <div className="provider-check-time">上次确认：{dateTime(info?.checkedAt)}{info?.stale ? ' · 等待重新检测' : ''}</div>
  </section>;
}
