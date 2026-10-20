export const TIME_INPUT_ERROR = '時刻は1516 / 0915 / 915 / 15:16形式で、00:00〜23:59を入力してください'

export function parseTimeInput(value: string): string {
  const text = value.trim()
  if (!text) return ''
  const digits = /^\d{3,4}$/.test(text) ? text.padStart(4, '0') : null
  const time = digits ? `${digits.slice(0, 2)}:${digits.slice(2)}` : text
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error(TIME_INPUT_ERROR)
  return time
}
