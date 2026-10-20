import assert from 'node:assert/strict'
import test from 'node:test'
import { reportHourlyBuckets, reportActivityRows, reportShare, reportSummaryDifference } from '../src/reportPresentation.ts'
import { createReportDemoData } from '../src/reportDemo.ts'
import { buildReportMetrics } from '../src/reportMetrics.ts'

process.env.TZ = 'Asia/Tokyo'
const data = createReportDemoData()

test('Hour buckets clip at boundaries and union overlapping plans before measuring', () => {
  const buckets = reportHourlyBuckets([{ startMinutes: 570, endMinutes: 660 }, { startMinutes: 600, endMinutes: 690 }], [{ startMinutes: 590, endMinutes: 650 }])
  assert.equal(buckets.length, 24)
  assert.deepEqual(buckets.slice(9, 12).map(b => [b.plannedMinutes, b.actualMinutes]), [[30, 10], [60, 50], [30, 0]])
  assert(buckets.every(b => b.plannedMinutes <= 60 && Number.isFinite(b.differenceMinutes)))
})
test('Demo hours preserve day totals and never exceed 60 minutes', () => {
  for (const date of ['2026-10-05','2026-10-06','2026-10-07','2026-10-08','2026-10-09','2026-10-10','2026-10-11','2026-10-12','2026-10-13']) {
    const day = buildReportMetrics(data.tasks, data.projects, data.blocks, data.entries, [date], 0).daily[0]
    const hours = reportHourlyBuckets(day.planIntervals, day.actualIntervals)
    assert.equal(hours.reduce((n, b) => n + b.plannedMinutes, 0), day.plannedMinutes)
    assert.equal(hours.reduce((n, b) => n + b.actualMinutes, 0), day.actualMinutes)
    assert(hours.every(b => b.actualMinutes <= 60))
  }
})
test('Legacy overlapping records stay truthful rather than silently unioned', () => {
  assert.equal(reportHourlyBuckets([], [{ startMinutes: 0, endMinutes: 60 }, { startMinutes: 0, endMinutes: 30 }])[0].actualMinutes, 90)
})
test('Activity clips overnight contributions but retains a single original Entry in a range', () => {
  const a = reportActivityRows(data.entries, ['2026-10-12'], 0), b = reportActivityRows(data.entries, ['2026-10-13'], 0)
  assert.deepEqual([a[0].startMinutes, a[0].endMinutes, a[0].minutes], [1420, 1440, 20])
  assert.deepEqual([b[0].startMinutes, b[0].endMinutes, b[0].minutes], [0, 20, 20])
  const combined = reportActivityRows(data.entries, ['2026-10-12','2026-10-13'], 0)
  assert.equal(combined.length, 1); assert.equal(combined[0].minutes, 40)
  assert.equal(combined[0].entry, a[0].entry)
})
test('Activity is newest first and uses snapshots/current source Entries without mutation', () => {
  const before = JSON.stringify(data)
  const rows = reportActivityRows(data.entries, Array.from({length:7}, (_,i)=>`2026-10-${String(i+5).padStart(2,'0')}`), 0)
  assert.equal(rows.length, 17)
  assert(rows.every((r,i)=>!i || Date.parse(rows[i-1].entry.startedAt)>=Date.parse(r.entry.startedAt)))
  assert(rows.every(r=>r.entry.projectIdSnapshot !== undefined))
  assert.equal(JSON.stringify(data), before)
})
test('Active activity advances with now, excludes out-of-range records, floors minutes', () => {
  const entry = { ...data.entries[0], startedAt: '2026-10-05T09:00:00+09:00', endedAt: null }
  assert.equal(reportActivityRows([entry], ['2026-10-05'], Date.parse('2026-10-05T09:01:59+09:00'))[0].minutes, 1)
  assert.equal(reportActivityRows([entry], ['2026-10-06'], Date.parse('2026-10-05T09:01:59+09:00')).length, 0)
})
test('Shares use supplied filtered total; zero total is finite zero', () => {
  assert.equal(reportShare(60, 120), 50); assert.equal(reportShare(60, 60), 100)
  assert.equal(reportShare(0, 0), 0); assert.equal(reportShare(60, 0), 0)
})
test('Summary wording separates overrun, shortening and equal as signed numeric values', () => {
  assert.equal(reportSummaryDifference(30), '+30分')
  assert.equal(reportSummaryDifference(-80), '-1時間20分')
  assert.equal(reportSummaryDifference(0), '0分')
})
