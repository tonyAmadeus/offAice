import test from 'node:test';
import assert from 'node:assert/strict';
import {acpModelOptions,configureAcp} from '../src/backend/adapters/acp-config';
import {selectConfig} from '../src/backend/adapters/acp-config';
test('all advertised model groups and legacy-only models are selectable without a fixed list limit',async()=>{
  const entries=Array.from({length:130},(_,i)=>({value:'provider/model-'+i,name:'Model '+i}));
  const state={configOptions:[{id:'model',category:'model',type:'select',currentValue:entries[0].value,options:[{name:'Group',options:[{name:'Nested',options:entries}]}]}],models:{currentModelId:entries[0].value,availableModels:[{modelId:entries[0].value,name:'duplicate'},{modelId:'provider/legacy',name:'Legacy'}]}};
  const models=acpModelOptions(state);assert.equal(models.length,131);assert.equal(new Set(models.map(m=>m.id)).size,131);assert.equal(models.filter(m=>m.isDefault).length,1);
  const calls:any[]=[];await configureAcp({state,sessionId:'s',model:'provider/legacy',request:async(method,params)=>{calls.push({method,params});return {};}});assert.equal(calls[0].method,'session/set_model');assert.equal(calls[0].params.modelId,'provider/legacy');
});

test('vendor effort names without a standard category work, and only the current model receives its levels',async()=>{
  const thinking={id:'vendor-thinking-effort',name:'Thinking effort',type:'select',currentValue:'low',options:[{value:'low'},{value:'high'}]};
  const state={models:{currentModelId:'fast',availableModels:[{modelId:'fast'},{modelId:'deep'}]},configOptions:[thinking]};
  assert.equal(selectConfig(state,'thought_level',['reasoning_effort'])?.id,thinking.id);
  assert.deepEqual(acpModelOptions(state).map(model=>model.efforts),[['low','high'],[]]);
  const calls:any[]=[];
  await configureAcp({state,sessionId:'s',effort:'high',request:async(method,params)=>{calls.push({method,params});return {...state,configOptions:[{...thinking,currentValue:'high'}]};}});
  assert.equal(calls[0].params.configId,thinking.id);
  assert.equal(calls[0].params.value,'high');
});

test('boolean thinking controls retain native boolean values and report their actual state',async()=>{
  const state={configOptions:[{id:'thinking',name:'Thinking',type:'boolean',currentValue:true}]};
  assert.deepEqual(acpModelOptions(state)[0].efforts,['on','off']);
  assert.equal(acpModelOptions(state)[0].defaultEffort,'on');
  const calls:any[]=[],reports:any[]=[];
  await configureAcp({state,sessionId:'s',effort:'off',request:async(method,params)=>{calls.push({method,params});return {configOptions:[{...state.configOptions[0],currentValue:false}]};},record:report=>reports.push(report)});
  assert.equal(calls[0].params.value,false);
  assert.equal(reports.at(-1).effort,'off');
  assert.equal(reports.at(-1).effortStatus,'reported');
});

test('native reported current selections avoid setters, including legacy model and boolean effort',async()=>{
  const reports:any[]=[],state={models:{currentModelId:'native/deep',availableModels:[{modelId:'native/deep'}]},configOptions:[{id:'thinking',type:'boolean',currentValue:true}]};
  await configureAcp({state,sessionId:'s',model:'deep',effort:'on',encodeModel:m=>'native/'+m,decodeModel:m=>m.replace('native/',''),request:async()=>assert.fail('unchanged reported selections'),record:r=>reports.push(r)});
  assert.deepEqual(reports.map(r=>[r.model??r.effort,r.modelStatus??r.effortStatus]),[['deep','reported'],['on','reported']]);
});

test('accepted unreported configuration is reapplied; removed choices and mismatches still fail',async()=>{
  let requests=0;const state={configOptions:[{id:'model',category:'model',type:'select',options:[{value:'deep'}]}]};
  const options={state,sessionId:'s',model:'deep',request:async()=>{requests++;return {};}};
  await configureAcp(options);await configureAcp(options);assert.equal(requests,2);
  await assert.rejects(configureAcp({...options,state:{configOptions:[{...state.configOptions[0],currentValue:'deep',options:[]}]} }),/已不在/);
  await assert.rejects(configureAcp({...options,request:async()=>({models:{currentModelId:'wrong'}})}),/实际配置/);
});

test('changing model refreshes a previously equal effort before deciding whether a setter is necessary',async()=>{
  const calls:string[]=[],thought={id:'thinking',category:'thought_level',type:'select',currentValue:'high',options:[{value:'high'},{value:'low'}]};
  const state={models:{currentModelId:'fast',availableModels:[{modelId:'fast'},{modelId:'deep'}]},configOptions:[thought]};
  await configureAcp({state,sessionId:'s',model:'deep',effort:'high',request:async(method,params:any)=>{calls.push(method);return method==='session/set_model'?{models:{...state.models,currentModelId:'deep'},configOptions:[{...thought,currentValue:'low'}]}:{configOptions:[thought]};}});
  assert.deepEqual(calls,['session/set_model','session/set_config_option']);
});
