import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, FileCheck2, FileImage, FileMinus, FileText, FolderOpen, RefreshCw, X } from 'lucide-react';
import type { ResultPreview, RoundResults as Results } from '../shared/round-results';
import type { Invoke } from './ui';
import { Markdown } from './Markdown';
import {useRoundtableNavigation} from './roundtable-navigation';

const KIND: Record<string, string> = { added: '新增', modified: '修改', deleted: '删除', unchanged: '未改动' };
const SOURCE: Record<ResultPreview['source'], string> = { submitted: '本轮提交版本', current: '项目当前文件', previous: '删除前的旧版' };
const size = (bytes: number) => bytes < 1024 ? `${bytes} 字节` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const icon = (path: string, kind: string) => kind === 'deleted' ? <FileMinus size={14} /> : /\.(?:png|jpe?g|gif|webp|svg)$/i.test(path) ? <FileImage size={14} /> : <FileText size={14} />;

/** The round's product files: the version submitted that round (never replaced by later edits), and, once written into
 *  the project, the project's current file beside it. Click a file to read it here; nothing is executed. */
export function RoundResults({ projectId, roundId, integrationId, invoke, defaultOpen = false, paths,scopeLabel }: { projectId: string; roundId: string; integrationId: string; invoke: Invoke; defaultOpen?: boolean; paths?:string[];scopeLabel?:string }) {
  const [data, setData] = useState<Results | null>(null), [preview, setPreview] = useState<ResultPreview | null>(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [expanded, setExpanded] = useState(false), [all, setAll] = useState(false);
  const toRoundtable=useRoundtableNavigation();
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  const context = { projectId, roundId, integrationId };
  async function perform<T>(work: () => Promise<T>, done: (result: T) => void) {
    const token = ++generation.current; setBusy(true); setError(''); setNotice('');
    try { const result = await work(); if (token === generation.current) done(result); }
    catch (cause) { if (token === generation.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (token === generation.current) setBusy(false); }
  }
  function load() { setExpanded(true); void perform(() => invoke<Results>('projectFlow.round.results', context), setData); }
  useEffect(() => { if (defaultOpen) load(); }, [integrationId]);
  function show(path: string, source: ResultPreview['source']) { setPreview(null); void perform(() => invoke<ResultPreview>('projectFlow.round.preview', { ...context, path, source }), setPreview); }
  function open(path: string, mode: 'open' | 'reveal', source?: 'submitted') { void perform(() => invoke<{ revealed?: boolean }>('project.openPath', { ...context, relativePath: path, mode, ...(source ? { source } : {}) }), result => { if (result.revealed && mode === 'open') setNotice('这类文件只在文件夹中显示，不会直接运行。'); if (source) setNotice('已在文件夹中显示本轮提交版本。这是 AIROOM 保存的副本，请不要在里面修改；要改项目文件请先验收写入。'); }); }
  const files=data?.files.filter(file=>!paths||paths.includes(file.path))??[];
  const changed = files.filter(file => file.kind !== 'unchanged' || file.deliverable);
  const visible = all ? files : changed;
  return <section aria-label="本轮成果" className={`round-results ${expanded ? 'open' : ''}`}>
    <header className="round-results-head">
      <button type="button" className="round-results-toggle" disabled={busy && !expanded} aria-expanded={expanded} aria-label={expanded ? '收起成果' : '查看成果文件'} onClick={() => expanded ? setExpanded(false) : load()}>
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<strong>{scopeLabel??'成果'}</strong>{data?.availability === 'ready' && <small>{changed.length} 个文件</small>}
      </button>
      {data && <span className={`round-results-applied ${data.applied ? 'yes' : ''}`} title={data.applied ? '当前文件可能已有后续改动' : '负责人自验通过不代表已写回'}>{data.applied ? '已写入项目' : '还没写入项目'}</span>}
      {expanded && data && <button type="button" className="icon-button" aria-label="重新读取成果" title="重新读取成果" disabled={busy} onClick={load}><RefreshCw size={13} /></button>}
    </header>
    {expanded && <div className="round-results-body">
      {busy && !data && <p className="task-meta" role="status">正在读取文件…</p>}
      {data && <p className="round-results-note">{data.detail}{data.applied ? ' 项目里的文件可能已有后续改动，可以对照查看。' : ''}</p>}
      {data?.availability === 'ready' && <>
        {visible.length === 0 ? <p className="task-meta">这一轮没有新增、修改或删除文件。</p>
          : <ul className="result-files">{visible.map(file => <li key={file.path} className={`result-file change-${file.kind} ${preview?.path === file.path ? 'selected' : ''}`}>
            <button type="button" className="result-file-main" disabled={busy} title={file.kind === 'deleted' ? '查看删除前的旧版' : '查看本轮提交的版本'} aria-label={`${file.kind === 'deleted' ? '查看旧版' : '查看本轮版本'} ${file.path}`} onClick={() => show(file.path, file.kind === 'deleted' ? 'previous' : 'submitted')}>
              {icon(file.path, file.kind)}<span className="result-path">{file.path}</span>{file.deliverable && <span className="result-tag">交付</span>}<span className="result-kind">{KIND[file.kind]}</span>
            </button>
            {toRoundtable&&file.kind!=='deleted'&&<button className="link-button" aria-label={'送去圆桌评审 '+file.path} onClick={()=>toRoundtable({projectId,integrationId,path:file.path})}>送去圆桌</button>}
            {!data.applied && file.kind !== 'deleted' && <span className="result-file-tools">
              <button type="button" className="icon-button" disabled={busy} title="在文件夹中显示本轮提交版本（AIROOM 保存的副本）" aria-label={`在文件夹中显示本轮提交版本 ${file.path}`} onClick={() => open(file.path, 'reveal', 'submitted')}><FolderOpen size={14} /></button>
            </span>}
            {data.applied && file.kind !== 'deleted' && <span className="result-file-tools">
              <button type="button" className="icon-button" disabled={busy} title="查看项目当前文件" aria-label={`查看项目当前文件 ${file.path}`} onClick={() => show(file.path, 'current')}><FileCheck2 size={14} /></button>
              <button type="button" className="icon-button" disabled={busy} title="在文件夹中显示" aria-label={`在文件夹中显示 ${file.path}`} onClick={() => open(file.path, 'reveal')}><FolderOpen size={14} /></button>
              <button type="button" className="icon-button" disabled={busy} title="用默认程序打开（网页等可执行类文件只在文件夹中显示）" aria-label={`用默认程序打开 ${file.path}`} onClick={() => open(file.path, 'open')}><ExternalLink size={14} /></button>
            </span>}
          </li>)}</ul>}
        {files.length > changed.length && <button type="button" className="link-button round-results-all" onClick={() => setAll(value => !value)}>{all ? '只看本轮改动的文件' : `显示全部 ${files.length} 个文件`}</button>}
      </>}
      {preview && <div className="result-preview" role="region" aria-label={`文件预览 ${preview.path}`}>
        <header><strong>{preview.path}</strong><span className="result-tag">{SOURCE[preview.source]}</span><small>{size(preview.size)}{preview.source === 'current' ? preview.comparison === 'same' ? ' · 与本轮版本相同' : preview.comparison === 'changed' ? ' · 已有后续改动' : ' · 无法核对是否与本轮版本相同' : ''}</small>
          <button type="button" className="icon-button" aria-label="关闭预览" title="关闭预览" onClick={() => setPreview(null)}><X size={13} /></button></header>
        {preview.kind === 'image' ? <img src={preview.imageUrl} alt={preview.path} /> : preview.kind === 'text' ? preview.language === 'markdown' ? <div className="result-preview-markdown"><Markdown text={preview.content ?? ''} /></div> : <pre>{preview.content}</pre> : <p className="task-meta">这种格式或大小不支持在这里预览，文件没有被执行。</p>}
        {preview.truncated && <p className="task-meta">内容过长，只显示前 512 KB。</p>}
      </div>}
      {notice && <p className="round-results-info" role="alert">{notice}</p>}
      {error && <p className="round-results-error" role="alert">{error}</p>}
    </div>}
  </section>;
}
