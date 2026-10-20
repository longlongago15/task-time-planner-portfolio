import { openReport, selectReportMode, expectReportSummary } from './report-picker.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { openBrowser, pauseOrResumeTimer, selectTimerTask } from './browser.mjs'

test('Frontend Timer DB lifecycle (browser, intercepted API; no real DB connections)', { timeout: 240000 }, async t => {
  const browser = await openBrowser()
  t.after(() => browser.close())
  const today = '2026-10-02'
  const noon = Date.parse(`${today}T12:00:00+09:00`)
  let now = noon
  await browser.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' })
  // Both API fixtures and the page use this clock, independently of the host time.
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const RealDate = Date;
    window.__timerTestNow = Number(localStorage.getItem('__timerTestNow')) || ${noon};
    window.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [window.__timerTestNow])); }
      static now() { return window.__timerTestNow; }
    };
  })()` })
  async function setClock(time) {
    now = Date.parse(`${today}T${time}:00+09:00`)
    await browser.evaluate(`window.__timerTestNow = ${now}; localStorage.setItem('__timerTestNow', String(window.__timerTestNow)); undefined`)
  }
  let model
  const requests = []
  const runtimeErrors = []
  const interceptionErrors = []
  const stamp = () => new Date(now).toISOString()
  function reset() {
    requests.length = 0
    model = {
      tasks: [1, 2].map(id => ({
        id, title: `Timer Task ${id}`, estimatedMinutes: id === 1 ? 20 : null,
        projectId: 1, projectName: 'Timer Project',
        completed: false, status: 'NOT_STARTED', completedAt: null, completedEstimateMinutes: null,
        actualMinutes: 0, differenceMinutes: id === 1 ? -20 : null, actualStartedAt: null,
        createdAt: stamp(), updatedAt: stamp(),
      })),
      blocks: [1, 2].map(id => ({ id, taskId: id, date: today, type: 'TIME_UNSET', startTime: null, durationMinutes: null,
        createdAt: stamp(), updatedAt: stamp() })),
      entries: [], nextId: 1, startAge: 0, fault: null, activeFailure: false, heldRead: null, heldHistory: null, switchAfterStart: false,
    }
  }
  function active() {
    const entry = model.entries.find(item => item.endedAt === null)
    return entry ? { taskId: entry.taskId, running: true, startedAt: entry.startedAt }
      : { taskId: null, running: false, startedAt: null }
  }
  function insert(taskId, age = 0) {
    const startedAt = new Date(now - age * 1000).toISOString()
    const entry = { id: model.nextId++, taskId, projectIdSnapshot: 1,
      startedAt, endedAt: null, startAt: startedAt, endAt: null, durationMinutes: null,
      createdAt: startedAt, updatedAt: startedAt }
    model.entries.push(entry)
    const task = model.tasks.find(item => item.id === taskId)
    task.status = 'IN_PROGRESS'
    task.actualStartedAt ??= startedAt
    return entry
  }
  const posts = operation => requests.filter(item => item.method === 'POST' && item.path === `/tasks/time/${operation}`)
  const getActiveCount = () => requests.filter(item => item.method === 'GET' && item.path === '/tasks/time/active').length

  browser.listeners.push(message => {
    if (message.method === 'Runtime.exceptionThrown') runtimeErrors.push(message.params.exceptionDetails)
    if (message.method !== 'Fetch.requestPaused') return
    const { request, requestId } = message.params
    const state = model
    const url = new URL(request.url)
    void (async () => {
      const payload = request.postData ? JSON.parse(request.postData) : null
      requests.push({ method: request.method, path: url.pathname, payload })
      if (request.method === 'OPTIONS') { await browser.fulfill(requestId, {}); return }
      if (state.fault === 'offline' || (state.activeFailure && url.pathname === '/tasks/time/active')) {
        await browser.send('Fetch.failRequest', { requestId, errorReason: 'ConnectionFailed' }); return
      }
      if (request.method === 'POST' && url.pathname.startsWith('/tasks/time/')) {
        assert.deepEqual(Object.keys(payload), ['taskId'], 'Timer writes send only taskId, never client endAt')
        const operation = url.pathname.split('/').at(-1)
        if (state.fault === `${operation}-network`) {
          await browser.send('Fetch.failRequest', { requestId, errorReason: 'ConnectionFailed' }); return
        }
        if (state.fault === `${operation}-commit-network`) {
          if (operation === 'start') insert(payload.taskId)
          else {
            const entry = state.entries.find(item => item.taskId === payload.taskId && item.endedAt === null)
            entry.endedAt = stamp(); entry.endAt = entry.endedAt; entry.durationMinutes = 0
          }
          await browser.send('Fetch.failRequest', { requestId, errorReason: 'ConnectionFailed' }); return
        }
        if (state.fault === `${operation}-500`) { await browser.fulfill(requestId, { detail: 'Controlled failure' }, 500); return }
        if (operation === 'start') {
          const task = state.tasks.find(item => item.id === payload.taskId)
          if (task?.completed || task?.status === 'COMPLETED' || active().running) {
            await browser.fulfill(requestId, { detail: 'Timer conflict' }, 409); return
          }
          insert(payload.taskId, state.startAge)
          const response = active()
          if (state.switchAfterStart) {
            const entry = state.entries.find(item => item.endedAt === null)
            entry.endedAt = stamp(); entry.endAt = entry.endedAt; entry.durationMinutes = 0
            insert(2)
          }
          await browser.fulfill(requestId, response); return
        }
        const entry = state.entries.find(item => item.taskId === payload.taskId && item.endedAt === null)
        if (!entry) { await browser.fulfill(requestId, { detail: 'No Active' }, 409); return }
        entry.endedAt = stamp(); entry.endAt = entry.endedAt; entry.updatedAt = entry.endedAt
        entry.durationMinutes = Math.max(0, Math.floor((Date.parse(entry.endedAt) - Date.parse(entry.startedAt)) / 60000))
        await browser.fulfill(requestId, entry); return
      }
      if (request.method !== 'GET') throw new Error(`Unexpected mutation: ${request.method} ${url.pathname}`)
      if (url.pathname === '/tasks/time/active') {
        const response = active()
        if (state.heldRead === 'next') { state.heldRead = { requestId, response }; return }
        await browser.fulfill(requestId, response); return
      }
      if (url.pathname === '/tasks') { await browser.fulfill(requestId, url.searchParams.has('inbox') ? [] : state.tasks); return }
      if (url.pathname === '/tags') { await browser.fulfill(requestId, []); return }
      if (url.pathname === '/projects') {
        await browser.fulfill(requestId, [{ id: 1, name: 'Timer Project', taskCount: 2, completedCount: state.tasks.filter(task => task.completed).length,
          estimatedMinutes: 20, actualMinutes: state.tasks.reduce((sum, task) => sum + task.actualMinutes, 0) }]); return
      }
      if (url.pathname === '/schedule-blocks') {
        await browser.fulfill(requestId, state.blocks.filter(block => (!url.searchParams.has('startDate') || block.date >= url.searchParams.get('startDate'))
          && (!url.searchParams.has('endDate') || block.date <= url.searchParams.get('endDate')))); return
      }
      if (url.pathname === '/reports/weekly') {
        const monday = new Date(`${url.searchParams.get('date')}T12:00:00`)
        monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
        const daily = Array.from({ length: 7 }, (_, offset) => {
          const day = new Date(monday); day.setDate(day.getDate() + offset)
          const date = `${day.getFullYear()}-${String(day.getMonth()+1).padStart(2,'0')}-${String(day.getDate()).padStart(2,'0')}`
          const taskIds = new Set(state.blocks.filter(block => block.date === date).map(block => block.taskId))
          const tasks = state.tasks.filter(task => taskIds.has(task.id)).map(task => ({ taskId: task.id, title: task.title,
            estimatedMinutes: task.estimatedMinutes, actualMinutes: task.actualMinutes,
            differenceMinutes: task.estimatedMinutes === null ? null : task.actualMinutes - task.estimatedMinutes }))
          const dailyEstimatedMinutes = tasks.reduce((sum, task) => sum + (task.estimatedMinutes ?? 0), 0)
          const dailyActualMinutes = date === today ? state.tasks.reduce((sum, task) => sum + task.actualMinutes, 0) : 0
          return { date, plannedOccupiedMinutes: 0, dailyEstimatedMinutes, dailyActualMinutes, dailyDifference: dailyActualMinutes - dailyEstimatedMinutes, tasks }
        })
        await browser.fulfill(requestId, { weekStart: daily[0].date, weekEnd: daily[6].date, daily,
          weeklyEstimatedMinutes: daily.reduce((sum, day) => sum + day.dailyEstimatedMinutes, 0),
          weeklyPlannedOccupiedMinutes: 0, weeklyActualMinutes: daily.reduce((sum, day) => sum + day.dailyActualMinutes, 0) }); return
      }
      if (url.pathname === '/reports/daily') {
        const taskIds = new Set(state.blocks.filter(block => block.date === url.searchParams.get('date')).map(block => block.taskId))
        const tasks = state.tasks.filter(task => taskIds.has(task.id)).map(task => ({
          taskId: task.id, title: task.title, estimatedMinutes: task.estimatedMinutes,
          actualMinutes: task.actualMinutes, differenceMinutes: task.estimatedMinutes === null ? null : task.actualMinutes - task.estimatedMinutes,
        }))
        const actualMinutes = url.searchParams.get('date') === today ? state.tasks.reduce((sum, task) => sum + task.actualMinutes, 0) : 0
        await browser.fulfill(requestId, { date: url.searchParams.get('date'), plannedOccupiedMinutes: 0, dailyEstimatedMinutes: tasks.reduce((sum, task) => sum + (task.estimatedMinutes ?? 0), 0),
          dailyActualMinutes: actualMinutes, dailyDifference: actualMinutes - (tasks.length ? 20 : 0), tasks }); return
      }
      const match = url.pathname.match(/^\/tasks\/(\d+)\/time-entries$/)
      if (match) {
        const response = state.entries.filter(entry => entry.taskId === Number(match[1]))
        if (state.heldHistory === 'next') { state.heldHistory = { requestId, response: structuredClone(response) }; return }
        await browser.fulfill(requestId, response); return
      }
      throw new Error(`Unexpected API read: ${url.pathname}`)
    })().catch(async error => {
      if (/Invalid InterceptionId|Invalid interceptionId|Invalid requestId/.test(error.message)) return
      interceptionErrors.push(error.message)
      try { await browser.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }) } catch { /* Page may have reloaded. */ }
    })
  })
  // Every request to the application's Backend URL is intercepted, including writes.
  await browser.send('Fetch.enable', { patterns: [{ urlPattern: 'http://localhost:8000/*', requestStage: 'Request' }] })
  async function load(configure = () => {}) {
    reset(); configure()
    await browser.navigate()
    await browser.until("document.querySelector('.timer-play-button') && !document.querySelector('.timer-play-button').disabled", 'Active API initialized')
    if (!await browser.evaluate('Boolean(document.querySelector(".timer-session"))')) await selectTimerTask(browser, 1)
  }
  async function start() {
    if (!await browser.evaluate('Boolean(document.querySelector(".timer-session"))')) await selectTimerTask(browser, 1)
    await browser.click('.timer-play-button')
    await browser.until("document.querySelector('.timer-session:not(.paused)') !== null && !document.querySelector('.timer-session .timer-stop').disabled", 'Start confirmed')
  }
  async function pause() {
    await pauseOrResumeTimer(browser)
    await browser.until("document.querySelector('.timer-session.paused') && !document.querySelector('.timer-play-button').disabled", 'Pause confirmed')
  }
  async function stop() {
    await browser.click('.timer-session .timer-stop')
    await browser.until("!document.querySelector('.timer-session') && !document.querySelector('.timer-play-button').disabled", 'Stop confirmed')
  }
  async function history() {
    await browser.click('.timer-time-button')
    await browser.until("document.querySelectorAll('.history-list li').length > 0", 'History loaded')
    return browser.evaluate("document.querySelector('.history-list').innerText")
  }
  async function alert() { await browser.until("document.querySelector('.global-error')", 'Timer error displayed') }

  await t.test('Start inserts an Active interval and refreshes Task status', async () => {
    await load(); await start()
    assert.equal(model.entries.length, 1); assert.equal(model.entries[0].endedAt, null)
    assert.equal(model.tasks[0].status, 'IN_PROGRESS'); assert.equal(posts('start').length, 1)
  })
  await t.test('Pause closes the same entry and clears running', async () => {
    await load(); await start(); const id = model.entries[0].id; await pause()
    assert.equal(model.entries.length, 1); assert.equal(model.entries[0].id, id)
    assert.notEqual(model.entries[0].endedAt, null); assert.equal(active().running, false)
    assert.equal(model.tasks[0].status, 'IN_PROGRESS')
  })
  await t.test('Resume sends a new Start and creates a new interval', async () => {
    await load(); await start(); await pause(); await start()
    assert.equal(posts('start').length, 2); assert.equal(model.entries.length, 2)
    assert.notEqual(model.entries[0].id, model.entries[1].id); assert.equal(model.entries[1].endedAt, null)
  })
  await t.test('Stop ends the existing entry and sends no client timestamp', async () => {
    await load(); await start(); await stop()
    assert.equal(model.entries.length, 1); assert.deepEqual(posts('stop')[0].payload, { taskId: 1 })
  })
  await t.test('Start → reload restores the same DB Active and can Pause', async () => {
    await load(); await start(); const before = structuredClone(active()); const entryId = model.entries[0].id
    await browser.navigate(true)
    await browser.until("document.querySelector('.timer-session .timer-task-title')?.textContent === 'Timer Task 1' && !document.querySelector('.timer-session .timer-stop').disabled", 'Reload restoration')
    assert.deepEqual(active(), before); assert.equal(posts('start').length, 1)
    await pause(); assert.equal(model.entries[0].id, entryId)
  })
  await t.test('reload elapsed comes from server startedAt and does not reset to zero', async () => {
    await load(() => insert(1, 123))
    const clock = await browser.evaluate("document.querySelector('.timer-elapsed').textContent")
    assert.match(clock, /^0:02:0[3-9]$/)
  })
  await t.test('Active endedAt NULL renders 終了 —', async () => {
    await load(); await start(); assert.match(await history(), /終了 —/)
  })
  await t.test('Active durationMinutes NULL renders 計測中', async () => {
    await load(); await start(); await history()
    assert.equal(await browser.evaluate("document.querySelector('.history-list strong').textContent"), '計測中')
  })
  await t.test('NULL history never renders Invalid Date, NaN, null or epoch', async () => {
    await load(); await start(); const text = await history()
    assert.doesNotMatch(text, /Invalid Date|NaN|null|1970|1999/)
  })
  await t.test('closed history is reflected immediately after Pause', async () => {
    await load(); await start(); await history(); await browser.click('.timer-modal .timer-controls button:first-child')
    await browser.until("document.querySelector('.history-list strong')?.textContent === '0分'", 'Closed entry displayed')
    assert.doesNotMatch(await browser.evaluate("document.querySelector('.history-list').innerText"), /終了 —/)
  })
  await t.test('30 second Timer is accepted', async () => {
    await load(() => { model.startAge = 30 }); await start(); await stop()
    assert.equal(posts('stop').length, 1); assert.equal(model.entries[0].durationMinutes, 0)
  })
  await t.test('immediate zero-minute Timer is not refused or discarded', async () => {
    await load(); await start(); await stop()
    assert.equal(model.entries.length, 1); assert.equal(model.entries[0].durationMinutes, 0)
    assert.match(await history(), /0分/)
  })
  await t.test('Start 409 synchronizes another Task Active', async () => {
    await load(); insert(2, 90); const reads = getActiveCount()
    await browser.click('.timer-play-button'); await alert()
    await browser.until("document.querySelector('.timer-session .timer-task-title')?.textContent === 'Timer Task 2'", 'Conflict synchronization')
    assert(getActiveCount() > reads); assert.equal(model.entries.length, 1)
  })
  await t.test('Stop 409 clears stale running when the DB has no Active', async () => {
    await load(); await start(); model.entries[0].endedAt = stamp(); model.entries[0].endAt = model.entries[0].endedAt
    const reads = getActiveCount(); await browser.click('.timer-session .timer-stop'); await alert()
    await browser.until("!document.querySelector('.timer-session')", 'Stale running cleared')
    assert(getActiveCount() > reads)
  })
  await t.test('Stop network failure preserves the DB Active display', async () => {
    await load(); await start(); model.fault = 'stop-network'; await browser.click('.timer-session .timer-stop'); await alert()
    assert.equal(active().running, true)
    assert.equal(await browser.evaluate("Boolean(document.querySelector('.timer-session:not(.paused)'))"), true)
  })
  await t.test('Stop and resync both offline preserve cache and offer retry', async () => {
    await load(); await start(); model.fault = 'offline'; await browser.click('.timer-session .timer-stop'); await alert()
    // Other offline reads can show a Workspace alert before Timer reconciliation finishes.
    await browser.until("document.querySelector('.global-error button')?.disabled === false && document.querySelector('.timer-session .timer-stop')?.disabled === true", 'Offline Timer reconciliation exposes retry')
    assert.equal(await browser.evaluate("Boolean(document.querySelector('.timer-session:not(.paused)'))"), true)
    assert.equal(await browser.evaluate("document.querySelector('.timer-session .timer-stop').disabled"), true)
    model.fault = null
    await browser.click('.global-error button')
    await browser.until("!document.querySelector('.timer-session .timer-stop').disabled", 'Retry confirms DB Active')
    await stop()
  })
  await t.test('Start network failure does not invent local running', async () => {
    await load(); model.fault = 'start-network'; await browser.click('.timer-play-button'); await alert()
    assert.equal(await browser.evaluate("Boolean(document.querySelector('.timer-session'))"), false)
    assert.equal(model.entries.length, 0)
  })
  await t.test('Start committed but response lost is recovered from Active API', async () => {
    await load(); model.fault = 'start-commit-network'; await browser.click('.timer-play-button'); await alert()
    await browser.until("document.querySelector('.timer-session:not(.paused)') !== null", 'Committed Start restored')
    assert.equal(model.entries.length, 1)
  })
  await t.test('Stop committed but response lost synchronizes DB idle', async () => {
    await load(); await start(); model.fault = 'stop-commit-network'; await browser.click('.timer-session .timer-stop'); await alert()
    await browser.until("!document.querySelector('.timer-session')", 'Committed Stop restored')
    assert.equal(active().running, false)
  })
  await t.test('Home → Tasks → Project → Reports retains the same Timer', async () => {
    await load(); await start(); const before = structuredClone(active())
    for (const selector of ['.icon-rail [aria-label="タスク"]', '.icon-rail [aria-label="プロジェクト"]', '.icon-rail [aria-label="レポート"]', '.icon-rail [aria-label="ホーム"]']) {
      await browser.click(selector)
      assert.equal(await browser.evaluate("document.querySelector('.timer-session .timer-task-title').textContent"), 'Timer Task 1')
      assert.deepEqual(active(), before)
    }
    assert.equal(posts('start').length, 1)
  })
  await t.test('Task, Project, Daily and period Report use Backend actual without double addition', async () => {
    await load(() => { insert(1, 420); model.tasks[0].actualMinutes = 7; model.tasks[0].differenceMinutes = -13 })
    await browser.until("document.querySelectorAll('.calendar-event.actual').length === 1", 'One DB interval drawn')
    await browser.click('.icon-rail [aria-label="タスク"]')
    await browser.until("document.querySelector('.task-table-row [data-label=記録]')?.textContent === '7m'", 'Task API minutes')
    await browser.click('.icon-rail [aria-label="プロジェクト"]'); await browser.until('document.querySelector(".project-card-open")', 'Project card loaded'); await browser.click('.project-card-open')
    await browser.until("document.querySelector('.project-detail-stats .time .project-progress-text')?.textContent.startsWith('7分 /')", 'Project API minutes')
    await browser.click('.icon-rail [aria-label="レポート"]')
    await openReport(browser,'day'); await expectReportSummary(browser,0,7)
    assert.equal(await browser.evaluate('document.querySelector("[data-report-table=tasks] tbody tr td:nth-of-type(3)").textContent'),'7分')
    await browser.click('.report-mode button:nth-child(2)')
    await selectReportMode(browser,'week'); await expectReportSummary(browser,0,7)
    assert.equal(await browser.evaluate('document.querySelector("[data-report-table=tasks] tbody tr td:nth-of-type(3)").textContent'),'7分')
  })
  for (const time of ['00:01', '00:05', '12:00', '23:59']) {
    await t.test(`same-day Actual fixture remains one interval at ${time}`, async () => {
      await setClock(time)
      await load(() => {
        const entry = insert(1)
        // A closed absolute interval always lies within today, even at 00:01.
        entry.startedAt = `${today}T00:00:00+09:00`
        entry.endedAt = `${today}T00:00:30+09:00`
        entry.startAt = entry.startedAt; entry.endAt = entry.endedAt; entry.durationMinutes = 0
      })
      await browser.until("document.querySelectorAll('.calendar-event.actual').length === 1", 'One same-day interval')
      assert.equal(await browser.evaluate("document.querySelector('.calendar-event.actual').dataset.date"), today)
    })
  }
  await setClock('12:00')
  await t.test('stale completed Task Start 409 keeps the UI valid', async () => {
    await load(); model.tasks[0].completed = true; model.tasks[0].status = 'COMPLETED'
    await browser.click('.timer-play-button'); await alert()
    await browser.until("document.querySelector('.timer-task-picker input')?.disabled === false", 'Search ready after conflict')
    await browser.click('.timer-task-picker input')
    await browser.until("document.querySelectorAll('.timer-task-suggestions [role=option]').length === 1 && document.querySelector('.timer-task-suggestions [data-task-id=\"2\"]')", 'Completed choices refreshed')
    await browser.evaluate("document.querySelector('.timer-task-picker input').blur()")
    assert.equal(model.entries.length, 0)
    assert.doesNotMatch(await browser.evaluate('document.body.innerText'), /NaN|Invalid Date/)
  })
  await t.test('rapid repeated Start sends only one POST', async () => {
    await load(); await browser.evaluate("document.querySelector('.timer-play-button').click(); document.querySelector('.timer-play-button').click()")
    await browser.until("document.querySelector('.timer-session') && !document.querySelector('.timer-session .timer-stop').disabled", 'Start finished')
    assert.equal(posts('start').length, 1)
  })
  await t.test('older Active read cannot undo a later confirmed Start', async () => {
    await load(); model.heldRead = 'next'
    await browser.evaluate("window.dispatchEvent(new Event('focus'))")
    await browser.until('true', 'Focus dispatched')
    for (let i = 0; i < 100 && (model.heldRead === 'next'); i += 1) await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(typeof model.heldRead, 'object')
    const held = model.heldRead; model.heldRead = null
    await start(); await browser.fulfill(held.requestId, held.response)
    await browser.evaluate('new Promise(resolve => setTimeout(resolve, 100))')
    assert.equal(await browser.evaluate("Boolean(document.querySelector('.timer-session:not(.paused)'))"), true)
  })
  await t.test('initial Active failure blocks Start until explicit successful resync', async () => {
    reset(); model.activeFailure = true; await browser.navigate(); await alert()
    assert.equal(await browser.evaluate("document.querySelector('.timer-play-button').disabled"), true)
    model.activeFailure = false; insert(2, 90)
    await browser.click('.global-error button')
    await browser.until("document.querySelector('.timer-session .timer-task-title')?.textContent === 'Timer Task 2'", 'Recovered Active')
  })
  await t.test('server error on Stop does not locally stop Active', async () => {
    await load(); await start(); model.fault = 'stop-500'; await browser.click('.timer-session .timer-stop'); await alert()
    assert.equal(await browser.evaluate("Boolean(document.querySelector('.timer-session:not(.paused)'))"), true)
  })
  await t.test('successful Start followed by another client Active synchronizes selection and history', async () => {
    await load(); model.switchAfterStart = true; await start()
    await browser.until("document.querySelector('.timer-task-title')?.textContent === 'Timer Task 2'", 'Final Active wins over Start response')
    await history()
    assert.equal(await browser.evaluate("document.querySelector('.timer-modal h3').textContent"), 'Timer Task 2')
    assert.equal(await browser.evaluate("document.querySelectorAll('.history-list li').length"), 1)
  })
  await t.test('Stop 409 switches from stale Task to another DB Active', async () => {
    await load(); await start(); model.entries[0].endedAt = stamp(); insert(2)
    await browser.click('.timer-session .timer-stop'); await alert()
    await browser.until("document.querySelector('.timer-session .timer-task-title')?.textContent === 'Timer Task 2'", 'Other Active restored')
    assert.equal(await browser.evaluate("document.querySelector('.timer-task-title').textContent"), 'Timer Task 2')
  })
  await t.test('an older Active history read cannot replace the confirmed closed entry', async () => {
    await load(); await start(); model.heldHistory = 'next'
    await browser.evaluate("window.dispatchEvent(new Event('focus'))")
    for (let i = 0; i < 100 && model.heldHistory === 'next'; i += 1) await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(typeof model.heldHistory, 'object')
    const held = model.heldHistory; model.heldHistory = null
    await stop(); await browser.fulfill(held.requestId, held.response)
    await history()
    await browser.until("document.querySelector('.history-list strong')?.textContent === '0分'", 'Old history ignored')
    assert.doesNotMatch(await browser.evaluate("document.querySelector('.history-list').innerText"), /終了 —/)
  })
  await t.test('confirmed Stop stays stopped if its subsequent Active refetch fails', async () => {
    await load(); await start(); model.activeFailure = true
    await browser.click('.timer-session .timer-stop'); await alert()
    assert.equal(active().running, false)
    assert.equal(await browser.evaluate("Boolean(document.querySelector('.timer-session'))"), false)
    model.activeFailure = false; await browser.click('.global-error button')
    await browser.until("!document.querySelector('.timer-play-button').disabled", 'Resync confirms successful Stop')
  })
  assert.deepEqual(runtimeErrors, [], 'No browser runtime exceptions')
  assert.deepEqual(interceptionErrors, [], 'All API requests intercepted safely')
})
