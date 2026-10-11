import {officialExecutorLoginUrl} from '../backend/official-login';
import type {CatalogLoginState} from '../shared/executor-catalog';

/** Progress may open one official page only while the matching user-started login is active. */
export class LoginBrowserGate {
  private active=new Map<string,{provider:string;opened:boolean}>();
  begin(id:string,provider:string){if(this.active.has(id))throw new Error('登录正在进行，请先完成或取消。');this.active.set(id,{provider,opened:false});}
  finish(id:string){this.active.delete(id);}
  clear(){this.active.clear();}
  accept(id:string,state:CatalogLoginState){const attempt=this.active.get(id);if(!attempt||attempt.opened||state.phase!=='waiting'||!state.url)return;
    const url=officialExecutorLoginUrl(attempt.provider,state.url);if(url){attempt.opened=true;return url;}
  }
}
