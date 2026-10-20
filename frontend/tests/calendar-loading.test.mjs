import assert from 'node:assert/strict'
import test from 'node:test'
import { openBrowser } from './browser.mjs'

test('Home Calendar retains its displayed view during navigation and failed refreshes (API mocks only)', { timeout: 120000 }, async t => {
  const browser = await openBrowser()
  t.after(() => browser.close())
  const today = '2026-10-15'
  const tasks = [{ id: 1, title: 'Retained calendar task', estimatedMinutes: 60, projectId: null, projectName: null,
    completed: false, status: 'IN_PROGRESS', completedAt: null, completedEstimateMinutes: null,
    actualMinutes: 60, differenceMinutes: 0, actualStartedAt: `${today}T00:00:00Z` }]
  const days = (start, end) => {
    const values = [], date = new Date(`${start}T12:00:00Z`)
    while (date.toISOString().slice(0, 10) <= end) {
      values.push(date.toISOString().slice(0, 10)); date.setUTCDate(date.getUTCDate() + 1)
    }
    return values
  }
  const entries = days('2026-09-01', today).map((date, index) => ({
    id: index + 1, taskId: 1, projectIdSnapshot: null, startedAt: `${date}T01:00:00Z`, endedAt: `${date}T02:00:00Z`,
    durationMinutes: 60, createdAt: `${date}T01:00:00Z`, updatedAt: `${date}T02:00:00Z`,
  }))
  const summary = date => ({ date, plannedOccupiedMinutes: 60, dailyEstimatedMinutes: Number(date.slice(-2)) * 60,
    dailyActualMinutes: 60, dailyDifference: 0, tasks: [] })
  const requests = [], held = [], errors = []
  let hold = '', failure = ''
  await browser.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' })
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const D=Date; window.Date=class extends D { constructor(...args){super(...(args.length?args:[${Date.parse(today + 'T12:00:00+09:00')}]))} static now(){return ${Date.parse(today + 'T12:00:00+09:00')}} };
  })()` })
  browser.listeners.push(message => {
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method !== 'Fetch.requestPaused') return
    const { request, requestId } = message.params
    void (async () => {
      if (request.method === 'OPTIONS') { await browser.fulfill(requestId, {}); return }
      const url = new URL(request.url)
      requests.push({ path: url.pathname, query: url.search, method: request.method })
      let body
      if (request.method === 'POST' && url.pathname === '/tasks') {
        const input = JSON.parse(request.postData)
        const task = { ...tasks[0], ...input, id: 2, status: 'NOT_STARTED', actualMinutes: 0 }
        tasks.push(task); body = task
      } else if (request.method !== 'GET') throw new Error(`Unexpected mutation: ${request.method} ${url.pathname}`)
      else if (url.pathname === '/tasks') body = url.searchParams.has('inbox') ? tasks.filter(task => task.id !== 1) : tasks
      else if (url.pathname === '/tags') body = []
      else if (url.pathname === '/projects') body = []
      else if (url.pathname === '/tasks/time/active') body = { taskId: null, running: false, startedAt: null }
      else if (url.pathname.endsWith('/time-entries')) body = url.pathname.includes('/1/') ? entries : []
      else if (url.pathname === '/reports/daily') body = summary(url.searchParams.get('date'))
      else if (url.pathname === '/schedule-blocks') body = days(url.searchParams.get('startDate') ?? '2026-09-01', url.searchParams.get('endDate'))
        .map(date => ({ id: Number(date.replaceAll('-', '')), taskId: 1, date, type: 'TIMED', startTime: '09:00:00',
          durationMinutes: 60, createdAt: `${date}T00:00:00Z`, updatedAt: `${date}T00:00:00Z` }))
      else throw new Error(`Unexpected read: ${url.pathname}`)
      const resource = url.pathname === '/schedule-blocks' ? 'plans' : url.pathname === '/reports/daily' ? 'metrics'
        : url.pathname.endsWith('/time-entries') ? 'actual' : ''
      if (resource && hold === resource) { held.push({ requestId, body }); return }
      if (resource && failure === resource) { await browser.fulfill(requestId, { detail: 'Controlled failure' }, 500); return }
      if (resource === 'plans' && failure === 'network') {
        await browser.send('Fetch.failRequest', { requestId, errorReason: 'ConnectionFailed' }); return
      }
      await browser.fulfill(requestId, body)
    })().catch(error => { if (!/Invalid [Ii]nterception|Invalid requestId/.test(error.message)) errors.push(error.message) })
  })
  await browser.send('Fetch.enable', { patterns: [{ urlPattern: 'http://localhost:8000/*', requestStage: 'Request' }] })
  const ready = () => browser.until('document.querySelector(".calendar-schedule-status") && !document.querySelector(".calendar-schedule-status [role=status], .calendar-schedule-status [role=alert]")', 'Calendar settled')
  const clickMode = value => browser.click(`[aria-label="カレンダー表示"] button:nth-child(${({ day: 1, week: 2, month: 3 })[value]})`)
  async function mode(value) { await clickMode(value); await ready() }
  const period = direction => browser.click(`.calendar-period-controls [aria-label="${direction === -1 ? '前' : '次'}の期間"]`)
  async function release(status = 200) {
    hold = ''
    for (const item of held.splice(0)) {
      try { await browser.fulfill(item.requestId, status === 200 ? item.body : { detail: 'Late failure' }, status) }
      catch (error) { if (!/Invalid [Ii]nterception|Invalid requestId/.test(error.message)) throw error }
    }
  }
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await browser.navigate(); await ready()
  await browser.evaluate(`window.readCalendar = () => JSON.stringify({
    dates: Array.from(document.querySelectorAll('[data-timed-drop-date], .month-day')).map(e=>e.dataset.timedDropDate??e.dataset.date),
    plans: Array.from(document.querySelectorAll('[data-schedule-block-id]')).map(e=>[e.dataset.scheduleBlockId,e.dataset.date,e.textContent]),
    actual: Array.from(document.querySelectorAll('.calendar-event.actual')).map(e=>[e.dataset.timeEntryId,e.dataset.date,e.textContent]),
    metrics: Array.from(document.querySelectorAll('[data-metric-date]')).map(e=>[e.dataset.metricDate,e.textContent]),
    label: document.querySelector('.calendar-period-controls strong').textContent
  }); undefined`)
  async function watch() {
    await browser.evaluate(`(() => {
      const panel=document.querySelector('.week-calendar-panel, .month-calendar-panel'), signature=window.readCalendar(), rect=panel.getBoundingClientRect();
      window.calendarWatch={frames:0,failures:0,layoutChanges:0,stopped:false};
      const sample=()=>{const w=window.calendarWatch;if(w.stopped)return;
        const r=panel.getBoundingClientRect();w.frames++;
        if(!panel.isConnected||window.readCalendar()!==signature)w.failures++;
        if(Math.abs(r.top-rect.top)>.1||Math.abs(r.height-rect.height)>.1)w.layoutChanges++;
        requestAnimationFrame(sample);
      };requestAnimationFrame(sample);
    })()`)
  }
  async function retained(checkLayout = true) {
    await browser.until('window.calendarWatch.frames>=4', 'Observe loading frames')
    assert.equal(await browser.evaluate('window.calendarWatch.failures'), 0, 'Calendar data, panel and dates stay visible')
    if (checkLayout) assert.equal(await browser.evaluate('window.calendarWatch.layoutChanges'), 0, 'Fetching does not shift the Calendar')
    assert.equal(await browser.evaluate('document.querySelectorAll(".calendar-page .calendar-time-grid, .calendar-page .month-grid").length'), 1)
    await browser.evaluate('window.calendarWatch.stopped=true; undefined')
  }
  async function delayed(action, resource = 'plans') {
    await watch(); hold = resource; await action()
    await browser.until('document.querySelector(".calendar-schedule-status [role=status]")', 'Small inline update')
    await browser.until('window.calendarWatch.frames>=4', 'Loading keeps rendering')
    assert(held.length > 0, 'Request was held')
    await retained(); await release(); await ready()
  }
  await t.test('Day → Week → Month → Day keeps the previous Calendar until both replacement resources are ready', async () => {
    await mode('day')
    for (const value of ['week', 'month', 'day']) await delayed(() => clickMode(value))
    assert(await browser.evaluate('document.querySelector(".week-calendar-panel.single-day")!==null'))
  })
  await t.test('previous/next day, week and month retain their old dates, blocks, metrics and layout while fetching', async () => {
    for (const value of ['day', 'week', 'month']) {
      await mode(value)
      for (const direction of [-1, 1, 1, -1]) await delayed(() => period(direction))
    }
  })
  await t.test('slow metrics keep plans and Actual visible instead of partially publishing a new date', async () => {
    await mode('day'); await delayed(() => period(-1), 'metrics')
  })
  await t.test('repeated current-mode clicks retain the Calendar and never leave a loading indicator', async () => {
    for (const value of ['day', 'week', 'month']) {
      await mode(value)
      const count = requests.length
      if (value === 'week') {
        // Preserve the existing Week-button refresh action without clearing its UI.
        await delayed(async () => { await clickMode(value); await clickMode(value) })
        assert(requests.length > count)
      } else {
        await clickMode(value); await clickMode(value); await ready()
        assert.equal(requests.length, count)
      }
    }
  })
  await t.test('rapid navigation ignores a late older success and a late older failure', async () => {
    await mode('day')
    for (const status of [200, 500]) {
      hold = 'plans'; await period(1)
      await browser.until('document.querySelector(".calendar-schedule-status [role=status]")', 'Older request pending')
      assert(held.length > 0)
      hold = ''; await period(1); await ready()
      const latest = await browser.evaluate('window.readCalendar()')
      await release(status)
      await browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      assert.equal(await browser.evaluate('window.readCalendar()'), latest)
      assert.equal(await browser.evaluate('document.querySelector(".calendar-schedule-status [role=alert]")!==null'), false)
    }
  })
  await t.test('Schedule, metric and network failures retain the successful view and retry updates it', async () => {
    for (const resource of ['plans', 'metrics', 'network']) {
      await watch(); failure = resource; await period(-1)
      await browser.until('document.querySelector(".calendar-schedule-status [role=alert]")', 'Inline request error')
      await retained(false) // An error message may wrap; the Calendar content must stay intact.
      assert.equal(await browser.evaluate('document.querySelector(".calendar-schedule-status [role=status]")!==null'), false)
      failure = ''; await browser.click('.calendar-schedule-status [role=alert] button'); await ready()
    }
  })
  await t.test('Actual history refresh and failure keep existing blocks visible, and retry clears the local error', async () => {
    await browser.click('.calendar-period-controls .today-button'); await ready()
    const before = await browser.evaluate('Array.from(document.querySelectorAll(".calendar-event.actual")).map(e=>e.dataset.timeEntryId)')
    assert(before.length > 0)
    hold = 'actual'; await browser.click('[aria-label="未配置タスクを作成"]')
    await browser.until('document.querySelector(".task-drawer")?.open', 'Task Create Drawer')
    await browser.evaluate(`(()=>{const e=document.querySelector('.task-form [name=title]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'Background refresh');e.dispatchEvent(new Event('input',{bubbles:true}));})()`)
    await browser.click('.task-form button[type=submit]')
    await browser.until('document.querySelector(".calendar-schedule-status").textContent.includes("記録を更新中")', 'History refresh pending')
    assert.deepEqual(await browser.evaluate('Array.from(document.querySelectorAll(".calendar-event.actual")).map(e=>e.dataset.timeEntryId)'), before)
    await release(500)
    await browser.until('document.querySelector(".calendar-schedule-status [role=alert]")?.textContent.includes("記録")', 'Actual error shown')
    assert.deepEqual(await browser.evaluate('Array.from(document.querySelectorAll(".calendar-event.actual")).map(e=>e.dataset.timeEntryId)'), before)
    await browser.click('.calendar-schedule-status [role=alert] button'); await ready()
    assert.equal(await browser.evaluate('document.querySelector(".global-error")!==null'), false)
  })
  await t.test('375px keeps the Day Calendar and its data during a delayed switch', async () => {
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 1000, deviceScaleFactor: 1, mobile: true })
    await mode('day'); await delayed(() => clickMode('week')); await delayed(() => clickMode('month')); await delayed(() => clickMode('day'))
    assert(await browser.evaluate('document.documentElement.scrollWidth<=innerWidth'))
  })
  assert.deepEqual(errors, [], 'No browser errors or unmocked API access')
})
