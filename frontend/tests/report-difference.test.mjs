import assert from 'node:assert/strict'
import test from 'node:test'
import { reportDifference } from '../src/reportDifference.ts'

for (const [planned, actual, label, tone] of [
  [0, 0, '－', 'neutral'], [60, 0, '－', 'neutral'],
  [0, 30, '+30分', 'warm'], [60, 60, '±0', 'neutral'],
  [60, 90, '+30分', 'warm'], [90, 60, '-30分', 'cool'],
]) test(`Difference ${planned}/${actual}: ${label}`, () => {
  const result = reportDifference(planned, actual)
  assert.equal(result.displayText, label); assert.equal(result.tone, tone)
  assert.equal(result.value, actual - planned)
})
