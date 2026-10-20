import type { TimeEntry } from './timer'
import type { Tag } from './TagStore'
import { formatDuration } from './duration'
import { recordDateTime } from './timeEntryInput'
import { reportEntryForDay } from './reportMetrics'
import { TimeEntryLogRow } from './TimeEntryLogRow'
import type { EntryTimerActions } from './TaskRowActions'
import type { EntryActions, EntryTask } from './timeEntryInlineState'

type Task = EntryTask & { tags?: Tag[] }
type Project = {id: number; name: string; color?: string | null}
const minutes = (entry: TimeEntry, now: number) => Math.max(0, Math.floor(((entry.endedAt ? Date.parse(entry.endedAt) : now) - Date.parse(entry.startedAt)) / 60000))

export function HomeEntryList({entries, dates, tasks, projects, now, status, ...actions}: EntryActions & EntryTimerActions & {entries: TimeEntry[]; dates: string[]; tasks: Task[]; projects: Project[]; now: number; status: string}) {
  const records = entries.filter(entry=>dates.some(date=>reportEntryForDay(entry,date,now))).sort((a,b)=>Date.parse(b.startedAt)-Date.parse(a.startedAt)||b.id-a.id)
  const groups = [...new Set(records.map(entry=>recordDateTime(entry.startedAt).date))].sort().reverse()
  return <section className="panel home-entry-list" aria-label="記録リスト">
    {status==='error' && <p className="error" role="alert">記録を取得できませんでした。再取得してください。</p>}
    {!records.length ? <p className="empty-state">{status==='loading' ? '記録を読み込んでいます' : 'この期間の記録はありません'}</p> : groups.map(date=>{
      const group = records.filter(entry=>recordDateTime(entry.startedAt).date===date)
      const weekday = new Date(`${date.replaceAll('/','-')}T00:00:00`).getDay()
      return <section key={date} className="home-entry-group" data-entry-date={date}><header><h2>{date}（{'日月火水木金土'[weekday]}）</h2><span>合計 {formatDuration(group.reduce((sum,entry)=>sum+minutes(entry,now),0))}</span></header>
        <div className="time-entry-log-scroll"><table className="time-entry-log-table home-entry-table"><thead><tr>{['タスク名', 'プロジェクト名', 'タグ', '計測期間', '記録', '⋮', '時間計測'].map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>{group.map(entry=><TimeEntryLogRow key={entry.id} entry={entry} tasks={tasks} projects={projects} now={now} showDate={false} {...actions} />)}</tbody></table></div></section>
    })}
  </section>
}
