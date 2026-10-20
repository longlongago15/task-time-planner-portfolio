import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import type { TaskTimes } from './TaskTimeComparison'
import { parseDurationInput, formatDurationInput, formatCompactDuration } from './durationInput'
import { formatDuration } from './duration'
import type { TaskTimeEditing } from './TaskTimeSection'
import { TaskTimeSection } from './TaskTimeSection'
import { ProjectPicker } from './ProjectPicker'
import { TagPicker } from './TagPicker'
import type { Tag } from './TagStore'
import { TaskStatusPicker } from './TaskStatusPicker'
import { Button } from './Button'
import { TimeInput } from './TimeInput'
import { TaskTimerButton } from './TaskTimerButton'
import { DeadlineInput } from './DeadlineInput'
import { PriorityPicker } from './PriorityPicker'
import { TaskAttributeRow } from './TaskAttributeRow'
import { ProjectIcon, UiIcon } from './UiIcon'

export type TaskFormValue = { title: string; estimatedMinutes: string; projectId: string; priority: '' | 'HIGH' | 'MEDIUM' | 'LOW'; deadline: string; tagIds: number[]; status: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' }
type ProjectChoice = { id: number; name: string }
type Props = {
  // Presentation is shared; these options retain the caller's existing input/save contracts.
  estimateSaveMode?: 'draft' | 'immediate'
  timeInputMode?: 'text' | 'native'
  compactTimeHistory?: boolean
  timeEditing?: TaskTimeEditing
  onEstimateUpdate?: (minutes: number | null) => Promise<void>
  editing: boolean
  taskTimes?: TaskTimes
  api: string
  taskId: number | null
  refresh: number
  timerDisabled: boolean
  running: boolean
  completed: boolean
  onStart: () => Promise<boolean>
  value: TaskFormValue
  projects: ProjectChoice[]
  selectedTags?: Tag[]
  error: string
  onChange: (value: TaskFormValue | ((current: TaskFormValue) => TaskFormValue)) => void
  onSave: () => Promise<boolean>
  onCreateProject: (name: string, color?: string | null) => Promise<ProjectChoice>
  onClose: () => void
  onDelete: () => Promise<boolean>
  scheduleDraft: { date: string; startTime: string }
  onScheduleChange: (value: { date: string; startTime: string }) => void
  focusAnchor?: HTMLElement | null
  className?: string
  closeLabel?: string
  allowEmptyTitle?: boolean
  scheduleDateRequired?: boolean
  taskFieldsDisabled?: boolean
  scheduleControls?: ReactNode
  notice?: ReactNode
  extraDirty?: boolean
}

export function TaskEditorPanel({ estimateSaveMode = 'immediate', timeInputMode = 'native', compactTimeHistory = false, editing, taskTimes, api, taskId, refresh, timerDisabled, running, completed, onStart, value, projects, selectedTags, error, onChange, onSave, onCreateProject, onClose, onDelete, scheduleDraft, onScheduleChange, focusAnchor, className = '', closeLabel = '閉じる', allowEmptyTitle = false, scheduleDateRequired = false, taskFieldsDisabled = false, scheduleControls, notice, extraDirty = false, timeEditing, onEstimateUpdate }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const title = useRef<HTMLInputElement>(null)
  const pending = useRef(false)
  const [initial] = useState(() => value)
  const [initialSchedule] = useState(() => scheduleDraft)
  const estimateInput = useRef<HTMLInputElement>(null)
  const [estimateBaseline, setEstimateBaseline] = useState(initial.estimatedMinutes)
  const estimateBeforeEdit = useRef('')
  const estimatePending = useRef(false)
  const [estimateEditing, setEstimateEditing] = useState(false)
  const [estimateBusy, setEstimateBusy] = useState(false)
  const [estimateSaveError, setEstimateSaveError] = useState('')
  const [busy, setBusy] = useState(false)
  const [projectOpen, setProjectOpen] = useState(false)
  const [tagOpen, setTagOpen] = useState(false)
  const [timerError, setTimerError] = useState('')
  let estimate: number | null = null, estimateError = ''
  try {
    estimate = parseDurationInput(value.estimatedMinutes)
  } catch (failure) { estimateError = failure instanceof Error ? failure.message : '見積もりを確認してください' }
  const dirty = Boolean(estimateError) || value.title.trim() !== initial.title.trim() || value.projectId !== initial.projectId
    || estimate !== parseDurationInput(estimateBaseline) || value.priority !== initial.priority || value.deadline !== initial.deadline || value.status !== initial.status || value.tagIds.join() !== initial.tagIds.join() || scheduleDraft.date !== initialSchedule.date || scheduleDraft.startTime !== initialSchedule.startTime
  useEffect(() => { estimateInput.current?.setCustomValidity(estimateError) }, [estimateError])
  const commitEstimate = async () => {
    if (!estimateEditing || estimatePending.current || busy) return
    let minutes: number | null
    try { minutes = parseDurationInput(value.estimatedMinutes) } catch (failure) { setEstimateSaveError(failure instanceof Error ? failure.message : '見積もりを確認してください'); return }
    estimatePending.current = true; setEstimateBusy(true); setEstimateSaveError('')
    try {
      if (estimateSaveMode === 'immediate' && onEstimateUpdate && taskId !== null) { await onEstimateUpdate(minutes); setEstimateBaseline(formatDurationInput(minutes)) }
      onChange(current => ({...current, estimatedMinutes: formatDurationInput(minutes)})); setEstimateEditing(false)
    } catch (failure) { setEstimateSaveError(failure instanceof Error ? failure.message : '見積もりを保存できませんでした') }
    finally { estimatePending.current = false; setEstimateBusy(false) }
  }
  const requestClose = useCallback(() => {
    if (pending.current || estimatePending.current) return
    if (dialog.current?.querySelector('.project-picker-popup, .tag-picker-popup, .priority-popup, .single-select-picker .shared-picker-popup, .deadline-calendar') || document.querySelector('.project-composer')) return
    if ((dirty || extraDirty) && !window.confirm('変更を破棄しますか？')) return
    onClose()
  }, [dirty, extraDirty, onClose])

  useEffect(() => {
    const element = dialog.current
    const previous = focusAnchor ?? document.activeElement
    const blockId = previous instanceof HTMLElement ? previous.dataset.scheduleBlockId : undefined
    element?.showModal()
    title.current?.focus()
    return () => {
      element?.close()
      queueMicrotask(() => {
        if (element?.open) return
        const target = previous instanceof HTMLElement && previous.isConnected && !element?.contains(previous) ? previous
          : blockId ? document.querySelector<HTMLElement>(`[data-schedule-block-id="${blockId}"]`) : taskId === null ? null : document.querySelector<HTMLElement>(`[data-inbox-task-id="${taskId}"] .inbox-card-open`)
        target?.focus({ preventScroll: true })
      })
    }
  }, [taskId, focusAnchor])
  useEffect(() => {
    if (busy) dialog.current?.focus()
    else if (document.activeElement === dialog.current) title.current?.focus()
  }, [projectOpen, busy])
  useEffect(() => {
    const element = dialog.current
    const cancel = (event: Event) => {
      event.preventDefault()
      if (!pending.current) {
        requestClose()
      }
    }
    const escape = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (event.target instanceof Node && !element?.contains(event.target)) return
      if (event.key === 'Escape' && event.target instanceof Element && event.target.closest('.single-select-picker')?.querySelector('.shared-picker-popup')) return
      if (event.key === 'Escape' && event.target instanceof Element && event.target.closest('.task-time-estimate-editor,.task-editor-records,.task-editor-schedule')?.querySelector('input:not([type=hidden]),select')) return
      if (event.target instanceof Element && event.target.closest('.tag-picker')?.querySelector('.tag-picker-popup')) return
      if (event.target instanceof Element && event.target.closest('.project-picker')?.querySelector('.project-picker-popup')) return
      if (event.key === 'Escape' && event.target instanceof Element && (event.target.closest('.priority-picker')?.querySelector('.priority-popup') || event.target.closest('.deadline-input')?.querySelector('.deadline-calendar'))) return
      if (event.key === 'Tab' && element?.open) {
        const controls = Array.from(element.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]'))
          .filter(control => control.getClientRects().length > 0)
        const first = controls[0], last = controls.at(-1)
        if (!controls.length) { event.preventDefault(); element.focus() }
        else if (event.shiftKey && (document.activeElement === first || document.activeElement === element)) {
          event.preventDefault(); last?.focus()
        } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === element)) {
          event.preventDefault(); first?.focus()
        }
      }
      if (event.key === 'Escape' && element?.open) {
        event.stopPropagation()
        cancel(event)
      }
    }
    element?.addEventListener('cancel', cancel)
    document.addEventListener('keydown', escape, true)
    return () => { element?.removeEventListener('cancel', cancel); document.removeEventListener('keydown', escape, true) }
  }, [requestClose, projectOpen, tagOpen])

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (pending.current || projectOpen || tagOpen) return
    pending.current = true
    setBusy(true)
    try { await onSave() } finally { pending.current = false; setBusy(false) }
  }
  const start = async () => {
    if (pending.current || timerDisabled || running || completed) return
    pending.current = true; setBusy(true); setTimerError('')
    try { if (!await onStart()) setTimerError('計測を開始できませんでした。別のタスクの計測や完了状態を確認してください。') }
    catch { setTimerError('計測を開始できませんでした。接続を確認してください。') }
    finally { pending.current = false; setBusy(false) }
  }

  return <dialog ref={dialog} tabIndex={-1} className={`task-composer task-drawer task-editor-panel task-attribute-form shared-full-editor ${compactTimeHistory ? 'home-full-editor' : ''} ${className}`} aria-labelledby="taskComposerTitle" aria-busy={busy || undefined}
    onPointerDown={event => { const bounds = event.currentTarget.getBoundingClientRect(); if (event.target === event.currentTarget && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) requestClose() }}>
    <header className="composer-head"><div><h2 id="taskComposerTitle">{editing ? 'タスクを編集' : 'タスクを追加'}</h2></div>
      {editing && taskId !== null && <TaskTimerButton task={{ id: taskId, title: value.title, completed, status: value.status }} activeTaskId={running ? taskId : null} disabled={busy || timerDisabled} onStart={() => void start()} className="task-drawer-start" alwaysVisible />}
      <button type="button" className="icon-close" aria-label={closeLabel} title="キャンセルして閉じる" disabled={busy} onClick={requestClose}><UiIcon name="close" /></button></header>
    {timerError && <p className="error" role="alert">{timerError}</p>}
    <form onSubmit={save} className="task-form">
      <div className="task-name-section"><div className="task-name-label"><label htmlFor="task-editor-title">タスク名</label>
        </div>
        <input id="task-editor-title" ref={title} name="title" required={!allowEmptyTitle} disabled={busy || taskFieldsDisabled} value={value.title}
        onChange={event => onChange({ ...value, title: event.target.value })} placeholder="タスク名" /></div>
      <TaskAttributeRow label="ステータス" icon={<UiIcon name="statusRadial" />} className="task-status-field">
        <TaskStatusPicker label="ステータス" status={value.status} disabled={busy || taskFieldsDisabled} onChange={async status => onChange(current => ({ ...current, status }))} />
      </TaskAttributeRow>
      <TaskAttributeRow label="プロジェクト" icon={<ProjectIcon tone="neutral" />} unset={!value.projectId} className="task-project-field">
        <ProjectPicker variant="editor" cell colorSelection projects={projects} projectId={value.projectId ? Number(value.projectId) : null} disabled={busy || taskFieldsDisabled} emptyLabel="未設定"
          onChange={projectId => onChange({ ...value, projectId: projectId === null ? '' : String(projectId) })} onCreateProject={onCreateProject} onInteractionChange={setProjectOpen} />
      </TaskAttributeRow>
      <TaskAttributeRow label="タグ" icon={<UiIcon name="tag" />} unset={!value.tagIds.length} className="task-tag-field">
        <TagPicker variant="editor" tagIds={value.tagIds} selectedTags={selectedTags} showAllSelected emptyLabel="未設定" disabled={busy || taskFieldsDisabled} onChange={tagIds => onChange(current => ({ ...current, tagIds }))} onInteractionChange={setTagOpen} />
      </TaskAttributeRow>
      <TaskAttributeRow label="優先度" icon={<UiIcon name="flag" />} unset={!value.priority} className="task-priority-field">
        <PriorityPicker variant="editor" value={value.priority || null} disabled={busy || taskFieldsDisabled} onChange={priority => onChange(current => ({ ...current, priority: priority ?? '' }))} />
      </TaskAttributeRow>
      <TaskAttributeRow label="期限" icon={<UiIcon name="calendar" />} unset={!value.deadline} className="task-deadline-field">
        <DeadlineInput value={value.deadline} disabled={busy || taskFieldsDisabled} placeholder="未設定" onChange={deadline => onChange(current => ({ ...current, deadline }))} />
      </TaskAttributeRow>
      <TaskAttributeRow label="見積もり" icon={<UiIcon name="clock" />} unset={!value.estimatedMinutes}>
        <input ref={estimateInput} name="estimatedMinutes" type="text" disabled={busy || taskFieldsDisabled} aria-label="見積もり"
          value={value.estimatedMinutes} onChange={event => onChange({ ...value, estimatedMinutes: event.target.value })}
          placeholder="未設定" aria-invalid={Boolean(estimateError)} aria-describedby={`task-estimate-help${estimateError ? ' task-estimate-error' : ''}`} />
      </TaskAttributeRow>
      {estimateError && <p className="error" id="task-estimate-error" role="alert">{estimateError}</p>}
      <p id="task-estimate-help" className="task-form-help">見積もりは2h 30m / 2.5h / 150m形式で入力できます。タスク全体に必要な時間です。空欄のまま保存できます。個々の予定の長さはCalendarで設定します。</p>
      <TaskAttributeRow label="予定日" icon={<UiIcon name="calendar" />} unset={!scheduleDraft.date}>
        <DeadlineInput name="date" label="予定日" required={scheduleDateRequired} value={scheduleDraft.date} disabled={busy} placeholder="未設定" onChange={date => onScheduleChange({ ...scheduleDraft, date })} />
      </TaskAttributeRow>
      <TaskAttributeRow label="時刻" icon={<UiIcon name="clock" />} unset={!scheduleDraft.startTime}>
        {timeInputMode === 'text' ? <TimeInput value={scheduleDraft.startTime} disabled={busy} onChange={startTime => onScheduleChange({ ...scheduleDraft, startTime })} /> : <input name="startTime" aria-label="時刻" type="time" step="60" value={scheduleDraft.startTime} disabled={busy} onChange={event => onScheduleChange({ ...scheduleDraft, startTime: event.target.value })} />}
      </TaskAttributeRow>
      {scheduleControls}
      {notice}
      <TaskTimeSection compact={compactTimeHistory} api={api} taskId={taskId} refresh={refresh} draftEstimate={estimate} fallbackTask={taskTimes} editing={timeEditing}
        estimateControl={<span className="task-time-estimate-editor">{estimateEditing ? <input autoFocus aria-label="時間の見積もり" value={value.estimatedMinutes} disabled={busy || estimateBusy} aria-invalid={Boolean(estimateError || estimateSaveError)}
          onChange={event => onChange(current => ({...current, estimatedMinutes: event.target.value}))} onBlur={() => void commitEstimate()} onKeyDown={event => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void commitEstimate() }
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!estimatePending.current) { onChange(current => ({...current, estimatedMinutes: estimateBeforeEdit.current})); setEstimateEditing(false); setEstimateSaveError('') } }
          }} /> : <button type="button" data-time-estimate disabled={busy || taskFieldsDisabled} onClick={() => { estimateBeforeEdit.current = value.estimatedMinutes; setEstimateSaveError(''); setEstimateEditing(true) }}><strong className={estimate === null ? 'unset-value' : undefined}>{compactTimeHistory ? formatCompactDuration(estimate) : formatDuration(estimate)}</strong></button>}
          {estimateSaveError && <span className="error" role="alert">{estimateSaveError}</span>}</span>} />
      {error && <p className="error task-form-error" role="alert">{error}</p>}
      <div className="composer-footer"><Button variant="secondary" type="button" className="secondary-button" disabled={busy} onClick={requestClose}>キャンセル</Button>
        <Button variant="primary" type="submit" className="primary-action" disabled={busy || projectOpen || tagOpen || (editing && !dirty)}>{busy ? '保存中…' : editing ? '変更を保存' : 'タスクを追加'}</Button>
        {editing && <Button variant="danger" type="button" className="danger task-editor-delete" disabled={busy} onClick={async () => { if (pending.current) return; pending.current = true; setBusy(true); try { await onDelete() } finally { pending.current = false; setBusy(false) } }}>タスクを削除</Button>}</div>
    </form>
  </dialog>
}
