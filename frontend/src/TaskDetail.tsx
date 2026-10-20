import type { ReactNode } from 'react'
import { formatDuration, formatEndTime } from './duration'
import type { Tag } from './TagStore'
import { TaskTitleInput } from './TaskTitleInput'
import { UiIcon } from './UiIcon'
import { ProjectPicker } from './ProjectPicker'
import type { ProjectChoice } from './ProjectPicker'
import { TagPicker } from './TagPicker'
import { TaskAttributeRow } from './TaskAttributeRow'
import { ProjectIcon } from './UiIcon'
import { TaskStatusChip } from './TaskStatusChip'
import type { TaskStatus } from './TaskStatusChip'
import { TaskTimerButton } from './TaskTimerButton'
import { TaskTimeSection } from './TaskTimeSection'

export type DetailTask = { id: number; title: string; projectId: number | null; projectName: string | null; completed: boolean; status: string; estimatedMinutes: number | null; actualMinutes: number; tags?: Tag[] }
export type TaskScheduleContext = { id: number; date: string; type: 'TIMED' | 'TIME_UNSET' | 'ALL_DAY'; startTime: string | null; durationMinutes: number | null }
export type ScheduleField = 'date' | 'startTime' | 'durationMinutes'
export type DetailTaskChanges = { title?: string; projectId?: number | null; tagIds?: number[]; estimatedMinutes?: number | null; status?: TaskStatus }

type Props = {
  api: string; refresh: number; task: DetailTask; schedule?: TaskScheduleContext; busy: boolean; activeTaskId: number | null; timerUnavailable: boolean
  titleId: string; closeLabel: string; onClose: () => void; onStart: () => void; onOpenEditor: () => void
  projects: ProjectChoice[]; onCreateProject: (name: string, color?: string | null) => Promise<ProjectChoice>
  onTaskUpdate: (input: DetailTaskChanges) => Promise<void>
  scheduleFields?: Partial<Record<ScheduleField, ReactNode>>; onEditScheduleField?: (field: ScheduleField) => void; scheduleActions?: ReactNode
  onRelease?: () => void
}

// Task information is shared; placement and its actions exist only for a real Schedule.
export function TaskDetail({ api, refresh, task, schedule, busy, activeTaskId, timerUnavailable, titleId, closeLabel, onClose, onStart, onOpenEditor, projects, onCreateProject, onTaskUpdate, scheduleFields, onEditScheduleField, scheduleActions, onRelease }: Props) {
  const detailProjects = task.projectId !== null && task.projectName && !projects.some(project => project.id === task.projectId)
    ? [...projects, { id: task.projectId, name: task.projectName }] : projects
  return <div className="task-detail task-attribute-form" data-task-detail-id={task.id}>
    <div className="task-detail-top-row">
      <TaskStatusChip status={task.status} disabled={busy} onChange={status => onTaskUpdate({ status })} />
      <div className="task-detail-top-actions"><TaskTimerButton task={task} activeTaskId={activeTaskId} disabled={busy || timerUnavailable} onStart={onStart} alwaysVisible />
        <button type="button" className="secondary-button task-detail-close" aria-label={closeLabel} disabled={busy} onClick={onClose}><UiIcon name="close" /></button>
      </div>
    </div>
    <TaskAttributeRow label="タスク名" icon={<UiIcon name="task" />}>
      <h2 id={titleId}><TaskTitleInput key={task.id} title={task.title} disabled={busy} label="予定のタスク名" onSave={title => onTaskUpdate({ title })} clickToEdit /></h2>
    </TaskAttributeRow>
    <TaskAttributeRow label="プロジェクト" icon={<ProjectIcon tone="neutral" />} unset={task.projectId === null}>
      <div className="calendar-popover-project"><ProjectPicker projects={detailProjects} projectId={task.projectId} emptyLabel="未設定" label="プロジェクトを変更" disabled={busy} colorSelection
        onCreateProject={onCreateProject} onChange={projectId => onTaskUpdate({ projectId })} /></div>
    </TaskAttributeRow>
    <TaskAttributeRow label="タグ" icon={<UiIcon name="tag" />} unset={!task.tags?.length}>
      <div className="calendar-popover-tags task-detail-tag-field" aria-label="タグ">
        <TagPicker label="タグを編集" tagIds={(task.tags ?? []).map(tag => tag.id)} selectedTags={task.tags} showAllSelected emptyLabel="未設定" disabled={busy} onChange={tagIds => onTaskUpdate({ tagIds })} />
      </div>
    </TaskAttributeRow>
    {schedule && <div className="calendar-popover-schedule" aria-label="この予定の日時">
      <TaskAttributeRow label="日付" icon={<UiIcon name="calendar" />}>
        {scheduleFields?.date ?? <button type="button" className="task-inline-value" data-schedule-field="date" disabled={busy} onClick={() => onEditScheduleField?.('date')}><time dateTime={schedule.date}>{schedule.date.replaceAll('-', '/')}（{new Intl.DateTimeFormat('ja-JP', { weekday: 'short' }).format(new Date(`${schedule.date}T12:00:00`))}）</time></button>}
      </TaskAttributeRow>
      <TaskAttributeRow label="時刻" icon={<UiIcon name="clock" />} unset={schedule.type !== 'TIMED'}>
        {scheduleFields?.startTime ?? <button type="button" className="task-inline-value" data-schedule-field="startTime" disabled={busy} onClick={() => onEditScheduleField?.('startTime')}>{schedule.type === 'TIMED' && schedule.startTime && schedule.durationMinutes !== null ? `${schedule.startTime.slice(0, 5)} – ${formatEndTime(schedule.startTime, schedule.durationMinutes)}` : '未設定'}</button>}
      </TaskAttributeRow>
      <TaskAttributeRow label="計画時間" icon={<UiIcon name="clock" />} unset={schedule.durationMinutes === null}>
        {scheduleFields?.durationMinutes ?? <button type="button" className="task-inline-value" data-schedule-field="durationMinutes" disabled={busy} onClick={() => onEditScheduleField?.('durationMinutes')}>{formatDuration(schedule.durationMinutes)}</button>}
      </TaskAttributeRow>
    </div>}
    {scheduleActions}
    <TaskTimeSection api={api} taskId={task.id} refresh={refresh} draftEstimate={task.estimatedMinutes} fallbackTask={task} summaryOnly />
    <div className="calendar-dialog-actions">
      <button type="button" className="secondary-button task-detail-edit" disabled={busy} onClick={onOpenEditor}>タスクを編集</button>
      {schedule && onRelease && <button type="button" className="danger" disabled={busy} onClick={onRelease}>この予定を解除</button>}
    </div>
  </div>
}
