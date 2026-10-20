import { eventInsidePopup, focusPopupControl } from './popupInteraction'
import { positionPopup } from './popupPosition'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { TagPicker } from './TagPicker'
import { KebabSummary } from './KebabButton'
import { ProjectPicker } from './ProjectPicker'
import type { ProjectChoice } from './ProjectPicker'
import { TaskTitleInput } from './TaskTitleInput'
import { TaskRowActions } from './TaskRowActions'
import { deadlineDisplay, localDate } from './taskListModel'
import { InlineDeadlineInput } from './DeadlineInput'
import { PriorityPicker } from './PriorityPicker'
import type { ListTask } from './taskListModel'
import { formatDuration } from './duration'
import { formatCompactDuration, formatDurationInput, parseDurationInput } from './durationInput'
import { useCalendarClock } from './useCalendarClock'
import { InlineTextEditor } from './InlineTextEditor'
import { TaskPeriodEditor } from './TaskPeriodEditor'
import { TaskStatusPicker } from './TaskStatusPicker'

type EditableTask = ListTask & { completed: boolean }
export type TaskChanges = Partial<Pick<ListTask, 'title' | 'status' | 'projectId' | 'priority' | 'deadline' | 'startDate' | 'estimatedMinutes'>> & { tagIds?: number[] }

export function TaskRow<T extends EditableTask>({ task, error, projects, runningTaskId, timerDisabled, onUpdate, onCreateProject, onEdit, onDelete, onStart, onStop, hideProject = false, presentation = 'compact' }: {
  task: T; error?: string; projects: ProjectChoice[]; runningTaskId: number | null; timerDisabled: boolean
  onUpdate: (taskId: number, changes: TaskChanges) => Promise<void>; onCreateProject: (name: string, color?: string | null) => Promise<ProjectChoice>
  onEdit: (task: T) => void; onDelete: (task: T) => void; onStart: (id: number) => void; onStop: () => void; hideProject?: boolean; presentation?: 'compact' | 'regular'
}) {
  const [busy, setBusy] = useState(false), [deadlineOpen, setDeadlineOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPosition, setMenuPosition] = useState({ left: 8, top: 8 })
  const [deadlinePosition, setDeadlinePosition] = useState({ left: 8, top: 8 })
  const pending = useRef(false)
  const menu = useRef<HTMLDetailsElement>(null), dateTrigger = useRef<HTMLButtonElement>(null)
  const now = useCalendarClock(true)
  const deadline = deadlineDisplay(task.deadline, localDate(new Date(now)))
  // Column visibility never selects an editing or save contract.
  const compact = presentation === 'compact'
  useLayoutEffect(() => {
    const place = () => {
      const fit = (anchor: DOMRect, box: DOMRect) => positionPopup(anchor, box, { width: document.documentElement.clientWidth, height: innerHeight }, { align: 'end' })
      const anchor = menu.current?.querySelector('summary')?.getBoundingClientRect(), popup = menu.current?.querySelector('.task-table-actions')?.getBoundingClientRect()
      if (menuOpen && anchor && popup) setMenuPosition(fit(anchor, popup))
      const dateAnchor = dateTrigger.current?.getBoundingClientRect(), editor = dateTrigger.current?.parentElement?.querySelector('.task-deadline-editor')?.getBoundingClientRect()
      if (deadlineOpen && dateAnchor && editor) setDeadlinePosition(fit(dateAnchor, editor))
    }
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    const observer = new ResizeObserver(place)
    const editor = dateTrigger.current?.parentElement?.querySelector('.task-deadline-editor')
    if (deadlineOpen && editor) observer.observe(editor)
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [menuOpen, deadlineOpen])
  useEffect(() => {
    const outside = (event: Event) => {
      if (!eventInsidePopup(event, [menu.current])) menu.current?.removeAttribute('open')
      if (!eventInsidePopup(event, [dateTrigger.current?.parentElement ?? null])) {
        const editor = dateTrigger.current?.parentElement?.querySelector('.task-deadline-editor')
        // Let focus leave the widget and finish its Blur save before dismissing it.
        if (!pending.current && !editor?.contains(document.activeElement) && editor?.querySelector('input')?.getAttribute('aria-invalid') !== 'true') setDeadlineOpen(false)
      }
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.target instanceof Element && event.target.closest('dialog')) return
      if (menu.current?.open) { menu.current.open = false; focusPopupControl(menu.current.querySelector('summary')) }
      if (deadlineOpen) { setDeadlineOpen(false); focusPopupControl(dateTrigger.current) }
    }
    document.addEventListener('pointerdown', outside); document.addEventListener('click', outside); document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('click', outside); document.removeEventListener('keydown', escape) }
  }, [deadlineOpen])
  const update = async (changes: TaskChanges) => {
    if (pending.current) throw new Error('保存中です。少し待ってから再試行してください。')
    pending.current = true; setBusy(true)
    try { await onUpdate(task.id, changes) }
    finally { pending.current = false; setBusy(false) }
  }
  const action = (callback: () => void) => { if (menu.current) menu.current.open = false; callback() }
  return <li className={`task-table-row task-status-${task.status.toLowerCase()}`} data-task-id={task.id}>
    <div className="task-table-status"><TaskStatusPicker status={task.status} disabled={busy} label={`${task.title}のステータス`} onChange={status => update({ status })} /></div>
    <div className="task-table-name"><strong><TaskTitleInput variant="table" title={task.title} disabled={busy} clickToEdit label={`${task.title}のタスク名を編集`} onSave={title => update({ title })} /></strong></div>
    <div className="task-table-tags" data-label="タグ"><TagPicker variant={compact ? 'table' : undefined} tagIds={(task.tags ?? []).map(tag => tag.id)} selectedTags={task.tags} label={`${task.title}のタグを編集`} disabled={busy} onChange={tagIds => update({ tagIds })} /></div>
    {!hideProject && <div className="task-table-project" data-label="プロジェクト"><ProjectPicker variant="table" cell colorSelection coloredOptions projects={projects} projectId={task.projectId} disabled={busy} onChange={projectId => update({ projectId })} onCreateProject={onCreateProject} /></div>}
    <span className="task-table-priority" data-label="優先度"><PriorityPicker variant="table" label={`${task.title}の優先度`} value={task.priority ?? null} disabled={busy} onChange={priority => update({ priority })} /></span>
    {compact ? <span className="task-table-period" data-label="期間"><TaskPeriodEditor today={localDate(new Date(now))} startDate={task.startDate ?? null} deadline={task.deadline ?? null} disabled={busy} label={`${task.title}の期間を編集`} onSave={period => update(period)} /></span> : <span className={`task-table-deadline deadline-${deadline.state}`} data-label="期限">
      <button ref={dateTrigger} type="button" className="task-inline-value" aria-label={`${task.title}の期限を編集`} aria-expanded={deadlineOpen} disabled={busy} onClick={() => setDeadlineOpen(value => !value)}><span>{!task.deadline ? '' : deadline.date}</span>{deadline.relative && <small>{deadline.relative}</small>}</button>
      {deadlineOpen && <span className="task-deadline-editor" style={deadlinePosition}><InlineDeadlineInput value={task.deadline ?? null} disabled={busy}
        onCancel={() => { setDeadlineOpen(false); focusPopupControl(dateTrigger.current) }}
        onSave={async deadline => { if (deadline !== (task.deadline ?? null)) await update({ deadline }); setDeadlineOpen(false) }} /></span>}
    </span>}
    <span className="task-table-number" data-unset={task.estimatedMinutes === null} data-label="見積もり"><InlineTextEditor className="task-inline-estimate" label={`${task.title}の見積もりを編集`} display={task.estimatedMinutes === null ? '' : compact ? formatCompactDuration(task.estimatedMinutes) : formatDuration(task.estimatedMinutes)} value={formatDurationInput(task.estimatedMinutes)} disabled={busy}
      onSave={async draft => { const estimatedMinutes = parseDurationInput(draft); if (estimatedMinutes !== task.estimatedMinutes) await update({ estimatedMinutes }) }} /></span>
    <span className="task-table-number" data-label="記録">{compact ? formatCompactDuration(task.actualMinutes) : formatDuration(task.actualMinutes)}</span>
    <TaskRowActions separateTimer={compact} task={task} activeTaskId={runningTaskId} timerDisabled={timerDisabled || busy} onStart={onStart} onStop={onStop}><details ref={menu} className="task-row-menu" onToggle={event => setMenuOpen(event.currentTarget.open)}><KebabSummary label={`${task.title}の操作`} /><div className="task-table-actions" style={menuPosition}>
      <button type="button" className="task-row-edit" onClick={() => action(() => onEdit(task))} aria-label="タスクを編集" title="詳細を編集">✎ 詳細を編集</button>
      <div className="task-menu-divider" />
      <button type="button" className="task-row-icon danger" disabled={busy} onClick={() => action(() => onDelete(task))} aria-label="タスクを削除" title="削除">削除</button>
      <small className="task-created-date">作成 {task.createdAt ? localDate(new Date(task.createdAt)).replaceAll('-', '/') : '—'}</small>
    </div></details></TaskRowActions>
    {error && <p className="error task-row-error" role="alert">{error}</p>}
  </li>
}
