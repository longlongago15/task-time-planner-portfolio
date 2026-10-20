import { parseDeadline } from './deadline.ts'

export type TimeEntryUpdateInput = { startedAt: string; endedAt: string }

export function recordDateTime(value: string) {
  const local = localMinuteDateTime(value)
  return { date: local.slice(0, 10).replaceAll('-', '/'), time: local.slice(11) }
}

export function recordTimestamp(date: string, time: string, original?: string) {
  const day = parseDeadline(date)
  if (!day || !/^\d{2}:\d{2}$/.test(time) || Number(time.slice(0, 2)) > 23 || Number(time.slice(3)) > 59) {
    throw new Error('日付と時刻をYYYY/MM/DD・HH:mm形式で入力してください')
  }
  return utcDateTime(`${day}T${time}`, original)
}

export function recordInterval(start: { date: string; time: string }, end: { date: string; time: string }, original?: { startedAt: string; endedAt: string | null }): TimeEntryUpdateInput {
  const startedAt = recordTimestamp(start.date, start.time, original?.startedAt)
  const endedAt = recordTimestamp(end.date, end.time, original?.endedAt ?? undefined)
  if (Date.parse(endedAt) <= Date.parse(startedAt)) throw new Error('終了日時は開始日時より後にしてください')
  return { startedAt, endedAt }
}

// datetime-local is a wall-clock value in the browser's timezone; API dates are UTC.
export function localDateTime(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const pad = (part: number, size = 2) => String(part).padStart(size, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

export function localMinuteDateTime(value: string): string {
  return localDateTime(value).slice(0, 16)
}

export function utcDateTime(value: string, original?: string): string {
  // Keep the original UTC instant (including the second occurrence of a DST hour)
  // when a user edits only Task or the other endpoint of an existing interval.
  const date = new Date(value)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(value) || !Number.isFinite(date.getTime())) {
    throw new Error('開始日時・終了日時を入力してください')
  }
  const normalized = value.length === 16 ? `${value}:00.000` : value.includes('.') ? `${value.split('.')[0]}.${value.split('.')[1].padEnd(3, '0')}` : `${value}.000`
  if (original && (localDateTime(original) === normalized
    || value.length === 16 && localMinuteDateTime(original) === value)) return original
  if (localDateTime(date.toISOString()) !== normalized) throw new Error('この日時は現地時間では存在しません。日時を確認してください')
  return date.toISOString()
}

export function actualDefaults(date: string, startMinutes: number, endMinutes = startMinutes + 30, now = Date.now()) {
  const day = new Date(`${date}T00:00:00`)
  const start = new Date(day); start.setMinutes(startMinutes)
  const end = new Date(day); end.setMinutes(endMinutes)
  const adjusted = end.getTime() > now
  const endTime = Math.min(end.getTime(), now)
  const startTime = start.getTime() >= endTime ? endTime - 30 * 60000 : start.getTime()
  return { startedAt: new Date(startTime).toISOString(), endedAt: new Date(endTime).toISOString(), adjusted }
}
