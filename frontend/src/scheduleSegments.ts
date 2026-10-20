import { shiftDate } from './calendarDates.ts'

type ScheduleSource = { id: number; date: string; type: string; startTime: string | null; durationMinutes: number | null }

// Calendar uses local wall-clock minutes, like formatEndTime; keep the source intact.
export function scheduleSegmentsForDay<T extends ScheduleSource>(blocks: T[], date: string) {
  return blocks.flatMap(schedule => {
    if (schedule.type !== 'TIMED' || !schedule.startTime || !Number.isFinite(schedule.durationMinutes) || schedule.durationMinutes! <= 0) return []
    const [hour, minute, second = 0] = schedule.startTime.split(':').map(Number)
    if (![hour, minute, second].every(Number.isFinite) || hour < 0 || hour >= 24 || minute < 0 || minute >= 60 || second < 0 || second >= 60) return []
    // Noon-based shiftDate is the existing Calendar local-date helper.
    const sourceStart = hour * 60 + minute + second / 60
    let day = schedule.date, offset = 0
    while (day < date && sourceStart + schedule.durationMinutes! > (offset + 1) * 1440) {
      day = shiftDate(day, 1)
      offset++
    }
    if (day !== date) return []
    const startMinutes = Math.max(0, sourceStart - offset * 1440)
    const endMinutes = Math.min(1440, sourceStart + schedule.durationMinutes! - offset * 1440)
    return endMinutes > startMinutes ? [{ schedule, date, startMinutes, endMinutes }] : []
  })
}

export function plannedMinutesForDay(blocks: ScheduleSource[], date: string) {
  const intervals = scheduleSegmentsForDay(blocks, date).sort((a, b) => a.startMinutes - b.startMinutes)
  let total = 0, end = 0
  for (const interval of intervals) {
    total += Math.max(0, interval.endMinutes - Math.max(end, interval.startMinutes))
    end = Math.max(end, interval.endMinutes)
  }
  return total
}
