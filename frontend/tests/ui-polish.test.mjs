import test from 'node:test'
import { sidebarCollapseAcceptance } from './sidebar-collapse-acceptance.mjs'
import { uiFoundationAcceptance } from './ui-foundation-acceptance.mjs'

test('44C-4 shared Sidebar and bounded Table regressions on isolated Test DB', { timeout: 240000 }, async t => {
  await sidebarCollapseAcceptance(t, undefined, { responsive: true })
})
test('44C-4 date inputs, cells, filled Folders, Calendar palette and Theme / Typography foundation', { timeout: 240000 }, async t => {
  await uiFoundationAcceptance(t)
})
