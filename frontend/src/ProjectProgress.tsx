export type ProjectStats = { taskCount: number; completedCount: number; estimatedMinutes: number; actualMinutes: number }
type Props = { project: ProjectStats; formatDuration: (minutes: number) => string; summary?: boolean }

function Metric({ label, value, percent, kind, caption }: {
  label: string; value: string; percent: number | null; kind: 'completion' | 'time'; caption?: string
}) {
  const rounded = percent === null ? null : Math.round(percent)
  const over = percent !== null && percent > 100
  const width = Math.min(100, Math.max(0, percent ?? 0))
  const text = `${label} ${value}${rounded === null ? '' : ` ${rounded}%`}`
  return <div className={`project-progress-item ${kind}${over ? ' over-estimate' : ''}`}>
    <span className="project-metric-label">{label}</span>
    <div className="project-metric-values"><span className="project-progress-text">{value}</span><strong>{rounded === null ? '—' : `${rounded}%`}</strong></div>
    <div className="progress-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={width} aria-valuetext={text}><span style={{ width: `${width}%` }} /></div>
    {over ? <small className="project-over-estimate">見積超過 +{Math.round(percent - 100)}%</small> : caption && <small className="project-metric-caption">{caption}</small>}
  </div>
}

export function ProjectProgress({ project, formatDuration, summary = false }: Props) {
  const completion = project.taskCount > 0 ? project.completedCount / project.taskCount * 100 : 0
  const consumption = project.estimatedMinutes > 0 ? project.actualMinutes / project.estimatedMinutes * 100 : null
  return <div className={`project-progress-group project-detail-stats${summary ? ' project-summary-metrics' : ''}`}>
    <Metric label={summary ? 'タスク進捗' : '完了タスク'} value={`${project.completedCount} / ${project.taskCount}`} percent={completion} kind="completion" caption={summary ? '完了タスク' : undefined} />
    <Metric label="時間消費" value={`${formatDuration(project.actualMinutes)} / ${project.estimatedMinutes > 0 ? formatDuration(project.estimatedMinutes) : '未設定'}`} percent={consumption} kind="time" caption={summary ? '記録 / 見積もり' : undefined} />
  </div>
}
