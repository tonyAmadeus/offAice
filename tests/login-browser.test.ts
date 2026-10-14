import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {LOGIN_BROWSER_PRELOAD} from '../src/backend/login-browser';
import {LoginBrowserGate} from '../src/main/login-browser';
import {codexBrowserLogin} from '../src/main/codex-login';
import {getCodexBrowserLoginLaunch} from '../src/backend/adapters/codex';
import {DEFAULT_SETTINGS} from '../src/shared/defaults';

test('Node login relays browser commands without launching a child browser, and ordinary commands still work',async()=>{
  const source=`import cp from 'node:child_process';const url='https://auth.kimi.com/verify?user_code=FIXTURE';cp.execFile('cmd',['/c','start','',url],(error)=>{if(error)process.exitCode=2;cp.execFile(process.execPath,['-p','6*7'],(err,out)=>{if(err||out.trim()!=='42')process.exitCode=3;else console.log('ordinary-command-ok');});});`;
  const child=spawn(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(LOGIN_BROWSER_PRELOAD),'--input-type=module','-e',source],{windowsHide:true,stdio:['pipe','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
  assert.equal(await new Promise(resolve=>child.once('close',resolve)),0);assert.equal(out.trim(),'ordinary-command-ok');assert.match(err,/AIROOM_BROWSER_URL https:\/\/auth.kimi.com/);
});
test('official browser gate opens once for a matching pending user login and forgets cancelled or stopped attempts',()=>{
  const gate=new LoginBrowserGate(),waiting=(url:string)=>({phase:'waiting' as const,message:'fixture',url});
  assert.equal(gate.accept('a',waiting('https://qoder.cn/login')),undefined);gate.begin('a','qodercn');
  for(const url of ['https://qoder.com/login','https://qoder.cn.evil.example/login','http://qoder.cn/login'])assert.equal(gate.accept('a',waiting(url)),undefined);
  assert.equal(gate.accept('a',waiting('https://qoder.cn/login')),'https://qoder.cn/login');assert.equal(gate.accept('a',waiting('https://qoder.cn/login')),undefined);gate.finish('a');
  gate.begin('a','kimi');gate.clear();assert.equal(gate.accept('a',waiting('https://auth.kimi.com/login')),undefined);
});

test('Cursor-style spawn listeners receive the browser relay even after the CLI intercepts stderr',async()=>{
  const source=`import {spawn} from 'node:child_process';process.stderr.write=()=>true;const events=[];const child=spawn('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-Command',"Start-Process 'https://cursor.com/loginDeepControl?fixture=1'"],{stdio:'ignore',windowsHide:true});child.once('error',()=>process.exitCode=2);child.once('spawn',()=>events.push('spawn'));child.once('exit',()=>events.push('exit'));child.once('close',()=>{events.push('close');console.log(JSON.stringify(events));});`;
  const child=spawn(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(LOGIN_BROWSER_PRELOAD),'--input-type=module','-e',source],{windowsHide:true,stdio:['pipe','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
  assert.equal(await new Promise(resolve=>child.once('close',resolve)),0);
  assert.deepEqual(JSON.parse(out),['spawn','exit','close']);assert.match(err,/AIROOM_BROWSER_URL https:\/\/cursor.com\/loginDeepControl\?fixture=1/);
});
function fakeCodex(url:string,success=true){
  return spawn(process.execPath,['--input-type=module','-e',`import{createInterface}from'node:readline';const lines=createInterface({input:process.stdin});lines.on('line',line=>{const p=JSON.parse(line);if(p.method==='account/login/start'){process.stdout.write(JSON.stringify({id:p.id,result:{type:'chatgpt',loginId:'fixture',authUrl:${JSON.stringify(url)}}})+'\\n');process.stdout.write(JSON.stringify({method:'account/login/completed',params:{loginId:'fixture',success:${success}}})+'\\n');}else if(p.id)process.stdout.write(JSON.stringify({id:p.id,result:{}})+'\\n');});`],{stdio:['pipe','pipe','pipe'],windowsHide:true});
}
test('Codex app-server returns the official browser URL, requires login completion, and sends no thread or prompt',async()=>{
  const launch=getCodexBrowserLoginLaunch({...DEFAULT_SETTINGS,paths:{codex:process.execPath}},process.env);assert.equal(launch.args.at(-1),'app-server');assert.equal(launch.env.CODEX_HOME,process.env.AIROOM_CODEX_HOME);
  for(const success of [true,false]){const child=fakeCodex('https://auth.openai.com/oauth/authorize?fixture=1',success),opened:string[]=[];try{const task=codexBrowserLogin(child,url=>opened.push(url),2000);if(success)await task;else await assert.rejects(task,/没有完成/);assert.equal(opened.length,1);}finally{child.stdin.end();}}
  const child=fakeCodex('https://evil.example/auth');try{await assert.rejects(codexBrowserLogin(child,()=>assert.fail('untrusted browser URL'),2000),/有效的官方/);}finally{child.stdin.end();}
});
