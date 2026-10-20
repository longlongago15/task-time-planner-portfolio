import assert from 'node:assert/strict'
import test from 'node:test'
import { parseDurationInput, formatDurationInput, formatCompactDuration } from '../src/durationInput.ts'

test('Task table Estimate and Record share compact h/m display', () => {
  assert.deepEqual([0, 30, 60, 90, 150].map(formatCompactDuration), ['0m', '30m', '1h', '1h 30m', '2h 30m'])
})

for (const [input, expected] of [['2h 30m',150],['2.5h',150],['150m',150],['2h',120],['30m',30],['2 h 30 m',150],['2H 30M',150],['2.5 h',150],['2h30m',150],['0.05h',3],['0.1h',6],['',null],['   ',null],['37',37],['0h 30m',30]]) {
  test(`duration input ${JSON.stringify(input)} becomes ${expected}`, () => assert.equal(parseDurationInput(input),expected))
}
for (const input of ['0m','0h','0','-30m','-2h','abc','2hours','2:30','2h 3','1.5','1.5m','0.01h','1h 30m junk','1e3m','9007199254740992m']) {
  test(`duration input ${JSON.stringify(input)} is rejected without rounding`, () => assert.throws(()=>parseDurationInput(input),/2h 30m/))
}
test('formatting saved minutes round trips and NULL remains unestimated', () => {
  for(const minutes of [1,30,60,150,345,720,1800])assert.equal(parseDurationInput(formatDurationInput(minutes)),minutes)
  assert.equal(formatDurationInput(null),'');assert.equal(formatCompactDuration(null),'未設定')
  assert.equal(formatCompactDuration(226),'3h 46m')
})
