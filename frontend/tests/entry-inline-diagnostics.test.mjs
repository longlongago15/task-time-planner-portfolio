import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { startEntryInlineDiagnostics } from './entry-inline-diagnostics.mjs'

function fakeBrowser(send, cleanupError) {
  let evaluation = 0
  return { listeners: [], send, async evaluate() {
    if (evaluation++ === 0) return { pageNow: 0 }
    if (cleanupError) throw cleanupError
    return { events: [{ time: 1, phase: 'keydown:capture', key: 'Escape', state: { busy: 'false', pickerOpen: false, editorOpen: true } }], dropped: 0, finalState: { editorOpen: false }, removedListeners: 8, observerDisconnected: true }
  } }
}

test('Entry diagnostics preserve command arguments/promise and pair request IDs without bodies', async () => {
  const calls = [], response = Promise.resolve({ original: true })
  const send = function (...args) { calls.push(args); return response }
  const b = fakeBrowser(send), diagnostic = await startEntryInlineDiagnostics(b)
  assert.deepEqual(calls, [], 'Diagnostic setup dispatches no input, response or navigation command')
  const params = { requestId: 'fetch-1', responseCode: 500, body: 'excluded body' }
  assert.equal(b.send('Fetch.fulfillRequest', params), response)
  assert.deepEqual(calls, [['Fetch.fulfillRequest', params]])
  // Existing fixture handlers may send before the diagnostic listener sees the event.
  b.listeners[0]({ method: 'Fetch.requestPaused', params: { requestId: 'fetch-1', networkId: 'network-1', request: { url: 'http://localhost:8000/tasks/1', method: 'PUT', postData: 'private fixture body' } } })
  const file = await diagnostic.finish(), trace = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(await diagnostic.finish(), file, 'Cleanup is idempotent')
  assert.equal(b.send, send); assert.equal(b.listeners.length, 0)
  assert.deepEqual(trace.cleanup, { listenerRemoved: true, sendRestored: true })
  assert.equal(trace.timeline.find(e => e.phase === 'mock-response-command').networkId, 'network-1')
  assert.equal(JSON.stringify(trace).includes('private fixture body'), false)
  assert.equal(JSON.stringify(trace).includes('excluded body'), false)
  assert.equal(trace.page.removedListeners, 8)
  assert.equal(trace.page.observerDisconnected, true)
})

test('Entry diagnostics keep live transport rejection and never resend input', async () => {
  const error = new Error('CDP transport failed'), response = Promise.reject(error); response.catch(() => {})
  let calls = 0
  const b = fakeBrowser(() => { calls++; return response }), diagnostic = await startEntryInlineDiagnostics(b)
  const actual = b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape' })
  assert.equal(actual, response); await assert.rejects(actual, value => value === error)
  const trace = JSON.parse(await readFile(await diagnostic.finish(), 'utf8'))
  assert.equal(calls, 1); assert.equal(trace.timeline.filter(e => e.phase === 'key-command').length, 1)
})

test('Entry diagnostics restore CDP hooks even when page snapshot cleanup fails', async () => {
  const send = () => Promise.resolve(), existing = () => {}
  const b = fakeBrowser(send, new Error('page context lost')); b.listeners.push(existing)
  const diagnostic = await startEntryInlineDiagnostics(b)
  await assert.rejects(diagnostic.finish(), /diagnostic cleanup failed.*page context lost/)
  assert.equal(b.send, send); assert.deepEqual(b.listeners, [existing])
})
