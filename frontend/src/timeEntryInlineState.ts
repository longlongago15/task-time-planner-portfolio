import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { FocusEvent, KeyboardEvent, PointerEvent } from 'react'
import type { TimeEntry } from './timer'
import { recordDateTime, recordInterval } from './timeEntryInput'
import type { TimeEntryUpdateInput } from './timeEntryInput'
import type { ProjectChoice } from './ProjectPicker'
import type { Tag } from './TagStore'
import { timeEntryDeleteConfirmation } from './timeEntryDeleteConfirmation'

export type EntryCorrection = TimeEntryUpdateInput & { taskId?: number; projectIdSnapshot?: number | null }
export type EntryActions = { onSave: (input: EntryCorrection, id: number) => Promise<void>; onDelete: (id: number) => Promise<void>; disabled?: boolean; onUpdateTags: (taskId: number, tagIds: number[]) => Promise<void>; onCreateProject: (name: string, color?: string | null) => Promise<ProjectChoice> }
export type EntryTask = { id: number; title: string; projectName: string | null; completed?: boolean; status?: string; tags?: Tag[] }
type EntryField = 'task' | 'project' | 'tag' | 'time'
type Draft = { taskId: number; projectIdSnapshot: number | null; tagIds: number[]; originalTagIds: number[]; fields: EntryField[]; start: {date: string; time: string}; end: {date: string; time: string}; field: EntryField }

// One transaction covers all focusable controls in the Row. Only server success
// ends editing; Enter and the ensuing blur share the same in-flight guard.
export function useTimeEntryInline(entry: TimeEntry, actions: EntryActions, taskTags: (id: number) => number[], taskTitle?: string) {
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const [finished, setFinished] = useState(0)
  const root = useRef<HTMLElement | null>(null)
  const failedFocus = useRef<HTMLElement | null>(null)
  // Keep the guard through the enabled commit: disabling a focused control
  // can deliver blur after the request settles, but before this commit.
  useLayoutEffect(() => {
    if (busy) return
    pending.current = false
    const target = failedFocus.current
    failedFocus.current = null
    if (target?.isConnected && root.current?.contains(target)) target.focus()
  }, [busy, finished])
  const disabled = actions.disabled || entry.endedAt === null
  const begin = (field: Draft['field']) => {
    if (disabled || pending.current) return
    setError(''); setDraft(current => current ? {...current, field, fields: [...new Set([...current.fields, field])]} : {taskId: entry.taskId, projectIdSnapshot: entry.projectIdSnapshot, tagIds: taskTags(entry.taskId), originalTagIds: taskTags(entry.taskId), fields: [field], start: recordDateTime(entry.startedAt), end: recordDateTime(entry.endedAt ?? ''), field})
  }
  const cancel = useCallback(() => { if (!pending.current) { setDraft(null); setError('') } }, [])
  const save = async (blurred?: HTMLElement) => {
    if (!draft || pending.current || disabled) return
    let input: EntryCorrection
    try {
      input = recordInterval(draft.start, draft.end, entry)
      if (!draft.taskId) throw new Error('Taskを選択してください')
      if (Date.parse(input.endedAt) > Date.now()) throw new Error('未来の記録は登録できません')
      if (draft.taskId !== entry.taskId) input.taskId = draft.taskId
      if (draft.projectIdSnapshot !== entry.projectIdSnapshot) input.projectIdSnapshot = draft.projectIdSnapshot
    } catch (failure) { setError(failure instanceof Error ? failure.message : '日時を確認してください'); return }
    const entryChanged = input.startedAt !== entry.startedAt || input.endedAt !== entry.endedAt || Boolean(input.taskId) || 'projectIdSnapshot' in input
    const tagsChanged = draft.fields.includes('tag') && [...draft.tagIds].sort().join(',') !== [...draft.originalTagIds].sort().join(',')
    if (!entryChanged && !tagsChanged) { cancel(); return }
    const focused = blurred ?? (document.activeElement instanceof HTMLElement && root.current?.contains(document.activeElement) ? document.activeElement : null)
    pending.current = true; setBusy(true); setError('')
    try { if (entryChanged) await actions.onSave(input, entry.id); if (tagsChanged) await actions.onUpdateTags(draft.taskId, draft.tagIds); setDraft(null) }
    catch (failure) { setError(failure instanceof Error ? failure.message : '記録を更新できませんでした。再試行してください。'); failedFocus.current = focused }
    finally { setBusy(false); setFinished(current => current + 1) }
  }
  const remove = async () => {
    if (disabled || pending.current || !window.confirm(timeEntryDeleteConfirmation(entry, taskTitle))) return
    pending.current = true; setBusy(true); setError('')
    try { await actions.onDelete(entry.id) }
    catch (failure) { setError(failure instanceof Error ? failure.message : '記録を削除できませんでした') }
    finally { setBusy(false); setFinished(current => current + 1) }
  }
  return { draft, setDraft, error, busy, disabled, begin, remove, cancel, save, isEditing: (field: EntryField) => Boolean(draft?.fields.includes(field)), rowEvents: {
    ref: (element: HTMLElement | null) => { root.current = element },
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      // Clicking another Cell's whitespace must not blur to body before its editor mounts.
      if (draft && event.target instanceof Element && !event.target.closest('button,input,select,textarea,a,summary')) event.preventDefault()
    },
    onBlur: (event: FocusEvent<HTMLElement>) => { if (!event.currentTarget.contains(event.relatedTarget)) void save(event.target instanceof HTMLElement ? event.target : undefined) },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); cancel() }
      if (event.key === 'Enter' && !event.nativeEvent.isComposing && (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLButtonElement && event.target.matches('.project-picker-trigger,.tag-picker-trigger') && Boolean(draft))) { event.preventDefault(); void save() }
    },
  } }
}
export type EntryEditor = ReturnType<typeof useTimeEntryInline>
