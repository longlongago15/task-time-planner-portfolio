import assert from 'node:assert/strict'
import test from 'node:test'
import { parseTaskPeriod, taskPeriodText } from '../src/taskPeriod.ts'
import { parseDateInput } from '../src/dateParser.ts'

for (const value of ['20261012', '2026/10/12', '2026-10-12', '1012', '10/12']) {
  test(`Task period accepts ${value} without changing strict date inputs`, () => {
    assert.deepEqual(parseTaskPeriod(value, 2026), { startDate: null, deadline: '2026-10-12' })
  })
}
test('Range preserves dates, validates ordering and allows equality', () => {
  assert.deepEqual(parseTaskPeriod('10/12 - 10/20', 2026), { startDate: '2026-10-12', deadline: '2026-10-20' })
  assert.deepEqual(parseTaskPeriod('2026-10-12 - 2026-10-12'), { startDate: '2026-10-12', deadline: '2026-10-12' })
  assert.throws(() => parseTaskPeriod('10/20 - 10/12', 2026))
  assert.deepEqual(parseTaskPeriod(''), { startDate: null, deadline: null })
})
for (const value of ['2026/13/40', '20260230', 'abc']) test(`Invalid ${value} is rejected`, () => assert.throws(() => parseTaskPeriod(value, 2026)))
test('Display is compact, equal dates collapse and start-only data remains readable', () => {
  assert.equal(taskPeriodText(null, '2026-10-20'), '10/20')
  assert.equal(taskPeriodText('2026-10-12', '2026-10-20'), '10/12 - 10/20')
  assert.equal(taskPeriodText('2026-10-20', '2026-10-20'), '10/20')
  assert.equal(taskPeriodText('2026-10-12', null), '10/12')
  assert.equal(taskPeriodText(null, null), '')
  assert.throws(() => parseDateInput('1012'), 'Existing DateInput remains strict without opt-in')
})
