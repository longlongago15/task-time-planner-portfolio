import { createContext } from 'react'

export type TimerPending = { taskId: number; operation: 'start' | 'stop' }

// Presentation only; useTimer remains the owner of the canonical Active entry.
export const TimerUiContext = createContext<{ pending: TimerPending | null; onStop?: () => void }>({ pending: null })
