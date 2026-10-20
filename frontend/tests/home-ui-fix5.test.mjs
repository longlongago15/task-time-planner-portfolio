import { isolateScenarios } from './scenario-fixture.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { openBrowser } from './browser.mjs'

test('Fix5 Summary, combined counts, Hover Timer and native selection use a guarded temporary DB', { timeout: 240000 }, async t => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const python = process.env.TIMER_TEST_PYTHON ?? path.join(root, 'backend', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  const directory = await mkdtemp(path.join(tmpdir(), 'task-timer-db-'))
  const day = '2026-10-05', sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  let browser, backend, base, inFlight = 0, clockVersion = 0, now = Date.parse(`${day}T12:34:00+09:00`)
  const errors = [], requests = []
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
  async function clock() {
    const staging = path.join(directory, `clock-${++clockVersion}.txt`)
    await writeFile(staging, new Date(now).toISOString())
    for (let attempt = 0; ; attempt++) {
      try { await rename(staging, path.join(directory, 'clock.txt')); break } catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 30) throw error
        await sleep(20)
      }
    }
    if (browser) await browser.evaluate(`window.__fix5Now=${now};undefined`)
  }
  await clock()
  backend = spawn(python, ['-B', fileURLToPath(new URL('./isolated-backend.py', import.meta.url)), directory], {
    cwd: root, windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = '', backendLog = ''
  backend.stdout.on('data', chunk => { output += chunk.toString() })
  backend.stderr.on('data', chunk => { backendLog += chunk.toString() })
  for (let attempt = 0; attempt < 200; attempt++) {
    const port = output.match(/TIMER_TEST_PORT=(\d+)/)?.[1]
    if (port) {
      base = `http://127.0.0.1:${port}`
      try { if ((await fetch(`${base}/health`)).ok) break } catch { /* Starting. */ }
    }
    assert.equal(backend.exitCode, null, backendLog)
    if (attempt === 199) assert.fail(`Temporary Backend did not start: ${output}\n${backendLog}`)
    await sleep(50)
  }
  async function api(route, payload, method = 'POST') {
    const response = await fetch(`${base}${route}`, payload === undefined ? {} : {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })
    assert(response.ok, `${route}: ${response.status} ${await response.clone().text()}`)
    return response.json()
  }
  const project = await api('/projects', { name: '開発' })
  const learning = await api('/projects', { name: '学習' })
  const task = async (title, estimatedMinutes = 150, projectId = project.id) => api('/tasks', { title, estimatedMinutes, projectId })
  const inbox = await task('未配置のタスク')
  const allDayTask = await task('終日の学習', 240, learning.id)
  const unsetTask = await task('日付のみの作業', 90)
  const timedTask = await task('設計を進める', 360)
  const actualTask = await task('資料を読む', 240)
  const morningTask = await task('朝の記録', 300, learning.id)
  const completedTask = await task('完了済みの作業')
  const allDay = await api('/schedule-blocks', { taskId: allDayTask.id, date: day, type: 'ALL_DAY' })
  const unset = await api('/schedule-blocks', { taskId: unsetTask.id, date: '2026-10-06', type: 'TIME_UNSET' })
  const timed = await api('/schedule-blocks', { taskId: timedTask.id, date: day, type: 'TIMED', startTime: '06:00', durationMinutes: 150 })
  const completedBlock = await api('/schedule-blocks', { taskId: completedTask.id, date: '2026-10-07', type: 'ALL_DAY' })
  const actual = await api('/time-entries', { taskId: actualTask.id, startedAt: `${day}T00:00:00Z`, endedAt: `${day}T01:40:00Z` })
  await api('/time-entries', { taskId: morningTask.id, startedAt: '2026-10-04T15:00:00Z', endedAt: '2026-10-04T17:59:00Z' })
  const completedEntry = await api('/time-entries', { taskId: completedTask.id, startedAt: `${day}T01:45:00Z`, endedAt: `${day}T02:45:00Z` })
  await api(`/tasks/${completedTask.id}/complete`, { completed: true }, 'PATCH')
  // Restart uses current membership; the original Actual retains its Snapshot.
  await api(`/tasks/${actualTask.id}`, { projectId: learning.id }, 'PUT')

  browser = await openBrowser()
  await browser.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' })
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const D=Date;window.__fix5Now=${now};window.confirm=()=>true;
    window.Date=class extends D{constructor(...a){super(...(a.length?a:[window.__fix5Now]));}static now(){return window.__fix5Now;}};
  })()` })
  browser.listeners.push(message => {
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method !== 'Fetch.requestPaused') return
    const { request, requestId } = message.params
    inFlight++
    void (async () => {
      if (request.method === 'OPTIONS') { await browser.fulfill(requestId, {}); return }
      const url = new URL(request.url)
      requests.push({ method: request.method, path: url.pathname, payload: request.postData ? JSON.parse(request.postData) : null })
      const response = await fetch(`${base}${url.pathname}${url.search}`, { method: request.method,
        ...(request.postData ? { headers: { 'Content-Type': 'application/json' }, body: request.postData } : {}) })
      await browser.fulfill(requestId, await response.json(), response.status)
    })().catch(async error => {
      if (/Invalid [Ii]nterception|Invalid requestId/.test(error.message)) return
      errors.push(error.message)
      try { await browser.send('Fetch.failRequest', { requestId, errorReason: 'ConnectionFailed' }) } catch { /* Closing. */ }
    }).finally(() => { inFlight-- })
  })
  await browser.send('Fetch.enable', { patterns: [{ urlPattern: 'http://localhost:8000/*', requestStage: 'Request' }] })
  const size = width => browser.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false })
  async function ready() {
    await browser.until('document.querySelector(".calendar-grid-content")&&!document.querySelector(".calendar-schedule-status [role=status]")', 'Calendar rendered')
    for (let i = 0; i < 200; i++) { if (!inFlight) { await sleep(60); if (!inFlight) return } await sleep(20) }
    assert.fail('API reads did not settle')
  }
  const mode = async value => { await browser.click(`.calendar-mode-switch[aria-label="カレンダー表示"] button:nth-child(${value === 'day' ? 1 : 2})`); await ready() }
  const block = id => `[data-schedule-block-id="${id}"]`
  const entry = id => `.calendar-event.actual[data-time-entry-id="${id}"]`
  const postCount = route => requests.filter(r => r.method === 'POST' && r.path === route).length
  async function shot(name) {
    if (!process.env.FIX5_VISUAL_OUTPUT) return
    const folder = path.resolve(process.env.FIX5_VISUAL_OUTPUT), relative = path.relative(path.resolve(tmpdir()), folder)
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
    const result = await browser.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    await writeFile(path.join(folder, name + '.png'), Buffer.from(result.data, 'base64'))
  }
  async function point(selector, scroll = true) {
    if (scroll) {
      await browser.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',inline:'nearest'})`)
      await browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    }
    return browser.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`)
  }
  async function clickAt(selector) {
    const p = await point(selector, false)
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p })
    for (const type of ['mousePressed', 'mouseReleased']) await browser.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 })
  }
  async function hover(selector) {
    const before = await browser.evaluate(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON()`)
    const p = await point(selector)
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p })
    const action = `${selector} .task-hover-start`
    await browser.until(`getComputedStyle(document.querySelector(${JSON.stringify(action)})).opacity==='1'`, 'Hover action visible')
    assert(await browser.evaluate(`(()=>{const s=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(),b=document.querySelector(${JSON.stringify(action)}).getBoundingClientRect();return b.width>0&&b.height>0&&b.left>=s.left&&b.right<=s.right&&b.top>=s.top&&b.bottom<=s.bottom&&s.width===${before.width}&&s.height===${before.height}})()`), 'Play stays inside its Card without changing its size')
    assert(await browser.evaluate(`!document.querySelector(${JSON.stringify(selector)}).querySelector('.schedule-release-button')`), 'No Hover release')
    return action
  }
  async function stop() {
    now += 60000; await clock()
    await browser.until('document.querySelector(".timer-stop")?.disabled===false', 'Stop ready')
    await browser.click('.global-top-timer .timer-stop')
    await browser.until('!document.querySelector(".global-top-timer.timer-session")&&!document.querySelector(".timer-play-button").disabled', 'Timer stopped')
    await ready()
  }
  const selectionEmpty = () => browser.evaluate('getSelection().toString()===""&&getSelection().isCollapsed')
  const noDetail = () => browser.evaluate('!document.querySelector(".calendar-dialog,.time-entry-dialog,.task-drawer")')
  async function closeSchedule() { await browser.click('.calendar-dialog [aria-label="予定の操作を閉じる"]'); await browser.until('!document.querySelector(".calendar-dialog")', 'Schedule closed') }
  await size(1440); await browser.navigate(); await ready()

  await isolateScenarios(t, { browser, directory, python,
    prepare: async () => { now = Date.parse(`${day}T12:34:00+09:00`); await clock() },
    ready: async () => {
      await ready(); await mode('week')
      if (await browser.evaluate('document.querySelector(".calendar-row-toggle").getAttribute("aria-expanded")') !== 'true') await browser.click('.calendar-row-toggle')
    },
  })
  await t.test('Fix6 shared icons and day headers keep counts centred for both toggle states', async () => {
    const inspect = () => browser.evaluate(`(()=>{const b=document.querySelector('.calendar-row-toggle'),i=b.querySelector('svg'),r=b.getBoundingClientRect();return {width:r.width,height:r.height,icon:[i.getAttribute('width'),i.getAttribute('height'),i.getAttribute('stroke-width')],offsets:[...document.querySelectorAll('.calendar-date-count')].map(e=>{const c=e.getBoundingClientRect();return c.top+c.height/2-r.top-r.height/2})}})()`)
    const closed = await inspect()
    await browser.click('.calendar-row-toggle')
    assert.deepEqual(await inspect(), closed)
    assert(closed.offsets.every(x => Math.abs(x) <= 1), JSON.stringify(closed))
    assert.deepEqual(closed.icon, ['18', '18', '2'])
    assert(await browser.evaluate(`(()=>{const icons=[...document.querySelectorAll('[data-icon="folder"]')];return icons.length>=4&&icons.every(i=>i.getAttribute('stroke-width')==='2'&&i.querySelector('path').getAttribute('d')===icons[0].querySelector('path').getAttribute('d'))})()`))
    assert(await browser.evaluate(`(()=>{const e=document.querySelector('.calendar-week-header:not(.calendar-lane-header)>button'),s=getComputedStyle(e),d=getComputedStyle(e.querySelector('strong'));return e.offsetHeight===58&&parseFloat(s.fontSize)>=14&&parseFloat(d.fontSize)>=20&&!!document.querySelector('.calendar-week-header>button.today strong')})()`))
    await browser.click('.calendar-row-toggle')
  })

  for (const width of [1440, 1024, 768, 375]) for (const value of ['week', 'day']) await t.test(`${width}px ${value} Summary keeps Planned left and Recorded right with aligned columns`, async () => {
    await size(width); await mode(value)
    const result = await browser.evaluate(`(()=>{const dls=[...document.querySelectorAll('.home-metrics')];return{cells:dls.length,overflow:document.documentElement.scrollWidth>innerWidth,rows:dls.map(dl=>{const [p,a]=dl.children,x=p.getBoundingClientRect(),y=a.getBoundingClientRect();return{labels:[p.querySelector('dt').textContent,a.querySelector('dt').textContent],values:[p.querySelector('dd').textContent,a.querySelector('dd').textContent],horizontal:x.right<=y.left+1&&Math.abs(x.top-y.top)<1}}),separate:!!document.querySelector('.calendar-count-row'),ordered:document.querySelector('.calendar-week-metrics').nextElementSibling.matches('.calendar-combined-row')}})()`)
    assert.equal(result.cells, value === 'week' ? 7 : 1); assert.equal(result.overflow, false)
    assert(result.rows.every(row => row.horizontal && row.labels.join('/') === '計画済み/記録'), JSON.stringify(result))
    assert.deepEqual(result.rows[0].values, ['2時間30分', '5時間39分'])
    if (value === 'week') assert.deepEqual(result.rows[1].values, ['0分', '0分'])
    assert(!result.separate && result.ordered)
    const alignment = await browser.evaluate(`(()=>{const rows=['.calendar-week-header:not(.calendar-lane-header)>button','.calendar-week-metrics>div','.calendar-combined-row>.calendar-schedule-cell','.calendar-day-column'].map(q=>[...document.querySelectorAll(q)].map(e=>{const r=e.getBoundingClientRect();return[r.left,r.right]}));return rows.every(row=>row.every((r,i)=>r.every((x,j)=>Math.abs(x-rows.at(-1)[i][j])<=1)))})()`)
    assert(alignment); await browser.evaluate('window.scrollTo(0,0)'); await shot(`summary-${value}-${width}`)
  })
  for (const expanded of [false, true]) await t.test(`Combined Row ${expanded ? 'open' : 'closed'} keeps one Chevron and all seven counts including zero`, async () => {
    if (await browser.evaluate('document.querySelector(".calendar-row-toggle").getAttribute("aria-expanded")') !== String(expanded)) await browser.click('.calendar-row-toggle')
    assert.equal(await browser.evaluate('document.querySelectorAll(".calendar-row-toggle").length'), 1)
    assert.equal(await browser.evaluate('document.querySelector(".calendar-row-toggle svg").dataset.icon'), expanded ? 'chevronDown' : 'chevronRight')
    assert.deepEqual(await browser.evaluate('[...document.querySelectorAll(".calendar-combined-row [data-count-date] dd")].map(e=>e.textContent)'), ['1件', '1件', '1件', '0件', '0件', '0件', '0件'])
    assert.equal(await browser.evaluate('document.querySelectorAll(".calendar-combined-row [data-schedule-block-id]").length'), expanded ? 3 : 0)
    assert(await browser.evaluate('!document.querySelector(".calendar-count-row")'))
    await browser.evaluate('window.scrollTo(0,0)'); await shot(expanded ? 'combined-open-1440' : 'combined-closed-1440')
  })
  const cases = [
    ['inbox', inbox, `[data-inbox-task-id="${inbox.id}"]`], ['all-day', allDayTask, block(allDay.id)],
    ['time-unset', unsetTask, block(unset.id)], ['timed', timedTask, block(timed.id)], ['closed-actual', actualTask, entry(actual.id)],
  ]
  await t.test('Clicking an empty count cell retains date-only Quick Create without writes on Cancel', async () => {
    const count = postCount('/tasks'), selector = '[data-count-date="2026-10-08"] dd'
    await point(selector); await clickAt(selector)
    await browser.until('document.querySelector(".calendar-dialog [name=date]")', 'Date-only Quick Create')
    assert.equal(await browser.evaluate('document.querySelector(".calendar-dialog [name=date]").value'), '2026/10/08')
    assert.equal(await browser.evaluate('document.querySelector(".calendar-dialog [name=startTime]").value'), '')
    await closeSchedule(); assert.equal(postCount('/tasks'), count)
  })
  for (const [name, current, selector] of cases) await t.test(`${name} real Hover Start creates one segment without parent Click or Drag; Active has no duplicate Start`, async () => {
    const action = await hover(selector)
    const before = await api(`/tasks/${current.id}/time-entries`), plans = await api('/schedule-blocks'), starts = postCount('/tasks/time/start')
    await shot(`hover-${name}-1440`); await clickAt(action)
    await browser.until(`document.querySelector('.global-top-timer.timer-session [data-task-id="${current.id}"]')||document.querySelector('.global-top-timer.timer-session')`, 'Timer started')
    await ready()
    const active = await api('/tasks/time/active'), entries = await api(`/tasks/${current.id}/time-entries`)
    assert.equal(active.taskId, current.id); assert.equal(postCount('/tasks/time/start'), starts + 1)
    assert.equal(entries.length, before.length + 1)
    assert.deepEqual(entries.filter(e => e.endedAt !== null), before)
    assert.equal(entries.filter(e => e.endedAt === null).length, 1)
    if (name === 'closed-actual') assert.equal(entries.find(e => e.endedAt === null).projectIdSnapshot, learning.id)
    assert.deepEqual(await api('/schedule-blocks'), plans); assert(await noDetail())
    assert(await browser.evaluate(`[...document.querySelectorAll('[data-task-id="${current.id}"] .task-hover-start')].every(b=>b.getAttribute('aria-pressed')==='true'&&!b.querySelector('[data-icon=play]'))`))
    assert(await browser.evaluate('document.querySelectorAll(".active-entry .task-hover-start").length>0&&[...document.querySelectorAll(".active-entry .task-hover-start")].every(b=>b.getAttribute("aria-pressed")==="true")'))
    now += 60000; await clock()
    const stops = postCount('/tasks/time/stop')
    await browser.evaluate(`document.querySelector(${JSON.stringify(action)}).click()`)
    await browser.until('!document.querySelector(".global-top-timer.timer-session")', 'Active action stops the existing Timer')
    assert.equal(postCount('/tasks/time/start'), starts + 1)
    assert.equal(postCount('/tasks/time/stop'), stops + 1)
    assert.equal((await api('/tasks/time/active')).running, false)
  })
  await t.test('Other Active Task conflict reports the error without Stop or switch', async () => {
    await clickAt(await hover(block(timed.id))); await ready()
    const before = await api('/tasks/time/active'), starts = postCount('/tasks/time/start'), stops = postCount('/tasks/time/stop')
    await clickAt(await hover(block(unset.id)))
    await browser.until('document.querySelector(".global-error")?.textContent.includes("他の計測")', 'Conflict notification')
    assert.deepEqual(await api('/tasks/time/active'), before)
    assert.equal(postCount('/tasks/time/start'), starts + 1); assert.equal(postCount('/tasks/time/stop'), stops)
    assert(await noDetail()); await stop()
  })
  await t.test('Completed Schedule and Closed Actual cannot Start', async () => {
    const starts = postCount('/tasks/time/start')
    for (const selector of [block(completedBlock.id), entry(completedEntry.id)]) {
      const action = await hover(selector)
      assert(await browser.evaluate(`document.querySelector(${JSON.stringify(action)}).disabled`))
      await browser.evaluate(`document.querySelector(${JSON.stringify(action)}).click()`)
    }
    assert.equal(postCount('/tasks/time/start'), starts); assert.equal((await api('/tasks/time/active')).running, false)
  })
  await t.test('Keyboard Focus exposes the same action and Enter starts without opening the Block', async () => {
    await point(block(timed.id)); await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 })
    await browser.evaluate(`document.querySelector('${block(timed.id)}').focus()`)
    for (let i = 0; i < 3 && !await browser.evaluate('document.activeElement?.matches(".task-hover-start")'); i++) {
      for (const type of ['keyDown', 'keyUp']) await browser.send('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
    }
    assert(await browser.evaluate('document.activeElement.matches(".task-hover-start:focus-visible")&&getComputedStyle(document.activeElement).opacity==="1"&&getComputedStyle(document.activeElement).outlineStyle!=="none"'))
    assert.equal(await browser.evaluate('document.activeElement.closest("[data-task-id]").dataset.taskId'), String(timedTask.id))
    await shot('keyboard-focus-1440')
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await browser.until('document.querySelector(".global-top-timer.timer-session")&&!document.querySelector(".timer-stop").disabled', 'Keyboard Start confirmed')
    await ready(); assert.equal((await api('/tasks/time/active')).taskId, timedTask.id); assert(await noDetail()); await stop()
  })
  await t.test('Dragging from the action cannot start native Block Drag or parent Click', async () => {
    const action = await hover(block(timed.id)), p = await point(action, false), starts = postCount('/tasks/time/start')
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', clickCount: 1 })
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x + 60, y: p.y + 40, buttons: 1 })
    assert(await browser.evaluate('!document.querySelector(".schedule-block-dragging,.calendar-timed-drop-preview")'))
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x + 60, y: p.y + 40, button: 'left', clickCount: 1 })
    assert.equal(postCount('/tasks/time/start'), starts); assert(await noDetail()); assert(await selectionEmpty())
  })
  async function lanePoint(selector, minute) {
    await browser.evaluate(`(()=>{const g=document.querySelector('.calendar-time-grid'),lane=document.querySelector(${JSON.stringify(selector)});g.scrollTop=Math.max(0,lane.getBoundingClientRect().height*${minute}/1440-g.clientHeight/2);g.scrollIntoView({block:'nearest'})})()`)
    await browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    const p = await point(selector, false)
    p.y = await browser.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return r.top+r.height*${minute}/1440})()`)
    assert(await browser.evaluate(`document.elementFromPoint(${p.x},${p.y})?.matches(${JSON.stringify(selector)})`), `Visible lane at ${minute}: ${JSON.stringify(p)}`)
    return p
  }
  async function blankDrag(selector, start, end, preview, screenshot) {
    await browser.evaluate('document.activeElement?.blur();getSelection().removeAllRanges()')
    await lanePoint(selector, (start + end) / 2)
    const { p, q } = await browser.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(),x=r.left+r.width/2;return{p:{x,y:r.top+r.height*${start}/1440},q:{x,y:r.top+r.height*${end}/1440}}})()`)
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p })
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', clickCount: 1 })
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...q, buttons: 1 })
    try {
      await browser.until(`document.querySelector(${JSON.stringify(preview)})`, 'Native drag preview')
      assert(await selectionEmpty()); await shot(screenshot)
    } finally {
      await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...q, button: 'left', clickCount: 1 })
    }
    assert(await selectionEmpty())
  }
  await t.test('Native planned Drag Create does not select preview or hour-label text', async () => {
    const count = postCount('/tasks')
    await blankDrag(`[data-timed-drop-date="${day}"]`, 60, 180, '.calendar-create-preview:not(.actual-create-preview)', 'drag-create-1440')
    await browser.until('document.querySelector(".calendar-dialog [name=startTime]")', 'Create editor')
    assert.equal(await browser.evaluate('document.querySelector(".calendar-dialog [name=startTime]").value'), '01:00')
    assert.equal(await browser.evaluate('document.querySelector(".calendar-dialog [name=durationMinutes]").value'), '2h')
    await closeSchedule(); assert.equal(postCount('/tasks'), count)
  })
  await t.test('Native Actual Drag Create does not select preview text and Cancel preserves history', async () => {
    const before = await api(`/tasks/${actualTask.id}/time-entries`)
    await blankDrag(`[data-actual-date="${day}"]`, 300, 360, '.actual-create-preview', 'actual-drag-create-1440')
    await browser.until('document.querySelector(".time-entry-dialog")', 'Actual create')
    await browser.click('.time-entry-dialog [aria-label="記録の操作を閉じる"]')
    await browser.until('!document.querySelector(".time-entry-dialog")', 'Actual cancelled')
    assert.deepEqual(await api(`/tasks/${actualTask.id}/time-entries`), before)
  })
  await t.test('Native HTML Drag Move has no text selection, preserves duration and opens no Popover', async () => {
    let data
    const intercept = message => { if (message.method === 'Input.dragIntercepted') data = message.params.data }
    browser.listeners.push(intercept)
    await browser.send('Input.setInterceptDrags', { enabled: true })
    try {
      await browser.evaluate('document.activeElement?.blur();getSelection().removeAllRanges()')
      await point(`${block(timed.id)} strong`)
      const p = await point(`${block(timed.id)} strong`, false)
      assert(await browser.evaluate(`!!document.elementFromPoint(${p.x},${p.y})?.closest('${block(timed.id)}')`), `Move hit target: ${await browser.evaluate(`document.elementFromPoint(${p.x},${p.y})?.outerHTML`)}`)
      await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p })
      await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', clickCount: 1 })
      await sleep(50)
      await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x + 8, y: p.y + 16, button: 'left', buttons: 1 })
      await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x + 12, y: p.y + 24, button: 'left', buttons: 1 })
      for (let i = 0; !data && i < 100; i++) await sleep(20)
      assert(data, 'Native HTML drag was intercepted')
      // Native Drag can autoscroll while picking up the Block. Calculate the
      // drop position from the current lane, rather than its pre-Drag bounds.
      const q = await lanePoint(`[data-timed-drop-date="${day}"]`, 660)
      for (const type of ['dragEnter', 'dragOver']) await browser.send('Input.dispatchDragEvent', { type, ...q, data })
      await browser.until('document.querySelector(".calendar-timed-drop-preview")', 'Move preview')
      assert(await selectionEmpty()); await shot('move-preview-1440')
      await browser.send('Input.dispatchDragEvent', { type: 'drop', ...q, data })
      await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...q, button: 'left', clickCount: 1 })
      await ready()
      const saved = (await api('/schedule-blocks')).find(b => b.id === timed.id)
      assert.equal(saved.startTime, '11:00:00'); assert.equal(saved.durationMinutes, 150)
      assert(await selectionEmpty()); assert(await noDetail())
    } finally {
      await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 5, y: 5, button: 'left', clickCount: 1 })
      await browser.send('Input.setInterceptDrags', { enabled: false })
      browser.listeners.splice(browser.listeners.indexOf(intercept), 1)
    }
  })
  await t.test('Native Resize has no text selection and preserves estimate and minute snap', async () => {
    const selector = `${block(timed.id)} .schedule-resize-handle`, p = await point(selector)
    assert(await browser.evaluate(`!!document.elementFromPoint(${p.x},${p.y})?.closest('.schedule-resize-handle')`), `Resize hit target: ${await browser.evaluate(`document.elementFromPoint(${p.x},${p.y})?.outerHTML`)}`)
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p })
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', clickCount: 1 })
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y + 27, button: 'left', buttons: 1 })
    try {
      await browser.until('document.querySelector(".schedule-resize-preview")', 'Resize preview')
      assert(await selectionEmpty()); await shot('resize-preview-1440')
    } finally {
      await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y + 27, button: 'left', clickCount: 1 })
    }
    await ready()
    assert.equal((await api('/schedule-blocks')).find(b => b.id === timed.id).durationMinutes, 180)
    assert.equal((await api(`/tasks/${timedTask.id}`)).estimatedMinutes, 360)
    assert(await selectionEmpty()); assert(await noDetail())
  })
  async function selectInput(selector) {
    const p = await point(selector)
    p.x = await browser.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return e.getBoundingClientRect().left+parseFloat(getComputedStyle(e).paddingLeft)+2})()`)
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p })
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', clickCount: 1 })
    await sleep(50)
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x + 100, y: p.y, button: 'left', buttons: 1 })
    await sleep(50)
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x + 100, y: p.y, button: 'left', clickCount: 1 })
    await browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    const selected = await browser.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return {start:e?.selectionStart,end:e?.selectionEnd,value:e?.value,type:e?.type,select:e?getComputedStyle(e).userSelect:null,active:document.activeElement===e}})()`)
    assert(selected.end>selected.start&&selected.select!=='none', `Native text selection ${selector}: ${JSON.stringify(selected)}`)
  }
  await t.test('Timer Input remains natively selectable', async () => {
    await browser.evaluate(`(()=>{const e=document.querySelector('.timer-task-picker input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'SelectableTimerText');e.dispatchEvent(new Event('input',{bubbles:true}));})()`)
    await selectInput('.timer-task-picker input')
  })
  await t.test('Task Editor title and duration remain natively selectable', async () => {
    await browser.click(`[data-inbox-task-id="${inbox.id}"] .inbox-card-open`)
    await browser.until('document.querySelector(".task-drawer[open]")', 'Task Editor')
    await selectInput('.task-form [name=title]'); await selectInput('.task-form [name=estimatedMinutes]')
    await browser.click('.task-drawer .icon-close'); await browser.until('!document.querySelector(".task-drawer")', 'Task Editor closed')
  })
  await t.test('Popover title and Schedule duration retain input selection; Project uses the common Task Editor', async () => {
    await browser.click(block(timed.id)); await browser.until('document.querySelector(".calendar-popover")', 'Schedule Popover')
    assert.deepEqual(await browser.evaluate('[...document.querySelectorAll(".calendar-popover-schedule dt,.calendar-popover-totals dt")].map(e=>e.textContent)'), ['記録', '計画済み', '見積もり'])
    await shot('schedule-popover-1440')
    assert.deepEqual(await browser.evaluate('[...document.querySelectorAll(".calendar-popover-schedule .task-attribute-label")].map(e=>e.textContent)'), ['日付','時刻','計画時間'])
    await browser.click('.calendar-popover .task-title-input button')
    await selectInput('.calendar-popover .task-title-input input')
    await browser.send('Input.dispatchKeyEvent', {type:'keyDown',key:'Escape',windowsVirtualKeyCode:27})
    await browser.click('.calendar-popover [data-schedule-field=durationMinutes]')
    await browser.until('document.querySelector(".calendar-dialog [name=durationMinutes]")', 'Schedule editor')
    await selectInput('.calendar-dialog [name=durationMinutes]')
    await closeSchedule()
    await browser.click(block(timed.id)); await browser.until('document.querySelector(".calendar-popover")', 'Schedule Popover reopened')
    await browser.evaluate('[...document.querySelectorAll(".calendar-dialog-actions button")].find(b=>b.textContent==="タスクを編集").click()')
    await browser.until('document.querySelector(".task-editor-panel .project-picker-trigger")', 'Common Task Editor')
    const savedTask = await api(`/tasks/${timedTask.id}`), mutations = requests.filter(r=>r.method==='PUT'&&r.path===`/tasks/${timedTask.id}`).length
    await browser.click('.task-editor-panel .project-picker-trigger')
    await browser.until('document.querySelector(".task-editor-panel .project-picker-popup [aria-checked=true]")', 'Current Project choice')
    assert.equal(await browser.evaluate('document.querySelector(".task-editor-panel .project-picker-popup [aria-checked=true]").dataset.projectId'), String(project.id))
    await browser.click(`.task-editor-panel .project-picker-popup [data-project-id="${learning.id}"]`)
    await browser.until('!document.querySelector(".task-editor-panel .project-picker-popup")', 'Draft Project selected')
    assert.equal(await browser.evaluate('document.querySelector(".task-editor-panel [name=projectId]").value'), String(learning.id))
    assert.equal(requests.filter(r=>r.method==='PUT'&&r.path===`/tasks/${timedTask.id}`).length, mutations)
    await browser.click('.task-editor-panel .project-picker-trigger')
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await browser.until('!document.querySelector(".project-picker-popup") && document.querySelector(".task-editor-panel[open]")', 'Project closes without closing Task Editor')
    assert.equal(await browser.evaluate('document.activeElement.classList.contains("project-picker-trigger")'), true)
    await browser.click('.task-editor-panel .icon-close'); await browser.until('!document.querySelector(".task-editor-panel")', 'Task Editor closed')
    assert.deepEqual(await api(`/tasks/${timedTask.id}`), savedTask)
    assert.equal(requests.filter(r=>r.method==='PUT'&&r.path===`/tasks/${timedTask.id}`).length, mutations)
  })
  await t.test('Fix6 short Schedule Play stays inside at all five zoom levels and clears the Resize handle', async () => {
    const compactTask = await task('短い予定', null)
    const compact = await api('/schedule-blocks', { taskId: compactTask.id, date: day, type: 'TIMED', startTime: '17:00', durationMinutes: 15 })
    await browser.navigate(true); await ready(); await mode('week')
    while (await browser.evaluate('document.querySelector(".week-calendar-panel").dataset.zoomLevel') !== '1') await browser.click('[aria-label="時間軸を縮小"]')
    for (let zoom = 1; zoom <= 5; zoom++) {
      if (zoom > 1) await browser.click('[aria-label="時間軸を拡大"]')
      const action = await hover(block(compact.id))
      assert(await browser.evaluate(`(()=>{const b=document.querySelector(${JSON.stringify(action)}),i=b.querySelector('svg').getBoundingClientRect(),r=b.getBoundingClientRect(),h=b.parentElement.querySelector('.schedule-resize-handle').getBoundingClientRect();return i.width>0&&i.height>0&&i.left>=r.left&&i.right<=r.right&&i.top>=r.top&&i.bottom<=r.bottom&&r.bottom<=h.top})()`), `Contained Play and Resize at zoom ${zoom}`)
      if (zoom === 1 || zoom === 5) await shot(`hover-short-zoom-${zoom}`)
    }
  })
  assert.deepEqual(errors, [], 'No browser or API forwarding errors')
})
