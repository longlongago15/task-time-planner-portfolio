import test from 'node:test'
import { tableCalendarUiAcceptance } from './table-calendar-ui-acceptance.mjs'

test('Task tables fill Cards; status cells edit chips; Calendar groups two lanes per date with project tints', { timeout: 180000 }, async t => {
  await tableCalendarUiAcceptance(t, new URL('../../docs/screenshots/home-final/', import.meta.url))
})
