import assert from 'node:assert/strict'
import test from 'node:test'
import { actualDefaults, localDateTime, localMinuteDateTime, utcDateTime, recordDateTime, recordTimestamp, recordInterval } from '../src/timeEntryInput.ts'

function inZone(zone, callback) {
  const previous = process.env.TZ
  process.env.TZ = zone
  try { callback() } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous }
}

test('Separate record date/time inputs use strict dates and preserve unchanged precision', () => inZone('Asia/Tokyo', () => {
  const original = '2026-10-07T04:00:30.123Z'
  assert.deepEqual(recordDateTime(original), { date: '2026/10/07', time: '13:00' })
  assert.equal(recordTimestamp('2026/10/7', '13:00', original), original)
  assert.equal(recordTimestamp('2026/10/7', '13:45'), '2026-10-07T04:45:00.000Z')
  for (const [date, time] of [['', '13:00'], ['2026/02/30', '13:00'], ['2026/10/7', '24:00'], ['2026/10/7', '13:60'], ['2026/10/7', '1:00']]) assert.throws(() => recordTimestamp(date, time))
  const start = { date: '2026/10/7', time: '23:30' }, end = { date: '2026/10/8', time: '00:45' }
  const interval = recordInterval(start, end)
  assert.equal((Date.parse(interval.endedAt) - Date.parse(interval.startedAt)) / 60000, 75)
  assert.throws(() => recordInterval(start, start), /後/)
  assert.throws(() => recordInterval(end, start), /後/)
}))

test('Record editing rejects DST gaps and preserves the second occurrence of repeated time', () => inZone('America/New_York', () => {
  assert.throws(() => recordTimestamp('2026/03/08', '02:30'), /存在しません/)
  const original = '2026-11-01T06:30:45.123Z'
  assert.equal(recordTimestamp('2026/11/01', '01:30', original), original)
}))

test('Tokyo local input becomes canonical UTC and preserves milliseconds', () => inZone('Asia/Tokyo', () => {
  assert.equal(utcDateTime('2026-10-02T10:00'), '2026-10-02T01:00:00.000Z')
  assert.equal(localDateTime('2026-10-02T01:00:30.123Z'), '2026-10-02T10:00:30.123')
  assert.equal(utcDateTime('2026-10-02T10:00:30.123'), '2026-10-02T01:00:30.123Z')
}))
test('UTC input retains its local date including a midnight crossing', () => inZone('UTC', () => {
  assert.equal(utcDateTime('2026-10-02T23:30'), '2026-10-02T23:30:00.000Z')
  assert.equal(utcDateTime('2026-10-03T00:30'), '2026-10-03T00:30:00.000Z')
}))

test('minute-only editing hides seconds and preserves unchanged API precision', () => inZone('Asia/Tokyo', () => {
  const original = '2026-10-02T01:00:30.123Z'
  assert.equal(localMinuteDateTime(original), '2026-10-02T10:00')
  assert.equal(utcDateTime(localMinuteDateTime(original), original), original)
  assert.equal(utcDateTime('2026-10-02T10:01', original), '2026-10-02T01:01:00.000Z')
}))

test('minute-only editing preserves the second occurrence of a DST hour', () => inZone('America/New_York', () => {
  const original = '2026-11-01T06:30:45.123Z'
  assert.equal(utcDateTime(localMinuteDateTime(original), original), original)
}))
test('nonexistent DST wall time and invalid calendar dates are rejected', () => inZone('America/New_York', () => {
  assert.throws(() => utcDateTime('2026-03-08T02:30'), /存在しません/)
  assert.throws(() => utcDateTime('2026-02-30T10:00'), /存在しません/)
  assert.throws(() => utcDateTime(''), /入力/)
}))
test('unchanged second occurrence of DST hour retains its original instant on edit', () => inZone('America/New_York', () => {
  const first = '2026-11-01T05:30:00.123Z', second = '2026-11-01T06:30:00.123Z'
  assert.equal(localDateTime(first), localDateTime(second))
  assert.equal(utcDateTime(localDateTime(second), second), second)
  assert.equal(utcDateTime('2026-11-01T02:30'), '2026-11-01T07:30:00.000Z')
}))
test('click and drag defaults use selected local positions and no writes', () => inZone('Asia/Tokyo', () => {
  const now = Date.parse('2026-10-04T03:00:00Z')
  assert.deepEqual(actualDefaults('2026-10-02', 600, undefined, now), { startedAt: '2026-10-02T01:00:00.000Z', endedAt: '2026-10-02T01:30:00.000Z', adjusted: false })
  assert.equal(actualDefaults('2026-10-02', 600, 675, now).endedAt, '2026-10-02T02:15:00.000Z')
}))
test('future defaults clamp end to now while keeping a positive interval', () => inZone('Asia/Tokyo', () => {
  const now = Date.parse('2026-10-04T03:00:00Z')
  for (const [date, start] of [['2026-10-04', 720], ['2026-10-05', 600], ['2026-10-04', 710]]) {
    const result = actualDefaults(date, start, undefined, now)
    assert(result.adjusted)
    assert(Date.parse(result.startedAt) < Date.parse(result.endedAt))
    assert.equal(Date.parse(result.endedAt), now)
  }
}))
