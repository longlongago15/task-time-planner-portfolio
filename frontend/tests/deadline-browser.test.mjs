import test from 'node:test'
import assert from 'node:assert/strict'
import { openBrowser } from './browser.mjs'
import { startMetadataBackend } from './metadata-backend.mjs'

test('Deadline real pointer blur and Escape probe', async t => {
  const { base, api } = await startMetadataBackend(t)
  const task = await api('/tasks', { title: 'Blur probe', deadline: '2026-10-10' })
  const browser = await openBrowser(); t.after(() => browser.close())
  const requests = [], errors = []
  browser.listeners.push(message => {
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method !== 'Fetch.requestPaused') return
    const { requestId, request } = message.params
    void (async () => {
      if (request.method === 'OPTIONS') return browser.fulfill(requestId, {})
      requests.push({ method: request.method, url: request.url })
      const url = new URL(request.url), response = await fetch(base + url.pathname + url.search, { method: request.method, ...(request.postData ? { headers: { 'Content-Type': 'application/json' }, body: request.postData } : {}) })
      await browser.fulfill(requestId, await response.json(), response.status)
    })().catch(error => { if (!/Invalid [Ii]nterception|Invalid requestId/.test(error.message)) errors.push(String(error)) })
  })
  await browser.send('Fetch.enable', { patterns: [{ urlPattern: 'http://localhost:8000/*', requestStage: 'Request' }] })
  await browser.navigate(); await browser.until('document.querySelector(".icon-rail")', 'Loaded'); await browser.click('.icon-rail [aria-label="タスク"]')
  await browser.until('document.querySelector(".task-table-row")', 'Row loaded')
  const edit = async value => {
    await browser.click('.task-period-input > button')
    await browser.evaluate(`(()=>{const e=document.querySelector('.task-period-input input');e.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`)
  }
  await t.test('Pointer blur persists the complete draft', async () => {
    await edit('2026/11/10')
    const point = await browser.evaluate('(()=>{const r=document.querySelector(".task-search input").getBoundingClientRect();return {x:r.x+20,y:r.y+20};})()')
    for (const type of ['mousePressed', 'mouseReleased']) await browser.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point })
    await browser.until('!document.querySelector(".task-period-input[data-inline-editing]")', 'Closed after blur')
    assert.equal((await api(`/tasks/${task.id}`)).deadline, '2026-11-10')
  })
  await t.test('Escape discards the draft without saving it', async () => {
    const before = (await api(`/tasks/${task.id}`)).deadline
    const count = requests.filter(r => r.method === 'PUT').length
    await edit('2026/12/10'); await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', windowsVirtualKeyCode: 27 })
    await browser.until('!document.querySelector(".task-period-input[data-inline-editing]")', 'Escape closed')
    await browser.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
    assert.equal(requests.filter(r => r.method === 'PUT').length, count)
    assert.equal((await api(`/tasks/${task.id}`)).deadline, before)
  })
  await t.test('Invalid pointer Blur keeps the draft and error visible, and unchanged Blur sends no write', async () => {
    const count = requests.filter(r => r.method === 'PUT').length
    await edit('0080/10/08')
    const point = await browser.evaluate('(()=>{const r=document.querySelector(".task-search input").getBoundingClientRect();return {x:r.x+20,y:r.y+20};})()')
    for (const type of ['mousePressed', 'mouseReleased']) await browser.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point })
    await browser.until('document.querySelector(".task-period-input [role=alert]")', 'Blur error remains visible')
    assert.equal(await browser.evaluate('document.querySelector(".task-period-input input").value'), '0080/10/08')
    assert.equal(requests.filter(r => r.method === 'PUT').length, count)
    await browser.evaluate('document.querySelector(".task-period-input input").focus()')
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', windowsVirtualKeyCode: 27 })
    await edit('2026/11/10')
    await browser.evaluate('document.querySelector(".task-period-input input").blur()')
    await browser.until('!document.querySelector(".task-period-input[data-inline-editing]")', 'Unchanged deadline closed')
    assert.equal(requests.filter(r => r.method === 'PUT').length, count)
  })
  assert.deepEqual(errors, [])
})
