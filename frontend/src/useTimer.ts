import { useCallback, useEffect, useRef, useState } from 'react'
import { getElapsedSeconds, readActiveTimer } from './timer'
import type { ActiveTimer, ActiveTimerResponse, TimeEntry } from './timer'
import { timeEntryOverlapMessage } from './timeEntryErrors'
import type { TimerPending } from './TimerUiContext'

// One display cache for all Workspace views; the DB-backed Active API is authoritative.
export function useTimer(api: string, onChange: (entry?: TimeEntry, active?: ActiveTimer | null) => void) {
  const [active, setActive] = useState<ActiveTimer | null>(null)
  const [pausedTaskId, setPausedTaskId] = useState<number | null>(null)
  const [pausedElapsedSeconds, setPausedElapsedSeconds] = useState(0)
  const [elapsedOffsetSeconds, setElapsedOffsetSeconds] = useState(0)
  const displaySession = useRef<{ taskId: number | null; startedAt: string | null; seconds: number }>({ taskId: null, startedAt: null, seconds: 0 })
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [pendingOperation, setPendingOperation] = useState<TimerPending | null>(null)
  const [error, setError] = useState('')
  const [now, setNow] = useState(Date.now)
  const cache = useRef<ActiveTimer | null>(null)
  const confirmed = useRef(false)
  const pending = useRef(false)
  const generation = useRef(0)
  const mounted = useRef(false)
  const changed = useRef(onChange)
  useEffect(() => { changed.current = onChange })

  const apply = useCallback((value: ActiveTimer | null) => {
    if (value !== null) {
      const previous = displaySession.current
      if (previous.taskId !== value.taskId || (previous.startedAt !== null && previous.startedAt !== value.startedAt)) {
        displaySession.current = { taskId: value.taskId, startedAt: value.startedAt, seconds: 0 }
      } else displaySession.current = { ...previous, startedAt: value.startedAt }
    } else if (cache.current !== null) displaySession.current = { taskId: null, startedAt: null, seconds: 0 }
    cache.current = value
    confirmed.current = true
    if (!mounted.current) return
    setActive(value)
    setReady(true)
    setElapsedOffsetSeconds(displaySession.current.seconds)
    if (value !== null) { setPausedTaskId(null); setPausedElapsedSeconds(0) }
    setNow(Date.now())
  }, [])

  const readActive = useCallback(async () => {
    const version = ++generation.current
    try {
      const response = await fetch(`${api}/tasks/time/active`)
      if (!response.ok) throw new Error('計測状態を取得できませんでした')
      const value = readActiveTimer(await response.json() as ActiveTimerResponse)
      if (version !== generation.current || !mounted.current) return undefined
      apply(value)
      return value
    } catch (failure) {
      if (version !== generation.current || !mounted.current) return undefined
      confirmed.current = false
      setReady(false)
      throw failure
    }
  }, [api, apply])

  const sync = useCallback(async () => {
    if (pending.current) return
    try {
      const value = await readActive()
      if (value === undefined) return
      if (mounted.current) { setError(''); changed.current(undefined, value) }
    } catch {
      if (mounted.current) setError('計測状態を確認できません。接続を確認して再同期してください。')
    }
  }, [readActive])

  useEffect(() => {
    mounted.current = true
    let cancelled = false
    queueMicrotask(() => { if (!cancelled && mounted.current) void sync() })
    const focus = () => { void sync() }
    window.addEventListener('focus', focus)
    return () => {
      cancelled = true
      mounted.current = false
      generation.current += 1
      window.removeEventListener('focus', focus)
    }
  }, [sync])

  const reconcileFailure = async (message: string) => {
    try {
      const value = await readActive()
      if (value === undefined) return
      if (mounted.current) {
        if (value === null) { displaySession.current = { taskId: null, startedAt: null, seconds: 0 }; setPausedTaskId(null); setPausedElapsedSeconds(0); setElapsedOffsetSeconds(0) }
        changed.current(undefined, value)
        setError(message)
      }
    } catch {
      // Keep the last confirmed display, never assume that the DB timer stopped.
      if (mounted.current) setError(`${message} 計測状態を確認できないため、再同期してください。`)
    }
  }

  const mutate = async (operation: 'start' | 'stop', taskId: number, keepPaused = false) => {
    if (pending.current || !confirmed.current) return false
    pending.current = true
    generation.current += 1 // Older initialization/focus reads cannot overwrite this operation.
    setBusy(true)
    setPendingOperation({ taskId, operation })
    setError('')
    try {
      const response = await fetch(`${api}/tasks/time/${operation}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId }),
      })
      if (!response.ok) {
        const failure = await response.json().catch(() => null) as { detail?: unknown } | null
        await reconcileFailure(timeEntryOverlapMessage(failure?.detail) ?? (response.status === 409
          ? operation === 'start' ? '計測を開始できませんでした。完了状態や他の計測を確認してください。' : '計測を終了できませんでした。計測状態が他の画面で変更された可能性があります。'
          : '計測操作に失敗しました。最新の状態を確認してください。'))
        return false
      }
      if (operation === 'start') {
        const value = readActiveTimer(await response.json() as ActiveTimerResponse)
        if (value === null) throw new Error('Start response must be active')
        apply(value)
        if (mounted.current) changed.current(undefined, value)
      } else {
        const entry = await response.json() as TimeEntry
        if (entry.taskId !== taskId || typeof entry.endedAt !== 'string' || !Number.isFinite(Date.parse(entry.endedAt))) {
          throw new Error('Stop response must be closed')
        }
        const carriedSeconds = displaySession.current.seconds
        apply(null)
        if (mounted.current) {
          const total = carriedSeconds + getElapsedSeconds(entry.startedAt, Date.parse(entry.endedAt))
          displaySession.current = keepPaused ? { taskId, startedAt: null, seconds: total } : { taskId: null, startedAt: null, seconds: 0 }
          setPausedTaskId(keepPaused ? taskId : null)
          setPausedElapsedSeconds(keepPaused ? total : 0)
          setElapsedOffsetSeconds(0)
          changed.current(entry)
        }
      }
      // Another client can change Active immediately after this response.
      const notifiedActive = cache.current
      try {
        const latest = await readActive()
        if (latest !== undefined && mounted.current
          && (latest?.taskId !== notifiedActive?.taskId || latest?.startedAt !== notifiedActive?.startedAt)) changed.current(undefined, latest)
      } catch {
        if (mounted.current) setError('操作は保存されましたが、最新の計測状態を確認できません。再同期してください。')
      }
      return true
    } catch {
      await reconcileFailure('通信に失敗しました。計測の状態を確認してください。')
      return false
    } finally {
      pending.current = false
      if (mounted.current) { setBusy(false); setPendingOperation(null) }
    }
  }

  return {
    active, pausedTaskId, pausedElapsedSeconds, elapsedOffsetSeconds, ready, busy, pendingOperation, error,
    now,
    elapsedSeconds: getElapsedSeconds(active?.startedAt ?? null, now),
    sync,
    start: (taskId: number) => mutate('start', taskId),
    stop: (keepPaused: boolean) => {
      const value = cache.current
      return value === null ? Promise.resolve(false) : mutate('stop', value.taskId, keepPaused)
    },
    finishPaused: () => { displaySession.current = { taskId: null, startedAt: null, seconds: 0 }; setPausedTaskId(null); setPausedElapsedSeconds(0); setElapsedOffsetSeconds(0) },
  }
}
