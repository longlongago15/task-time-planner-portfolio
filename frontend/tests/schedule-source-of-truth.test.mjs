import { openReport, selectReportAnchor, expectReportSummary } from './report-picker.mjs'
import { setTaskFilter } from './current-task-ui.mjs'
import { isolateScenarios } from './scenario-fixture.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { openBrowser } from './browser.mjs'

test('ScheduleBlock is the source of truth across forms Inbox Calendar and Reports', { timeout: 240000 }, async t => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const python = process.env.TIMER_TEST_PYTHON ?? path.join(root, 'backend', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  const directory = await mkdtemp(path.join(tmpdir(), 'task-timer-db-'))
  let backend, browser, base, clockVersion = 0
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  async function setClock(value) {
    const staging = path.join(directory, `clock-${++clockVersion}.txt`)
    await writeFile(staging, value)
    for (let attempt = 0; ; attempt += 1) {
      try { await rename(staging, path.join(directory, 'clock.txt')); break } catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 30) throw error
        await sleep(20)
      }
    }
  }
  t.after(async () => {
    try { await browser?.close() } finally {
      if (backend?.exitCode === null) {
        const exited = new Promise(resolve => backend.once('exit', resolve))
        if (process.platform === 'win32') {
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
  await setClock('2026-10-02T08:00:00Z')
  backend = spawn(python, ['-B', fileURLToPath(new URL('./isolated-backend.py', import.meta.url)), directory], {
    cwd: root, windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = '', log = ''
  backend.stdout.on('data', chunk => { output += chunk.toString() })
  backend.stderr.on('data', chunk => { log += chunk.toString() })
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const port = output.match(/TIMER_TEST_PORT=(\d+)/)?.[1]
    if (port) {
      base = `http://127.0.0.1:${port}`
      try { if ((await fetch(`${base}/health`)).ok) break } catch { /* Starting. */ }
    }
    assert.equal(backend.exitCode, null, `Temporary Backend exited: ${output}\n${log}`)
    if (attempt === 199) assert.fail(`Temporary Backend did not start: ${output}\n${log}`)
    await sleep(50)
  }
  async function api(route, payload, method = 'POST') {
    const response = await fetch(`${base}${route}`, payload === undefined ? {} : {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })
    assert(response.ok, `${route}: ${response.status} ${await response.clone().text()}`)
    return response.json()
  }
  const day = '2026-10-02', movedDay = '2026-10-03', legacyDay = '2026-10-05', scheduledDay = '2026-10-06'
  const legacyOnly = await api('/tasks', { title: 'Legacy only', estimatedMinutes: 20, plannedDate: legacyDay, plannedStartTime: '10:00' })
  const contradiction = await api('/tasks', { title: 'Legacy contradiction', estimatedMinutes: 60, plannedDate: legacyDay, plannedStartTime: '10:00' })
  const contradictionBlock = await api('/schedule-blocks', { taskId: contradiction.id, date: scheduledDay, type: 'TIMED', startTime: '11:00', durationMinutes: 30 })
  const allDay = await api('/tasks', { title: 'All day unestimated', estimatedMinutes: null })
  const allDayBlock = await api('/schedule-blocks', { taskId: allDay.id, date: day, type: 'ALL_DAY' })
  const actualTask = await api('/tasks', { title: 'Actual without schedule', estimatedMinutes: null })
  await api('/tasks/time/start', { taskId: actualTask.id })
  await setClock('2026-10-02T08:10:00Z'); await api('/tasks/time/stop', { taskId: actualTask.id })
  const actualEntry = (await api(`/tasks/${actualTask.id}/time-entries`))[0]
  await setClock('2026-10-02T12:00:00Z')

  browser = await openBrowser()
  await browser.send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' })
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const OriginalDate = Date; const now = ${Date.parse('2026-10-02T12:00:00Z')}; window.confirm = () => true;
    window.Date = class extends OriginalDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
  })()` })
  const requests = [], errors = []
  // CDP interception forwards through Node fetch, bypassing the browser's
  // per-origin HTTP/1 connection queue. Keep the Month's daily requests bounded
  // instead of sending the entire month to the temporary server simultaneously.
  const forwardingQueue = []
  let forwarding = 0
  async function forwardRequest(operation) {
    if (forwarding === 6) await new Promise(resolve => forwardingQueue.push(resolve))
    else forwarding += 1
    try { return await operation() } finally {
      const next = forwardingQueue.shift()
      if (next) next()
      else forwarding -= 1
    }
  }
  browser.listeners.push(message => {
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'warn'].includes(message.params.type)) errors.push(message.params.args)
    if (message.method !== 'Fetch.requestPaused') return
    const { request, requestId } = message.params
    void (async () => {
      if (request.method === 'OPTIONS') { await browser.fulfill(requestId, {}); return }
      const url = new URL(request.url)
      const item = { method: request.method, path: url.pathname, payload: request.postData ? JSON.parse(request.postData) : undefined, finished: false }
      requests.push(item)
      try {
        await forwardRequest(async () => {
          const response = await fetch(`${base}${url.pathname}${url.search}`, {
            method: request.method,
            ...(request.postData ? { headers: { 'Content-Type': 'application/json' }, body: request.postData } : {}),
          })
          item.status = response.status
          const body = await response.text()
          if (!response.headers.get('content-type')?.includes('application/json')) {
            throw new Error(`${request.method} ${url.pathname}: HTTP ${response.status}: ${body}\n${log.slice(-12000)}`)
          }
          await browser.fulfill(requestId, JSON.parse(body), response.status)
        })
      } finally { item.finished = true }
    })().catch(async error => {
      if (/Invalid InterceptionId|Invalid interceptionId|Invalid requestId/.test(error.message)) return
      errors.push(error.message)
      try { await browser.send('Fetch.failRequest', { requestId, errorReason: 'ConnectionFailed' }) } catch { /* Closing. */ }
    })
  })
  // The normal Backend URL is intercepted before contact; all writes use a synthetic temporary DB.
  await browser.send('Fetch.enable', { patterns: [{ urlPattern: 'http://localhost:8000/*', requestStage: 'Request' }] })
  async function settleRequests() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const count = requests.length
      await sleep(100)
      if (count === requests.length && requests.every(item => item.finished)) return
    }
    assert.fail('Background requests did not finish')
  }
  async function setInput(selector, value) {
    await browser.evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      Object.getOwnPropertyDescriptor(input.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(String(value))});
      input.dispatchEvent(new Event('input', {bubbles:true})); input.dispatchEvent(new Event('change', {bubbles:true}));
    })()`)
  }
  async function scheduleReady(mode) {
    await browser.until(`document.querySelector('[aria-label="カレンダー表示"] button:nth-child(${({day:1,week:2,month:3})[mode]})')?.getAttribute('aria-pressed') === 'true'
      && document.querySelector('.calendar-schedule-status') && !document.querySelector('.calendar-schedule-status [role="status"]')`, `${mode} schedules ready`)
    await settleRequests()
  }
  async function calendar(mode, date = day) {
    await settleRequests()
    await browser.until('document.querySelector(".icon-rail [aria-label=ホーム]")', 'Reloaded Home navigation rendered')
    await browser.click('.icon-rail [aria-label="ホーム"]')
    await browser.until('document.querySelector("[aria-label=カレンダー表示]")', 'Calendar mode controls rendered')
    await settleRequests()
    await browser.click('[aria-label="カレンダー表示"] button:nth-child(3)')
    await scheduleReady('month')
    if (mode === 'month') return
    await browser.click(`.month-day[data-date="${date}"]`)
    await browser.click('.calendar-dialog [aria-label="予定の操作を閉じる"]')
    await browser.click('[aria-label="カレンダー表示"] button:nth-child(1)')
    await scheduleReady('day')
    if (mode === 'week') {
      await browser.click('[aria-label="カレンダー表示"] button:nth-child(2)')
      await scheduleReady('week')
    }
  }
  const blockSelector = id => `[data-schedule-block-id="${id}"]`
  const inboxSelector = id => `[data-inbox-task-id="${id}"]`
  async function drag(source, destination, minute = 600) {
    await browser.until(`document.querySelector(${JSON.stringify(source)}) && document.querySelector(${JSON.stringify(destination)})`, 'Drag source and destination')
    await browser.evaluate(`(() => {
      const source = document.querySelector(${JSON.stringify(source)}), destination = document.querySelector(${JSON.stringify(destination)});
      const dataTransfer = new DataTransfer(), bounds = destination.getBoundingClientRect();
      const options = {bubbles:true,cancelable:true,dataTransfer,clientX:bounds.left+bounds.width/2,clientY:bounds.top+bounds.height*${minute}/1440};
      source.dispatchEvent(new DragEvent('dragstart', options)); destination.dispatchEvent(new DragEvent('dragover', options));
      destination.dispatchEvent(new DragEvent('drop', options)); source.dispatchEvent(new DragEvent('dragend', options));
    })()`)
    await settleRequests()
    // Network completion can precede the retained Calendar's replacement render.
    await browser.until("!document.querySelector('.calendar-schedule-status [role=\"status\"]')", 'Calendar updated after drag')
  }
  const daily = date => api(`/reports/daily?date=${date}&timezone=UTC`)
  const values = report => [report.dailyEstimatedMinutes, report.plannedOccupiedMinutes, report.dailyActualMinutes]
  async function showDaily(date, expected) {
    await openReport(browser,'day')
    await selectReportAnchor(browser,date)
    assert.deepEqual(values(await daily(date)),expected)
    await expectReportSummary(browser,expected[1],expected[2])
  }
  async function taskList() {
    await browser.until('document.querySelector(".icon-rail [aria-label=タスク]")', 'Reloaded Task navigation rendered')
    await browser.click('.icon-rail [aria-label="タスク"]')
    await browser.click('.icon-rail [aria-label="タスク"]')
    await browser.until('document.querySelector(".task-list-toolbar")', 'Current Task browsing controls')
    await settleRequests()
  }
  let unknown, unsetTask, timedTask, timedBlock
  await browser.navigate()
  await browser.until("document.querySelector('.timer-task-picker input')?.disabled === false && document.querySelector('.unplanned-list')", 'Initial Tasks loaded')
  await settleRequests()

  const scenarioNames = ['title-only', 'TIME_UNSET', 'direct TIMED', 'moving one', 'releasing', 'multiple Blocks', 'Legacy-only', 'Task editing', 'Home uses', 'ALL_DAY', 'Daily Weekly']
  await isolateScenarios(t, { browser, directory, python,
    prepare: async name => {
      const index = scenarioNames.findIndex(prefix => name.startsWith(prefix))
      assert(index >= 0, `Missing independent fixture for ${name}`)
      if (index > 0) {
        unknown = await api('/tasks', { title: 'Title only', estimatedMinutes: null })
        unsetTask = await api('/tasks', { title: 'Unset source', estimatedMinutes: 60 })
        timedTask = await api('/tasks', { title: 'Timed source', estimatedMinutes: 120 })
      }
      if (index >= 2) await api('/schedule-blocks', { taskId: unsetTask.id, date: day, type: 'TIME_UNSET' })
      if (index === 3 || index === 4) timedBlock = await api('/schedule-blocks', { taskId: timedTask.id, date: index === 4 ? movedDay : day, type: 'TIMED', startTime: index === 4 ? '10:30' : '10:00', durationMinutes: 60 })
      if (index >= 6) for (const [startTime, durationMinutes] of [['09:00', 30], ['13:00', 45]]) await api('/schedule-blocks', { taskId: timedTask.id, date: day, type: 'TIMED', startTime, durationMinutes })
    }, ready: () => calendar('week'),
  })
  await t.test('title-only and estimated Tasks create no schedule and omit Legacy fields', async () => {
    await taskList()
    const created = []
    for (const [title, estimate] of [['Title only', ''], ['Unset source', '60'], ['Timed source', '120']]) {
      await browser.click('.task-list-tools .primary-action')
      assert(await browser.evaluate("[...document.querySelectorAll('.task-form [name=date],.task-form [name=startTime]')].every(e=>e.value==='')"))
      await setInput('.task-form [name=title]', title)
      await setInput('.task-form [name=estimatedMinutes]', estimate)
      await browser.click('.task-form button[type="submit"]')
      await browser.until("!document.querySelector('.task-composer')", 'Task saved')
      await settleRequests()
      const item = (await api('/tasks')).find(task => task.title === title)
      assert.equal(item.plannedDate, null); assert.equal(item.plannedStartTime, null)
      assert.deepEqual(await api(`/schedule-blocks?taskId=${item.id}`), [])
      assert((await api('/tasks?inbox=true')).some(task => task.id === item.id))
      created.push(item)
    }
    ;[unknown, unsetTask, timedTask] = created
    assert.equal(unknown.estimatedMinutes, null)
    await calendar('week')
    for (const item of created) {
      assert(await browser.evaluate(`Boolean(document.querySelector(${JSON.stringify(inboxSelector(item.id))}))`))
      assert.equal(await browser.evaluate(`document.querySelectorAll('[data-schedule-block-id][data-task-id="${item.id}"]').length`), 0)
    }
  })

  await t.test('TIME_UNSET placement appears in Day Month Report and leaves Inbox', async () => {
    await drag(inboxSelector(unsetTask.id), `[data-drop-date="${day}"]`)
    const [block] = await api(`/schedule-blocks?taskId=${unsetTask.id}`)
    assert.equal(block.type, 'TIME_UNSET')
    assert(!(await api('/tasks?inbox=true')).some(task => task.id === unsetTask.id))
    await calendar('day')
    assert(await browser.evaluate(`Boolean(document.querySelector('.calendar-time-unset-row ${blockSelector(block.id)}'))`))
    assert.equal(await browser.evaluate(`document.querySelector('.calendar-plan-lane [data-task-id="${unsetTask.id}"]') === null`), true)
    await calendar('month')
    assert(await browser.evaluate(`Boolean(document.querySelector('.month-day[data-date="${day}"] ${blockSelector(block.id)}'))`))
    await showDaily(day, [60, 0, 10])
    assert((await daily(day)).tasks.some(row => row.taskId === unsetTask.id))
  })

  await t.test('direct TIMED placement agrees in Week Day Month and Report independently of estimate', async () => {
    await calendar('week')
    await drag(inboxSelector(timedTask.id), `[data-timed-drop-date="${day}"]`, 600)
    ;[timedBlock] = await api(`/schedule-blocks?taskId=${timedTask.id}`)
    assert.equal(timedBlock.type, 'TIMED'); assert.equal(timedBlock.startTime, '10:00:00')
    assert.equal(timedBlock.durationMinutes, 60); assert.equal(timedTask.estimatedMinutes, 120)
    assert(await browser.evaluate(`Boolean(document.querySelector('.calendar-plan-lane ${blockSelector(timedBlock.id)}'))`))
    await calendar('day')
    assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(blockSelector(timedBlock.id))}).style.height`), '54px')
    assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(blockSelector(timedBlock.id))}).dataset.scheduleType`), 'TIMED')
    await calendar('month')
    assert(await browser.evaluate(`Boolean(document.querySelector('.month-day[data-date="${day}"] ${blockSelector(timedBlock.id)}'))`))
    await showDaily(day, [180, 60, 10])
  })

  await t.test('moving one Block updates both Day and Month cells and both daily estimates', async () => {
    await calendar('week')
    await drag(blockSelector(timedBlock.id), `[data-timed-drop-date="${movedDay}"]`, 630)
    const [stored] = await api(`/schedule-blocks?taskId=${timedTask.id}`)
    assert.equal(stored.id, timedBlock.id); assert.equal(stored.date, movedDay)
    assert.equal(stored.startTime, '10:30:00')
    await calendar('day', day)
    assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(blockSelector(timedBlock.id))}) === null`), true)
    await calendar('month')
    assert.equal(await browser.evaluate(`document.querySelector('.month-day[data-date="${day}"] ${blockSelector(timedBlock.id)}') === null`), true)
    assert(await browser.evaluate(`Boolean(document.querySelector('.month-day[data-date="${movedDay}"] ${blockSelector(timedBlock.id)}'))`))
    await browser.click(`.month-day[data-date="${movedDay}"]`); await browser.click('.calendar-dialog [aria-label="予定の操作を閉じる"]'); await browser.click('[aria-label="カレンダー表示"] button:nth-child(1)'); await scheduleReady('day')
    assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(blockSelector(timedBlock.id))}).dataset.date`), movedDay)
    await showDaily(day, [60, 0, 10]); await showDaily(movedDay, [120, 60, 0])
  })

  await t.test('releasing the final Block from Day removes the plan and returns the Task to Inbox', async () => {
    await calendar('day', movedDay)
    await browser.click(blockSelector(timedBlock.id))
    await browser.until('document.querySelector(".calendar-dialog-actions .danger")', 'Release in Popover')
    await browser.click('.calendar-dialog-actions .danger')
    await browser.until(`!document.querySelector(${JSON.stringify(blockSelector(timedBlock.id))}) && document.querySelector(${JSON.stringify(inboxSelector(timedTask.id))})`, 'Released plan and restored Inbox')
    assert.deepEqual(await api(`/schedule-blocks?taskId=${timedTask.id}`), [])
    await calendar('month')
    assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(blockSelector(timedBlock.id))}) === null`), true)
    await showDaily(movedDay, [0, 0, 0])
  })

  await t.test('multiple Blocks retain separate IDs across Calendars but one daily estimate', async () => {
    const first = await api('/schedule-blocks', { taskId: timedTask.id, date: day, type: 'TIMED', startTime: '09:00', durationMinutes: 30 })
    const second = await api('/schedule-blocks', { taskId: timedTask.id, date: day, type: 'TIMED', startTime: '13:00', durationMinutes: 45 })
    await browser.navigate(true); await settleRequests()
    for (const mode of ['week', 'day', 'month']) {
      await calendar(mode)
      if (mode === 'month') {
        // The compact Month cell shows three blocks and counts the remaining blocks as overflow.
        assert(await browser.evaluate(`Boolean(document.querySelector(${JSON.stringify(blockSelector(first.id))}))`))
        assert.equal(await browser.evaluate(`document.querySelector('.month-day[data-date="${day}"] .month-overflow')?.textContent`), '+1件')
      } else {
        for (const block of [first, second]) assert(await browser.evaluate(`Boolean(document.querySelector(${JSON.stringify(blockSelector(block.id))}))`))
        assert.equal(await browser.evaluate(`document.querySelectorAll('[data-schedule-block-id][data-task-id="${timedTask.id}"]').length`), 2)
      }
    }
    const report = await daily(day)
    assert.equal(report.tasks.filter(row => row.taskId === timedTask.id).length, 1)
    await showDaily(day, [180, 75, 10])
  })

  await t.test('Legacy-only dates are absent and a contradictory Block uses only its own day', async () => {
    await calendar('day', legacyDay)
    for (const item of [legacyOnly, contradiction]) assert.equal(await browser.evaluate(`document.querySelector('[data-schedule-block-id][data-task-id="${item.id}"]') === null`), true)
    assert(await browser.evaluate(`Boolean(document.querySelector(${JSON.stringify(inboxSelector(legacyOnly.id))}))`))
    await calendar('month')
    assert.equal(await browser.evaluate(`document.querySelector('.month-day[data-date="${legacyDay}"] [data-task-id="${contradiction.id}"]') === null`), true)
    assert(await browser.evaluate(`Boolean(document.querySelector('.month-day[data-date="${scheduledDay}"] ${blockSelector(contradictionBlock.id)}'))`))
    await calendar('day', scheduledDay)
    assert(await browser.evaluate(`Boolean(document.querySelector(${JSON.stringify(blockSelector(contradictionBlock.id))}))`))
    await showDaily(legacyDay, [0, 0, 0]); await showDaily(scheduledDay, [60, 30, 0])
    const paths = ['/reports/daily?date=2026-10-06&timezone=UTC', '/reports/weekly?date=2026-10-06&timezone=UTC', '/reports/monthly?month=2026-10&timezone=UTC']
    const before = await Promise.all(paths.map(route => api(route)))
    await api(`/tasks/${contradiction.id}`, { plannedDate: '2026-10-07', plannedStartTime: '18:00' }, 'PUT')
    assert.deepEqual(await Promise.all(paths.map(route => api(route))), before)
    await browser.navigate(true); await settleRequests()
    await calendar('day', '2026-10-07')
    assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(blockSelector(contradictionBlock.id))}) === null`), true)
    await calendar('day', scheduledDay)
    assert(await browser.evaluate(`Boolean(document.querySelector(${JSON.stringify(blockSelector(contradictionBlock.id))}))`))
  })

  await t.test('Task editing omits Legacy fields and preserves existing compatibility values', async () => {
    await taskList()
    const before = await api(`/tasks/${contradiction.id}`)
    await browser.click(`[data-task-id="${contradiction.id}"] .task-row-menu summary`)
    await browser.click(`[data-task-id="${contradiction.id}"] .task-row-edit`)
    assert(await browser.evaluate("[...document.querySelectorAll('.task-form [name=date],.task-form [name=startTime]')].every(e=>e.value==='')"))
    await setInput('.task-form [name=title]', 'Legacy contradiction renamed')
    await browser.click('.task-form button[type="submit"]')
    await browser.until("!document.querySelector('.task-composer')", 'Legacy Task title saved')
    await settleRequests()
    const stored = await api(`/tasks/${contradiction.id}`)
    assert.equal(stored.plannedDate, before.plannedDate); assert.equal(stored.plannedStartTime, before.plannedStartTime)
    assert.deepEqual((await api(`/schedule-blocks?taskId=${contradiction.id}`))[0], contradictionBlock)
    assert.equal((await daily(scheduledDay)).tasks[0].title, 'Legacy contradiction renamed')
  })

  await t.test('Home uses combined and timed schedules without a second Today list, while the Task filter deduplicates', async () => {
    await calendar('day')
    assert(await browser.evaluate("!document.querySelector('.today-tasks-panel')"))
    const sorted = values => [...values].sort((a,b)=>a-b)
    const blocks = await api('/schedule-blocks'), allTasks = await api('/tasks')
    const todayIds = sorted(new Set(await browser.evaluate("Array.from(document.querySelectorAll('.calendar-combined-row [data-task-id], .calendar-plan-lane [data-task-id]')).map(e=>Number(e.dataset.taskId))")))
    assert.deepEqual(todayIds,sorted([allDay.id,unsetTask.id,timedTask.id]))
    assert.deepEqual(todayIds,sorted(new Set(blocks.filter(block=>block.date===day).map(block=>block.taskId))))
    assert.equal(blocks.filter(block=>block.taskId===timedTask.id&&block.date===day).length,2,'Two Blocks still represent one Task')
    const allScheduled = sorted(new Set(blocks.map(block=>block.taskId)))
    assert.deepEqual(allScheduled,sorted([...todayIds,contradiction.id]))
    assert.deepEqual(blocks.filter(block=>block.taskId===contradiction.id).map(block=>block.date),[scheduledDay])
    assert.equal((await api(`/tasks/${legacyOnly.id}`)).plannedDate,legacyDay)
    assert(!allScheduled.includes(legacyOnly.id),'Legacy dates alone do not create placement')
    await taskList(); await setTaskFilter(browser,'placement',['scheduled'])
    const rows = () => browser.evaluate("Array.from(document.querySelectorAll('.task-table-row[data-task-id]')).map(e=>Number(e.dataset.taskId))")
    await browser.until(`document.querySelectorAll('.task-table-row').length===${allScheduled.length}`,'All-period scheduled rows rendered')
    const scheduledRows = await rows()
    assert.deepEqual(sorted(scheduledRows),allScheduled)
    assert.equal(scheduledRows.filter(id=>id===timedTask.id).length,1,'Multiple Blocks do not duplicate the Task Row')
    const expectedInbox = sorted(allTasks.filter(task=>!allScheduled.includes(task.id)).map(task=>task.id))
    const inboxIds = sorted((await api('/tasks?inbox=true')).map(task=>task.id))
    assert.deepEqual(inboxIds,expectedInbox)
    await setTaskFilter(browser,'placement',['unplanned'])
    await browser.until(`document.querySelectorAll('.task-table-row').length===${expectedInbox.length}`,'Unplanned rows rendered')
    assert.deepEqual(sorted(await rows()),expectedInbox)
    assert(inboxIds.includes(legacyOnly.id)&&inboxIds.includes(actualTask.id))
    assert(!inboxIds.some(id=>allScheduled.includes(id)),'Inbox and scheduled Tasks are disjoint')
    console.log('Placement sets',JSON.stringify({day,scheduledDay,todayIds,allScheduled,inboxIds,timedTaskId:timedTask.id,contradictionId:contradiction.id,legacyOnlyId:legacyOnly.id}))
  })

  await t.test('ALL_DAY is outside the time axis and Day actual geometry uses TimeEntry only', async () => {
    await calendar('day')
    assert(await browser.evaluate(`Boolean(document.querySelector('.calendar-all-day-row ${blockSelector(allDayBlock.id)}'))`))
    assert.equal(await browser.evaluate(`document.querySelector('.calendar-plan-lane ${blockSelector(allDayBlock.id)}') === null`), true)
    const actualSelector = `.calendar-actual-lane [data-time-entry-id="${actualEntry.id}"]`
    await browser.until(`document.querySelector(${JSON.stringify(actualSelector)})`, 'Day actual entry')
    assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(actualSelector)}).style.top`), '432px')
    assert(await browser.evaluate(`document.querySelector(${JSON.stringify(actualSelector)}).textContent.includes('10分')`))
    assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(actualSelector)}).textContent.includes('08:00–08:10')`), false)
    assert.deepEqual(await api(`/schedule-blocks?taskId=${actualTask.id}`), [])
  })

  await t.test('Daily Weekly Monthly agree on each day and retain actual totals', async () => {
    const weekly = await api(`/reports/weekly?date=${day}&timezone=UTC`)
    const monthly = await api('/reports/monthly?month=2026-10&timezone=UTC')
    for (const report of [weekly, monthly]) {
      for (const row of report.daily) assert.deepEqual(row, await daily(row.date))
    }
    for (const [report, prefix] of [[weekly, 'weekly'], [monthly, 'monthly']]) {
      assert.equal(report[`${prefix}EstimatedMinutes`], report.daily.reduce((sum, row) => sum + row.dailyEstimatedMinutes, 0))
      assert.equal(report[`${prefix}PlannedOccupiedMinutes`], report.daily.reduce((sum, row) => sum + row.plannedOccupiedMinutes, 0))
      assert.equal(report[`${prefix}ActualMinutes`], 10)
    }
    await showDaily(day, [180, 75, 10])
    for (const [mode, report, prefix] of [[2, weekly, 'weekly'], [3, monthly, 'monthly']]) {
      await browser.click(`.report-mode button:nth-child(${mode})`)
      await selectReportAnchor(browser,day)
      await expectReportSummary(browser,report[prefix+'PlannedOccupiedMinutes'],report[prefix+'ActualMinutes'])
    }
  })
  assert.deepEqual(errors, [], 'No browser crashes or API forwarding failures')
  assert.deepEqual(requests.filter(item => item.status >= 400), [], 'No unexpected API failures')
  for (const request of requests.filter(item => ['POST', 'PUT'].includes(item.method) && /^\/tasks(?:\/\d+)?$/.test(item.path))) {
    assert.equal(Object.hasOwn(request.payload, 'plannedDate'), false)
    assert.equal(Object.hasOwn(request.payload, 'plannedStartTime'), false)
  }
})
