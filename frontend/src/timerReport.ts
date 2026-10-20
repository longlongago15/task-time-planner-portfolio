import { entryDisplaySpan } from './timer.ts'
import type { TimeEntry } from './timer.ts'

type ReportTask = {
  id: number; title: string; projectName: string | null
}
type ReportSummary = {
  date: string
  tasks: { taskId: number; estimatedMinutes: number | null; actualMinutes: number; differenceMinutes: number | null }[]
}

export function timerReportRows(tasks: ReportTask[], entries: TimeEntry[], summaries: ReportSummary[], dates: string[]) {
  const totals = new Map<number, { actual: number; estimate: number | null }>()
  for (const summary of summaries) {
    if (!dates.includes(summary.date)) continue
    for (const row of summary.tasks) {
      const previous = totals.get(row.taskId)
      totals.set(row.taskId, {
        actual: (previous?.actual ?? 0) + row.actualMinutes,
        estimate: row.estimatedMinutes === null || previous?.estimate === null
          ? null : (previous?.estimate ?? 0) + row.estimatedMinutes,
      })
    }
  }
  // Entries only determine which rows are relevant; they never supply formal minutes.
  const recorded = new Set<number>()
  const unavailable = new Set<number>()
  for (const entry of entries) {
    const span = entryDisplaySpan(entry)
    if (span === null) continue
    for (const date of dates) {
      const start = new Date(`${date}T00:00:00`)
      const end = new Date(start)
      end.setDate(end.getDate() + 1)
      if (span.start < end.getTime() && span.end > start.getTime()) {
        recorded.add(entry.taskId)
        if (!summaries.some((summary) => summary.date === date && summary.tasks.some((row) => row.taskId === entry.taskId))) {
          unavailable.add(entry.taskId)
        }
      }
    }
  }
  return tasks.filter((task) => totals.has(task.id) || recorded.has(task.id)).map((task) => {
    const total = totals.get(task.id)
    const estimatedMinutes = total ? total.estimate : 0
    const actualMinutes = unavailable.has(task.id) ? null : total?.actual ?? null
    return {
      taskId: task.id, title: task.title, projectName: task.projectName ?? '未所属',
      estimatedMinutes, actualMinutes,
      differenceMinutes: actualMinutes === null || estimatedMinutes === null ? null : actualMinutes - estimatedMinutes,
    }
  }).sort((a, b) => Math.abs(b.differenceMinutes ?? 0) - Math.abs(a.differenceMinutes ?? 0))
}
