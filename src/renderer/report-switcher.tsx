import { Avatar, useTeam } from './members';

export interface ReportEntry { id: string; name: string; count: number; historical?: boolean; unread?: boolean }

/** 成员汇报: one chip per project member. Shown in the project room and on the report page itself,
 *  where the current member is marked and the others switch the page. */
export function ReportSwitcher({ entries, current, onOpen }: { entries: ReportEntry[]; current?: string; onOpen: (memberId: string) => void }) {
  const team = useTeam();
  if (!entries.length) return null;
  return <nav className="report-switcher" aria-label="项目成员汇报">
    <span className="report-switcher-label">成员汇报</span>
    {entries.map(entry => {
      const member = team.get(entry.id), selected = current === entry.id;
      return <button key={entry.id} type="button" className={`report-chip member-${entry.id} ${selected ? 'selected' : ''} ${entry.historical ? 'historical' : ''}`}
        aria-label={entry.name + ' 的项目汇报'} aria-current={selected ? 'page' : undefined}
        title={`${entry.name} · ${entry.count ? entry.count + ' 份汇报' : '还没有汇报'}${entry.historical ? ' · 已不在名单' : ''}`} onClick={() => onOpen(entry.id)}>
        {member && <Avatar member={member} size={22} ring={false} />}<span>{entry.name}</span>
        {entry.count > 0 && <small>{entry.count}</small>}
        {entry.unread && <span className="unread-dot" aria-label="有未读汇报" />}
      </button>;
    })}
  </nav>;
}
