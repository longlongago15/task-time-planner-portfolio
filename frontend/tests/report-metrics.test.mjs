import assert from 'node:assert/strict'
import test from 'node:test'
import { buildReportMetrics, formatReportDifference, reportEntryForDay } from '../src/reportMetrics.ts'

process.env.TZ = 'Asia/Tokyo'
const tasks = [{ id: 1, title: 'A', projectId: 1 }, { id: 2, title: 'B', projectId: 2 }, { id: 3, title: 'Record only', projectId: 1 }]
const projects = [{ id: 1, name: 'Blue' }, { id: 2, name: 'Red' }]
const block = (id, taskId, date, startTime, durationMinutes) => ({ id, taskId, date, startTime, durationMinutes, type: 'TIMED' })
const entry = (id, taskId, projectIdSnapshot, startedAt, endedAt) => ({ id, taskId, projectIdSnapshot, startedAt, endedAt })
const build = (blocks = [], entries = [], dates = ['2026-10-07'], now = Date.parse('2026-10-07T12:00:00+09:00')) => buildReportMetrics(tasks, projects, blocks, entries, dates, now)

test('overall union differs intentionally from Task and Project allocations', () => {
  const blocks = [block(1, 1, '2026-10-07', '10:00:00', 60), block(2, 2, '2026-10-07', '10:30:00', 60)]
  const result = build(blocks)
  assert.equal(result.plannedMinutes, 90)
  assert.deepEqual(result.taskRows.map(row => row.plannedMinutes), [60, 60])
  assert.deepEqual(result.projectRows.map(row => row.plannedMinutes), [60, 60])
  assert.equal(buildReportMetrics(tasks.map(task => ({ ...task, projectId: 1 })), projects, blocks, [], ['2026-10-07'], 0).projectRows[0].plannedMinutes, 90)
})
test('overnight schedules reuse source segments across day, week and month boundaries', () => {
  const result = build([block(1, 1, '2026-10-31', '23:15:00', 180)], [], ['2026-10-31', '2026-11-01'])
  assert.deepEqual(result.daily.map(day => day.plannedMinutes), [45, 135])
  assert.equal(result.plannedMinutes, 180)
  assert.equal(build([block(1, 1, '2026-10-07', '22:00:00', 120)], [], ['2026-10-08']).plannedMinutes, 0)
})
test('closed and active Entries use per-day clipped, per-Entry flooring', () => {
  const entries = [entry(1, 1, 1, '2026-10-07T23:15:00+09:00', '2026-10-08T02:15:00+09:00')]
  assert.deepEqual(build([], entries, ['2026-10-07', '2026-10-08']).daily.map(day => day.actualMinutes), [45, 135])
  const active = entry(2, 3, 2, '2026-10-07T10:00:00+09:00', null)
  assert.equal(build([], [active]).actualMinutes, 120)
  assert.equal(build([], [active], ['2026-10-07'], Date.parse('2026-10-07T12:01:00+09:00')).actualMinutes, 121)
  assert.equal(build([], [entry(1, 1, 1, '2026-10-07T00:00:00Z', '2026-10-07T00:00:59Z'), entry(2, 1, 1, '2026-10-07T01:00:00Z', '2026-10-07T01:00:59Z')]).actualMinutes, 0)
})
test('backend microsecond precision survives the minute boundary', () => {
  assert.equal(reportEntryForDay(entry(1, 1, 1, '2026-10-07T00:00:00.900001Z', '2026-10-07T00:01:00.900000Z'), '2026-10-07', 0).minutes, 0)
  assert.equal(reportEntryForDay(entry(1, 1, 1, '2026-10-07T00:00:00.900000Z', '2026-10-07T00:01:00.900000Z'), '2026-10-07', 0).minutes, 1)
  assert.equal(build([block(1, 1, '2026-10-07', '23:59:30', 1)], [], ['2026-10-07']).plannedMinutes, 0)
})
test('TimeEntry continuations are included after week and month boundaries', () => {
  for (const [before, after] of [['2026-10-11', '2026-10-12'], ['2026-10-31', '2026-11-01']]) {
    const source = entry(1, 1, 2, `${before}T23:15:00+09:00`, `${after}T02:15:00+09:00`)
    assert.deepEqual(build([], [source], [before, after]).daily.map(day => day.actualMinutes), [45, 135])
    assert.equal(build([], [source], [after]).actualMinutes, 135)
  }
})
test('Schedule union floors after merging, while Task allocations floor separately', () => {
  const result = build([block(1, 1, '2026-10-07', '10:00:30', 1), block(2, 2, '2026-10-07', '10:01:00', 1)])
  assert.equal(result.plannedMinutes, 1)
  assert.deepEqual(result.taskRows.map(row => row.plannedMinutes), [1, 1])
  const midnight = build([block(1, 1, '2026-10-07', '23:59:30', 1), block(2, 2, '2026-10-08', '00:00:30', 1)], [], ['2026-10-08'])
  assert.equal(midnight.plannedMinutes, 1)
})
test('Record-only Task is included and Project uses snapshot, not current Task project', () => {
  const result = build([], [entry(1, 3, 2, '2026-10-07T10:00:00+09:00', '2026-10-07T11:00:00+09:00')])
  assert.equal(result.taskRows[0].id, 3)
  assert.equal(result.taskRows[0].plannedMinutes, 0)
  assert.deepEqual(result.projectRows.map(row => [row.id, row.actualMinutes]), [[2, 60]])
})
test('UTC clipping follows local boundaries and DST elapsed duration', () => {
  const source = entry(1, 1, null, '2026-11-01T00:00:00-04:00', '2026-11-02T00:00:00-05:00')
  process.env.TZ = 'America/New_York'
  try { assert.equal(reportEntryForDay(source, '2026-11-01', 0).minutes, 1500) } finally { process.env.TZ = 'Asia/Tokyo' }
  assert.equal(reportEntryForDay(entry(1, 1, null, '2026-10-31T23:00:00+09:00', '2026-11-01T00:00:00+09:00'), '2026-11-01', 0), null)
})
test('Task Top10 sorts absolute difference and includes unplanned recordings', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, title: `T${i}`, projectId: null }))
  const entries = many.map(task => entry(task.id, task.id, null, '2026-10-07T00:00:00Z', `2026-10-07T00:${String(task.id).padStart(2, '0')}:00Z`))
  const result = buildReportMetrics(many, [], [], entries, ['2026-10-07'], 0)
  assert.equal(result.topTasks.length, 10)
  assert.deepEqual(result.topTasks.map(row => row.id), [12, 11, 10, 9, 8, 7, 6, 5, 4, 3])
})
test('Difference wording and empty data are finite zeros without estimates', () => {
  assert.deepEqual([120, -75, 0].map(formatReportDifference), ['+2時間超過', '-1時間15分短縮', '0分'])
  const result = build()
  assert.equal(result.plannedMinutes, 0)
  assert.equal(result.actualMinutes, 0)
  assert.equal(result.differenceMinutes, 0)
  assert.deepEqual(result.taskRows, [])
  assert(!JSON.stringify(result).includes('estimated'))
})
