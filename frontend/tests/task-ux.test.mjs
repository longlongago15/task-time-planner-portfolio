import { chooseTaskStatus, setTaskFilter } from './current-task-ui.mjs'
import { isolateScenarios } from './scenario-fixture.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { selectProject, openBrowser, pauseOrResumeTimer } from './browser.mjs'

test('Tasks UX uses Backend statuses, guarded temporary DB and existing lifecycle', { timeout: 240000 }, async t => {
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
  browser = await openBrowser()
  await browser.send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' })
  await browser.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(()=>{const OriginalDate=Date;window.__crudNow=${now};window.confirm=()=>true;window.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:[window.__crudNow]));}static now(){return window.__crudNow;}};})()`,
  })
  let failProject=false, holdProject=false, releaseProject, failTask=false, holdTask=false, releaseTask, emptyTasks=false
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
      if (emptyTasks && url.pathname==='/tasks' && request.method==='GET') { item.status=200; await browser.fulfill(requestId,[]); return }
      if (url.pathname==='/projects' && request.method==='POST') {
        if (failProject) { item.status=500; await browser.fulfill(requestId,{detail:'Controlled Project failure'},500); return }
        if (holdProject) { await browser.evaluate('window.__projectHeld=true'); await new Promise(resolve=>{releaseProject=resolve}) }
      }
      if (url.pathname.startsWith('/tasks') && ['POST','PUT'].includes(request.method) && !url.pathname.includes('/time/')) {
        if (failTask) { item.status=500; await browser.fulfill(requestId,{detail:'Controlled Task failure'},500); return }
        if (holdTask && request.method==='POST') { await browser.evaluate('window.__taskHeld=true'); await new Promise(resolve=>{releaseTask=resolve}) }
      }
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
    await browser.evaluate(`(()=>{const r=${row(title)};const menu=r.querySelector('details');if(menu && ${JSON.stringify(selector)}!=='.task-state')menu.open=true;r.querySelector(${JSON.stringify(selector)}).click()})()`)
  }
  async function save(title) {
    await browser.click('.task-form button[type="submit"]')
    await browser.until(`!document.querySelector('.task-composer') && Boolean(${row(title)})`, 'Task saved')
  }

  const input = async (name, value) => setInput(`.task-composer [name="${name}"]`, value)
  const create = async (title, estimate = '', projectId = '') => {
    await browser.click('.task-list-tools .primary-action')
    await browser.until('document.querySelector(".task-composer[open]")', 'Task form open')
    await input('title', title)
    await input('estimatedMinutes', estimate)
    await input('projectId', projectId)
    await save(title)
    return (await api('/tasks')).find(item => item.title === title)
  }
  const status = value => setTaskFilter(browser, 'status', value === 'all' ? [] : [value])
  const close = () => browser.click('.task-composer .icon-close')
  const startCount = () => requests.filter(item => item.path === '/tasks/time/start' && item.method === 'POST').length
  const screenshot = async label => {
    if (!process.env.TASK_VISUAL_OUTPUT) return
    const destination = path.resolve(process.env.TASK_VISUAL_OUTPUT)
    const relative = path.relative(path.resolve(tmpdir()), destination)
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
    const result = await browser.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    await writeFile(path.join(destination, label+'.png'), Buffer.from(result.data, 'base64'))
  }
  const completed = await api('/tasks', { title: 'Completed readable task', estimatedMinutes: 15 })
  await api(`/tasks/${completed.id}/complete`, { completed: true }, 'PATCH')
  const notStartedTitle = 'No snapshot membership'
  const freshTitle = 'Title only task'
  const renamed = 'Edited title only task'
  let fresh

  await browser.navigate(); await tasks()
  await isolateScenarios(t, { browser, directory, python,
    reset: async () => {
      failProject = holdProject = failTask = holdTask = emptyTasks = false
      releaseProject?.(); releaseTask?.(); releaseProject = releaseTask = undefined
    },
    prepare: async name => {
      await setClock('2026-10-02T12:00:00Z')
      if (!/^(API statuses|status filter|task row shows|title-only create|empty API)/.test(name)) {
        fresh = await api('/tasks', { title: name.startsWith('edit retains') ? freshTitle : renamed, projectId: name.startsWith('edit retains') ? null : project.id, estimatedMinutes: null })
      }
      if (name.startsWith('Active completion')) await api('/tasks/time/start', { taskId: fresh.id })
      if (name.startsWith('search and Project')) {
        const independent = await api('/projects', { name: 'Inline Edited' })
        await api(`/tasks/${fresh.id}`, { projectId: independent.id }, 'PUT')
      }
    }, ready: () => tasks(),
  })
  await t.test('API statuses display 未着手 / 進行中 / 完了 with distinct semantic colors', async () => {
    const colors=[]
    for(const [title,label] of [[notStartedTitle,'未着手'],[history.title,'進行中'],[completed.title,'完了']]){
      assert.equal(await browser.evaluate(`${row(title)}.querySelector('.task-status-trigger').textContent`),label)
      colors.push(await browser.evaluate(`getComputedStyle(${row(title)}.querySelector('.task-status-trigger .shared-pill')).backgroundColor`))
    }
    assert.equal(new Set(colors).size,3)
  })
  await t.test('status filter has three checkbox choices and composes with Placement independently of status', async () => {
    await browser.click('[data-filter="status"] > button')
    assert.deepEqual(await browser.evaluate("Array.from(document.querySelectorAll('.task-filter-popover label')).map(e=>e.textContent)"),['未着手','進行中','完了'])
    await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
    for(const [value,expected] of [['NOT_STARTED',1],['IN_PROGRESS',2],['COMPLETED',1],['all',4]]){
      await status(value);await browser.until(`document.querySelectorAll('.task-list-panel .task-table-row').length===${expected}`,'Status filtered')
    }
    await status('COMPLETED');assert.equal(await browser.evaluate("document.querySelectorAll('.task-table-row').length"),1)
  })
  await t.test('task row shows Backend actual totals, NULL as blank and no date/time subtitle', async () => {
    assert.equal(await browser.evaluate(`${row(history.title)}.querySelector('[data-label="記録"]').textContent`),'10m')
    assert.equal(await browser.evaluate(`${row(notStartedTitle)}.querySelector('[data-label="見積もり"]').textContent`),'')
    for (const title of [history.title, other.title, notStartedTitle]) {
      assert.equal(await browser.evaluate(`${row(title)}.querySelector('.task-table-name').children.length`),1)
      assert.equal(await browser.evaluate(`${row(title)}.textContent.includes('2026-10-02')`),false)
    }
  })
  await t.test('title-only create sends explicit NULL estimate and Project without legacy schedule fields', async () => {
    fresh = await create(freshTitle)
    assert.equal(fresh.estimatedMinutes,null);assert.equal(fresh.projectId,null)
    assert.deepEqual(requests.findLast(r=>r.path==='/tasks'&&r.method==='POST').payload,{title:freshTitle,estimatedMinutes:null,projectId:null,priority:null,deadline:null,tagIds:[]})
    assert.equal(await browser.evaluate(`getComputedStyle(${row(freshTitle)}.querySelector('.project-picker-trigger .unset-value')).display`),'none')
  })
  await t.test('edit retains NULL, edits title and existing Project without creating a Schedule from empty controls', async () => {
    assert.deepEqual(await api(`/schedule-blocks?taskId=${fresh.id}`),[])
    await clickRow(freshTitle,'.task-row-edit')
    assert.equal(await browser.evaluate('document.querySelector(".task-form input[name=startTime][type=time]")?.value'),'')
    assert.equal(await browser.evaluate('document.querySelector(".task-form [name=date]")?.value'),'')
    assert.equal(await browser.evaluate('document.querySelector(".task-form [name=estimatedMinutes]").value'),'')
    await input('title',renamed);await input('projectId',project.id);await save(renamed)
    const result = await api(`/tasks/${fresh.id}`)
    assert.equal(result.estimatedMinutes,null);assert.equal(result.projectId,project.id)
    assert.deepEqual(await api(`/schedule-blocks?taskId=${fresh.id}`),[])
  })
  await t.test('NULL → positive → NULL does not convert an empty estimate to zero', async () => {
    for (const value of ['37','']) {
      await clickRow(renamed,'.task-row-edit');await input('estimatedMinutes',value);await save(renamed)
      assert.equal((await api(`/tasks/${fresh.id}`)).estimatedMinutes,value===''?null:37)
    }
  })
  for (const value of ['0','-1','1.5']) await t.test(`invalid estimate ${value} is rejected natively and by submit guard`, async () => {
    await clickRow(renamed,'.task-row-edit');await input('estimatedMinutes',value)
    assert.equal(await browser.evaluate('document.querySelector(".task-form [name=estimatedMinutes]").checkValidity()'),false)
    const before = requests.filter(r=>r.path===`/tasks/${fresh.id}`&&r.method==='PUT').length
    await browser.evaluate('document.querySelector(".task-form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))')
    await browser.until('document.querySelector(".task-form-error")?.textContent.includes("1以上の整数")','Inline validation')
    assert.equal(requests.filter(r=>r.path===`/tasks/${fresh.id}`&&r.method==='PUT').length,before)
    assert.equal((await api(`/tasks/${fresh.id}`)).estimatedMinutes,null)
    await close()
  })
  await t.test('inline Project create adds and selects the Project before creating the Task', async () => {
    await browser.click('.task-list-tools .primary-action');await input('title','Inline Project task')
    await browser.click('.task-form .project-picker-trigger'); await browser.click('.task-form .project-picker-create')
    assert.equal(await browser.evaluate('document.activeElement.name'),'name')
    await setInput('.project-composer [name=name]','  Inline Created  ')
    await browser.click('.project-composer .primary-action')
    await browser.until('!document.querySelector(".project-composer")','Inline Project saved')
    const project = (await api('/projects')).find(p=>p.name==='Inline Created')
    assert(project)
    assert.equal(await browser.evaluate('document.querySelector(".task-form [name=projectId]").value'),String(project.id))
    assert.equal(await browser.evaluate('document.querySelector(".task-form [name=title]").value'),'Inline Project task')
    await save('Inline Project task')
    assert.equal((await api('/tasks')).find(t=>t.title==='Inline Project task').projectId,project.id)
  })
  await t.test('edit can create a Project inline while preserving NULL estimate and title', async () => {
    await clickRow(renamed,'.task-row-edit')
    await browser.click('.task-form .project-picker-trigger'); await browser.click('.task-form .project-picker-create')
    await setInput('.project-composer [name=name]','Inline Edited')
    // Enter creates the Project, rather than submitting the Task.
    await browser.evaluate('document.querySelector(".project-composer form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))')
    await browser.until('!document.querySelector(".project-composer")','Edited inline Project saved')
    const project = (await api('/projects')).find(p=>p.name==='Inline Edited')
    assert.equal((await api(`/tasks/${fresh.id}`)).projectId, (await api('/projects')).find(p=>p.name==='History project').id)
    await save(renamed)
    const result = await api(`/tasks/${fresh.id}`)
    assert.equal(result.projectId,project.id);assert.equal(result.title,renamed);assert.equal(result.estimatedMinutes,null)
  })
  await t.test('Project validation, duplicate 409 and controlled 500 stay inline without losing Task input', async () => {
    await clickRow(renamed,'.task-row-edit');await browser.click('.task-form .project-picker-trigger'); await browser.click('.task-form .project-picker-create')
    const before=requests.filter(r=>r.path==='/projects'&&r.method==='POST').length
    await browser.click('.project-composer .primary-action')
    await browser.until('document.querySelector(".project-form-error")?.textContent.includes("入力")','Required name')
    assert.equal(requests.filter(r=>r.path==='/projects'&&r.method==='POST').length,before)
    await setInput('.project-composer [name=name]',project.name)
    await browser.click('.project-composer .primary-action')
    await browser.until('document.querySelector(".project-form-error")?.textContent.includes("登録")','Duplicate Project')
    assert.equal(requests.findLast(r=>r.path==='/projects'&&r.method==='POST').status,409)
    failProject=true;await setInput('.project-composer [name=name]','Retry Project')
    await browser.click('.project-composer .primary-action')
    await browser.until('document.querySelector(".project-form-error")?.textContent.includes("エラー")','Project 500')
    assert.equal(await browser.evaluate('document.querySelector(".task-form [name=title]").value'),renamed)
    failProject=false
    await browser.click('.project-composer .primary-action')
    await browser.until('!document.querySelector(".project-composer")','Project retry')
    await close()
  })
  await t.test('Project and Task pending operations reject duplicate submission and cannot dismiss halfway', async () => {
    await browser.click('.task-list-tools .primary-action');await input('title','Duplicate guarded task')
    await browser.click('.task-form .project-picker-trigger'); await browser.click('.task-form .project-picker-create');await setInput('.project-composer [name=name]','Duplicate guarded project')
    holdProject=true
    const before=requests.filter(r=>r.path==='/projects'&&r.method==='POST').length
    await browser.click('.project-composer .primary-action')
    await browser.until('document.querySelector(".project-composer").getAttribute("aria-busy")==="true"','Project saving')
    await browser.evaluate('document.querySelector(".project-composer .primary-action").click();document.querySelector(".task-form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))')
    await sleep(60)
    assert.equal(requests.filter(r=>r.path==='/projects'&&r.method==='POST').length,before+1)
    await browser.until('window.__projectHeld===true','Project request held')
    holdProject=false;releaseProject()
    await browser.until('!document.querySelector(".project-composer")','Project released')
    holdTask=true
    const taskBefore=requests.filter(r=>r.path==='/tasks'&&r.method==='POST').length
    await browser.click('.task-form button[type=submit]')
    await browser.until('document.querySelector(".task-composer").getAttribute("aria-busy")==="true"','Task saving')
    await browser.until('window.__taskHeld===true','Task request held')
    await browser.evaluate('document.querySelector(".task-form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))')
    await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
    await browser.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
    assert.equal(await browser.evaluate('document.querySelector(".task-composer").open'),true)
    await browser.until('window.__taskHeld===true','Task request held')
    holdTask=false;releaseTask()
    await browser.until(`!document.querySelector('.task-composer') && Boolean(${row('Duplicate guarded task')})`,'Task saved once')
    assert.equal(requests.filter(r=>r.path==='/tasks'&&r.method==='POST').length,taskBefore+1)
    assert.equal((await api('/tasks')).filter(t=>t.title==='Duplicate guarded task').length,1)
  })
  await t.test('create and edit API failures stay by the form and permit safe retry', async () => {
    await browser.click('.task-list-tools .primary-action');await input('title','Retry Task')
    failTask=true;await browser.click('.task-form button[type=submit]')
    await browser.until('document.querySelector(".task-form-error")?.textContent.includes("エラー")','Create error')
    assert.equal((await api('/tasks')).some(t=>t.title==='Retry Task'),false)
    failTask=false;await save('Retry Task')
    await clickRow('Retry Task','.task-row-edit');await input('title','Retry Task edited')
    failTask=true;await browser.click('.task-form button[type=submit]')
    await browser.until('document.querySelector(".task-form-error")?.textContent.includes("エラー")','Edit error')
    assert.equal((await api('/tasks')).some(t=>t.title==='Retry Task edited'),false)
    failTask=false;await save('Retry Task edited')
  })
  await t.test('Timer Start updates status, blocks other Start with 409 and keeps the same Active', async () => {
    await clickRow(renamed,'.task-timer-always')
    await browser.until(`${row(renamed)}?.querySelector('.task-status-trigger').textContent==='進行中' && document.querySelector('.timer-session')`,'IN_PROGRESS without reload')
    assert.equal(await browser.evaluate(`${row(renamed)}.querySelector('.task-timer-always').getAttribute('aria-pressed')`),'true')
    const active = await api('/tasks/time/active'), count=startCount()
    assert.equal(await browser.evaluate(`${row(renamed)}.querySelector('.task-timer-always [data-icon=play]')`),null)
    assert.equal(startCount(),count)
    await clickRow(notStartedTitle,'.task-timer-always')
    await browser.until('Array.from(document.querySelectorAll(".global-error")).some(e=>e.textContent.includes("他の計測"))','Timer 409')
    await browser.until(`${row(notStartedTitle)}?.querySelector('.task-row-error')?.textContent.includes('計測を開始できません')`,'Timer error by target row')
    assert.equal(requests.findLast(r=>r.path==='/tasks/time/start').status,409)
    assert.deepEqual(await api('/tasks/time/active'),active)
    assert.equal(requests.filter(r=>r.path==='/tasks/time/stop').length,0)
  })
  await t.test('Active completion rejected; Header Pause / Resume / Stop preserve status and measured actual', async () => {
    await clickRow(renamed,'.task-state')
    await browser.until(`${row(renamed)}?.querySelector('[role=alert]')?.textContent.includes('終了してから完了')`,'Active completion guard')
    assert(await browser.evaluate(`${row(renamed)}.querySelector('[role=alert]').textContent.includes('終了してから完了')`))
    assert.equal((await api(`/tasks/${fresh.id}`)).status,'IN_PROGRESS')
    assert.equal(requests.findLast(r=>r.path===`/tasks/${fresh.id}`&&r.method==='PUT').status,409)
    await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',windowsVirtualKeyCode:27})
    await setClock('2026-10-02T12:05:00Z')
    await pauseOrResumeTimer(browser)
    await browser.until('document.querySelector(".timer-session.paused") !== null && !document.querySelector(".timer-session .timer-pause-resume").disabled','Paused and ready')
    await browser.until(`${row(renamed)}?.querySelector('[data-label="記録"]').textContent==='5m'`,'Backend actual updated')
    assert.equal((await api(`/tasks/${fresh.id}`)).status,'IN_PROGRESS')
    await pauseOrResumeTimer(browser)
    await browser.until('document.querySelector(".timer-session:not(.paused)") !== null && !document.querySelector(".timer-session .timer-stop").disabled','Resumed and ready')
    await setClock('2026-10-02T12:07:00Z');await browser.click('.timer-session .timer-stop')
    await browser.until('!document.querySelector(".timer-session")','Stopped')
    await browser.until(`${row(renamed)}?.querySelector('[data-label="記録"]').textContent==='7m'`,'Actual from Backend')
    assert.equal((await api(`/tasks/${fresh.id}`)).status,'IN_PROGRESS')
    assert.equal(await browser.evaluate(`${row(renamed)}.querySelector('.task-timer-always').getAttribute('aria-pressed')`),'false')
  })
  await t.test('Complete snapshots remain Backend-owned, completed Start disabled and revert returns NOT_STARTED', async () => {
    await clickRow(renamed,'.task-state')
    await browser.until(`${row(renamed)}?.querySelector('.task-status-trigger').textContent==='完了'`,'Completed')
    let value=await api(`/tasks/${fresh.id}`)
    assert(value.completedAt);assert.equal(value.completedEstimateMinutes,null)
    assert.equal(await browser.evaluate(`${row(renamed)}.querySelector('.task-timer-always').disabled`),true)
    await clickRow(renamed,'.task-state')
    await browser.until(`${row(renamed)}?.querySelector('.task-status-trigger').textContent==='未着手'`,'Reverted')
    value=await api(`/tasks/${fresh.id}`)
    assert.equal(value.status,'NOT_STARTED');assert.equal(value.completedAt,null);assert.equal(value.completedEstimateMinutes,null)
  })
  await t.test('history-protected deletion exposes the 409 and preserves Task, entries and ScheduleBlock', async () => {
    const before=await api(`/tasks/${history.id}`),entries=await api(`/tasks/${history.id}/time-entries`),reportsBefore=await reports()
    await clickRow(history.title,'[aria-label="タスクを削除"]')
    await browser.until('document.querySelector(".global-error")?.textContent.includes("記録履歴")','Delete 409')
    assert(await browser.evaluate(`${row(history.title)}.querySelector('.task-row-error').textContent.includes('記録履歴')`))
    assert.equal(requests.findLast(r=>r.method==='DELETE').status,409)
    assert.deepEqual(await api(`/tasks/${history.id}`),before)
    assert.deepEqual(await api(`/tasks/${history.id}/time-entries`),entries)
    assert((await api('/schedule-blocks')).some(b=>b.id===schedule.id))
    assert.deepEqual(await reports(),reportsBefore)
  })
  await t.test('search and Project filter compose with status without changing existing sort order', async () => {
    await status('IN_PROGRESS');await setInput('.task-search input','History')
    await browser.until('document.querySelectorAll(".task-list-panel .task-table-row").length===1','Search with status')
    assert.equal(await browser.evaluate('document.querySelector(".task-table-name strong").textContent'),history.title)
    await status('all');await setInput('.task-search input','')
    await browser.click('[data-filter="project"] > button')
    await browser.evaluate(`Array.from(document.querySelectorAll('.task-filter-popover label')).find(e=>e.textContent===${JSON.stringify(project.name)}).querySelector('input').click()`)
    await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
    await browser.until('document.querySelectorAll(".task-list-panel .task-table-row").length===1','Project filter')
    await browser.click('.task-clear-all')
    const expected=(await api('/tasks')).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.id-b.id).map(task=>String(task.id))
    await browser.until(`document.querySelectorAll('.task-table-row').length===${expected.length}`,'All rows restored')
    assert.deepEqual(await browser.evaluate('Array.from(document.querySelectorAll(".task-table-row")).map(row=>row.dataset.taskId)'),expected)
  })
  await t.test('four viewports preserve 8px action gaps, 40px hit areas, accessible labels and no page overflow', async () => {
    const long=await api('/tasks',{title:'Very long task title '.repeat(9),projectId:project.id})
    await tasks(true)
    for (const width of [1440,1024,768,375]) {
      await browser.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false})
      await browser.evaluate(`${row(long.title)}.querySelector('details').open=true;${row(long.title)}.querySelector('summary').scrollIntoView({block:'nearest',inline:'nearest'});undefined`)
      await browser.until(`(()=>{const r=${row(long.title)}.querySelector('.task-table-actions').getBoundingClientRect();return r.width>0 && r.left>=0 && r.right<=${width}})()`, 'Menu positioned inside viewport')
      const geometry=await browser.evaluate(`(()=>{const row=${row(long.title)},group=row.querySelector('.task-table-actions');return {gap:parseFloat(getComputedStyle(group).gap),buttons:Array.from(group.querySelectorAll('button')).map(e=>{const r=e.getBoundingClientRect();return {width:r.width,height:r.height,left:r.left,right:r.right,label:e.getAttribute('aria-label'),title:e.title}}),overflow:document.documentElement.scrollWidth>innerWidth,searchHeight:document.querySelector('.task-search').getBoundingClientRect().height}})()`)
      assert(geometry.gap>=8);assert.equal(geometry.overflow,false,`${width} page overflow`)
      for (const button of geometry.buttons) {assert(button.width>=32);assert(button.height>=32&&button.height<=40);assert(button.left>=0&&button.right<=width);assert(button.label&&button.title)}
      await screenshot('tasks-'+width)
      await clickRow(renamed,'.task-row-edit')
      await browser.click('.task-form .project-picker-trigger'); await browser.click('.task-form .project-picker-create')
      const rect=await browser.evaluate('(()=>{const r=document.querySelector(".task-composer").getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}})()')
      assert(rect.left>=0&&rect.right<=width&&rect.top>=0&&rect.bottom<=1000)
      await screenshot('task-form-'+width)
      await browser.click('.project-composer .icon-close'); await close()
    }
  })
  await t.test('keyboard create, edit and inline Project cancel restore focus and prevent unintended saves', async () => {
    await browser.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false})
    await browser.click('.task-list-tools .primary-action')
    assert.equal(await browser.evaluate('document.activeElement.name'),'title')
    await input('title','Keyboard Task')
    await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'})
    await browser.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13})
    await browser.until(`!document.querySelector('.task-composer') && Boolean(${row('Keyboard Task')})`,'Keyboard create')
    await clickRow('Keyboard Task','.task-row-edit')
    await browser.click('.task-form .project-picker-trigger'); await browser.click('.task-form .project-picker-create')
    await setInput('.project-composer [name=name]','Do not create')
    await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
    await browser.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
    await browser.until('!document.querySelector(".project-composer") && document.querySelector(".task-composer").open','Inline Escape')
    assert.equal((await api('/projects')).some(p=>p.name==='Do not create'),false)
    await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
    await browser.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
    await browser.until('!document.querySelector(".task-composer")','Task Escape')
    await clickRow('Keyboard Task','[aria-label="タスクを削除"]')
    await browser.until(`!(${row('Keyboard Task')})`,'History-free delete')
  })
  await t.test('empty API list gives a concise empty state and an accessible create action', async () => {
    emptyTasks=true
    await browser.navigate(true)
    await browser.until('document.querySelector(".icon-rail [aria-label=タスク]")','Navigation mounted')
    await browser.click('.icon-rail [aria-label="タスク"]')
    await browser.until('document.querySelector(".task-list-panel .empty-state")?.textContent.includes("Taskがありません")','Empty Tasks')
    assert.equal(await browser.evaluate('document.querySelectorAll(".task-table-row").length'),0)
    await browser.click('.task-list-heading .primary-action')
    await browser.until('document.querySelector(".task-composer[open]")','Empty state opens create')
    await close()
    emptyTasks=false
  })
  assert.deepEqual(errors, [], 'No browser crashes or forwarding failures')
})
