import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { captureScenarioDatabase, isolateScenarios } from './scenario-fixture.mjs'
import { startMetadataBackend } from './metadata-backend.mjs'
import { runInNewContext } from 'node:vm'

test('Scenario snapshots reject the repository and restore only the guarded temporary DB', { timeout: 60000 }, async t => {
  const { directory, python, api } = await startMetadataBackend(t)
  await assert.rejects(captureScenarioDatabase(fileURLToPath(new URL('../../', import.meta.url)), python), { code: 'ERR_ASSERTION' })
  const initial = await api('/tasks', { title: 'Initial isolated fixture' })
  const before = await api('/tasks')
  const restore = await captureScenarioDatabase(directory, python)
  await api('/projects', { name: 'Temporary mutation' })
  await api('/tasks', { title: 'Temporary Task' })
  await api('/tasks/time/start', { taskId: initial.id })
  assert.equal((await api('/tasks/time/active')).running, true)
  await restore()
  assert.deepEqual(await api('/tasks'), before)
  assert.deepEqual(await api('/projects'), [])
  assert.deepEqual(await api('/tasks/time/active'), { taskId: null, running: false, startedAt: null })
  await restore() // Restoring is repeatable; IDs/schema and data remain identical.
  assert.deepEqual(await api('/tasks'), before)
})

test('Scenario cleanup preserves assertion failures, drains requests and resets UI/Active using a protocol test double', { timeout: 60000 }, async t => {
  const { directory, python, api } = await startMetadataBackend(t)
  const task = await api('/tasks', { title: 'Failure-path fixture' })
  const state = { modal: false, filters: [], held: false }
  const context = { innerWidth: 1600, innerHeight: 1100, location: { protocol: 'http:', href: 'http://test/' }, localStorage: { clear() {} }, sessionStorage: { clear() {} } }
  const b = {
    listeners: [],
    evaluate: async expression => runInNewContext(expression, context),
    until: async expression => assert(runInNewContext(expression, context)),
    navigate: async () => { context.location.href = 'http://test/'; context.location.protocol = 'http:' },
    send: async (method, params) => {
      if (method === 'Page.navigate') { context.location.href = params.url; context.location.protocol = 'about:'; state.modal = false; state.filters = [] }
      if (method === 'Fetch.fulfillRequest') { assert(state.held, 'Release exactly one pending request'); state.held = false }
    },
  }
  const hooks = {}
  await isolateScenarios({ beforeEach: fn => { hooks.before = fn }, afterEach: fn => { hooks.after = fn }, after: fn => t.after(fn) }, {
    browser: b, directory, python,
    reset: async () => { if (state.held) await b.send('Fetch.fulfillRequest', { requestId: 'held-test-request' }) },
  })
  const original = new assert.AssertionError({ message: 'Original business assertion is preserved' })
  await assert.rejects(async () => {
    await hooks.before({ name: 'Intentional failure-path probe' })
    try {
      state.modal = true; state.filters.push('COMPLETED'); state.held = true
      b.listeners.forEach(listener => listener({ method: 'Fetch.requestPaused', params: { requestId: 'held-test-request' } }))
      await api('/tasks/time/start', { taskId: task.id })
      throw original
    } finally { await hooks.after({ diagnostic: message => assert(message.includes('cleanup complete')) }) }
  }, error => error === original)
  assert.deepEqual(state, { modal: false, filters: [], held: false })
  assert.equal((await api('/tasks/time/active')).running, false)
  await hooks.before({ name: 'Independent case after failure' })
  try {
    assert.deepEqual(state, { modal: false, filters: [], held: false })
    assert.deepEqual(await api('/tasks'), [task])
  } finally { await hooks.after({ diagnostic: message => assert(message.includes('cleanup complete')) }) }
})
