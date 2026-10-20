import type { TimeEntry } from './timer'
import { TimeEntryLogRow } from './TimeEntryLogRow'
import type { LogTask, LogProject } from './TimeEntryLogRow'
import type { EntryActions } from './timeEntryInlineState'
import type { EntryTimerActions } from './TaskRowActions'
import { LiveClock } from './GlobalTimer'

export function ProjectRecords({ projectId, projects, entries, tasks, status, onRetry, now, ...actions }: EntryActions & EntryTimerActions & {
  projectId: number; projects: LogProject[]; entries: TimeEntry[]; tasks: LogTask[]; status: 'loading' | 'ready' | 'error'; onRetry: () => void; now: number
}) {
  const records = entries.filter(entry => entry.projectIdSnapshot === projectId).sort((a,b) => b.startedAt.localeCompare(a.startedAt) || b.id-a.id)
  return <LiveClock active={records.some(entry => entry.endedAt === null)}>{liveNow => <section className="panel project-records">
    {status === 'error' && <p className="error" role="alert">時間記録を取得できませんでした。<button type="button" onClick={onRetry}>再取得</button></p>}
    {!records.length ? <p className="empty-state">{status === 'loading' ? '時間記録を読み込んでいます' : '時間記録はありません'}</p> : <div className="project-records-scroll time-entry-log-scroll"><table className="time-entry-log-table"><thead><tr>{['タスク名','タグ','計測期間','日付','記録','⋮','時間計測'].map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>{records.map(entry => <TimeEntryLogRow key={entry.id} entry={entry} tasks={tasks} projects={projects} now={Math.max(now, liveNow)} showProject={false} {...actions} />)}</tbody></table></div>}
  </section>}</LiveClock>
}
