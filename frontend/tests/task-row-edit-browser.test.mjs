import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openBrowser } from './browser.mjs'

test('TaskRow shares editing contracts in Tasks and Project Cards (API memory mock only)', { timeout: 240000 }, async t => {
  const b = await openBrowser(); t.after(() => b.close())
  const artifacts = await mkdtemp(path.join(tmpdir(), 'task-row-contract-'))
  const tags = [1, 2, 3].map(id => ({ id, name: 'Tag ' + id, color: '#368AD8' }))
  const projects = [{ id: 1, name: 'Project 1', color: '#368AD8', taskCount: 3, completedCount: 0, estimatedMinutes: 180, actualMinutes: 90 }]
  const initial = [1, 2, 3].map(id => ({ id, title: 'Task ' + id, status: 'NOT_STARTED', completed: false, projectId: 1, projectName: 'Project 1', tags, estimatedMinutes: 60, actualMinutes: 30, priority: 'HIGH', startDate: null, deadline: '2026-10-20', createdAt: '2026-10-01', updatedAt: '2026-10-01' }))
  let tasks = structuredClone(initial), reject = false, hold = false, held = false, release
  const errors = [], writes = [], metrics = []
  t.after(async () => {
    if (release) release()
    await writeFile(path.join(artifacts, 'metrics.json'), JSON.stringify({ metrics, writes, errors }, null, 2))
  })
  b.listeners.push(message => {
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method !== 'Fetch.requestPaused') return
    const { request, requestId } = message.params, url = new URL(request.url), pathname = url.pathname
    void (async () => {
      if (url.origin === new URL(b.url).origin) return b.send('Fetch.continueRequest', { requestId })
      assert.equal(url.hostname, 'localhost'); assert.equal(url.port, '8000', 'All Backend traffic is mocked')
      if (request.method === 'OPTIONS') return b.fulfill(requestId, {})
      if (request.method !== 'GET') {
        const body = JSON.parse(request.postData)
        writes.push({ method: request.method, path: pathname, body })
        assert.equal(request.method, 'PUT'); assert.equal(pathname, '/tasks/1')
        assert.equal(Object.keys(body).length, 1, 'Each edit saves only its attribute')
        assert(['title', 'estimatedMinutes', 'status', 'priority'].includes(Object.keys(body)[0]))
        if (hold) { await new Promise(resolve => { release = resolve; held = true }); release = undefined; held = false }
        if (reject) return b.fulfill(requestId, { detail: 'Controlled save failure' }, 500)
        Object.assign(tasks[0], body)
        if ('status' in body) tasks[0].completed = body.status === 'COMPLETED'
        return b.fulfill(requestId, tasks[0])
      }
      let data = []
      if (pathname === '/tasks') data = tasks
      else if (pathname === '/projects') data = projects
      else if (pathname === '/tags') data = tags
      else if (pathname === '/tasks/inbox') data = tasks
      else if (pathname === '/tasks/time/active') data = { taskId: null, running: false, startedAt: null }
      else if (/^\/tasks\/\d+$/.test(pathname)) data = tasks.find(task => task.id === Number(pathname.split('/')[2]))
      else if (pathname === '/reports/daily') data = { date: url.searchParams.get('date'), tasks: [], plannedOccupiedMinutes: 0, dailyEstimatedMinutes: 0, dailyActualMinutes: 0, dailyDifference: 0 }
      await b.fulfill(requestId, data)
    })().catch(error => { if (!/Invalid [Ii]nterceptionId|Invalid requestId/.test(error.message)) errors.push(String(error)) })
  })
  await b.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
  await b.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' })
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: '(()=>{const D=Date,n=' + Date.parse('2026-10-07T03:00:00Z') + ';window.Date=class extends D{constructor(...a){super(...(a.length?a:[n]))}static now(){return n}}})()' })
  const row = '[data-task-id="1"]', title = row + ' .task-title-input', estimate = row + ' .task-inline-estimate'
  const codes = { Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38, Home: 36, End: 35 }
  const key = async name => {
    await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: name, windowsVirtualKeyCode: codes[name], ...(name === 'Enter' ? { text: '\r' } : {}) })
    await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: codes[name] })
  }
  const exists = selector => 'document.querySelector(' + JSON.stringify(selector) + ')'
  const input = async (selector, value) => b.evaluate('(()=>{const e=' + exists(selector) + ';e.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(e,' + JSON.stringify(value) + ');e.dispatchEvent(new Event("input",{bubbles:true}))})()')
  const bring = selector => b.evaluate(exists(selector) + '.scrollIntoView({block:"center",inline:"nearest"})')
  const origin = selector => b.evaluate('(()=>{const e=' + exists(selector) + ',r=e.getBoundingClientRect(),c=getComputedStyle(e);return {x:r.left+parseFloat(c.borderLeftWidth)+parseFloat(c.paddingLeft),height:r.height,row:e.closest(".task-table-row").getBoundingClientRect().height}})()')
  const begin = async selector => {
    await bring(selector + ' > button'); const before = await origin(selector + ' > button')
    await b.click(selector + ' > button'); await b.until(exists(selector + ' > input'), 'Inline input')
    const after = await origin(selector + ' > input')
    assert(Math.abs(before.x - after.x) < 1, 'Display and input text origins match')
    assert.equal(after.height, 40); assert.equal(after.row, before.row)
  }
  const finished = selector => b.until(exists(selector + ' > button') + ' && !' + exists(selector + ' > button') + '.disabled', 'Save finished')
  const edit = async (selector, value, blur = false) => {
    await begin(selector); await input(selector + ' > input', value)
    if (blur) await b.evaluate(exists(selector + ' > input') + '.blur()'); else await key('Enter')
    await finished(selector)
  }
  const focused = selector => b.until('document.activeElement === ' + exists(selector), 'Focus returns to ' + selector)
  const choose = async (trigger, option) => {
    await bring(trigger); await b.click(trigger); await b.click(option)
    await b.until(exists(trigger) + '?.getAttribute("aria-expanded")==="false" && !' + exists(trigger) + '.disabled', 'Picker save')
    await focused(trigger)
  }
  const pointClick = async (cell, edge) => {
    await bring(cell)
    const point = await b.evaluate('(()=>{const r=' + exists(cell) + '.getBoundingClientRect();return {x:' + (edge === 'left' ? 'r.left+2' : 'r.right-2') + ',y:r.top+r.height/2}})()')
    await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  }
  for (const width of [1920, 1024, 768, 601, 600, 375]) for (const screen of ['tasks', 'project']) await t.test(screen + ' at ' + width + 'px: geometry, save, validation, retry, keyboard and pending', async () => {
    tasks = structuredClone(initial); reject = false; hold = false
    await b.send('Emulation.setDeviceMetricsOverride', { width, height: 1080, deviceScaleFactor: 1, mobile: false })
    await b.navigate(); await b.until('document.querySelector(".icon-rail")', 'Navigation')
    await b.click('.icon-rail [aria-label="' + (screen === 'tasks' ? '\u30bf\u30b9\u30af' : '\u30d7\u30ed\u30b8\u30a7\u30af\u30c8') + '"]')
    if (screen === 'project') { await b.until('document.querySelector(".project-card-open")', 'Project card'); await b.click('.project-card-open') }
    await b.until(exists(title + ' > button'), 'Task rows')
    await b.until('document.querySelector(".app-layout").getAnimations().every(a=>a.playState!=="running")', 'Layout settled')
    const start = writes.length
    const layout = await b.evaluate('(' + (() => {
      const row = document.querySelector('[data-task-id="1"]'), table = document.querySelector('.task-table-scroll'), header = document.querySelector('.task-table-header')
      const rect = e => { const r = e.getBoundingClientRect(); return { width: r.width, height: r.height } }
      return { overflow: document.documentElement.scrollWidth > innerWidth, viewport: table.clientWidth, content: table.scrollWidth, columns: getComputedStyle(row).gridTemplateColumns.split(' ').map(parseFloat), header: getComputedStyle(header).display, row: rect(row), name: rect(row.querySelector('.task-table-name')), tag: rect(row.querySelector('.task-table-tags')), pills: [...row.querySelectorAll(':is(.task-status-trigger,.task-priority-pill) > .shared-pill')].map(rect), tagCount: row.querySelectorAll('.tag-chip:not(.tag-overflow)').length, record: row.querySelector('[data-label="\u8a18\u9332"]').textContent }
    }).toString() + ')()')
    metrics.push({ width, screen, ...layout })
    assert.equal(layout.overflow, false)
    assert.equal(layout.header, width > 600 ? 'grid' : 'none')
    assert.deepEqual(layout.pills, [{ width: 80, height: 32 }, { width: 80, height: 32 }])
    assert.equal(layout.tagCount, screen === 'tasks' ? 1 : 2)
    assert.equal(layout.record, screen === 'tasks' ? '30m' : '30\u5206')
    if (width > 600) {
      assert.equal(layout.columns.length, screen === 'tasks' ? 10 : 8)
      assert(layout.columns[1] >= 220)
      if (screen === 'project') assert(layout.columns[2] >= 144)
      assert.equal(layout.content > layout.viewport, width !== 1920)
    } else assert(layout.content <= layout.viewport + (screen === 'tasks' ? 8 : 1), 'Cards retain the measured baseline overflow limit')
    await bring(row)
    const shot = await b.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    await writeFile(path.join(artifacts, width + '-' + screen + '.png'), Buffer.from(shot.data, 'base64'))

    for (const edge of ['left', 'right']) {
      await pointClick(row + ' .task-table-name', edge); await b.until(exists(title + ' > input'), 'Whole name Cell hit area')
      const height = await b.evaluate(exists(row) + '.getBoundingClientRect().height')
      assert.equal(height, layout.row.height)
      await input(title + ' > input', 'Cancelled'); await key('Escape'); await finished(title); await focused(title + ' > button')
      assert.equal(tasks[0].title, 'Task 1')
    }
    await edit(title, '  Renamed  '); assert.equal(tasks[0].title, 'Renamed')
    await edit(title, 'Blur saved', true); assert.equal(tasks[0].title, 'Blur saved')
    await begin(title); await input(title + ' > input', '   ')
    let before = writes.length; await key('Enter'); await b.until(exists(title + ' [role=alert]'), 'Title validation')
    assert.equal(writes.length, before); assert.equal(await b.evaluate(exists(title + ' > input') + '.value'), '   ')
    await key('Escape'); await finished(title)

    for (const [value, minutes, blur] of [['2.5h', 150, false], ['30m', 30, true], ['', null, true]]) {
      before = writes.length; await edit(estimate, value, blur)
      assert.equal(tasks[0].estimatedMinutes, minutes); assert.equal(writes.length, before + 1)
      assert.deepEqual(writes.at(-1), { method: 'PUT', path: '/tasks/1', body: { estimatedMinutes: minutes } })
    }
    for (const value of ['0', '-1h', 'abc', '2:30']) {
      await begin(estimate); await input(estimate + ' > input', value)
      before = writes.length; await key('Enter'); await b.until(exists(estimate + ' [role=alert]'), 'Duration validation')
      assert.equal(writes.length, before); assert.equal(tasks[0].estimatedMinutes, null)
      assert.equal(await b.evaluate(exists(estimate + ' > input') + '.value'), value)
      await key('Escape'); await finished(estimate); await focused(estimate + ' > button')
    }
    for (const [selector, value, attribute, expected] of [[title, 'Retry title', 'title', 'Retry title'], [estimate, '2h 30m', 'estimatedMinutes', 150]]) {
      reject = true; before = writes.length; const old = tasks[0][attribute]
      await begin(selector); await input(selector + ' > input', value); await key('Enter')
      await b.until(exists(selector + ' [role=alert]'), 'Failed draft stays visible')
      assert.equal(writes.length, before + 1); assert.equal(tasks[0][attribute], old)
      assert.equal(await b.evaluate(exists(selector + ' > input') + '.value'), value)
      reject = false; await focused(selector + ' > input'); await key('Enter'); await finished(selector); assert.equal(tasks[0][attribute], expected)
      assert.equal(writes.length, before + 2); await focused(selector + ' > button')
    }
    hold = true; before = writes.length; await begin(title); await input(title + ' > input', 'Pending title'); await key('Enter')
    const deadline = Date.now() + 12000
    while (!held && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    assert(held, 'Mock write reached the pending gate')
    assert.equal(await b.evaluate(exists(title + ' > input') + '.disabled'), true)
    assert.equal(await b.evaluate(exists(row + ' .task-status-trigger') + '.disabled'), true)
    await key('Enter'); await b.evaluate(exists(title + ' > input') + '.blur()')
    assert.equal(writes.length, before + 1)
    hold = false; release(); await finished(title); assert.equal(writes.length, before + 1); assert.equal(tasks[0].title, 'Pending title')

    const status = row + ' .task-status-trigger', priority = row + ' .task-priority-pill'
    await bring(status); await b.click(status)
    assert.equal(await b.evaluate('document.querySelectorAll(".task-table-status [role=menuitemradio]").length'), 3)
    await key('ArrowDown'); await key('Escape'); await focused(status)
    assert.equal(tasks[0].status, 'NOT_STARTED')
    await choose(status, row + ' .task-table-status [data-value=COMPLETED]')
    assert.equal(tasks[0].completed, true); assert.deepEqual(writes.at(-1).body, { status: 'COMPLETED' })
    await choose(status, row + ' .task-table-status [data-value=NOT_STARTED]'); assert.equal(tasks[0].completed, false)
    for (const value of ['MEDIUM', 'LOW', '']) {
      await choose(priority, row + ' [data-priority="' + value + '"]')
      assert.equal(tasks[0].priority, value || null); assert.deepEqual(writes.at(-1).body, { priority: value || null })
    }
    await b.click(priority); await key('Home'); await key('ArrowDown'); await key('Enter')
    await b.until('!' + exists(row + ' .priority-popup'), 'Keyboard selection saves')
    assert.equal(tasks[0].priority, 'MEDIUM'); await focused(priority)
    for (const [trigger, option, attribute] of [[status, row + ' .task-table-status [data-value=IN_PROGRESS]', 'status'], [priority, row + ' [data-priority=HIGH]', 'priority']]) {
      reject = true; before = writes.length; const old = tasks[0][attribute]
      await b.click(trigger); await b.click(option); await b.until(exists(row + ' .shared-picker-popup [role=alert]'), 'Failed Picker stays open')
      assert.equal(writes.length, before + 1); assert.equal(tasks[0][attribute], old)
      reject = false; await focused(option); await key('Enter'); await b.until(exists(trigger) + '?.getAttribute("aria-expanded")==="false"', 'Keyboard Picker retry saves')
      assert.equal(writes.length, before + 2); await focused(trigger)
    }
    before = writes.length
    for (const [trigger, popup] of [[row + ' .tag-picker-trigger', '.tag-picker-popup'], [row + ' summary', '.task-row-menu[open]']]) {
      await bring(trigger); await b.click(trigger); await b.until(exists(popup), 'Other control works')
      await key('Escape'); await b.until('!' + exists(popup), 'Other control closes')
    }
    assert.equal(writes.length, before, 'Opening other Cells never updates a Task')
    assert.equal(await b.evaluate('document.querySelector(".task-editor-panel[open],.task-detail,.task-detail-popover")'), null)
    assert.deepEqual(tasks[1], initial[1]); assert.deepEqual(tasks[2], initial[2])
    assert.deepEqual(tasks[0].tags, tags); assert.equal(tasks[0].projectId, 1); assert.equal(tasks[0].deadline, '2026-10-20')
    assert(writes.length > start)
  })
  assert.deepEqual(errors, [])
  console.log('TaskRow screenshots and computed geometry: ' + artifacts)
})
