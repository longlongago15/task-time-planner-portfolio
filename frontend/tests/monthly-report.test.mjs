import { openReport, selectReportAnchor, selectReportMode, expectReportSummary, reportReady, releaseReportResponse } from './report-picker.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { openBrowser } from './browser.mjs'

test('Monthly Report shares daily aggregation with seven weekday totals on a guarded temporary DB', { timeout: 180000 }, async t => {
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
    if (browser) await browser.evaluate(`window.__monthlyNow = ${now}; localStorage.setItem('__monthlyTestNow', String(window.__monthlyNow)); document.dispatchEvent(new Event('visibilitychange')); undefined`)
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
  const createTask = async (title, date, estimatedMinutes) => {
    const task = await api('/tasks', { title, estimatedMinutes })
    await api('/schedule-blocks', { taskId: task.id, date, type: 'TIME_UNSET' })
    return task
  }
  async function interval(task, start, end) {
    await setClock(start); await api('/tasks/time/start', { taskId: task.id })
    await setClock(end); return api('/tasks/time/stop', { taskId: task.id })
  }
  const first = await createTask('October Monday A', '2026-10-05', 60)
  const second = await createTask('October Monday B', '2026-10-12', 120)
  const unknown = await createTask('Unestimated Monday', '2026-10-19', null)
  await block(first, '2026-10-05', '10:00', 60)
  await block(unknown, '2026-10-05', '10:30', 60) // Two tasks: union = 90, not 120.
  await block(second, '2026-10-12', '13:00', 30)
  await block(unknown, '2026-09-30', '23:30', 120)
  await block(unknown, '2026-10-31', '23:30', 120)
  await interval(unknown, '2026-09-30T23:00:00Z', '2026-10-01T01:30:00Z')
  await interval(first, '2026-10-05T12:00:00Z', '2026-10-05T12:30:00Z')
  await interval(second, '2026-10-12T12:00:00Z', '2026-10-12T12:45:00Z')
  await interval(unknown, '2026-10-19T12:00:00Z', '2026-10-19T13:00:00Z')
  await interval(unknown, '2026-10-31T23:30:00Z', '2026-11-01T01:00:00Z')
  const next = await createTask('November Monday', '2026-11-02', 30)
  await block(next, '2026-11-02', '10:00', 30)
  await interval(next, '2026-11-02T12:00:00Z', '2026-11-02T12:45:00Z')
  const activeTask = await createTask('December Active', '2026-12-15', 60)
  await block(activeTask, '2026-12-15', '12:00', 30)
  await setClock('2026-12-15T10:00:00Z'); await api('/tasks/time/start', { taskId: activeTask.id })
  await setClock('2026-12-15T10:15:00Z')

  browser = await openBrowser()
  await browser.send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' })
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const RealDate = Date; window.__monthlyNow = Number(localStorage.getItem('__monthlyTestNow')) || ${now};
    window.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [window.__monthlyNow])); } static now() { return window.__monthlyNow; } };
  })()` })
  const canceled=new Set()
  const errors = []
  const requests = []
  let holdMonth
  let held
  let failMonth
  browser.listeners.push(message => {
    if(message.method==='Network.loadingFailed'&&message.params.canceled)canceled.add(message.params.requestId)
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method !== 'Fetch.requestPaused') return
    const { request, requestId } = message.params
    void (async () => {
      if (request.method === 'OPTIONS') { await browser.fulfill(requestId, {}); return }
      const url = new URL(request.url)
      requests.push({ method: request.method, path: url.pathname, month: url.searchParams.get('month'), endDate:url.searchParams.get('endDate'), timezone: url.searchParams.get('timezone') })
      if (url.pathname === '/schedule-blocks' && url.searchParams.get('endDate')?.slice(0,7) === failMonth) {
        await browser.fulfill(requestId, { detail: 'Synthetic monthly failure' }, 500); return
      }
      const response = await fetch(`${base}${url.pathname}${url.search}`, { method: request.method,
        ...(request.postData ? { headers: { 'Content-Type': 'application/json' }, body: request.postData } : {}) })
      const body = await response.json()
      if (url.pathname === '/schedule-blocks' && url.searchParams.get('endDate')?.slice(0,7) === holdMonth) {
        held = { requestId, body, status: response.status, networkId:message.params.networkId }; await browser.evaluate('window.__heldReport=true'); return
      }
      await browser.fulfill(requestId, body, response.status)
    })().catch(async error => {
      if (/Invalid InterceptionId|Invalid interceptionId|Invalid requestId/.test(error.message)) return
      errors.push(error.message)
      try { await browser.send('Fetch.failRequest', { requestId, errorReason: 'ConnectionFailed' }) } catch { /* Reloaded. */ }
    })
  })
  await browser.send('Fetch.enable', { patterns: [{ urlPattern: 'http://localhost:8000/*', requestStage: 'Request' }] })
  const monthly = (month, zone = 'UTC') => api(`/reports/monthly?month=${month}&timezone=${encodeURIComponent(zone)}`)
  const values = value => [value.monthlyEstimatedMinutes, value.monthlyPlannedOccupiedMinutes, value.monthlyActualMinutes]
  const dailyValues = day => [day.dailyEstimatedMinutes, day.plannedOccupiedMinutes, day.dailyActualMinutes]
  const weekdayValues = totals => [totals.estimatedMinutes, totals.plannedOccupiedMinutes, totals.actualMinutes]
  async function changeMonth(month) { await selectReportAnchor(browser,month+'-01',{wait:false}) }
  async function assertMonth(month, expected, zone = 'UTC') {
    const response = await monthly(month, zone)
    if (expected) assert.deepEqual(values(response), expected)
    await expectReportSummary(browser,response.monthlyPlannedOccupiedMinutes,response.monthlyActualMinutes)
    const dates=response.daily.map(day=>day.date)
    if(response.daily.some(day=>day.plannedOccupiedMinutes||day.dailyActualMinutes)) {
      assert.deepEqual(await browser.evaluate('Array.from(document.querySelectorAll("[data-chart-date]")).map(e=>e.dataset.chartDate)'),dates)
    } else assert(await browser.evaluate('document.querySelector(".period-chart-panel .empty-state")?.textContent.includes("\u5bfe\u8c61\u671f\u9593\u306e\u8a18\u9332\u306f\u3042\u308a\u307e\u305b\u3093")'))
    assert.equal(response.weekdayTotals.length, 7)
    for (let index = 0; index < 3; index += 1) {
      assert.equal(values(response)[index], response.daily.reduce((sum, day) => sum + dailyValues(day)[index], 0))
      assert.equal(values(response)[index], response.weekdayTotals.reduce((sum, day) => sum + weekdayValues(day)[index], 0))
    }
    return response
  }
  async function show(month, expected, zone) { await changeMonth(month); return assertMonth(month, expected, zone) }
  async function load(zone = 'UTC', reload = false) {
    await browser.send('Emulation.setTimezoneOverride', { timezoneId: zone })
    await browser.navigate(reload)
    await browser.until("document.querySelector('.timer-session:not(.paused)') !== null && document.querySelector('.calendar-event.actual')", 'Active and Calendar ready')
    await openReport(browser,'day');await selectReportMode(browser,'week');await selectReportMode(browser,'month')
  }
  await load()
  await t.test('Daily to Weekly to Monthly uses Calendar controls and validates 31 Backend days with displayed totals', async () => {
    const result = await show('2026-10', [180,240,255])
    assert.equal(result.monthStart, '2026-10-01'); assert.equal(result.monthEnd, '2026-10-31'); assert.equal(result.daily.length, 31)
    assert.deepEqual(await browser.evaluate('Array.from(document.querySelectorAll(".report-summary .summary-item > span")).map(e=>e.textContent)'),['計画済み','記録','計画差'])
    assert.equal(await browser.evaluate('document.querySelector("[data-chart-date]").dataset.chartDate'),'2026-10-01')
  })
  await t.test('30 days, ordinary February, leap February and empty 31-day month show zero everywhere', async () => {
    for (const [month, days] of [['2026-04',30],['2026-02',28],['2028-02',29],['2027-01',31]]) {
      const result = await show(month, [0,0,0]); assert.equal(result.daily.length, days)
      assert(result.daily.every(day=>dailyValues(day).every(n=>n===0)));assert(result.weekdayTotals.every(day=>weekdayValues(day).every(n=>n===0)))
    }
  })
  await t.test('overlapping different Tasks use the daily union rather than durations or estimates', async () => {
    const result = await show('2026-10', [180,240,255])
    assert.deepEqual(dailyValues(result.daily[4]), [60,90,30])
  })
  await t.test('both month-boundary plans and actuals are clipped to the correct dates', async () => {
    const october = await assertMonth('2026-10', [180,240,255])
    assert.deepEqual(dailyValues(october.daily[0]), [0,90,90])
    assert.deepEqual(dailyValues(october.daily[30]), [0,30,30])
    const november = await show('2026-11', [30,120,105])
    assert.deepEqual(dailyValues(november.daily[0]), [0,90,60])
    const september = await show('2026-09', [0,30,60])
    assert.deepEqual(dailyValues(september.daily[29]), [0,30,60])
  })
  await t.test('NULL estimate stays unestimated and only known estimates contribute', async () => {
    const result = await show('2026-10', [180,240,255])
    assert.equal(result.daily[18].tasks[0].estimatedMinutes, null)
    assert.equal((await api(`/tasks/${unknown.id}`)).estimatedMinutes, null)
    await browser.click('#report-tab-activity');await browser.until('document.querySelector("[data-report-table=activity]")?.textContent.includes("Unestimated Monday")','Unestimated Task record remains visible');await browser.click('#report-tab-analysis')
  })
  await t.test('Monday actual is 30 plus 45 plus 60 and all weekday totals equal monthly totals', async () => {
    const result = await assertMonth('2026-10', [180,240,255])
    assert.deepEqual(result.weekdayTotals[0], { weekday:0, estimatedMinutes:180, plannedOccupiedMinutes:120, actualMinutes:135 })
    assert.deepEqual(result.weekdayTotals.map(day=>day.weekday),[0,1,2,3,4,5,6])
  })
  await t.test('previous, next, current month and repeated Month control remain usable', async () => {
    await browser.click('.report-period-controls [aria-label="次の期間"]'); await assertMonth('2026-11', [30,120,105])
    await browser.click('.report-period-controls [aria-label="前の期間"]'); await assertMonth('2026-10', [180,240,255])
    await browser.click('.report-mode button:nth-child(3)'); await assertMonth('2026-10', [180,240,255])
    await browser.click('.report-period-controls .secondary-button'); await assertMonth('2026-12', [60,30,15])
  })
  const retainedText=()=>browser.evaluate('document.querySelector("#report-tab-content").textContent')
  await t.test('refresh retains all previous-month values and an old delayed response cannot overwrite a new month', async () => {
    const retained=await retainedText()
    holdMonth='2026-11'; await changeMonth(holdMonth)
    await browser.until('window.__heldReport===true','Monthly Schedule source held')
    assert.equal(await retainedText(),retained)
    assert(held)
    assert(held); holdMonth=undefined
    await show('2026-02',[0,0,0])
    await releaseReportResponse(browser,held,canceled); held=undefined
    await browser.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'); await assertMonth('2026-02',[0,0,0])
  })
  await t.test('monthly failure uses existing Error UI and never partially updates the three sections', async () => {
    const retained=await retainedText()
    failMonth='2026-11'; await changeMonth(failMonth)
    await browser.until('!!document.querySelector(".reports-v2 [role=alert] button")','Monthly Error with Retry')
    assert.equal(await retainedText(),retained)
    failMonth=undefined;await browser.click('.reports-v2 [role=alert] button');await assertMonth('2026-11',[30,120,105]);await show('2026-10',[180,240,255])
  })
  await t.test('Active interval clock increases from 15 to 30 and agrees with monthly Backend totals', async () => {
    await show('2026-12',[60,30,15])
    await setClock('2026-12-15T10:30:00Z')
    await browser.click('.report-mode button:nth-child(2)')
    await reportReady(browser)
    const before=requests.length
    await browser.click('.report-mode button:nth-child(3)'); await assertMonth('2026-12',[60,30,30])
    assert.equal(requests.slice(before).filter(x=>x.path==='/schedule-blocks').length,1)
    assert.equal((await api(`/tasks/${activeTask.id}/time-entries`)).filter(entry=>entry.endedAt===null).length,1)
  })
  await t.test('UTC, Tokyo and New York use local month boundaries and preserve local planned values', async () => {
    for (const [zone,october,november] of [['UTC',255,105],['Asia/Tokyo',285,135],['America/New_York',225,45]]) {
      await load(zone,true)
      await show('2026-10',[180,240,october],zone)
      await show('2026-11',[30,120,november],zone)
      assert.equal(await browser.evaluate('Intl.DateTimeFormat().resolvedOptions().timeZone'),zone)
    }
  })
  await t.test('returning to Daily and Weekly matches existing Backend values', async () => {
    await show('2026-10',[180,240,225],'America/New_York')
    await browser.click('.report-mode button:nth-child(1)')
    const day=await api('/reports/daily?date=2026-10-01&timezone=America%2FNew_York')
    await expectReportSummary(browser,day.plannedOccupiedMinutes,day.dailyActualMinutes)
    await browser.click('.report-mode button:nth-child(2)')
    const week=await api('/reports/weekly?date=2026-10-01&timezone=America%2FNew_York')
    await expectReportSummary(browser,week.weeklyPlannedOccupiedMinutes,week.weeklyActualMinutes)
    assert.equal(await browser.evaluate('document.querySelectorAll("[data-report-table=days] tbody tr").length'),7)
    await browser.click('.report-mode button:nth-child(3)'); await assertMonth('2026-10',[180,240,225],'America/New_York')
  })
  await t.test('month navigation makes one Schedule request without 28 to 31 Daily requests', async () => {
    const before=requests.length
    await browser.click('.report-period-controls [aria-label="次の期間"]'); await assertMonth('2026-11',[30,120,45],'America/New_York')
    const added=requests.slice(before)
    assert.equal(added.filter(request=>request.path==='/schedule-blocks').length,1)
    // The pre-existing selected-day prefetch is retained, separate from monthly aggregation.
    assert(added.filter(request=>request.path==='/reports/daily').length<=1)
    assert(!added.some(request=>request.path==='/reports/weekly'||request.path==='/reports/monthly'))
  })
  await t.test('31-day Chart scrolls locally and retains all dates and its time axis', async () => {
    await show('2026-10',[180,240,225],'America/New_York')
    await browser.send('Emulation.setDeviceMetricsOverride',{width:768,height:1080,deviceScaleFactor:1,mobile:false})
    assert(await browser.evaluate('(()=>{const box=document.querySelector(".report-chart-scroll");return box.scrollWidth>box.clientWidth && document.querySelectorAll("[data-chart-date]").length===31 && !!document.querySelector(".report-y-axis") && document.documentElement.scrollWidth<=innerWidth})()'))
    await browser.evaluate('document.querySelector(".report-chart-scroll").scrollLeft=99999;undefined')
    assert(await browser.evaluate('document.querySelector(".report-chart-scroll").scrollLeft>0'))

  })
  assert.deepEqual(errors,[],'No browser runtime or forwarding errors')
})
