import assert from 'node:assert/strict'
import test from 'node:test'
import { openBrowser } from './browser.mjs'

test('Entry Calendar Escape preserves its parent draft and save contract (API mocks, no DB)', { timeout: 120000 }, async t => {
  const b = await openBrowser(); t.after(() => b.close())
  const project = { id: 1, name: 'Calendar project', color: '#368AD8', taskCount: 1, actualMinutes: 30 }
  const task = { id: 1, title: 'Calendar record', projectId: 1, projectName: project.name, tags: [], status: 'IN_PROGRESS', completed: false, actualMinutes: 30, estimatedMinutes: 60 }
  let entry = { id: 1, taskId: 1, projectIdSnapshot: 1, startedAt: '2026-10-06T04:00:00.000Z', endedAt: '2026-10-06T04:30:00.000Z' }, reject = false
  const writes = [], errors = []
  await b.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' })
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{const D=Date,now=${Date.parse('2026-10-07T16:00:00+09:00')};window.Date=class extends D{constructor(...a){super(...(a.length?a:[now]))}static now(){return now}}})()` })
  b.listeners.push(message => {
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method !== 'Fetch.requestPaused') return
    const { request, requestId } = message.params, url = new URL(request.url)
    void (async () => {
      assert.equal(url.hostname, 'localhost'); assert.equal(url.port, '8000')
      if (request.method === 'OPTIONS') return b.fulfill(requestId, {})
      if (request.method !== 'GET') {
        const input = JSON.parse(request.postData); writes.push({ method: request.method, path: url.pathname, input })
        assert.equal(request.method, 'PATCH'); assert.equal(url.pathname, '/time-entries/1')
        if (reject) return b.fulfill(requestId, { detail: 'Controlled save failure' }, 500)
        entry = { ...entry, ...input }; return b.fulfill(requestId, entry)
      }
      let data = []
      if (url.pathname === '/tasks' || url.pathname === '/tasks/inbox') data = [task]
      else if (url.pathname === '/projects') data = [project]
      else if (url.pathname === '/tasks/1') data = task
      else if (url.pathname === '/tasks/1/time-entries') data = [entry]
      else if (url.pathname === '/tasks/time/active') data = { taskId: null, startedAt: null, running: false }
      else if (url.pathname === '/reports/daily') data = { date: url.searchParams.get('date'), tasks: [] }
      await b.fulfill(requestId, data)
    })().catch(error => errors.push(String(error)))
  })
  await b.send('Fetch.enable', { patterns: [{ urlPattern: 'http://localhost:8000/*', requestStage: 'Request' }] })
  await b.navigate(); await b.until('!!document.querySelector(".home-view-switch") && !!document.querySelector(".calendar-grid-content")', 'Home ready')
  await b.click('.home-view-switch button:last-child')
  const row = '[data-entry-id="1"]', end = row + ' input[aria-label="\u7d42\u4e86\u6642\u523b"]'
  await b.until(`!!document.querySelector(${JSON.stringify(row)})`, 'Entry ready')
  const key = async name => {
    const windowsVirtualKeyCode = name === 'Enter' ? 13 : 27
    await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: name, windowsVirtualKeyCode, ...(name === 'Enter' ? { text: '\r' } : {}) })
    await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode })
  }
  const edit = async () => { await b.click(row + ' .entry-time-control > button'); await b.until(`!!document.querySelector(${JSON.stringify(end)})`, 'Editing') }
  const setEnd = async value => b.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(end)});e.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  const focus = async selector => b.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`)
  const frames = () => b.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  const pointer = async selector => {
    await b.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',inline:'nearest'})`); await frames()
    const point = await b.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return{x,y,hit:e.contains(document.elementFromPoint(x,y))}})()`)
    assert(point.hit, 'Calendar trigger must receive the real pointer')
    for (const type of ['mousePressed', 'mouseReleased']) await b.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, x: point.x, y: point.y })
  }
  const closed = () => b.until(`!document.querySelector(${JSON.stringify(end)})`, 'Parent closed explicitly')
  for (const endpoint of ['start', 'end']) for (const origin of ['date', 'time']) for (const method of ['mouse', 'keyboard']) {
    await t.test(`${endpoint} Calendar from ${origin} focus opened by ${method} consumes only the first Escape`, async () => {
      await edit(); await setEnd('13:45')
      const date = row + ` input[name="${endpoint}Date"]`, trigger = row + ` .date-input:has(input[name="${endpoint}Date"]) .deadline-calendar-trigger`
      const before = writes.length
      await focus(origin === 'date' ? date : end)
      if (method === 'mouse') await pointer(trigger)
      else { await focus(trigger); await key('Enter') }
      await b.until(`document.querySelector(${JSON.stringify(trigger)})?.getAttribute('aria-expanded')==='true'`, 'Target Calendar opened')
      assert.equal(await b.evaluate(`document.querySelectorAll(${JSON.stringify(row + ' .deadline-calendar')}).length`), 1)
      await key('Escape'); await b.until(`!document.querySelector(${JSON.stringify(row + ' .deadline-calendar')})`, 'Only Calendar closed')
      assert.equal(await b.evaluate(`document.querySelector(${JSON.stringify(end)})?.value`), '13:45')
      assert.equal(await b.evaluate(`document.activeElement===document.querySelector(${JSON.stringify(date)})`), true)
      await frames(); assert.equal(writes.length, before, 'Opening/closing Calendar must not save')
      await focus(end); await key('Escape'); await closed(); await frames()
      assert.equal(writes.length, before); assert.equal(entry.endedAt, '2026-10-06T04:30:00.000Z')
    })
  }
  await t.test('Save failure and Calendar dismissal retain the draft, then Enter saves exactly once', async () => {
    await edit(); await setEnd('13:45'); reject = true; const before = writes.length
    await key('Enter'); await b.until('document.querySelector(".time-entry-log-row [role=alert]")?.textContent.includes("Controlled")', 'Failed draft retained')
    await b.until(`!document.querySelector(${JSON.stringify(end)}).disabled`, 'Failure released pending guard')
    await pointer(row + ' .date-input:has(input[name="endDate"]) .deadline-calendar-trigger')
    await b.until('!!document.querySelector(".deadline-calendar")', 'Calendar reopened after failure'); await key('Escape')
    assert.equal(await b.evaluate(`document.querySelector(${JSON.stringify(end)})?.value`), '13:45')
    assert.equal(writes.length, before + 1)
    reject = false; await focus(end); await key('Enter'); await closed(); await frames()
    assert.equal(writes.length, before + 2)
    assert.deepEqual(writes.at(-1), { method: 'PATCH', path: '/time-entries/1', input: { startedAt: '2026-10-06T04:00:00.000Z', endedAt: '2026-10-06T04:45:00.000Z' } })
  })
  assert.deepEqual(errors, [])
})
