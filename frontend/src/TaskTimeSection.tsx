import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { TaskTimeSummary } from './TaskTimeSummary'
import { formatDuration, plannedEnd } from './duration'
import { formatEntryDate, formatEntryDuration } from './timer'
import type { TimeEntry } from './timer'
import type { TaskTimes } from './TaskTimeComparison'
import { formatCompactDuration } from './durationInput'

export type TaskTimePlacement = { id: number; taskId: number; date: string; type: 'TIMED' | 'TIME_UNSET' | 'ALL_DAY'; startTime: string | null; durationMinutes: number | null }
type Placement = TaskTimePlacement
export type TaskTimeEditing = { renderEntry: (entry: TimeEntry) => ReactNode; renderBlock: (block: Placement) => ReactNode }
type Detail = { task: TaskTimes; entries: TimeEntry[]; blocks: Placement[] }

export function TaskTimeSection({ api, taskId, refresh, draftEstimate, fallbackTask, summaryOnly = false, editing, estimateControl, compact = false }: { api: string; taskId: number | null; refresh: number; draftEstimate: number | null; fallbackTask?: TaskTimes; summaryOnly?: boolean; editing?: TaskTimeEditing; estimateControl?: ReactNode; compact?: boolean }) {
  const [data, setData] = useState<Detail | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [detail, setDetail] = useState<'recorded' | 'planned' | null>(null)
  useEffect(() => {
    if (taskId === null) return
    const controller = new AbortController()
    async function read<T>(path: string): Promise<T> {
      const response = await fetch(`${api}${path}`, { signal: controller.signal })
      if (!response.ok) throw new Error('時間情報を取得できませんでした。再取得してください。')
      return response.json() as Promise<T>
    }
    void Promise.all([read<TaskTimes>(`/tasks/${taskId}`), read<TimeEntry[]>(`/tasks/${taskId}/time-entries`), read<Placement[]>(`/schedule-blocks?taskId=${taskId}`)])
      .then(([task, entries, blocks]) => { if (!controller.signal.aborted) { setData({ task, entries: entries.filter(entry => entry.taskId === taskId), blocks: blocks.filter(block => block.taskId === taskId) }); setError('') } })
      .catch(() => { if (!controller.signal.aborted) setError('時間情報を取得できませんでした。再取得してください。') })
    return () => controller.abort()
  }, [api, taskId, refresh, retry])
  const savedTask = taskId === null ? { actualMinutes: 0, estimatedMinutes: null } : data?.task ?? fallbackTask
  const task = savedTask ? { ...savedTask, estimatedMinutes: draftEstimate } : null
  const blocks = data?.blocks ?? []
  const planned = blocks.reduce((total, block) => total + (block.type === 'TIMED' && block.durationMinutes !== null && Number.isSafeInteger(block.durationMinutes) && block.durationMinutes > 0 ? block.durationMinutes : 0), 0)
  const display = compact ? formatCompactDuration : formatDuration
  if (summaryOnly) return <div className="task-detail-time-summary">
    {error && <p className="error" role="alert">{error} <button type="button" onClick={() => setRetry(value => value + 1)}>再取得</button></p>}
    {task ? <TaskTimeSummary className="calendar-popover-totals" actualMinutes={task.actualMinutes} plannedMinutes={taskId !== null && !data ? null : planned} estimatedMinutes={task.estimatedMinutes} /> : <p role="status">時間情報を読み込んでいます</p>}
  </div>
  return <details className="task-time-section" open>
    <summary>時間</summary>
    {error && <p className="error" role="alert">{error} <button type="button" className="secondary-button" onClick={() => setRetry(value => value + 1)}>再取得</button></p>}
    {!task ? !error && <p role="status">時間情報を読み込んでいます</p> : <>
      <TaskTimeSummary compact={compact} className="task-time-totals" actualMinutes={task.actualMinutes} plannedMinutes={taskId !== null && !data ? null : planned} estimatedMinutes={task.estimatedMinutes}
        estimated={estimateControl}
        recorded={<button type="button" data-time-detail="recorded" aria-expanded={detail === 'recorded'} onClick={() => setDetail(value => value === 'recorded' ? null : 'recorded')}><strong>{display(task.actualMinutes)}</strong><small>詳細</small></button>}
        planned={<button type="button" data-time-detail="planned" aria-expanded={detail === 'planned'} onClick={() => setDetail(value => value === 'planned' ? null : 'planned')}><strong>{taskId !== null && !data ? '読込中' : display(planned)}</strong><small>詳細</small></button>} />
      {detail === 'recorded' && <section className="task-time-history" aria-label="記録の詳細">
        <h3>記録の詳細</h3>
        {taskId !== null && !data ? <p role="status">履歴を読み込んでいます</p> : data?.entries.length ? editing ? <div className="task-editor-records"><table className="time-entry-log-table"><tbody>{[...data.entries].sort((a,b) => b.startedAt.localeCompare(a.startedAt)).map(editing.renderEntry)}</tbody></table></div> : <ul>{[...data.entries].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(entry => <li key={entry.id} data-task-entry-id={entry.id}>
          <time dateTime={entry.startedAt}>{new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium' }).format(new Date(entry.startedAt))}</time>
          <span>{formatEntryDate(entry.startedAt, true)} – {formatEntryDate(entry.endedAt, true)}</span><strong>{formatEntryDuration(entry)}</strong>
        </li>)}</ul> : <p>まだ記録はありません</p>}
        <p className="task-history-total">記録合計：{display(task.actualMinutes)}</p>
      </section>}
      {detail === 'planned' && <section className="task-time-history" aria-label="計画済みの詳細">
        <h3>計画済みの詳細</h3>
        {taskId !== null && !data ? <p role="status">予定を読み込んでいます</p> : blocks.length ? editing ? <div className="task-editor-placements">{blocks.map(editing.renderBlock)}</div> : <ul>{blocks.map(block => <li key={block.id} data-task-placement-id={block.id}>
          <time>{block.date}</time><span>{block.type === 'TIMED' ? `${block.startTime?.slice(0, 5) ?? '—'} – ${plannedEnd(block)}` : block.type === 'ALL_DAY' ? '終日' : '時刻未定'}</span>
          {block.type === 'TIMED' && <strong>{display(block.durationMinutes)}</strong>}
        </li>)}</ul> : <p>配置済みの予定はありません</p>}
        {(taskId === null || data) && <p className="task-history-total">計画済み合計：{display(planned)}</p>}
      </section>}
    </>}
  </details>
}
