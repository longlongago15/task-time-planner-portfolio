import { TaskProjectLine } from './TaskProjectLine'
import type { Tag } from './TagStore'
import { getProjectColor } from './identificationColors'
import { formatDuration } from './duration'
import { reportDifference } from './reportDifference'
import type { ReportRow } from './reportMetrics'
import { reportClock, reportShare, reportShareLabel } from './reportPresentation'
import type { reportActivityRows, reportHourlyBuckets } from './reportPresentation'
import { ReportBarTooltip } from './ReportBarTooltip'
import { TimeEntryLogRow } from './TimeEntryLogRow'
import type { EntryTimerActions } from './TaskRowActions'
import type { EntryActions, EntryTask } from './timeEntryInlineState'

type Project = { id: number; name: string; color?: string | null }
type Task = EntryTask & { tags?: Tag[] }
const allocationNote = '全体の計画済みは同時刻の重複を除外しています。内訳は各タスク／プロジェクト単位で集計しています。'

export function ReportTaskTable({ title, rows, total }: { title: string; rows: ReportRow[]; total: number }) {
  return <section className="panel report-table-panel" data-report-section="tasks"><div className="report-table-heading"><h2>{title}</h2><span>{rows.length}件</span></div>
    <p className="report-allocation-note">{allocationNote}</p>
    {!rows.length ? <p className="empty-state">対象のタスクはありません</p> : <div className="weekly-breakdown-scroll"><table className="weekly-breakdown-table" data-report-table="tasks">
      <thead><tr><th>タスク名</th><th>記録割合</th><th>計画済み</th><th>記録</th><th>差</th></tr></thead>
      <tbody>{rows.map(row => { const share = reportShare(row.actualMinutes, total); return <tr key={row.id} data-report-id={row.id}>
        <th scope="row">{row.name}</th><td><span className="report-task-share"><span className="report-share-track" role="progressbar" aria-label={`${row.name}の記録割合`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={share}>
          <i style={{ width: `${share}%` }} /></span><span>{reportShareLabel(share)}</span></span></td>
        <td>{formatDuration(row.plannedMinutes)}</td><td>{formatDuration(row.actualMinutes)}</td><td className={`difference-${reportDifference(row.plannedMinutes, row.actualMinutes).tone}`}>{reportDifference(row.plannedMinutes, row.actualMinutes).displayText}</td></tr> })}</tbody>
    </table></div>}
  </section>
}

export function ReportProjectBreakdown({ rows, total, projects }: { rows: ReportRow[]; total: number; projects: Project[] }) {
  const recordedRows = rows.filter(row => row.actualMinutes > 0)
  return <section className="panel report-table-panel report-project-panel" data-report-section="projects"><div className="report-table-heading"><h2>プロジェクト別</h2><span>{rows.length}件</span></div>
    <p className="report-allocation-note">{allocationNote}</p>
    <div className="report-project-breakdown">
      {total > 0 ? <div className="report-donut"><svg viewBox="0 0 100 100" role="img" aria-label="プロジェクト別の記録割合">
        <title>{rows.filter(row => row.actualMinutes > 0).map(row => `${row.name} ${reportShareLabel(reportShare(row.actualMinutes, total))}`).join('、')}</title>
        {recordedRows.map((row, index) => { const share = reportShare(row.actualMinutes, total)
          const start = reportShare(recordedRows.slice(0, index).reduce((minutes, item) => minutes + item.actualMinutes, 0), total)
          const project = projects.find(project => project.id === row.id)
          return <circle key={row.id ?? 'unassigned'} data-project-slice={row.id ?? 'unassigned'} cx="50" cy="50" r="40" pathLength="100" fill="none"
            stroke={project ? getProjectColor(project) : '#78818B'} strokeWidth="14" strokeDasharray={`${share} ${100 - share}`} strokeDashoffset={-start} transform="rotate(-90 50 50)"><title>{row.name} {formatDuration(row.actualMinutes)} ({reportShareLabel(share)})</title></circle> })}
      </svg><div className="report-donut-total"><span>記録</span><strong>{formatDuration(total)}</strong></div></div>
        : <div className="report-project-empty"><strong>記録 0分</strong><p className="empty-state">対象期間のプロジェクト記録はありません</p></div>}
      {!!rows.length && <div className="weekly-breakdown-scroll"><table className="weekly-breakdown-table" data-report-table="projects"><thead><tr><th>プロジェクト</th><th>計画済み</th><th>記録</th><th>差</th><th>記録割合</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.id ?? 'unassigned'} data-report-id={row.id ?? 'unassigned'}><th scope="row"><TaskProjectLine project={projects.find(project => project.id === row.id)} name={row.name} hasTags={false} projectClassName="report-project-name" /></th>
          <td>{formatDuration(row.plannedMinutes)}</td><td>{formatDuration(row.actualMinutes)}</td><td className={`difference-${reportDifference(row.plannedMinutes, row.actualMinutes).tone}`}>{reportDifference(row.plannedMinutes, row.actualMinutes).displayText}</td><td>{reportShareLabel(reportShare(row.actualMinutes, total))}</td></tr>)}</tbody>
      </table></div>}
    </div>
  </section>
}

export function ReportActivityLog({ rows, tasks, projects, now, ...actions }: EntryActions & EntryTimerActions & {
  rows: ReturnType<typeof reportActivityRows>; tasks: Task[]; projects: Project[]; now: number
}) {
  const table = !rows.length ? <p className="empty-state">対象期間の記録はありません</p> : <div className="weekly-breakdown-scroll"><table className="weekly-breakdown-table" data-report-table="activity">
    <thead><tr><th>タスク名</th><th>プロジェクト名</th><th>タグ</th><th>計測期間</th><th>日付</th><th>記録</th><th>⋮</th><th>時間計測</th></tr></thead>
    <tbody>{rows.map(row=><TimeEntryLogRow key={row.entry.id} entry={row.entry} tasks={tasks} projects={projects} now={now} display={{clock: `${reportClock(row.startMinutes)}〜${reportClock(row.endMinutes)}${row.startDate !== row.endDate ? '（日跨ぎ）' : ''}`, date: row.startDate === row.endDate ? row.startDate.replaceAll('-', '/') : `${row.startDate.replaceAll('-', '/')}〜${row.endDate.replaceAll('-', '/')}`, minutes: row.minutes}} {...actions} />)}</tbody></table></div>
  return <section className="panel report-activity" data-report-section="activity"><h2>活動ログ <small>{rows.length}件</small></h2>{table}</section>
}

export function ReportHourChart({ buckets }: { buckets: ReturnType<typeof reportHourlyBuckets> }) {
  return <div className="report-chart-scroll"><div className="report-daily-chart report-hourly-chart">
    <div className="report-y-axis" aria-label="時間軸 0分から60分">{[0, 15, 30, 45, 60].map(tick => <span key={tick} style={{ bottom: `${tick / 60 * 100}%` }}>{tick}分</span>)}</div>
    <div className="period-chart" role="group" aria-label="時間帯別集計"><div className="report-chart-grid" aria-hidden="true">{[0, 15, 30, 45, 60].map(tick => <span key={tick} style={{ bottom: `${tick / 60 * 100}%` }} />)}</div>
      {buckets.map(bucket => { const tooltip = `${bucket.hour}時台\n計画済み ${bucket.plannedMinutes}分\n記録 ${bucket.actualMinutes}分\n差 ${reportDifference(bucket.plannedMinutes, bucket.actualMinutes).displayText}`
        return <div className="period-chart-column" key={bucket.hour} data-chart-hour={bucket.hour} aria-label={tooltip}>
          <ReportBarTooltip title={tooltip} planned={bucket.plannedMinutes / 60 * 100} actual={Math.min(60, bucket.actualMinutes) / 60 * 100} /><span className="period-chart-label">{bucket.hour}時</span></div> })}
    </div>
  </div></div>
}
