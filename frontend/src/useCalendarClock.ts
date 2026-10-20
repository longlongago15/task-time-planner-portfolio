import { useEffect, useState } from 'react'

// The Calendar clock runs even when no Timer is active; it never fetches data.
export function useCalendarClock(enabled: boolean) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const update = () => { if (!cancelled) setNow(Date.now()) }
    queueMicrotask(update)
    const interval = window.setInterval(update, 60000)
    const visible = () => { if (!document.hidden) update() }
    window.addEventListener('focus', update)
    document.addEventListener('visibilitychange', visible)
    return () => {
      cancelled = true
      window.clearInterval(interval)
      window.removeEventListener('focus', update)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [enabled])
  return now
}
