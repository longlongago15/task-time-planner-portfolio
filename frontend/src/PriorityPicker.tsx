import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { priorityLabels } from './taskListModel'
import { UiIcon } from './UiIcon'
import { SingleSelectPicker } from './SingleSelectPicker'

type Priority = 'HIGH' | 'MEDIUM' | 'LOW' | null
function ExistingPriorityPicker({ value, onChange, disabled = false, label = '優先度', name = 'priority', showIndicator = false }: {
  value: Priority; onChange: (value: Priority) => void | Promise<void>; disabled?: boolean; label?: string; name?: string; showIndicator?: boolean
}) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [position, setPosition] = useState({ left: 8, top: 8 })
  const root = useRef<HTMLSpanElement>(null), trigger = useRef<HTMLButtonElement>(null), popup = useRef<HTMLSpanElement>(null), pending = useRef(false)
  const id = useId()
  useLayoutEffect(() => {
    if (!open) return
    const place = () => { const anchor = trigger.current?.getBoundingClientRect(), box = popup.current?.getBoundingClientRect(); if (anchor && box) setPosition({ left: Math.max(8, Math.min(anchor.left, innerWidth - box.width - 8)), top: Math.max(8, Math.min(anchor.bottom + 4, innerHeight - box.height - 8)) }) }
    place(); popup.current?.querySelector<HTMLButtonElement>('[aria-checked=true]')?.focus()
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open])
  useEffect(() => {
    if (!open) return
    const outside = (event: Event) => { if (!pending.current && event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false) }
    document.addEventListener('pointerdown', outside); document.addEventListener('click', outside)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('click', outside) }
  }, [open])
  const choose = async (priority: Priority) => {
    if (disabled || pending.current) return
    pending.current = true; setBusy(true); setError('')
    try { await onChange(priority); setOpen(false); trigger.current?.focus() }
    catch (failure) { setError(failure instanceof Error ? failure.message : '優先度を保存できませんでした') }
    finally { pending.current = false; setBusy(false) }
  }
  return <span ref={root} className="priority-picker" onKeyDown={event => {
    if (!open || pending.current) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus() }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      const buttons = Array.from(popup.current?.querySelectorAll<HTMLButtonElement>('[role=menuitemradio]') ?? [])
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
      event.preventDefault(); buttons[next]?.focus()
    }
    if (event.key === 'Tab') setOpen(false)
  }}>
    <input type="hidden" name={name} value={value ?? ''} />
    <button ref={trigger} type="button" className={`task-priority-pill priority-${value?.toLowerCase() ?? 'none'}`} aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      disabled={disabled || busy} onClick={() => setOpen(current => !current)}>{showIndicator ? <><span>{priorityLabels[value ?? '']}</span><UiIcon name="chevronDown" /></> : value ? priorityLabels[value] : null}</button>
    {open && <span ref={popup} id={id} className="priority-popup" role="menu" aria-label="優先度を選択" style={position}>
      {Object.entries(priorityLabels).map(([key, text]) => <button type="button" key={key} role="menuitemradio" aria-checked={key === (value ?? '')} data-priority={key} disabled={disabled || busy}
        onClick={() => void choose(key ? key as Priority : null)}><span className={`priority-option-label priority-${key.toLowerCase() || 'none'}`}>{text}</span><span className="priority-check">{key === (value ?? '') ? '✓' : ''}</span></button>)}
      {error && <span className="error" role="alert">{error}</span>}
    </span>}
  </span>
}

export function PriorityPicker(props: Parameters<typeof ExistingPriorityPicker>[0] & { variant?: 'table' | 'editor' }) {
  if (!props.variant) return <ExistingPriorityPicker {...props} />
  const content = (value: string) => <span className={`shared-pill priority-option-label priority-${value.toLowerCase() || 'none'}`}>{value && <UiIcon name="flag" />}{priorityLabels[value]}</span>
  return <span className="priority-picker"><input type="hidden" name={props.name ?? 'priority'} value={props.value ?? ''} /><SingleSelectPicker value={props.value ?? ''} label={props.label ?? '優先度'} disabled={props.disabled} className={`task-priority-pill priority-${props.value?.toLowerCase() ?? 'none'}`}
    popupClassName="priority-popup" optionAttribute="data-priority"
    display={props.value ? content(props.value) : props.variant === 'editor' ? content('') : null} options={Object.keys(priorityLabels).map(value => ({ value, content: content(value) }))} onChange={value => props.onChange(value ? value as Priority : null)} /></span>
}
