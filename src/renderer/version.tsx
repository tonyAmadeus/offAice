import { useEffect, useState } from 'react';
import { BadgeCheck, LoaderCircle } from 'lucide-react';
import type { RunningVersion } from '../shared/version';
import { dateTime, errorText, type Invoke, type Notify } from './ui';

/** Which build is running, when it was deployed, and whether the user has confirmed it works. */
export function RunningVersionCard({ invoke, notify }: { invoke: Invoke; notify: Notify }) {
  const [version, setVersion] = useState<RunningVersion>(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { let alive = true; void invoke<RunningVersion>('app.version').then(value => { if (alive) setVersion(value); }).catch(cause => { if (alive) setError(errorText(cause)); }); return () => { alive = false; }; }, []);
  async function accept() {
    setBusy(true); setError('');
    try { setVersion(await invoke<RunningVersion>('app.accept')); notify('已记录：你确认这个版本可以正常使用。'); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  }
  const commit = version?.sourceCommit?.slice(0, 7);
  return <div className="running-version" aria-label="运行版本">
    <div className="panel-section-title">运行版本</div>
    {!version ? <p className="running-version-line">{error || '正在读取…'}</p>
      : version.development ? <p className="running-version-line">从源码运行的开发版本，没有部署记录。</p>
      : <>
        <p className="running-version-line"><strong>{commit ?? '未知版本'}</strong>
          {version.builtAt && <span>构建于 {dateTime(version.builtAt)}</span>}
          {version.deployedAt && <span>部署于 {dateTime(version.deployedAt)}</span>}
          {version.sourceDirty && <span className="running-version-warn">构建时有未提交的改动</span>}</p>
        {version.mismatch ? <p className="running-version-line muted">部署记录属于另一个版本，这个副本不是正式部署的程序。</p>
          : version.acceptance === 'accepted' ? <p className="running-version-line accepted"><BadgeCheck size={14} />你已确认这个版本可以正常使用{version.acceptedAt ? `（${dateTime(version.acceptedAt)}）` : ''}</p>
          : version.acceptance === 'pending' ? <div className="running-version-accept"><span>用过一阵、确认没问题后，可以在这里记下来。</span>
            <button type="button" className="button small secondary" disabled={busy} onClick={() => void accept()}>{busy ? <LoaderCircle size={13} className="spin" /> : <BadgeCheck size={13} />}这个版本没问题</button></div>
          : <p className="running-version-line muted">没有找到部署记录。</p>}
      </>}
    {error && version && <p className="running-version-line error">{error}</p>}
  </div>;
}
