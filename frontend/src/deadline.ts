import { parseDateInput } from './dateParser.ts'
export const DEADLINE_ERROR = '期限は2000〜2100年の実在する日付をYYYY/MM/DD形式で入力してください'

// Editing accepts partial text. Only complete, real dates may cross the save boundary.
export function parseDeadline(value: string): string | null {
  const text = value.trim()
  if (!text) return null
  return parseDateInput(text, DEADLINE_ERROR)
}

export function deadlineText(value: string | null) { return value?.replaceAll('-', '/') ?? '' }

export function deadlineCalendarDate(value: string, today = new Date()): Date {
  try {
    const parsed = parseDeadline(value)
    if (parsed) { const [y, m, d] = parsed.split('-').map(Number); return new Date(y, m - 1, d) }
  } catch { /* Invalid drafts must never supply the calendar year. */ }
  return today
}
