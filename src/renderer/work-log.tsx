import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, CircleHelp, Download, Info, LoaderCircle, RefreshCw, Save, Terminal, XCircle } from 'lucide-react';
import type { Project } from '../shared/types';
import type { LogExport, LogReceipt, LogTarget, WorkLogEntry, WorkLogPage } from '../shared/work-log';
import { Modal } from './modals';
import { time, type Invoke } from './ui';
import { terminalText } from '../shared/display-text';
import { Avatar, useTeam } from './members';

const PHASE = { started: '已开始', progress: '进行中', completed: '原生记录已完成', failed: '原生记录显示失败', unknown: '状态未知' };
const SOURCE = { native: '原生记录', derived: '系统整理', lossy: '信息不完整' };
const STAGE: Record<string, string> = { task: '做任务', review: '检查任务', 'integration-check': '检查本轮成果', 'peer-review': '另一成员检查', 'round-report': '汇报本轮', 'requested-check': '按你的要求检查', adjudication: '裁定分歧', rearrange: '重新安排', 'supplement-delivery': '补充要求', 'next-round': '安排下一轮' };

function MemberName({ id }: { id: string }) { const member = useTeam().get(id); return <span className="log-member">{member && <Avatar member={member} size={16} ring={false} />}{member?.name ?? id}</span>; }
function phaseIcon(entry: WorkLogEntry) {
  if (!entry.tool) return entry.fidelity === 'derived' ? <Info size={13} /> : <Terminal size={13} />;
  return entry.tool.phase === 'completed' ? <CheckCircle2 size={13} /> : entry.tool.phase === 'failed' ? <XCircle size={13} /> : entry.tool.phase === 'unknown' ? <CircleHelp size={13} /> : <LoaderCircle size={13} />;
}

/** One line of the log: when, who, what happened; a command and its files in a monospace line; the raw record folded. */
export function WorkLogEntryView({ entry }: { entry: WorkLogEntry }) {
  const tool = entry.tool;
  return <li className={`log-entry phase-${tool?.phase ?? 'note'} fidelity-${entry.fidelity}`}>
    <time className="log-time" title={new Date(entry.at).toLocaleString()}>{time(entry.at)}</time>
    <span className="log-icon" aria-hidden="true">{phaseIcon(entry)}</span>
    <div className="log-main">
      <p className="log-text"><MemberName id={entry.memberId} />{terminalText(entry.text)}</p>
      {tool && <p className="log-status">{entry.fidelity === 'native' ? PHASE[tool.phase] : `记录标记：${tool.phase}`} · 退出码：{tool.exitCode ?? '未知'}{entry.fidelity !== 'native' && <span className="log-source"> · {SOURCE[entry.fidelity]}</span>}</p>}
      {tool?.command && <code className="log-command">{terminalText(tool.command)}</code>}
      {tool && tool.paths.length > 0 && <p className="log-files">{tool.paths.map(item => <span key={item} className="round-file">{item}</span>)}</p>}
      <details className="log-raw"><summary>原始记录</summary><p className="task-meta">运行 {entry.runId} · 事件 {entry.id} · 已脱敏，最多显示 16000 字</p><pre>{terminalText(entry.detail)}</pre></details>
    </div>
  </li>;
}

/** A read-only view of what members actually did for a task, a round or a background conversation. Reading never
 *  sends a member anything; saving to the project only happens after the round was accepted and written back. */
export function WorkLog({ project, target, invoke, onClose }: { project: Project; target: LogTarget; invoke: Invoke; onClose: () => void }) {
  const [data, setData] = useState<WorkLogPage | null>(null), [entries, setEntries] = useState<WorkLogEntry[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const ticket = useRef(0);
  useEffect(() => { void load(); return () => { ticket.current++; }; }, []);
  const context = { projectId: project.id, target };
  async function perform(work: () => Promise<void>) { const id = ++ticket.current; setBusy(true); setError(''); try { await work(); } catch (e) { if (id === ticket.current) setError((e as Error).message); } finally { if (id === ticket.current) setBusy(false); } }
  async function load(more = false) { const id = ticket.current + 1; await perform(async () => { const page = await invoke<WorkLogPage>('projectFlow.log', { ...context, ...(more ? { cursor: data?.cursor } : {}) }); if (id !== ticket.current) return; setData(page); setEntries(previous => more ? [...previous, ...page.entries.filter(item => !previous.some(old => old.id === item.id))] : page.entries); }); }
  async function download() { const id = ticket.current + 1; await perform(async () => { const result = await invoke<LogExport>('projectFlow.log.export', { ...context, checkpoint: data?.checkpoint }); if (id !== ticket.current) return; const saved = await invoke<{ saved: boolean; path?: string }>('file.save', { name: result.name, content: result.content, title: '导出工作日志' }); if (id === ticket.current && saved.saved) setNotice('工作日志已导出：' + saved.path); }); }
  async function write() { await perform(async () => { const receipts = await invoke<LogReceipt[]>('projectFlow.log.write', { ...context, requestId: crypto.randomUUID() }); const failed = receipts.filter(r => r.state === 'failed'); setNotice(failed.length ? '成果已经验收，部分日志保存失败，可以稍后重试。' : '工作日志已保存在项目 .airoom/logs/ 中。'); const page = await invoke<WorkLogPage>('projectFlow.log', { ...context, cursor: data?.checkpoint }); setData(page); setEntries(page.entries); }); }
  return <Modal title="工作日志" subtitle={data?.title ?? '正在读取已保存的工作记录'} className="work-log-modal" onClose={onClose}>
    <div className="modal-body work-log-body">
      <div className="work-log-bar">
        <label className="work-log-auto" title="默认关闭；只在你验收、成品写回项目后保存，负责人自验不会触发"><input type="checkbox" disabled={busy} checked={project.writeWorkLogs === true} onChange={e => { const value = e.target.checked; void perform(async () => { await invoke('project.update', { projectId: project.id, writeWorkLogs: value }); }); }} />验收写回后，自动把日志保存到项目的 .airoom/logs/</label>
        <span className="work-log-actions">
          <button type="button" className="icon-button" aria-label="重新读取" title="重新读取（成员还在工作时可看到新的记录）" disabled={busy} onClick={() => void load()}><RefreshCw size={14} /></button>
          <button type="button" className="button small secondary" disabled={busy || !data} onClick={() => void download()}><Download size={13} />导出 Markdown</button>
          {data?.canWrite && <button type="button" className="button small secondary" disabled={busy} onClick={() => void write()}><Save size={13} />保存到项目日志</button>}
        </span>
      </div>
      <p className="work-log-hint">只查看已经记下的内容，不会给成员发任务。缺少退出码时显示“未知”，成员自己的说明不等于命令真的成功。</p>
      {data && (data.runs.length > 0 || data.records.length > 0) && <div className="work-log-meta">
        {data.runs.length > 0 && <details><summary>参与的运行 {data.runs.length} 次</summary>{data.runs.map(run => <p key={run.id} className="task-meta"><MemberName id={run.memberId} /> · {STAGE[run.stage] ?? run.stage} · {run.status} · 投递 {run.delivery}{run.error ? ' · ' + run.error : ''}<br/>{run.configuration??'这次运行未记录配置'}</p>)}</details>}
        {data.records.length > 0 && <details><summary>成员的提交和检查说明 {data.records.length} 条</summary>{data.records.map(record => <p key={record.id} className="work-log-record">{record.text}</p>)}</details>}
      </div>}
      {data && (entries.length ? <ol className="work-log-list">{entries.map(entry => <WorkLogEntryView key={entry.id} entry={entry} />)}</ol> : <p className="task-meta">这个范围内暂时没有日志条目。</p>)}
      {data?.hasMore && <button type="button" className="button small secondary work-log-more" disabled={busy} onClick={() => void load(true)}>读取更多日志</button>}
      {data?.receipts.map(r => <p key={r.id} className={`task-meta ${r.state === 'failed' ? 'bad' : ''}`}>{r.state === 'written' ? '已保存：' : r.state === 'failed' ? '成果已经验收，日志保存失败：' : '正在保存：'}{r.path}{r.error ? ' · ' + r.error : ''}</p>)}
      {busy && <p className="task-meta" role="status">正在读取…</p>}{error && <p className="round-results-error" role="alert">{error}</p>}{notice && <p className="task-meta" role="status">{notice}</p>}
    </div>
    <footer className="modal-footer">{data && <small className="work-log-through">读取到第 {data.through} 条记录</small>}<button type="button" className="button small primary" onClick={onClose}>关闭日志</button></footer>
  </Modal>;
}
