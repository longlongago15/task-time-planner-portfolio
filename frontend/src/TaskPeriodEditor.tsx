import { useLayoutEffect, useRef, useState } from 'react'
import { InlineTextEditor } from './InlineTextEditor'
import type { InlineEditorControls } from './InlineTextEditor'
import { formatDate, getMonthGridDates } from './calendarDates'
import { parseTaskPeriod, taskPeriodText } from './taskPeriod'
import type { TaskPeriod } from './taskPeriod'
import { UiIcon } from './UiIcon'
import { deadlineDisplay, localDate } from './taskListModel'

function PeriodCalendar({ draft, setDraft, cancel, onSelect }: InlineEditorControls & { onSelect: (value: TaskPeriod, text: string) => void }) {
  const root = useRef<HTMLSpanElement>(null)
  let selected: TaskPeriod = { startDate: null, deadline: null }
  try { selected = parseTaskPeriod(draft) } catch { /* Keep the invalid input, without feeding it into geometry. */ }
  const [month, setMonth] = useState(() => (selected.deadline ?? formatDate(new Date())).slice(0, 7) + '-01')
  const [first, setFirst] = useState<string | null>(null), [hover, setHover] = useState<string | null>(null)
  const [position, setPosition] = useState({ left: 8, top: 8 })
  useLayoutEffect(() => {
    const place = () => { const r = root.current?.parentElement?.getBoundingClientRect(), p = root.current?.getBoundingClientRect(); if (r && p) setPosition({ left: Math.max(8, Math.min(r.left, innerWidth - p.width - 8)), top: Math.max(8, Math.min(r.bottom + 4, innerHeight - p.height - 8)) }) }
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [])
  const date = new Date(`${month}T12:00:00`), today = formatDate(new Date())
  const firstDate = first && draft.includes(first.replaceAll('-', '/')) ? first : null
  const range = firstDate && hover ? [firstDate, hover].sort() : selected.startDate && selected.deadline ? [selected.startDate, selected.deadline] : null
  const pick = (value: string) => {
    if (!firstDate) { setFirst(value); setHover(value); const text = taskPeriodText(null, value, true); setDraft(text); onSelect({ startDate: null, deadline: value }, text) }
    else { const [start, end] = [firstDate, value].sort(); const text = taskPeriodText(start, end, true); setDraft(text); onSelect({ startDate: start, deadline: end }, text); setFirst(null); setHover(null) }
  }
  return <span ref={root} className="task-period-calendar shared-picker-popup" role="dialog" aria-label="期間のカレンダー" style={position} onPointerDown={event => event.preventDefault()}>
    <span className="task-period-calendar-heading"><button type="button" aria-label="前月" onClick={() => setMonth(formatDate(new Date(date.getFullYear(), date.getMonth() - 1, 1)))}><UiIcon name="chevronLeft" /></button>
      <strong>{date.getFullYear()}年{date.getMonth() + 1}月</strong><button type="button" aria-label="翌月" onClick={() => setMonth(formatDate(new Date(date.getFullYear(), date.getMonth() + 1, 1)))}><UiIcon name="chevronRight" /></button><button type="button" aria-label="期間編集を取消" onClick={cancel}><UiIcon name="close" /></button></span>
    <span className="task-period-calendar-days"><span className="task-period-weekdays" aria-hidden="true">{['月', '火', '水', '木', '金', '土', '日'].map(day => <small key={day}>{day}</small>)}</span>
      {getMonthGridDates(month).map(value => <button type="button" key={value} data-period-date={value} aria-label={value}
        aria-pressed={range ? value >= range[0] && value <= range[1] : value === selected.deadline} aria-current={value === today ? 'date' : undefined}
        className={value.slice(0, 7) === month.slice(0, 7) ? '' : 'other-month'} onMouseEnter={() => first && setHover(value)} onClick={() => pick(value)}>{Number(value.slice(8))}</button>)}
    </span>
  </span>
}

export function TaskPeriodEditor({ startDate, deadline, disabled, onSave, label, today = localDate() }: TaskPeriod & { disabled?: boolean; onSave: (value: TaskPeriod) => Promise<void>; label: string; today?: string }) {
  const [selection, setSelection] = useState<{ value: TaskPeriod; text: string } | null>(null)
  const value = taskPeriodText(startDate, deadline, true)
  const compact = taskPeriodText(startDate, deadline), relative = deadlineDisplay(deadline, today)
  return <InlineTextEditor className="task-period-input" display={[compact, relative.relative].filter(Boolean).join('  ')} displayContent={<><span className="task-period-dates">{compact}</span>{relative.relative && <small className={`task-period-relative ${relative.state}`}>{relative.relative}</small>}</>} value={value} label={label} disabled={disabled} onBegin={() => setSelection(null)}
    onSave={async draft => { if (draft === value && !selection) return; const next = selection?.text === draft ? selection.value : parseTaskPeriod(draft); if (next.startDate !== startDate || next.deadline !== deadline) await onSave(next) }} popup={controls => <PeriodCalendar {...controls} onSelect={(value, text) => setSelection({ value, text })} />} />
}
