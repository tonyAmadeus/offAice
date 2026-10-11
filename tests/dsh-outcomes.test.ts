import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DshAdapter, DSH_GUARD_SOURCE, dshTerminalEvent } from '../src/backend/adapters/dsh';
import { NativeResponseError } from '../src/backend/adapter-failure';
import { DEFAULT_SETTINGS } from '../src/shared/defaults';
import type { AdapterContext } from '../src/shared/types';

test('the native plugin emits the original durable terminal reason through the official session hook',()=>{
  const source=`const plugin=await import('data:text/javascript;base64,${Buffer.from(DSH_GUARD_SOURCE).toString('base64')}');
    let terminal;plugin.apply({tools:{guard(){}},on(event,fn){if(event==='session/event')terminal=fn;}},{writeMode:true});
    terminal({header:{id:'root'}},{type:'turn/end',data:{turn:7,reason:{kind:'error',error:{code:'UsageLimitExceeded',message:'fixture quota'}}}});`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});
  assert.equal(result.status,0,result.stderr);
  const packet=JSON.parse(result.stdout);assert.equal(packet.method,'airoom/turnEnd');
  assert.deepEqual(packet.params,{sessionId:'root',turn:7,kind:'error',code:'UsageLimitExceeded',message:'fixture quota'});
  assert.equal(dshTerminalEvent({header:{id:'root'}},{type:'turn/start',data:{turn:7}}),undefined);
});

test('DSH preserves blocked, aborted and error outcomes, ignores child outcomes and encodes manually chosen models',async()=>{
  for(const reason of ['completed','max-tokens','blocked','aborted','error','child','rpc-error','transport'] as const){
    const adapter=new DshAdapter(),native=adapter as any,deliveries:string[]=[],selections:any[]=[];
    const cwd=path.resolve('.test-cache'),settings={...DEFAULT_SETTINGS,models:{dsh:'deepseek-flash'}};
    const ctx:AdapterContext={cwd,settings,env:{AIROOM_DSH_HOME:cwd},
      session:{id:'s',projectId:'p',provider:'dsh',title:'fixture',writeMode:false,revision:1,createdAt:'',updatedAt:''},
      run:{id:'r',sessionId:'s',projectId:'p',provider:'dsh',input:'',revision:1,status:'running',delivery:'prepared',bootId:'test',createdAt:'',updatedAt:''},
      emit(){},async approve(){return {choice:'deny'};},persistNativeSession(id){ctx.session.nativeId=id;},markDelivery(value){deliveries.push(value);ctx.run.delivery=value;},registerProcess(){}
    };
    ctx.freshInput=remember=>{assert.ok(remember);return 'replayed room history';};
    native.accountStatus=async()=>({authenticated:true});native.launch=async()=>{};native.cleanup=async()=>{};
    native.request=async(method:string,params:any)=>{
      if(method==='session/new')return {sessionId:'root'};
      if(method==='session/set_config_option'){
        selections.push(params);
        await native.incoming({method:'airoom/turnEnd',params:{sessionId:'root',turn:0,kind:'blocked'}});
        assert.equal(native.terminal,undefined,'events from before prompt delivery must not terminate the new turn');return {};
      }
      assert.equal(method,'session/prompt');
      assert.equal(params.prompt[0].text,'replayed room history','new native context receives replay even when session persistence updates the context');
      if(reason==='transport')throw new Error('pipe disconnected');
      if(reason!=='rpc-error')await native.incoming({method:'airoom/turnEnd',params:{sessionId:reason==='child'?'child':'root',turn:1,kind:reason==='child'?'blocked':reason,...(reason==='error'?{code:'UsageLimitExceeded',message:'fixture quota'}:{})}});
      if(reason==='rpc-error')throw new NativeResponseError('turn failed: 429 quota exceeded',429);
      if(reason==='error')throw new NativeResponseError('turn failed: fixture quota',-32603);
      return {stopReason:'end_turn'};
    };
    if(reason==='transport'){
      await assert.rejects(adapter.start(ctx,'fixture'),/pipe disconnected/);assert.deepEqual(deliveries,['sent','unknown']);
    }else{
      const result=await adapter.start(ctx,'fixture');assert.deepEqual(deliveries,['sent','confirmed']);
      if(reason==='blocked'||reason==='aborted')assert.equal(result.failure?.kind,reason);
      else if(reason==='error'||reason==='rpc-error')assert.equal(result.failure?.kind,'rate_limited');
      else assert.equal(result.failure,undefined);
    }
    assert.equal(selections[0].value,JSON.stringify(['deepseek-account','deepseek-flash']));
  }
});

test('DSH keeps delivery confirmed when a turn is stopped after the agent already acted on it',async()=>{
  for(const acted of [true,false]){
    const adapter=new DshAdapter(),native=adapter as any,deliveries:string[]=[];
    const cwd=path.resolve('.test-cache');
    const ctx:AdapterContext={cwd,settings:DEFAULT_SETTINGS,env:{AIROOM_DSH_HOME:cwd},
      session:{id:'s',projectId:'p',provider:'dsh',title:'fixture',writeMode:true,revision:1,createdAt:'',updatedAt:''},
      run:{id:'r',sessionId:'s',projectId:'p',provider:'dsh',input:'',revision:1,status:'running',delivery:'prepared',bootId:'test',createdAt:'',updatedAt:''},
      emit(){},async approve(){return {choice:'deny'};},persistNativeSession(id){ctx.session.nativeId=id;},markDelivery(value){deliveries.push(value);ctx.run.delivery=value;},registerProcess(){}
    };
    native.accountStatus=async()=>({authenticated:true});native.launch=async()=>{};native.cleanup=async()=>{};
    native.request=async(method:string)=>{
      if(method==='session/new')return {sessionId:'root'};
      if(acted)await native.incoming({method:'session/update',params:{sessionId:'root',update:{sessionUpdate:'tool_call',toolCallId:'t1',title:'pwsh'}}});
      native.stopped=true;throw new Error('DSH 已停止。');
    };
    const result=await adapter.start(ctx,'fixture');
    assert.equal(result.stopped,true);
    assert.deepEqual(deliveries,acted?['sent','confirmed']:['sent']);
  }
});
