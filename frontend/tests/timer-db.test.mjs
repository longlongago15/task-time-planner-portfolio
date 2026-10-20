import { openReport, selectReportAnchor } from './report-picker.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { openBrowser, pauseOrResumeTimer, selectTimerTask } from './browser.mjs'

test('Frontend + real Backend lifecycle on a guarded temporary SQLite DB', { timeout: 120000 }, async t => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const python = process.env.TIMER_TEST_PYTHON ?? path.join(root, 'backend', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  await access(python)
  const directory = await mkdtemp(path.join(tmpdir(), 'task-timer-db-'))
  let backend
  let servingBackend
  const intentionallyStopped = new Set()
  let base
  let browser
  let now = Date.now() - 120000
  let clockVersion = 0
  const setClock = async delta => {
    now += delta
    const staging = path.join(directory, `clock-${++clockVersion}.txt`)
    await writeFile(staging, new Date(now).toISOString())
    for (let attempt = 0; ; attempt++) {
      try { await rename(staging, path.join(directory, 'clock.txt')); break } catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 30) throw error
        await new Promise(resolve => setTimeout(resolve, 20))
      }
    }
  }
  await setClock(0)
  const stopBackend = async () => {
    if (backend?.exitCode === null) {
      intentionallyStopped.add(backend)
      const exited = new Promise(resolve => backend.once('exit', resolve))
      backend.kill()
      await exited
    }
  }
  t.after(async () => {
    await browser?.close()
    await stopBackend()
    assert.equal(path.dirname(directory), path.resolve(tmpdir()))
    assert(path.basename(directory).startsWith('task-timer-db-'))
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  })
  async function startBackend() {
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
        const candidateBase = `http://127.0.0.1:${port}`
        try {
          if ((await fetch(`${candidateBase}/health`)).ok) { base = candidateBase; servingBackend = backend; return }
        } catch { /* Server is starting. */ }
      }
      if (backend.exitCode !== null) throw new Error(`Temporary Backend exited: ${output}\n${log}`)
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error(`Temporary Backend did not start: ${output}\n${log}`)
  }
  async function api(route, payload, method = 'POST') {
    const response = await fetch(`${base}${route}`, payload === undefined ? {} : {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })
    assert(response.ok, `${route}: ${response.status} ${await response.clone().text()}`)
    return response.json()
  }
  await startBackend()
  browser = await openBrowser()
  const errors = []
  browser.listeners.push(message => {
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method !== 'Fetch.requestPaused') return
    const { request, requestId } = message.params
    // Publish URL and process together only after health succeeds. While the
    // replacement starts, late browser reads still belong to the stopped server.
    const serverAtRequest = servingBackend, baseAtRequest = base
    void (async () => {
      if (request.method === 'OPTIONS') { await browser.fulfill(requestId, {}); return }
      const url = new URL(request.url)
      const response = await fetch(`${baseAtRequest}${url.pathname}${url.search}`, {
        method: request.method,
        ...(request.postData ? { headers: { 'Content-Type': 'application/json' }, body: request.postData } : {}),
      })
      const body = await response.text()
      let data
      try { data = JSON.parse(body) } catch { throw new Error(`${request.method} ${url.pathname}: ${response.status} ${body}`) }
      await browser.fulfill(requestId, data, response.status)
    })().catch(async error => {
      if (/Invalid InterceptionId|Invalid interceptionId|Invalid requestId/.test(error.message)) return
      // In-flight reads can fail during the deliberately exercised Backend restart.
      if (!intentionallyStopped.has(serverAtRequest)) errors.push(error.message)
      try { await browser.send('Fetch.failRequest', { requestId, errorReason: 'ConnectionFailed' }) } catch { /* Page may have reloaded. */ }
    })
  })
  // Even in integration tests the normal Backend URL is never contacted.
  await browser.send('Fetch.enable', { patterns: [{ urlPattern: 'http://localhost:8000/*', requestStage: 'Request' }] })
  const today = await browser.evaluate("(() => {const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`})()")
  const project = await api('/projects', { name: 'Isolated Timer Project' })
  const task = await api('/tasks', { title: 'Isolated Timer Task', projectId: project.id, estimatedMinutes: 20 })
  await api('/schedule-blocks', { taskId: task.id, date: today, type: 'TIME_UNSET' })
  const entries = () => api(`/tasks/${task.id}/time-entries`)
  const active = () => api('/tasks/time/active')
  async function load(reload = false) {
    await browser.navigate(reload)
    await browser.until("document.querySelector('.timer-play-button') && !document.querySelector('.timer-play-button').disabled", 'Temporary DB Active loaded')
    if (!await browser.evaluate('Boolean(document.querySelector(".timer-session"))')) await selectTimerTask(browser, task.id)
  }
  async function start() {
    if (!await browser.evaluate('Boolean(document.querySelector(".timer-session"))')) await selectTimerTask(browser, task.id)
    await browser.click('.timer-play-button')
    await browser.until("document.querySelector('.timer-session:not(.paused)') !== null && !document.querySelector('.timer-session .timer-stop').disabled", 'Real Start')
  }
  async function end(pause = false) {
    if (pause) await pauseOrResumeTimer(browser)
    else await browser.click('.timer-session .timer-stop')
    await browser.until(pause
      ? "document.querySelector('.timer-session.paused') && !document.querySelector('.timer-play-button').disabled"
      : "!document.querySelector('.timer-session') && !document.querySelector('.timer-play-button').disabled", 'Real end')
  }
  let firstId
  let secondId
  await t.test('Start persists canonical Active NULL fields and Task status', async () => {
    await load(); await start()
    const rows = await entries(); assert.equal(rows.length, 1); firstId = rows[0].id
    assert.equal(rows[0].endedAt, null); assert.equal(rows[0].durationMinutes, null)
    assert.equal(rows[0].projectIdSnapshot, project.id)
    assert.equal((await api(`/tasks/${task.id}`)).status, 'IN_PROGRESS')
  })
  await t.test('Pause at 30 seconds updates the same row with zero duration', async () => {
    await setClock(30000); await end(true)
    const rows = await entries(); assert.equal(rows.length, 1); assert.equal(rows[0].id, firstId)
    assert.notEqual(rows[0].endedAt, null); assert.equal(rows[0].durationMinutes, 0)
    assert.equal((await active()).running, false)
  })
  await t.test('Resume creates a second persisted Active row', async () => {
    await start(); const rows = await entries(); assert.equal(rows.length, 2)
    const row = rows.find(entry => entry.endedAt === null); secondId = row.id
    assert.notEqual(firstId, secondId)
  })
  await t.test('Frontend reload restores the same persisted entry and elapsed time', async () => {
    await setClock(93000); const before = await active(); await load(true)
    await browser.until("document.querySelector('.timer-session .timer-task-title')?.textContent === 'Isolated Timer Task'", 'Real reload restoration')
    assert.deepEqual(await active(), before)
    assert.equal((await entries()).find(entry => entry.endedAt === null).id, secondId)
    // Browser uses its own current time and the saved server timestamp, never saved duration.
    const seconds = await browser.evaluate("(() => {const [h,m,s] = document.querySelector('.timer-elapsed').textContent.split(':').map(Number); return h*3600+m*60+s})()")
    const expected = Math.max(0, Math.floor((Date.now() - Date.parse(before.startedAt)) / 1000))
    assert(Math.abs(seconds - expected) <= 2)
    assert(seconds >= 90)
  })
  await t.test('Backend restart plus Frontend reload restores the same DB Active', async () => {
    const before = await active(); await stopBackend(); await startBackend(); await load(true)
    await browser.until("document.querySelector('.timer-session .timer-task-title')?.textContent === 'Isolated Timer Task'", 'Backend restart restoration')
    assert.deepEqual(await active(), before); assert.equal((await entries()).length, 2)
  })
  await t.test('Stop after restart closes the second row instead of inserting', async () => {
    await end(); const rows = await entries(); assert.equal(rows.length, 2)
    const row = rows.find(entry => entry.id === secondId)
    assert.notEqual(row.endedAt, null); assert.equal(row.durationMinutes, 1)
  })
  await t.test('zero-second interval succeeds through the real Frontend and Backend', async () => {
    await start(); await end(); const rows = await entries(); assert.equal(rows.length, 3)
    const row = rows.find(entry => entry.id !== firstId && entry.id !== secondId)
    assert.equal(row.startedAt, row.endedAt); assert.equal(row.durationMinutes, 0)
  })
  await t.test('real Task, Project and Daily Report API minutes remain consistent', async () => {
    assert.equal((await api(`/tasks/${task.id}`)).actualMinutes, 1)
    assert.equal((await api('/projects'))[0].actualMinutes, 1)
    const timezone = await browser.evaluate('Intl.DateTimeFormat().resolvedOptions().timeZone')
    const dailyActual = (await api(`/reports/daily?date=${today}&timezone=${encodeURIComponent(timezone)}`)).dailyActualMinutes
    assert(dailyActual >= 0 && dailyActual <= 1) // Midnight may split this one-minute interval across dates.
    await browser.click('.icon-rail [aria-label="レポート"]')
    await openReport(browser,'day'); await selectReportAnchor(browser,today)
    await browser.until('document.querySelector(".report-summary-actual strong")?.textContent==='+JSON.stringify(dailyActual+'分'),'Real Backend Report displayed')
    await browser.until('document.querySelector("[data-report-table=tasks] tbody tr td:nth-of-type(3)")?.textContent==='+JSON.stringify(dailyActual+'分'),'Task report actual matches after Timer refresh')
  })
  assert.deepEqual(errors, [], 'No runtime or forwarding errors')
})
