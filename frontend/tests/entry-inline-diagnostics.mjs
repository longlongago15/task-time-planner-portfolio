import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Observation only: no focus, dispatch, fetch, waits, or changes to application state.
function installCollector(selector, limit) {
  const events = [], ids = new WeakMap(), handlers = []
  let sequence = 0, cursor = 0, dropped = 0, previousRow = null, lastMutation = ''
  const identify = node => {
    if (!node) return null
    if (!ids.has(node)) ids.set(node, ++sequence)
    return { node: ids.get(node), tag: node.tagName, id: node.id, class: typeof node.className === 'string' ? node.className : '', label: node.getAttribute?.('aria-label'), disabled: node.disabled, connected: node.isConnected }
  }
  const state = () => {
    const row = document.querySelector(selector), trigger = row?.querySelector('.tag-picker-trigger')
    const result = { row: identify(row), previousRow: identify(previousRow), active: identify(document.activeElement), busy: row?.getAttribute('aria-busy'), pickerOpen: !!row?.querySelector('.tag-picker-popup'), expanded: trigger?.getAttribute('aria-expanded'), trigger: identify(trigger), editorOpen: !!row?.querySelector('select,input,.project-picker,.tag-picker'), alerts: [...row?.querySelectorAll('[role=alert]') ?? []].map(node => node.textContent.slice(0, 250)) }
    previousRow = row ?? previousRow
    return result
  }
  const note = (phase, event, detail = {}) => {
    const value = { time: performance.now(), domain: 'page', phase, key: event?.key, target: identify(event?.target), defaultPrevented: event?.defaultPrevented, state: state(), ...detail }
    if (events.length < limit) events.push(value)
    else { events[cursor] = value; cursor = (cursor + 1) % limit; dropped++ }
  }
  for (const type of ['keydown', 'keyup', 'focusin', 'focusout']) {
    for (const capture of [true, false]) {
      const listener = event => {
        if ((type === 'keydown' || type === 'keyup') && !['Enter', 'Escape'].includes(event.key)) return
        note(type + (capture ? ':capture' : ':bubble'), event)
      }
      document.addEventListener(type, listener, { capture, passive: true })
      handlers.push([type, listener, capture])
    }
  }
  const observer = new MutationObserver(records => {
    const row = document.querySelector(selector)
    if (!records.some(record => row?.contains(record.target) || previousRow?.contains(record.target) || [...record.addedNodes, ...record.removedNodes].some(node => node.contains?.(row) || node.contains?.(previousRow)))) return
    const current = JSON.stringify(state())
    if (current !== lastMutation) { lastMutation = current; note('mutation', null, { types: [...new Set(records.map(record => record.type))], removed: records.flatMap(record => [...record.removedNodes]).filter(node => node.nodeType === 1).slice(0, 8).map(identify) }) }
  })
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'aria-expanded', 'aria-busy'] })
  note('installed')
  window.__entryEscapeDiagnostics = {
    stop() {
      observer.disconnect()
      for (const [type, listener, capture] of handlers) document.removeEventListener(type, listener, capture)
      note('final-snapshot')
      const finalState = state(), html = document.querySelector(selector)?.outerHTML ?? null
      const ordered = dropped ? [...events.slice(cursor), ...events.slice(0, cursor)] : events
      delete window.__entryEscapeDiagnostics
      return { events: ordered, dropped, finalState, finalHTML: html?.slice(0, 20000), htmlTruncated: (html?.length ?? 0) > 20000, removedListeners: handlers.length, observerDisconnected: true }
    },
  }
  return { pageNow: performance.now() }
}

export async function startEntryInlineDiagnostics(browser, { limit = 512 } = {}) {
  const origin = process.hrtime.bigint(), now = () => Number(process.hrtime.bigint() - origin) / 1e6
  const before = now()
  const installed = await browser.evaluate(`(${installCollector.toString()})('[data-entry-id="2"]',${limit})`)
  const after = now(), pageOffset = (before + after) / 2 - installed.pageNow
  const protocol = [], fetches = new Map(), requests = new Map()
  let dropped = 0, cursor = 0, finishing
  const record = (phase, detail) => {
    const value = { time: now(), domain: 'node', phase, ...detail }
    if (protocol.length < limit) protocol.push(value)
    else { protocol[cursor] = value; cursor = (cursor + 1) % limit; dropped++ }
  }
  const apiPath = url => { try { const u = new URL(url); return u.hostname === 'localhost' && u.port === '8000' ? u.pathname : null } catch { return null } }
  const listener = message => {
    const p = message.params
    if (message.method === 'Fetch.requestPaused') {
      const route = apiPath(p.request.url)
      if (route) { const value = { requestId: p.requestId, networkId: p.networkId, path: route, method: p.request.method }; fetches.set(p.requestId, value); record('Fetch.requestPaused', value) }
    }
    if (message.method === 'Network.requestWillBeSent') {
      const route = apiPath(p.request.url)
      if (route) { requests.set(p.requestId, route); record(message.method, { networkId: p.requestId, path: route, method: p.request.method, protocolTime: p.timestamp, initiator: p.initiator?.stack?.callFrames.slice(0, 16).map(frame => ({ functionName: frame.functionName, path: (() => { try { return new URL(frame.url).pathname } catch { return frame.url } })(), line: frame.lineNumber + 1, column: frame.columnNumber + 1 })) }) }
    }
    if (message.method === 'Network.responseReceived' && apiPath(p.response.url)) record(message.method, { networkId: p.requestId, path: apiPath(p.response.url), status: p.response.status, protocolTime: p.timestamp })
    if (['Network.loadingFinished', 'Network.loadingFailed'].includes(message.method) && requests.has(p.requestId)) record(message.method, { networkId: p.requestId, protocolTime: p.timestamp, canceled: p.canceled, error: p.errorText })
  }
  const send = browser.send
  function observedSend(method, params) {
    if (method === 'Input.dispatchKeyEvent') record('key-command', { type: params.type, key: params.key })
    if (method === 'Fetch.fulfillRequest') record('mock-response-command', { requestId: params.requestId, status: params.responseCode })
    // Preserve the original promise and error; do not introduce an awaited hop.
    return send.call(this, method, params)
  }
  browser.send = observedSend
  browser.listeners.push(listener)
  return {
    finish() {
      return finishing ??= (async () => {
        let page, diagnosticError
        try { page = await browser.evaluate('window.__entryEscapeDiagnostics.stop()') }
        catch (error) { diagnosticError = String(error) }
        finally {
          const index = browser.listeners.indexOf(listener)
          if (index !== -1) browser.listeners.splice(index, 1)
          if (browser.send === observedSend) browser.send = send
        }
        const directory = await mkdtemp(path.join(tmpdir(), 'task-entry-escape-trace-')), file = path.join(directory, 'trace.json')
        // The fixture can respond synchronously before this observer receives requestPaused.
        // Join metadata after collection so both listener orders retain the response command.
        const ordered = dropped ? [...protocol.slice(cursor), ...protocol.slice(0, cursor)] : protocol
        const nodeEvents = ordered.map(event => event.phase === 'mock-response-command' ? { ...fetches.get(event.requestId), ...event } : event)
        const timeline = [...nodeEvents, ...page?.events.map(event => ({ ...event, pageTime: event.time, time: event.time + pageOffset })) ?? []].sort((a, b) => a.time - b.time)
        await writeFile(file, JSON.stringify({ clock: { unit: 'ms', node: 'hrtime relative to diagnostic start', page: 'performance.now translated by midpoint calibration', pageOffset, calibrationUncertaintyMs: (after - before) / 2, protocolTime: 'raw CDP monotonic seconds; correlate by networkId' }, timeline, page, protocolDropped: dropped, diagnosticError, cleanup: { listenerRemoved: !browser.listeners.includes(listener), sendRestored: browser.send === send } }, null, 2))
        if (diagnosticError) throw new Error('Entry Escape diagnostic cleanup failed; trace: ' + file + ': ' + diagnosticError)
        return file
      })()
    },
  }
}
