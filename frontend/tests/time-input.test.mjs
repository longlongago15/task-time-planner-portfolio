import assert from 'node:assert/strict'
import test from 'node:test'
import { parseTimeInput } from '../src/timeInputParser.ts'

for (const [input, expected] of [['1516', '15:16'], ['0915', '09:15'], ['915', '09:15'], ['15:16', '15:16'], ['001', '00:01'], ['2359', '23:59'], ['', '']]) {
  test(`Schedule time draft ${JSON.stringify(input)} normalizes to ${JSON.stringify(expected)}`, () => assert.equal(parseTimeInput(input), expected))
}
for (const input of ['2560', 'abcd', '2400', '12:60', '15', '9:15', '15160']) {
  test(`Invalid Schedule time ${JSON.stringify(input)} is rejected`, () => assert.throws(() => parseTimeInput(input)))
}
