import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

export type InlineEditorControls = { draft: string; setDraft: (value: string) => void; cancel: () => void }

function InlineEditorPopup({ render, ...controls }: InlineEditorControls & { render: (controls: InlineEditorControls) => ReactNode }) {
  return render(controls)
}

// Shared text-edit contract. Parsing and the existing save handler belong to the caller.
export function InlineTextEditor({ display, displayContent, value, label, disabled = false, onSave, className = '', popup, onBegin }: {
  display: string; value: string; label: string; disabled?: boolean; onSave: (draft: string) => Promise<void>; className?: string
  popup?: (controls: InlineEditorControls) => ReactNode
  displayContent?: ReactNode
  onBegin?: () => void
}) {
  const [draft, setDraft] = useState<string | null>(null), [error, setError] = useState('')
  const [committedByEnter, setCommittedByEnter] = useState(false)
  const [errorPosition, setErrorPosition] = useState({ left: 8, top: 8 })
  const root = useRef<HTMLSpanElement>(null), input = useRef<HTMLInputElement>(null), pending = useRef(false), discarded = useRef(false), restoreDisplayFocus = useRef(false), restoreInputFocus = useRef(false)
  const cancel = () => { if (!pending.current) { discarded.current = true; restoreDisplayFocus.current = true; setDraft(null); setError('') } }
  useLayoutEffect(() => {
    if (disabled || pending.current) return
    if (restoreDisplayFocus.current && draft === null) {
      restoreDisplayFocus.current = false
      if (document.activeElement === document.body || root.current?.contains(document.activeElement)) root.current?.querySelector<HTMLButtonElement>('.inline-editor-display')?.focus({ preventScroll: true })
    }
    if (restoreInputFocus.current && draft !== null && error) {
      restoreInputFocus.current = false
      input.current?.focus({ preventScroll: true })
    }
  }, [draft, error, disabled])
  useLayoutEffect(() => {
    if (!error) return
    const rect = root.current?.getBoundingClientRect()
    if (rect) setErrorPosition({ left: Math.max(8, Math.min(rect.left, innerWidth - 296)), top: Math.max(8, Math.min(rect.bottom + 4, innerHeight - 96)) })
  }, [error])
  const save = async (byEnter = false) => {
    if (discarded.current) { discarded.current = false; return }
    if (draft === null || pending.current || disabled) return
    pending.current = true; setError('')
    const restoreFocus = Boolean(root.current?.contains(document.activeElement))
    try { await onSave(draft); restoreDisplayFocus.current = restoreFocus; setCommittedByEnter(byEnter); setDraft(null) }
    catch (failure) { restoreInputFocus.current = true; setError(failure instanceof Error ? failure.message : '変更を保存できませんでした') }
    finally { pending.current = false }
  }
  return <span ref={root} className={`inline-text-editor ${className}`} data-inline-editing={draft !== null || undefined} data-inline-committed={committedByEnter || undefined}
    onPointerMove={() => committedByEnter && setCommittedByEnter(false)} onPointerLeave={() => committedByEnter && setCommittedByEnter(false)}
    onBlur={event => { if (event.target instanceof Element && event.target.closest('.inline-editor-display')) { if (!event.currentTarget.contains(event.relatedTarget)) setCommittedByEnter(false); return } if (!event.currentTarget.contains(event.relatedTarget)) void save() }}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing) return
      if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); cancel(); root.current?.querySelector<HTMLButtonElement>('.inline-editor-display')?.focus() }
      if (event.key === 'Enter' && event.target === input.current) { event.preventDefault(); event.stopPropagation(); void save(true) }
    }}>
    {draft === null ? <button type="button" className="task-inline-value inline-editor-display" disabled={disabled} aria-label={label} title={display}
      onClick={() => { discarded.current = false; restoreDisplayFocus.current = false; restoreInputFocus.current = false; setCommittedByEnter(false); onBegin?.(); setDraft(value); setError('') }}>{displayContent ?? display}</button>
      : <><input ref={input} autoFocus className="inline-editor-input" aria-label={label} aria-invalid={Boolean(error)} disabled={disabled} value={draft}
        onChange={event => { setDraft(event.target.value); setError('') }} />{popup && <InlineEditorPopup render={popup} draft={draft} setDraft={setDraft} cancel={cancel} />}</>}
    {error && <span className="inline-editor-error" role="alert" style={errorPosition}>{error}</span>}
  </span>
}
