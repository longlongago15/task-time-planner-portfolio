import type { ReactNode } from 'react'
import { formatDuration } from './duration'
import { formatCompactDuration } from './durationInput'

export function TaskTimeSummary({ actualMinutes, plannedMinutes, estimatedMinutes, recorded, planned, estimated, className = '', compact = false }: {
  actualMinutes: number; plannedMinutes: number | null; estimatedMinutes: number | null; recorded?: ReactNode; planned?: ReactNode; estimated?: ReactNode; className?: string
  compact?: boolean
}) {
  const format = compact ? formatCompactDuration : formatDuration
  return <dl className={`task-time-summary ${className}`} aria-label="タスク全体の時間">
    <div><dt>記録</dt><dd>{recorded ?? <strong>{format(actualMinutes)}</strong>}</dd></div>
    <div><dt>計画済み</dt><dd>{planned ?? <strong>{plannedMinutes === null ? '読込中' : format(plannedMinutes)}</strong>}</dd></div>
    <div><dt>見積もり</dt><dd>{estimated ?? <strong className={estimatedMinutes === null ? 'unset-value' : undefined}>{format(estimatedMinutes)}</strong>}</dd></div>
  </dl>
}
