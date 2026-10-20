import assert from 'node:assert/strict'
import test from 'node:test'
import { createReportDemoData, isReportDemoEnabled } from '../src/reportDemo.ts'
import { buildReportMetrics } from '../src/reportMetrics.ts'

process.env.TZ = 'Asia/Tokyo'
const data = createReportDemoData()
const week = Array.from({ length: 7 }, (_, i) => `2026-10-${String(i + 5).padStart(2, '0')}`)
const build = dates => buildReportMetrics(data.tasks, data.projects, data.blocks, data.entries, dates, 0)

test('Demo requires both development and the explicit reportDemo=1 query', () => {
  assert.equal(isReportDemoEnabled(true, ''), false)
  assert.equal(isReportDemoEnabled(true, '?reportDemo=0'), false)
  assert.equal(isReportDemoEnabled(true, '?reportDemo=1'), true)
  assert.equal(isReportDemoEnabled(false, '?reportDemo=1'), false)
})
test('Demo contains the agreed Projects, Tags, Tasks and statuses', () => {
  assert.deepEqual(data.projects.map(p => p.name), ['IT学習', '個人開発', '就活', '生活'])
  assert.equal(new Set(data.projects.map(p => p.color)).size, 4)
  assert.equal(data.tags.length, 9)
  assert.equal(data.tasks.length, 10)
  assert.equal(new Set(data.tasks.map(t => t.status)).size, 3)
  assert(data.tasks.some(t => t.tags.length > 1))
  assert.equal(build(week).topTasks.length, 10)
})
test('Existing metrics produce 25 hours planned, 25h30 recorded and +30 minutes', () => {
  const result = build(week)
  assert.deepEqual([result.plannedMinutes, result.actualMinutes, result.differenceMinutes], [1500, 1530, 30])
})
test('Dataset includes plan-only, record-only, overrun, saving and equal Tasks per day', () => {
  const rows = week.flatMap(date => build([date]).taskRows)
  assert(rows.some(r => r.plannedMinutes > 0 && r.actualMinutes === 0))
  assert(rows.some(r => r.plannedMinutes === 0 && r.actualMinutes > 0))
  assert(rows.some(r => r.plannedMinutes > 0 && r.actualMinutes > 0 && r.differenceMinutes > 0))
  assert(rows.some(r => r.plannedMinutes > 0 && r.actualMinutes > 0 && r.differenceMinutes < 0))
  assert(rows.some(r => r.plannedMinutes > 0 && r.differenceMinutes === 0))
})
test('Every TimeEntry is closed, has a Project snapshot and does not overlap', () => {
  const ordered = [...data.entries].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
  for (let i = 0; i < ordered.length; i++) {
    assert(ordered[i].endedAt)
    assert(data.projects.some(p => p.id === ordered[i].projectIdSnapshot))
    if (i) assert(Date.parse(ordered[i - 1].endedAt) <= Date.parse(ordered[i].startedAt))
  }
  const reassigned = data.tasks.map(t => ({ ...t, projectId: data.projects[3].id }))
  assert.deepEqual(buildReportMetrics(reassigned, data.projects, [], data.entries, week, 0).projectRows.map(r => [r.id, r.actualMinutes]),
    buildReportMetrics(data.tasks, data.projects, [], data.entries, week, 0).projectRows.map(r => [r.id, r.actualMinutes]))
})
test('Single overnight Schedule and TimeEntry split into 30 planned and 20 recorded each day', () => {
  assert.equal(data.blocks.filter(b => b.date === '2026-10-12').length, 1)
  assert.equal(data.entries.filter(e => e.startedAt === '2026-10-12T14:40:00.000Z').length, 1)
  assert.deepEqual(build(['2026-10-12', '2026-10-13']).daily.map(d => [d.plannedMinutes, d.actualMinutes, d.differenceMinutes]), [[30, 20, -10], [30, 20, -10]])
})
