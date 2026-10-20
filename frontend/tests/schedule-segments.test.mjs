import assert from 'node:assert/strict'
import test from 'node:test'
import { scheduleSegmentsForDay, plannedMinutesForDay } from '../src/scheduleSegments.ts'

const block = (date, startTime, durationMinutes, id = 1) => ({ id, date, startTime, durationMinutes, type: 'TIMED' })
const positions = (blocks, date) => scheduleSegmentsForDay(blocks, date).map(s => [s.schedule.id, s.startMinutes, s.endMinutes])

test('23:15 to 02:15 segments retain one source and split daily totals 45 + 135', () => {
  const source = block('2026-10-07', '23:15:00', 180), before = structuredClone(source)
  assert.deepEqual(positions([source], '2026-10-07'), [[1, 1395, 1440]])
  assert.deepEqual(positions([source], '2026-10-08'), [[1, 0, 135]])
  for (const date of ['2026-10-07', '2026-10-08']) assert.equal(scheduleSegmentsForDay([source], date)[0].schedule, source)
  assert.equal(plannedMinutesForDay([source], '2026-10-07'), 45)
  assert.equal(plannedMinutesForDay([source], '2026-10-08'), 135)
  assert.deepEqual(source, before)
})
test('midnight is exclusive; midnight start creates no previous-day segment', () => {
  const end = block('2026-10-07', '22:00:00', 120), start = block('2026-10-08', '00:00:00', 120)
  assert.deepEqual(positions([end], '2026-10-08'), [])
  assert.deepEqual(positions([start], '2026-10-07'), [])
  assert.deepEqual(positions([start], '2026-10-08'), [[1, 0, 120]])
})
test('multi-day and year boundaries use Calendar local dates', () => {
  const source = block('2026-12-31', '23:00:00', 1560)
  assert.deepEqual(positions([source], '2026-12-31'), [[1, 1380, 1440]])
  assert.deepEqual(positions([source], '2027-01-01'), [[1, 0, 1440]])
  assert.deepEqual(positions([source], '2027-01-02'), [[1, 0, 60]])
})
test('continuations and same-day overlap occupy a union, not double time', () => {
  const blocks = [block('2026-10-07', '23:15:00', 180), block('2026-10-08', '01:00:00', 120, 2)]
  assert.deepEqual(positions(blocks, '2026-10-08'), [[1, 0, 135], [2, 60, 180]])
  assert.equal(plannedMinutesForDay(blocks, '2026-10-08'), 180)
})
