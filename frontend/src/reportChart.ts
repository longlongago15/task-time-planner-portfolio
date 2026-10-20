// Presentation only: round the axis ceiling without changing Report totals.
export function reportChartScale(maximumMinutes: number) {
  const maximum = Math.max(1, maximumMinutes)
  const steps = [5, 15, 30, 60, 120, 180, 240, 360, 720, 1440]
  const step = steps.find(value => value >= maximum / 5) ?? Math.ceil(maximum / 5 / 1440) * 1440
  const intervals = Math.max(3, Math.ceil(maximum / step))
  return { maximum: intervals * step, ticks: Array.from({ length: intervals + 1 }, (_, index) => index * step) }
}
