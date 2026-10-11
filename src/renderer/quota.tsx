import { useState } from 'react';
import { Activity, RefreshCw } from 'lucide-react';
import type { AccountBalance, AccountWallet, MemberQuota, ProviderId, QuotaWindow, Snapshot } from '../shared/types';
import { balanceAmount, balanceExhausted, balanceFresh, quotaFresh } from '../shared/quota';
import { Modal } from './modals';
import { useTeam, Avatar } from './members';
import { errorText, useTicker, type Invoke } from './ui';

const resetText=(seconds:number)=>`${new Date(seconds*1000).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false})} 恢复`;

function visibleWindows(quota?:MemberQuota){
  const windows=quota?.windows??[],core=['5 小时','每周'].map(label=>windows.find(window=>window.label===label)||windows.find(window=>window.label.endsWith(` · ${label}`))||{id:label,label,checkedAt:''});
  return [...core,...windows.filter(window=>!core.some(item=>item.id===window.id))];
}
function tone(window:QuotaWindow,now:number){return !quotaFresh(window,now)?'stale':window.exhausted?'exhausted':window.warning||window.usedPercent!==undefined&&window.usedPercent>=80?'warning':'normal';}
function remaining(window:QuotaWindow,now:number){
  if(!window.checkedAt)return '未提供';
  if(!quotaFresh(window,now))return '待更新';
  if(window.exhausted&&window.usedPercent===undefined)return '已受限';
  return window.usedPercent===undefined?'未提供':`剩 ${Math.round((100-window.usedPercent)*10)/10}%`;
}
function detail(window:QuotaWindow,now:number){
  return `${window.label}：${remaining(window,now)}${window.usedPercent!==undefined?`，已用 ${Math.round(window.usedPercent*10)/10}%`:''}${window.resetsAt?`；${resetText(window.resetsAt)}`:''}${window.checkedAt?`；回报于 ${new Date(window.checkedAt).toLocaleTimeString('zh-CN')}`:'；成员程序还没有提供额度数据'}`;
}
const walletText=(wallet:AccountWallet)=>`${wallet.currency==='CNY'?'¥':'US$'}${balanceAmount(wallet.balance,wallet.currency==='CNY'?2:undefined)}`;
function balanceText(balance:AccountBalance|undefined,now:number){
  if(!balance||balance.status!=='ready'||!balance.wallets.length&&!balance.bonusWallets.length)return '未提供';
  if(!balanceFresh(balance,now))return '待更新';
}
function balanceRows(balance:AccountBalance){
  return [{label:'充值',wallets:balance.wallets},{label:'赠送',wallets:balance.bonusWallets}].flatMap(group=>group.wallets.map((wallet,index)=>({label:group.label,wallet,key:`${group.label}-${wallet.currency}-${index}`})));
}
function BalanceMeter({balance,now}:{balance?:AccountBalance;now:number}){
  const text=balanceText(balance,now);
  if(text)return <span className="quota-unavailable">余额 · {text}</span>;
  return <span className={`quota-mini balance-mini${balanceExhausted(balance,now)?' exhausted':''}`} aria-label="账户剩余余额">{balanceRows(balance!).map(row=><span className="balance-line" key={row.key} title={`${row.label}余额 ${walletText(row.wallet)}；更新于 ${new Date(balance!.checkedAt).toLocaleTimeString('zh-CN')}`}><span>{row.label}</span><span>{walletText(row.wallet)}</span></span>)}</span>;
}
function BalanceDetails({balance,now}:{balance?:AccountBalance;now:number}){
  const text=balanceText(balance,now);
  return <div className="balance-detail">{text?<p className="panel-muted">账户余额：{text}{text==='待更新'?'，请刷新余额。':'，账号服务暂未返回可验证的数据。'}</p>:balanceRows(balance!).map(row=><div className="balance-wallet" key={row.key}><span>{row.label}余额 · {row.wallet.currency==='CNY'?'人民币':'美元'}</span><strong>{walletText(row.wallet)}</strong></div>)}<small>按 API 扣费，充值和赠送余额分别显示；自动发言以两位小数的余额为准。{balanceExhausted(balance,now)?'余额已耗尽，自动发言已暂停。':''}</small></div>;
}
export function QuotaMeter({provider,quota}:{provider:ProviderId;quota?:MemberQuota}){
  const tick=useTicker(true,30000),now=Math.max(tick,Date.now());
  if(provider==='dsh')return <BalanceMeter balance={quota?.balance} now={now}/>;
  if(provider!=='codex'&&provider!=='claude'&&!quota)return <span className="quota-unavailable">程序未提供额度</span>;
  if(!visibleWindows(quota).some(window=>window.checkedAt))return <span className="quota-unavailable">还没有额度数据，可在“用量与额度”中刷新</span>;
  return <span className="quota-mini" aria-label="成员剩余额度">{visibleWindows(quota).slice(0,2).map(window=><span key={window.id} className={`quota-line ${tone(window,now)}`} title={detail(window,now)}><span>{window.label.includes('5 小时')?'5 小时':'每周'}</span><span>{remaining(window,now)}</span><span className="quota-track" aria-hidden="true"><i style={{width:`${quotaFresh(window,now)&&window.usedPercent!==undefined?100-window.usedPercent:0}%`}} /></span></span>)}</span>;
}
/** Compact sidebar indicator: only real, fresh data is shown; "not provided" lives in the usage dialog. */
export function QuotaBadge({provider,quota}:{provider:ProviderId;quota?:MemberQuota}){
  const tick=useTicker(true,30000),now=Math.max(tick,Date.now());
  if(provider==='dsh'){
    const balance=quota?.balance;
    if(balanceText(balance,now))return null;
    const first=balanceRows(balance!)[0];if(!first)return null;
    return <span className={`quota-badge balance${balanceExhausted(balance,now)?' exhausted':''}`} title={balanceRows(balance!).map(row=>`${row.label}余额 ${walletText(row.wallet)}`).join('；')}>{walletText(first.wallet)}</span>;
  }
  const windows=(quota?.windows??[]).filter(window=>quotaFresh(window,now)&&(window.usedPercent!==undefined||window.exhausted));
  if(!windows.length)return null;
  const tightest=windows.reduce((a,b)=>(b.exhausted?101:b.usedPercent??0)>(a.exhausted?101:a.usedPercent??0)?b:a);
  const left=tightest.exhausted?0:100-(tightest.usedPercent??0);
  return <span className={`quota-badge ${tone(tightest,now)}`} title={windows.map(window=>detail(window,now)).join('\n')} aria-label={`剩余额度 ${Math.round(left)}%`}><span className="quota-track" aria-hidden="true"><i style={{width:`${left}%`}}/></span></span>;
}
export function QuotaOverview({snapshot,invoke,onClose}:{snapshot:Snapshot;invoke:Invoke;onClose:()=>void}){
  const team=useTeam(),tick=useTicker(true,30000),now=Math.max(tick,Date.now());
  const [refreshing,setRefreshing]=useState<ProviderId>(),[errors,setErrors]=useState<Partial<Record<ProviderId,string>>>({});
  async function refresh(provider:ProviderId){if(refreshing)return;setRefreshing(provider);setErrors(previous=>({...previous,[provider]:''}));try{await invoke(provider==='dsh'?'provider.balance':'provider.quota',{provider});}catch(error){setErrors(previous=>({...previous,[provider]:errorText(error)}));}finally{setRefreshing(undefined);}}
  return <Modal title="用量与额度" subtitle="按成员程序的实际回报显示。使用同一个程序的成员共用账号额度。" onClose={onClose} className="quota-modal">
    <div className="modal-body">{team.members.map(member=>{
      const quota=snapshot.quotas?.[member.executor],windows=visibleWindows(quota);
      return <section className="quota-card" aria-label={`${member.name} 的额度`} key={member.id}><div className="quota-card-heading"><Avatar member={member} size={30}/><strong>{member.name}</strong><small>{quota?`更新于 ${new Date(quota.checkedAt).toLocaleTimeString('zh-CN')}`:'等待程序回报'}</small></div>
        {member.executor==='dsh'?<BalanceDetails balance={quota?.balance} now={now}/>:member.executor!=='codex'&&member.executor!=='claude'&&!quota?<p className="panel-muted">这个成员程序尚未提供可验证的额度数据。</p>:!windows.some(window=>window.checkedAt)?(member.executor==='claude'&&snapshot.claudeTokenConfigured?null:<p className="panel-muted">还没有额度数据，点“刷新额度”查询。</p>):windows.map(window=><div className={`quota-detail ${tone(window,now)}`} key={window.id}><div><span>{window.label}</span><strong>{remaining(window,now)}</strong></div><span className="quota-track"><i style={{width:`${quotaFresh(window,now)&&window.usedPercent!==undefined?100-window.usedPercent:0}%`}} /></span><small>{window.usedPercent!==undefined?`已用 ${Math.round(window.usedPercent*10)/10}% · `:''}{window.resetsAt?resetText(window.resetsAt):'恢复时间未提供'}{tone(window,now)==='warning'?' · 额度较低，自由讨论会减少自动点名':tone(window,now)==='exhausted'?' · 额度受限，自动发言已暂停':tone(window,now)==='stale'&&window.checkedAt?' · 回报已过期，等待更新':''}</small></div>)}
        {member.executor==='claude'&&snapshot.claudeTokenConfigured?<p className="panel-muted">Claude 用长期令牌登录时不能单独查询额度。{member.name} 下次发言或做任务后，这里会自动显示最新额度。</p>
          :['codex','claude'].includes(member.executor)&&quota?.queryStatus==='unavailable'&&<p className="panel-muted">已查询，{member.name} 暂未提供订阅额度数据。请检查连接或稍后重试。</p>}
        {(member.executor!=='claude'||!snapshot.claudeTokenConfigured)&&['dsh','claude','codex'].includes(member.executor)&&<><button type="button" className="button secondary small balance-refresh" disabled={!!refreshing} onClick={()=>void refresh(member.executor)}><RefreshCw size={13}/>{refreshing===member.executor?'正在查询…':member.executor==='dsh'?'刷新余额':'刷新额度'}</button>{errors[member.executor]&&<p className="inline-error" role="alert">{errors[member.executor]}</p>}</>}
      </section>;
    })}<p className="quota-explanation"><Activity size={14}/>显示最近一次账号回报；未提供或已过期的数据不计作零余额或零用量。订阅额度已用达到 80% 时减少自动点名，达到 100% 时暂停自动调用。</p></div>
    <div className="modal-footer"><button type="button" className="button secondary" onClick={onClose}>关闭</button></div>
  </Modal>;
}
