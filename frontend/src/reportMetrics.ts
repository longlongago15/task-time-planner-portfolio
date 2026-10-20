import { scheduleSegmentsForDay, plannedMinutesForDay } from './scheduleSegments.ts'
import { formatDuration } from './duration.ts'
import type { TimeEntry } from './timer.ts'

type Schedule = { id: number; taskId: number; date: string; type: string; startTime: string | null; durationMinutes: number | null }
type Task = { id: number; title: string; projectId: number | null }
type Project = { id: number; name: string; color?: string | null }
type Interval = { startMinutes: number; endMinutes: number }
export type ReportRow = { id: number | null; name: string; plannedMinutes: number; actualMinutes: number; differenceMinutes: number }

export function formatReportDifference(minutes: number) {
  return minutes === 0 ? '0分' : `${minutes > 0 ? '+' : '-'}${formatDuration(Math.abs(minutes))}${minutes > 0 ? '超過' : '短縮'}`
}

// Clip UTC timestamps to local midnight, then floor each Entry, as _entry_minutes does.
export function reportEntryForDay(entry: TimeEntry, date: string, now: number) {
  const dayStart = new Date(`${date}T00:00:00`)
  const nextDay = new Date(dayStart)
  nextDay.setDate(nextDay.getDate() + 1)
  const microseconds = (value: string) => {
    const fraction = value.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1] ?? ''
    return Date.parse(value) * 1000 + Number(fraction.padEnd(6, '0').slice(0, 6)) % 1000
  }
  const start = Math.max(microseconds(entry.startedAt), dayStart.getTime() * 1000)
  const end = Math.min(entry.endedAt === null ? now * 1000 : microseconds(entry.endedAt), nextDay.getTime() * 1000)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null
  const clockMinute = (timestamp: number) => {
    const value = new Date(timestamp / 1000)
    return value.getHours() * 60 + value.getMinutes() + value.getSeconds() / 60 + value.getMilliseconds() / 60000
  }
  return { minutes: Math.floor((end - start) / 60000000), startMinutes: clockMinute(start), endMinutes: end === nextDay.getTime() * 1000 ? 1440 : clockMinute(end) }
}

const wholeMinutes = (minutes: number) => Math.floor(minutes + 1e-9)
const finish = (row: Omit<ReportRow, 'differenceMinutes'>): ReportRow => ({ ...row, differenceMinutes: row.actualMinutes - row.plannedMinutes })

export function buildReportMetrics(tasks: Task[], projects: Project[], blocks: Schedule[], entries: TimeEntry[], dates: string[], now: number) {
  const taskById = new Map(tasks.map(task => [task.id, task]))
  const taskRows = new Map<number, Omit<ReportRow, 'differenceMinutes'>>()
  const projectRows = new Map<number | null, Omit<ReportRow, 'differenceMinutes'>>()
  const taskRow = (id: number) => {
    if (!taskRows.has(id)) taskRows.set(id, { id, name: taskById.get(id)?.title ?? `タスク ${id}`, plannedMinutes: 0, actualMinutes: 0 })
    return taskRows.get(id)!
  }
  const projectRow = (id: number | null) => {
    if (!projectRows.has(id)) projectRows.set(id, { id, name: id === null ? '未所属' : projects.find(project => project.id === id)?.name ?? `プロジェクト ${id}`, plannedMinutes: 0, actualMinutes: 0 })
    return projectRows.get(id)!
  }
  const daily = dates.map(date => {
    const segments = scheduleSegmentsForDay(blocks, date)
    const taskBlocks = new Map<number, Schedule[]>()
    const projectBlocks = new Map<number | null, Schedule[]>()
    for (const { schedule } of segments) {
      const projectId = taskById.get(schedule.taskId)?.projectId ?? null
      taskBlocks.set(schedule.taskId, [...(taskBlocks.get(schedule.taskId) ?? []), schedule])
      projectBlocks.set(projectId, [...(projectBlocks.get(projectId) ?? []), schedule])
    }
    for (const [id, group] of taskBlocks) taskRow(id).plannedMinutes += wholeMinutes(plannedMinutesForDay(group, date))
    for (const [id, group] of projectBlocks) projectRow(id).plannedMinutes += wholeMinutes(plannedMinutesForDay(group, date))
    let actualMinutes = 0
    const actualIntervals: Interval[] = []
    for (const entry of entries) {
      const span = reportEntryForDay(entry, date, now)
      if (!span) continue
      actualMinutes += span.minutes
      taskRow(entry.taskId).actualMinutes += span.minutes
      projectRow(entry.projectIdSnapshot).actualMinutes += span.minutes
      actualIntervals.push(span)
    }
    const plannedMinutes = wholeMinutes(plannedMinutesForDay(blocks, date))
    return { date, plannedMinutes, actualMinutes, differenceMinutes: actualMinutes - plannedMinutes, planIntervals: segments as Interval[], actualIntervals }
  })
  const plannedMinutes = daily.reduce((total, day) => total + day.plannedMinutes, 0)
  const actualMinutes = daily.reduce((total, day) => total + day.actualMinutes, 0)
  const taskDetails = [...taskRows.values()].map(finish).sort((a, b) => Math.abs(b.differenceMinutes) - Math.abs(a.differenceMinutes) || a.id! - b.id!)
  return { daily, plannedMinutes, actualMinutes, differenceMinutes: actualMinutes - plannedMinutes,
    taskRows: taskDetails, topTasks: taskDetails.slice(0, 10), projectRows: [...projectRows.values()].map(finish) }
}
