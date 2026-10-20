import { useEffect, useRef, useState } from 'react'
import { parseTimeInput } from './timeInputParser'

// Draft-only wall-clock input. Schedule validation/save remains with its caller.
export function TimeInput({ value, onChange, disabled = false, name = 'startTime', label = '時刻', variant, autoFocus, onEnter, onValidityChange }: {
  value: string; onChange: (value: string) => void; disabled?: boolean; name?: string; label?: string; variant?: 'compact'; autoFocus?: boolean; onEnter?: () => void; onValidityChange?: (valid: boolean) => void
}) {
  const input = useRef<HTMLInputElement>(null), [error, setError] = useState('')
  const [text, setText] = useState(value), emitted = useRef(value)
  useEffect(() => { if (variant && value !== emitted.current) { emitted.current = value; setText(value) } }, [value, variant])
  const change = (next: string) => { emitted.current = next; onChange(next) }
  const normalize = () => {
    try { const next = parseTimeInput(variant ? text : value); input.current?.setCustomValidity(''); setError(''); if (variant) setText(next); change(next); return true }
    catch (failure) { const message = (failure as Error).message; input.current?.setCustomValidity(message); setError(message) }
  }
  return <span className={`time-input${variant ? ' compact-input' : ''}`}><input ref={input} type="text" inputMode="numeric" autoComplete="off" name={name} aria-label={label} autoFocus={autoFocus}
    value={variant ? text : value} disabled={disabled} placeholder="未設定" aria-invalid={Boolean(error)}
    onInvalid={event => { event.preventDefault(); setError(event.currentTarget.validationMessage) }}
    onChange={event => {
      const next = event.target.value; if (variant) setText(next); setError('')
      try { const parsed = parseTimeInput(next); change(variant ? parsed : next); onValidityChange?.(true); event.target.setCustomValidity('') } catch (failure) { change(next); onValidityChange?.(false); event.target.setCustomValidity((failure as Error).message) }
    }} onBlur={normalize} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); if (normalize()) onEnter?.() } }} />
    {error && <span className="error" role="alert">{error}</span>}
  </span>
}
