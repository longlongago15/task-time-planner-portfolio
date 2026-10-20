import { useContext, useEffect, useState } from 'react'
import { TimerUiContext } from './TimerUiContext'
import { TimerActionIcon } from './TimerActionIcon'
import type { ReactNode } from 'react'
import { getElapsedSeconds } from './timer'
import type { ActiveTimer } from './timer'
import { TimerTaskPicker } from './TimerTaskPicker'
import { TaskTitleInput } from './TaskTitleInput'
import { TagPicker } from './TagPicker'
import type { Tag } from './TagStore'
import { ProjectPicker } from './ProjectPicker'
import type { ProjectChoice } from './ProjectPicker'

// Display clocks sample canonical timestamps; they do not own Timer lifecycle.
export function LiveClock({ active, children }: { active: boolean; children: (now: number) => ReactNode }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!active) return
    let cancelled = false
    const update = () => { if (!cancelled) setNow(Date.now()) }
    queueMicrotask(update)
    const interval = window.setInterval(update, 1000)
    window.addEventListener('focus', update)
    return () => { cancelled = true; window.clearInterval(interval); window.removeEventListener('focus', update) }
  }, [active])
  return children(now)
}

export function TimerElapsed({ active, pausedSeconds = 0, offsetSeconds = 0, hours = false }: { active: ActiveTimer | null; pausedSeconds?: number; offsetSeconds?: number; hours?: boolean }) {
  return <LiveClock active={active !== null}>{now => {
    const seconds = active ? offsetSeconds + getElapsedSeconds(active.startedAt, now) : pausedSeconds
    return <span>{hours ? `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}` : Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</span>
  }}</LiveClock>
}

type TimerTask = { id: number; title: string; projectId: number | null; projectName: string | null; completed?: boolean; status?: string; tags?: Tag[] }
type Props = {
  active: ActiveTimer | null
  pausedTaskId: number | null
  pausedSeconds: number
  offsetSeconds?: number
  tasks: TimerTask[]
  projects: { id: number; name: string }[]
  projectId: number | null
  tagIds: number[]
  onTags: (ids: number[]) => Promise<void>
  choice: string
  disabled: boolean
  creatingTask?: boolean
  onChoice: (value: string) => void
  onQueryChange: (value: string) => void
  onCreateProject: (name: string, color?: string | null) => Promise<ProjectChoice>
  onProject: (value: number | null) => Promise<void>
  onRename: (taskId: number, title: string) => Promise<void>
  onStart: (taskId: number | null) => void
  onStop: () => void
  onDetails: () => void
}

export function GlobalTimer(props: Props) {
  const { active, pausedTaskId, tasks, choice, disabled } = props
  const { pending } = useContext(TimerUiContext)
  const starting = pending?.operation === 'start' || Boolean(props.creatingTask)
  const stopping = pending?.operation === 'stop'
  const actionPending = starting || stopping
  const taskId = active?.taskId ?? pausedTaskId
  const task = tasks.find(item => item.id === (taskId ?? Number(choice)))
  const session = taskId !== null
  return <section className={`header-timer-control global-top-timer ${session ? 'timer-session' : ''} ${pausedTaskId !== null ? 'paused' : ''}`} aria-label="共通作業タイマー">
    <div className={`header-timer-task ${session ? 'has-session' : ''}`}>
      {session && <>{task ? <div className="timer-task-title"><span className="visually-hidden">{task.title}</span>
        <TaskTitleInput key={task.id} title={task.title} label={active ? '計測中のタスク名' : '一時停止中のタスク名'} disabled={disabled}
          onSave={title => props.onRename(task.id, title)} /></div> : <strong className="timer-task-title">{`タスク #${taskId}`}</strong>}
        {task?.projectName && <span className="timer-project-name" title={task.projectName}>{task.projectName}</span>}</>}
      {!session && <TimerTaskPicker tasks={tasks} choice={choice} disabled={disabled} onChoice={props.onChoice} onQueryChange={props.onQueryChange} />}
    </div>
    <div className="timer-context-actions">
      <ProjectPicker iconOnly showSelection label="タイマーのプロジェクトを選択" onCreateProject={props.onCreateProject} projects={props.projects} projectId={task ? task.projectId : props.projectId}
        disabled={disabled || session && !task} onChange={props.onProject} />
      <TagPicker iconOnly showSelection label="タイマーのタグを選択" disabled={disabled || session && !task} selectedTags={task?.tags} tagIds={task ? (task.tags ?? []).map(tag => tag.id) : props.tagIds} onChange={props.onTags} />
    </div>
    <button type="button" className="timer-time-button timer-elapsed" aria-label="タイマー詳細を開く" onClick={props.onDetails}><TimerElapsed active={active} pausedSeconds={props.pausedSeconds} offsetSeconds={props.offsetSeconds} hours /></button>
    {active ? <button type="button" className="timer-play-button timer-stop timer-action-button" data-timer-state={actionPending ? 'pending' : 'active'} aria-label={actionPending ? `${task?.title ?? 'タスク'}の計測${stopping ? '停止' : '開始'}中` : '計測を終了'} aria-busy={actionPending} aria-pressed disabled={disabled} onClick={props.onStop}><TimerActionIcon pending={actionPending} running /></button>
      : <><button type="button" className="timer-play-button timer-pause-resume timer-action-button" data-timer-state={actionPending ? 'pending' : 'default'} aria-label={actionPending ? `${task?.title ?? 'タスク'}の計測${stopping ? '停止' : '開始'}中` : pausedTaskId !== null ? '再開' : '計測開始'} aria-busy={actionPending} aria-pressed={false}
        disabled={disabled} onClick={() => props.onStart(pausedTaskId ?? (choice ? Number(choice) : null))}><TimerActionIcon pending={actionPending} /></button>
        {pausedTaskId !== null && <button type="button" className="secondary-button timer-stop timer-action-button" data-timer-state="active" aria-label="計測を終了" disabled={disabled} onClick={props.onStop}><TimerActionIcon running /></button>}</>}
  </section>
}
