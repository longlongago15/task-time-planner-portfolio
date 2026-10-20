// Match the existing API 409 detail; preserve presentation of other conflicts.
export function timeEntryOverlapMessage(detail: unknown): string | undefined {
  return detail === 'この時間帯には別の実績があります'
    ? 'この時間帯にはすでに記録があります。重ならない時間を指定してください。'
    : undefined
}
