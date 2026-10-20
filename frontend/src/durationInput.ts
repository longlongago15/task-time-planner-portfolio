const durationInputError = '「2h 30m」「2.5h」「150m」の形式で入力してください。見積もりは1以上の整数分になる時間を指定します。'

// Hours are converted exactly: never round a fractional minute into an estimate.
export function parseDurationInput(input: string): number | null {
  const text = input.trim()
  if (!text) return null
  const match = /^(?:(\d+(?:\.\d+)?)\s*h(?:\s*(\d+)\s*m)?|(\d+)\s*m|(\d+))$/i.exec(text)
  if (!match || text.length > 100) throw new Error(durationInputError)
  let minutes: bigint
  if (match[1] !== undefined) {
    const [whole, fraction = ''] = match[1].split('.')
    const divisor = 10n ** BigInt(fraction.length)
    const numerator = BigInt(whole + fraction) * 60n
    if (numerator % divisor !== 0n) throw new Error(durationInputError)
    minutes = numerator / divisor + BigInt(match[2] ?? '0')
  } else minutes = BigInt(match[3] ?? match[4])
  if (minutes <= 0n || minutes > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(durationInputError)
  return Number(minutes)
}

export function formatDurationInput(minutes: number | null): string {
  if (minutes === null) return ''
  const hours = Math.floor(minutes / 60), remainder = minutes % 60
  return hours ? `${hours}h${remainder ? ` ${remainder}m` : ''}` : `${remainder}m`
}

export function formatCompactDuration(minutes: number | null): string {
  return minutes === null ? '未設定' : formatDurationInput(minutes)
}
