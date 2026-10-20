export type ActiveTimer = { taskId: number; startedAt: string }
export type ActiveTimerResponse = { taskId: number | null; running: boolean; startedAt: string | null }

export type TimeEntry = {
  id: number
  taskId: number
  projectIdSnapshot: number | null
  startedAt: string
  endedAt: string | null
  startAt: string
  endAt: string | null
  durationMinutes: number | null
  createdAt: string
  updatedAt: string
}

export function readActiveTimer(data: ActiveTimerResponse): ActiveTimer | null {
  if (data.running === false && data.taskId === null && data.startedAt === null) return null
  if (data.running === true && typeof data.taskId === 'number' && Number.isInteger(data.taskId) && typeof data.startedAt === 'string'
    && Number.isFinite(Date.parse(data.startedAt))) {
    return { taskId: data.taskId, startedAt: data.startedAt }
  }
  throw new Error('計測状態の応答を確認できませんでした')
}

export function getElapsedSeconds(startedAt: string | null, now = Date.now()): number {
  const start = startedAt === null ? NaN : Date.parse(startedAt)
  return Number.isFinite(start) && Number.isFinite(now) ? Math.max(0, Math.floor((now - start) / 1000)) : 0
}

export function formatEntryDate(value: string | null, end = false): string {
  if (value === null || !Number.isFinite(Date.parse(value))) return '—'
  return new Intl.DateTimeFormat('ja-JP', end
    ? { hour: '2-digit', minute: '2-digit' }
    : { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

export function formatEntryDuration(entry: TimeEntry): string {
  if (entry.endedAt === null) return '計測中'
  const minutes = entry.durationMinutes
  if (minutes === null || !Number.isFinite(minutes) || minutes < 0) return '—'
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return hours > 0 ? `${hours}時間${remainder > 0 ? `${remainder}分` : ''}` : `${remainder}分`
}

// This interval is for calendar geometry only. Formal totals come from the API.
export function entryDisplaySpan(entry: TimeEntry, now = Date.now(), includeEmpty = false): { start: number; end: number } | null {
  const start = Date.parse(entry.startedAt)
  const end = entry.endedAt === null ? now : Date.parse(entry.endedAt)
  return Number.isFinite(start) && Number.isFinite(end) && (end > start || (includeEmpty && end === start)) ? { start, end } : null
}

// Local wall-clock positions on the existing calendar axis, including visible zero-second entries.
export function entrySegmentsForLocalDay(entries: TimeEntry[], targetDate: string, now: number) {
  const dayStart = new Date(`${targetDate}T00:00:00`)
  const nextDay = new Date(dayStart)
  nextDay.setDate(nextDay.getDate() + 1)
  const minutes = (value: Date) => value.getHours() * 60 + value.getMinutes() + value.getSeconds() / 60 + value.getMilliseconds() / 60000
  return entries.flatMap(entry => {
    const span = entryDisplaySpan(entry, now, true)
    if (span === null || span.start >= nextDay.getTime() || span.end < dayStart.getTime()
      || (span.end === dayStart.getTime() && span.start < span.end)) return []
    const start = new Date(Math.max(span.start, dayStart.getTime()))
    const end = new Date(Math.min(span.end, nextDay.getTime()))
    return [{ entry, startMinutes: minutes(start), endMinutes: end.getTime() === nextDay.getTime() ? 1440 : minutes(end) }]
  })
}
