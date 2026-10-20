import type { TimeEntry } from './timer'
import { recordDateTime } from './timeEntryInput.ts'
import { formatDuration } from './duration.ts'

// Describe the saved entry, never an editor draft or a clipped Calendar segment.
export function timeEntryDeleteConfirmation(entry: Pick<TimeEntry, 'taskId' | 'startedAt' | 'endedAt'>, taskTitle?: string): string {
  const dateTime = (value: string | null) => {
    const parts = recordDateTime(value ?? '')
    return parts.date && parts.time ? `${parts.date} ${parts.time}` : '—'
  }
  const duration = entry.endedAt === null ? '計測中' : formatDuration(Math.max(0, Math.floor((Date.parse(entry.endedAt) - Date.parse(entry.startedAt)) / 60000)))
  return `この時間記録を削除しますか？\n\nタスク：${taskTitle?.trim() ? taskTitle : `タスク ${entry.taskId}`}\n開始：${dateTime(entry.startedAt)}\n終了：${dateTime(entry.endedAt)}\n記録時間：${duration}\n\nこの時間記録のみ削除されます。削除後は元に戻せません。`
}
