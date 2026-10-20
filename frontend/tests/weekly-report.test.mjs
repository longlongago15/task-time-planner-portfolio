import { openReport, selectReportAnchor, expectReportSummary, reportValues, releaseReportResponse } from './report-picker.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { openBrowser } from './browser.mjs'

test('Weekly Report compares interval metrics and seven days with Backend contracts on an isolated DB', { timeout: 180000 }, async t => {
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
    if (browser) await browser.evaluate(`window.__weeklyNow = ${now}; localStorage.setItem('__weeklyTestNow', String(window.__weeklyNow)); document.dispatchEvent(new Event('visibilitychange')); undefined`)
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
  const monday = await createTask('Weekly Monday', '2026-09-28', 60)
  const tuesday = await createTask('Weekly Tuesday', '2026-09-29', 120)
  const unknown = await createTask('Unknown estimate', '2026-09-30', null)
  await block(monday, '2026-09-28', '09:00', 30)
  await block(tuesday, '2026-09-29', '09:00', 90)
  await block(unknown, '2026-09-29', '09:30', 30) // Different Task, fully contained: still 90 minutes.
  await interval(monday, '2026-09-28T10:00:00Z', '2026-09-28T10:45:00Z')
  await interval(tuesday, '2026-09-29T10:00:00Z', '2026-09-29T11:40:00Z')
  await interval(unknown, '2026-09-30T10:00:00Z', '2026-09-30T10:30:00Z')
  await block(unknown, '2026-10-01', '23:30', 120)
  await interval(unknown, '2026-10-01T23:30:00Z', '2026-10-02T01:00:00Z')
  await block(unknown, '2026-10-04', '23:30', 120)
  await interval(unknown, '2026-10-04T23:30:00Z', '2026-10-05T01:00:00Z')
  const next = await createTask('Next week Task', '2026-10-05', 30)
  await interval(next, '2026-10-05T08:00:00Z', '2026-10-05T08:45:00Z')
  const activeTask = await createTask('Weekly Active', '2026-10-21', 60)
  await block(activeTask, '2026-10-21', '12:00', 30)
  await setClock('2026-10-21T10:00:00Z'); await api('/tasks/time/start', { taskId: activeTask.id })
  await setClock('2026-10-21T10:15:00Z')

  browser = await openBrowser()
  await browser.send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' })
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const RealDate = Date; window.__weeklyNow = Number(localStorage.getItem('__weeklyTestNow')) || ${now};
    window.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [window.__weeklyNow])); } static now() { return window.__weeklyNow; } };
  })()` })
  const canceled=new Set()
  const errors = []
  const requests = []
  const weekEnd=date=>{if(!date)return null;const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+6);return d.toISOString().slice(0,10)}
  let holdDate
  let held
  let failDate
  browser.listeners.push(message => {
    if(message.method==='Network.loadingFailed'&&message.params.canceled)canceled.add(message.params.requestId)
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method !== 'Fetch.requestPaused') return
    const { request, requestId } = message.params
    void (async () => {
      if (request.method === 'OPTIONS') { await browser.fulfill(requestId, {}); return }
      const url = new URL(request.url)
      requests.push({ method: request.method, path: url.pathname, date: url.searchParams.get('date'), endDate:url.searchParams.get('endDate'), timezone: url.searchParams.get('timezone') })
      if (url.pathname === '/schedule-blocks' && url.searchParams.get('endDate') === weekEnd(failDate)) { await browser.fulfill(requestId, { detail: 'Test weekly failure' }, 500); return }
      const response = await fetch(`${base}${url.pathname}${url.search}`, { method: request.method,
        ...(request.postData ? { headers: { 'Content-Type': 'application/json' }, body: request.postData } : {}) })
      const body = await response.json()
      if (url.pathname === '/schedule-blocks' && url.searchParams.get('endDate') === weekEnd(holdDate)) { held = { requestId, body, status: response.status, networkId:message.params.networkId }; await browser.evaluate('window.__heldReport=true'); return }
      await browser.fulfill(requestId, body, response.status)
    })().catch(async error => {
      if (/Invalid InterceptionId|Invalid interceptionId|Invalid requestId/.test(error.message)) return
      errors.push(error.message)
      try { await browser.send('Fetch.failRequest', { requestId, errorReason: 'ConnectionFailed' }) } catch { /* Reloaded. */ }
    })
  })
  await browser.send('Fetch.enable', { patterns: [{ urlPattern: 'http://localhost:8000/*', requestStage: 'Request' }] })
  const weekly = (date, zone = 'UTC') => api(`/reports/weekly?date=${date}&timezone=${encodeURIComponent(zone)}`)
  const values = value => [value.weeklyEstimatedMinutes, value.weeklyPlannedOccupiedMinutes, value.weeklyActualMinutes]
  const dailyValues = day => [day.dailyEstimatedMinutes, day.plannedOccupiedMinutes, day.dailyActualMinutes]
  async function changeDate(date) { await selectReportAnchor(browser,date,{wait:false}) }
  async function assertWeek(date, expected, zone = 'UTC') {
    const response = await weekly(date, zone)
    if (expected) assert.deepEqual(values(response), expected)
    await expectReportSummary(browser,response.weeklyPlannedOccupiedMinutes,response.weeklyActualMinutes)
    const rows=response.daily.map(day=>[day.date,...reportValues(day.plannedOccupiedMinutes,day.dailyActualMinutes)])
    await browser.until('JSON.stringify(Array.from(document.querySelectorAll("[data-report-table=days] tbody tr")).map(row=>[row.dataset.reportDate,...Array.from(row.querySelectorAll("td")).map(e=>e.textContent)]))==='+JSON.stringify(JSON.stringify(rows)),'All seven daily union/record/difference rows')
    assert.equal(response.daily.length, 7)
    for (let index = 0; index < 3; index += 1) assert.equal(values(response)[index], response.daily.reduce((sum, day) => sum + dailyValues(day)[index], 0))
    return response
  }
  async function show(date, expected, zone) { await changeDate(date); return assertWeek(date, expected, zone) }
  async function load(zone = 'UTC', reload = false) {
    await browser.send('Emulation.setTimezoneOverride', { timezoneId: zone })
    await browser.navigate(reload)
    await browser.until("document.querySelector('.timer-session:not(.paused)') !== null && document.querySelector('.calendar-event.actual')", 'Active and existing Calendar history loaded')
    await openReport(browser,'week')
  }
  await load()
  await t.test('normal week displays Monday through Sunday and Backend totals', async () => {
    const result = await show('2026-10-02', [180, 270, 295])
    assert.equal(result.weekStart, '2026-09-28'); assert.equal(result.weekEnd, '2026-10-04')
    assert.deepEqual(result.daily.slice(0,3).map(dailyValues), [[60,30,45],[120,90,100],[0,0,30]])
    assert.deepEqual(await browser.evaluate('Array.from(document.querySelectorAll(".report-summary .summary-item > span")).map(e=>e.textContent)'),['計画済み','記録','計画差'])
  })
  await t.test('zero week shows zero in three totals and every daily cell', async () => {
    await show('2026-10-12', [0,0,0])
    assert.equal(await browser.evaluate("Array.from(document.querySelectorAll('[data-report-table=days] tbody tr')).every(row=>JSON.stringify(Array.from(row.querySelectorAll('td')).map(e=>e.textContent))===JSON.stringify(['0分','0分','－']))"), true)
  })
  await t.test('overlap, cross-day schedule and cross-day actual use daily Backend results', async () => {
    const result = await show('2026-09-28', [180,270,295])
    assert.equal(result.daily[1].plannedOccupiedMinutes, 90)
    assert.deepEqual(result.daily.slice(3,5).map(dailyValues), [[0,30,30],[0,90,60]])
  })
  await t.test('Sunday-to-Monday boundary belongs to the appropriate weekly report', async () => {
    const first = await show('2026-09-28', [180,270,295])
    assert.deepEqual(dailyValues(first.daily[6]), [0,30,30])
    const second = await show('2026-10-05', [30,90,105])
    assert.deepEqual(dailyValues(second.daily[0]), [30,90,105])
  })
  await t.test('NULL estimate remains NULL and known estimates alone contribute', async () => {
    const result = await show('2026-09-28', [180,270,295])
    assert.equal(result.daily[2].tasks.find(task => task.taskId === unknown.id).estimatedMinutes, null)
    assert.equal((await api(`/tasks/${unknown.id}`)).estimatedMinutes, null)
    assert(await browser.evaluate('document.querySelector("[data-report-table=tasks]").textContent.includes("Unknown estimate")'))
  })
  await t.test('week navigation updates seven rows and totals; a repeated Week click remains usable', async () => {
    await browser.click('.report-period-controls [aria-label="次の期間"]'); await assertWeek('2026-10-05', [30,90,105])
    await browser.click('.report-mode button:nth-child(2)'); await assertWeek('2026-10-05', [30,90,105])
    await browser.click('.report-period-controls [aria-label="前の期間"]'); await assertWeek('2026-09-28', [180,270,295])
  })
  await t.test('Refresh retains the previous summary and a late old week cannot overwrite the new week', async () => {
    const retained=await browser.evaluate('document.querySelector("#report-tab-content").textContent')
    holdDate = '2026-10-05'; await changeDate(holdDate)
    await browser.until('window.__heldReport===true','Weekly Schedule source held')
    assert.equal(await browser.evaluate('document.querySelector("#report-tab-content").textContent'),retained)
    assert(held)
    assert(held); holdDate = undefined
    await show('2026-10-12', [0,0,0])
    await releaseReportResponse(browser,held,canceled); held = undefined
    await browser.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'); await assertWeek('2026-10-12', [0,0,0])
  })
  await t.test('Schedule API 500 retains all weekly rows and totals; Retry recovers', async () => {
    const retained=await browser.evaluate('document.querySelector("#report-tab-content").textContent')
    failDate = '2026-10-05'; await changeDate(failDate)
    await browser.until('!!document.querySelector(".reports-v2 [role=alert] button")','Weekly Error with Retry')
    assert.equal(await browser.evaluate('document.querySelector("#report-tab-content").textContent'),retained)
    failDate = undefined;await browser.click('.reports-v2 [role=alert] button');await assertWeek('2026-10-05',[30,90,105]);await show('2026-09-28', [180,270,295])
  })
  await t.test('Active interval clock grows from 15 to 30 minutes and agrees with Backend totals', async () => {
    await show('2026-10-21', [60,30,15])
    await setClock('2026-10-21T10:30:00Z')
    await browser.click('.report-mode button:nth-child(1)')
    // Daily keeps its existing selected-date cache; request the updated day explicitly.
    await changeDate('2026-10-22'); await changeDate('2026-10-21')
    await expectReportSummary(browser,30,30)
    const before = requests.length
    await browser.click('.report-mode button:nth-child(2)'); await assertWeek('2026-10-19', [60,30,30])
    const added = requests.slice(before)
    assert.equal(added.filter(x=>x.path==='/schedule-blocks').length,1)
    assert.equal((await api(`/tasks/${activeTask.id}/time-entries`)).filter(entry => entry.endedAt === null).length, 1)
  })
  await t.test('UTC, Tokyo and New York weekly boundaries match Backend and browser timezone requests', async () => {
    for (const [zone, firstTotal, secondTotal] of [['UTC',295,105],['Asia/Tokyo',265,135],['America/New_York',355,45]]) {
      await load(zone, true)
      await show('2026-09-28', [180,270,firstTotal], zone)
      await show('2026-10-05', [30,90,secondTotal], zone)
      const latest = {timezone:await browser.evaluate('Intl.DateTimeFormat().resolvedOptions().timeZone')}
      assert.equal(latest.timezone, zone)
    }
  })
  await t.test('weekly navigation fetches one Schedule source and never seven Daily requests', async () => {
    const before = requests.length
    await browser.click('.report-period-controls [aria-label="次の期間"]'); await assertWeek('2026-10-12', [0,0,0], 'America/New_York')
    const added = requests.slice(before)
    assert.equal(added.filter(item => item.path === '/schedule-blocks').length, 1)
    // The existing selected-day prefetch is retained; no seven-day frontend aggregation remains.
    assert(added.filter(item => item.path === '/reports/daily').length <= 1)
    assert(!added.some(item => item.path === '/reports/weekly'||item.path==='/reports/monthly'))
  })
  assert.deepEqual(errors, [], 'No browser runtime or forwarding errors')
})
