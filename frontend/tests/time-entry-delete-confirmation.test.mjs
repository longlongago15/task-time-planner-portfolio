import assert from 'node:assert/strict'
import test from 'node:test'
import { timeEntryDeleteConfirmation } from '../src/timeEntryDeleteConfirmation.ts'

function inZone(zone, action) {
  const previous = process.env.TZ; process.env.TZ = zone
  try { action() } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous }
}
const entry = { taskId: 8, startedAt: '2026-10-06T00:00:00Z', endedAt: '2026-10-06T00:45:00Z' }
test('Delete identifies the saved 45-minute entry and its exact local endpoints', () => inZone('Asia/Tokyo', () => {
  const message = timeEntryDeleteConfirmation(entry, 'API study')
  for (const text of ['API study', '2026/10/06 09:00', '2026/10/06 09:45', '45\u5206', '\u3053\u306e\u6642\u9593\u8a18\u9332\u306e\u307f', '\u5143\u306b\u623b\u305b\u307e\u305b\u3093']) assert(message.includes(text), text)
}))
test('Cross-midnight confirmation includes both dates and the full 75 minutes', () => inZone('Asia/Tokyo', () => {
  const message = timeEntryDeleteConfirmation({ ...entry, startedAt: '2026-10-06T14:30:00Z', endedAt: '2026-10-06T15:45:00Z' }, 'API study')
  for (const text of ['2026/10/06 23:30', '2026/10/07 00:45', '1\u6642\u959315\u5206']) assert(message.includes(text), text)
}))
test('Missing/blank Task display falls back to the existing Task ID without inventing a Task', () => {
  for (const title of [undefined, '', '  ']) assert(timeEntryDeleteConfirmation(entry, title).includes('\u30bf\u30b9\u30af 8'))
})
test('Duration follows elapsed time and minute flooring across a DST fallback', () => inZone('America/New_York', () => {
  const message = timeEntryDeleteConfirmation({ ...entry, startedAt: '2026-11-01T05:30:30Z', endedAt: '2026-11-01T06:45:29Z' }, 'DST record')
  for (const text of ['2026/11/01 01:30', '2026/11/01 01:45', '1\u6642\u959314\u5206']) assert(message.includes(text), text)
}))
