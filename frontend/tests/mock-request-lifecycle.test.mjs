import assert from 'node:assert/strict'
import test from 'node:test'
import { createMockRequestLifecycle } from './mock-request-lifecycle.mjs'

const request = { requestId: 'fetch-1', networkId: 'network-1' }
const cancellation = canceled => ({ method: 'Network.loadingFailed', params: { requestId: request.networkId, canceled } })
function browser(fulfill = async () => {}) {
  return { listeners: [], calls: [], async fulfill(...args) { this.calls.push(args); return fulfill(...args) }, async send(...args) { this.calls.push(args) } }
}

test('Mock lifecycle preserves response body/status and unregisters its listener', async () => {
  const b = browser(), network = createMockRequestLifecycle(b)
  await network.fulfill(request, { detail: 'Validation' }, 409)
  assert.deepEqual(b.calls, [['fetch-1', { detail: 'Validation' }, 409]])
  assert.equal(network.snapshot()[0].outcome, 'responded'); await network.dispose(); assert.equal(b.listeners.length, 0)
})
test('Confirmed cancellation avoids sending to a known expired interception', async () => {
  const b = browser(), network = createMockRequestLifecycle(b)
  b.listeners[0](cancellation(true)); await network.fulfill(request, [])
  assert.deepEqual(b.calls, []); assert.equal(network.snapshot()[0].outcome, 'canceled'); await network.dispose()
})
test('Invalid ID is accepted only when matching cancellation arrives after the error', async () => {
  const b = browser(async () => { setImmediate(() => b.listeners[0](cancellation(true))); throw new Error('Invalid InterceptionId.') })
  const network = createMockRequestLifecycle(b)
  await network.fulfill(request, []); assert.equal(b.calls.length, 1); assert.equal(network.snapshot()[0].outcome, 'canceled'); await network.dispose()
})
test('Invalid ID without cancellation proof rejects and remains a lifecycle error', async () => {
  const b = browser(async () => { throw new Error('Invalid InterceptionId.') }), network = createMockRequestLifecycle(b, { cancellationTimeout: 20 })
  await assert.rejects(network.fulfill(request, []), /Invalid InterceptionId/)
  await assert.rejects(network.dispose(), e => e instanceof AggregateError && e.errors[0].message === 'Invalid InterceptionId.')
  assert.equal(b.listeners.length, 0)
})
test('Transport errors including CDP closed are never swallowed as cancellation', async () => {
  const b = browser(async () => { throw new Error('CDP connection closed') }), network = createMockRequestLifecycle(b)
  b.listeners[0](cancellation(false)); await assert.rejects(network.fulfill(request, []), /CDP connection closed/)
  await assert.rejects(network.dispose(), e => e.errors[0].message === 'CDP connection closed')
})
test('Duplicate ownership fails before a second Continue/fulfill command is sent', async () => {
  const b = browser(), network = createMockRequestLifecycle(b)
  await network.continue(request)
  await assert.rejects(network.fulfill(request, []), /already owned/)
  assert.deepEqual(b.calls, [['Fetch.continueRequest', { requestId: 'fetch-1' }]])
  await assert.rejects(network.dispose(), AggregateError)
})
test('Disposal drains a pending response before listener teardown without sleeps', async () => {
  let release; const gate = new Promise(resolve => { release = resolve })
  const b = browser(() => gate), network = createMockRequestLifecycle(b)
  const response = network.fulfill(request, []); let disposed = false
  const disposal = network.dispose().then(() => { disposed = true })
  await Promise.resolve(); assert.equal(disposed, false); assert.equal(b.listeners.length, 1)
  release(); await response; await disposal; assert.equal(disposed, true); assert.equal(b.listeners.length, 0)
})
test('Missing network ID cannot turn an Invalid ID into an accepted cancellation', async () => {
  const b = browser(async () => { throw new Error('Invalid requestId') }), network = createMockRequestLifecycle(b)
  await assert.rejects(network.fulfill({ requestId: 'no-network-id' }, []), /Invalid requestId/)
  await assert.rejects(network.dispose(), AggregateError)
})

test('Replacing the owning Document invalidates a held request even without loadingFailed', async () => {
  const b = browser(), network = createMockRequestLifecycle(b), event = b.listeners[0]
  event({ method: 'Page.frameNavigated', params: { frame: { id: 'frame', loaderId: 'old' } } })
  event({ method: 'Network.requestWillBeSent', params: { requestId: request.networkId, frameId: 'frame', loaderId: 'old' } })
  event({ method: 'Page.frameNavigated', params: { frame: { id: 'frame', loaderId: 'new' } } })
  await network.fulfill(request, []); assert.equal(b.calls.length, 0); assert.equal(network.snapshot()[0].outcome, 'canceled'); await network.dispose()
})
test('A new Document request before its Frame commit remains live, not implicitly canceled', async () => {
  const b = browser(), network = createMockRequestLifecycle(b), event = b.listeners[0]
  event({ method: 'Page.frameNavigated', params: { frame: { id: 'frame', loaderId: 'old' } } })
  event({ method: 'Network.requestWillBeSent', params: { requestId: request.networkId, frameId: 'frame', loaderId: 'new' } })
  await network.fulfill(request, []); assert.equal(b.calls.length, 1); assert.equal(network.snapshot()[0].outcome, 'responded'); await network.dispose()
})
