import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../src/backend/store';
import {Engine} from '../src/backend/engine';
import {Engine as TeamFixture} from './helpers/seeded-engine';
import {BUILTIN_MEMBERS,DEFAULT_SETTINGS} from '../src/shared/defaults';
import {ProviderLoginState} from '../src/main/provider-login-state';
import {clearManagedOAuth,logoutProvider} from '../src/backend/provider-logout';
import {catalogCandidate} from '../src/backend/executor-catalog';
import type {Adapter,MemberProfile} from '../src/shared/types';

const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(){return mkdtemp(path.join(os.tmpdir(),'AIROOM-release-initial-'));}
async function clean(directory:string){await rm(directory,{recursive:true,force:true,maxRetries:5});}

test('new production profiles remain empty after probing and restarting, with no automatic program discovery',async()=>{
  const directory=await fixture();let calls=0;
  const engine=new Engine(directory,()=>{},()=>{},()=>({probe:async()=>{calls++;throw Error('must not probe an unconfigured program');}} as unknown as Adapter));
  try{
    assert.deepEqual(engine.snapshot().members,[]);assert.deepEqual(engine.snapshot().executors,[]);
    await engine.probe();assert.equal(calls,0);assert.deepEqual(engine.snapshot().providers,[]);
    await engine.close();const reopened=new Store(directory);try{assert.deepEqual(reopened.members(),[]);}finally{reopened.close();}
  }finally{await engine.close();await clean(directory);}
});

test('legacy implicit cards are migrated once, without replacing saved customization or resurrecting removed cards',async()=>{
  const directory=await fixture();
  try{
    const db=new DatabaseSync(path.join(directory,'airoom.sqlite'));
    db.exec('CREATE TABLE entities(entity TEXT,id TEXT,value TEXT,PRIMARY KEY(entity,id))');
    const put=db.prepare('INSERT INTO entities VALUES(?,?,?)');
    put.run('settings','main',JSON.stringify(DEFAULT_SETTINGS));
    put.run('members','claude',JSON.stringify({...BUILTIN_MEMBERS[0],name:'我的编辑',executor:'codex'}));
    put.run('removed_members','dsh',JSON.stringify(BUILTIN_MEMBERS[2]));db.close();
    let store=new Store(directory);
    assert.deepEqual(store.members().map(member=>member.id).sort(),['claude','codex']);
    assert.equal(store.members().find(member=>member.id==='claude')?.name,'我的编辑');
    assert.equal(store.members().find(member=>member.id==='claude')?.executor,'codex');
    store.delete('members','codex');store.close();store=new Store(directory);
    assert.deepEqual(store.members().map(member=>member.id),['claude']);store.close();
  }finally{await clean(directory);}
});

test('each original template can be rebound and persisted while existing native sessions keep their original provider',async()=>{
  const directory=await fixture(),engine=new TeamFixture(directory,()=>{},()=>{});
  try{
    const project=await engine.invoke('project.create',{directory});
    for(const original of BUILTIN_MEMBERS){
      const old=engine.createSession((project as {id:string}).id,original.executor,'old',false,original.id);
      const next=original.executor==='codex'?'dsh':'codex';
      const updated=await engine.invoke('team.save',{member:{...original,executor:next}}) as MemberProfile;
      assert.equal(updated.executor,next);assert.equal(engine.store.members().find(member=>member.id===original.id)?.executor,next);
      assert.equal(engine.store.get<any>('sessions',old.id).provider,original.executor);
      const created=engine.createSession((project as {id:string}).id,original.executor,'new',false,original.id);
      assert.equal(created.provider,next);assert.equal(created.memberId,original.id);
    }
    await assert.rejects(engine.invoke('team.save',{member:{...BUILTIN_MEMBERS[0],executor:'acp-deadbeef'}}),/保存.*连接/);
    await engine.close();const reopened=new Store(directory);try{assert.equal(reopened.members().find(member=>member.id==='claude')?.executor,'codex');}finally{reopened.close();}
  }finally{await engine.close();await clean(directory);}
});

test('optional artwork templates do not choose the executor or populate an empty team',async()=>{
  const directory=await fixture(),engine=new Engine(directory,()=>{},()=>{});
  try{
    const member=await engine.invoke('team.save',{member:{name:'自选的角色',templateId:'claude',executor:'dsh'}}) as MemberProfile;
    assert.equal(member.executor,'dsh');assert.equal(member.templateId,'claude');assert.equal(engine.snapshot().members.length,1);
    await engine.invoke('team.delete',{id:member.id});assert.deepEqual(engine.snapshot().members,[]);
    const template=await engine.invoke('team.save',{addTemplate:true,member:{...BUILTIN_MEMBERS[1],executor:'dsh'}}) as MemberProfile;
    assert.equal(template.id,'codex');assert.equal(template.executor,'dsh');
    await assert.rejects(engine.invoke('team.save',{addTemplate:true,member:BUILTIN_MEMBERS[1]}),/已添加/);
    await engine.invoke('team.reset',{id:template.id});assert.equal(engine.snapshot().members.length,1);assert.equal(engine.snapshot().members[0].executor,'dsh');
    await engine.invoke('team.delete',{id:template.id});assert.deepEqual(engine.snapshot().members,[]);
  }finally{await engine.close();await clean(directory);}
});

test('cancelled or expired login attempts cannot reopen a page, and retry receives a new attempt',async()=>{
  const expired:string[]=[],state=new ProviderLoginState(provider=>expired.push(provider),15,30);
  const first=state.begin('codex');state.cancel('codex');
  assert.equal(state.update('codex',first,{phase:'waiting',message:'late',url:'https://auth.openai.com/'}),false);
  const second=state.begin('codex');assert.notEqual(first,second);
  assert.equal(state.update('codex',first,{phase:'completed',message:'stale'}),false);
  assert.equal(state.checked('codex',first,'stale check'),false);
  await delay(25);assert.deepEqual(expired,['codex']);assert.equal(state.get('codex')?.phase,'failed');assert.equal(state.get('codex')?.url,undefined);
});

test('connection checks finish a completed login but cannot overwrite a logout or a new attempt',()=>{
  const state=new ProviderLoginState(()=>{}),first=state.begin('codex');
  state.update('codex',first,{phase:'completed',message:'checking'});
  assert.equal(state.checked('codex',first,'checked'),true);assert.equal(state.get('codex')?.message,'checked');
  state.clear('codex');assert.equal(state.checked('codex',first,'late'),false);
  const next=state.begin('codex');assert.equal(state.checked('codex',first,'late'),false);state.cancel('codex');
  assert.equal(state.checked('codex',next,'late'),false);
});

test('repeated authorization progress does not reset or remove its deadline',async()=>{
  const expired:string[]=[],state=new ProviderLoginState(provider=>expired.push(provider),100,35),token=state.begin('claude');
  state.update('claude',token,{phase:'waiting',message:'waiting',url:'https://claude.ai/authorize'});
  await delay(20);state.update('claude',token,{phase:'waiting',message:'still waiting'});
  await delay(30);assert.deepEqual(expired,['claude']);assert.equal(state.get('claude')?.phase,'failed');
});

test('managed OAuth logout removes only the grant and preserves transcripts, settings and other accounts',async()=>{
  const directory=await fixture();
  try{
    for(const kind of ['gemini','qwen'] as const){const home=path.join(directory,kind);await mkdir(path.join(home,'.'+kind),{recursive:true});
      await writeFile(path.join(home,'.'+kind,'oauth_creds.json'),'fixture-secret');await writeFile(path.join(home,'.'+kind,'settings.json'),'preserved');
      await writeFile(path.join(home,'history.jsonl'),'transcript');await clearManagedOAuth(home,kind);
      await assert.rejects(readFile(path.join(home,'.'+kind,'oauth_creds.json')),/ENOENT/);
      assert.equal(await readFile(path.join(home,'.'+kind,'settings.json'),'utf8'),'preserved');assert.equal(await readFile(path.join(home,'history.jsonl'),'utf8'),'transcript');
    }
  }finally{await clean(directory);}
});

test('official logout uses the managed executor profile and sends no model prompt',async()=>{
  const directory=await fixture();
  try{
    const executor=catalogCandidate('qoder',path.resolve('tests/fixtures/fake-catalog-login.mjs'));
    const homes=path.join(directory,'homes'),home=path.join(homes,executor.id,'qoder'),calls=path.join(directory,'calls.jsonl');
    await mkdir(home,{recursive:true});await writeFile(path.join(home,'fixture-auth'),'fixture');await writeFile(path.join(home,'history.jsonl'),'keep');
    await logoutProvider(executor.id,DEFAULT_SETTINGS,{...process.env,AIROOM_ACP_HOME:homes,FIXTURE_CALLS:calls,QODER_PERSONAL_ACCESS_TOKEN:'must-not-leak'},executor);
    const record=JSON.parse((await readFile(calls,'utf8')).trim());assert.deepEqual(record.args,['logout']);assert.equal(record.leaked,false);assert.equal(record.home,home);
    await assert.rejects(readFile(path.join(home,'fixture-auth')),/ENOENT/);assert.equal(await readFile(path.join(home,'history.jsonl'),'utf8'),'keep');
  }finally{await clean(directory);}
});
