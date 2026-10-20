import { useRef, useState } from 'react'
import { taskStatusLabels } from './taskStatus'

export type TaskStatus = keyof typeof taskStatusLabels
export function TaskStatusChip({ status, onChange, disabled = false }: { status: string; onChange?: (status: TaskStatus) => void | Promise<void>; disabled?: boolean }) {
  const value = status in taskStatusLabels ? status as TaskStatus : 'NOT_STARTED'
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const pending = useRef(false), select = useRef<HTMLSelectElement>(null)
  const change = async (next: TaskStatus) => {
    if (!onChange || pending.current || disabled) return
    pending.current = true; setBusy(true); setError('')
    try { await onChange(next) } catch (failure) { setError(failure instanceof Error ? failure.message : 'ステータスを保存できませんでした') }
    finally { pending.current = false; setBusy(false); requestAnimationFrame(() => select.current?.focus({ preventScroll: true })) }
  }
  return <span className="task-status-control" data-task-status={value}>
    <span className={`task-status-chip ${value === 'COMPLETED' ? 'done' : value === 'IN_PROGRESS' ? 'in-progress' : 'todo'}`} aria-hidden={onChange ? true : undefined}>
      {taskStatusLabels[value]}
    </span>
    {onChange && <select ref={select} name="status" aria-label="ステータス" value={value} disabled={disabled || busy} onChange={event => void change(event.target.value as TaskStatus)}>
      {Object.entries(taskStatusLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
    </select>}
    {error && <span className="error" role="alert">{error}</span>}
  </span>
}
