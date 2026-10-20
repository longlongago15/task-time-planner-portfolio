// CDP response ownership only; fixtures retain data, assertions and request routing.
export function createMockRequestLifecycle(browser, { cancellationTimeout = 1000 } = {}) {
  const canceled = new Set(), waiters = new Map(), requests = new Map(), pending = new Set(), errors = []
  const documents = new Map(), retired = new Set(), networkRequests = new Map()
  const obsolete = networkId => canceled.has(networkId) || retired.has(networkRequests.get(networkId)?.loaderId)
  const listener = message => {
    if (message.method === 'Network.requestWillBeSent') {
      const { requestId, loaderId, frameId } = message.params
      networkRequests.set(requestId, { loaderId, frameId })
    }
    if (message.method === 'Page.frameNavigated') {
      const { id, loaderId } = message.params.frame, previous = documents.get(id)
      if (previous && previous !== loaderId) retired.add(previous)
      documents.set(id, loaderId)
      // Chrome can invalidate a held interception on Document replacement without loadingFailed.
      for (const [networkId, waiting] of waiters) if (obsolete(networkId)) for (const finish of [...waiting]) finish(true)
    }
    if (message.method !== 'Network.loadingFailed') return
    const { requestId, canceled: wasCanceled } = message.params
    if (wasCanceled) canceled.add(requestId)
    const waiting = waiters.get(requestId)
    if (waiting) for (const finish of [...waiting]) finish(Boolean(wasCanceled))
  }
  browser.listeners.push(listener)
  const confirmedCancellation = networkId => {
    if (!networkId) return Promise.resolve(false)
    if (obsolete(networkId)) return Promise.resolve(true)
    return new Promise(resolve => {
      const finish = value => { clearTimeout(timer); waiters.get(networkId)?.delete(finish); if (!waiters.get(networkId)?.size) waiters.delete(networkId); resolve(value) }
      const timer = setTimeout(() => finish(false), cancellationTimeout)
      if (!waiters.has(networkId)) waiters.set(networkId, new Set())
      waiters.get(networkId).add(finish)
    })
  }
  const respond = (request, action) => {
    const operation = (async () => {
      const { requestId, networkId } = request
      if (requests.has(requestId)) throw new Error('Mock response already owned: ' + requestId)
      const record = { requestId, networkId, outcome: 'pending', attempts: 0 }
      requests.set(requestId, record)
      if (networkId && obsolete(networkId)) { record.outcome = 'canceled'; return }
      record.attempts = 1
      try { await action(); record.outcome = 'responded' }
      catch (error) {
        // An invalid ID alone is insufficient: require matching Network cancellation evidence.
        if (/Invalid .*nterception|Invalid requestId/.test(error.message) && await confirmedCancellation(networkId)) { record.outcome = 'canceled'; return }
        record.outcome = 'failed'
        throw error
      }
    })()
    const tracked = operation.catch(error => { errors.push(error) }).finally(() => pending.delete(tracked))
    pending.add(tracked)
    return operation
  }
  return {
    fulfill: (request, body, status = 200) => respond(request, () => browser.fulfill(request.requestId, body, status)),
    continue: request => respond(request, () => browser.send('Fetch.continueRequest', { requestId: request.requestId })),
    snapshot: () => [...requests.values()].map(record => ({ ...record })),
    async dispose() {
      try {
        while (pending.size) await Promise.all([...pending])
        if (errors.length) throw new AggregateError(errors, 'Mock request lifecycle failed')
      } finally {
        const index = browser.listeners.indexOf(listener)
        if (index !== -1) browser.listeners.splice(index, 1)
      }
    },
  }
}
