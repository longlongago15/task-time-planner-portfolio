import { reportEntryForDay } from './reportMetrics.ts'
import { formatDuration } from './duration.ts'
import type { TimeEntry } from './timer.ts'

type Interval = { startMinutes: number; endMinutes: number }
export const reportShare = (minutes: number, total: number) => total > 0 && Number.isFinite(minutes / total) ? Math.max(0, minutes / total * 100) : 0
export const reportShareLabel = (share: number) => `${Number(share.toFixed(1))}%`
export const reportSummaryDifference = (minutes: number) => `${minutes === 0 ? '' : minutes > 0 ? '+' : '-'}${formatDuration(Math.abs(minutes))}`
export const reportClock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(Math.floor(minutes % 60)).padStart(2, '0')}`

// Presentation buckets only. Overall Report totals retain the existing helpers.
export function reportHourlyBuckets(plan: Interval[], actual: Interval[]) {
  return Array.from({ length: 24 }, (_, hour) => {
    const clip = (intervals: Interval[]) => intervals.map(span => ({ start: Math.max(hour * 60, span.startMinutes), end: Math.min((hour + 1) * 60, span.endMinutes) }))
      .filter(span => Number.isFinite(span.start) && Number.isFinite(span.end) && span.end > span.start)
    const merged: { start: number; end: number }[] = []
    for (const span of clip(plan).sort((a, b) => a.start - b.start)) {
      const last = merged.at(-1)
      if (last && span.start <= last.end) last.end = Math.max(last.end, span.end)
      else merged.push({ ...span })
    }
    const plannedMinutes = Math.floor(merged.reduce((sum, span) => sum + span.end - span.start, 0) + 1e-9)
    const actualMinutes = clip(actual).reduce((sum, span) => sum + Math.floor(span.end - span.start + 1e-9), 0)
    return { hour, plannedMinutes, actualMinutes, differenceMinutes: actualMinutes - plannedMinutes }
  })
}

export function reportActivityRows(entries: TimeEntry[], dates: string[], now: number) {
  return entries.flatMap(entry => {
    const spans = dates.flatMap(date => { const span = reportEntryForDay(entry, date, now); return span ? [{ date, ...span }] : [] })
    if (!spans.length) return []
    const first = spans[0], last = spans[spans.length - 1]
    return [{ entry, minutes: spans.reduce((sum, span) => sum + span.minutes, 0), startDate: first.date, endDate: last.date,
      startMinutes: first.startMinutes, endMinutes: last.endMinutes }]
  }).sort((a, b) => Date.parse(b.entry.startedAt) - Date.parse(a.entry.startedAt) || b.entry.id - a.entry.id)
}
