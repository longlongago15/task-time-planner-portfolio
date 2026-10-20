import assert from 'node:assert/strict'
import test from 'node:test'
import { parseDeadline, deadlineCalendarDate } from '../src/deadline.ts'

test('Deadline strict parsing accepts variable month/day width, leap days and inclusive year limits', () => {
  for (const [text, expected] of [['2026/10/8', '2026-10-08'], ['2026/10/08', '2026-10-08'], ['2026/1/10', '2026-01-10'], ['2000/2/29', '2000-02-29'], ['2100/12/31', '2100-12-31'], ['', null]]) assert.equal(parseDeadline(text), expected)
})
test('Incomplete, malformed, impossible and out-of-range deadlines never parse', () => {
  for (const text of ['1', '2026/10/', '0080/10/08', '0002/01/01', '0020/10/08', '999/01/01', '10000/10/10', '202610/10/10', '1999/12/31', '2101/01/01', '2026/00/10', '2026/13/10', '2026/02/30', '2026/10/00', '2026/10/32', '2100/2/29', '2026/10-08', '2026/10/08junk']) assert.throws(() => parseDeadline(text), /2000〜2100/)
})
test('Invalid and empty drafts open the current month; only a valid deadline supplies the calendar date', () => {
  const today = new Date(2026, 9, 8)
  for (const text of ['', '2026/1', '0080/10/08', '202610/10/10', '2026/02/30']) assert.equal(deadlineCalendarDate(text, today), today)
  assert.equal(deadlineCalendarDate('2027/2/10', today).getFullYear(), 2027)
  assert.equal(deadlineCalendarDate('2027/2/10', today).getMonth(), 1)
})
