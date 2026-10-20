import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { selectProject, openBrowser, pauseOrResumeTimer } from './browser.mjs'

test('Calendar interactions persist through existing APIs on a guarded temporary DB', { timeout: 180000 }, async t => {
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
    window.confirm=()=>true;
    window.__homeMinuteTicks=new Map();const start=window.setInterval,stop=window.clearInterval;
    window.setInterval=(fn,delay,...args)=>{const id=start(fn,delay,...args);if(delay===60000)window.__homeMinuteTicks.set(id,fn);return id;};
    window.clearInterval=id=>{window.__homeMinuteTicks.delete(id);stop(id);};
    const D=Date;window.__homeNow=${now};
    window.Date=class extends D{constructor(...a){super(...(a.length?a:[window.__homeNow]));}static now(){return window.__homeNow;}};
  })()` })
  const errors = [], requests = []
  let failBlock = false, holdBlock = false, heldBlock, failPatch = false, failDelete = false, failProjectChange = false
  let holdNextToday = false, heldToday, staleToday
  async function forward(requestId, request) {
    const url = new URL(request.url)
    const response = await fetch(`${base}${url.pathname}${url.search}`, {
      method: request.method,
      ...(request.postData ? { headers: { 'Content-Type': 'application/json' }, body: request.postData } : {}),
    })
    await browser.fulfill(requestId, await response.json(), response.status)
  }
  browser.listeners.push(message => {
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method !== 'Fetch.requestPaused') return
    const { requestId, request } = message.params
    void (async () => {
      if (request.method === 'OPTIONS') { await browser.fulfill(requestId, {}); return }
      const url = new URL(request.url)
      requests.push({ method: request.method, path: url.pathname, payload: request.postData ? JSON.parse(request.postData) : null })
      if (failProjectChange && request.method === 'PUT' && url.pathname.startsWith('/tasks/')) {
        await browser.fulfill(requestId, { detail: 'Controlled Project change failure' }, 500); return
      }
      if (holdNextToday && request.method === 'GET' && url.pathname === '/reports/daily' && url.searchParams.get('date') === day) {
        holdNextToday = false; heldToday = { requestId, body: staleToday }; return
      }
      if (url.pathname === '/schedule-blocks' && request.method === 'POST') {
        if (failBlock) { await browser.fulfill(requestId, { detail: 'Controlled create failure' }, 500); return }
        if (holdBlock) { heldBlock = { requestId, request }; return }
      }
      if ((failPatch && request.method === 'PATCH' || failDelete && request.method === 'DELETE') && url.pathname.startsWith('/schedule-blocks/')) {
        await browser.fulfill(requestId, { detail: 'Controlled mutation failure' }, 500); return
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
  const posts = route => requests.filter(r => r.path === route && r.method === 'POST')
  const plans = () => api('/schedule-blocks')
  const tasks = () => api('/tasks')
  async function ready() {
    await browser.until('document.querySelector(".calendar-schedule-status") && !document.querySelector(".calendar-schedule-status [role=status]") && !document.querySelector(".calendar-schedule-status [role=alert]")', 'Schedule ready')
  }
  async function mode(value) {
    await browser.click(`[aria-label="カレンダー表示"] button:nth-child(${({ day: 1, week: 2, month: 3 })[value]})`)
    await ready()
  }
  async function input(name, value) {
    if (name === 'projectId') return selectProject(browser, `.calendar-dialog [name="${name}"]`, value)
    if (['date','startTime','durationMinutes'].includes(name)) await browser.evaluate(`(()=>{if(!document.querySelector('.calendar-dialog [name="${name}"]'))document.querySelector('.calendar-dialog [data-schedule-field="${name}"]')?.click()})()`)
    await browser.evaluate(`(()=>{const e=document.querySelector('.calendar-dialog [name="${name}"]');e.focus();Object.getOwnPropertyDescriptor(e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`)
  }
  const dialogReady = () => browser.until('document.querySelector(".calendar-dialog:is([open], .calendar-popover)") && (!document.querySelector(".task-detail") || (document.querySelector(".calendar-popover-totals") && !document.querySelector(".calendar-popover-totals").textContent.includes("読込中")))', 'Calendar surface opened')
  async function close() { await browser.click('.calendar-dialog [aria-label="予定の操作を閉じる"]'); await browser.until('!document.querySelector(".calendar-dialog")', 'Calendar dialog closed') }
  async function screenshot(label) {
    if (!process.env.CALENDAR_VISUAL_OUTPUT) return
    const destination = path.resolve(process.env.CALENDAR_VISUAL_OUTPUT)
    const relative = path.relative(path.resolve(tmpdir()), destination)
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
    const shot = await browser.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    await writeFile(path.join(destination, `${label}.png`), Buffer.from(shot.data, 'base64'))
  }
  async function point(minute, date = day) {
    const position = await browser.evaluate(`(async()=>{const e=document.querySelector('[data-timed-drop-date="${date}"]'),scroller=e.closest('.calendar-time-grid');const r=e.getBoundingClientRect();if(scroller.scrollHeight>scroller.clientHeight&&getComputedStyle(scroller).overflowY==='auto'){const s=scroller.getBoundingClientRect();scroller.scrollTop+=r.top+${minute}*.9-(s.top+Math.min(160,s.height/2));}else window.scrollBy(0,r.top+${minute}*.9-320);await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const b=e.getBoundingClientRect();return {x:b.left+b.width*.6,y:b.top+${minute}*.9}})()`)
    // Move the physical pointer after scrolling before starting the gesture.
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position })
    return position
  }
  async function clickTime(minute, date = day) {
    const p = await point(minute, date)
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p })
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...p })
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...p })
    await dialogReady()
  }
  async function create(title, fields = {}) {
    await input('title', title)
    for (const [name, value] of Object.entries(fields)) await input(name, value)
    await browser.click('.calendar-dialog button[type=submit]')
    await browser.until('!document.querySelector(".calendar-dialog")', 'Created and closed')
    await ready()
    const task = (await tasks()).find(task => task.title === title.trim())
    assert(task)
    const block = (await plans()).find(block => block.taskId === task.id)
    assert(block)
    return { task, block }
  }
  async function openBlock(id) {
    await ready(); await sleep(320)
    await browser.click(`[data-schedule-block-id="${id}"]`); await dialogReady()
    assert(await browser.evaluate(`(()=>{const pop=document.querySelector('.calendar-dialog.calendar-popover');return pop?.tagName==='DIV'&&pop.getAttribute('aria-modal')==='false'&&pop.querySelector('h2').textContent===document.querySelector('[data-schedule-block-id="${id}"] strong').textContent})()`))
  }
  async function editFields(id, fields) {
    // Seed an existing domain type through the test API; the Editor has no type control.
    if (fields.type) {
      const stored=(await plans()).find(block=>block.id===id)
      if(stored.type!==fields.type){
        await api(`/schedule-blocks/${id}`,{type:fields.type,...(fields.type==='TIMED'?{startTime:fields.startTime??'11:00',durationMinutes:Number(fields.durationMinutes??60)}:{startTime:null,durationMinutes:null})},'PATCH')
        await browser.navigate(true);await ready()
      }
    }
    await openBlock(id)
    const wanted=Object.keys(fields).filter(name=>['date','startTime','durationMinutes'].includes(name));if(!wanted.length)wanted.push(...(fields.type==='TIMED'?['startTime','durationMinutes']:['date']));
    for(const name of wanted)await browser.click(`.calendar-dialog [data-schedule-field="${name}"]`)
    assert.equal(await browser.evaluate('document.querySelector(".calendar-dialog [name=type]")'),null)
    for (const [name, value] of Object.entries(fields)) if(name!=='type') await input(name, value)
  }
  async function saveEdit() {
    await browser.click('.calendar-dialog button[type=submit]')
    await browser.until('!document.querySelector(".calendar-inline-schedule-actions")&&!document.querySelector(".calendar-dialog [aria-label=予定の操作を閉じる]").disabled', 'Inline Schedule saved');assert(await browser.evaluate('!!document.querySelector(".calendar-dialog .task-detail")'));await close();await ready()
  }
  async function drag(source, target, minute) {
    await ready()
    await browser.until(`document.querySelector(${JSON.stringify(source)}) && document.querySelector(${JSON.stringify(target)})`, 'Drag source and target')
    await browser.evaluate(`(()=>{const source=document.querySelector(${JSON.stringify(source)}),target=document.querySelector(${JSON.stringify(target)}),dataTransfer=new DataTransfer();
      const r=target.getBoundingClientRect(),y=${minute === undefined ? 'r.top+r.height/2' : `r.top+${minute}*.9`};
      const options={bubbles:true,cancelable:true,dataTransfer,clientX:r.left+r.width/2,clientY:y};
      source.dispatchEvent(new DragEvent('dragstart',options));target.dispatchEvent(new DragEvent('dragover',options));target.dispatchEvent(new DragEvent('drop',options));source.dispatchEvent(new DragEvent('dragend',options));source.dispatchEvent(new MouseEvent('click',{bubbles:true}));})()`)
    await ready(); await sleep(80)
  }
  async function changed(id, type, date = day) {
    await browser.until(`document.querySelector('[data-schedule-block-id="${id}"][data-schedule-type="${type}"][data-date="${date}"]') && document.querySelector('[data-schedule-block-id="${id}"]')?.getAttribute('aria-busy')!=='true'`, 'Changed Block confirmed')
    const block = (await plans()).find(block => block.id === id)
    assert.equal(block.type, type); assert.equal(block.date, date)
    if (type !== 'TIMED') { assert.equal(block.startTime, null); assert.equal(block.durationMinutes, null) }
    assert.equal(await browser.evaluate('document.querySelector(".calendar-dialog")!==null'), false, 'DnD never opens the dialog')
    return block
  }
  async function metrics() {
    await browser.until(`document.querySelector('[data-metric-date="${day}"] dd') && ![...document.querySelectorAll('[data-metric-date="${day}"] dd')].some(e=>/読込中|取得失敗/.test(e.textContent))`, 'Fresh metrics')
    const report = await api(`/reports/daily?date=${day}&timezone=Asia%2FTokyo`)
    const actual = await browser.evaluate(`[...document.querySelectorAll('[data-metric-date="${day}"] dd')].slice(0,2).map(e=>{const v=e.textContent;return Number(v.match(/(\\d+)時間/)?.[1]??0)*60+Number(v.match(/(\\d+)分/)?.[1]??0)})`)
    // Overall planning uses occupied-time union, not the sum of per-Task durations.
    const planned = report.plannedOccupiedMinutes
    assert.deepEqual(actual, [planned, report.dailyActualMinutes])
    return report
  }

  const project = await api('/projects', { name: 'Calendar Project' })
  const inbox = await api('/tasks', { title: 'Inbox for all day', estimatedMinutes: 120, projectId: project.id })
  const noEstimate = await api('/tasks', { title: 'No estimate all day', estimatedMinutes: null })
  await size(1440); await browser.navigate(); await ready()
  await browser.until('!document.querySelector(".header-timer-control .timer-play-button").disabled', 'Timer ready')
  let timed, unset, allDay, month, dragged, partial
  await t.test('empty TIMED mouse click snaps to fifteen minutes and defaults to thirty minutes', async () => {
    await clickTime(607)
    assert.equal(await browser.evaluate('document.querySelector(".calendar-dialog [name=startTime]").value'), '10:00')
    assert.equal(await browser.evaluate('document.querySelector(".calendar-dialog [name=durationMinutes]").value'), '30m')
    assert.equal(await browser.evaluate('document.activeElement.name'), 'title')
    await screenshot('timed-click-create')
    timed = await create('Click created', { projectId: String(project.id), estimatedMinutes: '120' })
    assert.equal(timed.block.startTime, '10:00:00'); assert.equal(timed.block.durationMinutes, 30)
    assert.equal(timed.task.projectId, project.id); assert.equal(timed.task.estimatedMinutes, 120)
    assert.equal((await metrics()).plannedOccupiedMinutes, 30)
  })
  await t.test('empty TIMED pointer drag previews its range and persists nothing until form submission', async () => {
    const p = await point(720), count = posts('/schedule-blocks').length
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...p })
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', buttons: 1, x: p.x, y: p.y + 90 * .9 })
    await browser.until('document.querySelector(".calendar-create-preview")', 'Drag preview')
    assert.equal(await browser.evaluate('document.querySelector(".calendar-create-preview").textContent.trim()'), '12:00 – 13:30')
    assert.equal(posts('/schedule-blocks').length, count)
    await screenshot('timed-drag-preview')
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: p.x, y: p.y + 90 * .9 })
    await dialogReady()
    assert.equal(await browser.evaluate('document.querySelector(".calendar-dialog [name=durationMinutes]").value'), '1h 30m')
    assert.equal(posts('/schedule-blocks').length, count)
    dragged = await create('Drag created')
    assert.equal(dragged.block.startTime, '12:00:00'); assert.equal(dragged.block.durationMinutes, 90)
  })
  await t.test('upward drag normalizes the interval and Cancel leaves both tables unchanged', async () => {
    const beforeTasks = await tasks(), beforeBlocks = await plans(), p = await point(990)
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...p })
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', buttons: 1, x: p.x, y: p.y - 30 * .9 })
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: p.x, y: p.y - 30 * .9 })
    await dialogReady()
    assert.equal(await browser.evaluate('document.querySelector(".calendar-dialog [name=startTime]").value'), '16:00')
    assert.equal(await browser.evaluate('document.querySelector(".calendar-dialog [name=durationMinutes]").value'), '30m')
    await browser.click('.calendar-dialog .composer-footer .secondary-button')
    assert.deepEqual(await tasks(), beforeTasks); assert.deepEqual(await plans(), beforeBlocks)
  })
  await t.test('Date-only clicks create TIME_UNSET and seeded ALL_DAY remains nullable', async () => {
    await browser.click(`[data-drop-date="${day}"]`); await dialogReady()
    assert.equal(await browser.evaluate('document.querySelector(".calendar-dialog [name=startTime]").value'), '');assert(await browser.evaluate('!!document.querySelector(".calendar-dialog.task-editor-panel")'))
    unset = await create('Unset created')
    assert.equal(unset.block.type, 'TIME_UNSET'); assert.equal(unset.block.durationMinutes, null); assert.equal(unset.task.estimatedMinutes, null)
    await browser.click(`[data-all-day-drop-date="${day}"]`); await dialogReady()
    assert.equal(await browser.evaluate('document.querySelector(".calendar-dialog [name=type]")'),null)
    await screenshot('all-day-create')
    allDay = await create('All day created')
    allDay.block=await api(`/schedule-blocks/${allDay.block.id}`,{type:'ALL_DAY',startTime:null,durationMinutes:null},'PATCH')
    await browser.navigate(true);await ready()
    assert.equal(allDay.block.type, 'ALL_DAY'); assert.equal(allDay.block.startTime, null); assert.equal(allDay.block.durationMinutes, null)
    assert.equal(allDay.task.projectId, null)
  })
  await t.test('small drags retain fifteen-minute minimum and Escape cancels before release', async () => {
    await ready()
    let p = await point(1065)
    assert(await browser.evaluate(`document.elementFromPoint(${p.x},${p.y})?.closest('[data-timed-drop-date="${day}"]')!==null`), JSON.stringify(p))
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p })
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...p })
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', buttons: 1, x: p.x, y: p.y + 7 })
    await browser.until('document.querySelector(".calendar-create-preview")', 'Minimum duration preview')
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: p.x, y: p.y + 7 })
    await dialogReady()
    assert.equal(await browser.evaluate('document.querySelector(".calendar-dialog [name=durationMinutes]").value'), '15m'); await close()
    const count = posts('/schedule-blocks').length
    p = await point(1065)
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...p })
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', buttons: 1, x: p.x, y: p.y + 30 })
    await browser.until('document.querySelector(".calendar-create-preview")', 'Cancelable preview')
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: p.x, y: p.y + 30 })
    assert.equal(await browser.evaluate('document.querySelector(".calendar-create-preview, .calendar-dialog")!==null'), false)
    assert.equal(posts('/schedule-blocks').length, count)
  })
  await t.test('Keyboard creation focuses the input, supports Tab, and restores the Calendar focus on Escape', async () => {
    await browser.evaluate(`document.querySelector('[data-drop-date="${day}"]').focus(); undefined`)
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 })
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await dialogReady(); assert.equal(await browser.evaluate('document.activeElement.name'), 'title')
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
    assert(await browser.evaluate('document.activeElement.classList.contains("task-status-trigger")'))
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
    assert(await browser.evaluate('document.activeElement.classList.contains("project-picker-trigger")'))
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await browser.until('!document.querySelector(".calendar-dialog")', 'Keyboard close')
    assert(await browser.evaluate(`document.activeElement===document.querySelector('[data-drop-date="${day}"]')`))
  })
  await t.test('Day blank tap and Month Quick Add create schedules without changing Mode', async () => {
    await mode('day'); await clickTime(1118)
    assert.equal(await browser.evaluate('document.querySelector(".calendar-dialog [name=startTime]").value'), '18:45')
    const created = await create('Day click created'); assert.equal(created.block.durationMinutes, 30)
    await mode('month'); await browser.click(`.month-day[data-date="${day}"]`); await dialogReady()
    assert(await browser.evaluate('document.querySelector(".month-calendar-panel")!==null'))
    assert.equal(await browser.evaluate('document.querySelector(".calendar-dialog [name=type]")'), null)
    month = await create('Month added')
    assert.equal(month.block.type, 'TIME_UNSET')
    assert(await browser.evaluate(`document.querySelector('.month-task-chip[data-schedule-block-id="${timed.block.id}"]')!==null`))
    await mode('week')
  })
  await t.test('failed ScheduleBlock creation retains the created Task and retry never duplicates it', async () => {
    await clickTime(870); await input('title', 'Partial save')
    failBlock = true; await browser.click('.calendar-dialog button[type=submit]')
    await browser.until('document.querySelector(".calendar-dialog [role=alert]")', 'Partial save error')
    assert.equal((await tasks()).filter(task => task.title === 'Partial save').length, 1)
    assert(await browser.evaluate('document.querySelector(".calendar-dialog [name=title]").disabled'))
    const task = (await tasks()).find(task => task.title === 'Partial save')
    assert((await api('/tasks?inbox=true')).some(item => item.id === task.id))
    failBlock = false; holdBlock = true
    const count = posts('/tasks').length
    await browser.click('.calendar-dialog button[type=submit]')
    await browser.until('document.querySelector(".calendar-dialog button[type=submit]").disabled', 'Retry pending')
    await browser.evaluate('document.querySelector(".calendar-dialog form").requestSubmit(); document.querySelector(".calendar-dialog form").requestSubmit(); undefined')
    for (let i = 0; !heldBlock && i < 100; i++) await sleep(20)
    assert(heldBlock); assert.equal(posts('/tasks').length, count)
    assert.equal(posts('/schedule-blocks').filter(r => r.payload.taskId === task.id).length, 2)
    holdBlock = false; await forward(heldBlock.requestId, heldBlock.request); heldBlock = undefined
    await browser.until('!document.querySelector(".calendar-dialog")', 'Retry saved'); await ready()
    partial = (await plans()).find(block => block.taskId === task.id)
    assert(partial); assert.equal((await tasks()).filter(task => task.title === 'Partial save').length, 1)
  })
  await t.test('Combined date drops and ALL_DAY edits preserve Task and Block identity through all transitions', async () => {
    await browser.until(`document.querySelector('[data-inbox-task-id="${inbox.id}"]')`, 'Inbox available')
    await drag(`[data-inbox-task-id="${inbox.id}"]`, `[data-all-day-drop-date="${day}"]`)
    const created = (await plans()).find(block => block.taskId === inbox.id)
    assert(created); await changed(created.id, 'TIME_UNSET')
    await editFields(created.id, { type: 'ALL_DAY' }); await saveEdit(); await changed(created.id, 'ALL_DAY')
    await editFields(unset.block.id, { type: 'ALL_DAY' }); await saveEdit(); await changed(unset.block.id, 'ALL_DAY')
    await drag(`[data-schedule-block-id="${timed.block.id}"]`, `[data-drop-date="${day}"]`); await changed(timed.block.id, 'TIME_UNSET')
    await editFields(timed.block.id, { type: 'ALL_DAY' }); await saveEdit(); await changed(timed.block.id, 'ALL_DAY')
    await drag(`[data-schedule-block-id="${timed.block.id}"]`, '[data-all-day-drop-date="2026-10-04"]'); await changed(timed.block.id, 'ALL_DAY', '2026-10-04')
    await drag(`[data-schedule-block-id="${timed.block.id}"]`, `[data-drop-date="${day}"]`); await changed(timed.block.id, 'ALL_DAY')
    await editFields(timed.block.id, { type: 'TIME_UNSET' }); await saveEdit(); await changed(timed.block.id, 'TIME_UNSET')
    await drag(`[data-schedule-block-id="${created.id}"]`, `[data-timed-drop-date="${day}"]`, 607)
    const block = await changed(created.id, 'TIMED'); assert.equal(block.startTime, '10:00:00'); assert.equal(block.durationMinutes, 60)
    const task = (await tasks()).find(task => task.id === inbox.id)
    assert.equal(task.title, inbox.title); assert.equal(task.estimatedMinutes, 120); assert.equal(task.projectId, project.id)
    await drag(`[data-inbox-task-id="${noEstimate.id}"]`, `[data-all-day-drop-date="${day}"]`)
    const noEstimateBlock = (await plans()).find(block => block.taskId === noEstimate.id)
    await drag(`[data-schedule-block-id="${noEstimateBlock.id}"]`, `[data-timed-drop-date="${day}"]`, 1030)
    assert.equal((await changed(noEstimateBlock.id, 'TIMED')).durationMinutes, 60)
    await metrics(); await screenshot('all-day-dnd')
  })
  await t.test('late pre-create Today summary cannot remove the newly scheduled Task from the combined row', async () => {
    await metrics()
    staleToday = await api(`/reports/daily?date=${day}&timezone=Asia%2FTokyo`)
    await browser.click(`[data-all-day-drop-date="${day}"]`); await dialogReady()
    holdNextToday = true
    const created = await create('Today response race')
    assert(heldToday, 'Held the pre-create daily summary')
    await browser.until('document.querySelector(".calendar-combined-row").textContent.includes("Today response race")', 'Latest Sidebar summary')
    await browser.fulfill(heldToday.requestId, heldToday.body); heldToday = undefined
    await browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    assert(await browser.evaluate('document.querySelector(".calendar-combined-row").textContent.includes("Today response race")'))
    assert((await plans()).some(block => block.id === created.block.id)); await metrics()
  })
  await t.test('ScheduleBlock details omit timed fields when unset and Esc/outside click restore focus', async () => {
    await openBlock(timed.block.id)
    assert(await browser.evaluate('document.querySelector(".calendar-dialog").textContent.includes("Click created")'))
    assert(await browser.evaluate('document.querySelector(".calendar-dialog").textContent.includes("Calendar Project")'))
    assert.equal(await browser.evaluate('document.querySelectorAll(".calendar-popover-schedule > div").length'), 3)
    await screenshot('block-details')
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await browser.until('!document.querySelector(".calendar-dialog")', 'Escape closes')
    await openBlock(dragged.block.id)
    assert.equal(await browser.evaluate('document.querySelectorAll(".calendar-popover-schedule > div").length'), 3)
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: 5, y: 5 })
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: 5, y: 5 })
    await browser.until('!document.querySelector(".calendar-dialog")', 'Outside closes')
  })
  await t.test('detail edit accepts one-minute values and overlap warns without rejecting save', async () => {
    await editFields(timed.block.id, { type: 'TIMED', startTime: '10:07', durationMinutes: '37' })
    await browser.until('document.querySelector(".calendar-dialog-warning")', 'Edit overlap warning')
    await screenshot('block-edit'); await saveEdit()
    let block = (await plans()).find(block => block.id === timed.block.id)
    assert.equal(block.startTime, '10:07:00'); assert.equal(block.durationMinutes, 37)
    assert(await browser.evaluate(`document.querySelector('[data-schedule-block-id="${timed.block.id}"] .schedule-overlap-warning')!==null`))
    await metrics()
    await editFields(timed.block.id, { durationMinutes: '0' })
    const count = requests.filter(r => r.method === 'PATCH').length
    await browser.click('.calendar-dialog button[type=submit]'); await browser.until('document.querySelector(".calendar-dialog [role=alert]")', 'Invalid duration')
    assert.equal(requests.filter(r => r.method === 'PATCH').length, count); await close()
    await editFields(timed.block.id, { type: 'ALL_DAY' }); await saveEdit()
    block = (await plans()).find(block => block.id === timed.block.id); assert.equal(block.startTime, null); assert.equal(block.durationMinutes, null)
    await editFields(timed.block.id, { type: 'TIME_UNSET' }); await saveEdit()
    assert.equal((await plans()).find(block => block.id === timed.block.id).type, 'TIME_UNSET')
    await editFields(timed.block.id, { type: 'TIMED', date: '2026-10-04', startTime: '23:57', durationMinutes: '1800' }); await saveEdit()
    block = (await plans()).find(block => block.id === timed.block.id); assert.equal(block.date, '2026-10-04'); assert.equal(block.durationMinutes, 1800)
    await metrics()
  })
  await t.test('PATCH and DELETE errors preserve the existing schedule and allow retry', async () => {
    const before = (await plans()).find(block => block.id === partial.id)
    await editFields(partial.id, { startTime: '15:07', durationMinutes: '37' })
    failPatch = true; await browser.click('.calendar-dialog button[type=submit]')
    await browser.until('document.querySelector(".calendar-dialog [role=alert]")', 'Patch failure')
    assert.deepEqual((await plans()).find(block => block.id === partial.id), before)
    failPatch = false; await saveEdit()
    await openBlock(partial.id); failDelete = true; await browser.click('.calendar-dialog .danger')
    await browser.until('document.querySelector(".calendar-dialog [role=alert]")', 'Delete failure')
    assert((await plans()).some(block => block.id === partial.id)); failDelete = false
    await browser.click('.calendar-dialog .danger'); await browser.until('!document.querySelector(".calendar-dialog")', 'Delete retry'); await ready()
    assert(!(await plans()).some(block => block.id === partial.id))
    assert((await tasks()).some(task => task.id === before.taskId))
    await browser.until(`document.querySelector('[data-inbox-task-id="${before.taskId}"]')`, 'Final schedule removal returns Task to Inbox')
    await metrics()
  })
  await t.test('Dialog stays inside all four viewports and mobile touch tap creates without drag', async () => {
    for (const width of [1440, 1024, 768, 375]) {
      await size(width); await browser.click(`[data-all-day-drop-date="${day}"]`); await dialogReady()
      const box = await browser.evaluate('(()=>{const r=document.querySelector(".calendar-dialog").getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight}})()')
      assert(box.left >= 0 && box.right <= box.width && box.top >= 0 && box.bottom <= box.height)
      assert(await browser.evaluate('document.documentElement.scrollWidth<=innerWidth'))
      await input('title', 'Responsive preview'); assert.equal(await browser.evaluate('document.querySelector(".calendar-dialog [name=type]")'),null); await screenshot(`quick-create-${width}`); await close()
    }
    await mode('day'); await browser.send('Emulation.setTouchEmulationEnabled', { enabled: true })
    const p = await point(480)
    await browser.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...p, id: 1 }] })
    await browser.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await dialogReady(); const created = await create('Mobile tap created')
    assert.equal(created.block.startTime, '08:00:00'); assert.equal(created.block.durationMinutes, 30)
    await browser.send('Emulation.setTouchEmulationEnabled', { enabled: false }); await size(1440); await mode('week')
  })
  await t.test('editing outside the displayed week checks overlap through the existing daily Block API', async () => {
    await api('/schedule-blocks', { taskId: inbox.id, date: '2026-10-12', type: 'TIMED', startTime: '10:00', durationMinutes: 60 })
    await editFields(dragged.block.id, { date: '2026-10-12', startTime: '10:07', durationMinutes: '37' })
    await browser.until('document.querySelector(".calendar-dialog-warning")', 'Future date overlap warning')
    await saveEdit()
    assert.equal((await plans()).find(block => block.id === dragged.block.id).date, '2026-10-12')
    await mode('month'); await editFields(dragged.block.id, { date: day, startTime: '12:00', durationMinutes: '90' }); await saveEdit()
    await mode('week'); await metrics()
  })
  await t.test('Calendar Timer uses Task lifecycle, same Task adds no Start, and other Task cannot replace Active', async () => {
    await openBlock(dragged.block.id); await browser.click('.calendar-dialog .task-timer-always')
    await browser.until('!document.querySelector(".calendar-dialog") && document.querySelector(".header-timer-control.timer-session")', 'Calendar Start')
    const active = await api('/tasks/time/active'); assert.equal(active.taskId, dragged.task.id)
    const entries = await api(`/tasks/${dragged.task.id}/time-entries`)
    assert.equal(entries.length, 1); assert.equal(entries[0].endedAt, null)
    assert.equal((await tasks()).find(task => task.id === dragged.task.id).status, 'IN_PROGRESS')
    await browser.until('!document.querySelector(".header-timer-control .timer-stop").disabled', 'Start settled')
    await openBlock(dragged.block.id)
    const count = posts('/tasks/time/start').length
    assert.equal(await browser.evaluate('document.querySelector(".calendar-dialog .task-timer-always [data-icon]").dataset.icon'), 'stop')
    assert(await browser.evaluate('document.querySelector(".calendar-dialog .task-timer-always").getAttribute("aria-pressed")==="true" && !document.querySelector(".calendar-dialog .task-timer-always").disabled')); await close()
    await openBlock(allDay.block.id); await browser.click('.calendar-dialog .task-timer-always')
    await browser.until('document.querySelector(".calendar-dialog [role=alert]")?.textContent.includes("別のタスクを計測中")', 'Active conflict')
    assert.deepEqual(await api('/tasks/time/active'), active); assert.equal(posts('/tasks/time/start').length, count)
    assert.equal(posts('/tasks/time/stop').length, 0); await screenshot('timer-conflict'); await close()
    await setClock(`${day}T12:02:00+09:00`)
    await browser.until(`document.querySelector('[data-metric-date="${day}"] > div:nth-child(2) dd')?.textContent==='2分'`, 'Timer metric refreshed')
    await metrics()
    await pauseOrResumeTimer(browser); await browser.until('document.querySelector(".header-timer-control.paused") && !document.querySelector(".timer-pause-resume").disabled', 'Pause')
    await pauseOrResumeTimer(browser); await browser.until('document.querySelector(".header-timer-control.timer-session:not(.paused)") && !document.querySelector(".header-timer-control .timer-stop").disabled', 'Resume')
    await browser.click('.header-timer-control .timer-stop'); await browser.until('!document.querySelector(".header-timer-control.timer-session")', 'Stop')
    assert.equal((await api('/tasks/time/active')).running, false); await metrics()
  })
  await t.test('external Active conflict uses Backend 409 and preserves its interval', async () => {
    const external = await api('/tasks/time/start', { taskId: allDay.task.id })
    await openBlock(dragged.block.id); await browser.click('.calendar-dialog .task-timer-always')
    await browser.until('document.querySelector(".calendar-dialog [role=alert]")', 'Server conflict')
    assert.deepEqual(await api('/tasks/time/active'), external)
    await close(); await browser.until('!document.querySelector(".header-timer-control .timer-stop").disabled', 'External Timer reconciled')
    await browser.click('.header-timer-control .timer-stop'); await browser.until('!document.querySelector(".header-timer-control.timer-session")', 'External Stop')
  })
  await t.test('Actual clicks never open Schedule editing and completed Tasks cannot start', async () => {
    await browser.until('document.querySelector(".calendar-event.actual")', 'Actual block')
    await browser.click('.calendar-event.actual'); assert.equal(await browser.evaluate('document.querySelector(".calendar-dialog")!==null'), false)
    assert(await browser.evaluate('document.querySelector(".time-entry-dialog.calendar-popover[aria-modal=false]")!==null'))
    await browser.click('.time-entry-dialog [aria-label="記録の操作を閉じる"]')
    await api(`/tasks/${allDay.task.id}/complete`, { completed: true }, 'PATCH'); await browser.navigate(true); await ready()
    await openBlock(allDay.block.id); assert(await browser.evaluate('document.querySelector(".calendar-dialog .task-timer-always").disabled')); await close()
    await mode('day'); await metrics(); await mode('month')
    await browser.click(`[data-schedule-block-id="${dragged.block.id}"]`); await dialogReady()
    assert.equal(await browser.evaluate('document.querySelector(".calendar-dialog h2").textContent'), dragged.task.title); await close()
    assert(await browser.evaluate('document.querySelector(".month-calendar-panel")!==null'))
  })
  let lecture, firstPart, secondPart
  await t.test('one Task supports multiple days and estimates stay independent of placements', async () => {
    lecture = await api('/tasks', { title: 'Lecture overall twelve hours', estimatedMinutes: 720 })
    firstPart = await api('/schedule-blocks', { taskId: lecture.id, date: day, type: 'TIMED', startTime: '08:00', durationMinutes: 60 })
    secondPart = await api('/schedule-blocks', { taskId: lecture.id, date: day, type: 'TIMED', startTime: '12:00', durationMinutes: 120 })
    for (const [date, durationMinutes] of [['2026-10-05', 180], ['2026-10-06', 180], ['2026-10-08', 120], ['2026-10-10', 240]]) {
      await api('/schedule-blocks', { taskId: lecture.id, date, type: 'TIMED', startTime: '10:00', durationMinutes })
    }
    await browser.navigate(true); await ready(); await mode('week')
    assert.equal((await api(`/tasks/${lecture.id}`)).estimatedMinutes, 720)
    assert.equal((await api(`/schedule-blocks?taskId=${lecture.id}`)).length, 6)
  })
  await t.test('same Task overlapping Drag move is rejected and the saved Block stays visible', async () => {
    await drag(`[data-schedule-block-id="${firstPart.id}"]`, `[data-timed-drop-date="${day}"]`, 750)
    await browser.until(`document.querySelector('.unplanned-panel [role=alert]')?.textContent.includes('同じタスク') && document.querySelector('[data-schedule-block-id="${firstPart.id}"]')?.getAttribute('aria-busy')==='false'`, 'Same Task move rejected')
    assert.deepEqual((await plans()).find(block => block.id === firstPart.id), firstPart)
    assert.deepEqual((await plans()).find(block => block.id === secondPart.id), secondPart)
    assert.equal((await api(`/tasks/${lecture.id}`)).estimatedMinutes, 720)
  })
  await t.test('same Task overlapping Resize is rejected and adjacent resize is allowed without changing estimate', async () => {
    const handle = `[data-schedule-block-id="${firstPart.id}"] .schedule-resize-handle`
    await browser.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(handle)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();window.__resize41={x:r.left+r.width/2,y:r.top+r.height/2}})()`)
    const p = await browser.evaluate('window.__resize41')
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p })
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...p })
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y + 240 * .9, button: 'left', buttons: 1 })
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: p.x, y: p.y + 240 * .9 })
    await browser.until(`document.querySelector('.unplanned-panel [role=alert]')?.textContent.includes('同じタスク') && document.querySelector('[data-schedule-block-id="${firstPart.id}"]')?.getAttribute('aria-busy')==='false'`, 'Same Task resize rejected')
    assert.equal(await browser.evaluate('document.querySelector(".calendar-dialog")===null'),true,'Resize completion does not open a Popover')
    assert.deepEqual((await plans()).find(block => block.id === firstPart.id), firstPart)
    await editFields(firstPart.id, { durationMinutes: '240' }); await saveEdit()
    assert.equal((await plans()).find(block => block.id === firstPart.id).durationMinutes, 240)
    assert.equal((await api(`/tasks/${lecture.id}`)).estimatedMinutes, 720)
  })
  await t.test('same Task overlapping Edit is refused with an inline error and adjacent Edit succeeds', async () => {
    await editFields(firstPart.id, { startTime: '11:30', durationMinutes: '60' })
    await browser.until('document.querySelector(".calendar-dialog-warning")?.textContent.includes("保存できません")', 'Same Task warning is a prohibition')
    await browser.click('.calendar-dialog button[type=submit]')
    await browser.until('document.querySelector(".calendar-dialog [role=alert]")?.textContent.includes("同じタスク")', 'Same Task edit refused')
    assert.equal((await plans()).find(block => block.id === firstPart.id).startTime, '08:00:00')
    await input('startTime', '11:00'); await saveEdit()
    assert.equal((await plans()).find(block => block.id === firstPart.id).startTime, '11:00:00')
  })
  await t.test('Editing seeded untimed schedules preserves type and shows no timed fields', async () => {
    for (const type of ['TIME_UNSET', 'ALL_DAY']) {
      await editFields(firstPart.id, { type })
      assert.equal(await browser.evaluate('document.querySelector(".calendar-dialog [name=startTime], .calendar-dialog [name=durationMinutes]")===null'), true)
      await saveEdit()
      const stored = (await plans()).find(block => block.id === firstPart.id)
      assert.equal(stored.type,type)
      assert.equal(stored.startTime, null); assert.equal(stored.durationMinutes, null)
      await editFields(firstPart.id, { type: 'TIMED' })
      assert.equal(await browser.evaluate('document.querySelector(".calendar-dialog [name=startTime]").value'), '11:00')
      await input('durationMinutes', '')
      const count = requests.filter(r => r.method === 'PATCH').length
      await browser.click('.calendar-dialog button[type=submit]')
      await browser.until('document.querySelector(".calendar-dialog [role=alert]")', 'TIMED requires fresh time fields')
      assert.equal(requests.filter(r => r.method === 'PATCH').length, count)
      await input('startTime', '11:00'); await input('durationMinutes', '60'); await saveEdit()
    }
  })
  await t.test('Schedule duration uses hours and minutes, independently of Task overall estimate', async () => {
    await api(`/schedule-blocks/${firstPart.id}`, { startTime: '06:00', durationMinutes: 345 }, 'PATCH')
    await mode('week'); await openBlock(firstPart.id)
    assert.equal(await browser.evaluate('document.querySelector(".calendar-popover-schedule > div:last-child .task-attribute-control").textContent'),'5時間45分')
    assert.equal(await browser.evaluate('document.querySelector(".calendar-popover-totals > div:last-child dd").textContent'), '12時間')
    await browser.click('.calendar-dialog [data-schedule-field="durationMinutes"]')
    assert.equal(await browser.evaluate('document.querySelector(".calendar-dialog [name=durationMinutes]").value'),'5h 45m')
    assert(await browser.evaluate('document.querySelector(".calendar-popover-totals").textContent.includes("12時間")'))
    await close()
  })
  await t.test('Task details sum multiple entries and compare actual with estimate without a progress percentage', async () => {
    for (const [date, end] of [['2026-10-01', '02:30'], ['2026-10-02', '03:20'], [day, '01:40']]) {
      await api('/time-entries', { taskId: lecture.id, startedAt: `${date}T00:00:00Z`, endedAt: `${date}T${end}:00Z` })
    }
    await browser.navigate(true); await ready(); await openBlock(firstPart.id)
    assert.equal((await api(`/tasks/${lecture.id}`)).actualMinutes, 450)
    assert.deepEqual(await browser.evaluate('[...document.querySelectorAll(".calendar-popover-totals dd")].filter((_,i)=>i!==1).map(e=>e.textContent)'), ['7時間30分', '12時間'])
    assert.equal(await browser.evaluate('document.querySelector(".calendar-popover .task-time-bar")'), null)
    assert.equal(await browser.evaluate('/進捗|%/.test(document.querySelector(".calendar-popover-totals").textContent)'), false)
    await close()
    await browser.click('.icon-rail [aria-label="タスク"]')
    await browser.click(`.task-table-row[data-task-id="${lecture.id}"] .task-row-edit`)
    await browser.until('document.querySelector(".task-time-totals")?.textContent.includes("7時間30分")','Task time totals')
    assert.deepEqual(await browser.evaluate('[...document.querySelectorAll(".task-time-totals dt")].map(e=>e.textContent)'),['記録','計画済み','見積もり'])
    assert.equal(await browser.evaluate('document.querySelector(".task-composer .task-time-comparison")'),null)
    await browser.click('.task-composer .icon-close'); await browser.click('.icon-rail [aria-label="ホーム"]'); await ready()
  })
  await t.test('Popover records actual beyond estimate without clamping the displayed total', async () => {
    await api('/time-entries', { taskId: lecture.id, startedAt: '2026-09-30T00:00:00Z', endedAt: '2026-09-30T05:30:00Z' })
    await browser.navigate(true); await ready(); await openBlock(firstPart.id)
    assert.deepEqual(await browser.evaluate('[...document.querySelectorAll(".calendar-popover-totals dd")].filter((_,i)=>i!==1).map(e=>e.textContent)'), ['13時間', '12時間'])
    assert.equal(await browser.evaluate('document.querySelector(".calendar-popover .task-time-bar")'), null)
    await close()
  })
  const selectedBlock = `[data-schedule-block-id="${firstPart.id}"]`
  const fits = width => `(()=>{const p=document.querySelector('.calendar-popover');if(!p)return false;const r=p.getBoundingClientRect();return r.left>=0&&r.right<=${width}&&r.top>=0&&r.bottom<=1000&&p.scrollWidth<=p.clientWidth})()`
  await t.test('Schedule click opens a non-modal Popover beside its Block without changing Calendar layout', async () => {
    await size(1440); await mode('week')
    await browser.evaluate(`document.querySelector('${selectedBlock}').scrollIntoView({block:'center',inline:'center'})`)
    const before = await browser.evaluate('(()=>{const r=document.querySelector(".calendar-time-grid").getBoundingClientRect();return [r.width,r.height]})()')
    await openBlock(firstPart.id); await browser.until(fits(1440), 'Popover fits')
    const geometry = await browser.evaluate(`(()=>{const a=document.querySelector('${selectedBlock}').getBoundingClientRect(),p=document.querySelector('.calendar-popover').getBoundingClientRect();return {gap:Math.min(Math.abs(p.left-a.right),Math.abs(a.left-p.right)),width:p.width}})()`)
    assert(geometry.gap<=12&&geometry.width<=340, JSON.stringify(geometry))
    assert.deepEqual(await browser.evaluate('(()=>{const r=document.querySelector(".calendar-time-grid").getBoundingClientRect();return [r.width,r.height]})()'),before)
    assert.equal(await browser.evaluate('document.querySelector("dialog[open]")===null'),true)
    const details = await browser.evaluate('Array.from(document.querySelectorAll(".calendar-popover-schedule > div")).map(e=>[e.querySelector(".task-attribute-label").textContent,e.querySelector(".task-attribute-control").textContent])')
    assert.deepEqual(details,[['日付',day.replaceAll('-','/')+'（土）'],['時刻','06:00 – 11:45'],['計画時間','5時間45分']])
    assert(await browser.evaluate('!document.querySelector(".calendar-popover [name=date], .calendar-popover [name=startTime], .calendar-popover [name=durationMinutes], .calendar-popover [name=type]")'))
    assert(await browser.evaluate('document.querySelector(".calendar-popover").contains(document.activeElement)'))
    assert.equal(await browser.evaluate(`document.querySelector('${selectedBlock}').getAttribute('aria-controls')`),'schedule-detail')
    await screenshot('schedule-popover-desktop'); await close()
  })
  for (const width of [1440,1024,768,375]) await t.test(`Schedule Popover fits ${width}px and only mobile uses the bottom Sheet`, async () => {
    await size(width); await browser.evaluate(`document.querySelector('${selectedBlock}').scrollIntoView({block:'center',inline:'center'})`)
    await openBlock(firstPart.id); await browser.until(fits(width),'Responsive Popover')
    if(width===375) assert(await browser.evaluate('Math.abs(document.querySelector(".calendar-popover").getBoundingClientRect().bottom-innerHeight+8)<2'))
    await screenshot('schedule-popover-'+width); await close()
  })
  for (const [horizontal,vertical] of [['left','top'],['right','top'],['left','bottom'],['right','bottom']]) await t.test(`Popover adjusts at the ${horizontal}/${vertical} viewport edges`, async () => {
    await size(1440)
    const original = await browser.evaluate(`(()=>{const a=document.querySelector('${selectedBlock}'),old=a.style.cssText;a.style.cssText='position:fixed;z-index:5;width:120px;height:70px;${horizontal}:8px;${vertical}:8px;';return old})()`)
    await openBlock(firstPart.id); await browser.until(fits(1440),'Edge Popover')
    assert(await browser.evaluate(`(()=>{const a=document.querySelector('${selectedBlock}').getBoundingClientRect(),p=document.querySelector('.calendar-popover').getBoundingClientRect();return ${horizontal==='left'?'p.left>=a.right':'p.right<=a.left'}})()`))
    await screenshot('schedule-edge-'+horizontal+'-'+vertical); await close()
    await browser.evaluate(`document.querySelector('${selectedBlock}').style.cssText=${JSON.stringify(original)}`)
  })
  await t.test('Enter and Space open; Tab stays on an internal control; Escape and Outside Click close with focus restored', async () => {
    for(const key of ['Enter',' ']){
      await browser.evaluate(`document.querySelector('${selectedBlock}').focus()`)
      await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key,code:key==='Enter'?'Enter':'Space',windowsVirtualKeyCode:key==='Enter'?13:32})
      await browser.send('Input.dispatchKeyEvent',{type:'keyUp',key,code:key==='Enter'?'Enter':'Space',windowsVirtualKeyCode:key==='Enter'?13:32})
      await dialogReady()
      await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9})
      await browser.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9})
      assert(await browser.evaluate('document.querySelector(".calendar-popover").contains(document.activeElement)'))
      await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
      await browser.until('!document.querySelector(".calendar-popover")','Esc closed')
      assert(await browser.evaluate(`document.activeElement===document.querySelector('${selectedBlock}')`))
      assert.equal(await browser.evaluate(`document.querySelector('${selectedBlock}').getAttribute('aria-expanded')`),'false')
    }
    await openBlock(firstPart.id); await browser.evaluate('document.querySelector(".home-calendar-header").dispatchEvent(new MouseEvent("click",{bubbles:true}))')
    await browser.until('!document.querySelector(".calendar-popover")','Outside closed')
  })
  await t.test('Project Quick Edit saves immediately, retains Popover and retries failed assignment without changing history', async () => {
    const priorPlans=await plans(),priorEntries=await api(`/tasks/${lecture.id}/time-entries`)
    await openBlock(firstPart.id);await browser.click('.calendar-popover-project .project-picker-trigger')
    await browser.until('document.querySelector(".project-picker-popup")','Project Picker')
    failProjectChange=true;await browser.click(`.project-picker-popup [data-project-id="${project.id}"]`)
    await browser.until('document.querySelector(".project-picker-popup [role=alert]")','Failed Project update')
    assert.equal((await api(`/tasks/${lecture.id}`)).projectId,null)
    failProjectChange=false;await browser.click(`.project-picker-popup [data-project-id="${project.id}"]`)
    await browser.until('document.querySelector(".calendar-popover-project").textContent.includes("Calendar Project")&&!document.querySelector(".project-picker-popup")','Project synchronized')
    assert.equal((await api(`/tasks/${lecture.id}`)).projectId,project.id)
    await browser.click('.calendar-popover-project .project-picker-trigger');await browser.until('document.querySelector(".project-picker-popup")','Project Picker reopened');await browser.click('.project-picker-popup [data-project-id=""]')
    await browser.until('document.querySelector(".calendar-popover-project").textContent.includes("\u672a\u8a2d\u5b9a")&&!document.querySelector(".project-picker-popup")','Project cleared')
    assert.equal((await api(`/tasks/${lecture.id}`)).projectId,null);assert.deepEqual(await api(`/tasks/${lecture.id}/time-entries`),priorEntries);assert.deepEqual(await plans(),priorPlans);await close()
  })
  await t.test('Unschedule deletes only one Block, retains Task, and returns to Inbox only after the final Block', async () => {
    const task=await api('/tasks',{title:'Two Popover schedules',estimatedMinutes:60})
    const first=await api('/schedule-blocks',{taskId:task.id,date:day,type:'ALL_DAY'})
    const last=await api('/schedule-blocks',{taskId:task.id,date:'2026-10-02',type:'TIME_UNSET'})
    await browser.navigate(true);await ready();await openBlock(first.id);await browser.click('.calendar-dialog .danger')
    await browser.until('!document.querySelector(".calendar-dialog")','First released');await ready()
    assert((await plans()).some(b=>b.id===last.id));assert.equal((await api(`/tasks/${task.id}`)).id,task.id)
    assert.equal((await api('/tasks?inbox=true')).some(t=>t.id===task.id),false)
    assert.equal(await browser.evaluate(`document.querySelector('[data-inbox-task-id="${task.id}"]')===null`),true)
    await openBlock(last.id);await browser.click('.calendar-dialog .danger');await browser.until('!document.querySelector(".calendar-dialog")','Last released');await ready()
    assert.equal((await api(`/tasks/${task.id}`)).id,task.id)
    assert((await api('/tasks?inbox=true')).some(t=>t.id===task.id))
    await browser.until(`document.querySelector('[data-inbox-task-id="${task.id}"]')`,'Inbox restored')
  })
  await t.test('Timed Block density prioritizes Task then Project then formatted duration, independently of estimate', async () => {
    const task=await api('/tasks',{title:'Readable Block',estimatedMinutes:720,projectId:project.id})
    const ids=[]
    for(const[startTime,durationMinutes]of [['07:00',90],['08:30',60],['09:30',15]])ids.push((await api('/schedule-blocks',{taskId:task.id,date:day,type:'TIMED',startTime,durationMinutes})).id)
    await browser.navigate(true);await ready()
    for(const[index,id]of ids.entries()){
      const visible=await browser.evaluate(`(()=>{const a=document.querySelector('[data-schedule-block-id="${id}"]');return {density:a.dataset.density,title:a.querySelector('strong').textContent,project:getComputedStyle(a.querySelector('.schedule-block-project')).display!=='none',duration:getComputedStyle(a.querySelector('.schedule-block-duration')).display!=='none',time:a.querySelector('.schedule-block-duration').textContent,font:parseFloat(getComputedStyle(a.querySelector('strong')).fontSize)}})()`)
      assert.equal(visible.title,task.title);assert(visible.font>=12)
      assert.deepEqual([visible.density,visible.project,visible.duration],[['full',true,true],['medium',true,true],['short',false,false]][index])
      if(index===0)assert.equal(visible.time,'1時間30分')
    }
    await drag(`[data-schedule-block-id="${ids[0]}"]`,'[data-timed-drop-date="2026-10-02"]',660)
    await changed(ids[0],'TIMED','2026-10-02')
    assert.equal(await browser.evaluate('document.querySelector(".calendar-popover")===null'),true)
  })
  let metadataTask,metadataBlock,metadataEntry
  await t.test('Simple Schedule Popover directly renames Task and separates placement from recorded and estimate totals',async()=>{
    metadataTask=await api('/tasks',{title:'Popover metadata',estimatedMinutes:90,projectId:project.id})
    metadataBlock=await api('/schedule-blocks',{taskId:metadataTask.id,date:day,type:'TIMED',startTime:'16:00',durationMinutes:60})
    metadataEntry=await api('/time-entries',{taskId:metadataTask.id,startedAt:'2026-10-01T22:00:00Z',endedAt:'2026-10-01T22:15:00Z'})
    await size(1440);await browser.navigate(true);await ready();await openBlock(metadataBlock.id)
    const text=await browser.evaluate('document.querySelector(".calendar-popover").textContent')
    assert.deepEqual(await browser.evaluate('[...document.querySelectorAll(".calendar-popover-totals dd")].filter((_,i)=>i!==1).map(e=>e.textContent)'), ['15分', '1時間30分'])
    assert(!/予定種別|開始時刻|TIME_UNSET|ALL_DAY|TIMED/.test(text),text)
    assert.deepEqual(await browser.evaluate('[...document.querySelectorAll(".calendar-popover-schedule .task-attribute-control")].map(e=>e.textContent)'),[day.replaceAll('-','/')+'（土）','16:00 – 17:00','1時間'])
    assert(text.includes('計画済み')&&!text.includes('durationMinutes'));assert.equal(await browser.evaluate('document.querySelector(".calendar-popover-totals > div:nth-child(2) dd").textContent'),'1時間');assert.equal(await browser.evaluate('document.querySelector(".task-detail [name=estimatedMinutes]")'),null)
    assert.deepEqual(await browser.evaluate('[...document.querySelectorAll(".calendar-popover-totals dt")].map(e=>e.textContent)'), ['記録', '計画済み', '見積もり'])
    assert.equal(await browser.evaluate('document.querySelector(".task-detail").dataset.taskDetailId'),String(metadataTask.id))
    await browser.click('.calendar-popover .task-title-input button')
    await browser.evaluate('(()=>{const e=document.querySelector(".calendar-popover .task-title-input input");e.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(e,"Popoverで変更");e.dispatchEvent(new Event("input",{bubbles:true}));})()')
    await browser.evaluate('document.querySelector(".calendar-popover .task-title-input input").blur()')
    await browser.until('document.querySelector(".calendar-popover h2").textContent==="Popoverで変更"&&!document.querySelector(".calendar-popover [aria-label=予定の操作を閉じる]").disabled','Popover rename saved')
    assert.equal((await api(`/tasks/${metadataTask.id}`)).title,'Popoverで変更')
    assert.deepEqual(await api(`/tasks/${metadataTask.id}/time-entries`),[metadataEntry])
    assert.deepEqual((await plans()).find(b=>b.id===metadataBlock.id),metadataBlock)
    await screenshot('fix3-simple-popover');await close()
  })
  async function editTaskFromSchedule(blockId, fields) {
    await openBlock(blockId)
    await browser.click('.calendar-dialog-actions .task-detail-edit')
    await browser.until('document.querySelector(".task-editor-panel[open]")', 'Common Task Editor from Schedule')
    for (const [name, value] of Object.entries(fields)) {
      if (name === 'projectId') await selectProject(browser, '.task-editor-panel [name=projectId]', value)
      else await browser.evaluate(`(()=>{const e=document.querySelector('.task-editor-panel [name="${name}"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`)
    }
  }
  await t.test('Common Task Editor saves Schedule Task metadata separately from one-minute placement and Snapshot',async()=>{
    await editTaskFromSchedule(metadataBlock.id,{title:'Taskと予定を編集',projectId:'',estimatedMinutes:'2.5h'})
    await browser.click('.task-editor-panel [type=submit]')
    await browser.until('!document.querySelector(".task-editor-panel")','Common Task Editor saved')
    assert.deepEqual((await plans()).find(b=>b.id===metadataBlock.id),metadataBlock)
    await editFields(metadataBlock.id,{date:'2026-10-02',startTime:'16:07',durationMinutes:'2h 37m'})
    assert(await browser.evaluate('document.querySelector(".calendar-dialog").textContent.includes("計画時間")'))
    assert.equal(await browser.evaluate('document.querySelectorAll(".calendar-dialog .task-time-comparison").length'),0)
    assert.equal(await browser.evaluate('document.querySelectorAll(".schedule-record-total").length'),0)
    await screenshot('fix3-schedule-edit');await saveEdit()
    const task=await api(`/tasks/${metadataTask.id}`),block=(await plans()).find(b=>b.id===metadataBlock.id)
    assert.equal(task.title,'Taskと予定を編集');assert.equal(task.projectId,null);assert.equal(task.estimatedMinutes,150)
    assert.equal(block.date,'2026-10-02');assert.equal(block.startTime,'16:07:00');assert.equal(block.durationMinutes,157);assert.equal(block.type,'TIMED')
    assert.deepEqual(await api(`/tasks/${metadataTask.id}/time-entries`),[metadataEntry])
  })
  await t.test('A common Task update failure leaves Schedule untouched and retains editor draft',async()=>{
    const before=(await plans()).find(b=>b.id===metadataBlock.id),patches=requests.filter(r=>r.method==='PATCH').length
    await editTaskFromSchedule(metadataBlock.id,{title:'部分失敗の確認'})
    failProjectChange=true;await browser.click('.task-editor-panel [type=submit]')
    await browser.until('document.querySelector(".task-editor-panel [role=alert]")','Task failure visible')
    assert.equal(requests.filter(r=>r.method==='PATCH').length,patches)
    assert.equal((await api(`/tasks/${metadataTask.id}`)).title,'Taskと予定を編集')
    assert.deepEqual((await plans()).find(b=>b.id===metadataBlock.id),before)
    assert.equal(await browser.evaluate('document.querySelector(".task-editor-panel [name=title]").value'),'部分失敗の確認')
    failProjectChange=false;await browser.click('.task-editor-panel [type=submit]')
    await browser.until('!document.querySelector(".task-editor-panel")','Common Task retry saved')
  })
  await t.test('A Schedule failure retains placement draft and retry never updates Task metadata',async()=>{
    const before=(await plans()).find(b=>b.id===metadataBlock.id)
    const updates=requests.filter(r=>r.method==='PUT'&&r.path===`/tasks/${metadataTask.id}`).length
    await editFields(metadataBlock.id,{durationMinutes:'3h'})
    failPatch=true;await browser.click('.calendar-dialog button[type=submit]')
    await browser.until('document.querySelector(".calendar-dialog [role=alert]")','Schedule failure explicit')
    assert.equal((await api(`/tasks/${metadataTask.id}`)).title,'部分失敗の確認')
    assert.deepEqual((await plans()).find(b=>b.id===metadataBlock.id),before)
    failPatch=false;await saveEdit()
    assert.equal(requests.filter(r=>r.method==='PUT'&&r.path===`/tasks/${metadataTask.id}`).length,updates)
    assert.equal((await plans()).find(b=>b.id===metadataBlock.id).durationMinutes,180)
    assert.deepEqual(await api(`/tasks/${metadataTask.id}/time-entries`),[metadataEntry])
  })
  for(const [inputValue,minutes] of [['3h',180],['2h 30m',150],['150m',150],['1m',1]])await t.test(`Schedule length ${inputValue} saves ${minutes} minutes without snap rounding`,async()=>{
    await editFields(metadataBlock.id,{durationMinutes:inputValue});await saveEdit()
    const block=(await plans()).find(b=>b.id===metadataBlock.id)
    assert.equal(block.durationMinutes,minutes);assert.equal(block.startTime,'16:07:00');assert.equal(block.type,'TIMED')
    assert.equal((await api(`/tasks/${metadataTask.id}`)).estimatedMinutes,150)
  })
  await t.test('Actual Block prioritizes Task, Snapshot Project and recorded duration while detail retains timestamps',async()=>{
    const selector=`.calendar-event.actual[data-time-entry-id="${metadataEntry.id}"]`
    const primary=await browser.evaluate(`document.querySelector('${selector}').textContent`)
    assert(primary.includes('部分失敗の確認')&&primary.includes('Calendar Project')&&primary.includes('15分'),primary)
    assert(!/\d{2}:\d{2}/.test(primary),primary)
    await browser.evaluate(`document.querySelector('${selector}').scrollIntoView({block:'center'})`)
    await screenshot('fix3-actual-block');await browser.click(selector)
    await browser.until('document.querySelector(".time-entry-dialog .actual-detail")','Actual detail')
    const detail=await browser.evaluate('document.querySelector(".actual-detail").textContent')
    assert(detail.includes('開始')&&detail.includes('終了')&&/0?7:00/.test(detail)&&/0?7:15/.test(detail)&&detail.includes('15分'),detail)
    await browser.click('.time-entry-dialog [aria-label="記録の操作を閉じる"]')
  })
  for(const type of ['TIME_UNSET','ALL_DAY'])await t.test(`${type} shared Detail shows date record and unset time without TIMED fields`,async()=>{
    const task=await api('/tasks',{title:type==='TIME_UNSET'?'日付のみの予定':'一日を使う予定',estimatedMinutes:null})
    const block=await api('/schedule-blocks',{taskId:task.id,date:day,type})
    await size(1440);await browser.navigate(true);await ready()
    if(await browser.evaluate('document.querySelector(".calendar-row-toggle").getAttribute("aria-expanded")==="false"'))await browser.click('.calendar-row-toggle')
    for(const width of [1440,375]){
      await size(width);await openBlock(block.id);await browser.until(fits(width),'Untimed Popover fits')
      assert.equal(await browser.evaluate('document.querySelector(".task-detail").dataset.taskDetailId'),String(task.id))
      assert.deepEqual(await browser.evaluate('[...document.querySelectorAll(".calendar-popover-schedule .task-attribute-label")].map(e=>e.textContent)'),['日付','時刻','計画時間'])
      assert.equal(await browser.evaluate('document.querySelectorAll(".calendar-popover-schedule .task-attribute-control")[1].textContent'),'未設定')
      assert.equal(await browser.evaluate('document.querySelector(".calendar-popover-schedule time").textContent'),day.replaceAll('-','/')+'（土）')
      const text=await browser.evaluate('document.querySelector(".calendar-popover").textContent')
      assert(text.includes('未設定')&&!text.includes('未見積もり'),text)
      assert.deepEqual(await browser.evaluate('[...document.querySelectorAll(".calendar-popover-totals > div")].filter((_,i)=>i!==1).map(e=>[e.querySelector("dt").textContent,e.querySelector("dd").textContent])'),[['記録','0分'],['見積もり','未設定']])
      assert(!/予定種別|TIME_UNSET|ALL_DAY|TIMED|durationMinutes/.test(text),text)
      assert.equal(await browser.evaluate('document.querySelector(".task-detail-top-actions .task-timer-always").disabled'),false)
      assert(await browser.evaluate('document.querySelector(".calendar-dialog-actions .danger").textContent==="この予定を解除"'))
      await screenshot(`fix4-popover-${type.toLowerCase()}-${width}`);await close()
    }
  })
  await t.test('Quick Detail uses shared Status Row Timer and read-only time summary; status failure retains original',async()=>{
    const task=await api('/tasks',{title:'Shared Quick Status',projectId:project.id,estimatedMinutes:120}),block=await api('/schedule-blocks',{taskId:task.id,date:day,type:'TIMED',startTime:'18:00',durationMinutes:60})
    await size(1440);await browser.navigate(true);await ready();await openBlock(block.id)
    assert.equal(await browser.evaluate('document.querySelectorAll(".task-detail-top-row .task-status-control").length'),1)
    assert.equal(await browser.evaluate('document.querySelectorAll(".task-detail-top-row [data-icon=play],.task-detail-top-row [data-icon=close]").length'),2)
    assert.deepEqual(await browser.evaluate('[...document.querySelectorAll(".task-detail .task-attribute-label")].map(e=>e.textContent)'),['タスク名','プロジェクト','タグ','日付','時刻','計画時間'])
    assert.equal(await browser.evaluate('document.querySelector(".task-detail [name=estimatedMinutes],.task-detail-time-summary input,.task-detail-time-summary select,.task-detail-time-summary .task-inline-value")'),null)
    assert.deepEqual(await browser.evaluate('[...document.querySelectorAll(".calendar-popover-totals dd")].map(e=>e.textContent)'),['0分','1時間','2時間'])
    const setStatus=async value=>browser.evaluate(`(()=>{const e=document.querySelector('.task-detail [name=status]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    failProjectChange=true;await setStatus('IN_PROGRESS');await browser.until('document.querySelector(".task-status-control [role=alert]")','Status failure shown');assert.equal((await api(`/tasks/${task.id}`)).status,'NOT_STARTED');assert.equal(await browser.evaluate('document.querySelector(".task-detail .task-status-control").dataset.taskStatus'),'NOT_STARTED')
    failProjectChange=false
    for(const status of ['IN_PROGRESS','COMPLETED','NOT_STARTED']){await setStatus(status);await browser.until(`document.querySelector('.task-detail .task-status-control')?.dataset.taskStatus==='${status}'&&!document.querySelector('.task-detail-close').disabled`,'Status saved');assert.equal((await api(`/tasks/${task.id}`)).status,status)}
    const colors=await browser.evaluate('[...document.querySelectorAll(".task-detail [data-icon=folder]")].map(e=>getComputedStyle(e).color)');assert.equal(colors.length,2);assert.notEqual(colors[0],colors[1])
    assert.equal(await browser.evaluate('getComputedStyle(document.querySelector(".task-detail .project-picker-trigger > span")).color'),colors[1])
    assert.equal(await browser.evaluate('document.querySelector(".task-detail .task-status-chip .ui-icon")'),null)
    assert(await browser.evaluate('[...document.querySelectorAll(".task-detail .task-time-summary dd > strong")].every(e=>e.getBoundingClientRect().height===40&&parseFloat(getComputedStyle(e).fontSize)>=14)'))
    await close()
  })
  await t.test('TIME_UNSET date Quick Edit preserves type; time Quick Edit updates the same Block to TIMED with sixty minutes',async()=>{
    const task=await api('/tasks',{title:'Quick TIME_UNSET',estimatedMinutes:90})
    const block=await api('/schedule-blocks',{taskId:task.id,date:day,type:'TIME_UNSET'})
    await size(1440);await browser.navigate(true);await ready();await openBlock(block.id)
    assert.equal(await browser.evaluate('[...document.querySelectorAll(".calendar-dialog button")].some(e=>e.textContent==="予定を編集")'),false)
    assert(await browser.evaluate('!!document.querySelector(".calendar-dialog .danger")'))
    await browser.click('[data-schedule-field=date]');await input('date','2026-10-02');await browser.click('.calendar-inline-schedule-actions [type=submit]')
    await browser.until('!document.querySelector(".calendar-inline-schedule-actions")&&!document.querySelector("[data-schedule-field=startTime]").disabled','Date Quick Edit saved')
    let stored=(await plans()).find(b=>b.id===block.id);assert.equal(stored.type,'TIME_UNSET');assert.equal(stored.date,'2026-10-02');assert.equal(stored.startTime,null)
    assert(await browser.evaluate('document.querySelector(".calendar-dialog .task-detail")!==null'))
    await browser.click('[data-schedule-field=startTime]');await input('startTime','14:07');await browser.click('.calendar-inline-schedule-actions [type=submit]')
    await browser.until('!document.querySelector(".calendar-inline-schedule-actions")&&!document.querySelector(".calendar-dialog [aria-label=予定の操作を閉じる]").disabled','Time Quick Edit saved')
    stored=(await plans()).find(b=>b.id===block.id);assert.equal(stored.type,'TIMED');assert.equal(stored.startTime,'14:07:00');assert.equal(stored.durationMinutes,60);assert.equal(stored.date,'2026-10-02')
    assert.equal((await plans()).filter(b=>b.taskId===task.id).length,1);assert.equal((await api(`/tasks/${task.id}`)).estimatedMinutes,90)
    assert(await browser.evaluate('document.querySelector(".calendar-dialog").textContent.includes("14:07")'))
    await browser.until(`document.querySelector('.calendar-event.planned[data-schedule-block-id="${block.id}"]')`,'TIMED Block synchronized')
    await close()
  })
  await t.test('TIMED Popover formats a midnight crossing with minute precision and the Block length',async()=>{
    const task=await api('/tasks',{title:'夜の予定',estimatedMinutes:360,projectId:project.id})
    const block=await api('/schedule-blocks',{taskId:task.id,date:day,type:'TIMED',startTime:'23:45',durationMinutes:150})
    await size(1440);await browser.navigate(true);await ready();await openBlock(block.id)
    assert.deepEqual(await browser.evaluate('[...document.querySelectorAll(".calendar-popover-schedule .task-attribute-control")].map(e=>e.textContent)'),[day.replaceAll('-','/')+'（土）','23:45 – 02:15 (+1日)','2時間30分'])
    const text=await browser.evaluate('document.querySelector(".calendar-popover").textContent')
    assert.deepEqual(await browser.evaluate('[...document.querySelectorAll(".calendar-popover-totals dd")].filter((_,i)=>i!==1).map(e=>e.textContent)'), ['0分', '6時間'])
    assert(!text.includes('150分')&&!text.includes('23:45:00')&&!text.includes('予定種別'),text)
    await screenshot('fix4-popover-midnight');await close()
  })
  assert.deepEqual(errors, [], 'No browser or forwarding errors')
})
