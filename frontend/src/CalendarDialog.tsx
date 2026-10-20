import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { TaskEditorPanel } from './TaskEditorPanel'
import type { TaskFormValue } from './TaskEditorPanel'
import { TaskAttributeRow } from './TaskAttributeRow'
import { UiIcon } from './UiIcon'
import { formatCompactDuration, formatDurationInput, parseDurationInput } from './durationInput'
import { TaskDetail } from './TaskDetail'
import type { DetailTask, DetailTaskChanges, ScheduleField } from './TaskDetail'
import { CalendarSurface } from './CalendarSurface'
import { PLACEHOLDER_TASK_TITLE } from './taskPlaceholder'
import { DateInput } from './DateInput'
import { TimeInput } from './TimeInput'
import { parseTimeInput } from './timeInputParser'
import { Button } from './Button'
import { deadlineText, parseDeadline } from './deadline'
import type { ProjectChoice } from './ProjectPicker'
import { formatDuration, formatEndTime, plannedEnd } from './duration'

export type CalendarPlacement = {
  date: string
  type: 'TIME_UNSET' | 'TIMED' | 'ALL_DAY'
  startTime: string | null
  durationMinutes: number | null
}
export type CalendarTaskInput = { title: string; estimatedMinutes: number | null; projectId: number | null; tagIds?: number[]; priority?: 'HIGH' | 'MEDIUM' | 'LOW' | null; deadline?: string | null; status?: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' }
type DialogTask = DetailTask
export type CalendarDialogSelection =
  | { kind: 'create'; placement: CalendarPlacement }
  | { kind: 'block'; block: CalendarPlacement & { id: number }; task: DialogTask }

type Props = {
  inlineSchedule?: boolean
  compactInline?: boolean
  api: string
  refresh: number
  selection: CalendarDialogSelection
  anchor: HTMLElement | null
  projects: { id: number; name: string }[]
  activeTaskId: number | null
  timerUnavailable: boolean
  scheduleBusy?: boolean
  onCreateProject: (name: string, color?: string | null) => Promise<ProjectChoice>
  onCreateTask: (input: CalendarTaskInput) => Promise<number>
  onCreateBlock: (taskId: number, placement: CalendarPlacement) => Promise<void>
  onTaskUpdate: (taskId: number, input: Partial<CalendarTaskInput>) => Promise<void>
  onEdit: (blockId: number, placement: CalendarPlacement) => Promise<void>
  onRelease: (blockId: number) => Promise<void>
  onStart: (taskId: number) => Promise<void>
  readBlocks: (date: string) => Promise<(CalendarPlacement & { id: number; taskId: number })[]>
  onOpenTaskEditor: (taskId: number) => void
  onClose: () => void
}

export function CalendarDialog(props: Props) {
  const { selection, onClose, readBlocks } = props
  const initial = selection.kind === 'create' ? selection.placement : selection.block
  const selectedTask = selection.kind === 'block' ? selection.task : null
  const editing = selection.kind === 'create'
  const [fields, setFields] = useState<ScheduleField[]>([])
  const [date, setDate] = useState(deadlineText(initial.date))
  const [createType, setCreateType] = useState(initial.type)
  const type = !editing && (fields.includes('startTime') || fields.includes('durationMinutes')) ? 'TIMED' : editing ? createType : initial.type
  const [startTime, setStartTime] = useState(initial.type === 'TIMED' ? initial.startTime?.slice(0, 5) ?? '' : '')
  const [duration, setDuration] = useState(initial.type === 'TIMED' ? formatDurationInput(initial.durationMinutes) : '')
  const [title, setTitle] = useState(selectedTask?.title ?? '')
  const [estimate, setEstimate] = useState(formatDurationInput(selectedTask?.estimatedMinutes ?? null))
  const [projectId, setProjectId] = useState(String(selectedTask?.projectId ?? ''))
  const [createdTaskId, setCreatedTaskId] = useState<number | null>(null)
  const [priority, setPriority] = useState<TaskFormValue['priority']>('')
  const [deadline, setDeadline] = useState('')
  const [status, setStatus] = useState<TaskFormValue['status']>('NOT_STARTED')
  const [tagIds, setTagIds] = useState<number[]>([])
  const [busy, setBusy] = useState(false)
  const [endTimeValid, setEndTimeValid] = useState(true)
  const [error, setError] = useState('')
  const [dayBlocks, setDayBlocks] = useState<{ date: string; blocks: (CalendarPlacement & { id: number; taskId: number })[]; failed: boolean } | null>(null)
  const pending = useRef(false)
  const createdTask = useRef<number | null>(null)

  const normalizedDate = (() => { try { return parseDeadline(date) } catch { return null } })()
  useEffect(() => {
    if ((!editing && !fields.length) || !normalizedDate) return
    let cancelled = false
    readBlocks(normalizedDate)
      .then(blocks => { if (!cancelled) setDayBlocks({ date: normalizedDate, blocks, failed: false }) })
      .catch(() => { if (!cancelled) setDayBlocks({ date: normalizedDate, blocks: [], failed: true }) })
    return () => { cancelled = true }
  }, [normalizedDate, editing, fields.length, readBlocks])

  let durationMinutes: number | null = null, estimatedMinutes: number | null = null, durationError = '', estimateError = ''
  try { durationMinutes = parseDurationInput(duration) } catch { durationError = 'この予定の長さは「3h」「2h 30m」「150m」など、1分以上の整数分で入力してください' }
  try { estimatedMinutes = parseDurationInput(estimate) } catch (failure) { estimateError = failure instanceof Error ? failure.message : '見積もりを確認してください' }
  const placement: CalendarPlacement = {
    date: normalizedDate ?? '', type, startTime: type === 'TIMED' ? startTime : null,
    durationMinutes: type === 'TIMED' ? durationMinutes : null,
  }
  const conflicts = type === 'TIMED' && durationMinutes !== null && dayBlocks?.date === normalizedDate ? dayBlocks.blocks.filter(block => {
    if (block.type !== 'TIMED' || !block.startTime || !block.durationMinutes
      || selection.kind === 'block' && block.id === selection.block.id) return false
    const [hour, minute] = startTime.split(':').map(Number)
    const [otherHour, otherMinute] = block.startTime.split(':').map(Number)
    const start = hour * 60 + minute, otherStart = otherHour * 60 + otherMinute
    return start < otherStart + block.durationMinutes && otherStart < start + durationMinutes!
  }) : []
  const selectedTaskId = selectedTask?.id ?? createdTaskId
  const sameTaskConflict = conflicts.some(block => block.taskId === selectedTaskId)
  const differentTaskConflict = conflicts.some(block => block.taskId !== selectedTaskId)
  const close = () => { if (!pending.current) onClose() }
  const perform = async (action: () => Promise<void>, closeOnSuccess = true) => {
    if (pending.current || props.scheduleBusy) return false
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    pending.current = true; setBusy(true); setError('')
    try { await action(); if (closeOnSuccess) onClose(); return true }
    catch (failure) { setError(failure instanceof Error ? failure.message : '操作を保存できませんでした'); if (props.inlineSchedule) requestAnimationFrame(() => focused?.focus()); return false }
    finally { pending.current = false; setBusy(false) }
  }
  const beginField = (field: ScheduleField) => {
    if (!fields.length) {
      setEndTimeValid(true)
      setDate(deadlineText(initial.date)); setStartTime(initial.startTime?.slice(0, 5) ?? '')
      setDuration(formatDurationInput(initial.durationMinutes ?? 60)); setError('')
    }
    setFields(current => current.includes(field) ? current : [...current, field])
  }
  const updateTask = async (input: DetailTaskChanges) => {
    if (pending.current || !selectedTask) throw new Error('保存中です。少し待ってから再試行してください。')
    pending.current = true; setBusy(true)
    try { await props.onTaskUpdate(selectedTask.id, input) }
    finally { pending.current = false; setBusy(false) }
  }
  const save = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault()
    if (pending.current) return false
    if (selection.kind === 'block' && !fields.length) return false
    if (!normalizedDate) { setError('日付は2000〜2100年の実在する日付を入力してください'); return false }
    if (type === 'TIMED' && (!/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime) || durationMinutes === null || durationError)) {
      setError(durationError || '開始時刻とこの予定の長さを入力してください'); return false
    }
    if (selection.kind === 'create' && estimateError) { setError(estimateError); return false }
    if (selectedTask && !title.trim()) { setError('タスク名を入力してください'); return false }
    if (sameTaskConflict) { setError('同じタスクの予定と重複しています。開始時刻・この予定の長さを変更してください。'); return false }
    return perform(async () => {
      const input = { title: title.trim() || PLACEHOLDER_TASK_TITLE, estimatedMinutes, projectId: projectId === '' ? null : Number(projectId), tagIds, priority: priority || null, deadline: parseDeadline(deadline) }
      if (selection.kind === 'block') {
        await props.onEdit(selection.block.id, placement)
        setFields([])
        return
      }
      if (createdTask.current === null) {
        createdTask.current = await props.onCreateTask(input)
        setCreatedTaskId(createdTask.current)
      }
      if (status !== 'NOT_STARTED') await props.onTaskUpdate(createdTask.current, { status })
      await props.onCreateBlock(createdTask.current, placement)
    }, editing)
  }
  if (editing) {
    const editorValue: TaskFormValue = { title, estimatedMinutes: estimate, projectId, priority, deadline, tagIds, status }
    return <TaskEditorPanel estimateSaveMode="draft" timeInputMode="text" compactTimeHistory editing={false} api={props.api} taskId={null} refresh={props.refresh} timerDisabled={props.timerUnavailable} running={false} completed={false} onStart={async () => false}
      value={editorValue} projects={props.projects} error={error} onCreateProject={props.onCreateProject} onClose={close} onDelete={async () => false}
      extraDirty={duration !== (initial.type === 'TIMED' ? formatDurationInput(initial.durationMinutes) : '') || createType !== initial.type}
      className="calendar-dialog calendar-editor-create" closeLabel="予定の操作を閉じる" allowEmptyTitle scheduleDateRequired taskFieldsDisabled={createdTaskId !== null}
      onChange={update => { const next = typeof update === 'function' ? update(editorValue) : update; setTitle(next.title); setEstimate(next.estimatedMinutes); setProjectId(next.projectId); setPriority(next.priority); setDeadline(next.deadline); setTagIds(next.tagIds); setStatus(next.status) }}
      scheduleDraft={{ date, startTime }} onScheduleChange={next => { setDate(next.date); setStartTime(next.startTime); if (next.startTime !== startTime) { setCreateType(next.startTime ? 'TIMED' : editing ? createType : initial.type === 'ALL_DAY' ? 'ALL_DAY' : 'TIME_UNSET'); if (next.startTime && !duration) setDuration(formatDurationInput(60)) } }} onSave={() => save()}
      scheduleControls={<>
        {type === 'TIMED' && <TaskAttributeRow label="計画時間" icon={<UiIcon name="clock" />}><input name="durationMinutes" aria-label="この予定の長さ" value={duration} onChange={event => setDuration(event.target.value)} disabled={busy} /></TaskAttributeRow>}
      </>}
      notice={<>{createdTaskId !== null && <p role="status">タスクは作成済みです。予定保存を再試行できます。閉じると未配置タスクとして残ります。</p>}
        {sameTaskConflict && <p className="calendar-dialog-warning" role="status">同じタスクの予定と重複しています。この時間では保存できません。</p>}
        {differentTaskConflict && <p className="calendar-dialog-warning" role="status">別のタスクの予定と時間が重複しています。保存できます。</p>}
      </>} />
  }
  const changeEndTime = (endTime: string) => {
    if (!startTime || !endTime) return
    const start = Number(startTime.slice(0,2))*60 + Number(startTime.slice(3,5)), end = Number(endTime.slice(0,2))*60 + Number(endTime.slice(3,5))
    const days = Math.floor((start + (durationMinutes ?? 60)) / 1440)
    const next = days * 1440 + end - start
    setDuration(formatDurationInput(next > 0 ? next : next + 1440))
  }
  if (props.inlineSchedule && selection.kind === 'block') return <div className={`task-editor-schedule${props.compactInline ? ' task-editor-schedule-compact' : ''}`} data-task-placement-id={selection.block.id} onKeyDown={event => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape' && fields.length && !busy) { event.preventDefault(); event.stopPropagation(); setFields([]); setError('') }
    if (event.key === 'Enter' && fields.length && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); void save() }
  }}>
    <div>{fields.includes('date') ? <DateInput variant={props.compactInline ? 'compact' : undefined} autoFocus name="date" label="予定の日付" value={date} onChange={setDate} required disabled={busy} /> : <button type="button" className="task-inline-value" data-schedule-field="date" onClick={() => beginField('date')}>{props.compactInline ? initial.date.replaceAll('-', '/') : initial.date}</button>}</div>
    <div>{fields.includes('startTime') ? <span className="task-editor-schedule-times">
      {props.compactInline ? <TimeInput variant="compact" autoFocus label="予定の開始時刻" value={startTime} disabled={busy} onChange={setStartTime} onEnter={()=>void save()} /> : <input autoFocus type="time" aria-label="予定の開始時刻" value={startTime} disabled={busy} onChange={event => setStartTime(event.target.value)} />}
      <span>–</span>{props.compactInline ? <TimeInput variant="compact" name="endTime" label="予定の終了時刻" disabled={busy} value={startTime && durationMinutes ? formatEndTime(startTime,durationMinutes).slice(0,5) : ''} onValidityChange={setEndTimeValid} onEnter={()=>void save()} onChange={value=>{
        let endTime: string; try {endTime=parseTimeInput(value)} catch {return}
        changeEndTime(endTime)
      }} /> : <input type="time" aria-label="予定の終了時刻" disabled={busy} value={startTime && durationMinutes ? formatEndTime(startTime, durationMinutes).slice(0,5) : ''} onChange={event => changeEndTime(event.target.value)} />}</span> : <button type="button" className="task-inline-value" data-schedule-field="startTime" onClick={() => beginField('startTime')}>{initial.type === 'TIMED' && initial.startTime && initial.durationMinutes ? `${initial.startTime.slice(0,5)} – ${plannedEnd(selection.block)}` : initial.type === 'ALL_DAY' ? '終日' : '時刻未定'}</button>}</div>
    <div>{fields.includes('durationMinutes') ? <input autoFocus aria-label="予定の長さ" value={duration} disabled={busy} onChange={event => setDuration(event.target.value)} /> : <button type="button" className="task-inline-value" data-schedule-field="durationMinutes" onClick={() => beginField('durationMinutes')}>{props.compactInline ? formatCompactDuration(initial.durationMinutes) : formatDuration(initial.durationMinutes)}</button>}</div>
    {fields.length > 0 && <div className="calendar-inline-schedule-actions"><Button variant={props.compactInline?'secondary':undefined} type="button" disabled={busy} onClick={() => {setFields([]);setError('');setEndTimeValid(true)}}>キャンセル</Button><Button variant={props.compactInline?'primary':undefined} type="button" disabled={busy || props.scheduleBusy || (props.compactInline&&!endTimeValid)} onClick={() => void save()}>保存</Button></div>}
    {sameTaskConflict && <p role="status">同じタスクの予定と重複しています。この時間では保存できません。</p>}
    {differentTaskConflict && <p role="status">別のタスクの予定と時間が重複しています。保存できます。</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <button type="button" className="danger" disabled={busy || props.scheduleBusy} onClick={() => { if (window.confirm('この予定を解除しますか？')) void perform(() => props.onRelease(selection.block.id), false) }}>この予定を解除</button>
  </div>
  return <CalendarSurface anchor={props.anchor} modal={editing} retainDetachedAnchor={!editing} className="calendar-dialog" id="schedule-detail" titleId="calendar-dialog-title" busy={busy || !!props.scheduleBusy} onClose={close}>
    {selection.kind === 'block' && <form className="calendar-detail-form" noValidate onSubmit={save} onKeyDown={event => {
        if (event.key === 'Escape' && fields.length && !busy) { event.preventDefault(); event.stopPropagation(); setFields([]); setError('') }
      }}><TaskDetail api={props.api} refresh={props.refresh} task={selection.task} schedule={selection.block} busy={busy || !!props.scheduleBusy} activeTaskId={props.activeTaskId} timerUnavailable={props.timerUnavailable}
        titleId="calendar-dialog-title" closeLabel="予定の操作を閉じる" onClose={close} onTaskUpdate={updateTask} projects={props.projects} onCreateProject={props.onCreateProject}
        onStart={() => void perform(() => props.onStart(selection.task.id))} onOpenEditor={() => props.onOpenTaskEditor(selection.task.id)}
        onRelease={() => void perform(() => props.onRelease(selection.block.id))} onEditScheduleField={beginField}
        scheduleFields={{
          date: fields.includes('date') ? <span className="task-detail-field-editor"><DateInput autoFocus name="date" label="日付" value={date} onChange={setDate} required disabled={busy} /></span> : undefined,
          startTime: fields.includes('startTime') ? <span className="task-detail-field-editor"><input autoFocus name="startTime" aria-label="開始時刻" type="time" step="60" value={startTime} onChange={event => setStartTime(event.target.value)} disabled={busy} /></span> : undefined,
          durationMinutes: fields.includes('durationMinutes') ? <span className="task-detail-field-editor"><input autoFocus name="durationMinutes" aria-label="この予定の長さ" value={duration} onChange={event => setDuration(event.target.value)} disabled={busy} /></span> : undefined,
        }}
        scheduleActions={fields.length > 0 && <>
          {sameTaskConflict && <p className="calendar-dialog-warning" role="status">同じタスクの予定と重複しています。この時間では保存できません。</p>}
          {differentTaskConflict && <p className="calendar-dialog-warning" role="status">別のタスクの予定と時間が重複しています。保存できます。</p>}
          {dayBlocks?.date === normalizedDate && dayBlocks.failed && <p role="status">重複確認ができませんでした。予定の保存は可能です。</p>}
          <div className="calendar-inline-schedule-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => { setFields([]); setError('') }}>キャンセル</button>
            <button type="submit" className="primary-action" disabled={busy || props.scheduleBusy}>保存</button></div>
        </>} /></form>}
    {error && <p className="error" role="alert">{error}</p>}
  </CalendarSurface>
}
