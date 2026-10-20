import { TaskStatusChip } from './TaskStatusChip'
import { useRef } from 'react'
import type { DragEvent } from 'react'
import { formatCompactDuration } from './durationInput'
import { TaskTimerButton } from './TaskTimerButton'
import { TaskProjectLine } from './TaskProjectLine'
import type { ProjectChoice } from './ProjectPicker'
import type { Tag } from './TagStore'

type CardTask = { id: number; title: string; projectName: string | null; actualMinutes: number; estimatedMinutes: number | null; completed: boolean; status: string; tags?: Tag[] }
type Props = { project?: ProjectChoice; task: CardTask; draggable: boolean; dragging: boolean; placing: boolean; timerDisabled: boolean; activeTaskId: number | null; error?: string
  onOpenEditor: () => void; onStart: () => void; onDragStart: (event: DragEvent<HTMLLIElement>) => void; onDragEnd: () => void }

export function InboxTaskCard({ project, task, draggable, dragging, placing, timerDisabled, activeTaskId, error, onOpenEditor, onStart, onDragStart, onDragEnd }: Props) {
  const dragged = useRef(false)
  return <li data-inbox-task-id={task.id} draggable={draggable} aria-busy={placing} className={`inbox-task-card ${dragging ? 'inbox-task-dragging' : ''}`}
    onDragStart={event => { if (event.target instanceof Element && event.target.closest('.inbox-card-actions')) { event.preventDefault(); return } dragged.current = true; onDragStart(event) }}
    onDragEnd={() => { onDragEnd(); window.setTimeout(() => { dragged.current = false }, 300) }}>
    <button type="button" className="inbox-card-open" disabled={placing} aria-label={`${task.title}を編集`} aria-haspopup="dialog" onClick={() => { if (!dragged.current) onOpenEditor() }}>
      <TaskStatusChip status={task.status} />
      <span className="inbox-card-title"><strong title={task.title}>{task.title}</strong></span>
      <TaskProjectLine project={project} name={task.projectName ?? '未所属'} hasTags={!!task.tags?.length} projectClassName="inbox-card-project" />
      <span className="inbox-card-times" aria-label={`記録 ${formatCompactDuration(task.actualMinutes)} / 見積もり ${formatCompactDuration(task.estimatedMinutes)}`}>
        <b>{formatCompactDuration(task.actualMinutes)} / {formatCompactDuration(task.estimatedMinutes)}</b>
      </span>
    </button>
    <div className="inbox-card-actions" onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
      <TaskTimerButton task={task} className="inbox-card-start" activeTaskId={activeTaskId} disabled={placing || timerDisabled} onStart={onStart} />
    </div>
    {placing && <small role="status">配置中…</small>}
    {error && <p className="error" role="alert">{error}</p>}
  </li>
}
