import type {CatalogLoginState} from '../shared/executor-catalog';

/** An attempt owns its status, deadline and URL. Late events cannot revive a cancelled login. */
export class ProviderLoginState {
  private attempts=new Map<string,{token:symbol;state:CatalogLoginState;timer:ReturnType<typeof setTimeout>}>();
  constructor(private expired:(provider:string)=>void,private readyMs=30_000,private authorizationMs=5*60_000){}
  get(provider:string){return this.attempts.get(provider)?.state;}
  begin(provider:string){
    if(this.active(provider))throw new Error('登录正在进行，请完成或取消后再重试。');
    const previous=this.attempts.get(provider);if(previous)clearTimeout(previous.timer);
    const token=Symbol(provider),timer=setTimeout(()=>this.timeout(provider,token),this.readyMs);
    timer.unref();this.attempts.set(provider,{token,state:{phase:'starting',message:'正在准备官方登录…'},timer});return token;
  }
  active(provider:string){return ['starting','waiting'].includes(this.get(provider)?.phase??'');}
  update(provider:string,token:symbol,state:CatalogLoginState){
    const attempt=this.attempts.get(provider);if(attempt?.token!==token||!this.active(provider))return false;
    if(state.phase==='waiting'&&attempt.state.phase==='waiting')return this.assign(attempt,state);
    if(state.phase!=='starting'){
      clearTimeout(attempt.timer);
      if(state.phase==='waiting'&&attempt.state.phase!=='waiting'){
        attempt.timer=setTimeout(()=>this.timeout(provider,token),this.authorizationMs);attempt.timer.unref();
      }
    }
    return this.assign(attempt,state);
  }
  private assign(attempt:{state:CatalogLoginState},state:CatalogLoginState){attempt.state=state;return true;}
  cancel(provider:string){const attempt=this.attempts.get(provider);if(!attempt)return;clearTimeout(attempt.timer);attempt.state={phase:'cancelled',message:'登录已取消，可以重新登录。'};}
  clear(provider:string){this.cancel(provider);this.attempts.delete(provider);}
  checked(provider:string,token:symbol,message:string){
    const attempt=this.attempts.get(provider);
    if(attempt?.token!==token||attempt.state.phase!=='completed')return false;
    attempt.state={phase:'completed',message};return true;
  }
  /** A login reported as unfinished may still have stored the account; the connection check that follows settles it. */
  settleUnfinished(provider:string,token:symbol,state:CatalogLoginState){
    const attempt=this.attempts.get(provider);
    if(attempt?.token!==token||attempt.state.phase!=='failed')return false;
    attempt.state=state;return true;
  }
  private timeout(provider:string,token:symbol){
    // A first start (fresh install, cold cache) can outlast the preparation hint: keep the program
    // running and say so. Only the authorization deadline ends the attempt.
    if(this.attempts.get(provider)?.token===token&&this.get(provider)?.phase==='starting'){
      this.update(provider,token,{phase:'waiting',message:'官方登录页面还在准备，首次启动会慢一些。浏览器打开授权页后请完成授权；长时间没有打开可以取消后重试。'});
      return;
    }
    if(this.update(provider,token,{phase:'failed',message:'官方授权等待超时，请检查网络后重新登录。'}))this.expired(provider);
  }
}
