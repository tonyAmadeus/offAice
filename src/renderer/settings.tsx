import { connectionLabel } from '../shared/executor-connection';
import {ProviderLogin} from './provider-login';
import { ModelPicker } from './model-picker';
export { ModelPicker } from './model-picker';
import { PermissionSettings } from './permission-settings';
import { ExecutorCatalog, ThirdPartyLicenses } from './executor-catalog';
import type { NodeRuntimeInfo } from '../shared/executor-catalog';
import { CompatibilityDetails } from './compatibility';
import {DiscussionCallSettings} from './discussion-call-settings';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Cable, Check, Download, Folder, Globe2, Info, KeyRound, LoaderCircle, LockKeyhole, Network, Palette, RefreshCw, ShieldCheck, Trash2, UserRound, Users } from 'lucide-react';
import { PROVIDER_NAMES, normalizePermissions } from '../shared/defaults';
import type { PermissionMember, ProviderId, ProviderInfo, Settings, Snapshot } from '../shared/types';
import type { MemberVersions, MemberInstallation } from '../shared/member-versions';
import { effectiveConfigText } from '../shared/executor-config';
import { Avatar, useTeam } from './members';
import { CardEditor, MemberGallery, ProfileSettings } from './cards';
import { Modal } from './modals';
import { AcpConnection } from './executors';
import { NOTIFY_KEY, notificationsEnabled } from './interactions';
import { PROVIDERS, dateTime, providerSummary, runnable, useTicker, type Invoke, type Notify, versionText } from './ui';
import { BackupSettings } from './backup';
import { RunningVersionCard } from './version';
import { roomBackdropEnabled, setRoomBackdropEnabled } from './room-backdrop';

export type Installs = Partial<Record<ProviderId, { version: string; startedAt: number }>>;
export type ThemeChoice = 'system' | 'light' | 'dark';

export type SettingsTab = 'members' | 'connections' | 'profile' | 'permissions' | 'network' | 'workspace';
export function SettingsModal({ snapshot, invoke, onClose, notify, installs, onInstall, theme, onTheme, initialTab = 'members', initialEditing, initialFocus }: {
  snapshot: Snapshot; invoke: Invoke; onClose: () => void; notify: Notify;
  installs: Installs; onInstall: (provider: ProviderId, version: string | null) => void;
  theme: ThemeChoice; onTheme: (theme: ThemeChoice) => void; initialTab?: SettingsTab; initialEditing?: string | null;
  /** A program whose connection section is scrolled into view and highlighted on open. */
  initialFocus?: string | null;
}) {
  const team = useTeam();
  const [editing, setEditing] = useState<string | null>(initialEditing ?? null);
  useEffect(() => {
    if (!initialFocus) return;
    const frame = requestAnimationFrame(() => {
      const section = document.querySelector<HTMLElement>(`[data-provider="${CSS.escape(initialFocus)}"]`);
      section?.scrollIntoView({ block: 'center' }); section?.classList.add('focus-flash');
    });
    return () => cancelAnimationFrame(frame);
  }, [initialFocus]);
  const [cardActions, setCardActions] = useState<HTMLDivElement | null>(null);
  const [settings, setSettings] = useState<Settings>(() => ({ ...snapshot.settings, paths: { ...snapshot.settings.paths }, models: { ...Object.fromEntries((snapshot.executors ?? []).filter(executor => executor.model).map(executor => [executor.id, executor.model!])), ...snapshot.settings.models }, efforts: { ...snapshot.settings.efforts }, permissions: normalizePermissions(snapshot.settings.permissions) }));
  useEffect(() => {
    const ids = new Set(snapshot.members?.map(member => member.id));
    setSettings(previous => {
      const values = previous.memberPermissions;
      if (!values || Object.keys(values).every(id => ids.has(id))) return previous;
      return { ...previous, memberPermissions: Object.fromEntries(Object.entries(values).filter(([id]) => ids.has(id))) };
    });
  }, [snapshot.members]);
  // Requests that point at a program (its id, or the download catalog) belong to 连接与版本.
  const [tab, setTab] = useState<SettingsTab>(initialTab === 'members' && initialFocus && !initialEditing ? 'connections' : initialTab);
  const [newExecutor,setNewExecutor]=useState<PermissionMember>();
  const [manualProvider,setManualProvider]=useState<ProviderId>();
  // Cancelling a card started from the download catalog returns to the catalog, not the gallery.
  const [editOrigin,setEditOrigin]=useState<SettingsTab>('members');
  const [nodeInfo,setNodeInfo]=useState<NodeRuntimeInfo>();
  useEffect(()=>{void invoke<{node:NodeRuntimeInfo}>('catalog.list').then(value=>setNodeInfo(value.node)).catch(()=>{});},[invoke]);
  const [claudeApi,setClaudeApi]=useState('');
  async function saveClaudeApi(value:string){setClaudeApi('');try{await saveConfiguration();await invoke('claudeApiKey.set',{value},value?'Claude API Key 已加密保存。':'Claude API Key 已清除。');}catch{}}
  const [busy, setBusy] = useState(false); const [checking, setChecking] = useState<ProviderId | 'all' | null>(null);
  const [backupBusy,setBackupBusy]=useState(false);
  const [loginMessages, setLoginMessages] = useState<Partial<Record<ProviderId, string>>>({});
  const [claudeLoginCode, setClaudeLoginCode] = useState('');
  const [sendingLoginCode, setSendingLoginCode] = useState(false);
  const [claudeToken, setClaudeToken] = useState(''), [savingToken, setSavingToken] = useState(false);
  const [notify_, setNotify] = useState(notificationsEnabled);
  const [backdrop, setBackdrop] = useState(roomBackdropEnabled);
  function toggleNotifications(on: boolean) {
    setNotify(on);
    try { localStorage.setItem(NOTIFY_KEY, on ? 'on' : 'off'); } catch {}
    if (on && typeof Notification !== 'undefined' && Notification.permission === 'default') void Notification.requestPermission();
  }
  async function sendClaudeLoginCode() {
    const code = claudeLoginCode; setClaudeLoginCode(''); setSendingLoginCode(true);
    try { await invoke('provider.loginCode', { provider: 'claude', code }); notify('授权码已提交，等待官方登录完成。'); } catch {} finally { setSendingLoginCode(false); }
  }
  async function openTokenWindow() {
    try { const result = await invoke<{ detail?: string }>('provider.tokenLogin', { provider: 'claude' }); setLoginMessages(previous => ({ ...previous, claude: result?.detail ?? '已打开令牌窗口。' })); } catch {}
  }
  /** The token goes straight to the desktop process for encryption; the field is cleared at once either way. */
  async function saveClaudeToken(value: string) {
    setClaudeToken(''); setSavingToken(true);
    try { await invoke('secret.set', { provider: 'claude', value }, value ? 'Claude 长期令牌已加密保存，正在重新检查。' : '已清除 Claude 长期令牌。'); } catch {} finally { setSavingToken(false); }
  }
  async function saveConfiguration() {
    await invoke('settings.save', { settings });
  }
  async function save() { setBusy(true); try { await saveConfiguration(); notify('设置已保存。新任务会使用当前配置。'); onClose(); } catch {} finally { setBusy(false); } }
  async function probe(provider?: ProviderId) { setChecking(provider ?? 'all'); try { await saveConfiguration(); await invoke('provider.probe', provider ? { provider } : {}); } catch {} finally { setChecking(null); } }
  async function selectManualProvider(provider?: ProviderId) {
    try {
      if (provider && snapshot.removedProviders?.includes(provider)) await invoke('executor.restore',{id:provider});
      setManualProvider(provider);
    } catch {}
  }
  async function removeProvider(provider: ProviderId) {
    if (!window.confirm(`删除「${PROVIDER_NAMES[provider]}」的连接？聊天记录、登录资料和已下载程序会保留，可以从清单或手动配置重新添加。`)) return;
    setChecking(provider);
    try {
      await invoke('executor.delete',{id:provider},'执行端连接已删除。');
      setSettings(previous=>({...previous,paths:{...previous.paths,[provider]:undefined}}));
      if (manualProvider===provider) setManualProvider(undefined);
    } catch {} finally { setChecking(null); }
  }
  async function exportDiagnostics() {
    try {
      const result = await invoke<{ path?: string } | string>('diagnostics.export');
      const path = typeof result === 'string' ? result : result?.path;
      notify(path ? `诊断记录已导出：${path}` : '诊断记录已导出。');
    } catch {}
  }
  const tabs = [['members', '团队成员', <Users size={15} />], ['connections', '连接与版本', <Cable size={15} />], ['profile', '个人资料', <UserRound size={15} />], ['permissions', '权限', <ShieldCheck size={15} />], ['network', '网络', <Globe2 size={15} />], ['workspace', '工作台', <Folder size={15} />]] as const;
  return <Modal title="设置与成员连接" subtitle="团队成员的人物卡、连接和版本，以及你自己的资料。" onClose={backupBusy?()=>{}:onClose} className="settings-modal">
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="设置分类">
        {tabs.map(([id, label, icon]) => <button disabled={backupBusy} className={tab === id ? 'selected' : ''} key={id} onClick={() => { setTab(id); setEditing(null); }}>{icon}{label}</button>)}
        <div className="settings-nav-team" aria-hidden="true">{team.members.slice(0, 4).map(member => <Avatar key={member.id} member={member} size={30} />)}</div>
        <div className="settings-nav-note"><ShieldCheck size={16} /><span>登录由官方程序完成，工作台不复制订阅令牌。</span></div>
      </nav>
      <div className="settings-content">
        {tab === 'members' && editing && <CardEditor key={editing} snapshot={snapshot} memberId={editing} invoke={invoke} notify={notify} onBack={() => setEditing(null)} onCancel={() => { setEditing(null); setTab(editOrigin); }} actionContainer={cardActions} initialExecutor={newExecutor} />}
        {tab === 'members' && !editing && <>
          <div className="settings-section-heading"><h3>团队成员</h3></div>
          <p className="settings-description">每位成员是一张人物卡：名字、怎么称呼你、人设、长期记忆和形象都可以改。成员使用的 AI 程序在“连接与版本”里下载和登录。</p>
          <MemberGallery snapshot={snapshot} onEdit={id => {setEditOrigin('members');setEditing(id);}} onAdd={() => {setNewExecutor(undefined);setEditOrigin('members');setEditing('new');}} />
        </>}
        {tab === 'connections' && <>
          <ExecutorCatalog snapshot={snapshot} invoke={invoke} notify={notify} beforeOperation={saveConfiguration} onSelected={item=>{if(!item.provider.startsWith('acp-'))setSettings(previous=>({...previous,paths:{...previous.paths,[item.provider]:item.selectedPath}}));}} onNewMember={provider=>{setNewExecutor(provider);setEditOrigin('connections');setEditing('new');setTab('members');}}/>
          <div className="settings-section-heading"><h3>连接、模型与版本</h3><button className="button small secondary" disabled={Boolean(checking) || !snapshot.backendReady} onClick={() => void probe()}><RefreshCw size={13} className={checking ? 'spin' : ''} />检查全部</button></div>
          <p className="settings-description">按程序设置，使用同一个程序的成员共用登录和版本。</p>
          <label className="field compact">手动配置本机执行端<select aria-label="手动配置本机执行端" value={manualProvider??''} onChange={event=>void selectManualProvider(event.target.value as ProviderId||undefined)}><option value="">选择要配置的程序</option>{PROVIDERS.map(provider=><option key={provider} value={provider}>{PROVIDER_NAMES[provider]}</option>)}</select></label>
          {PROVIDERS.filter(provider=>!snapshot.removedProviders?.includes(provider)&&(snapshot.settings.paths[provider]||team.members.some(member=>member.executor===provider)||manualProvider===provider||provider==='deepseek'&&snapshot.deepseekKeyConfigured)).map(provider => {
            const info = snapshot.providers.find(item => item.id === provider);
            const p = team.members.find(member=>member.executor===provider);
            return <section className={`provider-settings member-${provider}`} key={provider} data-provider={provider}>
              <div className="provider-settings-heading">
                {p?<Avatar member={p} size={42} mood={runnable(info) ? 'resting' : info ? 'offline' : 'away'} />:<Cable size={24}/>}
                <div><strong>{PROVIDER_NAMES[provider]} <small>{team.members.filter(member => member.executor === provider).map(member => member.name).join('、')}</small></strong><span className={runnable(info) ? 'ready-text' : ''}>{providerSummary(info)}{info?.version ? ` · ${versionText(info)}` : ''}</span></div>
                <button className="button small quiet" disabled={Boolean(checking) || !snapshot.backendReady} onClick={() => void probe(provider)}>{checking === provider || checking === 'all' ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}检查</button>
                {provider!=='deepseek'&&<button className="button small quiet danger" aria-label={`${PROVIDER_NAMES[provider]} 删除连接`} disabled={Boolean(checking)||!snapshot.backendReady||team.members.some(member=>member.executor===provider)} title={team.members.some(member=>member.executor===provider)?'先让使用它的人物改用其他执行端，或删除对应人物卡':undefined} onClick={()=>void removeProvider(provider)}><Trash2 size={12}/>删除连接</button>}
              </div>
              <p className="provider-detail">{connectionLabel(provider)}</p><p className="provider-detail">{info?.detail ?? '尚未检查本机可用性与认证方式。'}</p>
              {(provider==='codex'||provider==='dsh'||provider==='claude'&&settings.claudeAuthMode!=='api')&&<ProviderLogin provider={provider} available={snapshot.backendReady} invoke={invoke} notify={notify} beforeLogin={saveConfiguration}/>}
              <CompatibilityDetails provider={provider} info={info} available={snapshot.backendReady} load={provider=>invoke('provider.compatibility',{provider})}/>
              {loginMessages[provider] && <pre className="login-message">{loginMessages[provider]}</pre>}
              {provider !== 'deepseek' && <label className="field compact">执行文件路径 <span className="optional">留空自动查找</span><input value={settings.paths[provider] ?? ''} onChange={event => setSettings(previous => ({ ...previous, paths: { ...previous.paths, [provider]: event.target.value } }))} placeholder={info?.path ?? (provider === 'claude' ? '独立安装的 Claude Code CLI 路径' : '使用本机默认路径')} spellCheck={false} /></label>}
              <ModelPicker provider={provider} info={info} settings={settings} setSettings={setSettings} invoke={invoke} />
              {provider !== 'deepseek' && <VersionPanel provider={provider} info={info} available={snapshot.backendReady} invoke={invoke} installing={installs[provider]} onInstall={version => onInstall(provider, version)} onSelectedPath={path => setSettings(previous => ({ ...previous, paths: { ...previous.paths, [provider]: path ?? undefined } }))} />}
              {provider==='claude'&&<>
                <label className="field compact">Claude 登录方式<select aria-label="Claude 登录方式" value={settings.claudeAuthMode??'subscription'} onChange={event=>setSettings(previous=>({...previous,claudeAuthMode:event.target.value as 'subscription'|'api'}))}><option value="subscription">订阅登录（官方 Claude Code）</option><option value="api">API Key</option></select></label>
                {settings.claudeAuthMode==='api'?<div className="catalog-login"><p className="provider-detail">用量按 Anthropic API 计费，与 Claude 订阅额度分开。{snapshot.claudeApiKeyConfigured?'密钥已加密保存。':''}</p><label className="field compact">Anthropic API Key<input type="password" autoComplete="off" value={claudeApi} aria-label="Anthropic API Key" onChange={event=>setClaudeApi(event.target.value)}/></label><button className="button secondary" disabled={!claudeApi.trim()||!snapshot.backendReady} onClick={()=>void saveClaudeApi(claudeApi)}>加密保存 API Key</button>{snapshot.claudeApiKeyConfigured&&<button className="button quiet danger" onClick={()=>void saveClaudeApi('')}>清除 API Key</button>}</div>:<p className="provider-detail">由你自己通过官方 Claude Code 登录，使用你自己的 Claude 订阅。AIROOM 只是启动官方程序，不经手你的账号；请遵守 Anthropic 的条款。</p>}
              </>}
              {provider === 'claude' && settings.claudeAuthMode!=='api' && snapshot.claudeTokenConfigured && <div className="token-login"><div className="token-login-heading"><strong>已有长期令牌（兼容保留）</strong><span className="ready-text">已保存</span></div>
                <p className="provider-detail">此前保存的凭据继续保留。新增订阅登录使用官方 Claude Code 登录入口；也可以选择 API Key 登录。清除已有令牌后，通过官方程序重新登录。</p>
                <div className="token-login-row"><button type="button" className="button small secondary" disabled={!snapshot.backendReady} onClick={() => void openTokenWindow()}><KeyRound size={12} />浏览器重新登录</button>
                  <input type="password" autoComplete="off" aria-label="Claude 长期令牌" value={claudeToken} onChange={event => setClaudeToken(event.target.value)} placeholder="粘贴 sk-ant- 开头的令牌" spellCheck={false} />
                  <button type="button" className="button small primary" disabled={!claudeToken.trim() || savingToken || !snapshot.backendReady} onClick={() => void saveClaudeToken(claudeToken.trim())}>保存令牌</button>
                  {snapshot.claudeTokenConfigured && <button type="button" className="button small quiet danger" disabled={savingToken || !snapshot.backendReady} onClick={() => { if (window.confirm('清除 Claude 长期令牌？之后需要重新登录 Claude。')) void saveClaudeToken(''); }}>清除令牌</button>}</div></div>}
              {provider === 'claude' && settings.claudeAuthMode!=='api' && <div className="login-code"><label className="field compact">粘贴官方授权码<input type="password" autoComplete="off" aria-label="Claude 官方授权码" value={claudeLoginCode} onChange={event => setClaudeLoginCode(event.target.value)} placeholder="仅在官方网页显示授权码时填写" spellCheck={false} /></label><button className="button small secondary" disabled={!claudeLoginCode.trim() || sendingLoginCode || !snapshot.backendReady} onClick={() => void sendClaudeLoginCode()}>提交授权码</button><p className="provider-detail">先点击登录。如果网页给出授权码，在这里粘贴；提交后立即清空，不写入对话和日志。</p></div>}
              {provider === 'dsh' && <label className="field compact">DSH 独立后台配置<input value={settings.dshProfile} onChange={event => setSettings(previous => ({ ...previous, dshProfile: event.target.value }))} /></label>}
              {provider === 'dsh' && <p className="provider-detail">使用独立 DSH 后台和独立账号登录，不需要桌面客户端运行，也不读取桌面登录凭据。点击登录后在官方浏览器页面授权一次。</p>}
              <div className="provider-check-time">上次确认：{dateTime(info?.checkedAt)}{info?.stale ? ' · 等待重新检测' : ''}{info?.authDirectory && <span> · 账号目录：{info.authDirectory}</span>} · 额度：{provider==='claude'&&settings.claudeAuthMode==='api'?'API 按用量计费':info?.quota == null ? '未提供' : '已收到服务端信息'}</div>
              {!(provider==='claude'&&settings.claudeAuthMode==='api')&&info?.quota != null && <details className="quota-details"><summary>查看服务端额度信息</summary><pre>{typeof info.quota === 'string' ? info.quota : JSON.stringify(info.quota, null, 2)}</pre></details>}
            </section>;
          })}
          {(snapshot.executors ?? []).length > 0 && <><div className="settings-section-heading"><h3>外接的 AI 程序</h3></div>
            <p className="settings-description">清单执行端自动使用对应适配；手动连接使用 ACP。登录、模型和权限按执行端实际能力提供。</p></>}
          {(snapshot.executors ?? []).map(executor => <div key={executor.id} data-provider={executor.id}><AcpConnection executor={executor} info={snapshot.providers.find(item => item.id === executor.id)} snapshot={snapshot} invoke={invoke} notify={notify} settings={settings} setSettings={setSettings} /></div>)}
        </>}
        {tab === 'profile' && <ProfileSettings snapshot={snapshot} invoke={invoke} />}
        {tab === 'permissions' && <PermissionSettings snapshot={snapshot} settings={settings} setSettings={setSettings} />}
        {tab === 'network' && <>
          <div className="settings-section-heading"><h3>使用当前网络出口</h3></div>
          <p className="settings-description">默认沿用你已经开启的 TUN，独立 CLI 和本机客户端使用相同的网络环境。</p>
          <label className={`network-option ${settings.networkMode === 'tun' ? 'selected' : ''}`}><input type="radio" checked={settings.networkMode === 'tun'} onChange={() => setSettings(previous => ({ ...previous, networkMode: 'tun' }))} /><span><strong>沿用系统 TUN</strong><small>无需另设代理地址。任务运行时请保持 TUN 开启。</small></span><Globe2 size={20} /></label>
          <label className={`network-option ${settings.networkMode === 'proxy' ? 'selected' : ''}`}><input type="radio" checked={settings.networkMode === 'proxy'} onChange={() => setSettings(previous => ({ ...previous, networkMode: 'proxy' }))} /><span><strong>使用显式代理</strong><small>工作台启动的成员程序都走这个代理。</small></span><Network size={20} /></label>
          {settings.networkMode === 'proxy' && <label className="field">代理地址<input value={settings.proxyUrl} onChange={event => setSettings(previous => ({ ...previous, proxyUrl: event.target.value }))} placeholder="http://127.0.0.1:7897" spellCheck={false} /></label>}
          <div className="info-card"><Info size={17} /><p>本地通信会绕过网络代理。订阅登录和真实调用仍需单独验证；HTTP 状态码不能代替完整的接入检查。</p></div>
          <button className="button small secondary settings-inline-action" disabled={Boolean(checking)} onClick={() => void probe()}><RefreshCw size={14} className={checking ? 'spin' : ''} />保存并检查成员连接</button>
          <div className="settings-section-heading"><h3>下载源</h3></div>
          <label className="field">npm 下载源<select aria-label="npm 下载源" value={settings.npmRegistry??'official'} onChange={event=>setSettings(previous=>({...previous,npmRegistry:event.target.value as 'official'|'npmmirror'}))}><option value="official">npm 官方源</option><option value="npmmirror">npmmirror 国内镜像</option></select><small>镜像下载仍与官方包名及完整性记录核对；连接设置同时用于下载。</small></label>
        </>}
        {tab === 'workspace' && <>
          <div className="settings-section-heading"><h3>工作台设置</h3></div>
          <section className="settings-group" aria-label="对话">
            <DiscussionCallSettings settings={settings} onChange={limits=>setSettings(previous=>({...previous,discussionCallLimits:limits}))}/>
          </section>
          <section className="settings-group" aria-label="外观与提醒"><h3>外观与提醒</h3>
            <div className="field">外观<div className="segmented wide" role="radiogroup" aria-label="外观">{([['system', '跟随系统'], ['light', '白天'], ['dark', '夜晚']] as const).map(([id, label]) => <button type="button" role="radio" aria-checked={theme === id} className={theme === id ? 'selected' : ''} key={id} onClick={() => onTheme(id)}><Palette size={13} />{label}</button>)}</div><small>只影响这台电脑上的显示，立即生效。</small></div>
            <label className="toggle-row"><span><strong>成员完成或需要你时通知我</strong><small>AIROOM 不在前台时，弹出系统通知并闪烁任务栏图标。只影响这台电脑，立即生效。</small></span><input type="checkbox" checked={notify_} onChange={event => toggleNotifications(event.target.checked)} /></label>
            <label className="toggle-row"><span><strong>聊天室背景随时间变化</strong><small>同一间工作室，按早上、白天、傍晚、深夜变换光线。只影响这台电脑，立即生效。</small></span><input type="checkbox" checked={backdrop} onChange={event => { setBackdrop(event.target.checked); setRoomBackdropEnabled(event.target.checked); }} /></label>
          </section>
          <section className="settings-group" aria-label="任务运行"><h3>任务运行</h3>
            <div className="settings-field-grid">
              <label className="field">同时执行的任务数量<input type="number" min="1" max="8" value={settings.maxParallel} onChange={event => setSettings(previous => ({ ...previous, maxParallel: Number(event.target.value) || 1 }))} /><small>并行任务会共用各成员账号的额度。</small></label>
              <label className="field">单个任务最长运行时间（分钟）<input type="number" min="1" max="1440" value={settings.maxRunMinutes ?? 30} onChange={event => setSettings(previous => ({ ...previous, maxRunMinutes: Math.min(1440, Math.max(1, Number(event.target.value) || 30)) }))} /><small>包括等待审批的时间。到期会请求停止，并核对执行状态。</small></label>
              <label className="field">停止等待时间（秒）<input type="number" min="1" max="60" value={settings.stopTimeoutMs / 1000} onChange={event => setSettings(previous => ({ ...previous, stopTimeoutMs: (Number(event.target.value) || 10) * 1000 }))} /><small>超时后工作台会停下这一轮并清理残留程序，结果标为待核对。</small></label>
            </div>
            <label className="toggle-row"><span><strong>新会话默认允许修改文件</strong><small>写入任务使用独立工作区。已有会话的权限保持不变。</small></span><input type="checkbox" checked={settings.defaultWriteMode} onChange={event => setSettings(previous => ({ ...previous, defaultWriteMode: event.target.checked }))} /></label>
          </section>
          <section className="settings-group" aria-label="执行端运行环境"><h3>执行端运行环境</h3>
            <p className="settings-description">当前：{nodeInfo?.source==='local'?`本机 Node.js ${nodeInfo.version}`:`AIROOM 自带 Node.js ${nodeInfo?.version??'检查中'}`}。npm 随工作台安装。</p>
            {nodeInfo?.local&&<label className="field">运行环境<select aria-label="执行端运行环境" value={settings.nodeRuntime??'bundled'} onChange={event=>setSettings(previous=>({...previous,nodeRuntime:event.target.value as 'bundled'|'local'}))}><option value="bundled">AIROOM 自带（默认）</option><option value="local" disabled={!nodeInfo.local.available}>本机 Node.js {nodeInfo.local.version}</option></select></label>}
            <small className="settings-note">{nodeInfo?.local?.detail??nodeInfo?.detail??'无需另装 Node.js。DSH 原生加载器不兼容时才使用经校验的官方便携备用环境。'}</small>
            <ThirdPartyLicenses invoke={invoke}/>
          </section>
          <section className="settings-group" aria-label="版本与本地数据"><h3>版本与本地数据</h3>
            <RunningVersionCard invoke={invoke} notify={notify} />
            <div className="field">本地记录位置<code className="data-directory">{snapshot.dataDirectory || '后端连接后显示'}</code><small>会话、任务状态和产物引用保存在本机。关闭窗口后可在托盘继续运行；退出应用会停止工作台任务。</small></div>
            <div><button className="button secondary small" onClick={() => void exportDiagnostics()}><Download size={14} />导出诊断记录</button></div>
          </section>
          <section className="settings-group" aria-label="备份"><BackupSettings invoke={invoke} notify={notify} available={snapshot.backendReady} onBusy={setBackupBusy} onRestored={onClose}/></section>
        </>}
      </div>
    </div>
    {tab === 'members' && editing ? <div className="modal-footer card-editor-footer" ref={setCardActions} /> : <div className="modal-footer"><span className="save-note"><LockKeyhole size={12} />人物卡和个人资料有各自的保存按钮</span><button className="button quiet" disabled={backupBusy} onClick={onClose}>取消</button><button className="button primary" disabled={busy || backupBusy || !snapshot.backendReady} onClick={() => void save()}>{busy ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}保存设置</button></div>}
  </Modal>;
}

const SOURCE_LABELS: Record<MemberVersions['source'], string> = { airoom: 'AIROOM 管理的版本', custom: '设置中指定的程序路径', global: '全局安装（会随你在终端的更新而变化）', bundled: 'AIROOM 内置版本' };
const INSTALL_PHASES:Record<MemberInstallation['phase'],string>={installing:'下载并安装',files:'检查安装文件',launch:'检查程序启动',connection:'检查账号与连接'};

/** Checks and completed runs refresh status; installing still requires the user's update button. */
export function VersionPanel({ provider, info, available, invoke, installing, onInstall, onSelectedPath }: { provider: ProviderId; info?:ProviderInfo; available:boolean; invoke: Invoke; installing?: { version: string; startedAt: number }; onInstall: (version: string | null) => void; onSelectedPath: (path: string | null) => void }) {
  const [state, setState] = useState<MemberVersions>();
  const [progress,setProgress]=useState<MemberInstallation>();
  const [readError,setReadError]=useState('');
  const [busy, setBusy] = useState<'check' | 'switch' | 'remove' | null>(null);
  const request=useRef(0);
  const installation=progress??state?.installation;
  const ongoing=Boolean(installing||installation);
  const now = useTicker(ongoing);
  const load = useCallback(async (checkLatest = false) => {
    if(!available)return;
    const ticket=++request.current;
    try {
      const next=await invoke<MemberVersions>('member.versions', { provider, checkLatest },undefined,{background:!checkLatest});setReadError('');
      setState(previous=>ticket===request.current?{...next,...(!checkLatest?{latest:previous?.latest,latestError:previous?.latestError}:{})}:checkLatest&&previous?{...previous,latest:next.latest,latestError:next.latestError}:previous);
    } catch {setReadError('版本状态暂未更新，请稍后重试。');}
  }, [invoke, provider,available]);
  useEffect(() => { void load(false); }, [load, installing?.version,info?.checkedAt,info?.stale,info?.compatibility?.id,info?.lastRunCompatibility?.id,info?.lastRunCompatibility?.completedAt]);
  useEffect(()=>{
    if(!available||!ongoing)return;
    let cancelled=false,pending=false;
    const poll=async()=>{
      if(pending)return;pending=true;
      try{
        const next=await invoke<MemberInstallation|undefined>('member.installation',{provider},undefined,{background:true});
        if(cancelled)return;
        setProgress(next);setState(previous=>previous?.installation?{...previous,installation:next}:previous);
        if(!next&&!installing)void load(false);
      }catch{}finally{pending=false;}
    };
    void poll();const timer=setInterval(()=>void poll(),2000);
    return()=>{cancelled=true;clearInterval(timer);};
  },[available,ongoing,Boolean(installing),invoke,provider,load]);
  useEffect(()=>()=>{request.current++;},[]);
  async function run(kind: 'check' | 'switch' | 'remove', action: () => Promise<unknown>) {
    setBusy(kind); try { await action(); } catch {} finally { setBusy(null); }
  }
  // Nothing to show until the backend reports an actual version state.
  if (!state || !Array.isArray(state.installed)) return readError?<p className="provider-detail" role="status">{readError}</p>:null;
  const currentVersion = state.current?.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/)?.[0];
  const newer = state.latest && state.latest !== currentVersion ? state.latest : undefined;
  const locked = Boolean(busy || ongoing || !available || info?.installationRequired);
  async function install(version: string) {
    onInstall(version);
    try {
      const next = await invoke<MemberVersions>('member.install', { provider, version });
      request.current++;setState(previous=>({...next,latest:previous?.latest,latestError:previous?.latestError}));
      if (!next.installedOnly) onSelectedPath(next.selectedPath);
    } catch {} finally { onInstall(null);setProgress(undefined);setState(previous=>previous?{...previous,installation:undefined}:previous);void load(false); }
  }
  const removable = state.installed.filter(version => version !== state.activeVersion);
  const elapsed = ongoing ? Math.max(0, Math.round((now - (installation?Date.parse(installation.startedAt):installing!.startedAt)) / 1000)) : 0;
  const phase=installation?.phase??'installing';
  const slow=installation?.phase==='installing'&&now-Date.parse(installation.lastProgressAt??installation.phaseStartedAt)>90_000;
  const connection=state.connection;
  const runProblem=state.lastRun&&['failed','unknown'].includes(state.lastRun.outcome);
  const status=connection.state==='failed'?'连接检查未通过':connection.state==='stale'?'等待重新确认':connection.state==='unchecked'?'待检查连接':runProblem?(state.lastRun!.outcome==='unknown'?'运行结果待核对':'最近运行失败'):state.successfulUse?'本版本已成功使用':'连接检查通过';
  const fixedVersion=currentVersion??state.baselineVersions.at(-1);
  return <div className="version-panel">
    {readError&&<p className="provider-detail" role="status">{readError}</p>}
    <div className="version-row"><span className="permission-label">版本</span>
      <span className="version-current">{currentVersion ?? '未检测'} <span className={`version-badge ${connection.state==='failed'||runProblem?'warn':connection.state==='connected'?'ok':'neutral'}`}>{status}</span></span>
      <button className="button small quiet" disabled={locked} onClick={() => void run('check', () => load(true))}>{busy === 'check' ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}检查更新</button>
    </div>
    <small className="version-note">{SOURCE_LABELS[state.source]}。AIROOM 不会自动更新成员，只在你点击后安装。</small>
    {connection.state==='failed'&&<small className="version-note error">{connection.detail}</small>}
    {runProblem&&state.lastRun?.error&&<small className="version-note error">最近运行：{state.lastRun.error}</small>}
    {ongoing && <div className="install-progress" role="status"><div className="install-progress-bar"><span /></div><span>{INSTALL_PHASES[phase]} {installation?.version??installing?.version} · 已用 {Math.floor(elapsed / 60)} 分 {elapsed % 60} 秒{phase==='installing'&&installation?.writtenBytes?` · 已展开 ${(installation.writtenBytes/1024/1024).toFixed(1)} MB`:''}。{slow?'文件暂时没有增长，正在等待下载或安装工具回应。':''}{phase==='installing'?'下载与安装最多等待 15 分钟。':'检查通过后切换版本。'}关闭设置也会继续。</span></div>}
    {state.latestError && <small className="version-note error">{state.latestError}</small>}
    {state.detail && <small className="version-note">{state.detail}</small>}
    {state.latest && !newer && <small className="version-note">已是最新版本（{state.latest}）。</small>}
    {newer && !ongoing && <div className="version-update">
      <span>可更新到 <strong>{newer}</strong></span>
      <button className="button small secondary" disabled={locked} onClick={() => void install(newer)}>{`更新到 ${newer}`}</button>
    </div>}
    {(state.installed.length > 0 || state.source !== 'bundled') && <div className="version-row">
      <span className="permission-label">切换</span>
      <select value={state.activeVersion ?? ''} disabled={locked} onChange={event => { const version = event.target.value; void run('switch', async () => { const next = await invoke<MemberVersions>('member.use', { provider, version: version || null }, '已切换版本。'); request.current++;setState(previous=>({...next,latest:previous?.latest,latestError:previous?.latestError})); onSelectedPath(next.selectedPath); }); }}>
        <option value="">{provider === 'claude' ? '全局安装的 Claude' : '内置版本'}</option>
        {state.installed.map(version => <option key={version} value={version}>{version}</option>)}
      </select>
    </div>}
    {removable.length > 0 && <details className="version-remove"><summary>清理旧版本（{removable.length}）</summary>{removable.map(version => <div className="version-row" key={version}><span>{version}</span><button className="button small quiet danger" disabled={locked} onClick={() => { if (window.confirm(`删除 AIROOM 管理的 ${PROVIDER_NAMES[provider]} ${version} 的程序目录及依赖？聊天记录和登录配置会保留，后续回复使用当前版本。`)) void run('remove', async () => setState(await invoke<MemberVersions>('member.remove', { provider, version }, `已删除 ${version}。`))); }}><Trash2 size={12} />删除</button></div>)}</details>}
    {provider === 'claude' && state.source === 'global' && fixedVersion && !ongoing && <small className="version-note">可以安装一份 AIROOM 管理的 Claude（{fixedVersion}），之后终端里的更新不会影响 AIROOM。<button className="link-button" disabled={locked} onClick={() => void install(fixedVersion)}>安装并固定</button></small>}
    <details className="version-diagnostics"><summary>版本诊断与使用记录</summary>
      <small className="version-note">兼容基线：{state.baselineVersions.join('、')||'暂无'}。基线用于排查问题，当前状态以实际检查和运行记录为准。</small>
      {connection.checkedAt&&<small className="version-note">连接确认：{new Date(connection.checkedAt).toLocaleString()}</small>}
      {state.successfulUse&&<><small className="version-note">本版本最近成功使用：{new Date(state.successfulUse.completedAt).toLocaleString()}。记录对应这一次任务。</small><small className="version-note">{effectiveConfigText(state.successfulUse.requestedConfig,state.successfulUse.effectiveConfig)}</small></>}
    </details>
  </div>;
}
