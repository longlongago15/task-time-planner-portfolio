export function plannedEnd(block: {date: string; startTime: string | null; durationMinutes: number | null}) {
  if (!block.startTime || !block.durationMinutes) return '—'
  // Calendar dates are local wall times: use a neutral axis for date arithmetic.
  const end = new Date(`${block.date}T00:00:00Z`)
  end.setUTCMinutes(Number(block.startTime.slice(0, 2)) * 60 + Number(block.startTime.slice(3, 5)) + block.durationMinutes)
  if (!Number.isFinite(end.getTime())) return '—'
  const date = end.toISOString().slice(0, 10), time = end.toISOString().slice(11, 16)
  return date === block.date ? time : `${date} ${time}`
}

export function formatDuration(minutes: number | null): string {
  if (minutes === null) return '未設定'
  const hours = Math.floor(Math.abs(minutes) / 60)
  const remainder = Math.abs(minutes) % 60
  return hours > 0 ? `${hours}時間${remainder > 0 ? `${remainder}分` : ''}` : `${remainder}分`
}

// Schedule times are local wall times, independent of timezone transitions.
export function formatEndTime(startTime: string, duration: number): string {
  const [hour, minute] = startTime.split(':').map(Number)
  const endMinutes = hour * 60 + minute + duration
  const dayOffset = Math.floor(endMinutes / 1440)
  const endHour = Math.floor((endMinutes % 1440) / 60)
  const endMinute = endMinutes % 60
  const formatted = `${String(endHour).padStart(2, '0')}:${String(endMinute).padStart(2, '0')}`
  return dayOffset > 0 ? `${formatted} (+${dayOffset}日)` : formatted
}
