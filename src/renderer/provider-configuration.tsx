import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProviderId, ProviderInfo } from '../shared/types';
import type { Invoke } from './ui';

/** A configuration read is local to this editor. It never changes the saved defaults. */
export function useProviderConfiguration(provider: ProviderId, info: ProviderInfo | undefined, model: string | undefined, invoke?: Invoke) {
  const [state, setState] = useState(info), [checking, setChecking] = useState(false), [error, setError] = useState('');
  const ticket = useRef(0), latest = useRef(info); latest.current = info;
  const refresh = useCallback(async (choice?: string) => {
    if (!invoke) return;
    const serial = ++ticket.current; setChecking(true); setError('');
    try {
      const result = await invoke<ProviderInfo>('provider.config', { provider, model: choice ?? null }, undefined, { background: true });
      if (serial !== ticket.current) return;
      if (result?.runtimeReady || result?.available) { setState(result); if (!result.available) setError(result.detail || '请先完成登录。'); }
      else setError(result?.detail || '尚未读取到执行端配置。');
    } catch (value) { if (serial === ticket.current) setError((value as Error).message); }
    finally { if (serial === ticket.current) setChecking(false); }
  }, [provider, invoke]);
  useEffect(() => { ticket.current++; setState(info); setChecking(false); setError(''); }, [provider, info?.checkedAt]);
  useEffect(() => {
    const initial = latest.current; setState(initial); setError('');
    const options = initial?.modelOptions ?? [];
    const selected = options.find(option => (option.id === model || option.aliases?.includes(model ?? ''))) ?? (!model ? options.find(option => option.isDefault) : undefined);
    if (model && initial?.available && initial.configuration?.model !== false && (!selected || selected.effortSource === 'unreported')) void refresh(model);
    return () => { ticket.current++; };
  }, [provider, model, refresh, info?.checkedAt]);
  const options = state?.modelOptions ?? [];
  const active = options.find(option => (option.id === model || option.aliases?.includes(model ?? ''))) ?? (!model ? options.find(option => option.isDefault) ?? options[0] : undefined);
  const efforts = Array.isArray(active?.efforts) ? active.efforts : [];
  const hint = checking ? '正在读取这个模型的配置…' : error || state?.configuration?.detail || (efforts.length ? '选项来自执行端；修改从下一轮开始生效。' : state?.configuration?.effort === 'unsupported' || active?.effortSource === 'unsupported' ? '当前接口不支持调整，跟随官方默认。' : '执行端尚未报告这个模型的思考选项，当前跟随官方默认。');
  return { options, active, efforts, checking, error, hint, modelConfigurable: state?.configuration?.model !== false, refresh: () => refresh(model) };
}

export function ConfigurationHint({ configuration, onDefault }: { configuration: ReturnType<typeof useProviderConfiguration>; onDefault?: () => void }) {
  return <small>{configuration.hint} <button type="button" className="link-button" disabled={configuration.checking} onClick={() => void configuration.refresh()}>刷新选项</button>{onDefault && !configuration.modelConfigurable && <> <button type="button" className="link-button" onClick={onDefault}>使用官方默认</button></>}</small>;
}
