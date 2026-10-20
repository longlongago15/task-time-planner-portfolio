export const CALENDAR_HOUR_HEIGHTS = [36, 45, 54, 72, 90] as const
export const DEFAULT_CALENDAR_ZOOM = 3

export function createCalendarScale(level: number) {
  const zoom = Number.isFinite(level) ? Math.max(1, Math.min(5, Math.trunc(level))) : DEFAULT_CALENDAR_ZOOM
  const pixelsPerHour = CALENDAR_HOUR_HEIGHTS[zoom - 1]
  const pixelsPerMinute = pixelsPerHour / 60
  const minutesToPixels = (minutes: number) => minutes * pixelsPerMinute
  const pixelsToMinutes = (pixels: number) => pixels / pixelsPerMinute
  return { zoom, pixelsPerHour, pixelsPerMinute, dayHeight: minutesToPixels(1440), minutesToPixels, pixelsToMinutes }
}

export function calendarLocalTime(timestamp: number) {
  const date = new Date(timestamp)
  return {
    date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
    minutes: date.getHours() * 60 + date.getMinutes(),
  }
}
