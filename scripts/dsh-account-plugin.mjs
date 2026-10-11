// Runs inside the official dsh launcher and uses its account service exclusively.
// No credential document or token is read, copied, or returned by this plugin.
export const inject = ['deepseekAccount', 'webServer'];
const prefix = 'AIROOM_DSH_ACCOUNT ';
export function apply(ctx, config) {
  // The account-only composition disables ACP, so explicitly consume stdin
  // for the official acp-app EOF lifetime handler to observe parent shutdown.
  process.stdin.resume();
  const exit = code => { process.stdin.pause(); ctx.appExit(code); };
  const controller = new AbortController();
  ctx.on('dispose', () => controller.abort());
  const emit = value => process.stdout.write(prefix + JSON.stringify(value) + '\n');
  const client = {version:'0.2.0-rc.2',locale:'zh-CN',timezoneOffsetSeconds:-new Date().getTimezoneOffset()*60};
  const balance = async () => {
    const unavailable={status:'unavailable',wallets:[],bonusWallets:[]};
    try {
      if(typeof ctx.deepseekAccount.getBalance!=='function')return unavailable;
      const value=await ctx.deepseekAccount.getBalance(client);
      const project=wallets=>{
        if(!Array.isArray(wallets)||wallets.length>20)throw Error('invalid-wallets');
        return wallets.map(wallet=>{
          const amount=typeof wallet?.balance==='string'?wallet.balance.trim():'';
          if(!['CNY','USD'].includes(wallet?.currency)||!amount||amount.length>256||!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(amount))throw Error('invalid-wallet');
          return {currency:wallet.currency,balance:amount};
        });
      };
      return value?.status==='ready'?{status:'ready',wallets:project(value.value),bonusWallets:project(value.bonusWallets)}:unavailable;
    }catch{return unavailable;}
  };
  const run = async () => {
    const state = await ctx.deepseekAccount.getState();
    if (state.status === 'credential-stored') {
      // A local recheck after the verified probe, without another profile/balance network request.
      if(config.mode==='state'){emit({type:'status',authenticated:true,state:'signed-in'});exit(0);return;}
      if(config.mode==='balance'){
        const accountBalance=await balance(),current=await ctx.deepseekAccount.getState();
        // The native service removes an expired grant; never retain that account's old balance.
        const authenticated=current.status==='credential-stored';
        emit({type:'status',authenticated,state:authenticated?'signed-in':'signed-out',accountBalance:authenticated?accountBalance:{status:'unavailable',wallets:[],bonusWallets:[]}});
        exit(0);return;
      }
      const profile = await ctx.deepseekAccount.getProfile(client);
      let authenticated=profile?.status==='ready',accountBalance;
      if(config.mode==='probe'){
        accountBalance=authenticated?await balance():{status:'unavailable',wallets:[],bonusWallets:[]};
        if(!authenticated)accountBalance={status:'unavailable',wallets:[],bonusWallets:[]};
      }
      const current=await ctx.deepseekAccount.getState();
      if(current.status!=='credential-stored'){emit({type:'status',authenticated:false,state:'signed-out',...(config.mode==='probe'?{accountBalance:{status:'unavailable',wallets:[],bonusWallets:[]}}:{})});exit(0);return;}
      emit({type:'status',authenticated,state:authenticated?'signed-in':'verification-failed',...(accountBalance?{accountBalance}:{})});
      // A network failure is not permission to replace or copy a login.
      exit(authenticated?0:2); return;
    }
    if (config.mode !== 'login') {emit({type:'status',authenticated:false,state:'signed-out',...(['probe','balance'].includes(config.mode)?{accountBalance:{status:'unavailable',wallets:[],bonusWallets:[]}}:{})});exit(0);return;}
    const callbackOrigin='http://127.0.0.1:'+ctx.webServer.port;
    await ctx.deepseekAccount.startSignIn(client,callbackOrigin,'web');
    let opened=false;
    for await (const view of ctx.deepseekAccount.watch(controller.signal)) {
      const attempt=view.attempt;
      if(attempt?.authorizeUrl&&!opened){
        const url=new URL(attempt.authorizeUrl);
        if(url.origin!=='https://platform.deepseek.com'||url.pathname!=='/dsh/authorize'||url.username||url.password)throw Error('unexpected-login-destination');
        opened=true;emit({type:'login-url',url:url.href});
      }
      emit({type:'phase',phase:attempt?.phase||'waiting',code:attempt?.errorCode});
      if(view.status==='credential-stored'){
        const profile=await ctx.deepseekAccount.getProfile(client);
        emit({type:'status',authenticated:profile?.status==='ready',state:profile?.status==='ready'?'signed-in':'verification-failed'});
        exit(profile?.status==='ready'?0:2);return;
      }
      if(['cancelled','expired','failed'].includes(attempt?.phase)){exit(2);return;}
    }
  };
  ctx.appReady.onReady(()=>void run().catch(()=>{emit({type:'status',authenticated:false,state:'verification-failed'});exit(2);}));
}
