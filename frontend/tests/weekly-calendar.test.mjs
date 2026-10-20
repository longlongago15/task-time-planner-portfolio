import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { openBrowser, selectTimerTask, pauseOrResumeTimer } from './browser.mjs'

test('Week Calendar compares persisted ScheduleBlocks and TimeEntries on a guarded temporary DB', { timeout: 180000 }, async t => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const python = process.env.TIMER_TEST_PYTHON ?? path.join(root, 'backend', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  const directory = await mkdtemp(path.join(tmpdir(), 'task-timer-db-'))
  let backend
  let browser
  let base
  let clockVersion = 0
  let now
  const setClock = async value => {
    const staging = path.join(directory, `clock-${++clockVersion}.txt`)
    await writeFile(staging, value)
    // Windows may briefly hold the old clock file open while the test Backend reads it.
    for (let attempt = 0; ; attempt += 1) {
      try { await rename(staging, path.join(directory, 'clock.txt')); break } catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 30) throw error
        await new Promise(resolve => setTimeout(resolve, 20))
      }
    }
    now = Date.parse(value)
    if (browser) await browser.evaluate(`window.__calendarNow = ${now}; localStorage.setItem('__calendarTestNow', String(window.__calendarNow)); undefined`)
  }
  t.after(async () => {
    try { await browser?.close() } finally {
      if (backend?.exitCode === null) {
        const exited = new Promise(resolve => backend.once('exit', resolve))
        if (process.platform === 'win32') {
          // The virtualenv launcher has a child Python process; terminate our entire server tree.
          const killer = spawn('taskkill.exe', ['/PID', String(backend.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
          await new Promise((resolve, reject) => { killer.once('error', reject); killer.once('exit', resolve) })
        } else backend.kill()
        await exited
      }
      assert.equal(path.dirname(directory), path.resolve(tmpdir()))
      assert(path.basename(directory).startsWith('task-timer-db-'))
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
    }
  })
  await setClock('2026-10-02T12:00:00+00:00')
  backend = spawn(python, ['-B', fileURLToPath(new URL('./isolated-backend.py', import.meta.url)), directory], {
    cwd: root, windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  let log = ''
  backend.stdout.on('data', data => { output += data.toString() })
  backend.stderr.on('data', data => { log += data.toString() })
  for (let i = 0; i < 200; i += 1) {
    const port = output.match(/TIMER_TEST_PORT=(\d+)/)?.[1]
    if (port) {
      base = `http://127.0.0.1:${port}`
      try { if ((await fetch(`${base}/health`)).ok) break } catch { /* Starting. */ }
    }
    assert.equal(backend.exitCode, null, `Temporary Backend exited: ${output}\n${log}`)
    await new Promise(resolve => setTimeout(resolve, 50))
    if (i === 199) assert.fail(`Temporary Backend did not start: ${output}\n${log}`)
  }
  async function api(route, payload, method = 'POST') {
    const response = await fetch(`${base}${route}`, payload === undefined ? {} : {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })
    assert(response.ok, `${route}: ${response.status} ${await response.clone().text()}`)
    return response.json()
  }
  const block = (task, date, startTime, durationMinutes) => api('/schedule-blocks', {
    taskId: task.id, date, type: 'TIMED', startTime, durationMinutes,
  })
  const oldProject = await api('/projects', { name: 'Historical Project' })
  const newProject = await api('/projects', { name: 'Current Project' })
  const task = title => api('/tasks', { title, estimatedMinutes: 60, projectId: oldProject.id })
  // Test browser uses Asia/Tokyo. UTC canonical entries must land at these local wall times.
  const utc = (date, minutes) => new Date(Date.parse(`${date}T00:00:00+09:00`) + minutes * 60000).toISOString()
  async function interval(task, day, start, end) {
    await setClock(utc(day, start)); await api('/tasks/time/start', { taskId: task.id })
    await setClock(utc(day, end)); return api('/tasks/time/stop', { taskId: task.id })
  }
  async function pair(title, day, start, duration, actualStart, actualEnd) {
    const item = await task(title)
    const plan = await block(item, day, start, duration)
    const entry = await interval(item, day, actualStart, actualEnd)
    return { task: item, plan, entry, day }
  }
  const basic = await pair('Basic comparison', '2026-09-28', '10:00', 60, 615, 675)
  await api(`/tasks/${basic.task.id}`, { projectId: newProject.id }, 'PUT')
  const exact = await pair('Exact comparison', '2026-09-29', '10:00', 60, 600, 660)
  const exceeded = await pair('Longer actual', '2026-09-30', '10:00', 30, 600, 690)
  const actualOnlyTask = await task('Actual without a plan')
  const actualOnly = await interval(actualOnlyTask, '2026-10-01', 600, 645)
  const planOnlyTask = await task('Plan without actual')
  const planOnly = await block(planOnlyTask, '2026-10-02', '10:00', 60)
  const shortTask = await task('Short intervals')
  const shortEntries = []
  for (const [start, seconds] of [[780, 0], [790, 30], [800, 59]]) shortEntries.push(await interval(shortTask, '2026-10-01', start, start + seconds / 60))
  const midnightTask = await task('Midnight actual')
  const midnight = await interval(midnightTask, '2026-10-03', 1410, 1500)
  const next = await pair('Next week', '2026-10-05', '09:30', 60, 585, 630)
  const inboxTask = await task('Inbox drag')
  const unsetTask = await task('Unset drag')
  const unset = await api('/schedule-blocks', { taskId: unsetTask.id, date: '2026-10-02', type: 'TIME_UNSET' })
  const allDayTask = await task('All day stays above')
  const allDay = await api('/schedule-blocks', { taskId: allDayTask.id, date: '2026-10-02', type: 'ALL_DAY' })
  const activeTask = await task('Active lifecycle')
  await setClock(utc('2026-10-02', 720))

  browser = await openBrowser()
  await browser.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' })
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const RealDate = Date; window.__calendarNow = Number(localStorage.getItem('__calendarTestNow')) || ${now};
    window.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [window.__calendarNow])); } static now() { return window.__calendarNow; } };
  })()` })
  const errors = []
  const requests = []
  let failHistory = false
  let holdWeek = false
  let held
  browser.listeners.push(message => {
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method !== 'Fetch.requestPaused') return
    const { requestId, request } = message.params
    void (async () => {
      if (request.method === 'OPTIONS') { await browser.fulfill(requestId, {}); return }
      const url = new URL(request.url)
      requests.push({ method: request.method, path: url.pathname, search: url.search })
      if (failHistory && url.pathname.endsWith('/time-entries')) { await browser.fulfill(requestId, { detail: 'Isolated history failure' }, 500); return }
      const response = await fetch(`${base}${url.pathname}${url.search}`, { method: request.method,
        ...(request.postData ? { headers: { 'Content-Type': 'application/json' }, body: request.postData } : {}) })
      const body = await response.json()
      if (holdWeek && url.pathname === '/schedule-blocks' && url.searchParams.get('endDate') === '2026-10-11') {
        held = { requestId, body, status: response.status }; return
      }
      await browser.fulfill(requestId, body, response.status)
    })().catch(async error => {
      if (/Invalid InterceptionId|Invalid interceptionId|Invalid requestId/.test(error.message)) return
      errors.push(error.message)
      try { await browser.send('Fetch.failRequest', { requestId, errorReason: 'ConnectionFailed' }) } catch { /* Reloaded. */ }
    })
  })
  await browser.send('Fetch.enable', { patterns: [{ urlPattern: 'http://localhost:8000/*', requestStage: 'Request' }] })
  const planSelector = id => `.weekly-schedule-event[data-schedule-block-id="${id}"]`
  const entrySelector = (id, date) => `.calendar-actual-lane [data-time-entry-id="${id}"]${date ? `[data-date="${date}"]` : ''}`
  const laneSelector = date => `[data-timed-drop-date="${date}"]`
  const actualLane = date => `[data-actual-date="${date}"]`
  const inboxSelector = `[data-inbox-task-id="${inboxTask.id}"]`
  const counts = selector => browser.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`)
  async function ready() {
    await browser.until(`document.querySelector(${JSON.stringify(planSelector(basic.plan.id))}) && document.querySelector(${JSON.stringify(entrySelector(basic.entry.id))}) && !document.querySelector('.calendar-schedule-status [role="status"]')`, 'Initial persisted plan and actual loaded')
  }
  async function geometry(selector) {
    await browser.until(`document.querySelector(${JSON.stringify(selector)})`, `Block ${selector}`)
    return browser.evaluate(`(() => { const item = document.querySelector(${JSON.stringify(selector)}), bounds = item.getBoundingClientRect(), lane = item.parentElement.getBoundingClientRect(); return {top:parseFloat(item.style.top),height:bounds.height,left:bounds.left,right:bounds.right,laneLeft:lane.left,laneRight:lane.right,title:item.title,draggable:item.draggable} })()`)
  }
  async function drag(source, destination, minutes) {
    await browser.until(`document.querySelector(${JSON.stringify(source)}) && document.querySelector(${JSON.stringify(destination)}) && !document.querySelector('.calendar-schedule-status [role="status"]')`, 'Drag source ready')
    await browser.evaluate(`(() => {
      const source = document.querySelector(${JSON.stringify(source)}), target = document.querySelector(${JSON.stringify(destination)}), bounds = target.getBoundingClientRect();
      const dataTransfer = new DataTransfer(), options = {bubbles:true,cancelable:true,dataTransfer,clientX:bounds.left+bounds.width/2,clientY:bounds.top+bounds.height*${minutes}/1440};
      source.dispatchEvent(new DragEvent('dragstart', options)); target.dispatchEvent(new DragEvent('dragover', options)); target.dispatchEvent(new DragEvent('drop', options)); source.dispatchEvent(new DragEvent('dragend', options));
    })()`)
  }
  const plans = () => api('/schedule-blocks?startDate=2026-09-28&endDate=2026-10-04')
  const history = item => api(`/tasks/${item.id}/time-entries`)
  const unchangedActual = await history(basic.task)
  await browser.navigate(); await ready()

  t.afterEach(async () => {
    failHistory = holdWeek = false
    if (held) { const request = held; held = undefined; await browser.fulfill(request.requestId, request.body, request.status) }
  })
  await t.test('default comparison has distinct 50:50 lanes; canonical UTC and historical Project are displayed', async () => {
    assert.equal(await browser.evaluate("document.querySelector('.calendar-comparison-switch button:nth-child(2)').getAttribute('aria-pressed')"), 'true')
    const plan = await geometry(planSelector(basic.plan.id)), actual = await geometry(entrySelector(basic.entry.id))
    assert.equal(plan.top, 540); assert.equal(actual.top, 553.5)
    assert.equal(plan.height, 54); assert.equal(actual.height, 54)
    assert(plan.right <= actual.left + 1)
    assert(Math.abs((plan.right - plan.left) - (actual.right - actual.left)) <= 2)
    assert(actual.title.includes('10:15–11:15')); assert(actual.title.includes('Historical Project')); assert(!actual.title.includes('Current Project'))
    assert.equal(actual.draggable, false)
    assert.equal(await counts('.calendar-actual-lane button:not(.task-hover-start), .calendar-actual-lane .schedule-resize-handle'), 0)
    assert.equal(await counts(`${entrySelector(basic.entry.id)} .task-hover-start`), 1)
    assert(await browser.evaluate(`(()=>{const b=document.querySelector('${entrySelector(basic.entry.id)} .task-hover-start');return !b.disabled&&!b.draggable&&b.title==='このタスクをもう一度計測開始'})()`))
    assert.equal(await counts(`[data-schedule-block-id="${allDay.id}"]`), 1)
    assert.equal(await counts(`.calendar-time-unset-row [data-schedule-block-id="${unset.id}"]`), 1)
    assert.equal(await counts('.schedule-overlap-warning'), 0) // Actual overlap is not a schedule conflict.
  })
  await t.test('matching intervals share Y and height in separate lanes', async () => {
    const plan = await geometry(planSelector(exact.plan.id)), actual = await geometry(entrySelector(exact.entry.id))
    assert.equal(plan.top, actual.top); assert.equal(plan.height, actual.height); assert(plan.right <= actual.left + 1)
  })
  await t.test('longer actual is not clamped to its plan', async () => {
    assert.equal((await geometry(planSelector(exceeded.plan.id))).height, 27)
    assert.equal((await geometry(entrySelector(exceeded.entry.id))).height, 81)
  })
  await t.test('plan-only fills the day and returning to comparison needs no history request', async () => {
    const before = requests.length
    await browser.click('.calendar-comparison-switch button:nth-child(1)')
    assert.equal(await counts('.calendar-actual-lane'), 0)
    const plan = await geometry(planSelector(basic.plan.id))
    const width = await browser.evaluate(`document.querySelector(${JSON.stringify(planSelector(basic.plan.id))}).closest('.calendar-day-column').clientWidth`)
    assert(Math.abs(plan.right - plan.left - width) <= 1)
    await browser.click('.calendar-comparison-switch button:nth-child(2)'); await ready()
    assert.equal(await counts(entrySelector(basic.entry.id)), 1)
    assert.equal(requests.length, before)
  })
  await t.test('zero, 30-second and 59-second intervals remain visible and independent without changing the DB', async () => {
    for (const entry of shortEntries) assert.equal((await geometry(entrySelector(entry.id))).height, 20)
    assert.equal(await counts(`.calendar-actual-lane [data-task-id="${shortTask.id}"]`), 3)
    assert.deepEqual((await history(shortTask)).map(entry => entry.durationMinutes), [0, 0, 0])
  })
  await t.test('midnight actual is split into two local days', async () => {
    assert.equal(await counts(entrySelector(midnight.id)), 2)
    const first = await geometry(entrySelector(midnight.id, '2026-10-03')), second = await geometry(entrySelector(midnight.id, '2026-10-04'))
    assert.equal(first.top, 1269); assert.equal(first.height, 27)
    assert.equal(second.top, 0); assert.equal(second.height, 54)
  })
  await t.test('actual without plan and plan without actual are valid', async () => {
    assert.equal(await counts(`.weekly-schedule-event[data-task-id="${actualOnlyTask.id}"]`), 0)
    assert.equal(await counts(entrySelector(actualOnly.id)), 1)
    assert.equal(await counts(planSelector(planOnly.id)), 1)
    assert.equal(await counts(`.calendar-actual-lane [data-task-id="${planOnlyTask.id}"]`), 0)
  })
  await t.test('actual Lane rejects Inbox, TIME_UNSET and TIMED drops with no mutations', async () => {
    const before = await plans(), writes = requests.filter(item => item.method !== 'GET').length
    for (const source of [inboxSelector, `[data-schedule-block-id="${unset.id}"]`, planSelector(basic.plan.id)]) await drag(source, actualLane('2026-10-02'), 810)
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.deepEqual(await plans(), before)
    assert.equal(requests.filter(item => item.method !== 'GET').length, writes)
  })
  await t.test('Inbox, TIME_UNSET and TIMED drops preserve 15-minute snap in the plan Lane', async () => {
    await drag(inboxSelector, laneSelector('2026-10-02'), 811)
    await browser.until(`document.querySelector('.weekly-schedule-event[data-task-id="${inboxTask.id}"]')`, 'Inbox TIMED placement')
    assert.equal((await plans()).find(item => item.taskId === inboxTask.id).startTime, '13:30:00')
    await drag(`[data-schedule-block-id="${unset.id}"]`, laneSelector('2026-10-02'), 826)
    await browser.until(`document.querySelector(${JSON.stringify(planSelector(unset.id))})`, 'TIME_UNSET became TIMED')
    assert.equal((await plans()).find(item => item.id === unset.id).startTime, '13:45:00')
    await drag(planSelector(unset.id), laneSelector('2026-10-01'), 811)
    await browser.until(`document.querySelector(${JSON.stringify(planSelector(unset.id))})?.dataset.date === '2026-10-01' && document.querySelector(${JSON.stringify(planSelector(unset.id))})?.getAttribute('aria-busy') === 'false'`, 'TIMED moved')
    const moved = (await plans()).find(item => item.id === unset.id)
    assert.equal(moved.startTime, '13:30:00'); assert.equal(moved.durationMinutes, 60)
    await drag(planSelector(unset.id), '[data-drop-date="2026-10-02"]', 0)
    await browser.until(`document.querySelector('.calendar-time-unset-row [data-schedule-block-id="${unset.id}"]')`, 'TIMED returned to TIME_UNSET')
    assert.equal((await plans()).find(item => item.id === unset.id).type, 'TIME_UNSET')
  })
  await t.test('Resize changes only the planned duration; Actual is unchanged', async () => {
    const actualBefore = await geometry(entrySelector(basic.entry.id))
    const handle = `${planSelector(basic.plan.id)} .schedule-resize-handle`
    await browser.evaluate(`document.querySelector(${JSON.stringify(handle)}).scrollIntoView({block:'center'})`)
    const position = await browser.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(handle)}).getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2} })()`)
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position })
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...position, button: 'left', clickCount: 1 })
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: position.x, y: position.y + 27, button: 'left', buttons: 1 })
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: position.x, y: position.y + 27, button: 'left', clickCount: 1 })
    await browser.until(`document.querySelector(${JSON.stringify(planSelector(basic.plan.id))})?.style.height === '81px' && document.querySelector(${JSON.stringify(planSelector(basic.plan.id))})?.getAttribute('aria-busy') === 'false'`, 'Resize saved')
    const resized = (await plans()).find(item => item.id === basic.plan.id)
    assert.equal(resized.durationMinutes, 90); assert.equal(resized.startTime, '10:00:00')
    const actualAfter = await geometry(entrySelector(basic.entry.id))
    assert.equal(actualAfter.top, actualBefore.top); assert.equal(actualAfter.height, actualBefore.height)
    assert.deepEqual(await history(basic.task), unchangedActual)
  })
  await t.test('week change retains the visible plans and Actual until the next week is ready, without extra history requests', async () => {
    const before = requests.filter(item => item.path.endsWith('/time-entries')).length
    holdWeek = true
    await browser.click('.calendar-period-controls [aria-label="次の期間"]')
    await browser.until('document.querySelector(".calendar-schedule-status [role=status]")', 'Next week inline update')
    assert.equal(await counts(entrySelector(basic.entry.id)), 1)
    assert.equal(await counts(planSelector(basic.plan.id)), 1)
    assert.equal(await counts(entrySelector(next.entry.id)), 0)
    for (let i = 0; !held && i < 100; i += 1) await new Promise(resolve => setTimeout(resolve, 20))
    assert(held)
    const request = requests.findLast(item=>item.path==='/schedule-blocks')
    assert.equal(new URLSearchParams(request.search).get('endDate'),'2026-10-11')
    assert.equal(new URLSearchParams(request.search).has('startDate'),false,'Keep overnight sources before the visible week')
    holdWeek = false; await browser.fulfill(held.requestId, held.body, held.status); held = undefined
    await browser.until(`document.querySelector(${JSON.stringify(planSelector(next.plan.id))}) && document.querySelector(${JSON.stringify(entrySelector(next.entry.id))})`, 'Next week plan and actual')
    assert.equal(await counts(entrySelector(basic.entry.id)), 0)
    await browser.click('.calendar-period-controls [aria-label="前の期間"]'); await ready()
    assert.equal(await counts(entrySelector(next.entry.id)), 0)
    assert.equal(requests.filter(item => item.path.endsWith('/time-entries')).length, before)
  })
  await t.test('Actual API failure is explicit and plan-only operations still work', async () => {
    failHistory = true; await browser.navigate(true)
    await browser.until("document.body.textContent.includes('記録を取得できませんでした。予定は引き続き操作できます。')", 'Actual error')
    assert.equal(await counts('.calendar-actual-lane .calendar-event'), 0)
    await browser.click('.calendar-comparison-switch button:nth-child(1)')
    await drag(`[data-schedule-block-id="${unset.id}"]`, laneSelector('2026-10-02'), 901)
    await browser.until(`document.querySelector(${JSON.stringify(planSelector(unset.id))}) && document.querySelector(${JSON.stringify(planSelector(unset.id))})?.getAttribute('aria-busy') === 'false'`, 'Plan DnD despite Actual failure')
    assert.equal((await plans()).find(item => item.id === unset.id).startTime, '15:00:00')
    failHistory = false; await browser.navigate(true); await ready()
  })
  // These future closed fixtures have already been verified above. They must
  // not intersect the open-ended Start intervals in the independent lifecycle.
  await api(`/time-entries/${midnight.id}`, {}, 'DELETE')
  await api(`/time-entries/${next.entry.id}`, {}, 'DELETE')
  let firstActive
  let secondActive
  async function selectActiveTask() {
    await selectTimerTask(browser, activeTask.id)
    await browser.until("document.querySelector('.timer-play-button') && !document.querySelector('.timer-play-button').disabled", 'Timer ready')
  }
  await t.test('Start displays exactly one persisted Active that grows with the ticker', async () => {
    await setClock(utc('2026-10-02', 720)); await selectActiveTask(); await browser.click('.timer-play-button')
    await browser.until(`document.querySelector('.calendar-actual-lane [data-task-id="${activeTask.id}"]')`, 'Persisted Active drawn')
    firstActive = (await history(activeTask))[0]
    await browser.until(`document.querySelectorAll(${JSON.stringify(entrySelector(firstActive.id))}).length === 1`, 'Active history refresh complete')
    assert.equal(await counts(entrySelector(firstActive.id)), 1)
    await setClock(utc('2026-10-02', 780))
    await browser.until(`document.querySelector(${JSON.stringify(entrySelector(firstActive.id))})?.style.height === '54px'`, 'Active grew to 60 minutes')
    assert.equal(await counts(`.calendar-actual-lane [data-task-id="${activeTask.id}"]`), 1)
    assert.equal((await history(activeTask))[0].endedAt, null)
  })
  await t.test('Pause and Resume create separate persisted intervals and Stop retains both', async () => {
    await pauseOrResumeTimer(browser)
    await browser.until("document.querySelector('.timer-session.paused') && !document.querySelector('.timer-play-button').disabled", 'Paused')
    await setClock(utc('2026-10-02', 810)); await pauseOrResumeTimer(browser)
    await browser.until(`document.querySelectorAll('.calendar-actual-lane [data-task-id="${activeTask.id}"]').length === 2`, 'Two intervals after Resume')
    secondActive = (await history(activeTask)).find(entry => entry.endedAt === null)
    assert.notEqual(secondActive.id, firstActive.id)
    await setClock(utc('2026-10-02', 840)); await browser.click('.timer-session .timer-stop')
    await browser.until(`!document.querySelector('.timer-session') && document.querySelectorAll('.calendar-actual-lane [data-task-id="${activeTask.id}"]').length === 2`, 'Stopped intervals')
    const rows = await history(activeTask); assert.equal(rows.length, 2); assert(rows.every(entry => entry.endedAt !== null))
    assert.equal((await geometry(entrySelector(firstActive.id))).height, 54)
    assert.equal((await geometry(entrySelector(secondActive.id))).height, 27)
  })
  await t.test('Active survives Reload and is split across midnight exactly once per day', async () => {
    await setClock(utc('2026-10-02', 1410)); await selectActiveTask(); await browser.click('.timer-play-button')
    await browser.until("document.querySelector('.timer-session:not(.paused)') !== null", 'Second Start')
    const entry = (await history(activeTask)).find(item => item.endedAt === null)
    await setClock(utc('2026-10-02', 1500)); await browser.navigate(true); await ready()
    await browser.until(`document.querySelectorAll('.calendar-actual-lane [data-time-entry-id="${entry.id}"]').length === 2`, 'Reload midnight Active')
    assert.equal((await geometry(entrySelector(entry.id, '2026-10-02'))).height, 27)
    assert.equal((await geometry(entrySelector(entry.id, '2026-10-03'))).height, 54)
    assert.equal((await api('/tasks/time/active')).taskId, activeTask.id)
    assert.equal((await history(activeTask)).find(item => item.endedAt === null).id, entry.id)
    await browser.click('.timer-session .timer-stop')
    await browser.until("!document.querySelector('.timer-session')", 'Final Active closed')
  })
  assert.deepEqual(errors, [], 'No browser runtime or API forwarding errors')
})
