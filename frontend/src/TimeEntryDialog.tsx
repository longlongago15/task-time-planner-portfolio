import { useContext, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { TimeEntry } from './timer'
import { formatEntryDate, formatEntryDuration, getElapsedSeconds } from './timer'
import { localMinuteDateTime, utcDateTime } from './timeEntryInput'
import { formatDuration } from './duration'
import { CalendarSurface } from './CalendarSurface'
import { TimerUiContext } from './TimerUiContext'
import { TimerActionIcon } from './TimerActionIcon'
import { TagChip } from './TagChip'
import type { Tag } from './TagStore'
import { TimeEntryTaskSelect } from './TimeEntryTaskSelect'
import { timeEntryDeleteConfirmation } from './timeEntryDeleteConfirmation'

export type ManualEntryInput = { taskId: number; startedAt: string; endedAt: string }
export type ActualSelection = { kind: 'create'; startedAt: string; endedAt: string; adjusted: boolean }
  | { kind: 'entry'; entry: TimeEntry }
type Props = {
  selection: ActualSelection
  anchor: HTMLElement | null
  projects: { id: number; name: string }[]
  now: number
  timerAvailable: boolean
  onPause: () => Promise<void>
  onStop: () => Promise<void>
  tasks: { id: number; title: string; projectName: string | null; tags?: Tag[] }[]
  onSave: (input: ManualEntryInput, entryId?: number) => Promise<void>
  onDelete: (entryId: number) => Promise<void>
  onClose: () => void
}

export function TimeEntryDialog({ selection, anchor, projects, now, timerAvailable, onPause, onStop, tasks, onSave, onDelete, onClose }: Props) {
  const { pending: timerPending } = useContext(TimerUiContext)
  const stopping = timerPending?.operation === 'stop' && selection.kind === 'entry' && timerPending.taskId === selection.entry.taskId
  const entry = selection.kind === 'entry' ? selection.entry : null
  const active = entry?.endedAt === null
  const [editing, setEditing] = useState(selection.kind === 'create')
  const [taskId, setTaskId] = useState(entry ? String(entry.taskId) : '')
  const [start, setStart] = useState(localMinuteDateTime(entry?.startedAt ?? (selection.kind === 'create' ? selection.startedAt : '')))
  const [end, setEnd] = useState(localMinuteDateTime(entry?.endedAt ?? (selection.kind === 'create' ? selection.endedAt : '')))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const perform = async (operation: () => Promise<void>) => {
    if (pending.current) return
    pending.current = true; setBusy(true); setError('')
    try { await operation(); onClose() } catch (failure) { setError(failure instanceof Error ? failure.message : '記録を保存できませんでした') }
    finally { pending.current = false; setBusy(false) }
  }
  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (pending.current || active) return
    try {
      if (!taskId) throw new Error('Taskを選択してください')
      const startedAt = utcDateTime(start, entry?.startedAt), endedAt = utcDateTime(end, entry?.endedAt ?? undefined)
      if (Date.parse(startedAt) >= Date.parse(endedAt)) throw new Error('終了日時は開始日時より後にしてください')
      if (Date.parse(endedAt) > Date.now()) throw new Error('未来の記録は登録できません')
      void perform(() => onSave({ taskId: Number(taskId), startedAt, endedAt }, entry?.id))
    } catch (failure) { setError(failure instanceof Error ? failure.message : '日時を確認してください') }
  }
  const task = tasks.find(task => task.id === entry?.taskId)
  const taskTitle = task?.title ?? `Task #${entry?.taskId}`
  const projectName = entry?.projectIdSnapshot == null ? '未所属' : projects.find(project => project.id === entry.projectIdSnapshot)?.name ?? `プロジェクト #${entry.projectIdSnapshot}`
  return <CalendarSurface anchor={anchor} modal={editing} className="time-entry-dialog" id="actual-detail" titleId="actualDialogTitle" busy={busy} onClose={() => { if (!pending.current) onClose() }}>
    <header className="composer-head"><h2 id="actualDialogTitle">{entry ? editing ? '記録を編集' : taskTitle : '記録を追加'}</h2>
      <button type="button" className="icon-close" aria-label="記録の操作を閉じる" title="閉じる" disabled={busy} onClick={onClose}>×</button></header>
    {editing ? <form className="time-entry-form" onSubmit={save}>
      <p className="form-hint">日時は現地時間（{Intl.DateTimeFormat().resolvedOptions().timeZone}）です。</p>
      {selection.kind === 'create' && selection.adjusted && <p className="form-hint">終了が未来にならないよう、初期日時を現在以前に調整しました。</p>}
      {entry ? <dl className="actual-detail"><div><dt>Task</dt><dd>{taskTitle}</dd></div><div><dt>Project</dt><dd>{projectName}</dd></div></dl>
        : <label>Task<TimeEntryTaskSelect tasks={tasks} disabled={busy || active} value={taskId} onChange={setTaskId} /></label>}
      <label>開始日時<input name="startedAt" type="datetime-local" step="60" required disabled={busy || active} value={start} onChange={event => setStart(event.target.value.slice(0, 16))} /></label>
      <label>終了日時<input name="endedAt" type="datetime-local" step="60" required disabled={busy || active} value={end} onChange={event => setEnd(event.target.value.slice(0, 16))} /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="composer-footer"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>キャンセル</button>
        <button type="submit" className="primary-action" disabled={busy || active}>{busy ? '保存中…' : entry ? '変更を保存' : '追加'}</button></div>
    </form> : <>
      <p className="calendar-popover-project">{projectName}</p>
      {!!task?.tags?.length && <div className="calendar-popover-tags" aria-label="タグ">{task.tags.map(tag => <TagChip key={tag.id} tag={tag} />)}</div>}
      <dl className="actual-detail"><div><dt>Task</dt><dd>{taskTitle}</dd></div>
        <div><dt>開始</dt><dd>{formatEntryDate(entry?.startedAt ?? null)}</dd></div>
        <div><dt>終了</dt><dd>{formatEntryDate(entry?.endedAt ?? null)}</dd></div>
        <div><dt>{active ? '経過時間' : '記録'}</dt><dd>{active ? `${formatDuration(Math.floor(getElapsedSeconds(entry?.startedAt ?? null, now) / 60))} · 計測中` : entry ? formatEntryDuration(entry) : '—'}</dd></div></dl>
      {active && <p className="form-hint">計測中の記録は直接編集・削除できません。一度停止または一時停止してください。</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="composer-footer actual-dialog-actions">
        <button type="button" className="secondary-button" disabled={busy || active} onClick={() => {
          if (entry) { setStart(localMinuteDateTime(entry.startedAt)); setEnd(localMinuteDateTime(entry.endedAt ?? '')); setTaskId(String(entry.taskId)); setEditing(true); setError('') }
        }}>編集</button>
        <button type="button" className="danger" disabled={busy || active} onClick={() => {
          if (entry && !pending.current && window.confirm(timeEntryDeleteConfirmation(entry, taskTitle))) void perform(() => onDelete(entry.id))
        }}>削除</button>
        {active && <><button type="button" className="secondary-button timer-text-action" data-timer-state={stopping ? 'pending' : 'active'} aria-busy={stopping} disabled={busy || !timerAvailable} onClick={() => void perform(onPause)}>{stopping && <TimerActionIcon pending />}一時停止</button>
          <button type="button" className="primary-action timer-text-action" data-timer-state={stopping ? 'pending' : 'active'} aria-busy={stopping} disabled={busy || !timerAvailable} onClick={() => void perform(onStop)}>{stopping && <TimerActionIcon pending />}終了して保存</button></>}
        <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>閉じる</button>
      </div>
    </>}
  </CalendarSurface>
}
