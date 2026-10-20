import { parseDateInput } from './dateParser.ts'

export type TaskPeriod = { startDate: string | null; deadline: string | null }
const error = '実在する日付を入力してください（例：20261012、2026/10/12、10/12）'
export function taskPeriodText(startDate?: string | null, deadline?: string | null, full = false) {
  const format = (date: string) => full ? date.replaceAll('-', '/') : date.slice(5).replace('-', '/')
  if (!deadline) return startDate ? format(startDate) : ''
  return startDate && startDate !== deadline ? `${format(startDate)} - ${format(deadline)}` : format(deadline)
}
export function parseTaskPeriod(value: string, currentYear = new Date().getFullYear()): TaskPeriod {
  if (!value.trim()) return { startDate: null, deadline: null }
  try { return { startDate: null, deadline: parseDateInput(value, error, currentYear) } } catch { /* A full ISO date is one date, never a range of its fragments. */ }
  const token = '(?:\\d{4}[/-]\\d{1,2}[/-]\\d{1,2}|\\d{8}|\\d{1,2}[/-]\\d{1,2}|\\d{4})'
  const range = new RegExp(`^\\s*(${token})\\s*(?:-|–|〜|～)\\s*(${token})\\s*$`).exec(value)
  const deadline = parseDateInput(range?.[2] ?? value, error, currentYear)
  const startDate = range ? parseDateInput(range[1], error, currentYear) : null
  if (startDate && deadline && startDate > deadline) throw new Error('開始日は期限以前の日付を指定してください')
  return { startDate, deadline }
}
