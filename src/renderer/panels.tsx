import { useMemo, useState } from 'react';
import {
  FileText, Info, LoaderCircle, MessageSquare, PencilLine, Plus,
  Sparkles, Square, Terminal, } from 'lucide-react';
import type { Approval, Collaboration, MemberPermissions, ProviderInfo, Session, TimelineEvent } from '../shared/types';
import { Markdown } from './Markdown';
import { Avatar, useTeam, type TeamMember } from './members';
import { prettyCommand, thinkingSegments } from './timeline';
import { Empty, time, type Invoke, type Perform } from './ui';

export function PlanPanel({ events, session, provider, claudeFileScope, collaborations, onCollaboration, perform,projectWork=false }: {
  events: TimelineEvent[]; session?: Session; provider?: ProviderInfo; claudeFileScope: MemberPermissions['fileScope']; collaborations: Collaboration[]; onCollaboration: () => void; perform: Perform;
  projectWork?:boolean;
}) {
  const team = useTeam();
  const plans = events.filter(event => event.kind === 'plan');
  const reasoning = thinkingSegments(events).segments;
  const claudeLoading = [...events].reverse().find(event => event.provider === 'claude' && (event.data as any)?.loadingMode)?.data as { loadingMode?: string } | undefined;
  const claudeNativeLoading = claudeLoading ? claudeLoading.loadingMode === 'native' : claudeFileScope === 'any';
  return <>
    <div className="panel-section-title">公开计划<span>{plans.length || '—'}</span></div>
    {!plans.length ? <Empty icon={<Sparkles size={22} />} title="计划会出现在这里">成员公开计划后，会跟着实际执行更新。</Empty> : plans.map(event => <div className="plan-card" key={event.id}><div><span className="event-time">{time(event.at)}</span>{event.fidelity !== 'native' && <span className="fidelity-label">{event.fidelity === 'derived' ? '整理记录' : '简化记录'}</span>}</div><Markdown text={event.text} /></div>)}
    {reasoning.length > 0 && <><div className="panel-section-title">公开过程摘要<span>{reasoning.length}</span></div><div className="reasoning-notice"><Info size={12} />执行端原文摘要（可能是英文），不代表完整的内部思考。</div>{reasoning.map((text, index) => <div className="reasoning-card" key={index}><Markdown text={text} /></div>)}</>}
    {!projectWork&&<><div className="panel-section-title">一起协作<button onClick={onCollaboration} disabled={!session}><Plus size={13} />安排</button></div>
    {!collaborations.length ? <p className="panel-muted">请在项目会议室安排新流程。下方保留历史协作记录。</p> : collaborations.map(item => <div className="collaboration-card" key={item.id}><strong>{item.topic.split('\n')[0]}</strong><span>{item.mode === 'relay' ? '接力协作' : '各自作答 → 互审 → 汇总'} · {item.stage}</span><div className="collaboration-members">{item.members.map(member => <Avatar key={member} id={member} size={24} />)}<span>{item.status === 'running' ? '进行中' : item.status === 'paused' ? '已暂停' : item.status === 'ended' ? '流程结束' : '执行失败'}</span></div><span>历史协作记录 · 只读</span></div>)}
    </>}{session && <details className="capability-details">
      <summary>关于 {team.ofSession(session).name} 的能力</summary>
      <div className="capability-list"><span><MessageSquare size={13} />实时输出<strong>{provider ? provider.capabilities.streaming ? '支持' : '有限' : '待检查'}</strong></span><span><PencilLine size={13} />运行中补充<strong>{provider ? provider.capabilities.steer ? '当前轮可介入' : '排到下一轮' : '待检查'}</strong></span><span><Square size={12} />停止执行<strong>{provider ? provider.capabilities.cancel === 'native' ? '可以直接中断' : provider.capabilities.cancel === 'process' ? '结束成员程序' : '取消请求' : '待检查'}</strong></span><span><FileText size={13} />项目修改<strong>{session.writeMode ? '已开启' : '只读'}</strong></span></div>
      {session.provider === 'claude' && <p className="panel-muted">{claudeNativeLoading ? 'Claudia 不受限制地运行，会直接读取你的用户设置和项目约定。具体以活动记录为准。' : 'AIROOM 显式加载当前工作目录的 CLAUDE.md 和 .claude/CLAUDE.md（合计最多 64 KiB）。不自动读取父目录、规则目录、CLAUDE.local.md 和 @ 引用。具体以活动记录为准。'}</p>}
    </details>}
  </>;
}




interface QuestionView { key: string; question: string; header?: string; options: { label: string; description?: string }[]; multiSelect?: boolean }
function questionsFor(approval: Approval): QuestionView[] {
  const value = approval.questions;
  const raw = Array.isArray(value) ? value : value && typeof value === 'object' && 'questions' in value ? (value as { questions: unknown }).questions : [];
  if (!Array.isArray(raw)) return [];
  return raw.filter(item => item && typeof item === 'object').map((item, index) => ({
    key: String(item.id ?? item.key ?? item.question ?? index),
    question: String(item.question ?? item.text ?? ''), header: item.header,
    options: Array.isArray(item.options) ? item.options.map((option: unknown) => typeof option === 'string' ? { label: option } : ({ label: String((option as { label?: string }).label ?? ''), description: (option as { description?: string }).description })) : [],
    multiSelect: Boolean(item.multiSelect),
  }));
}



const ALLOW = /allow|accept|approve|answer|允许|批准|提交|同意/i;
const DENY = /deny|decline|reject|cancel|拒绝|取消/i;
function consequence(approval: Approval) {
  const category = approval.category ?? '';
  if (/command|bash|pwsh|shell/i.test(category)) return '允许后，这条命令会以你的 Windows 用户权限运行。';
  if (/file/i.test(category) || /Edit|Write/.test(category)) return '允许后，成员会修改工作副本中的文件；改动可以在“产出”里核对。';
  if (/web|fetch|search/i.test(category)) return '允许后，成员会访问网络获取资料。';
  return '允许后，成员会继续执行这一步。';
}

export function ApprovalCard({ approval, invoke, compact = false, member }: { approval: Approval; invoke: Invoke; compact?: boolean; member?: TeamMember }) {
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [busy, setBusy] = useState(false);
  const questions = questionsFor(approval);
  const team = useTeam();
  const p = member ?? team.get(approval.provider) ?? team.ofSession({provider:approval.provider});
  // Codex sends "reason\ncommand\ncwd"; show the reason as text, the command unwrapped, the directory as a note.
  const { reason, command, cwd } = useMemo(() => {
    const lines = approval.detail.trim().split('\n');
    const at = lines.findIndex(line => prettyCommand(line) !== line);
    if (at < 0) return { reason: undefined, command: undefined, cwd: undefined };
    const after = lines.slice(at + 1).join('\n').trim();
    return {
      reason: lines.slice(0, at).join('\n').trim() || undefined,
      command: prettyCommand(lines[at]),
      cwd: /^[A-Za-z]:[\\/]|^\//.test(after) && !after.includes('\n') ? after : undefined,
    };
  }, [approval.detail]);
  async function answer(choice: string) {
    setBusy(true);
    try { await invoke('approval.answer', { id: approval.id, choice, ...(approval.type === 'question' ? { answers } : {}) }); } catch {} finally { setBusy(false); }
  }
  function setQuestion(key: string, value: string, multi = false) {
    setAnswers(previous => {
      if (!multi) return { ...previous, [key]: value };
      const items = Array.isArray(previous[key]) ? previous[key] as string[] : [];
      return { ...previous, [key]: items.includes(value) ? items.filter(item => item !== value) : [...items, value] };
    });
  }
  const isQuestion = approval.type === 'question';
  return <div className={`approval-card member-${p.id} ${isQuestion ? 'question' : ''} ${compact ? 'compact' : ''}`}>
    <div className="approval-card-header"><Avatar member={p} size={30} mood="waiting" /><span><strong>{p.name}</strong>{isQuestion ? ' 想问你一个问题' : ' 想请你批准'}</span><time>{time(approval.createdAt)}</time></div>
    <h3>{approval.title}</h3>
    {reason && <p className="approval-reason">{reason}</p>}
    {command ? <div className="approval-command"><Terminal size={13} /><code>{command}</code></div> : approval.detail && !isQuestion && <pre className="approval-detail">{approval.detail}</pre>}
    {cwd && <small className="approval-cwd">在 {cwd} 中执行</small>}
    {isQuestion && approval.detail && !questions.length && <p className="approval-question-text">{approval.detail}</p>}
    {questions.map(question => <div className="approval-question" key={question.key}>
      <strong>{question.header ?? question.question}</strong>{question.header && <p>{question.question}</p>}
      {question.options.map(option => {
        const selected = Array.isArray(answers[question.key]) ? (answers[question.key] as string[]).includes(option.label) : answers[question.key] === option.label;
        return <label className={`question-option ${selected ? 'selected' : ''}`} key={option.label}><input type={question.multiSelect ? 'checkbox' : 'radio'} name={`${approval.id}-${question.key}`} checked={selected} onChange={() => setQuestion(question.key, option.label, question.multiSelect)} /><span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span></label>;
      })}
      <input className="answer-input" aria-label={`自定义回答：${question.question}`} placeholder="或者写下你自己的回答" value={typeof answers[question.key] === 'string' && !question.options.some(option => option.label === answers[question.key]) ? answers[question.key] as string : ''} onChange={event => setQuestion(question.key, event.target.value)} />
    </div>)}
    {isQuestion && !questions.length && <textarea className="answer-input" aria-label="回答成员问题" rows={3} value={String(answers.answer ?? '')} onChange={event => setAnswers({ answer: event.target.value })} placeholder="写下你的回答…" />}
    {!isQuestion && <p className="approval-consequence"><Info size={12} />{consequence(approval)}</p>}
    <div className="approval-options">{approval.options.map(option => {
      const tone = ALLOW.test(option.id + option.label) ? 'primary' : DENY.test(option.id + option.label) ? 'quiet' : 'secondary';
      const scope = option.kind && ({ allow_once: '仅本次', allow_always: '始终允许', reject_once: '仅本次拒绝', reject_always: '始终拒绝' } as Record<string,string>)[option.kind];
      return <button className={`button ${tone}`} key={option.id} disabled={busy} onClick={() => void answer(option.id)}>{busy && tone === 'primary' ? <LoaderCircle size={13} className="spin" /> : null}{option.label}{scope ? ' · ' + scope : ''}</button>;
    })}{!approval.options.length && <div className="inline-notice"><Info size={13} /><span>这个请求还没有提供可用的回应选项。</span></div>}</div>
    {!isQuestion && approval.allowChoice && <details className="approval-delegate">
      <summary>帮我批准 · 更多选项</summary>
      <div className="approval-options">
        {approval.category && <button className="button secondary" disabled={busy} onClick={() => void answer('airoom:allow-category')} title="本会话后续同类请求自动批准">本会话允许「{approval.categoryLabel ?? approval.category}」</button>}
        <button className="button secondary" disabled={busy} onClick={() => void answer('airoom:allow-all')} title="本会话后续所有审批自动批准">本会话全部自动批准</button>
      </div>
      <span className="approval-explainer">自动批准使用成员自己的“允许这次”，每一项都记入活动；可以在会话标题旁随时关闭。</span>
      {approval.denyChoice && <button className="button danger-outline" disabled={busy} onClick={() => { if (window.confirm('拒绝这项请求，并停止本轮任务？已写入的文件会保留。')) void answer('airoom:deny-stop'); }}>拒绝并停止本轮</button>}
    </details>}
    <span className="approval-explainer">操作范围以成员程序发来的请求为准；停止任务后，这个请求会失效。</span>
  </div>;
}

