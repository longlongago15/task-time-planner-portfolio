import assert from 'node:assert/strict'
import test from 'node:test'
import { entryDisplaySpan, formatEntryDate, formatEntryDuration, getElapsedSeconds, readActiveTimer } from '../src/timer.ts'
import { timerReportRows } from '../src/timerReport.ts'

const entry = {
  id: 1, taskId: 1, projectIdSnapshot: null,
  startedAt: '2026-10-02T01:00:00Z', endedAt: null,
  startAt: '1999-01-01T00:00:00Z', endAt: '1999-01-01T00:01:00Z',
  durationMinutes: null, createdAt: '2026-10-02T01:00:00Z', updatedAt: '2026-10-02T01:00:00Z',
}

test('Active response restores the DB task and timestamp', () => {
  assert.deepEqual(readActiveTimer({ taskId: 1, running: true, startedAt: entry.startedAt }), { taskId: 1, startedAt: entry.startedAt })
  assert.equal(readActiveTimer({ taskId: null, running: false, startedAt: null }), null)
})
test('elapsed is restored from startedAt, including seconds', () => {
  assert.equal(getElapsedSeconds(entry.startedAt, Date.parse(entry.startedAt) + 123000), 123)
  assert.equal(getElapsedSeconds(entry.startedAt, Date.parse(entry.startedAt) - 30000), 0)
})
test('invalid timestamps never produce NaN or Invalid Date', () => {
  assert.equal(getElapsedSeconds(null), 0)
  assert.equal(getElapsedSeconds('invalid'), 0)
  assert.equal(formatEntryDate(null, true), '—')
  assert.equal(formatEntryDate('invalid'), '—')
  assert.throws(() => readActiveTimer({ taskId: 1, running: true, startedAt: 'invalid' }))
})
test('NULL duration is Active, not an estimate or a completed zero interval', () => {
  assert.equal(formatEntryDuration(entry), '計測中')
  assert.equal(formatEntryDuration({ ...entry, endedAt: entry.startedAt, durationMinutes: null }), '—')
  assert.equal(formatEntryDuration({ ...entry, endedAt: entry.startedAt, durationMinutes: NaN }), '—')
})
test('closed zero-second and 30-second entries display zero minutes', () => {
  assert.equal(formatEntryDuration({ ...entry, endedAt: entry.startedAt, durationMinutes: 0 }), '0分')
  assert.equal(formatEntryDuration({ ...entry, endedAt: '2026-10-02T01:00:30Z', durationMinutes: 0 }), '0分')
})
test('calendar geometry uses canonical fields once and handles Active NULL end', () => {
  const now = Date.parse(entry.startedAt) + 123000
  assert.deepEqual(entryDisplaySpan(entry, now), { start: Date.parse(entry.startedAt), end: now })
  assert.equal(entryDisplaySpan({ ...entry, startedAt: 'invalid' }, now), null)
  assert.equal(entryDisplaySpan({ ...entry, endedAt: 'invalid' }, now), null)
})
test('report rows use Backend minutes without adding Active duration', () => {
  const tasks = [{ id: 1, title: 'Task', projectName: null, estimatedMinutes: 20 }]
  const summaries = [{ date: '2026-10-02', tasks: [{ taskId: 1, estimatedMinutes: 20, actualMinutes: 7, differenceMinutes: -13 }] }]
  const rows = timerReportRows(tasks, [entry], summaries, ['2026-10-02'])
  assert.equal(rows[0].actualMinutes, 7)
  assert.equal(rows[0].differenceMinutes, -13)
})
test('report period sums only API task values and preserves NULL estimates', () => {
  const tasks = [{ id: 1, title: 'Task', projectName: null, estimatedMinutes: null }]
  const summaries = [{ date: '2026-10-02', tasks: [{ taskId: 1, estimatedMinutes: null, actualMinutes: 7, differenceMinutes: null }] }]
  const row = timerReportRows(tasks, [], summaries, ['2026-10-02'])[0]
  assert.equal(row.estimatedMinutes, null)
  assert.equal(row.differenceMinutes, null)
})
test('unscheduled recorded tasks retain a row without inventing period actual minutes', () => {
  const tasks = [{ id: 1, title: 'Task', projectName: null, estimatedMinutes: 20 }]
  const row = timerReportRows(tasks, [{ ...entry, endedAt: '2026-10-02T01:10:00Z', durationMinutes: 10 }], [], ['2026-10-02'])[0]
  assert.equal(row.actualMinutes, null)
  assert.equal(row.differenceMinutes, null)
})

test('period reports do not present a scheduled-day subtotal as a full-period task total', () => {
  const tasks = [{ id: 1, title: 'Task', projectName: null, estimatedMinutes: 20 }]
  const summaries = [
    { date: '2026-10-01', tasks: [] },
    { date: '2026-10-02', tasks: [{ taskId: 1, estimatedMinutes: 20, actualMinutes: 7, differenceMinutes: -13 }] },
  ]
  const row = timerReportRows(tasks, [{ ...entry, startedAt: '2026-10-01T01:00:00Z', endedAt: '2026-10-01T01:05:00Z' }], summaries, ['2026-10-01', '2026-10-02'])[0]
  assert.equal(row.actualMinutes, null)
  assert.equal(row.differenceMinutes, null)
})

test('Legacy schedule values alone never create a report row or contribute an estimate', () => {
  const tasks = [{ id: 1, title: 'Legacy only', projectName: null, plannedDate: '2026-10-02', plannedStartTime: '10:00', estimatedMinutes: 60 }]
  assert.deepEqual(timerReportRows(tasks, [], [{ date: '2026-10-02', tasks: [] }], ['2026-10-02']), [])
  tasks[0].plannedDate = '2026-10-03'
  assert.deepEqual(timerReportRows(tasks, [], [{ date: '2026-10-02', tasks: [] }], ['2026-10-02']), [])
})

test('period estimates sum scheduled daily rows for the same Task across different days', () => {
  const tasks = [{ id: 1, title: 'Repeated schedule', projectName: null, estimatedMinutes: 60 }]
  const summaries = ['2026-10-02', '2026-10-03'].map(date => ({ date, tasks: [
    { taskId: 1, estimatedMinutes: 60, actualMinutes: 10, differenceMinutes: -50 },
  ] }))
  const [row] = timerReportRows(tasks, [], summaries, ['2026-10-02', '2026-10-03'])
  assert.equal(row.estimatedMinutes, 120)
  assert.equal(row.actualMinutes, 20)
  assert.equal(row.differenceMinutes, -100)
})
