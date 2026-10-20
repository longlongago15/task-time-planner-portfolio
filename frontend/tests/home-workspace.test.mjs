import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { openBrowser, selectTimerTask, pauseOrResumeTimer } from './browser.mjs'

test('Home workspace interactions use existing APIs on a guarded temporary DB', { timeout: 180000 }, async t => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const python = process.env.TIMER_TEST_PYTHON ?? path.join(root, 'backend', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  const directory = await mkdtemp(path.join(tmpdir(), 'task-timer-db-'))
  const day = '2026-10-03'
  let browser, backend, base, clockVersion = 0
  let now = Date.parse(`${day}T12:00:00+09:00`)
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  async function setClock(value) {
    now = Date.parse(value)
    const staging = path.join(directory, `clock-${++clockVersion}.txt`)
    await writeFile(staging, value)
    for (let attempt = 0; ; attempt++) {
      try { await rename(staging, path.join(directory, 'clock.txt')); break } catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 30) throw error
        await sleep(20)
      }
    }
    if (browser) await browser.evaluate(`window.__homeNow=${now}; for(const callback of window.__homeMinuteTicks.values())callback(); undefined`)
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
  await setClock(new Date(now).toISOString())
  backend = spawn(python, ['-B', fileURLToPath(new URL('./isolated-backend.py', import.meta.url)), directory], {
    cwd: root, windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = '', log = ''
  backend.stdout.on('data', chunk => { output += chunk.toString() })
  backend.stderr.on('data', chunk => { log += chunk.toString() })
  for (let attempt = 0; attempt < 200; attempt++) {
    const port = output.match(/TIMER_TEST_PORT=(\d+)/)?.[1]
    if (port) {
      base = `http://127.0.0.1:${port}`
      try { if ((await fetch(`${base}/health`)).ok) break } catch { /* Starting. */ }
    }
    assert.equal(backend.exitCode, null, `Temporary Backend exited: ${log}`)
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
  browser = await openBrowser()
  await browser.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' })
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    window.__homeMinuteTicks=new Map();const start=window.setInterval,stop=window.clearInterval;
    window.setInterval=(fn,delay,...args)=>{const id=start(fn,delay,...args);if(delay===60000)window.__homeMinuteTicks.set(id,fn);return id;};
    window.clearInterval=id=>{window.__homeMinuteTicks.delete(id);stop(id);};
    const D=Date;window.__homeNow=${now};
    window.Date=class extends D{constructor(...a){super(...(a.length?a:[window.__homeNow]));}static now(){return window.__homeNow;}};
  })()` })
  const errors = [], requests = [], heldReports = []
  let holdProject = false, heldProject, failProject = false, holdReports = false, failReports = false
  async function forward(requestId, request) {
    const url = new URL(request.url)
    const response = await fetch(`${base}${url.pathname}${url.search}`, {
      method: request.method,
      ...(request.postData ? { headers: { 'Content-Type': 'application/json' }, body: request.postData } : {}),
    })
    const body = await response.json()
    if (holdReports && url.pathname === '/reports/daily') { heldReports.push({ requestId, body, status: response.status }); return }
    await browser.fulfill(requestId, body, response.status)
  }
  browser.listeners.push(message => {
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method !== 'Fetch.requestPaused') return
    const { requestId, request } = message.params
    void (async () => {
      if (request.method === 'OPTIONS') { await browser.fulfill(requestId, {}); return }
      const url = new URL(request.url)
      requests.push({ method: request.method, path: url.pathname, payload: request.postData ? JSON.parse(request.postData) : null })
      if (failReports && url.pathname === '/reports/daily') {
        await browser.fulfill(requestId, { detail: 'Controlled Report failure' }, 500); return
      }
      if (request.method === 'POST' && url.pathname === '/projects') {
        if (failProject) { await browser.fulfill(requestId, { detail: 'Controlled failure' }, 500); return }
        if (holdProject) { heldProject = { requestId, request }; return }
      }
      await forward(requestId, request)
    })().catch(async error => {
      if (/Invalid [Ii]nterception|Invalid requestId/.test(error.message)) return
      errors.push(error.message)
      try { await browser.send('Fetch.failRequest', { requestId, errorReason: 'ConnectionFailed' }) } catch { /* Closing. */ }
    })
  })
  await browser.send('Fetch.enable', { patterns: [{ urlPattern: 'http://localhost:8000/*', requestStage: 'Request' }] })
  const size = width => browser.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false })
  const mode = async value => {
    await browser.click(`[aria-label="カレンダー表示"] button:nth-child(${({ day: 1, week: 2, month: 3 })[value]})`)
    await browser.until(`document.querySelector('.calendar-period-navigation').dataset.mode===${JSON.stringify(value)} && document.querySelector(".calendar-schedule-status") && !document.querySelector(".calendar-schedule-status [role=status]")`, 'Requested Mode and Schedules ready')
    await browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    await browser.until('document.querySelector(".app-layout").getAnimations().every(a=>a.playState!=="running")', 'Sidebar layout transition settled')
  }
  const metricValues = date => browser.evaluate(`[...document.querySelectorAll('[data-metric-date="${date}"] dd')].map(e=>e.textContent)`)
  async function screenshot(label) {
    if (!process.env.HOME_VISUAL_OUTPUT) return
    const destination = path.resolve(process.env.HOME_VISUAL_OUTPUT)
    const relative = path.relative(path.resolve(tmpdir()), destination)
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Screenshots stay in a private temporary directory')
    const shot = await browser.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, fromSurface: true })
    await writeFile(path.join(destination, `${label}.png`), Buffer.from(shot.data, 'base64'))
  }
  const type = (selector, value) => browser.evaluate(`(() => {
    const e=document.querySelector(${JSON.stringify(selector)});e.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));
  })()`)
  const quickSubmit = kind => browser.click(kind === 'project' ? '.project-form button[type=submit]' : `.home-quick-${kind} .primary-action`)

  await t.test('empty Home retains both compact Sidebar sections on Desktop and mobile', async () => {
    for (const width of [1440, 375]) {
      await size(width); await browser.navigate()
      await browser.until('document.querySelectorAll(".home-sidebar .empty-state").length===1', 'Empty Sidebar')
      assert(await browser.evaluate('document.documentElement.scrollWidth<=innerWidth'))
      assert.equal(await browser.evaluate('document.querySelectorAll(".home-sidebar > section").length'), 1)
      await screenshot(`empty-${width}`)
    }
  })
  const project = await api('/projects', { name: 'デザイン検証' })
  const a = await api('/tasks', { title: '画面デザインを確認する', estimatedMinutes: 120, projectId: project.id })
  const b = await api('/tasks', { title: '重複する予定', estimatedMinutes: 60, projectId: project.id })
  const inboxTask = await api('/tasks', { title: '未配置タスク', estimatedMinutes: null })
  const legacy = await api('/tasks', { title: '旧予定だけのタスク', estimatedMinutes: 10, plannedDate: day, plannedStartTime: '09:00' })
  await api('/schedule-blocks', { taskId: a.id, date: day, type: 'TIMED', startTime: '10:00', durationMinutes: 30 })
  await api('/schedule-blocks', { taskId: b.id, date: day, type: 'TIMED', startTime: '10:15', durationMinutes: 30 })
  await setClock(`${day}T09:00:00+09:00`); await api('/tasks/time/start', { taskId: a.id })
  await setClock(`${day}T09:40:00+09:00`); await api('/tasks/time/stop', { taskId: a.id })
  await setClock(`${day}T12:00:00+09:00`)
  await size(1440); await browser.navigate()
  await browser.until(`document.querySelector('[data-inbox-task-id="${inboxTask.id}"]') && document.querySelector('[data-metric-date="${day}"] dd')?.textContent==='45分'`, 'Seeded Home')

  // 10:00-10:30 and 10:15-10:45 occupy 45 minutes; their 60-minute sum is not the global plan.
  await t.test('Day and Week metrics use occupied-time union and Today ignores legacy plannedDate', async () => {
    assert.deepEqual(await metricValues(day), ['45分', '40分'])
    assert.equal(await browser.evaluate('document.querySelectorAll(".calendar-week-metrics .home-metrics").length'), 7)
    assert(await browser.evaluate(`document.querySelector('[data-inbox-task-id="${legacy.id}"]')!==null`))
    assert.equal(await browser.evaluate('document.querySelector(".calendar-combined-row").textContent.includes("旧予定だけのタスク")'), false)
    await mode('day'); await browser.until(`document.querySelector('[data-metric-date="${day}"] dd')?.textContent==='45分'`, 'Day Report loaded')
    assert.deepEqual(await metricValues(day), ['45分', '40分'])
  })
  await t.test('mode switch keeps its DOM node and position and date clicks keep Week or Month mode', async () => {
    await browser.evaluate('window.__modeNode=document.querySelector(".home-calendar-controls .calendar-mode-switch"); undefined')
    const position = () => browser.evaluate('(()=>{const r=window.__modeNode.getBoundingClientRect();return [r.x,r.y]})()')
    const before = await position()
    for (const value of ['week', 'month', 'day']) {
      await mode(value)
      assert(await browser.evaluate('window.__modeNode===document.querySelector(".home-calendar-controls .calendar-mode-switch")'))
      assert.deepEqual(await position(), before)
    }
    await mode('week'); await browser.click('.calendar-week-header > button:nth-of-type(7)')
    assert.equal(await browser.evaluate('document.querySelector(".week-calendar-panel.single-day")!==null'), false)
    await mode('month'); await browser.click(`.month-day[data-date="${day}"]`)
    assert(await browser.evaluate('document.querySelector(".month-calendar-panel")!==null'))
    assert.equal(await browser.evaluate('document.querySelectorAll(".home-metrics").length'), 0)
    await browser.click('.calendar-dialog [aria-label="予定の操作を閉じる"]')
    await mode('week')
  })
  await t.test('Project quick create prevents duplicate submits and refreshes Project list and navigation', async () => {
    await browser.click('.icon-rail [aria-label="プロジェクト"]'); await browser.until('document.querySelector("[data-project-create]")', 'Project list'); await browser.click('[data-project-create]'); await type('.project-form input[name=name]', '  新しいプロジェクト  ')
    await screenshot('project-quick-create')
    holdProject = true
    const count = requests.filter(r => r.method === 'POST' && r.path === '/projects').length
    await quickSubmit('project')
    for (let i = 0; !heldProject && i < 100; i++) await sleep(20)
    assert(heldProject)
    await browser.evaluate('document.querySelector(".project-form").requestSubmit(); document.querySelector(".project-form").requestSubmit(); undefined')
    assert.equal(requests.filter(r => r.method === 'POST' && r.path === '/projects').length, count + 1)
    holdProject = false; await forward(heldProject.requestId, heldProject.request); heldProject = undefined
    await browser.until('document.querySelector(".projects-list-panel").textContent.includes("新しいプロジェクト") && !document.querySelector(".project-form")', 'Project shown without Reload')
    assert.equal((await api('/projects')).filter(p => p.name === '新しいプロジェクト').length, 1)
    await browser.evaluate('Array.from(document.querySelectorAll(".project-card-open")).find(e=>e.textContent.includes("新しいプロジェクト")).click()')
    await browser.until('document.querySelector(".project-detail-panel")', 'Existing Project navigation')
    await browser.click('.icon-rail [aria-label="ホーム"]')
  })
  await t.test('Project errors retain the input and Cancel closes without a POST', async () => {
    await browser.click('.icon-rail [aria-label="プロジェクト"]'); await browser.until('document.querySelector("[data-project-create]")', 'Project list'); await browser.click('[data-project-create]'); await type('.project-form input[name=name]', '再試行するプロジェクト')
    failProject = true; await quickSubmit('project')
    await browser.until('document.querySelector(".project-composer [role=alert]")', 'Create error')
    assert.equal(await browser.evaluate('document.querySelector(".project-form input[name=name]").value'), '再試行するプロジェクト')
    const count = requests.filter(r => r.method === 'POST').length
    await browser.click('.project-composer .icon-close')
    assert.equal(requests.filter(r => r.method === 'POST').length, count)
    failProject = false; await browser.click('.icon-rail [aria-label="ホーム"]')
  })
  let quickTask
  await t.test('Task title-only create uses NULL fields and immediately appears in Inbox with no ScheduleBlock', async () => {
    await browser.click('[aria-label="未配置タスクを作成"]')
    await browser.until('document.querySelector(".task-drawer")?.open', 'Create Drawer')
    assert(await browser.evaluate('document.activeElement===document.querySelector(".task-form [name=title]")'))
    await type('.task-form [name=title]', '   ')
    await browser.evaluate('document.querySelector(".task-form").requestSubmit()')
    await browser.until('document.querySelector(".task-form [role=alert]")', 'Required title')
    const count = requests.filter(r => r.method === 'POST' && r.path === '/tasks').length
    await type('.task-form [name=title]', '  Homeから追加  ')
    await screenshot('task-quick-add')
    await browser.click('.task-form button[type=submit]')
    await browser.until('document.querySelector(".unplanned-list")?.textContent.includes("Homeから追加") && !document.querySelector(".task-drawer")', 'Inbox updated')
    const posts = requests.filter(r => r.method === 'POST' && r.path === '/tasks')
    assert.equal(posts.length, count + 1)
    assert.deepEqual(posts.at(-1).payload, { title: 'Homeから追加', estimatedMinutes: null, projectId: null, priority: null, deadline: null, tagIds: [] })
    quickTask = (await api('/tasks?inbox=true')).find(task => task.title === 'Homeから追加')
    assert(quickTask); assert.equal(quickTask.estimatedMinutes, null); assert.equal(quickTask.projectId, null)
    assert.equal((await api('/schedule-blocks')).filter(block => block.taskId === quickTask.id).length, 0)
    await browser.until(`document.querySelector('[data-time-entry-id][data-task-id="${a.id}"]') && ![...document.querySelectorAll('[role=status]')].some(e=>e.textContent.includes('記録を読み込んでいます'))`, 'Quick Add preserves Calendar actual history')
  })
  await t.test('Sidebar Inbox drops still create TIME_UNSET and TIMED through existing APIs', async () => {
    async function drag(id, target, minute) {
      await browser.until(`(()=>{const source=document.querySelector('[data-inbox-task-id="${id}"]'),target=document.querySelector(${JSON.stringify(target)});if(!source||!target)return false;const dataTransfer=new DataTransfer();
        source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer}));target.scrollIntoView({block:'center'});const r=target.getBoundingClientRect();
        const y=${minute === undefined ? 'r.top+r.height/2' : `r.top+${minute}/1440*r.height`};
        target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer,clientX:r.left+r.width/2,clientY:y}));
        target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer,clientX:r.left+r.width/2,clientY:y}));source.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer}));return true;})()`, 'Inbox source and Calendar drop target ready')
    }
    await drag(quickTask.id, `[data-drop-date="${day}"]`)
    await browser.until(`document.querySelector('.calendar-time-unset-row [data-task-id="${quickTask.id}"]') && !document.querySelector('[data-inbox-task-id="${quickTask.id}"]')`, 'TIME_UNSET saved')
    await drag(inboxTask.id, `[data-timed-drop-date="${day}"]`, 841)
    await browser.until(`document.querySelector('.weekly-schedule-event[data-task-id="${inboxTask.id}"]')`, 'TIMED saved')
    const block = (await api('/schedule-blocks')).find(item => item.taskId === inboxTask.id)
    assert.equal(block.type, 'TIMED'); assert.equal(block.startTime, '14:00:00')
    await browser.evaluate('window.scrollTo(0,0)')
  })
  await t.test('late Home Report responses retain the displayed day and metrics until the new day is ready', async () => {
    await mode('day'); await browser.until(`document.querySelector('[data-metric-date="${day}"] dd')?.textContent==='1時間45分'`, 'Original metrics')
    holdReports = true; await browser.click('.calendar-period-controls [aria-label="次の期間"]')
    await browser.until('document.querySelector(".calendar-schedule-status [role=status]")', 'Inline update shown')
    assert.equal(await browser.evaluate('document.querySelector(".home-day-metrics dd").textContent'), '1時間45分')
    assert.equal(await browser.evaluate('document.querySelector(".home-day-metrics dl").dataset.metricDate'), day)
    for (let i = 0; heldReports.length === 0 && i < 100; i++) await sleep(20)
    holdReports = false
    for (const held of heldReports.splice(0)) await browser.fulfill(held.requestId, held.body, held.status)
    await browser.until('document.querySelector(".home-day-metrics dd")?.textContent==="0分"', 'Next day values')
    await browser.click('.calendar-period-controls [aria-label="前の期間"]')
    await mode('week')
  })
  await t.test('responsive Day Week Month preserve Header controls and keep one full-width Calendar', async () => {
    for (const width of [1440, 1024, 768, 375]) {
      await size(width)
      let position
      for (const value of ['week', 'day', 'month']) {
        await mode(value); await browser.evaluate('window.scrollTo(0,0)')
        if (value !== 'month') await browser.until(`document.querySelector('[data-time-entry-id][data-task-id="${a.id}"]')`, 'Actual history visible')
        const currentPosition = await browser.evaluate('(()=>{const r=document.querySelector(".home-calendar-controls .calendar-mode-switch").getBoundingClientRect();return [r.x,r.y]})()')
        if (position) assert.deepEqual(currentPosition, position, `Stable mode controls: ${width}/${value}`)
        position = currentPosition
        assert(await browser.evaluate('document.documentElement.scrollWidth<=innerWidth'), `${width}/${value}`)
        const geometry = await browser.evaluate('(()=>{const s=document.querySelector(".home-sidebar").getBoundingClientRect(),c=document.querySelector(".calendar-page").getBoundingClientRect();return {sidebarWidth:s.width,left:s.left,right:s.right,calendarLeft:c.left,calendarRight:c.right,calendarWidth:c.width}})()')
        if (width >= 1024) { assert(geometry.sidebarWidth === 192); assert(geometry.calendarLeft >= geometry.right); assert(geometry.calendarWidth > width / 2) }
        assert.equal(await browser.evaluate('document.querySelectorAll(".home-calendar-sidebar, .timer-workspace, .timer-dock").length'), 0)
        assert(await browser.evaluate('getComputedStyle(document.querySelector(".home-sidebar")).display!=="none"'))
        await screenshot(`${value}-${width}`)
      }
    }
  })
  await t.test('failed Home Report requests preserve the last day and its metrics and expose a retry', async () => {
    await mode('day')
    const before = await browser.evaluate('document.querySelector(".home-day-metrics").textContent')
    failReports = true
    await browser.click('.calendar-period-controls [aria-label="次の期間"]')
    await browser.until('document.querySelector(".calendar-schedule-status [role=alert]")', 'Inline request failure visible')
    assert.equal(await browser.evaluate('document.querySelector(".home-day-metrics").textContent'), before)
    failReports = false
    await browser.click('.calendar-period-controls [aria-label="前の期間"]')
    await browser.until('document.querySelector(".home-day-metrics dd")?.textContent==="1時間45分"', 'Report recovery')
    await browser.navigate(true)
    await browser.until('document.querySelector(".home-sidebar") && document.querySelector(".calendar-schedule-status") && !document.querySelector(".calendar-schedule-status [role=status]")', 'Reload cleared the request error')
  })
  await t.test('top Timer supports Start Pause Resume Stop and persisted Reload without a bottom bar', async () => {
    await size(1440); await mode('week')
    await selectTimerTask(browser, a.id)
    await browser.click('.timer-play-button'); await browser.until('document.querySelector(".header-timer-control.timer-session")', 'Header Active')
    const before = await api('/tasks/time/active')
    await browser.navigate(true)
    await browser.until('document.querySelector(".header-timer-control.timer-session .timer-task-title")?.textContent==="画面デザインを確認する"', 'Recovered Timer')
    assert.deepEqual(await api('/tasks/time/active'), before)
    await setClock(`${day}T12:02:00+09:00`)
    await browser.until(`document.querySelector('[data-metric-date="${day}"] > div:nth-child(2) dd')?.textContent==='42分'`, 'Active Report refresh')
    await screenshot('timer-active-1440')
    await pauseOrResumeTimer(browser); await browser.until('document.querySelector(".header-timer-control.paused")', 'Header Paused')
    assert.equal((await api('/tasks/time/active')).running, false)
    await pauseOrResumeTimer(browser); await browser.until('document.querySelector(".header-timer-control.timer-session:not(.paused)") && !document.querySelector(".header-timer-control .timer-stop").disabled', 'Resumed')
    await browser.click('.header-timer-control .timer-stop'); await browser.until('!document.querySelector(".header-timer-control.timer-session")', 'Stopped')
    assert.equal((await api('/tasks/time/active')).running, false)
    assert.equal(await browser.evaluate('document.querySelector(".timer-dock")!==null'), false)
  })
  assert.deepEqual(errors, [], 'No runtime or unexpected forwarding errors')
})
