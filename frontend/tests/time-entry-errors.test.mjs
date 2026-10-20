import assert from 'node:assert/strict'
import test from 'node:test'
import { timeEntryOverlapMessage } from '../src/timeEntryErrors.ts'

test('TimeEntry overlap detail maps to a readable message without swallowing other API conflicts', () => {
  assert.equal(timeEntryOverlapMessage('この時間帯には別の実績があります'), 'この時間帯にはすでに記録があります。重ならない時間を指定してください。')
  for (const detail of [null, undefined, {}, 'Only one task can be timed at a time', 'Task not found']) {
    assert.equal(timeEntryOverlapMessage(detail), undefined)
  }
})
