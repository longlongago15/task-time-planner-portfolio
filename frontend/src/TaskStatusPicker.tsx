import { SingleSelectPicker } from './SingleSelectPicker'
import { taskStatusLabels } from './taskStatus'
import type { TaskStatus } from './TaskStatusChip'
import { UiIcon } from './UiIcon'

const icon = (status: string) => <UiIcon name={status === 'COMPLETED' ? 'check' : status === 'IN_PROGRESS' ? 'play' : 'circle'} />
export function TaskStatusPicker({ status, disabled, onChange, label }: { status: TaskStatus; disabled?: boolean; onChange: (status: TaskStatus) => Promise<void>; label: string }) {
  const display = (value: TaskStatus) => <span className={`shared-pill status-${value.toLowerCase()}`}>{icon(value)}{taskStatusLabels[value]}</span>
  return <SingleSelectPicker value={status} label={label} disabled={disabled} className="task-status-trigger" display={display(status)}
    options={(Object.keys(taskStatusLabels) as TaskStatus[]).map(value => ({ value, content: display(value) }))} onChange={value => onChange(value as TaskStatus)} />
}
