import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { BookmarkPlus, Download, LoaderCircle, Plus, Trash2 } from 'lucide-react';
import type { MemoryEntry, RoomThread, Snapshot } from '../shared/types';
import { Modal } from './modals';
import { Avatar, useTeam } from './members';
import type { Invoke } from './ui';
import { MEMORY_ENTRY_LIMIT, MEMORY_SOURCES, MEMORY_TEXT_LIMIT, activeMemoryText, newMemoryId } from '../shared/memory';

const day = (at: string) => { const date = new Date(at); return date.getTime() > 0 ? date.toLocaleDateString([], { month: 'numeric', day: 'numeric' }) : '早先'; };

/** A member's long-term memory, one entry per line of thought: edit, switch off, delete or add. */
export function MemoryEditor({ entries, onChange, executor, invoke }: { entries: MemoryEntry[]; onChange: (entries: MemoryEntry[]) => void; executor?: string; invoke?: Invoke }) {
  const [adding, setAdding] = useState(''), [importing, setImporting] = useState(false);
  const importable = Boolean(invoke && (executor === 'codex' || executor === 'claude'));
  const active = entries.filter(entry => !entry.off).length, used = activeMemoryText(entries).length, over = used > MEMORY_TEXT_LIMIT;
  const update = (id: string, change: Partial<MemoryEntry>) => onChange(entries.map(entry => entry.id === id ? { ...entry, ...change, updatedAt: new Date().toISOString() } : entry));
  function add() {
    const text = adding.trim(); if (!text) return;
    onChange([...entries, { id: newMemoryId(), text, source: 'manual', createdAt: new Date().toISOString() }]); setAdding('');
  }
  return <div className="field memory-editor" role="group" aria-label="长期记忆">
    <span className="memory-head">长期记忆<span className="memory-head-side"><small className={over ? 'over' : ''}>生效 {active} 条 · {used}/{MEMORY_TEXT_LIMIT} 字</small>{importable && <button type="button" className="link-button" onClick={() => setImporting(true)}><Download size={12} />从桌面端导入</button>}</span></span>
    {entries.length ? <ul className="memory-list">{entries.map(entry => <li key={entry.id} className={`memory-item ${entry.off ? 'off' : ''}`}>
      <input type="checkbox" checked={!entry.off} title={entry.off ? '已关闭：保留在卡片上，但不发送给成员' : '生效：每轮对话都会提供给成员'} aria-label={`让成员记住：${entry.text.slice(0, 24)}`} onChange={event => update(entry.id, { off: event.target.checked ? undefined : true })} />
      <span className="memory-body">
        <textarea aria-label="记忆内容" rows={Math.min(6, Math.max(1, entry.text.split('\n').length, Math.ceil(entry.text.length / 42)))} maxLength={MEMORY_ENTRY_LIMIT} value={entry.text} onChange={event => update(entry.id, { text: event.target.value })} />
        <small>{MEMORY_SOURCES[entry.source]}{entry.origin ? ` · ${entry.origin}` : ''} · {day(entry.createdAt)}{entry.off ? ' · 已关闭' : ''}</small>
      </span>
      <button type="button" className="icon-button" aria-label={`删除记忆：${entry.text.slice(0, 24)}`} title="删除这条记忆" onClick={() => onChange(entries.filter(item => item.id !== entry.id))}><Trash2 size={14} /></button>
    </li>)}</ul> : <p className="memory-empty">还没有记忆。写下希望 TA 一直记得的事，比如“我习惯用 TypeScript”“回答先给结论”。</p>}
    <span className="memory-add">
      <input value={adding} maxLength={MEMORY_ENTRY_LIMIT} aria-label="新增一条记忆" placeholder="新增一条，回车添加" onChange={event => setAdding(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); add(); } }} />
      <button type="button" className="button small secondary" disabled={!adding.trim()} onClick={add}><Plus size={13} />添加</button>
    </span>
    {/* Opened from inside the settings dialog: rendered at the page level so its scroll area cannot clip it. */}
    {importing && invoke && executor && createPortal(<MemoryImportDialog executor={executor} invoke={invoke} existing={entries} onClose={() => setImporting(false)} onAdd={added => { onChange([...entries, ...added]); setImporting(false); }} />, document.body)}
    <small>{over ? '生效的记忆超过上限，保存前请精简或关掉部分条目。' : '生效的每一条都会在每轮对话里提供给成员；取消勾选的条目保留在卡片上，但不会发送。'}AIROOM 只在你点“从桌面端导入”时读取客户端的记忆文件。</small>
  </div>;
}

interface Source { id: string; label: string; count?: number }
interface Candidate { text: string; origin: string }

/** Pick items from a desktop client's memory; they join the card as imported entries once the card is saved. */
function MemoryImportDialog({ executor, invoke, existing, onClose, onAdd }: { executor: string; invoke: Invoke; existing: MemoryEntry[]; onClose: () => void; onAdd: (entries: MemoryEntry[]) => void }) {
  const [sources, setSources] = useState<Source[] | null>(null), [source, setSource] = useState('');
  const [candidates, setCandidates] = useState<Candidate[] | null>(null), [chosen, setChosen] = useState<Set<number>>(() => new Set());
  const [loading, setLoading] = useState(false);
  const known = new Set(existing.map(entry => entry.text));
  useEffect(() => { void invoke<Source[]>('memory.sources', { executor }).then(list => { setSources(list); setSource(list[0]?.id ?? ''); }).catch(() => setSources([])); }, [executor]);
  useEffect(() => {
    if (!source) return;
    setLoading(true); setCandidates(null);
    void invoke<Candidate[]>('memory.read', { executor, source }).then(list => { setCandidates(list); setChosen(new Set(list.map((item, index) => known.has(item.text) ? -1 : index).filter(index => index >= 0))); })
      .catch(() => setCandidates([])).finally(() => setLoading(false));
  }, [source]);
  const toggle = (index: number) => setChosen(previous => { const next = new Set(previous); if (next.has(index)) next.delete(index); else next.add(index); return next; });
  function add() {
    const at = new Date().toISOString();
    onAdd((candidates ?? []).filter((_, index) => chosen.has(index)).map(item => ({ id: newMemoryId(), text: item.text, source: 'imported', origin: item.origin, createdAt: at })));
  }
  return <Modal title="从桌面端导入记忆" subtitle="只读取所选的记忆文件，不读取登录凭据。勾选的条目会加到人物卡上，保存人物卡后生效。" onClose={onClose} className="memory-import-dialog">
    <div className="modal-body">
      {sources === null ? <p className="memory-empty"><LoaderCircle size={14} className="spin" /> 正在查找…</p>
        : !sources.length ? <p className="memory-empty">这台电脑上没有找到这位成员客户端的记忆文件。</p>
        : <>
          {sources.length > 1 && <label className="field">来源<select aria-label="记忆来源" value={source} onChange={event => setSource(event.target.value)}>{sources.map(item => <option key={item.id} value={item.id}>{item.label}{item.count ? `（${item.count} 条）` : ''}</option>)}</select></label>}
          {sources.length === 1 && <p className="memory-source">{sources[0].label}</p>}
          {loading ? <p className="memory-empty"><LoaderCircle size={14} className="spin" /> 正在读取…</p>
            : candidates && !candidates.length ? <p className="memory-empty">这个来源里没有可以导入的内容。</p>
            : candidates && <ul className="memory-candidates">{candidates.map((item, index) => <li key={index}>
              <label className="check-row"><input type="checkbox" checked={chosen.has(index)} disabled={known.has(item.text)} onChange={() => toggle(index)} />
                <span><span className="memory-candidate-text">{item.text}</span><small>{item.origin}{known.has(item.text) ? ' · 卡片上已有' : ''}</small></span></label>
            </li>)}</ul>}
        </>}
    </div>
    <div className="modal-footer"><button type="button" className="button quiet" onClick={onClose}>取消</button>
      <button type="button" className="button primary" disabled={!chosen.size} onClick={add}><Download size={14} />加入 {chosen.size} 条</button></div>
  </Modal>;
}

/** What a topic's summary proposed remembering: the user picks the items and the members who keep them. */
export function MemoryProposalDialog({ snapshot, thread, invoke, onClose }: { snapshot: Snapshot; thread: RoomThread; invoke: Invoke; onClose: () => void }) {
  const team = useTeam(), proposals = thread.summary?.proposals ?? [];
  const [items, setItems] = useState<Set<string>>(() => new Set(proposals)), [members, setMembers] = useState<Set<string>>(() => new Set(team.members.map(member => member.id)));
  const [busy, setBusy] = useState(false);
  const flip = (set: Set<string>, value: string) => { const next = new Set(set); if (next.has(value)) next.delete(value); else next.add(value); return next; };
  async function act(method: 'memory.accept' | 'memory.dismiss') {
    setBusy(true);
    try {
      await invoke(method, method === 'memory.accept' ? { threadId: thread.id, texts: [...items], memberIds: [...members] } : { threadId: thread.id }, method === 'memory.accept' ? `已记住 ${items.size} 条，下一轮对话生效。` : '已忽略这些提议。');
      onClose();
    } catch {} finally { setBusy(false); }
  }
  return <Modal title="可以记住的事" subtitle={`${thread.summary?.byName ?? '成员'}在压缩「${thread.title}」时发现的。勾选要记住的内容，以及由哪几位成员记住。`} onClose={() => { if (!busy) onClose(); }} className="memory-import-dialog">
    <div className="modal-body">
      <ul className="memory-candidates">{proposals.map(text => <li key={text}><label className="check-row"><input type="checkbox" checked={items.has(text)} onChange={() => setItems(previous => flip(previous, text))} /><span className="memory-candidate-text">{text}</span></label></li>)}</ul>
      <div className="field">记到谁的卡片上<div className="memory-members">{team.members.map(member => <label key={member.id} className={`memory-member ${members.has(member.id) ? 'on' : ''}`}><input type="checkbox" checked={members.has(member.id)} onChange={() => setMembers(previous => flip(previous, member.id))} /><Avatar member={member} size={22} ring={false} />{member.name}</label>)}</div></div>
    </div>
    <div className="modal-footer"><button type="button" className="button quiet" disabled={busy || !snapshot.backendReady} onClick={() => void act('memory.dismiss')}>都不需要</button>
      <button type="button" className="button primary" disabled={busy || !items.size || !members.size || !snapshot.backendReady} onClick={() => void act('memory.accept')}>{busy ? <LoaderCircle size={14} className="spin" /> : <BookmarkPlus size={14} />}记住 {items.size} 条</button></div>
  </Modal>;
}
