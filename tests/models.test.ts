import '../scripts/test-bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { codexModelOptions } from '../src/backend/adapters/codex';
import { dshModelOptions, dshModelSelection } from '../src/backend/adapters/dsh';
import { CLAUDE_MODEL_OPTIONS } from '../src/backend/adapters/claude';
import { claudeModelOptions } from '../src/backend/adapters/claude-models';

test('Codex model/list becomes options with per-model reasoning efforts, hidden models dropped', () => {
  const options = codexModelOptions({ data: [
    { id: 'a', model: 'gpt-5.6', displayName: 'GPT-5.6', description: 'flagship', hidden: false, isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }, { reasoningEffort: 'high', description: '' }] },
    { id: 'b', model: 'internal', displayName: 'x', description: '', hidden: true, isDefault: false, defaultReasoningEffort: 'low', supportedReasoningEfforts: [] },
  ] });
  assert.deepEqual(options, [{ id: 'gpt-5.6', label: 'GPT-5.6', description: 'flagship', efforts: ['low', 'high'], defaultEffort: 'medium', isDefault: true }]);
  assert.deepEqual(codexModelOptions(undefined), []);
});

test('DSH model names map to account ACP routes and legacy JSON settings remain usable',()=>{
  const route=JSON.stringify(['deepseek-account','deepseek-flash']);
  assert.deepEqual(dshModelSelection('deepseek-flash'),{provider:'deepseek-account',model:'deepseek-flash',option:route});
  assert.deepEqual(dshModelSelection(route),dshModelSelection('deepseek-flash'));
  assert.throws(()=>dshModelSelection('["api","deepseek-flash"]'),/计费路径/);
  const options=dshModelOptions([{id:'model',type:'select',currentValue:route,options:[{value:route,name:'Flash'}]}]);
  assert.equal(options[0].id,'deepseek-flash');assert.equal(options[0].isDefault,true);
});

test('DSH ACP config options (plain or grouped selects) become model options', () => {
  const configOptions = [
    { id: 'model', type: 'select', name: '模型', currentValue: 'deepseek-flash', options: [{ group: 'g', name: 'DeepSeek', options: [{ value: 'deepseek-flash', name: 'Flash' }, { value: 'deepseek-pro', name: 'Pro', description: '更强' }] }] },
    { id: 'reasoning_effort', type: 'select', name: '推理', currentValue: 'high', options: [{ value: 'low', name: '低' }, { value: 'high', name: '高' }] },
  ];
  assert.deepEqual(dshModelOptions(configOptions), [
    { id: 'deepseek-flash', label: 'Flash', description: undefined, efforts: ['low', 'high'], defaultEffort: 'high', effortSource: 'reported', isDefault: true },
    { id: 'deepseek-pro', label: 'Pro', description: '更强', efforts: [], defaultEffort: undefined, effortSource: 'unreported', isDefault: false },
  ]);
  assert.deepEqual(dshModelOptions(null), []);
});

test('Claude fallback aliases do not invent effort support for every family', () => {
  assert.deepEqual(CLAUDE_MODEL_OPTIONS.map(option => option.id), ['opus', 'sonnet', 'haiku']);
  for (const option of CLAUDE_MODEL_OPTIONS) assert.deepEqual(option.efforts, []);
  const options = claudeModelOptions([{value:'opus',displayName:'Opus',supportsEffort:true,supportedEffortLevels:['low','high']},{value:'haiku',displayName:'Haiku'}]);
  assert.deepEqual(options[0].efforts,['low','high']);
  assert.deepEqual(options[1].efforts,[]);
  assert.equal(options[1].effortSource,'unreported');
});
