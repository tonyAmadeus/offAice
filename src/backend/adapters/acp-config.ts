import type { ModelOption } from '../../shared/types';
import type { EffectiveRunConfig } from '../../shared/executor-config';

export interface AcpSelectOption {
  id: string; name?: string; category?: string; type: 'select' | 'boolean'; currentValue?: string | boolean;
  options?: unknown[];
}
export const configCurrent = (option: AcpSelectOption | undefined): string | undefined => typeof option?.currentValue === 'boolean' ? (option.currentValue ? 'on' : 'off') : option?.currentValue;
export function selectConfig(state: any, category: string, legacyIds: string[] = []): AcpSelectOption | undefined {
  const options = (Array.isArray(state?.configOptions) ? state.configOptions : []).filter((option: any) => (option?.type === 'select' || category === 'thought_level' && option?.type === 'boolean') && typeof option.id === 'string');
  return options.find((option: any) => option.category === category) ?? options.find((option: any) => legacyIds.includes(option.id)) ?? (category === 'thought_level' ? options.find((option: any) => !['model', 'mode'].includes(option.category) && /reasoning[_ -]?effort|thinking[_ -]?(level|effort)|thought[_ -]?level|思考(程度|强度|深度)|推理(程度|强度|深度)|(?:^|\s)(thinking|reasoning)(?:\s|$)/i.test(`${option.id} ${option.name ?? ''}`)) : undefined);
}
export function configChoices(option: AcpSelectOption | undefined): { value: string; name: string; description?: string }[] {
  if (option?.type === 'boolean') return [{ value: 'on', name: '开启' }, { value: 'off', name: '关闭' }];
  const entries = Array.isArray(option?.options) ? option.options : [];
  const flatten=(items:any[]):any[]=>items.flatMap(entry=>Array.isArray(entry?.options)?flatten(entry.options):[entry]);
  return flatten(entries)
    .filter((entry: any) => typeof entry?.value === 'string').map((entry: any) => ({ value: entry.value, name: typeof entry.name === 'string' ? entry.name : entry.value, ...(typeof entry.description === 'string' ? { description: entry.description } : {}) }));
}
export function acpModelOptions(state: any): ModelOption[] {
  const model = selectConfig(state, 'model', ['model']), thought = selectConfig(state, 'thought_level', ['reasoning_effort']);
  const efforts = configChoices(thought).map(choice => choice.value);
  const models = state?.models;
  const currentModel = configCurrent(model) ?? models?.currentModelId;
  const thinking = (id: string) => ({ efforts: id === currentModel ? efforts : [], defaultEffort: id === currentModel ? configCurrent(thought) : undefined, effortSource: id === currentModel && thought ? 'reported' as const : 'unreported' as const });
  const legacy:ModelOption[]=(Array.isArray(models?.availableModels) ? models.availableModels : []).filter((entry: any) => typeof entry?.modelId === 'string')
    .map((entry: any) => ({ id: entry.modelId, label: typeof entry.name === 'string' ? entry.name : entry.modelId, description: entry.description, ...thinking(entry.modelId), isDefault: entry.modelId === currentModel }));
  const modern=model?configChoices(model).map(choice => ({ id: choice.value, label: choice.name, description: choice.description, ...thinking(choice.value), isDefault: choice.value === model.currentValue })):[];
  const result = [...modern,...legacy.filter(option=>!modern.some(current=>current.id===option.id))];
  return result.length || !thought ? result : [{ id: '', label: '程序默认', efforts, defaultEffort: configCurrent(thought), effortSource: 'reported', isDefault: true }];
}
export function acpConfigReport(state: any, source: string): Omit<EffectiveRunConfig, 'at'> {
  const model = configCurrent(selectConfig(state, 'model', ['model'])) ?? state?.models?.currentModelId;
  const effort = configCurrent(selectConfig(state, 'thought_level', ['reasoning_effort']));
  return { source, ...(typeof model === 'string' ? { model, modelStatus: 'reported' as const } : {}), ...(typeof effort === 'string' ? { effort, effortStatus: 'reported' as const } : {}) };
}

/** Legacy IDs are fallback rules only; reported categories always choose the actual ID. */
export const ACP_CONFIG_RULES = {model:{category:'model',legacyIds:['model']},effort:{category:'thought_level',legacyIds:['reasoning_effort']}};
export async function configureAcp(options:{
  state:any; sessionId:string; model?:string; effort?:string;
  request:(method:string,params:unknown,timeout?:number)=>Promise<any>;
  record?:(report:Omit<EffectiveRunConfig,'at'>)=>void;
  legacyModelConfigId?:string; currentState?:()=>any; encodeModel?:(model:string)=>string; decodeModel?:(model:string)=>string;
}){
  let state=options.state;
  for(const key of ['model','effort'] as const){
    const requested=options[key];if(!requested)continue;
    const rule=ACP_CONFIG_RULES[key];let option=selectConfig(state,rule.category,rule.legacyIds);
    const value=key==='model'&&options.encodeModel?options.encodeModel(requested):requested;
    const status=key==='model'?'modelStatus':'effortStatus';
    try{
      if(key==='model'&&option&&!configChoices(option).some(choice=>choice.value===value)&&state?.models?.availableModels?.some((item:any)=>item.modelId===value))option=undefined;
      if(option&&!configChoices(option).some(choice=>choice.value===value))throw new Error(`所选${key==='model'?'模型':'思考程度'}已不在执行端选项中`);
      if(!option&&key==='effort')throw new Error('执行端没有提供思考程度配置');
      if(!option&&Array.isArray(state?.models?.availableModels)&&!state.models.availableModels.some((item:any)=>item.modelId===value))throw new Error('所选模型已不在执行端选项中');
      // Only a native reported value can skip a setter. Accepted-but-unreported changes
      // still get applied next time; changing the model still refreshes effort choices.
      const current=option?configCurrent(option):key==='model'?state?.models?.currentModelId:undefined;
      if(current===value){
        options.record?.({[key]:key==='model'&&options.decodeModel?options.decodeModel(value):requested,[status]:'reported',source:'acp.configuration-current'});
        continue;
      }
      const before=options.currentState?.();
      const configId=option?.id??(key==='model'?options.legacyModelConfigId:undefined);
      const result=await options.request(configId?'session/set_config_option':'session/set_model',configId?{sessionId:options.sessionId,configId,value:option?.type === 'boolean' ? value === 'on' : value}:{sessionId:options.sessionId,modelId:value},30000);
      options.record?.({[key]:undefined,[status]:'accepted',source:'acp.configuration'});
      const notified=options.currentState?.();
      const reported=result?.configOptions||result?.models?result:notified!==before?notified:undefined;
      if(reported){
        const report=acpConfigReport(reported,'acp.configuration-response');
        if(report.model&&options.decodeModel)report.model=options.decodeModel(report.model);
        options.record?.(report);
        const actual=report[key],expected=key==='model'&&options.decodeModel?options.decodeModel(value):requested;
        if(actual&&actual!==expected)throw new Error('执行端报告的实际配置与选择不同');
        state={...state,...reported};
      }
    }catch(error){options.record?.({[key]:undefined,[status]:'rejected',source:'acp.configuration'});throw new Error(`执行端没有接受所选${key==='model'?'模型':'思考程度'}「${requested}」，任务尚未发送：${(error as Error).message}`);}
  }
  return state;
}
