import { chooseTaskStatus } from './current-task-ui.mjs'
import { isolateScenarios } from './scenario-fixture.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { selectProject, openBrowser, selectTimerTask } from './browser.mjs'

test('Task NULL estimates and history-protected deletion use a guarded temporary Backend', { timeout: 180000 }, async t => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const python = process.env.TIMER_TEST_PYTHON ?? path.join(root, 'backend', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  const directory = await mkdtemp(path.join(tmpdir(), 'task-timer-db-'))
  let backend, browser, base, now
  let clockVersion = 0
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
    now = Date.parse(value)
    if (browser) await browser.evaluate(`window.__crudNow = ${now}; undefined`)
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
  await setClock('2026-10-02T10:00:00Z')
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
  const project = await api('/projects', { name: 'History project' })
  const movedProject = await api('/projects', { name: 'Moved project' })
  const disposable = await api('/projects', { name: 'No history project' })
  await api('/tasks', { title: 'No snapshot membership', projectId: disposable.id })
  const history = await api('/tasks', { title: 'History 10 minutes', estimatedMinutes: 20, projectId: project.id, plannedDate: '2026-10-02' })
  const other = await api('/tasks', { title: 'Other 90 minutes', estimatedMinutes: 90, plannedDate: '2026-10-02' })
  const schedule = await api('/schedule-blocks', { taskId: history.id, date: '2026-10-02', type: 'TIMED', startTime: '10:00', durationMinutes: 30 })
  await api('/tasks/time/start', { taskId: history.id })
  await setClock('2026-10-02T10:10:00Z'); await api('/tasks/time/stop', { taskId: history.id })
  await api('/tasks/time/start', { taskId: other.id })
  await setClock('2026-10-02T11:40:00Z'); await api('/tasks/time/stop', { taskId: other.id })
  await setClock('2026-10-02T12:00:00Z')
  const reports = async () => Promise.all([
    '/reports/daily?date=2026-10-02&timezone=UTC',
    '/reports/weekly?date=2026-10-02&timezone=UTC',
    '/reports/monthly?month=2026-10&timezone=UTC',
  ].map(route => api(route)))
  const estimates = async () => (await reports()).map((report, index) => report[['dailyEstimatedMinutes', 'weeklyEstimatedMinutes', 'monthlyEstimatedMinutes'][index]])
  const baselineEstimates = await estimates()
  browser = await openBrowser()
  await browser.send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' })
  await browser.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(()=>{const OriginalDate=Date;window.__crudNow=${now};window.confirm=()=>true;window.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:[window.__crudNow]));}static now(){return window.__crudNow;}};})()`,
  })
  const requests = [], errors = []
  browser.listeners.push(message => {
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'warn'].includes(message.params.type)) errors.push(message.params.args)
    if (message.method !== 'Fetch.requestPaused') return
    const { request, requestId } = message.params
    void (async () => {
      if (request.method === 'OPTIONS') { await browser.fulfill(requestId, {}); return }
      const url = new URL(request.url)
      const item = { method: request.method, path: url.pathname, payload: request.postData ? JSON.parse(request.postData) : undefined }
      requests.push(item)
      const response = await fetch(`${base}${url.pathname}${url.search}`, {
        method: request.method,
        ...(request.postData ? { headers: { 'Content-Type': 'application/json' }, body: request.postData } : {}),
      })
      item.status = response.status
      await browser.fulfill(requestId, await response.json(), response.status)
    })().catch(async error => {
      if (/Invalid InterceptionId|Invalid interceptionId|Invalid requestId/.test(error.message)) return
      errors.push(error.message)
      try { await browser.send('Fetch.failRequest', { requestId, errorReason: 'ConnectionFailed' }) } catch { /* Closing. */ }
    })
  })
  // All application API requests are intercepted; localhost:8000 is never contacted.
  await browser.send('Fetch.enable', { patterns: [{ urlPattern: 'http://localhost:8000/*', requestStage: 'Request' }] })
  const row = title => `Array.from(document.querySelectorAll('.task-table-row')).find(item=>item.querySelector('.task-table-name strong')?.textContent===${JSON.stringify(title)})`
  async function setInput(selector, value) {
    if (await browser.evaluate(`document.querySelector(${JSON.stringify(selector)})?.type==='hidden'`)) return selectProject(browser, selector, value)
    await browser.evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(input.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(String(value))});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`)
  }
  async function settleRequests() {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const count = requests.length
      await sleep(100)
      if (count === requests.length && requests.every(item => item.status !== undefined)) return
    }
    assert.fail('Background API requests did not finish')
  }
  async function tasks(reload = false) {
    if (reload) await browser.navigate(true)
    await browser.until("document.querySelector('.icon-rail [aria-label=\"タスク\"]')", 'Navigation mounted')
    await browser.click('.icon-rail [aria-label="タスク"]')
    await browser.click('.icon-rail [aria-label="タスク"]')
    await browser.until("document.querySelector('.task-list-toolbar') && document.querySelectorAll('.task-table-row').length>=2", 'Tasks ready')
    await settleRequests()
  }
  async function clickRow(title, selector) {
    await browser.until(`Boolean(${row(title)})`, `Task row: ${title}`)
    if (selector === '.task-state') { const completed = await browser.evaluate(`${row(title)}.classList.contains('task-status-completed')`); return chooseTaskStatus(browser, row(title), completed ? 'NOT_STARTED' : 'COMPLETED') }
    await browser.evaluate(`${row(title)}.querySelector(${JSON.stringify(selector)}).click()`)
  }
  async function save(title) {
    await browser.click('.task-form button[type="submit"]')
    await browser.until(`!document.querySelector('.task-composer') && Boolean(${row(title)})`, 'Task saved')
  }
  async function projectView() {
    await tasks()
    await browser.click('.icon-rail [aria-label="プロジェクト"]')
    await browser.until("document.querySelector('.project-grid')", 'Projects ready')
    await settleRequests()
  }
  async function deleteProject(name) {
    const card = `Array.from(document.querySelectorAll('.project-card')).find(item=>item.querySelector('.project-card-heading strong')?.textContent===${JSON.stringify(name)})`
    await browser.evaluate(`${card}.querySelector('.project-menu-trigger').click()`)
    await browser.until(`${card}?.querySelector('[data-action=delete]')`, 'Project delete menu opened')
    await browser.evaluate(`${card}.querySelector('[data-action=delete]').click()`)
  }
  const title = 'NULL estimate task'
  const renamed = 'Renamed NULL estimate task'
  let unknown
  await browser.navigate(); await tasks()

  await isolateScenarios(t, { browser, directory, python,
    prepare: async name => {
      await setClock('2026-10-02T12:00:00Z')
      if (!name.startsWith('blank estimate')) {
        unknown = await api('/tasks', { title: name.startsWith('a NULL Task') ? title : renamed, estimatedMinutes: name.startsWith('45 to blank') ? 45 : null, projectId: project.id })
        await api('/schedule-blocks', { taskId: unknown.id, date: '2026-10-02', type: 'TIME_UNSET' })
      }
      if (/^(Active Project|deleting a history-free)/.test(name)) {
        activeTask = await api('/tasks', { title: 'Active deletion guard', projectId: movedProject.id, plannedDate: '2026-10-02' })
        await api('/tasks/time/start', { taskId: activeTask.id }); await setClock('2026-10-02T12:10:00Z')
      }
    },
    ready: async name => {
      await tasks()
      if (/^(Active Project|a Project without|deleting a history-free)/.test(name)) await projectView()
      if (name.startsWith('a Project without')) {
        await deleteProject(project.name)
        await browser.until('document.querySelector(".global-error")', 'Explicit prerequisite: protected Project deletion error')
      }
    },
  })
  await t.test('blank estimate creates NULL and displays blank without affecting any Report estimate', async () => {
    await browser.click('.task-list-tools .primary-action')
    assert.equal(await browser.evaluate("document.querySelector('.task-form [name=estimatedMinutes]').value"), '')
    await setInput('.task-form [name=title]', title)
    await setInput('.task-form [name=projectId]', project.id)
    await save(title)
    unknown = (await api('/tasks')).find(task => task.title === title)
    assert.equal(unknown.estimatedMinutes, null)
    const submitted = requests.findLast(item => item.method === 'POST' && item.path === '/tasks')
    assert.equal(submitted.status, 201); assert.equal(submitted.payload.estimatedMinutes, null)
    assert.equal(await browser.evaluate(`${row(title)}.querySelector('[data-label="見積もり"]').textContent`), '')
    assert.deepEqual(await estimates(), baselineEstimates)
    await api('/schedule-blocks', { taskId: unknown.id, date: '2026-10-02', type: 'TIME_UNSET' })
  })
  await t.test('a NULL Task allows a title-only edit and retains NULL', async () => {
    await clickRow(title, '.task-row-edit')
    await setInput('.task-form [name=title]', renamed)
    await save(renamed)
    const stored = await api(`/tasks/${unknown.id}`)
    assert.equal(stored.title, renamed); assert.equal(stored.estimatedMinutes, null)
    assert.equal(requests.findLast(item => item.method === 'PUT' && item.path === `/tasks/${unknown.id}`).payload.estimatedMinutes, null)
  })
  await t.test('NULL to 45 adds the known estimate to Daily Weekly Monthly', async () => {
    await clickRow(renamed, '.task-row-edit'); await setInput('.task-form [name=estimatedMinutes]', 45); await save(renamed)
    assert.equal((await api(`/tasks/${unknown.id}`)).estimatedMinutes, 45)
    assert.deepEqual(await estimates(), baselineEstimates.map(value => value + 45))
  })
  await t.test('45 to blank writes DB NULL and restores all Report estimate totals', async () => {
    await clickRow(renamed, '.task-row-edit'); await setInput('.task-form [name=estimatedMinutes]', ''); await save(renamed)
    assert.equal((await api(`/tasks/${unknown.id}`)).estimatedMinutes, null)
    assert.equal(requests.findLast(item => item.method === 'PUT' && item.path === `/tasks/${unknown.id}`).payload.estimatedMinutes, null)
    await browser.until(`${row(renamed)}?.querySelector('[data-label="見積もり"]').textContent===''`, 'Saved NULL estimate displayed')
    assert.deepEqual(await estimates(), baselineEstimates)
  })
  for (const value of ['0', '-10', '1.5']) await t.test(`estimate ${value} is rejected, never rounded or sent as NULL`, async () => {
    await clickRow(renamed, '.task-row-edit'); await setInput('.task-form [name=estimatedMinutes]', value)
    assert.equal(await browser.evaluate("document.querySelector('.task-form [name=estimatedMinutes]').checkValidity()"), false)
    const before = requests.filter(item => item.method === 'PUT' && item.path === `/tasks/${unknown.id}`).length
    await browser.click('.task-form button[type="submit"]'); await sleep(100)
    assert.equal(await browser.evaluate("document.querySelector('.task-form [name=estimatedMinutes]').value"), value)
    // Also exercise the submit guard if native HTML validation is bypassed.
    await browser.evaluate("document.querySelector('.task-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))")
    await browser.until("document.querySelector('.global-error')?.textContent.includes('1以上の整数')", 'Integer validation')
    assert.equal(requests.filter(item => item.method === 'PUT' && item.path === `/tasks/${unknown.id}`).length, before)
    assert.equal((await api(`/tasks/${unknown.id}`)).estimatedMinutes, null)
    await browser.click('.task-composer .icon-close')
  })
  await t.test('completing a NULL estimate Task keeps its completion snapshot NULL', async () => {
    await clickRow(renamed, '.task-state')
    await browser.until(`${row(renamed)}?.querySelector('.task-status-trigger').textContent==='完了'`, 'Completed NULL Task')
    const completed = await api(`/tasks/${unknown.id}`)
    assert(completed.completedAt); assert.equal(completed.completedEstimateMinutes, null)
    assert.equal(completed.estimatedMinutes, null)
    await clickRow(renamed, '.task-state')
    await browser.until(`${row(renamed)}?.querySelector('.task-status-trigger').textContent==='未着手'`, 'Reverted to NOT_STARTED')
  })
  await t.test('closed-history Task DELETE shows its 409 reason and keeps 100 actual minutes', async () => {
    const before = await api(`/tasks/${history.id}`), entries = await api(`/tasks/${history.id}/time-entries`), totals = await reports()
    assert.equal(totals[0].dailyActualMinutes, 100)
    await clickRow(history.title, '[aria-label="タスクを削除"]')
    await browser.until("document.querySelector('.global-error')?.textContent.includes('記録履歴があるため、このタスクは削除できません')", 'Task deletion reason')
    assert.equal(requests.findLast(item => item.method === 'DELETE').status, 409)
    assert.deepEqual(await api(`/tasks/${history.id}`), before)
    assert.deepEqual(await api(`/tasks/${history.id}/time-entries`), entries)
    assert((await api('/schedule-blocks?startDate=2026-10-02&endDate=2026-10-02')).some(block => block.id === schedule.id))
    assert.deepEqual(await reports(), totals)
    assert(await browser.evaluate(`Boolean(${row(history.title)})`))
  })
  await t.test('historical Project DELETE remains blocked after moving its Task', async () => {
    await api(`/tasks/${history.id}`, { projectId: movedProject.id }, 'PUT')
    await tasks(true); await projectView()
    const before = await api('/projects'), entries = await api(`/tasks/${history.id}/time-entries`)
    assert.equal(before.find(item => item.id === project.id).actualMinutes, 10)
    await deleteProject(project.name)
    await browser.until("document.querySelector('.global-error')?.textContent.includes('記録履歴から参照されているため、このプロジェクトは削除できません')", 'Project deletion reason')
    // A background Active resync must not erase this business error.
    await browser.evaluate("window.dispatchEvent(new Event('focus'))")
    await settleRequests()
    assert(await browser.evaluate("document.querySelector('.global-error')?.textContent.includes('記録履歴から参照されているため、このプロジェクトは削除できません')"))
    assert.equal(requests.findLast(item => item.method === 'DELETE').status, 409)
    assert.deepEqual(await api('/projects'), before)
    assert.deepEqual(await api(`/tasks/${history.id}/time-entries`), entries)
    assert.equal((await api(`/tasks/${history.id}`)).projectId, movedProject.id)
  })
  let activeTask
  await t.test('Active Task DELETE preserves the same persisted Active and status', async () => {
    activeTask = await api('/tasks', { title: 'Active deletion guard', projectId: movedProject.id, plannedDate: '2026-10-02' })
    await api('/tasks/time/start', { taskId: activeTask.id }); await setClock('2026-10-02T12:10:00Z')
    await tasks(true)
    const before = await api(`/tasks/${activeTask.id}`), active = await api('/tasks/time/active'), totals = await reports()
    await clickRow(activeTask.title, '[aria-label="タスクを削除"]')
    await browser.until("document.querySelector('.global-error')?.textContent.includes('記録履歴があるため、このタスクは削除できません')", 'Active deletion reason')
    assert.deepEqual(await api(`/tasks/${activeTask.id}`), before)
    assert.deepEqual(await api('/tasks/time/active'), active); assert.deepEqual(await reports(), totals)
  })
  await t.test('Active Project snapshot also blocks DELETE without unassigning Tasks', async () => {
    await projectView()
    const before = await api('/projects'), tasksBefore = await api('/tasks'), active = await api('/tasks/time/active')
    await deleteProject(movedProject.name)
    await browser.until("document.querySelector('.global-error')?.textContent.includes('記録履歴から参照されているため、このプロジェクトは削除できません')", 'Active Project deletion reason')
    assert.deepEqual(await api('/projects'), before); assert.deepEqual(await api('/tasks'), tasksBefore)
    assert.deepEqual(await api('/tasks/time/active'), active)
  })
  await t.test('a Project without snapshots is still deletable and clears the previous error', async () => {
    assert(await browser.evaluate("document.querySelector('.global-error')?.textContent.includes('プロジェクトは削除できません')"))
    await deleteProject(disposable.name)
    await browser.until("!document.body.textContent.includes('No history project') && !document.querySelector('.global-error')", 'Project deleted')
    assert(!(await api('/projects')).some(item => item.id === disposable.id))
    assert.equal((await api('/tasks')).find(item => item.title === 'No snapshot membership').projectId, null)
  })
  await t.test('deleting a history-free Task keeps another Task Active', async () => {
    const disposableTask = await api('/tasks', { title: 'Deletable while another Task runs' })
    await tasks()
    const active = await api('/tasks/time/active'), before = await api(`/tasks/${activeTask.id}`)
    assert.equal(active.taskId, activeTask.id)
    await clickRow(disposableTask.title, '[aria-label="タスクを削除"]')
    await browser.until(`!(${row(disposableTask.title)})`, 'History-free Task deleted during Active')
    assert.deepEqual(await api('/tasks/time/active'), active)
    assert.deepEqual(await api(`/tasks/${activeTask.id}`), before)
    assert(await browser.evaluate(`document.querySelector('.timer-session .timer-task-title')?.textContent===${JSON.stringify(activeTask.title)}`))
    await api('/tasks/time/stop', { taskId: activeTask.id })
    await browser.evaluate("window.dispatchEvent(new Event('focus'))")
    await settleRequests()
    await browser.until("document.querySelector('.timer-session')===null", 'Stopped Active restored')
  })
  await t.test('a Task without entries still deletes and cascades its ScheduleBlock', async () => {
    const block = await api('/schedule-blocks', { taskId: unknown.id, date: '2026-10-02', type: 'TIMED', startTime: '14:00', durationMinutes: 30 })
    await browser.click('.icon-rail [aria-label="ホーム"]')
    await selectTimerTask(browser, unknown.id)
    await settleRequests()
    await tasks()
    const actual = (await reports())[0].dailyActualMinutes
    await clickRow(renamed, '[aria-label="タスクを削除"]')
    await browser.until(`!(${row(renamed)})`, 'Task deleted')
    assert.equal(requests.findLast(item => item.method === 'DELETE').status, 200)
    assert(!(await api('/schedule-blocks?startDate=2026-10-02&endDate=2026-10-02')).some(item => item.id === block.id))
    assert.equal((await reports())[0].dailyActualMinutes, actual)
    await settleRequests()
    assert.equal(await browser.evaluate("document.querySelector('.global-error')===null"), true)
  })
  assert.deepEqual(errors, [], 'No browser crashes, React warnings or API forwarding failures')
  assert.deepEqual(requests.filter(item => [404, 422, 500].includes(item.status)), [], 'No unexpected API failures')
})
