import test from 'node:test'
import { sidebarCollapseAcceptance } from './sidebar-collapse-acceptance.mjs'

test('Common Sidebar collapse preserves layout, navigation and data on a guarded temporary DB', { timeout: 240000 }, async t => {
  await sidebarCollapseAcceptance(t)
})
