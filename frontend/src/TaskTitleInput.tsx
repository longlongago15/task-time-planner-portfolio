import { useRef, useState } from 'react'
import { InlineTextEditor } from './InlineTextEditor'

// Save Task metadata independently of the Timer and Schedule lifecycle.
function ExistingTaskTitleInput({ title, disabled, onSave, label, clickToEdit = false }: {
  title: string; disabled: boolean; onSave: (title: string) => Promise<void>; label: string; clickToEdit?: boolean
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const discarded = useRef(false)
  const save = async () => {
    if (discarded.current) { discarded.current = false; return }
    if (pending.current || disabled || draft === null) return
    const value = draft.trim()
    if (!value) { if (clickToEdit) setDraft(null); setError('タスク名を入力してください'); return }
    if (value === title) { setDraft(null); setError(''); return }
    pending.current = true; setBusy(true); setError('')
    try { await onSave(value); setDraft(null) }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'タスク名を保存できませんでした') }
    finally { pending.current = false; setBusy(false) }
  }
  return <span className="task-title-input">
    {clickToEdit && draft === null ? <button type="button" className="task-inline-value" disabled={disabled || busy} aria-label={label} title={title} onClick={() => { setDraft(title); setError('') }}>{title}</button>
      : <input autoFocus={clickToEdit} aria-label={label} value={draft ?? title} disabled={disabled || busy} aria-invalid={Boolean(error)}
      onChange={event => { setDraft(event.target.value); setError('') }} onBlur={() => void save()}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return
        if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
        if (event.key === 'Escape') {
          event.preventDefault(); event.stopPropagation(); discarded.current = true
          setDraft(null); setError(''); event.currentTarget.blur()
        }
      }} />}
    {error && <span className="error task-title-error" role="alert">{error}</span>}
  </span>
}

export function TaskTitleInput(props: Parameters<typeof ExistingTaskTitleInput>[0] & { variant?: 'table' }) {
  if (props.variant !== 'table') return <ExistingTaskTitleInput {...props} />
  return <InlineTextEditor className="task-title-input" display={props.title} value={props.title} label={props.label} disabled={props.disabled}
    onSave={async draft => { const title = draft.trim(); if (!title) throw new Error('タスク名を入力してください'); if (title !== props.title) await props.onSave(title) }} />
}
