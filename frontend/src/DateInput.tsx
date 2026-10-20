import { useId, useLayoutEffect, useRef, useState } from 'react'
import { deadlineCalendarDate, deadlineText, parseDeadline } from './deadline'
import { UiIcon } from './UiIcon'
import { acceptsDateDraft, parseDateInput } from './dateParser'
import { dismissPopupOnEscape, focusPopupControl } from './popupInteraction'

export function DateInput({ value, onChange, onCommit, onCancel, allowClear = false, disabled = false, autoFocus = false, name = 'deadline', label = '期限', required = false, placeholder = 'YYYY/MM/DD', variant }: {
  value: string; onChange: (value: string) => void; onCommit?: (value: string | null) => Promise<void>
  onCancel?: () => void; allowClear?: boolean; disabled?: boolean; autoFocus?: boolean; name?: string; label?: string; required?: boolean
  placeholder?: string
  variant?: 'compact'
}) {
  const id = useId(), input = useRef<HTMLInputElement>(null)
  const [error, setError] = useState(''), [month, setMonth] = useState<Date | null>(null)
  const [busy, setBusy] = useState(false), pending = useRef(false), discarded = useRef(false)
  const popup = useRef<HTMLSpanElement>(null), [position, setPosition] = useState({left: 8, top: 8})
  useLayoutEffect(() => {
    if (!month || !variant) return
    const place = () => { const a=input.current?.getBoundingClientRect(), p=popup.current?.getBoundingClientRect(); if(a&&p) setPosition({left:Math.max(8,Math.min(a.left,innerWidth-p.width-8)),top:Math.max(8,Math.min(a.bottom+4,innerHeight-p.height-8))}) }
    place();window.addEventListener('resize',place);window.addEventListener('scroll',place,true)
    return () => {window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true)}
  },[month,variant])
  const validate = async (text: string) => {
    if (disabled || pending.current || discarded.current) return
    let parsed: string | null
    try { parsed = name === 'deadline' ? parseDeadline(text) : parseDateInput(text); if (required && !parsed) throw new Error(`${label}を入力してください`) }
    catch (failure) {
      const message = (failure as Error).message
      setError(message); input.current?.setCustomValidity(message); return
    }
    setError(''); input.current?.setCustomValidity(''); onChange(deadlineText(parsed))
    if (!onCommit) return
    pending.current = true; setBusy(true)
    try { await onCommit(parsed) }
    catch (failure) { setError(failure instanceof Error ? failure.message : `${label}を保存できませんでした`) }
    finally { pending.current = false; setBusy(false) }
  }
  return <span className={`date-input deadline-input${variant ? ' compact-input' : ''}`} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) { setMonth(null); void validate(value) }
  }} onKeyDown={event => {
    if (event.key !== 'Escape') return
    if (month) dismissPopupOnEscape(event, () => { setMonth(null); focusPopupControl(input.current) })
    else if (onCancel && !pending.current) { event.preventDefault(); event.stopPropagation(); discarded.current = true; onCancel() }
  }}>
    <span className="deadline-input-controls">
      <input ref={input} type="text" name={name} aria-label={label} placeholder={placeholder} value={value} autoFocus={autoFocus}
        autoComplete="off" inputMode="numeric" required={required} maxLength={10} disabled={disabled || busy} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined}
        onChange={event => { if (!acceptsDateDraft(event.target.value)) return; input.current?.setCustomValidity(''); setError(''); onChange(event.target.value) }}
        onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void validate(value) } }} />
      <button type="button" className="deadline-calendar-trigger" aria-label={`${label}のカレンダーを開く`} aria-expanded={month !== null} disabled={disabled || busy}
        onMouseDown={event => event.preventDefault()} onClick={() => {
          // Own focus before opening, including clicks from a sibling time field.
          if (!month) focusPopupControl(input.current)
          const date = deadlineCalendarDate(value); setMonth(current => current ? null : new Date(date.getFullYear(), date.getMonth(), 1))
        }}><UiIcon name="calendar" /></button>
    </span>
    {error && <span className="error deadline-input-error" id={`${id}-error`} role="alert">{error}</span>}
    {allowClear && <button type="button" className="deadline-clear" disabled={disabled || busy} onMouseDown={event => event.preventDefault()} onClick={() => void validate('')}>期限なし</button>}
    {month && <span ref={popup} className="deadline-calendar" style={variant ? position : undefined} role="dialog" aria-label={`${label}のカレンダー`}>
      <span className="deadline-calendar-heading">
        <button type="button" aria-label="前の月" disabled={disabled || busy || month.getFullYear() === 2000 && month.getMonth() === 0} onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><UiIcon name="chevronLeft" /></button>
        <strong>{month.getFullYear()}年{month.getMonth() + 1}月</strong>
        <button type="button" aria-label="次の月" disabled={disabled || busy || month.getFullYear() === 2100 && month.getMonth() === 11} onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><UiIcon name="chevronRight" /></button>
      </span>
      <span className="deadline-calendar-days">
        {['日', '月', '火', '水', '木', '金', '土'].map(day => <small key={day}>{day}</small>)}
        {Array.from({ length: month.getDay() }, (_, i) => <span key={`blank-${i}`} />)}
        {Array.from({ length: new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate() }, (_, i) => {
          const date = `${month.getFullYear()}/${String(month.getMonth() + 1).padStart(2, '0')}/${String(i + 1).padStart(2, '0')}`
          return <button type="button" key={date} aria-label={date} disabled={disabled || busy} aria-pressed={deadlineText(parseSafe(value)) === date}
            onClick={() => { if (variant) input.current?.focus(); setMonth(null); void validate(date) }}>{i + 1}</button>
        })}
      </span>
    </span>}
  </span>
}

function parseSafe(value: string) { try { return parseDeadline(value) } catch { return null } }
