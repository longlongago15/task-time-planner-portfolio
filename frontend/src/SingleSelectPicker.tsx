import { dismissPopupOnEscape, focusPopupControl, listenOutsidePopup, movePopupFocus, usePopupFocusReturn } from './popupInteraction'
import { positionPopup } from './popupPosition'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { PickerOption } from './PickerOption'

export function SingleSelectPicker({ value, label, display, options, onChange, disabled, className, popupClassName = '', optionAttribute }: {
  value: string; label: string; display: ReactNode; className: string; disabled?: boolean; onChange: (value: string) => void | Promise<void>
  options: { value: string; content: ReactNode; style?: CSSProperties }[]
  popupClassName?: string; optionAttribute?: string
}) {
  const root = useRef<HTMLSpanElement>(null), trigger = useRef<HTMLButtonElement>(null), popup = useRef<HTMLSpanElement>(null), pending = useRef(false), restoreFocus = useRef(false), restoreOptionFocus = useRef<string | null>(null)
  const { capture: captureFocus, restore: focusBack } = usePopupFocusReturn(root)
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [position, setPosition] = useState({ left: 8, top: 8 }), id = useId()
  useLayoutEffect(() => {
    if (!open) return
    captureFocus(trigger.current)
    const place = () => { const a = trigger.current?.getBoundingClientRect(), p = popup.current?.getBoundingClientRect(); if (a && p) setPosition(positionPopup(a, p, { width: document.documentElement.clientWidth, height: innerHeight }, { vertical: 'clamp' })) }
    place(); popup.current?.querySelector<HTMLButtonElement>('[aria-checked=true]')?.focus()
    const observer = new ResizeObserver(place)
    if (popup.current) observer.observe(popup.current)
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open, captureFocus])
  useLayoutEffect(() => {
    if (restoreFocus.current && !open && !busy && !disabled) {
      restoreFocus.current = false
      focusBack()
    }
    if (restoreOptionFocus.current !== null && open && !busy && !disabled) {
      const value = restoreOptionFocus.current
      restoreOptionFocus.current = null
      focusPopupControl(Array.from(popup.current?.querySelectorAll<HTMLButtonElement>('[data-value]') ?? []).find(option => option.dataset.value === value))
    }
  }, [open, busy, disabled, focusBack])
  useEffect(() => {
    if (!open) return
    return listenOutsidePopup(() => [root.current, popup.current], () => { if (!pending.current) setOpen(false) })
  }, [open])
  const choose = async (next: string) => {
    if (disabled || pending.current) return
    pending.current = true; setBusy(true); setError('')
    try { await onChange(next); restoreFocus.current = true; setOpen(false) }
    catch (failure) { restoreOptionFocus.current = next; setError(failure instanceof Error ? failure.message : '変更を保存できませんでした') }
    finally { pending.current = false; setBusy(false) }
  }
  return <span ref={root} className="single-select-picker" onKeyDown={event => {
    if (!open || pending.current) return
    if (dismissPopupOnEscape(event, () => { setOpen(false); focusBack() })) return
    if (movePopupFocus(popup.current, event.key, '[role=menuitemradio]')) event.preventDefault()
    if (event.key === 'Tab') setOpen(false)
  }}>
    <button ref={trigger} type="button" className={className} aria-label={label} aria-expanded={open} aria-haspopup="menu" aria-controls={open ? id : undefined} disabled={disabled || busy} onClick={() => { restoreOptionFocus.current = null; setOpen(current => !current); setError('') }}>{display}</button>
    {open && <span ref={popup} id={id} className={`shared-picker-popup ${popupClassName}`} role="menu" aria-label={label} style={position}>
      {options.map(option => <PickerOption key={option.value} value={option.value} selected={option.value === value} attributes={optionAttribute ? { [optionAttribute]: option.value } : undefined} style={option.style} disabled={disabled || busy} onClick={() => void choose(option.value)}>{option.content}</PickerOption>)}
      {error && <span role="alert" className="error">{error}</span>}
    </span>}
  </span>
}
