import { useContext } from 'react'
import { TimerUiContext } from './TimerUiContext'
import { TimerActionIcon } from './TimerActionIcon'

type TimerTask = { id: number; title: string; completed?: boolean; status?: string }
type Props = { task: TimerTask; activeTaskId: number | null; disabled: boolean; onStart: () => void; onStop?: () => void; className?: string; floating?: boolean; restart?: boolean; alwaysVisible?: boolean; size?: 'sm' | 'md' }

export function TaskTimerButton({ task, activeTaskId, disabled, onStart, onStop, className = '', floating = false, restart = false, alwaysVisible = false, size = floating ? 'sm' : 'md' }: Props) {
  const timerUi = useContext(TimerUiContext)
  const pending = timerUi.pending?.taskId === task.id ? timerUi.pending : null
  const stop = onStop ?? timerUi.onStop
  const running = activeTaskId === task.id

  return <button type="button" className={`secondary-button task-hover-start task-timer-button ${floating ? 'calendar-task-start' : ''} ${alwaysVisible ? 'task-timer-always' : ''} ${className}`}
    data-timer-state={pending ? 'pending' : running ? 'active' : 'default'} data-timer-size={size}
    aria-label={pending ? `${task.title}の計測${pending.operation === 'start' ? '開始' : '停止'}中` : running ? stop ? `${task.title}の計測を停止` : `${task.title}を計測中` : `${task.title}の計測を開始`}
    aria-busy={Boolean(pending)}
    aria-pressed={running}
    title={pending ? `計測${pending.operation === 'start' ? '開始' : '停止'}中` : running ? stop ? '計測を停止' : '計測中' : restart ? 'このタスクをもう一度計測開始' : '計測開始'}
    disabled={Boolean(pending) || disabled || (running ? !stop : task.completed || task.status === 'COMPLETED')} draggable={false}
    onPointerDown={event => event.stopPropagation()}
    onMouseDown={event => { event.preventDefault(); event.currentTarget.focus({ preventScroll: true }) }}
    onDragStart={event => { event.preventDefault(); event.stopPropagation() }}
    onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation() }}
    onClick={event => { event.preventDefault(); event.stopPropagation(); if (running) stop?.(); else onStart() }}><TimerActionIcon pending={Boolean(pending)} running={running} /></button>
}
