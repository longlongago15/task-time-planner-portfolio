import { API } from './api'
import { useEffect, useState } from 'react'

export type TaskSchedules = {
  blocks: { taskId: number; date: string }[]
  status: 'loading' | 'ready' | 'error'
  retry: () => void
}

export function useTaskSchedules(refresh: number, enabled = true): TaskSchedules {
  const [attempt, setAttempt] = useState(0)
  const key = `${refresh}/${attempt}/${enabled}`
  const [result, setResult] = useState<{ key: string; blocks: TaskSchedules['blocks']; status: TaskSchedules['status'] }>({ key: '', blocks: [], status: 'loading' })
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    fetch(`${API}/schedule-blocks`, { signal: controller.signal })
      .then(response => { if (!response.ok) throw new Error('Schedule fetch failed'); return response.json() })
      .then(data => { if (!controller.signal.aborted) setResult({ key, blocks: data, status: 'ready' }) })
      .catch(() => { if (!controller.signal.aborted) setResult({ key, blocks: [], status: 'error' }) })
    return () => controller.abort()
  }, [key, enabled])
  return { blocks: result.blocks, status: result.key === key ? result.status : 'loading', retry: () => setAttempt(value => value + 1) }
}
