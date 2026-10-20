import assert from 'node:assert/strict'
import test from 'node:test'
import { acceptsDateDraft, parseDateInput } from '../src/dateParser.ts'
import { parseDeadline, deadlineCalendarDate } from '../src/deadline.ts'

test('Shared deadline / schedule parser normalizes slash, ISO and eight digits including leap dates', () => {
  for (const [input, output] of [['20261008','2026-10-08'], ['2026/10/8','2026-10-08'], ['2026/1/8','2026-01-08'], ['2026-10-08','2026-10-08'], ['20000229','2000-02-29'], ['21001231','2100-12-31']]) {
    assert.equal(parseDateInput(input), output); assert.equal(parseDeadline(input), output)
  }
})
test('Compact and separated invalid dates, five-digit years and out-of-range years cannot save', () => {
  for (const input of ['20261','202610','00801008','00021008','00201008','19991231','21010101','100001008','20261301','20260230','20260001','20261000','20261032','21000229','10000/10/08','20261/10/08','2026/10-08']) {
    assert.throws(() => parseDateInput(input)); assert.throws(() => parseDeadline(input))
  }
})
test('Typing preserves partial year/month/day and bounds separated years at four digits', () => {
  for (const draft of ['','2','20','202','2026','20261','202610','2026100','20261008','2026/1','2026/10','2026/10/1','2026/10/10']) assert(acceptsDateDraft(draft))
  for (const draft of ['20261/','20261/10/8','2026/100','2026/10/100','202610080','2026a']) assert.equal(acceptsDateDraft(draft), false)
  const today = new Date(2026,9,9)
  for (const draft of ['','20261','00801008','20260230']) assert.equal(deadlineCalendarDate(draft,today),today)
  assert.equal(deadlineCalendarDate('20261008',today).getDate(),8)
})
