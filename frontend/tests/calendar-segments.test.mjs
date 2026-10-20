import assert from 'node:assert/strict'
import test from 'node:test'
import { entryDisplaySpan, entrySegmentsForLocalDay } from '../src/timer.ts'

process.env.TZ = 'Asia/Tokyo'
const entry = (id, startedAt, endedAt) => ({ id, taskId: 1, projectIdSnapshot: null, startedAt, endedAt,
  startAt: '1999-01-01T00:00:00Z', endAt: '1999-01-01T00:01:00Z', durationMinutes: null,
  createdAt: startedAt, updatedAt: startedAt })
const positions = (entries, day, now = Date.parse('2026-10-03T03:00:00Z')) => entrySegmentsForLocalDay(entries, day, now)
  .map(({ entry, startMinutes, endMinutes }) => [entry.id, startMinutes, endMinutes])

test('calendar actual uses canonical UTC timestamps in local time, independently of duration', () => {
  assert.deepEqual(positions([entry(1, '2026-10-02T01:15:00Z', '2026-10-02T02:15:00Z')], '2026-10-02'), [[1, 615, 675]])
})
test('closed midnight crossing is split and midnight end is excluded from the next day', () => {
  const rows = [entry(1, '2026-10-02T14:30:00Z', '2026-10-02T16:00:00Z')]
  assert.deepEqual(positions(rows, '2026-10-02'), [[1, 1410, 1440]])
  assert.deepEqual(positions(rows, '2026-10-03'), [[1, 0, 60]])
  assert.deepEqual(positions([entry(2, '2026-10-02T14:00:00Z', '2026-10-02T15:00:00Z')], '2026-10-03'), [])
})
test('Active midnight crossing uses the supplied ticker time without changing the entry', () => {
  const rows = [entry(1, '2026-10-02T14:30:00Z', null)]
  const before = structuredClone(rows)
  assert.deepEqual(positions(rows, '2026-10-02', Date.parse('2026-10-02T16:00:00Z')), [[1, 1410, 1440]])
  assert.deepEqual(positions(rows, '2026-10-03', Date.parse('2026-10-02T16:00:00Z')), [[1, 0, 60]])
  assert.deepEqual(rows, before)
})
test('zero seconds is a point on exactly one day and short entries retain fractional minutes', () => {
  // Keep the existing Report/day consumers' interval semantics; only the week helper opts into points.
  assert.equal(entryDisplaySpan(entry(1, '2026-10-02T15:00:00Z', '2026-10-02T15:00:00Z')), null)
  assert.deepEqual(positions([entry(1, '2026-10-02T15:00:00Z', '2026-10-02T15:00:00Z')], '2026-10-02'), [])
  assert.deepEqual(positions([entry(1, '2026-10-02T15:00:00Z', '2026-10-02T15:00:00Z')], '2026-10-03'), [[1, 0, 0]])
  assert.deepEqual(positions([entry(2, '2026-10-02T01:00:00Z', '2026-10-02T01:00:30Z')], '2026-10-02'), [[2, 600, 600.5]])
})
test('Pause and Resume entries are not merged', () => {
  assert.deepEqual(positions([entry(1, '2026-10-02T01:00:00Z', '2026-10-02T01:30:00Z'),
    entry(2, '2026-10-02T01:30:00Z', '2026-10-02T02:00:00Z')], '2026-10-02'), [[1, 600, 630], [2, 630, 660]])
})
test('invalid, reversed and future Active intervals do not render', () => {
  assert.deepEqual(positions([entry(1, 'invalid', null), entry(2, '2026-10-02T02:00:00Z', 'invalid'),
    entry(3, '2026-10-02T02:00:00Z', '2026-10-02T01:00:00Z'), entry(4, '2026-10-04T01:00:00Z', null)], '2026-10-02'), [])
})
