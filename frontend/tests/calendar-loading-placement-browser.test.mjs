import test from 'node:test'
import { calendarLoadingPlacementAcceptance } from './table-calendar-ui-acceptance.mjs'

test('Calendar Loading remains visible and never covers controls (API mocks)', { timeout: 240000 }, async t => {
  await calendarLoadingPlacementAcceptance(t)
})
