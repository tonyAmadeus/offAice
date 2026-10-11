import { ConfigurationHint, useProviderConfiguration } from './provider-configuration';
import type { ConfigSelection } from '../shared/executor-config';
import { requestedConfig, effectiveConfigText } from '../shared/executor-config';
import type { MemberProfile, Project, Snapshot } from '../shared/types';
import type { Invoke } from './ui';

const inputValue=(value:string|null|undefined)=>value===null?'default':value===undefined?'inherit':'value:'+value;
const selectionValue=(value:string)=>value==='default'?null:value==='inherit'?undefined:value.slice(6);

/** Project choices are separate from card defaults and from the configuration already frozen for an active run. */
export function MemberConfigFields({snapshot,member,value,onChange,invoke}:{snapshot:Snapshot;member:MemberProfile;value:ConfigSelection;onChange:(value:ConfigSelection)=>void;invoke:Invoke}){
  const inherited=requestedConfig({},member,snapshot.settings,undefined,snapshot.executors?.find(e=>e.id===member.executor));
  const requested=requestedConfig({memberConfigs:{[member.id]:value}},member,snapshot.settings,undefined,snapshot.executors?.find(e=>e.id===member.executor));
  const provider=snapshot.providers.find(p=>p.id===member.executor);
  const configuration = useProviderConfiguration(member.executor, provider, requested.model, invoke);
  const { options: catalog, efforts, checking } = configuration;
  function change(key:'model'|'effort',text:string){
    const next={...value,[key]:selectionValue(text)};if(next[key]===undefined)delete next[key];onChange(next);
  }
  return <div className="member-project-config">
    <label className="field">模型<select aria-label={member.name+' 项目模型'} disabled={!configuration.modelConfigurable} value={inputValue(value.model)} onChange={e=>change('model',e.target.value)}>
      <option value="inherit">沿用默认 · {inherited.model||'程序默认'}</option><option value="default">程序默认</option>
      {value.model&&!catalog.some(m=>m.id===value.model)&&<option value={'value:'+value.model}>{value.model}（需核对）</option>}
      {catalog.map(m=><option key={m.id} value={'value:'+m.id}>{m.label}</option>)}
    </select></label>
    <label className="field">思考程度<select aria-label={member.name+' 项目思考程度'} value={inputValue(value.effort)} disabled={checking} onChange={e=>change('effort',e.target.value)}>
      <option value="inherit">沿用默认 · {inherited.effort||'程序默认'}</option><option value="default">程序默认</option>
      {value.effort&&!efforts.includes(value.effort)&&<option value={'value:'+value.effort}>{value.effort}（需核对）</option>}
      {efforts.map(e=><option key={e} value={'value:'+e}>{e}</option>)}
    </select></label>
    <ConfigurationHint configuration={configuration} onDefault={requested.model ? () => onChange({ ...value, model: null, effort: null }) : undefined} />
  </div>;
}

export function MemberRunConfig({snapshot,project,memberId}:{snapshot:Snapshot;project:Project;memberId:string}){
  const sessions=new Set(snapshot.sessions.filter(s=>s.memberId===memberId&&(s.projectId===project.id||s.roomId==='project:'+project.id)).map(s=>s.id));
  const run=snapshot.runs.filter(r=>sessions.has(r.sessionId)).at(-1);
  return <p className="task-meta">{run?effectiveConfigText(run.requestedConfig,run.effectiveConfig):'还没有这位成员的运行记录。'} 修改只影响之后开始的运行。</p>;
}
