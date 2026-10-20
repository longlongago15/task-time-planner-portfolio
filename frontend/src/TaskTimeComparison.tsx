import { formatDuration } from './duration'

export type TaskTimes = { estimatedMinutes: number | null; actualMinutes: number }

export function TaskTimeComparison({ task, unestimatedLabel = '未設定' }: { task: TaskTimes; unestimatedLabel?: string }) {
  const estimate = task.estimatedMinutes, actual = task.actualMinutes
  const comparable = estimate !== null && estimate > 0
  const width = comparable ? Math.min(100, Math.max(0, actual / estimate * 100)) : 0
  const text = `記録 ${formatDuration(actual)} / 見積もり ${estimate === null ? unestimatedLabel : formatDuration(estimate)}`
  return <section className="task-time-comparison" aria-label="Task全体の見積もりと記録">
    {comparable && <div className="task-time-bar" role="meter" aria-label="記録と全体見積もりの比較"
      aria-valuemin={0} aria-valuemax={estimate} aria-valuenow={Math.min(estimate, Math.max(0, actual))} aria-valuetext={text}>
      <span style={{ width: `${width}%` }} /></div>}
    <p>{text}</p>
    {comparable && actual > estimate && <p className="difference over">見積もりより +{formatDuration(actual - estimate)}</p>}
  </section>
}
