import { selectReportAnchor, expectReportSummary, releaseReportResponse } from './report-picker.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { openBrowser } from './browser.mjs'

test('Daily Report preserves Backend estimate contracts and displayed interval metrics on an isolated DB', { timeout: 120000 }, async t => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const python = process.env.TIMER_TEST_PYTHON ?? path.join(root, 'backend', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  const directory = await mkdtemp(path.join(tmpdir(), 'task-timer-db-'))
  let backend
  let browser
  let base
  let now
  let clockVersion = 0
  const setClock = async value => {
    const staging = path.join(directory, `clock-${++clockVersion}.txt`)
    await writeFile(staging, value)
    await rename(staging, path.join(directory, 'clock.txt'))
    now=Date.parse(value)
    if(browser) await browser.evaluate('window.__dailyNow='+now+';localStorage.setItem("__dailyTestNow",String(window.__dailyNow));document.dispatchEvent(new Event("visibilitychange"));undefined')
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
  async function api(route, payload) {
    const response = await fetch(`${base}${route}`, payload === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })
    assert(response.ok, `${route}: ${response.status} ${await response.clone().text()}`)
    return response.json()
  }
  const block = (task, date, startTime, durationMinutes) => api('/schedule-blocks', {
    taskId: task.id, date, type: 'TIMED', startTime, durationMinutes,
  })
  const unestimated=new Map()
  async function seed(date, estimate, occupied, actual) {
    const task = await api('/tasks', { title: `Daily ${date}`, estimatedMinutes: estimate })
    // Include an unestimated Task; the Backend aggregate must remain authoritative.
    const unknown = await api('/tasks', { title: `Unestimated ${date}`, estimatedMinutes: null })
    unestimated.set(date,unknown)
    await api('/schedule-blocks', { taskId: unknown.id, date, type: 'TIME_UNSET' })
    if (occupied) await block(task, date, '10:00', occupied)
    else await api('/schedule-blocks', { taskId: task.id, date, type: 'TIME_UNSET' })
    if (actual) {
      await setClock(`${date}T08:00:00+00:00`)
      await api('/tasks/time/start', { taskId: task.id })
      await setClock(new Date(Date.parse(`${date}T08:00:00Z`) + actual * 60000).toISOString())
      await api('/tasks/time/stop', { taskId: task.id })
    }
    return task
  }
  await seed('2026-10-02', 180, 120, 95)
  await seed('2026-10-03', 30, 0, 45)
  await seed('2026-10-05', 60, 120, 30)
  await seed('2026-10-06', 60, 30, 90)
  await seed('2026-10-07', 60, 60, 0)
  const overlapPeer = await api('/tasks', { title: 'Different Task overlap', estimatedMinutes: null })
  await block(overlapPeer, '2026-10-07', '10:30', 60)
  const overnight = await seed('2026-10-08', 60, 0, 0)
  await block(overnight, '2026-10-08', '23:30', 120)
  const activeTask = await seed('2026-10-10', 60, 30, 0)
  const calendarTask = await api('/tasks', { title: 'Calendar regression', estimatedMinutes: 30 })
  const conflictTask = await api('/tasks', { title: 'Calendar conflict regression', estimatedMinutes: null })
  await setClock('2026-10-10T09:00:00+00:00')
  await api('/tasks/time/start', { taskId: activeTask.id })
  await setClock('2026-10-10T09:10:00+00:00')

  browser = await openBrowser()
  await browser.send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' })
  await browser.send('Page.addScriptToEvaluateOnNewDocument',{source:'(()=>{const D=Date;window.__dailyNow=Number(localStorage.getItem("__dailyTestNow"))||'+now+';window.Date=class extends D{constructor(...a){super(...(a.length?a:[window.__dailyNow]))}static now(){return window.__dailyNow}}})()'})
  const canceled=new Set()
  const errors = []
  const requests = []
  let failDate
  let holdDate
  let held
  browser.listeners.push(message => {
    if(message.method==='Network.loadingFailed'&&message.params.canceled)canceled.add(message.params.requestId)
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method !== 'Fetch.requestPaused') return
    const { request, requestId } = message.params
    void (async () => {
      if (request.method === 'OPTIONS') { await browser.fulfill(requestId, {}); return }
      const url = new URL(request.url)
      requests.push({ method: request.method, path: url.pathname, date: url.searchParams.get('date'), endDate:url.searchParams.get('endDate'), timezone: url.searchParams.get('timezone') })
      if (url.pathname === '/schedule-blocks' && url.searchParams.get('endDate') === failDate) {
        await browser.fulfill(requestId, { detail: 'Test daily API failure' }, 500); return
      }
      const response = await fetch(`${base}${url.pathname}${url.search}`, {
        method: request.method,
        ...(request.postData ? { headers: { 'Content-Type': 'application/json' }, body: request.postData } : {}),
      })
      const body = await response.json()
      if (url.pathname === '/schedule-blocks' && url.searchParams.get('endDate') === holdDate) {
        held = { requestId, body, status: response.status, networkId:message.params.networkId }; await browser.evaluate('window.__heldReport=true'); return
      }
      await browser.fulfill(requestId, body, response.status)
    })().catch(async error => {
      if (/Invalid InterceptionId|Invalid interceptionId|Invalid requestId/.test(error.message)) return
      errors.push(error.message)
      try { await browser.send('Fetch.failRequest', { requestId, errorReason: 'ConnectionFailed' }) } catch { /* Reloaded. */ }
    })
  })
  // Every production API URL is intercepted before contact and forwarded only to the guarded temporary Backend.
  await browser.send('Fetch.enable', { patterns: [{ urlPattern: 'http://localhost:8000/*', requestStage: 'Request' }] })
  const summary = () => browser.evaluate('Array.from(document.querySelectorAll(".report-summary strong")).map(e=>e.textContent)')
  async function changeDate(date) { await selectReportAnchor(browser,date,{wait:false}) }
  async function expectMetrics(date,values) {
    const response=await api('/reports/daily?date='+date+'&timezone=UTC')
    assert.deepEqual([response.dailyEstimatedMinutes,response.plannedOccupiedMinutes,response.dailyActualMinutes],values)
    await expectReportSummary(browser,values[1],values[2])
  }
  async function show(date, values) { await changeDate(date); await expectMetrics(date, values) }
  await browser.navigate()
  await browser.until("document.querySelector('.timer-session:not(.paused)') !== null", 'Persisted Active restored')
  await browser.click('.icon-rail [aria-label="レポート"]')
  await t.test('values and estimate > occupied > actual are separate; NULL estimate stays unestimated', async () => {
    await show('2026-10-02', [180, 120, 95])
    assert.equal((await api('/tasks/'+unestimated.get('2026-10-02').id)).estimatedMinutes,null,'NULL estimate remains unset; Reports no longer displays estimates')
  })
  await t.test('all zero is visibly zero', async () => { await show('2026-10-04', [0, 0, 0]) })
  await t.test('occupied exceeds estimate without clamping', async () => { await show('2026-10-05', [60, 120, 30]) })
  await t.test('actual exceeds occupied without clamping', async () => { await show('2026-10-06', [60, 30, 90]) })
  await t.test('date change replaces all three metrics', async () => {
    await show('2026-10-02', [180, 120, 95]); await show('2026-10-03', [30, 0, 45])
  })
  await t.test('reload retrieves the same values from the Backend', async () => {
    await show('2026-10-02', [180, 120, 95])
    const before = requests.filter(item => item.path === '/reports/daily').length
    await browser.navigate(true)
    await browser.until("document.querySelector('.timer-session:not(.paused)') !== null", 'Reload Active')
    await browser.click('.icon-rail [aria-label="レポート"]')
    await show('2026-10-02', [180, 120, 95])
    assert(requests.filter(item => item.path === '/reports/daily').length > before)
  })
  await t.test('refresh retains every displayed metric and a stale response cannot overwrite the new date', async () => {
    const retained=await summary()
    holdDate = '2026-10-03'
    await changeDate(holdDate)
    await browser.until('window.__heldReport===true','Report Schedule response held')
    assert.deepEqual(await summary(),retained)
    assert(held,'Held real Schedule source')
    assert(held, 'Real Backend response held')
    holdDate = undefined
    await show('2026-10-05', [60, 120, 30])
    await releaseReportResponse(browser,held,canceled)
    held = undefined
    await browser.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
    await expectMetrics('2026-10-05', [60, 120, 30])
  })
  await t.test('API 500 retains the complete displayed Report and Retry recovers', async () => {
    const retained=await summary()
    failDate = '2026-10-03'
    await changeDate(failDate)
    await browser.until('document.querySelector(".reports-v2 [role=alert]")?.textContent.includes("\u30ec\u30dd\u30fc\u30c8\u306e\u4e88\u5b9a\u3092\u53d6\u5f97\u3067\u304d\u307e\u305b\u3093\u3067\u3057\u305f")','Report source Error')
    assert.deepEqual(await summary(),retained)
    assert.equal(await browser.evaluate('!!document.querySelector(".report-summary") && !document.querySelector(".reports-v2 [role=status]")'),true)
    failDate = undefined
    await browser.click('.reports-v2 [role=alert] button');await expectMetrics('2026-10-03',[30,0,45])
    await show('2026-10-02', [180, 120, 95])
  })
  await t.test('Active TimeEntry grows from 10 to 20 minutes and agrees with Backend clipping', async () => {
    await show('2026-10-10', [60, 30, 10])
    await setClock('2026-10-10T09:20:00+00:00')
    await show('2026-10-03', [30, 0, 45]); await show('2026-10-10', [60, 30, 20])
    assert.equal((await api(`/tasks/${activeTask.id}/time-entries`)).filter(entry => entry.endedAt === null).length, 1)
  })
  await t.test('overlapping ScheduleBlocks display the Backend union of 90 minutes', async () => { await show('2026-10-07', [60, 90, 0]) })
  await t.test('a previous-day ScheduleBlock contributes its task estimate and 90 occupied minutes', async () => { await show('2026-10-09', [60, 90, 0]) })
  await t.test('narrow summary cards fit without horizontal scrolling', async () => {
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false })
    assert.equal(await browser.evaluate("(() => { const grid = document.querySelector('.report-summary'); return grid.scrollWidth <= grid.clientWidth && Array.from(grid.children).every(item => item.getBoundingClientRect().right <= 375 && item.scrollWidth <= item.clientWidth) })()"), true)
  })
  await t.test('Report fetches its Schedule source once without per-day summary fanout', async () => {
    const before = requests.length
    await show('2026-10-03', [30, 0, 45])
    const added = requests.slice(before)
    assert.equal(added.filter(x=>x.path==='/schedule-blocks'&&x.endDate==='2026-10-03').length,1)
    assert(added.filter(x=>x.path==='/reports/daily').length<=1)
    assert(!added.some(x=>x.path==='/reports/weekly'||x.path==='/reports/monthly'))
    assert.equal(await browser.evaluate('Intl.DateTimeFormat().resolvedOptions().timeZone'),'UTC')

  })
  await t.test('returning Home preserves week Calendar, Inbox, DnD, Resize, overlap warning and unscheduling', async child => {
    // Observe real post-gesture suppression completion; do not sleep or retry a click.
    await browser.evaluate(`(()=>{
      const original=window.setTimeout, timeout=original.bind(window), pending=new Set();
      window.setTimeout=(callback,delay,...args)=>{
        if(delay!==300||typeof callback!=='function')return timeout(callback,delay,...args);
        let resolve;const done=new Promise(ready=>{resolve=ready});pending.add(done);
        return timeout(()=>{try{return callback.apply(window,args)}finally{pending.delete(done);resolve()}},delay);
      };
      window.__calendarGesturesSettled=()=>Promise.all([...pending]);
      window.__restoreCalendarGestureTimers=()=>{window.setTimeout=original;delete window.__calendarGesturesSettled;delete window.__restoreCalendarGestureTimers};
    })()`)
    child.after(()=>browser.evaluate('window.__restoreCalendarGestureTimers?.()'))

    await browser.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false })
    await browser.click('.icon-rail [aria-label="ホーム"]')
    const inboxSelector = `[data-inbox-task-id="${calendarTask.id}"]`
    await browser.until(`document.querySelector(${JSON.stringify(inboxSelector)}) && document.querySelectorAll('[data-timed-drop-date]').length === 7`, 'Week Calendar and Inbox')
    const dates = await browser.evaluate("Array.from(document.querySelectorAll('[data-timed-drop-date]')).map(item => item.dataset.timedDropDate)")
    const timedSelector = date => `[data-timed-drop-date="${date}"]`
    async function drag(source, destination, minute) {
      // Timer background refresh can temporarily replace the Inbox between separate CDP calls.
      // Check the elements and dispatch one drag atomically, retrying only before dispatch.
      await browser.until(`(() => {
        const source = document.querySelector(${JSON.stringify(source)}), destination = document.querySelector(${JSON.stringify(destination)});
        if (!source || !destination || source.getAttribute('aria-busy') === 'true' || document.querySelector('.calendar-schedule-status [role="status"]')) return false;
        const dataTransfer = new DataTransfer(), rect = destination.getBoundingClientRect();
        const options = {bubbles:true,cancelable:true,dataTransfer,clientX:rect.left+rect.width/2,clientY:rect.top+rect.height*${minute}/1440};
        source.dispatchEvent(new DragEvent('dragstart', options));
        destination.dispatchEvent(new DragEvent('dragover', options));
        destination.dispatchEvent(new DragEvent('drop', options));
        source.dispatchEvent(new DragEvent('dragend', options));
        return true;
      })()`, 'Drag source and week data ready')
    }
    await drag(inboxSelector, timedSelector(dates[0]), 600)
    await browser.until(`document.querySelector('.weekly-schedule-event[data-task-id="${calendarTask.id}"]') && !document.querySelector(${JSON.stringify(inboxSelector)})`, 'Inbox placement creates a ScheduleBlock')
    const rows = await api(`/schedule-blocks?dateFrom=${dates[0]}&dateTo=${dates[6]}`)
    const placed = rows.find(row => row.taskId === calendarTask.id)
    assert(placed)
    assert.equal(placed.durationMinutes, 60, 'Inbox placement is independent of the Task estimate')
    const blockSelector = `[data-schedule-block-id="${placed.id}"]`
    await drag(blockSelector, timedSelector(dates[1]), 630)
    await browser.until(`document.querySelector(${JSON.stringify(blockSelector)})?.dataset.date === ${JSON.stringify(dates[1])} && document.querySelector(${JSON.stringify(blockSelector)})?.getAttribute('aria-busy') === 'false'`, 'Existing block moved')
    const moved = (await api(`/schedule-blocks?dateFrom=${dates[0]}&dateTo=${dates[6]}`)).find(row => row.id === placed.id)
    assert.equal(moved.date, dates[1]); assert.equal(moved.startTime, '10:30:00')

    const handleSelector = `${blockSelector} .schedule-resize-handle`
    await browser.evaluate(`document.querySelector(${JSON.stringify(handleSelector)}).scrollIntoView({block:'center'})`)
    const pointer = await browser.evaluate(`(() => { const handle = document.querySelector(${JSON.stringify(handleSelector)}).getBoundingClientRect(); const column = document.querySelector(${JSON.stringify(timedSelector(dates[1]))}).getBoundingClientRect(); return {x:handle.left+handle.width/2,y:handle.top+handle.height/2,delta:column.height*30/1440} })()`)
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pointer.x, y: pointer.y })
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pointer.x, y: pointer.y, button: 'left', clickCount: 1 })
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pointer.x, y: pointer.y + pointer.delta, button: 'left', buttons: 1 })
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pointer.x, y: pointer.y + pointer.delta, button: 'left', clickCount: 1 })
    await browser.until(`document.querySelector(${JSON.stringify(blockSelector)})?.title.includes('1時間30分') && document.querySelector(${JSON.stringify(blockSelector)})?.getAttribute('aria-busy') === 'false'`, 'Resize persisted')
    assert.equal((await api(`/schedule-blocks?dateFrom=${dates[0]}&dateTo=${dates[6]}`)).find(row => row.id === placed.id).durationMinutes, 90)

    await block(conflictTask, dates[1], '11:00', 60)
    await browser.click('.calendar-mode-switch button:nth-child(2)')
    await browser.until(`document.querySelector(${JSON.stringify(blockSelector + ' .schedule-overlap-warning')})`, 'Overlap warning retained')
    assert.equal((await api(`/tasks/${calendarTask.id}`)).estimatedMinutes, 30)
    await browser.evaluate('window.__calendarGesturesSettled()')
    await browser.click(blockSelector)
    await browser.until('document.querySelector(".calendar-dialog-actions .danger")', 'Release in Popover')
    await browser.click('.calendar-dialog-actions .danger')
    await browser.until(`!document.querySelector(${JSON.stringify(blockSelector)}) && document.querySelector(${JSON.stringify(inboxSelector)})`, 'Unscheduling returns the Task to Inbox')
    assert(!(await api(`/schedule-blocks?dateFrom=${dates[0]}&dateTo=${dates[6]}`)).some(row => row.id === placed.id))
    assert.equal((await api(`/tasks/${calendarTask.id}`)).estimatedMinutes, 30)
  })
  assert.deepEqual(errors, [], 'No browser runtime or API forwarding errors')
})
