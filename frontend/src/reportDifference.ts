import { formatDuration } from './duration.ts'

export function reportDifference(planned: number, recorded: number) {
  const value = recorded - planned
  const numeric = `${value > 0 ? '+' : value < 0 ? '-' : ''}${formatDuration(Math.abs(value))}`
  const direction = recorded === 0 || value === 0 ? 'neutral' : value > 0 ? 'positive' : 'negative'
  const displayText = recorded === 0 ? '－' : value === 0 ? '±0' : numeric
  const tone = direction === 'positive' ? 'warm' : direction === 'negative' ? 'cool' : 'neutral'
  return {value, displayText, direction, tone}
}
