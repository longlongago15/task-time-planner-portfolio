import { isolateScenarios } from './scenario-fixture.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { openBrowser } from './browser.mjs'
import { createMockRequestLifecycle } from './mock-request-lifecycle.mjs'

test('Indigo Timer actions share Pending/canonical states and clocks (API mocks, no DB)', { timeout: 180000 }, async t => {
  const b = await openBrowser()
  const network = createMockRequestLifecycle(b)
  const pendingHandlers = new Set()
  let listener
  const day = '2026-10-07', now = Date.parse(`${day}T16:00:00+09:00`)
  const projects = [{ id: 1, name: 'Timer Project', color: '#368AD8', taskCount: 3, completedCount: 0, estimatedMinutes: 180, actualMinutes: 60 }]
  const tasks = [1, 2, 3].map(id => ({ id, title: `Timer Task ${id}`, projectId: 1, projectName: projects[0].name, status: 'IN_PROGRESS', completed: false, tags: [], priority: null, deadline: null, estimatedMinutes: 60, actualMinutes: 60 }))
  const blocks = [{ id: 2, taskId: 2, date: day, type: 'TIMED', startTime: '10:00:00', durationMinutes: 60 }, { id: 3, taskId: 3, date: day, type: 'TIME_UNSET', startTime: null, durationMinutes: null }]
  const entries = [{ id: 1, taskId: 1, projectIdSnapshot: 1, startedAt: `${day}T09:00:00+09:00`, endedAt: `${day}T10:00:00+09:00` }]
  let active = null, nextId = 10, fault = false, hold = false, held = null, externalAfterStart = false, inFlight = 0
  const reads = [], writes = [], errors = []
  t.after(async () => {
    try {
      if (held) { const action = held; held = null; await action() }
      while (pendingHandlers.size) await Promise.all([...pendingHandlers])
      await network.dispose()
      assert.deepEqual(errors, [])
    } finally {
      const index = b.listeners.indexOf(listener)
      if (index !== -1) b.listeners.splice(index, 1)
      await b.close()
    }
  })
  await b.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' })
  await b.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false })
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{const D=Date;window.__timerNow=${now};window.Date=class extends D{constructor(...a){super(...(a.length?a:[window.__timerNow]))}static now(){return window.__timerNow}};window.__timerTicks=new Map();const start=setInterval,stop=clearInterval;window.setInterval=(fn,ms,...args)=>{const id=start(fn,ms,...args);if(ms===1000)window.__timerTicks.set(id,fn);return id};window.clearInterval=id=>{window.__timerTicks.delete(id);stop(id)};window.confirm=()=>true})()` })
  listener = m => {
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails)
    if (m.method !== 'Fetch.requestPaused') return
    const { request } = m.params, url = new URL(request.url), path = url.pathname
    inFlight++
    const handling = (async () => {
      if (request.method === 'OPTIONS') return network.fulfill(m.params, {})
      if (request.method === 'POST' && path.startsWith('/tasks/time/')) {
        const input = JSON.parse(request.postData)
        assert.deepEqual(Object.keys(input), ['taskId'])
        writes.push({ path, taskId: input.taskId })
        const respond = async () => {
          if (fault) return network.fulfill(m.params, { detail: 'Controlled Timer conflict' }, 409)
          if (path.endsWith('/start')) {
            active = { taskId: input.taskId, running: true, startedAt: new Date(now).toISOString() }
            entries.push({ id: nextId++, taskId: input.taskId, projectIdSnapshot: 1, startedAt: active.startedAt, endedAt: null })
            await network.fulfill(m.params, active)
          } else {
            const entry = entries.find(e => e.endedAt === null)
            entry.endedAt = new Date(now + 60000).toISOString()
            active = null
            await network.fulfill(m.params, entry)
          }
        }
        if (hold) { held = respond; await new Promise(resolve => { const release = held; held = async () => { try { await release() } finally { resolve() } } }) }
        else await respond()
        return
      }
      assert.equal(request.method, 'GET', `No non-Timer writes: ${request.method} ${path}`)
      reads.push(path + url.search)
      let data = []
      if (path === '/tasks') data = tasks
      else if (path === '/projects') data = projects
      else if (path === '/tasks/time/active') {
        if (externalAfterStart && active) {
          externalAfterStart = false
          entries.find(e => e.endedAt === null).endedAt = new Date(now).toISOString()
          active = { taskId: 2, running: true, startedAt: new Date(now + 1000).toISOString() }
          entries.push({ id: nextId++, taskId: 2, projectIdSnapshot: 1, startedAt: active.startedAt, endedAt: null })
        }
        data = active ?? { taskId: null, running: false, startedAt: null }
      } else if (/^\/tasks\/\d+\/time-entries$/.test(path)) data = entries.filter(e => e.taskId === Number(path.split('/')[2]))
      else if (/^\/tasks\/\d+$/.test(path)) data = tasks.find(e => e.id === Number(path.split('/')[2]))
      else if (path === '/schedule-blocks') data = url.searchParams.has('taskId') ? blocks.filter(e => e.taskId === Number(url.searchParams.get('taskId'))) : blocks
      else if (path === '/reports/daily') data = { date: url.searchParams.get('date'), actualMinutes: 60, plannedOccupiedMinutes: 60, tasks: [] }
      await network.fulfill(m.params, data)
    })().catch(e => errors.push(String(e))).finally(() => { inFlight--; pendingHandlers.delete(handling) })
    pendingHandlers.add(handling)
  }
  b.listeners.push(listener)
  await b.send('Fetch.enable', { patterns: [{ urlPattern: 'http://localhost:8000/*', requestStage: 'Request' }] })
  await b.navigate()
  await b.until(`document.querySelector('[data-inbox-task-id="1"] .task-timer-button') && !document.querySelector('.global-top-timer .timer-play-button').disabled`, 'Timer ready')
  const inbox = '[data-inbox-task-id="1"] .task-timer-button'
  const global = '.global-top-timer .timer-play-button'
  const inspect = async selector => {
    // Inbox refresh can replace its DOM after the Timer request settles.
    // Measure a connected node atomically; retain every state/style assertion.
    await b.until(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),exists=e?.isConnected;if(!exists)return false;const c=getComputedStyle(e),r=e.getBoundingClientRect();window.__timerInspection = {state:e.dataset.timerState,label:e.getAttribute('aria-label'),pressed:e.getAttribute('aria-pressed'),busy:e.getAttribute('aria-busy'),disabled:e.disabled,bg:c.backgroundColor,color:c.color,image:c.backgroundImage,shadow:c.boxShadow,radius:c.borderRadius,width:r.width,height:r.height,spinner:!!e.querySelector('.timer-pending-indicator'),icon:e.querySelector('[data-icon]')?.dataset.icon};return true})()`, 'Mounted Timer inspection: '+selector)
    return b.evaluate('window.__timerInspection')
  }
  const settle = async () => {
    await b.until('!document.querySelector(".global-top-timer .timer-play-button").disabled', 'Timer operation settled')
    await b.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    await b.until('!document.querySelector("[data-timer-state=pending]")', 'No Pending presentation')
    await new Promise(resolve => { const poll = () => inFlight ? setTimeout(poll, 10) : resolve(); poll() })
  }
  const release = async () => { assert(held); const action = held; held = null; hold = false; await action(); await settle() }
  const navigate = async label => { await settle(); await b.click(`.icon-rail [aria-label="${label}"]`); await settle() }
  await settle()

  const initialEntries = structuredClone(entries)
  await isolateScenarios(t, { browser: b,
    reset: async () => {
      fault = hold = externalAfterStart = false
      if (held) { const action = held; held = null; await action() }
      if (await b.evaluate('location.protocol === "http:"')) await settle()
      active = null; nextId = 10; entries.splice(0, entries.length, ...structuredClone(initialEntries))
    },
    prepare: async name => {
      if (name.startsWith('Stop failure')) {
        active = { taskId: 1, running: true, startedAt: new Date(now).toISOString() }
        entries.push({ id: nextId++, taskId: 1, projectIdSnapshot: 1, startedAt: active.startedAt, endedAt: null })
      }
    }, ready: async name => {
      await b.until(`document.querySelector('[data-inbox-task-id="1"] .task-timer-button') && !document.querySelector('.global-top-timer .timer-play-button').disabled`, 'Independent Timer ready')
      await settle()
      await b.until('document.querySelector(".global-top-timer .timer-play-button").getAnimations().every(animation => animation.playState !== "running")', 'Initial Timer visual transition complete')
      if (name.startsWith('Project Active Entry')) {
        await navigate('\u30d7\u30ed\u30b8\u30a7\u30af\u30c8'); await b.until('document.querySelector(".project-card-open")', 'Project card ready'); await b.click('.project-card-open')
        await b.until('document.querySelector(".project-detail-panel .task-timer-button")', 'Project Task Timer ready')
      }
    },
  })
  await t.test('Default is flat Indigo; Global action is filled; Inbox click has no Editor/Drag side effect', async () => {
    const value = await inspect(inbox)
    assert.equal(value.bg, 'rgb(238, 242, 255)'); assert.equal(value.color, 'rgb(79, 70, 229)')
    assert.equal(value.icon, 'play'); assert.equal(value.label, 'Timer Task 1の計測を開始')
    assert.equal(value.pressed, 'false'); assert.equal(value.image, 'none'); assert.equal(value.shadow, 'none'); assert.equal(value.radius, '8px')
    assert.equal(value.width, value.height); assert.equal((await inspect(global)).bg, 'rgb(79, 70, 229)')
  })
  await t.test('Held Start immediately shows task-scoped Pending, then canonical Active; unchanged confirm refreshes once', async () => {
    hold = true
    const baseline = reads.filter(path => path === '/tasks').length
    await b.click(inbox)
    await b.until(`document.querySelector('[data-inbox-task-id="1"] [data-timer-state=pending]')`, 'Immediate Pending before response')
    assert.equal(active, null)
    const value = await inspect(inbox)
    assert(value.spinner && value.disabled); assert.equal(value.label, 'Timer Task 1の計測開始中'); assert.equal(value.pressed, 'false')
    assert.equal((await inspect(global)).state, 'pending')
    assert.equal(await b.evaluate(`!!document.querySelector('[data-schedule-block-id="2"] [data-timer-state=pending]')`), false)
    assert.equal(await b.evaluate('!!document.querySelector(".task-editor-panel,.task-detail,.schedule-block-dragging,.inbox-task-dragging")'), false)
    await release()
    assert.equal((await inspect(inbox)).pressed, 'true'); assert.equal((await inspect(inbox)).icon, 'stop')
    assert.equal((await inspect(inbox)).bg, 'rgb(79, 70, 229)'); assert.equal((await inspect(inbox)).color, 'rgb(255, 255, 255)')
    assert.equal(reads.filter(path => path === '/tasks').length - baseline, 1)
  })
  await t.test('Stop failure keeps canonical Active; successful Stop uses one refresh', async () => {
    hold = true; fault = true
    await b.click(inbox)
    await b.until(`document.querySelector('[data-inbox-task-id="1"] [data-timer-state=pending]')`, 'Stop Pending')
    assert.equal((await inspect(inbox)).label, 'Timer Task 1の計測停止中')
    await release(); fault = false
    assert.equal((await inspect(inbox)).state, 'active'); assert.equal(active.taskId, 1)
    const baseline = reads.filter(path => path === '/tasks').length
    await b.click(inbox); await settle()
    assert.equal(active, null); assert.equal((await inspect(inbox)).icon, 'play')
    assert.equal(reads.filter(path => path === '/tasks').length - baseline, 1)
  })
  await t.test('Start failure clears Pending and leaves the confirmed Default', async () => {
    hold = true; fault = true
    await b.click(inbox); await b.until('document.querySelector("[data-timer-state=pending]")', 'Failed Start Pending')
    await release(); fault = false
    assert.equal(active, null); assert.equal((await inspect(inbox)).state, 'default')
    assert.equal((await inspect(inbox)).bg, 'rgb(238, 242, 255)')
  })
  await t.test('External change after POST is reconciled and gets its own refresh', async () => {
    externalAfterStart = true
    const baseline = reads.filter(path => path === '/tasks').length
    await b.click(inbox); await settle()
    assert.equal(active.taskId, 2)
    assert.equal(reads.filter(path => path === '/tasks').length - baseline, 2)
    assert.equal((await inspect(inbox)).pressed, 'false')
    await b.click(global); await settle()
  })
  await t.test('Calendar TIMED, date-only, Actual and Month reuse the small Timer without opening Detail', async () => {
    for (const selector of ['[data-schedule-block-id="2"]', '[data-schedule-block-id="3"]', '.calendar-event.actual']) {
      await b.until(`document.querySelector(${JSON.stringify(selector + ' .task-timer-button')})`, 'Calendar Timer')
      const value = await inspect(selector + ' .task-timer-button')
      assert.equal(value.icon, 'play'); assert.equal(value.radius, '8px'); assert(value.width <= 24)
    }
    await b.click('[data-schedule-block-id="2"] .task-timer-button'); await settle()
    assert.equal(await b.evaluate('!!document.querySelector(".task-detail,.calendar-dialog,.schedule-block-dragging")'), false)
    await b.click('[data-schedule-block-id="2"] .task-timer-button'); await settle()
    await b.click('[aria-label="カレンダー表示"] button:last-child')
    await b.until('document.querySelector(".month-grid .task-timer-button")', 'Month Timer')
    assert.equal((await inspect('.month-grid .task-timer-button')).radius, '8px')
    await b.click('[aria-label="カレンダー表示"] button:nth-child(2)')
  })
  await t.test('Home List, Tasks and Project Tasks use the same Timer; hover/active-hover/focus/disabled retain semantics', async () => {
    await b.click('.home-view-switch button:last-child')
    await b.until('document.querySelector(".home-entry-list .task-timer-button")', 'List Timer')
    assert.equal((await inspect('.home-entry-list .task-timer-button')).width, 36)
    await navigate('タスク')
    const selector = '[data-task-id="1"] .task-timer-button'
    await b.until(`document.querySelector(${JSON.stringify(selector)})`, 'Task Timer')
    assert.equal((await inspect(selector)).width, 40)
    const hover = async () => { const point = await b.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`); await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }) }
    await hover(); await b.until(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).backgroundColor==='rgb(82, 107, 132)'`, 'Task blue-gray hover')
    await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
    await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
    await b.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`)
    assert.equal(await b.evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).outlineStyle`), 'solid')
    await b.click(selector); await settle(); await hover()
    await b.until(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).backgroundColor==='rgb(67, 56, 202)'`, 'Active Indigo hover')
    await b.click(selector); await settle()
    await navigate('プロジェクト'); await b.until('document.querySelector(".project-card-open")', 'Project card'); await b.click('.project-card-open')
    await b.until('document.querySelector(".project-detail-panel .task-timer-button")', 'Project Task Timer')
    assert.equal((await inspect('.project-detail-panel .task-timer-button')).width, 36)
  })
  await t.test('Project Active Entry uses the common clock and does not fetch on a tick', async () => {
    await b.click('.project-detail-panel [data-task-id="1"] .task-timer-button'); await settle()
    await b.click('.project-tabs button:nth-child(2)')
    await b.until('document.querySelector(".project-records [data-entry-id] .task-timer-button[aria-pressed=true]")', 'Project active record')
    const activeEntry = entries.find(entry => entry.endedAt === null)
    const selector = `.project-records [data-entry-id="${activeEntry.id}"] .entry-log-duration`
    const before = await b.evaluate(`document.querySelector(${JSON.stringify(selector)}).textContent`), count = reads.length
    await b.evaluate('window.__timerNow+=120000;window.__timerTicks.forEach(fn=>fn());undefined')
    await b.until(`document.querySelector(${JSON.stringify(selector)})?.textContent!==${JSON.stringify(before)}`, 'Active minutes update from clock')
    assert.equal(await b.evaluate(`document.querySelector(${JSON.stringify(selector)}).textContent`), '2分')
    assert.equal(reads.length, count)
    await b.click('.project-records .task-timer-button[aria-pressed=true]'); await settle()
  })
  await t.test('Reports Activity and Drawer reuse Timer; Demo uses neutral disabled and sends no writes', async () => {
    await navigate('レポート'); await b.click('#report-tab-activity')
    await b.until('document.querySelector(".report-activity .task-timer-button")', 'Reports Timer')
    assert.equal((await inspect('.report-activity .task-timer-button')).width, 36)
    await navigate('ホーム'); await b.click('.home-view-switch button:first-child')
    await b.until(`document.querySelector('[data-inbox-task-id="1"] .inbox-card-open')`, 'Inbox Editor trigger')
    await b.click('[data-inbox-task-id="1"] .inbox-card-open')
    await b.until('document.querySelector(".task-editor-panel[open] .task-timer-button")', 'Drawer Timer')
    assert.equal((await inspect('.task-editor-panel .task-timer-button')).width, 36)
    await b.click('.task-editor-panel .icon-close')
    await b.send('Page.navigate', { url: b.url + '/?reportDemo=1' })
    await b.until('document.querySelector(".icon-rail [aria-label=レポート]")', 'Demo Navigation')
    await navigate('レポート'); await b.click('#report-tab-activity')
    await b.until('document.querySelector("[data-report-demo]") && document.querySelector(".report-activity .task-timer-button")', 'Demo Activity')
    const baseline = writes.length, value = await inspect('.report-activity .task-timer-button')
    assert(value.disabled); assert.notEqual(value.color, 'rgb(79, 70, 229)'); assert.equal(value.bg, 'rgb(241, 245, 249)')
    await b.evaluate('document.querySelector(".report-activity .task-timer-button").click()')
    assert.equal(writes.length, baseline)
  })
  assert.deepEqual(errors, [])
})
