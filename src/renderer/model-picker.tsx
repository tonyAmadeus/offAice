import { useState } from 'react';
import type { ProviderId, ProviderInfo, Settings } from '../shared/types';
import type { Invoke } from './ui';
import { ConfigurationHint, useProviderConfiguration } from './provider-configuration';

const EFFORT_LABELS: Record<string, string> = { on: '开启', none: '关闭', off: '关闭', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高', ultra: '超高' };
const effortLabel = (value: string) => EFFORT_LABELS[value] ? `${EFFORT_LABELS[value]}（${value}）` : value;

/** Model and thinking level for one member; advertised options first, free text as a fallback. */
export function ModelPicker({ provider, info, settings, setSettings, invoke }: { provider: ProviderId; info?: ProviderInfo; settings: Settings; invoke?: Invoke; setSettings: (update: (previous: Settings) => Settings) => void }) {
  const model = settings.models[provider] ?? '';
  const configuration = useProviderConfiguration(provider, info, model || undefined, invoke);
  const { options, active, efforts } = configuration;
  const effort = settings.efforts?.[provider] ?? '';
  const listed = options.some(option => option.id === model);
  const [custom, setCustom] = useState(Boolean(model) && !listed);
  const setModel = (value: string) => setSettings(previous => ({ ...previous, models: { ...previous.models, [provider]: value } }));
  const setEffort = (value: string) => setSettings(previous => ({ ...previous, efforts: { ...previous.efforts, [provider]: value } }));
  const defaultLabel = options.find(option => option.isDefault)?.label ?? info?.model;
  return <div className="model-picker">
    <label className="field compact">模型
      {options.length > 0 && <select aria-label="模型" disabled={!configuration.modelConfigurable} value={custom ? '__custom' : model} onChange={event => { if (event.target.value === '__custom') { setCustom(true); return; } setCustom(false); setModel(event.target.value); }}>
        <option value="">成员默认{defaultLabel ? `（${defaultLabel}）` : ''}</option>
        {options.filter(option => option.id).map(option => <option key={option.id} value={option.id}>{option.label}{option.label !== option.id ? ` · ${option.id}` : ''}{option.isDefault ? ' · 默认' : ''}</option>)}
        <option value="__custom">其他（手动填写）</option>
      </select>}
      {(custom || !options.length) && <input aria-label="模型" disabled={!configuration.modelConfigurable} value={model} onChange={event => setModel(event.target.value)} placeholder={options.length ? '填写模型名称' : (info?.model ?? '留空使用成员默认')} spellCheck={false} />}
      {active?.description ? <small>{active.description}</small> : !options.length && <small>检查连接后会列出这位成员可用的模型。</small>}
    </label>
    <label className="field compact">思考程度
      <select aria-label="思考程度" disabled={configuration.checking} value={effort} onChange={event => setEffort(event.target.value)}>
        <option value="">模型默认{active?.defaultEffort ? `（${effortLabel(active.defaultEffort)}）` : ''}</option>
        {[...efforts, ...(effort && !efforts.includes(effort) ? [effort] : [])].map(value => <option key={value} value={value}>{effortLabel(value)}{!efforts.includes(value) ? '（需重新核对）' : ''}</option>)}
      </select>
      <ConfigurationHint configuration={configuration} onDefault={model ? () => { setModel(''); setEffort(''); } : undefined} />
    </label>
  </div>;
}
