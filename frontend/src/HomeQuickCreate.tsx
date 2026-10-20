import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { ColorPicker } from './ColorPicker'

type Props = {
  kind: 'task' | 'project'
  onCreate: (name: string, color?: string | null) => Promise<void>
}

export function HomeQuickCreate({ kind, onCreate }: Props) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [color, setColor] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const input = useRef<HTMLInputElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef(false)
  const label = kind === 'task' ? 'タスク' : 'プロジェクト'

  useEffect(() => {
    if (open && !busy) input.current?.focus()
    else if (!open && !busy && restoreFocus.current) {
      restoreFocus.current = false
      trigger.current?.focus()
    }
  }, [open, busy])

  const close = () => {
    restoreFocus.current = true
    setOpen(false)
    setName('')
    setColor(null)
    setError('')
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (pending.current) return
    if (!name.trim()) { setError(`${label}名を入力してください`); return }
    pending.current = true
    setBusy(true)
    setError('')
    try {
      await onCreate(name.trim(), color ?? undefined)
      close()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : `${label}を作成できませんでした`)
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  return <div className={`home-quick-create home-quick-${kind}`}>
    <button ref={trigger} type="button" className="secondary-button home-add-trigger" aria-label={`${label}を作成`}
      title={`${label}を作成`} aria-expanded={open} aria-controls={`home-quick-${kind}-form`}
      disabled={busy} onClick={() => open ? close() : setOpen(true)}>＋{kind === 'task' ? ' Task' : ''}</button>
    {open && <form id={`home-quick-${kind}-form`} className="home-quick-form" aria-label={`${label}のクイック作成`} onSubmit={submit}>
      <label htmlFor={`home-quick-${kind}-name`}>{label}名</label>
      <input ref={input} id={`home-quick-${kind}-name`} value={name} onChange={event => setName(event.target.value)}
        disabled={busy} aria-invalid={Boolean(error)} aria-describedby={error ? `home-quick-${kind}-error` : undefined}
        placeholder={`${label}名`} />
      {kind === 'project' && <ColorPicker kind="project" name={name} value={color} onChange={setColor} disabled={busy} />}
      {error && <p id={`home-quick-${kind}-error`} className="error" role="alert">{error}</p>}
      <div className="home-quick-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={close}>キャンセル</button>
        <button type="submit" className="primary-action" disabled={busy}>{busy ? '作成中…' : '作成'}</button>
      </div>
    </form>}
  </div>
}
