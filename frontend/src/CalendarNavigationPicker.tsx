import { useState } from 'react'
import { CalendarSurface } from './CalendarSurface'
import { UiIcon } from './UiIcon'
import { formatDate, getISOWeekNumber, getMonthGridDates, getWeekDates } from './calendarDates'

type Props = {
  mode: 'day' | 'week' | 'month'
  selectedDate: string
  today: string
  anchor: HTMLElement
  onSelect: (date: string) => void
  onClose: () => void
  range?: { start: string; end: string }
  onSelectRange?: (range: { start: string; end: string }) => void
  selectByDate?: boolean
}

export function CalendarNavigationPicker({ mode, selectedDate, today, anchor, onSelect, onClose, range, onSelectRange, selectByDate = false }: Props) {
  const [period, setPeriod] = useState(() => selectedDate.slice(0, 7) + '-01')
  const [rangeStart, setRangeStart] = useState<string | null>(null)
  const [rangeHover, setRangeHover] = useState<string | null>(null)
  const date = new Date(`${period}T12:00:00`)
  const year = date.getFullYear()
  const month = date.getMonth()
  const monthSelection = mode === 'month' && !onSelectRange && !selectByDate
  const title = monthSelection ? `${year}年` : `${year}年${month + 1}月`
  const move = (direction: number) => setPeriod(formatDate(new Date(year + (monthSelection ? direction : 0), month + (monthSelection ? 0 : direction), 1, 12)))
  const dates = getMonthGridDates(period)
  const selectedWeek = getWeekDates(selectedDate)[0]
  const weekdays = ['月', '火', '水', '木', '金', '土', '日']
  const select = (value: string) => { onSelect(value); onClose() }
  const selectRangeDate = (value: string) => {
    if (!rangeStart) { setRangeStart(value); setRangeHover(value); return }
    const [start, end] = [rangeStart, value].sort()
    onSelectRange?.({ start, end }); onClose()
  }
  const highlightedRange = rangeStart ? [rangeStart, rangeHover ?? rangeStart].sort() : range ? [range.start, range.end] : null

  return <CalendarSurface anchor={anchor} modal={false} className="calendar-navigation-picker" id="calendar-navigation-picker" titleId="calendar-navigation-picker-title" busy={false} onClose={onClose}>
    <header className="calendar-picker-header">
      <button type="button" aria-label={monthSelection ? '前年' : '前月'} onClick={() => move(-1)}><UiIcon name="chevronLeft" /></button>
      <strong id="calendar-navigation-picker-title">{title}</strong>
      <button type="button" aria-label={monthSelection ? '翌年' : '次月'} onClick={() => move(1)}><UiIcon name="chevronRight" /></button>
      <button type="button" aria-label="カレンダーピッカーを閉じる" onClick={onClose}><UiIcon name="close" /></button>
    </header>
    {onSelectRange || selectByDate ? <>
      {onSelectRange && <p className="calendar-picker-range-hint" role="status">{rangeStart ? '終了日を選択' : '開始日を選択'}</p>}
      <div className="calendar-picker-weekdays with-week-number" aria-hidden="true"><span>週</span>{weekdays.map(day => <span key={day}>{day}</span>)}</div>
      <div className="calendar-picker-range-days">
        {Array.from({ length: 6 }, (_, index) => {
          const week = dates.slice(index * 7, index * 7 + 7)
          return <div className="calendar-picker-range-week" key={week[0]}><span>W{getISOWeekNumber(week[0])}</span>{week.map(value => {
            const inRange = Boolean(onSelectRange && highlightedRange !== null && value >= highlightedRange[0] && value <= highlightedRange[1])
            const selected = onSelectRange ? inRange : value === selectedDate
            const inWeek = !onSelectRange && mode === 'week' && value >= selectedWeek && value <= getWeekDates(selectedDate)[6]
            return <button key={value} type="button" data-picker-date={value} aria-label={value} aria-pressed={selected}
              className={`${value.slice(0, 7) === period.slice(0, 7) ? '' : 'other-month'}${inRange ? ' range-selected' : ''}${inWeek ? ' week-selected' : ''}${!onSelectRange && selected ? ' date-selected' : ''}`}
              data-range-edge={inRange && (value === highlightedRange?.[0] || value === highlightedRange?.[1]) || undefined}
              aria-current={value === today ? 'date' : undefined} onMouseEnter={() => { if (rangeStart) setRangeHover(value) }}
              onFocus={() => { if (rangeStart) setRangeHover(value) }} onClick={() => onSelectRange ? selectRangeDate(value) : select(value)}>{Number(value.slice(8))}</button>
          })}</div>
        })}
      </div>
    </> : mode === 'month' ? <div className="calendar-picker-months">
      {Array.from({ length: 12 }, (_, index) => {
        const value = formatDate(new Date(year, index, 1, 12))
        return <button key={value} type="button" data-picker-month={value.slice(0, 7)} aria-pressed={value.slice(0, 7) === selectedDate.slice(0, 7)}
          aria-current={value.slice(0, 7) === today.slice(0, 7) ? 'date' : undefined} onClick={() => select(value)}>{index + 1}月</button>
      })}
    </div> : <>
      <div className={`calendar-picker-weekdays ${mode === 'week' ? 'with-week-number' : ''}`} aria-hidden="true">
        {mode === 'week' && <span>週</span>}{weekdays.map(day => <span key={day}>{day}</span>)}
      </div>
      {mode === 'day' ? <div className="calendar-picker-days">
        {dates.map(value => <button key={value} type="button" data-picker-date={value} className={value.slice(0, 7) === period.slice(0, 7) ? '' : 'other-month'}
          aria-label={value} aria-pressed={value === selectedDate} aria-current={value === today ? 'date' : undefined} onClick={() => select(value)}>{Number(value.slice(8))}</button>)}
      </div> : <div className="calendar-picker-weeks">
        {Array.from({ length: 6 }, (_, index) => {
          const week = dates.slice(index * 7, index * 7 + 7)
          const label = `W${getISOWeekNumber(week[0])} ${week[0]} – ${week[6]}`
          return <button key={week[0]} type="button" data-picker-week={week[0]} aria-label={label} aria-pressed={week[0] === selectedWeek} onClick={() => select(week[0])}>
            <span>W{getISOWeekNumber(week[0])}</span>{week.map(value => <span key={value} data-picker-date={value} className={value.slice(0, 7) === period.slice(0, 7) ? '' : 'other-month'}
              aria-current={value === today ? 'date' : undefined}>{Number(value.slice(8))}</span>)}
          </button>
        })}
      </div>}
    </>}
  </CalendarSurface>
}
