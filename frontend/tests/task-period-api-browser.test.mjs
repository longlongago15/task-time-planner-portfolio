import assert from 'node:assert/strict'
import test from 'node:test'
import { Script, runInNewContext } from 'node:vm'
import { openBrowser } from './browser.mjs'
import { startMetadataBackend } from './metadata-backend.mjs'

test('Task Period Calendar persists through real API and page reload', { timeout: 120000 }, async t => {
  const real = process.env.PERIOD_REAL_API
  assert(!real || real === 'http://localhost:8000', 'Only the explicitly approved local development API is allowed')
  const environment = real ? { base: real } : await startMetadataBackend(t)
  const api = async (route, body, method = 'GET') => {
    const response = await fetch(environment.base + route, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) })
    assert(response.ok, `${method} ${route}: ${response.status}`)
    return response.json()
  }
  // Own exactly one disposable Task. Never update/delete pre-existing Tasks.
  const title = `Period UI verification ${Date.now()}`
  const task = await api('/tasks', { title }, 'POST')
  if (real) t.after(async () => { await api(`/tasks/${task.id}`, undefined, 'DELETE') })
  const b = await openBrowser(); t.after(() => b.close())
  const failures = [], writes = []
  await b.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false })
  const fixedAt = Date.parse('2026-10-12T03:00:00Z')
  const nativeDate = Date
  const clockSource = `(()=>{const D=Date;window.Date=class extends D{constructor(...a){super(...(a.length?a:[${fixedAt}]))}static now(){return ${fixedAt}}}})()`
  new Script(clockSource) // Fail immediately on invalid injected JavaScript.
  const clockContext = { window: {}, Date }
  runInNewContext(clockSource, clockContext)
  assert.equal(clockContext.window.Date.now(), fixedAt)
  t.after(() => assert.equal(Date, nativeDate, 'No fixed clock survives test teardown'))
  assert.equal(Date, nativeDate, 'The fixed clock is confined to its Browser/context')
  assert.notEqual(Date.now(), fixedAt, 'The Node test clock remains real')
  await b.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' })
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: clockSource })
  b.listeners.push(message => {
    if (message.method === 'Runtime.exceptionThrown') failures.push(message.params.exceptionDetails)
    if (message.method !== 'Fetch.requestPaused') return
    const { request, requestId } = message.params
    void (async () => {
      if (request.method === 'OPTIONS') return b.fulfill(requestId, {})
      const url = new URL(request.url)
      if (request.method !== 'GET') {
        assert.equal(request.method, 'PUT'); assert.equal(url.pathname, `/tasks/${task.id}`)
        writes.push(JSON.parse(request.postData))
      }
      const response = await fetch(environment.base + url.pathname + url.search, { method: request.method, ...(request.postData ? { headers: { 'Content-Type': 'application/json' }, body: request.postData } : {}) })
      await b.fulfill(requestId, await response.json(), response.status)
    })().catch(error => { if (!/Invalid InterceptionId|Invalid interceptionId|Invalid requestId/.test(String(error))) failures.push(String(error)) })
  })
  await b.send('Fetch.enable', { patterns: [{ urlPattern: 'http://localhost:8000/*', requestStage: 'Request' }] })
  const row = `[data-task-id="${task.id}"]`, editor = row + ' .task-period-input'
  const enter = () => b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  const load = async () => {
    await b.navigate()
    assert.deepEqual(await b.evaluate('[Date.now(),new Date().toISOString(),new Date().getFullYear(),new Date().getMonth()+1,new Date().getDate(),new Date().getHours(),new Date().getTimezoneOffset()]'), [fixedAt,'2026-10-12T03:00:00.000Z',2026,10,12,12,-540])
    assert.deepEqual(await b.evaluate("[new Date('2026-10-11T14:59:59Z').getDate(),new Date('2026-10-11T15:00:00Z').getDate()]"), [11,12], 'Tokyo midnight changes the date at 15:00 UTC')
    await b.until('document.querySelector(".icon-rail [aria-label=タスク]")', 'Navigation ready')
    await b.click('.icon-rail [aria-label=タスク]'); await b.until(`document.querySelector('${editor} > button')`, 'Own Task ready')
  }
  await load()
  await t.test('Single date saves deadline only and survives reload', async () => {
    await b.click(editor + ' > button'); await b.click('[data-period-date="2026-10-15"]'); await enter()
    await b.until(`!document.querySelector('${editor} > input')`, 'Deadline saved')
    assert.deepEqual(writes.at(-1), { startDate: null, deadline: '2026-10-15' })
    await load()
    const saved = await api(`/tasks/${task.id}`)
    assert.equal(saved.startDate, null); assert.equal(saved.deadline, '2026-10-15')
    assert.equal(await b.evaluate(`document.querySelector('${editor} .task-period-relative').textContent`), 'あと3日')
  })
  await t.test('Reverse cross-year selection saves both dates and survives reload', async () => {
    await b.click(editor + ' > button')
    await b.click('.task-period-calendar [aria-label=翌月]'); await b.click('.task-period-calendar [aria-label=翌月]'); await b.click('.task-period-calendar [aria-label=翌月]')
    await b.click('[data-period-date="2027-01-08"]'); await b.click('.task-period-calendar [aria-label=前月]'); await b.click('[data-period-date="2026-12-04"]'); await enter()
    await b.until(`!document.querySelector('${editor} > input')`, 'Range saved')
    assert.deepEqual(writes.at(-1), { startDate: '2026-12-04', deadline: '2027-01-08' })
    await load()
    const saved = await api(`/tasks/${task.id}`)
    assert.equal(saved.startDate, '2026-12-04'); assert.equal(saved.deadline, '2027-01-08')
    assert.equal(await b.evaluate(`document.querySelector('${editor} .task-period-dates').textContent`), '12/04 - 01/08')
    assert.equal(await b.evaluate(`document.querySelector('${editor} .task-period-relative').textContent`), 'あと88日')
    assert(await b.evaluate(`(()=>{const root=document.querySelector('${editor}'),a=root.querySelector('.task-period-dates').getBoundingClientRect(),b=root.querySelector('.task-period-relative').getBoundingClientRect();return b.top>=a.bottom&&root.closest('.task-table-row').getBoundingClientRect().height===56})()`))
  })
  assert.deepEqual(failures, [])
})
