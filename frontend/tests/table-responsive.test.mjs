import test from 'node:test'
import { sidebarCollapseAcceptance } from './sidebar-collapse-acceptance.mjs'

test('44C-3 responsive Task tables, top sidebar toggles and reference Nav Rail on isolated Test DB', { timeout: 240000 }, async t => {
  await sidebarCollapseAcceptance(t, undefined, { responsive: true })
})
