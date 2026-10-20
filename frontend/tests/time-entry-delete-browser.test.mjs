import assert from 'node:assert/strict'
import test from 'node:test'
import { openBrowser } from './browser.mjs'
import { startMetadataBackend } from './metadata-backend.mjs'

test('TimeEntry deletion identifies saved records and preserves other records and totals (guarded temporary DB)', { timeout: 150000 }, async t => {
  const { base, api } = await startMetadataBackend(t)
  assert.notEqual(new URL(base).port, '8000')
  const project = await api('/projects', { name: 'Delete audit project' })
  const task = await api('/tasks', { title: 'Multiple saved records', projectId: project.id, estimatedMinutes: 180 })
  const intervals = [['2026-10-06T00:00:00Z', '2026-10-06T00:45:00Z'], ['2026-10-06T14:30:00Z', '2026-10-06T15:45:00Z'], ['2026-10-06T04:00:00Z', '2026-10-06T04:30:00Z']]
  const entries = []
  for (const [startedAt, endedAt] of intervals) entries.push(await api('/time-entries', { taskId: task.id, startedAt, endedAt }))
  const [target, overnight, other] = entries, taskBefore = await api(`/tasks/${task.id}`)
  const b = await openBrowser(); t.after(() => b.close())
  const writes = [], errors = []
  let rejectDelete = false, holdDelete = false, release
  t.after(() => release?.())
  await b.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' })
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{const D=Date,now=${Date.parse('2026-10-07T12:00:00+09:00')};window.Date=class extends D{constructor(...a){super(...(a.length?a:[now]))}static now(){return now}}})()` })
  b.listeners.push(message => {
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method !== 'Fetch.requestPaused') return
    const { requestId, request } = message.params, url = new URL(request.url)
    void (async () => {
      assert(['localhost', '127.0.0.1'].includes(url.hostname)); assert.equal(url.port, '8000')
      if (request.method === 'OPTIONS') return b.fulfill(requestId, {})
      if (request.method !== 'GET') {
        writes.push({ method: request.method, path: url.pathname, payload: request.postData ?? null })
        assert.equal(request.method, 'DELETE'); assert.equal(url.pathname, `/time-entries/${target.id}`)
        if (rejectDelete) return b.fulfill(requestId, { detail: 'Controlled delete failure' }, 500)
        if (holdDelete) await new Promise(resolve => { release = resolve })
      }
      const response = await fetch(base + url.pathname + url.search, { method: request.method, ...(request.postData ? { headers: { 'Content-Type': 'application/json' }, body: request.postData } : {}) })
      await b.fulfill(requestId, await response.json(), response.status)
    })().catch(error => { if (!/Invalid [Ii]nterceptionId|Invalid requestId/.test(error.message)) errors.push(String(error)) })
  })
  await b.send('Fetch.enable', { patterns: [{ urlPattern: 'http://localhost:8000/*', requestStage: 'Request' }, { urlPattern: 'http://127.0.0.1:8000/*', requestStage: 'Request' }] })
  const row = id => `.project-records [data-entry-id="${id}"]`
  const history = () => api(`/tasks/${task.id}/time-entries`)
  const projectRecords = async () => {
    await b.until('!!document.querySelector(".icon-rail")', 'Navigation ready')
    await b.click('.icon-rail [aria-label="\u30d7\u30ed\u30b8\u30a7\u30af\u30c8"]')
    await b.until(`!!document.querySelector('.project-card[data-project-id="${project.id}"]')`, 'Project ready')
    await b.click(`.project-card[data-project-id="${project.id}"] .project-card-open`)
    await b.until('!!document.querySelector(".project-tabs")', 'Project detail ready')
    await b.click('.project-tabs button:nth-child(2)')
    await b.until(`!!document.querySelector(${JSON.stringify(row(other.id))})`, 'Saved records ready')
  }
  const confirm = async (selector, accept) => {
    let observe, timeout
    const dialog = new Promise((resolve, reject) => {
      observe = message => { if (message.method === 'Page.javascriptDialogOpening') resolve(message.params) }
      timeout = setTimeout(() => reject(new Error('Delete confirmation did not open')), 12000)
    })
    b.listeners.push(observe)
    const clicked = b.click(selector).then(() => null, error => error)
    try {
      const details = await dialog; await b.send('Page.handleJavaScriptDialog', { accept })
      const error = await clicked; if (error) throw error
      return details.message
    } finally { clearTimeout(timeout); b.listeners.splice(b.listeners.indexOf(observe), 1) }
  }
  const rowConfirm = async (id, accept) => { await b.click(row(id) + ' summary'); return confirm(row(id) + ' .entry-menu-options .danger', accept) }
  const checkMessage = (message, parts) => {
    for (const text of [task.title, ...parts, '\u3053\u306e\u6642\u9593\u8a18\u9332\u306e\u307f', '\u5143\u306b\u623b\u305b\u307e\u305b\u3093']) assert(message.includes(text), `Missing ${text}: ${message}`)
  }
  const totals = async (total, firstDay, nextDay) => {
    assert.equal((await api(`/tasks/${task.id}`)).actualMinutes, total)
    assert.equal((await api('/projects')).find(p => p.id === project.id).actualMinutes, total)
    assert.equal((await api('/reports/daily?date=2026-10-06&timezone=Asia/Tokyo')).dailyActualMinutes, firstDay)
    assert.equal((await api('/reports/daily?date=2026-10-07&timezone=Asia/Tokyo')).dailyActualMinutes, nextDay)
    assert.equal((await api('/reports/weekly?date=2026-10-06&timezone=Asia/Tokyo')).weeklyActualMinutes, total)
  }
  await b.navigate(); await projectRecords()
  await t.test('Cancelling a 45-minute record uses saved endpoints despite an unsaved 75-minute draft', async () => {
    await totals(150, 105, 45)
    await b.click(row(target.id) + ' .entry-time-control > button')
    const end = row(target.id) + ' input[aria-label="\u7d42\u4e86\u6642\u523b"]'
    await b.until(`!!document.querySelector(${JSON.stringify(end)})`, 'Draft opened')
    await b.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(end)});e.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'10:15');e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    const message = await rowConfirm(target.id, false)
    checkMessage(message, ['2026/10/06 09:00', '2026/10/06 09:45', '45\u5206'])
    assert(!message.includes('10:15')); assert.equal(writes.length, 0)
    assert.equal(await b.evaluate(`document.querySelector(${JSON.stringify(end)})?.value`), '10:15')
    assert.deepEqual((await history()).sort((a, b) => a.id - b.id), entries)
    await b.evaluate(`document.querySelector(${JSON.stringify(end)}).focus()`)
    await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', windowsVirtualKeyCode: 27 })
    await b.until(`!document.querySelector(${JSON.stringify(end)})`, 'Explicit draft discard')
    assert.equal(writes.length, 0)
  })
  await t.test('A different record on the same Task identifies the full cross-day 75 minutes', async () => {
    const message = await rowConfirm(overnight.id, false)
    checkMessage(message, ['2026/10/06 23:30', '2026/10/07 00:45', '1\u6642\u959315\u5206'])
    assert.equal(writes.length, 0); assert.equal((await history()).length, 3)
  })
  await t.test('Delete failure leaves the record, other entries, Snapshot and totals intact', async () => {
    rejectDelete = true; await rowConfirm(target.id, true)
    await b.until('document.querySelector(".project-records [role=alert]")?.textContent.includes("Controlled")', 'Delete failure shown')
    assert.equal(writes.length, 1); assert.deepEqual((await history()).find(e => e.id === target.id), target)
    await totals(150, 105, 45); rejectDelete = false
  })
  await t.test('Retry sends one DELETE while pending, removes only the selected Entry and refreshes totals', async () => {
    holdDelete = true; await rowConfirm(target.id, true)
    await b.until(`document.querySelector(${JSON.stringify(row(target.id))})?.getAttribute('aria-busy')==='true'`, 'Pending delete')
    const before = writes.length
    await b.evaluate(`(()=>{const button=document.querySelector(${JSON.stringify(row(target.id) + ' .entry-menu-options .danger')});button.click();button.click()})()`)
    assert.equal(writes.length, before); assert.equal(before, 2)
    holdDelete = false; release(); release = undefined
    await b.until(`!document.querySelector(${JSON.stringify(row(target.id))})`, 'Only target removed')
    await b.until('document.querySelector(".project-summary .time .project-progress-text")?.textContent.startsWith("1\u6642\u959345\u5206 /")', 'Project total refreshed')
    assert.equal(writes.length, 2)
    assert.deepEqual(writes, [{ method: 'DELETE', path: `/time-entries/${target.id}`, payload: null }, { method: 'DELETE', path: `/time-entries/${target.id}`, payload: null }])
    const remaining = await history(); assert.equal(remaining.length, 2)
    for (const saved of [overnight, other]) assert.deepEqual(remaining.find(e => e.id === saved.id), saved)
    const after = await api(`/tasks/${task.id}`)
    for (const field of ['id', 'title', 'projectId', 'status', 'estimatedMinutes']) assert.equal(after[field], taskBefore[field])
    await totals(105, 60, 45)
  })
  await t.test('Reload retains the other records and reduced totals', async () => {
    await b.navigate(true); await projectRecords()
    assert.equal(await b.evaluate('document.querySelectorAll(".project-records .time-entry-log-row").length'), 2)
    await totals(105, 60, 45); assert.equal(writes.length, 2)
  })
  await t.test('Calendar Actual confirmation describes the full saved entry rather than its visible day segment', async () => {
    await b.click('.icon-rail [aria-label="\u30db\u30fc\u30e0"]')
    const block = `.calendar-event.actual[data-time-entry-id="${overnight.id}"][data-date="2026-10-07"]`
    await b.until(`!!document.querySelector(${JSON.stringify(block)})`, 'Cross-day Actual segment')
    await b.click(block); await b.until('!!document.querySelector(".time-entry-dialog")', 'Actual details')
    const message = await confirm('.time-entry-dialog .actual-dialog-actions .danger', false)
    checkMessage(message, ['2026/10/06 23:30', '2026/10/07 00:45', '1\u6642\u959315\u5206'])
    assert.equal(writes.length, 2); assert.equal((await history()).length, 2)
    await b.click('.time-entry-dialog .icon-close')
  })
  assert.deepEqual(errors, [])
})
