export const DATE_INPUT_ERROR = '日付は2000〜2100年の実在する日付をYYYY/MM/DDまたはYYYYMMDD形式で入力してください'

/** Partial compact text has a four-digit year followed by unfinished month/day digits. */
export function acceptsDateDraft(value: string) {
  return /^\d{0,8}$/.test(value) || /^\d{0,4}([/-]\d{0,2}([/-]\d{0,2})?)?$/.test(value)
}

export function parseDateInput(value: string, message = DATE_INPUT_ERROR, currentYear?: number): string | null {
  let text = value.trim()
  if (!text) return null
  if (currentYear !== undefined) {
    if (/^\d{4}$/.test(text)) text = `${currentYear}${text}`
    else if (/^\d{1,2}[/-]\d{1,2}$/.test(text)) text = `${currentYear}/${text.replace('-', '/')}`
  }
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(text)
  const separated = /^(\d{4})([/-])(\d{1,2})\2(\d{1,2})$/.exec(text)
  if (!compact && !separated) throw new Error(message)
  const year = Number(compact?.[1] ?? separated![1])
  const month = Number(compact?.[2] ?? separated![3]), day = Number(compact?.[3] ?? separated![4])
  const date = new Date(year, month - 1, day)
  if (year < 2000 || year > 2100 || date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) throw new Error(message)
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}
