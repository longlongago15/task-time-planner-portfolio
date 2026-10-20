import test from 'node:test'
import { projectRecordsAcceptance } from './project-records-acceptance.mjs'

test('Project history edit/delete protects attribution and refreshes aggregates on an isolated DB', { timeout: 240000 }, async t => {
  await projectRecordsAcceptance(t)
})
