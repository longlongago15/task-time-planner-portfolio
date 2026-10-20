import assert from 'node:assert/strict'
import test from 'node:test'
import { openBrowser } from './browser.mjs'
import { createMockRequestLifecycle } from './mock-request-lifecycle.mjs'

const q = selector => 'document.querySelector(' + JSON.stringify(selector) + ')'
test('Entry saves retain one request, draft, retry and focus across Enter and real outside blur (mock API)', { timeout: 180000 }, async t => {
  const b = await openBrowser(), network = createMockRequestLifecycle(b)
  const day = '2026-10-07', row = '[data-entry-id="2"]', tag = row + ' .tag-picker-trigger', end = row + ' input[aria-label="\u7d42\u4e86\u6642\u523b"]'
  const writes = [], errors = [], pending = new Set(), releases = []
  const state = { status: 200, hold: false }
  let task, entry
  const reset = () => {
    task = { id: 1, title: 'Entry save', projectId: 1, projectName: 'Project', tags: [{ id: 1, name: 'First' }], status: 'IN_PROGRESS', completed: false, priority: null, deadline: null, estimatedMinutes: 60, actualMinutes: 30 }
    entry = { id: 2, taskId: 1, projectIdSnapshot: 1, startedAt: day + 'T04:00:00.000Z', endedAt: day + 'T04:30:00.000Z' }
    state.status = 200; state.hold = false; writes.length = 0
  }
  reset()
  await b.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' })
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{const D=Date,n=${Date.parse(day+'T16:00:00+09:00')};window.Date=class extends D{constructor(...a){super(...(a.length?a:[n]))}static now(){return n}}})()` })
  const listener = message => {
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method !== 'Fetch.requestPaused') return
    const { request } = message.params, url = new URL(request.url)
    const operation = (async () => {
      assert.equal(url.origin, 'http://localhost:8000')
      if (request.method === 'OPTIONS') return network.fulfill(message.params, {})
      if (request.method !== 'GET') {
        const input = JSON.parse(request.postData)
        writes.push({ method: request.method, path: url.pathname, input })
        assert(['PUT','PATCH'].includes(request.method))
        assert.equal(url.pathname, request.method === 'PUT' ? '/tasks/1' : '/time-entries/2')
        if (state.hold) await new Promise(resolve => releases.push(resolve))
        if (state.status !== 200) return network.fulfill(message.params, { detail: 'Controlled save failure' }, state.status)
        if (request.method === 'PUT') { assert.deepEqual(Object.keys(input), ['tagIds']); task = { ...task, tags: input.tagIds.map(id => ({ id, name: id === 1 ? 'First' : 'Second' })) }; return network.fulfill(message.params, task) }
        assert.deepEqual(Object.keys(input).sort(), ['endedAt','startedAt']); entry = { ...entry, ...input }; return network.fulfill(message.params, entry)
      }
      let data = []
      if (url.pathname === '/tasks' || url.pathname === '/tasks/inbox') data = [task]
      else if (url.pathname === '/tasks/1') data = task
      else if (url.pathname === '/tasks/1/time-entries') data = [entry]
      else if (url.pathname === '/projects') data = [{ id: 1, name: 'Project', color: '#368AD8' }]
      else if (url.pathname === '/tags') data = [{ id: 1, name: 'First' }, { id: 2, name: 'Second' }]
      else if (url.pathname === '/tasks/time/active') data = { taskId: null, running: false, startedAt: null }
      else if (url.pathname === '/reports/daily') data = { date: day, tasks: [], actualMinutes: 30 }
      await network.fulfill(message.params, data)
    })()
    const tracked = operation.catch(error => errors.push(String(error))).finally(() => pending.delete(tracked))
    pending.add(tracked)
  }
  b.listeners.push(listener)
  const drain = async () => { while (pending.size) await Promise.all([...pending]) }
  t.after(async () => {
    try { for (const release of releases.splice(0)) release(); await drain(); await network.dispose(); assert.deepEqual(errors, []) }
    finally { b.listeners.splice(b.listeners.indexOf(listener), 1); await b.close() }
  })
  await b.send('Fetch.enable', { patterns: [{ urlPattern: 'http://localhost:8000/*', requestStage: 'Request' }] })
  t.beforeEach(async () => {
    for (const release of releases.splice(0)) release()
    await drain(); reset(); await b.navigate()
    await b.until(q('.home-view-switch'), 'Home ready'); await b.click('.home-view-switch button:last-child')
    await b.until(q(row), 'Entry ready')
  })
  t.afterEach(async () => { state.hold = false; for (const release of releases.splice(0)) release(); await drain() })
  const key = async name => { for (const type of ['keyDown','keyUp']) await b.send('Input.dispatchKeyEvent', { type, key: name, code: name, windowsVirtualKeyCode: name === 'Enter' ? 13 : 27 }) }
  const closed = () => b.until('!'+q(row+' .tag-picker')+' && !'+q(end), 'Row closed')
  const frames = () => b.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  const failed = async selector => {
    await b.until(q(row+' [role=alert]')+' && '+q(row)+'.getAttribute("aria-busy")==="false"', 'Failure retained and pending released')
    await b.until('document.activeElement==='+q(selector)+' && !'+q(selector)+'.disabled', 'Original control automatically regains Focus')
  }
  const editTag = async () => {
    await b.click(row+' [data-label="\u30bf\u30b0"] > button'); await b.until(q(row+' .tag-picker-popup'), 'Tags open')
    await b.evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(row+' .tag-picker-options label')})).find(e=>e.textContent.includes('Second')).querySelector('input').click()`)
    await b.until('!'+q(tag)+'.disabled', 'Tag draft selection settled')
    await b.click(tag); await b.until('!'+q(row+' .tag-picker-popup'), 'Tag popup closed')
    await b.evaluate(q(tag)+'.focus()')
  }
  const editTime = async () => {
    await b.click(row+' .entry-time-control > button'); await b.until(q(end), 'Time editor')
    await b.evaluate(`(()=>{const e=${q(end)};e.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'13:45');e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  }
  const outsidePointer = async () => {
    const point = await b.evaluate(`(()=>{const e=document.querySelector('.home-view-switch button:last-child'),r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,hit:e.contains(document.elementFromPoint(x,y))}})()`)
    assert(point.hit)
    for (const type of ['mousePressed','mouseReleased']) await b.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 })
  }
  await t.test('Enter 500 retains Tag draft and Focus; a single Escape cancels with no resave', async () => {
    await editTag(); state.status = 500; await key('Enter'); await failed(tag); await frames()
    assert.deepEqual(writes, [{ method: 'PUT', path: '/tasks/1', input: { tagIds: [1,2] } }])
    assert.deepEqual(task.tags.map(tag => tag.id), [1]); assert(await b.evaluate(q(tag)+'.textContent.includes("Second")'))
    await key('Escape'); await closed(); await frames(); assert.equal(writes.length, 1)
  })
  await t.test('Enter retry and a later separate edit each save once with unchanged PUT payload', async () => {
    await editTag(); state.status = 500; await key('Enter'); await failed(tag)
    state.status = 200; await key('Enter'); await closed(); assert.equal(writes.length, 2); assert.deepEqual(task.tags.map(tag => tag.id), [1,2])
    await editTag(); await key('Enter'); await closed(); assert.equal(writes.length, 3); assert.deepEqual(task.tags.map(tag => tag.id), [1])
  })
  await t.test('Real mouse outside blur 500 restores the original Tag trigger and Enter can retry', async () => {
    await editTag(); state.status = 500; await outsidePointer(); await failed(tag); await frames()
    assert.equal(writes.length, 1); assert.deepEqual(task.tags.map(tag => tag.id), [1])
    state.status = 200; await key('Enter'); await closed(); assert.equal(writes.length, 2); assert.deepEqual(task.tags.map(tag => tag.id), [1,2])
  })
  await t.test('Enter 409 preserves interval draft, original record and one PATCH before Escape', async () => {
    await editTime(); state.status = 409; await key('Enter'); await failed(end); await frames()
    assert.deepEqual(writes, [{ method: 'PATCH', path: '/time-entries/2', input: { startedAt: day+'T04:00:00.000Z', endedAt: day+'T04:45:00.000Z' } }])
    assert.equal(entry.endedAt, day+'T04:30:00.000Z'); assert.equal(await b.evaluate(q(end)+'.value'), '13:45')
    await key('Escape'); await closed(); assert.equal(writes.length, 1)
  })
  await t.test('Real outside blur 500 retains time draft; a subsequent genuine blur succeeds', async () => {
    await editTime(); state.status = 500; await outsidePointer(); await failed(end); assert.equal(writes.length, 1)
    assert.equal(await b.evaluate(q(end)+'.value'), '13:45'); state.status = 200
    await outsidePointer(); await closed(); assert.equal(writes.length, 2); assert.equal(entry.endedAt, day+'T04:45:00.000Z')
  })
  await t.test('Held Enter rejects further Enter/Escape while pending, then restores retry and Focus', async () => {
    await editTag(); state.hold = true; state.status = 500; await key('Enter')
    await b.until(q(tag)+'.disabled && '+q(row)+'.getAttribute("aria-busy")==="true"', 'Pending disables controls')
    assert.equal(writes.length, 1)
    await b.evaluate(`for(const key of ['Enter','Escape'])${q(tag)}.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}))`)
    assert.equal(writes.length, 1); assert(await b.evaluate(q(row+' .tag-picker')+'!==null'))
    state.hold = false; assert.equal(releases.length, 1); releases.shift()(); await failed(tag); await frames(); assert.equal(writes.length, 1)
    state.status = 200; await key('Enter'); await closed(); assert.equal(writes.length, 2)
  })
})
