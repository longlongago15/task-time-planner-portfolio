import assert from 'node:assert/strict'
import test from 'node:test'
import { emptyReportFilters, filterReportDataset } from '../src/reportFilters.ts'
import { createReportDemoData } from '../src/reportDemo.ts'
import { buildReportMetrics } from '../src/reportMetrics.ts'

process.env.TZ = 'Asia/Tokyo'
const data = createReportDemoData(), dates = Array.from({ length: 7 }, (_, i) => `2026-10-${String(i + 5).padStart(2, '0')}`)
const build = filters => { const f = filterReportDataset(data.tasks, data.blocks, data.entries, { ...emptyReportFilters(), ...filters }); return buildReportMetrics(f.tasks, data.projects, f.blocks, f.entries, dates, 0) }
const totals = result => [result.plannedMinutes, result.actualMinutes, result.differenceMinutes]

test('Demo Project, Tag and Status use OR, with AND between categories', () => {
  assert.deepEqual(totals(build({})), [1500, 1530, 30])
  assert.deepEqual(totals(build({ project: ['9001'] })), [420, 465, 45])
  assert.deepEqual(totals(build({ project: ['9001', '9002'] })), [960, 945, -15])
  assert.deepEqual(totals(build({ tag: ['9101', '9103'] })), [330, 390, 60])
  assert.deepEqual(totals(build({ status: ['IN_PROGRESS', 'COMPLETED'] })), [1410, 1410, 0])
  assert.deepEqual(totals(build({ project: ['9001'], tag: ['9103'], status: ['NOT_STARTED'] })), [90, 120, 30])
})
test('Project attribution differs for Schedule and Entry; unassigned uses each source correctly', () => {
  const tasks = [{ id: 1, title: 'Moved', projectId: 2, tags: [{ id: 1 }], status: 'COMPLETED' }, { id: 2, title: 'Now unassigned', projectId: null, tags: [], status: 'IN_PROGRESS' }]
  const blocks = [{ taskId: 1 }, { taskId: 2 }]
  const entries = [{ taskId: 1, projectIdSnapshot: 1 }, { taskId: 2, projectIdSnapshot: null }, { taskId: 1, projectIdSnapshot: null }]
  const filter = project => filterReportDataset(tasks, blocks, entries, { ...emptyReportFilters(), project })
  assert.deepEqual(filter(['1']).blocks, [])
  assert.deepEqual(filter(['1']).entries, [entries[0]])
  assert.deepEqual(filter(['2']).blocks, [blocks[0]])
  assert.deepEqual(filter(['2']).entries, [])
  assert.deepEqual(filter(['unassigned']).blocks, [blocks[1]])
  assert.deepEqual(filter(['unassigned']).entries, [entries[1], entries[2]])
  const both = filterReportDataset(tasks, blocks, entries, { project: ['1'], tag: ['1'], status: ['COMPLETED'] })
  assert.deepEqual(both.entries, [entries[0]])
  assert.deepEqual(filterReportDataset(tasks, blocks, entries, { project: [], tag: ['1'], status: ['NOT_STARTED'] }).entries, [])
})
test('Filter precedes Schedule union and applies identically to charts and tables', () => {
  const tasks = [{ id: 1, title: 'A', projectId: 1 }, { id: 2, title: 'B', projectId: 2 }]
  const blocks = tasks.map((t, i) => ({ id: i, taskId: t.id, date: dates[0], type: 'TIMED', startTime: i ? '10:30:00' : '10:00:00', durationMinutes: 60 }))
  const metrics = project => { const f = filterReportDataset(tasks, blocks, [], { ...emptyReportFilters(), project }); return buildReportMetrics(f.tasks, [{ id: 1, name: 'P1' }, { id: 2, name: 'P2' }], f.blocks, [], [dates[0]], 0) }
  assert.equal(metrics(['1']).plannedMinutes, 60)
  assert.equal(metrics(['1', '2']).plannedMinutes, 90)
  assert.equal(metrics(['1']).daily[0].planIntervals.length, 1)
  assert.deepEqual(metrics(['1']).taskRows.map(r => r.id), [1])
  assert.deepEqual(metrics(['1']).projectRows.map(r => r.id), [1])
})
test('Top10 is selected after filtering, including Tasks outside the original Top10', () => {
  const tasks = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, title: `T${i}`, projectId: i < 10 ? 1 : 2 }))
  const blocks = tasks.map((t, i) => ({ id: i, taskId: t.id, date: dates[0], type: 'TIMED', startTime: '10:00:00', durationMinutes: 120 - i }))
  const f = filterReportDataset(tasks, blocks, [], { ...emptyReportFilters(), project: ['2'] })
  assert.deepEqual(buildReportMetrics(f.tasks, [], f.blocks, [], [dates[0]], 0).topTasks.map(r => r.id), [11, 12])
})
test('Filtered overnight and active Entries retain clipping and per-Entry minute flooring', () => {
  const overnight = filterReportDataset(data.tasks, data.blocks, data.entries, { ...emptyReportFilters(), tag: ['9109'] })
  assert.deepEqual(buildReportMetrics(overnight.tasks, data.projects, overnight.blocks, overnight.entries, ['2026-10-12', '2026-10-13'], 0).daily.map(d => [d.plannedMinutes, d.actualMinutes]), [[30, 20], [30, 20]])
  const entries = [{ taskId: 9201, projectIdSnapshot: 9001, startedAt: '2026-10-05T10:00:00+09:00', endedAt: null }]
  const f = filterReportDataset(data.tasks, [], entries, { ...emptyReportFilters(), tag: ['9101'] })
  assert.equal(buildReportMetrics(f.tasks, data.projects, [], f.entries, [dates[0]], Date.parse('2026-10-05T11:00:59+09:00')).actualMinutes, 60)
})
test('Filtering never mutates Demo sources and empty matches produce empty tables and zeros', () => {
  const before = structuredClone(data)
  assert.deepEqual(totals(build({ tag: ['missing'] })), [0, 0, 0])
  assert.deepEqual(build({ tag: ['missing'] }).taskRows, [])
  assert.deepEqual(build({ tag: ['missing'] }).projectRows, [])
  assert.deepEqual(data, before)
})
