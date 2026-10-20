import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { ColorPicker } from './ColorPicker'

type Props = {
  editing: boolean
  name: string
  error: string
  color: string | null
  entityId?: number
  onColorChange: (color: string | null) => void
  onChange: (name: string) => void
  onSave: () => Promise<boolean>
  onClose: () => void
}

export function ProjectComposer({ editing, name, error, color, entityId, onColorChange, onChange, onSave, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const pending = useRef(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const element = dialog.current
    const previous = document.activeElement
    element?.showModal()
    input.current?.focus()
    return () => { element?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }) }
  }, [])
  useEffect(() => {
    if (busy) dialog.current?.focus()
    else if (document.activeElement === dialog.current) input.current?.focus()
  }, [busy])
  useEffect(() => {
    const element = dialog.current
    const cancel = (event: Event) => { event.preventDefault(); if (!pending.current) onClose() }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && element?.open) { event.stopPropagation(); cancel(event) }
    }
    element?.addEventListener('cancel', cancel)
    document.addEventListener('keydown', escape, true)
    return () => { element?.removeEventListener('cancel', cancel); document.removeEventListener('keydown', escape, true) }
  }, [onClose])
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    event.stopPropagation()
    if (pending.current) return
    pending.current = true; setBusy(true)
    try { await onSave() } finally { pending.current = false; setBusy(false) }
  }
  return <dialog ref={dialog} tabIndex={-1} className="project-composer" aria-labelledby="projectComposerTitle" aria-busy={busy || undefined}
    onClick={event => {
      const bounds = event.currentTarget.getBoundingClientRect()
      if (event.target === event.currentTarget && !pending.current
        && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) onClose()
    }}>
    <header className="composer-head"><h2 id="projectComposerTitle">{editing ? 'プロジェクトを編集' : 'プロジェクトを作成'}</h2>
      <button type="button" className="icon-close" disabled={busy} aria-label="閉じる" title="閉じる" onClick={onClose}>×</button></header>
    <form className="project-form" onSubmit={save} noValidate>
      <label>プロジェクト名<input ref={input} name="name" required disabled={busy} value={name} onChange={event => onChange(event.target.value)} placeholder="プロジェクト名" /></label>
      <ColorPicker kind="project" name={name} value={color} entityId={entityId} onChange={onColorChange} disabled={busy} />
      {error && <p className="error project-form-error" role="alert">{error}</p>}
      <div className="composer-footer"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>キャンセル</button>
        <button type="submit" className="primary-action" disabled={busy}>{busy ? '保存中…' : editing ? '変更を保存' : '作成'}</button></div>
    </form>
  </dialog>
}
