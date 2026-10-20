import { UiIcon } from './UiIcon'

export function TimerActionIcon({ pending = false, running = false }: { pending?: boolean; running?: boolean }) {
  return pending ? <span className="timer-pending-indicator" aria-hidden="true" />
    : <span className="timer-action-icon"><UiIcon name={running ? 'stop' : 'play'} /></span>
}
