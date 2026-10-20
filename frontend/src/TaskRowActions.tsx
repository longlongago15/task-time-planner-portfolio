import type { ReactNode } from 'react'
import { TaskTimerButton } from './TaskTimerButton'
import type { EntryTask } from './timeEntryInlineState'

export type EntryTimerActions = { activeTaskId: number | null; timerDisabled: boolean; onStart: (taskId: number) => void; onStop: () => void }

export function TaskRowActions({ task, activeTaskId, timerDisabled, onStart, onStop, children, separateTimer = false }: EntryTimerActions & {task: EntryTask; children: ReactNode; separateTimer?: boolean}) {
  if (separateTimer) return <><div className="task-table-operation task-row-actions">{children}</div><div className="task-table-timer"><TaskTimerButton task={task} activeTaskId={activeTaskId} disabled={timerDisabled} onStart={() => onStart(task.id)} onStop={onStop} alwaysVisible /></div></>
  return <div className="task-row-actions">{children}<TaskTimerButton task={task} activeTaskId={activeTaskId} disabled={timerDisabled} onStart={() => onStart(task.id)} onStop={onStop} alwaysVisible /></div>
}
