export const formatDate = (value: Date) => (
  `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
)

export const shiftDate = (targetDate: string, days: number) => {
  const value = new Date(`${targetDate}T12:00:00`)
  value.setDate(value.getDate() + days)
  return formatDate(value)
}

export const getISOWeekNumber = (targetDate: string) => {
  const [year, month, day] = targetDate.split('-').map(Number)
  const thursday = new Date(Date.UTC(year, month - 1, day))
  thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7))
  return Math.ceil(((thursday.getTime() - Date.UTC(thursday.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7)
}

export const getMonthGridDates = (targetDate: string) => {
  const anchor = new Date(`${targetDate}T12:00:00`)
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1, 12)
  first.setDate(first.getDate() - ((first.getDay() + 6) % 7))
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(first)
    date.setDate(first.getDate() + index)
    return formatDate(date)
  })
}

export const getWeekDates = (anchorDate: string) => {
  const anchor = new Date(`${anchorDate}T12:00:00`)
  const monday = new Date(anchor)
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(monday)
    day.setDate(monday.getDate() + index)
    return formatDate(day)
  })
}
