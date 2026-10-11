import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {loginOutput,officialLoginUrl,submitClaudeLoginCode} from '../src/main/login-output';

test('login accepts official claude.com URLs across chunks and never exposes OAuth output or echoed codes',()=>{
  const opened:string[]=[],messages:string[]=[];
  const output=loginOutput('claude',url=>opened.push(url),text=>messages.push(text));
  const url='https://claude.com/cai/oauth/authorize?state=secret-state';
  output.write(Buffer.from('Open '+url.slice(0,30)));output.write(Buffer.from(url.slice(30)+'\nPaste code here if prompted > code-secret#state-secret\n'));output.end();
  assert.deepEqual(opened,[url]);assert.ok(messages.some(message=>message.includes('授权码')));
  assert.ok(!JSON.stringify(messages).includes('secret'));
  assert.equal(officialLoginUrl('claude','https://claude.com.evil.example/authorize'),undefined);
  assert.equal(officialLoginUrl('codex',url),undefined);
  assert.equal(officialLoginUrl('claude','https://user:pass@claude.com/authorize'),undefined);
});

test('Claude authorization code travels only through stdin; malformed or ended login is rejected',async()=>{
  const child=spawn(process.execPath,['-e',`process.stdin.once('data',data=>{process.exit(data.toString()==='code-secret#state-secret\\n'?0:2)})`],{stdio:['pipe','pipe','pipe']});
  let output='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);
  const closed=new Promise<number|null>(resolve=>child.once('close',resolve));
  try{await submitClaudeLoginCode(child,'code-secret#state-secret');assert.equal(await closed,0);assert.equal(output,'');
    assert.throws(()=>submitClaudeLoginCode(child,'code\ncommand'),/单行/);assert.throws(()=>submitClaudeLoginCode(child,'code'),/已结束/);
  }finally{if(child.exitCode===null)child.kill();}
});
