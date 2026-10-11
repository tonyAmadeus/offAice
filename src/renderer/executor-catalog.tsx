import { useCallback, useEffect, useState } from 'react';
import { Download, KeyRound, LoaderCircle, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { CATALOG_REVISION, EXECUTOR_CATALOG, catalogEntry, catalogProvider, type CatalogId, type CatalogStatus, type NodeRuntimeInfo, type CatalogLoginState } from '../shared/executor-catalog';
import { isAcpId } from '../shared/defaults';
import type { AcpExecutor, PermissionMember, Snapshot } from '../shared/types';
import type { MemberInstallation } from '../shared/member-versions';
import { AcpFields, emptyAcpDraft } from './executors';
import type { Invoke, Notify } from './ui';

const PHASES={installing:'下载与安装',files:'校验安装文件',launch:'检查程序启动',connection:'检查连接与登录状态'};
type CatalogReply={revision:string;items:CatalogStatus[];node:NodeRuntimeInfo};
const catalogReads=new WeakMap<Invoke,Promise<CatalogReply>>();
function readCatalog(invoke:Invoke){const pending=catalogReads.get(invoke);if(pending)return pending;const task=invoke<CatalogReply>('catalog.list',{},undefined,{background:true}).finally(()=>{if(catalogReads.get(invoke)===task)catalogReads.delete(invoke);});catalogReads.set(invoke,task);return task;}
const loginReads=new WeakMap<Invoke,Map<string,Promise<CatalogLoginState|undefined>>>();
function readLoginStatus(invoke:Invoke,id:string){
  let reads=loginReads.get(invoke);if(!reads){reads=new Map();loginReads.set(invoke,reads);}
  const existing=reads.get(id);if(existing)return existing;
  const task=invoke<CatalogLoginState|undefined>('executor.loginStatus',{id},undefined,{background:true}).finally(()=>{if(reads!.get(id)===task)reads!.delete(id);});reads.set(id,task);return task;
}
export function ExecutorCatalog({snapshot,invoke,notify,beforeOperation,onSelected,onNewMember}:{snapshot:Snapshot;invoke:Invoke;notify:Notify;beforeOperation:()=>Promise<void>;onSelected:(item:CatalogStatus)=>void;onNewMember:(provider:PermissionMember)=>void}){
  const [view,setView]=useState<'closed'|'catalog'|'manual'>(!snapshot.providers.some(item=>item.path)?'catalog':'closed'),[items,setItems]=useState<CatalogStatus[]>(()=>EXECUTOR_CATALOG.map(entry=>({entry,provider:catalogProvider(entry.id),installed:[],configured:false,consented:false}))),[selected,setSelected]=useState<CatalogId>(),[loading,setLoading]=useState(true),[loadError,setLoadError]=useState(''),[progressError,setProgressError]=useState('');
  const [version,setVersion]=useState(''),[agree,setAgree]=useState(false),[busy,setBusy]=useState(''),[progress,setProgress]=useState<MemberInstallation>(),[result,setResult]=useState('');
  const [draft,setDraft]=useState(emptyAcpDraft);
  const reload=useCallback(async()=>{setLoading(true);setLoadError('');try{const value=await invoke<CatalogReply>('catalog.list',undefined,undefined,{background:true});if(!value||!Array.isArray(value.items))throw new Error('执行端清单暂未返回。');setItems(value.items);return value.items;}catch(error){setLoadError((error as Error).message);throw error;}finally{setLoading(false);}},[invoke]);
  useEffect(()=>{if(view==='catalog')void reload().catch(()=>{});},[view,reload]);
  useEffect(()=>{
    if(!selected||busy!=='install')return;
    let live=true,pending=false;setProgressError('');const check=async()=>{if(pending)return;pending=true;try{const value=await invoke<MemberInstallation|undefined>('catalog.installation',{id:selected},undefined,{background:true});if(live){setProgress(value);setProgressError('');}}catch{if(live)setProgressError('暂时无法读取进度，下载可能仍在继续；正在等待下一次状态更新。');}finally{pending=false;}};void check();const timer=setInterval(()=>void check(),1500);return()=>{live=false;clearInterval(timer);};
  },[selected,busy,invoke]);
  const item=items.find(item=>item.entry.id===selected),entry=item?.entry,provider=item?.provider;
  const choose=(id:CatalogId)=>{setSelected(id);setVersion(EXECUTOR_CATALOG.find(item=>item.id===id)!.recommendedVersion);setAgree(false);setResult('');setProgress(undefined);};
  async function action(kind:'install'|'use'|'remove'|'latest',chosen=version){
    if(!selected)return;setBusy(kind);setResult('');
    try{
      await beforeOperation();
      if(kind==='latest'){const latest=await invoke<{version:string}>('catalog.latest',{id:selected});setVersion(latest.version);setResult(`最新版本 ${latest.version}，下载前仍会校验并检查连接。`);}
      else{
        const value=await invoke<CatalogStatus>(`catalog.${kind}`,{id:selected,version:chosen,agree,revision:CATALOG_REVISION});
        if(kind!=='remove')onSelected(value);
        await reload();setResult(kind==='remove'?'该版本已删除。':'程序已配置。完成下面的登录后即可使用；连接检查没有发送模型任务。');
      }
    }catch(error){setResult((error as Error).message);}finally{setBusy('');setProgress(undefined);}
  }
  async function manual(){setBusy('manual');try{const saved=await invoke<AcpExecutor>('executor.save',{executor:draft});setDraft(emptyAcpDraft);setView('closed');notify('连接已添加，可以创建人物卡。');onNewMember(saved.id);}catch{}finally{setBusy('');}}
  const info=snapshot.providers.find(info=>info.id===provider),executor=snapshot.executors?.find(executor=>executor.id===provider);
  return <section className="catalog-settings" data-provider="catalog" aria-label="添加执行端">
    <div className="settings-section-heading"><h3>添加执行端</h3></div>
    <p className="settings-description">选择官方程序，下载到 AIROOM 后再登录。已有安装可以继续使用。</p>
    <div className="catalog-actions"><button className="button secondary" onClick={()=>setView(view==='catalog'?'closed':'catalog')} disabled={!!busy}><Download size={14}/>从清单添加</button><button className="button quiet" onClick={()=>setView(view==='manual'?'closed':'manual')} disabled={!!busy}><Plus size={14}/>手动添加</button></div>
    {view==='manual'&&<div className="catalog-detail"><AcpFields value={draft} onChange={setDraft} invoke={invoke}/><button className="button primary" disabled={!!busy||!snapshot.backendReady||!draft.command.trim()||!draft.name.trim()} onClick={()=>void manual()}>保存连接并创建人物卡</button></div>}
    {view==='catalog'&&<div className="catalog-detail">
      {loading&&<p className="provider-detail" role="status">正在读取已安装版本…</p>}{loadError&&<p className="provider-detail" role="status">{loadError}<button className="link-button" onClick={()=>void reload().catch(()=>{})}>重新读取清单</button></p>}
      <div className="catalog-grid" role="group" aria-label="官方执行端清单">{items.map(item=><button key={item.entry.id} className={`catalog-choice ${selected===item.entry.id?'selected':''}`} disabled={!!busy} onClick={()=>choose(item.entry.id)}><strong>{item.entry.name}</strong><small>{item.entry.vendor} · {item.entry.license}</small><small>{item.selectedVersion?`正在使用 ${item.selectedVersion}`:item.configured?'已有连接':`推荐 ${item.entry.recommendedVersion}`}</small></button>)}</div>
      {entry&&item&&<>
        <h4>{entry.name} · {entry.vendor}</h4>
        <p><a href={entry.homepage} onClick={event=>{event.preventDefault();void invoke('catalog.openLink',{id:entry.id,kind:'homepage'}).catch(()=>{});}}>官方主页</a> · <a href={entry.licenseUrl} onClick={event=>{event.preventDefault();void invoke('catalog.openLink',{id:entry.id,kind:'licenseUrl'}).catch(()=>{});}}>{entry.license} 许可证</a> · <a href={entry.termsUrl} onClick={event=>{event.preventDefault();void invoke('catalog.openLink',{id:entry.id,kind:'termsUrl'}).catch(()=>{});}}>厂商条款</a></p>
        <p className="provider-detail">{entry.capabilities.join(' · ')}。{entry.limitations.join(' ')}</p>
        <p className="provider-detail">{entry.id==='cursor'?'运行环境：官方包自带 Node.js':`最低 Node.js：${entry.minimumNode}`}；已通过隔离连接检查的版本：{entry.verifiedVersions.join('、')||'本版尚无记录'}。真实账号调用需另行验收。</p>
        <p className="provider-detail">登录方式：{entry.authentication.map(item=>item.label).join(' / ')}。{entry.distribution==='zcode-official'?'安装来源：ZCode 官方 Windows 发行包；下载后核对官方 SHA-512。':entry.distribution==='qoder-official'?'安装来源：Qoder 官方原生 Windows 发行包；下载后核对官方 SHA-256。':entry.distribution==='cursor-official'?'安装来源：Cursor 官方 Windows 发行包；独立保存运行环境并核对安装文件清单。':`安装来源：${entry.packageName}；当前下载源：${snapshot.settings.npmRegistry==='npmmirror'?'npmmirror（与官方完整性记录核对）':'npm 官方源'}。`}</p>
        <label className="catalog-consent"><input type="checkbox" checked={agree} onChange={event=>setAgree(event.target.checked)} disabled={!!busy}/>我已了解并同意该厂商条款</label>
        <label className="field compact">下载版本<input aria-label="执行端下载版本" value={version} onChange={event=>setVersion(event.target.value)} disabled={!!busy}/></label>
        <div className="catalog-actions"><button className="button primary" disabled={loading||!!loadError||!!busy||!agree||!snapshot.backendReady||!version.trim()} onClick={()=>void action('install')}>{busy==='install'?<LoaderCircle className="spin" size={14}/>:<Download size={14}/>}下载并自动配置</button><button className="button quiet" disabled={loading||!!loadError||!!busy||!snapshot.backendReady} onClick={()=>void action('latest')}><RefreshCw size={14}/>检查新版本</button></div>
        {busy==='install'&&<div className="install-progress" role="status"><div className="install-progress-bar"><span/></div><p>{PHASES[progress?.phase??'installing']} {version}{progress?.writtenBytes?` · 已展开 ${(progress.writtenBytes/1048576).toFixed(1)} MB`:''}。{progress?.detail}关闭设置也会继续，下载最多等待 15 分钟。</p></div>}
        {result&&<p role="status" className="provider-detail">{result}</p>}
        {busy==='install'&&progressError&&<p role="status" className="provider-detail">{progressError}</p>}
        {item.configured&&<>
          <h4>登录</h4><p className="provider-detail">{info?.detail??'等待检查。'}</p>
          {executor?<CatalogLogin key={executor.id} executor={executor} snapshot={snapshot} invoke={invoke} notify={notify}/>:<p className="provider-detail">请在下方 {entry.name} 的连接设置中选择登录方式并登录。</p>}
          <button className="button secondary" disabled={!!busy||!snapshot.backendReady} onClick={()=>onNewMember(provider as PermissionMember)}><Plus size={14}/>用这个执行端创建人物卡</button>
        </>}
        <h4>版本管理</h4>
        {item.installed.length?item.installed.map(installed=><div className="catalog-version" key={installed}><span>{installed}{item.selectedVersion===installed?' · 正在使用':''}</span><button className="button small secondary" disabled={!!busy||installed===item.selectedVersion||!snapshot.backendReady||!agree&&!item.consented} onClick={()=>void action('use',installed)}>切换 / 回退</button><button className="button small quiet danger" disabled={!!busy||installed===item.selectedVersion||!snapshot.backendReady} onClick={()=>{if(window.confirm(`删除 ${entry.name} ${installed} 的程序文件？聊天记录和登录配置会保留，后续回复使用当前版本。`))void action('remove',installed);}}><Trash2 size={12}/>删除版本</button></div>):<p className="provider-detail">尚未下载托管版本。手动添加的连接保持原样。</p>}
      </>}
    </div>}
  </section>;
}
export function CatalogLogin({executor,snapshot,invoke,notify}:{executor:AcpExecutor;snapshot:Snapshot;invoke:Invoke;notify:Notify}){
  const entry=catalogEntry(executor.catalogId);
  const [authId,setAuthId]=useState(executor.authentication??(entry.id==='zcode'?'zai':entry.authentication[0].id)),[key,setKey]=useState(''),[model,setModel]=useState(executor.env.OPENAI_MODEL??executor.env.KIMI_MODEL_NAME??executor.model??''),[baseUrl,setBaseUrl]=useState(executor.env.OPENAI_BASE_URL??''),[busy,setBusy]=useState(false);
  const auth=entry.authentication.find(item=>item.id===authId)!;
  const modelOptions=entry.id==='opencode'?(snapshot.providers.find(info=>info.id===executor.id)?.modelOptions??[]).filter(option=>option.id.startsWith(authId+'/')):[];
  const [customModel,setCustomModel]=useState(false);
  const [login,setLogin]=useState<CatalogLoginState>(),[statusError,setStatusError]=useState('');
  useEffect(()=>{let live=true,pending=false;const check=async()=>{if(pending)return;pending=true;try{const state=await readLoginStatus(invoke,executor.id);if(live){setLogin(state);setStatusError('');}}catch{if(live)setStatusError('登录状态暂未更新，稍后会再次检查。');}finally{pending=false;}};void check();const timer=setInterval(()=>void check(),1500);return()=>{live=false;clearInterval(timer);};},[executor.id,invoke]);
  const loggingIn=login?.phase==='starting'||login?.phase==='waiting';
  async function save(clear=false){const value=key;setKey('');setBusy(true);try{
    await invoke('catalog.credentials',{id:entry.id,authentication:auth.id,...(value?{value}:{}),clear,model,baseUrl});
    if(entry.id==='zcode'&&!clear){const catalog=await invoke<CatalogReply>('catalog.list'),status=catalog.items.find(item=>item.entry.id==='zcode');if(status?.needsRepair&&status.selectedVersion){notify('正在补齐 ZCode 官方登录资源，下载校验完成后继续授权。');await invoke('catalog.install',{id:'zcode',version:status.selectedVersion,revision:CATALOG_REVISION});}}
    if(auth.kind==='browser'&&!clear)await invoke('executor.authenticate',{id:executor.id,methodId:auth.id});
    else await invoke('provider.probe',{provider:executor.id});
    notify(clear?'已清除密钥。':auth.kind==='api'?'密钥已加密保存。真实模型调用仍需验证。':'官方登录流程已结束，请核对连接状态。');
  }catch{}finally{setBusy(false);}}
  return <div className="catalog-login">
    <label className="field compact">登录方式<select aria-label="登录方式" value={authId} onChange={event=>{setAuthId(event.target.value);setKey('');if(entry.id==='opencode')setModel('');}} disabled={busy||loggingIn}>{entry.authentication.map(auth=><option key={auth.id} value={auth.id}>{auth.label}</option>)}</select></label>
    {auth.kind==='api'&&<>
      <p className="provider-detail">{auth.description??(auth.billing==='subscription'?'使用所选账号的订阅额度。':'按所选厂商 API 用量计费。')}密钥由 Windows 加密保存，只在运行该程序时传入。{executor.secretKeys?.length?'已有密钥；留空保留。':''}</p>
      <label className="field compact">{auth.secretLabel??'API Key'}<input type="password" autoComplete="off" aria-label={`${entry.name} API Key`} value={key} onChange={event=>setKey(event.target.value)} disabled={busy||loggingIn}/><small>{auth.secretKeys?.join('、')}</small></label>
      {(auth.modelRequired||entry.id==='opencode')&&<label className="field compact">模型
        {entry.id==='opencode'&&modelOptions.length>0&&<select aria-label="OpenCode 模型" value={customModel?'__custom':model} onChange={event=>{setCustomModel(event.target.value==='__custom');if(event.target.value!=='__custom')setModel(event.target.value);}} disabled={busy||loggingIn}><option value="">提供方默认</option>{modelOptions.map(option=><option key={option.id} value={option.id}>{option.label} · {option.id}</option>)}{model&&!modelOptions.some(option=>option.id===model)&&<option value={model}>{model}</option>}<option value="__custom">手动填写模型</option></select>}
        {(entry.id!=='opencode'||!modelOptions.length||customModel)&&<input aria-label={`${entry.name} API 模型`} value={model} onChange={event=>setModel(event.target.value)} placeholder={entry.id==='opencode'?`${authId}/模型；留空使用提供方默认`:''}/>}
        {entry.id==='opencode'&&<small>{modelOptions.length?`当前提供方已列出 ${modelOptions.length} 个模型，由 OpenCode 返回。`:'保存当前提供方的密钥并检查连接后，会列出 OpenCode 返回的模型。'}</small>}
      </label>}
      {entry.id==='qwen'&&<label className="field compact">API 服务地址<input aria-label="Qwen API 服务地址" value={baseUrl} onChange={event=>setBaseUrl(event.target.value)} placeholder="https://你的服务/v1"/></label>}
    </>}
    {auth.kind==='browser'&&auth.description&&<p className="provider-detail">{auth.description}</p>}
    <div className="catalog-actions"><button className="button secondary" disabled={busy||loggingIn||!snapshot.backendReady||auth.kind==='api'&&!key&&!executor.secretKeys?.length} onClick={()=>void save()}>{busy?<LoaderCircle className="spin" size={13}/>:<KeyRound size={13}/>}{auth.kind==='api'?'保存密钥并检查':'官方浏览器登录'}</button>{auth.kind==='api'&&!!executor.secretKeys?.length&&<button className="button quiet danger" disabled={busy||loggingIn||!snapshot.backendReady} onClick={()=>void save(true)}>清除密钥</button>}</div>
    {entry.id==='opencode'&&<button className="button quiet" disabled={busy||loggingIn||!snapshot.backendReady||authId!==executor.authentication} onClick={()=>{setBusy(true);void invoke('provider.probe',{provider:executor.id}).then(()=>notify('模型清单已按当前提供方重新读取。')).catch(()=>{}).finally(()=>setBusy(false));}}><RefreshCw size={13}/>刷新模型清单</button>}
    {login&&<div className="provider-detail" role="status"><p>{login.message}</p>{login.code&&<p>授权码：<strong>{login.code}</strong></p>}{login.phase==='waiting'&&login.url&&<button className="button secondary" onClick={()=>void invoke('executor.openLogin',{id:executor.id}).catch(()=>{})}>打开官方授权页面</button>}{loggingIn&&<button className="button quiet" onClick={()=>void invoke('executor.cancelLogin',{id:executor.id}).catch(()=>{})}>取消登录</button>}</div>}
    {statusError&&<p className="provider-detail" role="status">{statusError}</p>}
  </div>;
}

/** Installed catalog executors expose update checks where their connection is configured. */
export function CatalogVersionPanel({executor,snapshot,invoke}:{executor:AcpExecutor;snapshot:Snapshot;invoke:Invoke}) {
  const entry=catalogEntry(executor.catalogId);
  const [status,setStatus]=useState<CatalogStatus>(),[latest,setLatest]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(''),[agree,setAgree]=useState(false),[progress,setProgress]=useState<MemberInstallation>();
  const reload=useCallback(async()=>{const result=await readCatalog(invoke);setStatus(result.items.find(item=>item.entry.id===entry.id));},[invoke,entry.id]);
  useEffect(()=>{let live=true;void readCatalog(invoke).then(result=>{if(live)setStatus(result.items.find(item=>item.entry.id===entry.id));}).catch(()=>{});return()=>{live=false;};},[invoke,entry.id,executor.command,snapshot.backendReady]);
  useEffect(()=>{
    if(busy!=='install')return;let live=true,pending=false;
    const poll=async()=>{if(pending)return;pending=true;try{const value=await invoke<MemberInstallation|undefined>('catalog.installation',{id:entry.id},undefined,{background:true});if(live)setProgress(value);}catch{}finally{pending=false;}};
    void poll();const timer=setInterval(()=>void poll(),1500);return()=>{live=false;clearInterval(timer);};
  },[busy,entry.id,invoke]);
  async function action(kind:'latest'|'install'|'use'|'remove',version?:string){
    setBusy(kind);setMessage('');
    try{
      if(kind==='latest'){
        const result=await invoke<{version:string}>('catalog.latest',{id:entry.id});setLatest(result.version);
        setMessage(result.version===status?.selectedVersion?`已是最新版本 ${result.version}。`:`最新版本 ${result.version}，可下载后切换使用。`);
      }else{
        await invoke(`catalog.${kind}`,{id:entry.id,version,agree:agree||status?.consented,revision:CATALOG_REVISION});
        await reload();setMessage(kind==='remove'?'旧版本程序目录已删除，聊天记录和登录配置已保留。':kind==='use'?'已切换版本，原聊天将使用当前版本继续。':'新版已安装并检查；原聊天使用当前版本，登录配置和记录保留。');
      }
    }catch(error){setMessage((error as Error).message);}finally{setBusy('');setProgress(undefined);}
  }
  const locked=!!busy||!snapshot.backendReady,consented=agree||status?.consented;
  return <div className="version-panel" aria-label={`${executor.name} 版本管理`}>
    <div className="version-row"><span className="permission-label">当前版本</span><strong>{status?.selectedVersion??'手动指定的安装'}</strong><button className="button small quiet" aria-label={`${executor.name} 检查新版本`} disabled={locked} onClick={()=>void action('latest')}><RefreshCw size={13} className={busy==='latest'?'spin':''}/>检查新版本</button></div>
    {message&&<p className="version-note" role="status">{message}</p>}
    {!status?.consented&&latest&&<label className="catalog-consent"><input type="checkbox" checked={agree} disabled={locked} onChange={event=>setAgree(event.target.checked)}/>我已了解并同意<a href={entry.termsUrl} onClick={event=>{event.preventDefault();void invoke('catalog.openLink',{id:entry.id,kind:'termsUrl'}).catch(()=>{});}}>厂商条款</a></label>}
    {latest&&latest!==status?.selectedVersion&&<button className="button small secondary" disabled={locked||!consented} onClick={()=>void action('install',latest)}><Download size={13}/>{`更新到 ${latest}`}</button>}
    {busy==='install'&&<p className="version-note" role="status">{PHASES[progress?.phase??'installing']} {latest}。关闭设置后仍会继续。</p>}
    {!!status?.installed.length&&<details className="version-remove" onToggle={event=>{if(event.currentTarget.open)void reload().catch(()=>{});}}><summary>版本切换与清理（{status.installed.length}）</summary>
      <p className="version-note">每个版本独立安装。删除旧版会删除其程序目录；聊天记录和登录配置另行保留。</p>
      {status.installed.map(version=><div className="version-row" key={version}><span>{version}{version===status.selectedVersion?' · 正在使用':''}</span><button className="button small secondary" disabled={locked||version===status.selectedVersion||!consented} onClick={()=>void action('use',version)}>切换 / 回退</button><button className="button small quiet danger" aria-label={`${executor.name} 删除版本 ${version}`} disabled={locked||version===status.selectedVersion} onClick={()=>{if(window.confirm(`删除 ${entry.name} ${version} 的程序目录及依赖？聊天记录和登录配置会保留。`))void action('remove',version);}}><Trash2 size={12}/>删除版本</button></div>)}
    </details>}
  </div>;
}
export function ThirdPartyLicenses({invoke}:{invoke:Invoke}){const [text,setText]=useState('');return <details className="third-party-licenses"><summary>第三方软件许可与条款</summary><p className="provider-detail">执行端由用户从官方源下载，账号和服务条款由各厂商提供。AIROOM 附带 npm（Artistic-2.0）与 7-Zip 解压程序（LGPL-2.1-or-later）；7-Zip 对应源码和许可文本随安装包提供。Node.js / Electron 的许可文本随运行环境提供。</p>{EXECUTOR_CATALOG.map(entry=><p key={entry.id}>{entry.name} · <a href={entry.licenseUrl} onClick={event=>{event.preventDefault();void invoke('catalog.openLink',{id:entry.id,kind:'licenseUrl'}).catch(()=>{});}}>{entry.license}</a> · <a href={entry.termsUrl} onClick={event=>{event.preventDefault();void invoke('catalog.openLink',{id:entry.id,kind:'termsUrl'}).catch(()=>{});}}>条款</a></p>)}<button className="button quiet" onClick={()=>void fetch('third-party-licenses.txt').then(response=>{if(!response.ok)throw new Error('许可证文件未找到');return response.text();}).then(setText).catch(error=>setText(error.message))}>查看随安装包附带的开源许可证全文</button>{text&&<pre className="license-full-text">{text}</pre>}</details>;}
