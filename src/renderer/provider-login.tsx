import {useEffect,useState} from 'react';
import {KeyRound,LogOut,LoaderCircle} from 'lucide-react';
import type {ProviderId} from '../shared/types';
import type {CatalogLoginState} from '../shared/executor-catalog';
import type {Invoke,Notify} from './ui';

export function ProviderLogin({provider,available,invoke,notify,beforeLogin}:{provider:ProviderId;available:boolean;invoke:Invoke;notify:Notify;beforeLogin:()=>Promise<void>}){
  const [state,setState]=useState<CatalogLoginState>(),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{let live=true,pending=false;const poll=async()=>{if(pending||!available)return;pending=true;try{const next=await invoke<CatalogLoginState|undefined>('provider.loginStatus',{provider},undefined,{background:true});if(live)setState(next);}catch{}finally{pending=false;}};void poll();const timer=setInterval(()=>void poll(),1000);return()=>{live=false;clearInterval(timer);};},[provider,invoke,available]);
  const active=state?.phase==='starting'||state?.phase==='waiting';
  async function action(kind:'login'|'cancelLogin'|'openLogin'|'logout'){
    setBusy(true);setError('');
    try{
      if(kind==='login')await beforeLogin();
      const result=await invoke<{detail?:string}>(`provider.${kind}`,{provider});
      if(kind==='login')setState({phase:'starting',message:result?.detail??'正在准备官方登录…'});
      if(kind==='cancelLogin')setState({phase:'cancelled',message:'登录已取消，可以重新登录。'});
      if(kind==='logout'){setState(undefined);notify('已从此执行端登出，聊天记录保留。');}
    }catch(error){setError(error instanceof Error?error.message:String(error));}finally{setBusy(false);}
  }
  return <div className="catalog-login" aria-label={`${provider} 账号登录`}>
    <div className="catalog-actions"><button type="button" className="button small secondary" disabled={!available||busy||active} onClick={()=>void action('login')}>{busy||active?<LoaderCircle size={12} className="spin"/>:<KeyRound size={12}/>}登录</button>
      {active&&<button type="button" className="button small quiet" disabled={busy||!available} onClick={()=>void action('cancelLogin')}>取消登录</button>}
      <button type="button" className="button small quiet danger" disabled={!available||busy||active} onClick={()=>{if(window.confirm('登出此执行端在 AIROOM 中的账号？使用它的成员需要重新登录，聊天记录会保留。'))void action('logout');}}><LogOut size={12}/>登出</button></div>
    {state&&<div className="provider-detail" role="status">{state.message}{state.phase==='waiting'&&state.url&&<button type="button" className="button small secondary" disabled={busy||!available} onClick={()=>void action('openLogin')}>打开官方授权页面</button>}</div>}
    {error&&<p className="provider-detail" role="alert">{error}</p>}
  </div>;
}
