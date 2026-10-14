import{mkdirSync,writeFileSync,existsSync,appendFileSync}from'node:fs';
import path from'node:path';
import{createInterface}from'node:readline';
const provider=process.env.CURSOR_CONFIG_DIR?'cursor':process.env.QODERCN_CONFIG_DIR?'qodercn':process.env.QODER_CONFIG_DIR?'qoder':'kimi',home=process.env.CURSOR_CONFIG_DIR??process.env.QODERCN_CONFIG_DIR??process.env.QODER_CONFIG_DIR??process.env.KIMI_CODE_HOME;
if(!home)throw Error('isolated login home missing');
const credentials=path.join(home,'fixture-auth'),args=process.argv.slice(2);
if(process.env.FIXTURE_CALLS)appendFileSync(process.env.FIXTURE_CALLS,JSON.stringify({args,home,leaked:!!(process.env.CURSOR_API_KEY||process.env.CURSOR_AUTH_TOKEN||process.env.OPENAI_API_KEY||process.env.GEMINI_API_KEY||process.env.QODER_PERSONAL_ACCESS_TOKEN||process.env.QODERCN_PERSONAL_ACCESS_TOKEN||process.env.KIMI_API_KEY)})+'\n');
if(args.filter(arg=>arg!=='--disable-auto-update').join(' ')==='logout'){
  const {unlinkSync}=await import('node:fs');if(existsSync(credentials))unlinkSync(credentials);process.exit(0);
}else if(args.join(' ')==='acp --login'||args.filter(arg=>arg!=='--disable-auto-update').join(' ')==='login'){
  process.stderr.write(provider==='cursor'?'Open https://cursor.com/loginDeepControl?fixture=1 in your browser.\n':provider==='kimi'?'Opening browser for Kimi device login: https://auth.kimi.com/verify?user_code=ABCD-1234\nenter code: ABCD-1234\n':'Open https://'+(provider==='qodercn'?'qoder.cn':'qoder.com')+'/cli/login?fixture=1 in your browser.\n');
  if(process.env.FIXTURE_WAIT==='1')setInterval(()=>{},1000);
  else{mkdirSync(home,{recursive:true});writeFileSync(credentials,'fixture');process.exit(0);}
}else{
  const lines=createInterface({input:process.stdin});
  lines.on('line',async line=>{const p=JSON.parse(line);if(p.id===undefined)return;
    if(process.env.FIXTURE_CALLS)appendFileSync(process.env.FIXTURE_CALLS,JSON.stringify({method:p.method,methodId:p.params?.methodId})+'\n');
    let result={};if(p.method==='initialize')result={protocolVersion:1,agentInfo:{name:provider,version:'1.0.0'},agentCapabilities:{},authMethods:[{id:provider==='cursor'?'cursor_login':'login',type:'terminal',name:'Official terminal login',args:['--login']}]};
    else if(['authenticate','session/new'].includes(p.method)){
      if(provider==='cursor'&&p.method==='authenticate'){
        if(p.params.methodId!=='cursor_login')throw Error('wrong Cursor authentication method');
        if(process.env.FIXTURE_AUTH_FAIL==='1'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:p.id,error:{code:-32000,message:'Login failed'}})+'\n');return;}
        if(!existsSync(credentials)){
          const {spawn}=await import('node:child_process');
          // Cursor ACP intercepts stderr and waits for spawn, rather than exit.
          process.stderr.write=()=>true;
          await new Promise((resolve,reject)=>{const child=spawn('powershell.exe',['-NoProfile','-Command',"Start-Process 'https://cursor.com/loginDeepControl?fixture=1'"],{stdio:'ignore'});child.once('error',reject);child.once('spawn',resolve);});
          if(process.env.FIXTURE_WAIT==='1')return;
          mkdirSync(home,{recursive:true});writeFileSync(credentials,'fixture');
        }
      }
      if(!existsSync(credentials)){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:p.id,error:{code:-32000,message:'Authentication required'}})+'\n');return;}
      if(p.method==='session/new'&&process.env.FIXTURE_SESSION_WAIT==='1')return;
      result=p.method==='session/new'?{sessionId:'official-login-session'}:{};
    }
    else if(p.method==='session/prompt')throw Error('a login test must never send a model request');
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:p.id,result})+'\n');
  });
}
