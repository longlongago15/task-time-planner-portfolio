import { chooseTaskStatus } from './current-task-ui.mjs'
import { isolateScenarios } from './scenario-fixture.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { openBrowser } from './browser.mjs'

test('Projects UX uses existing Snapshot aggregates on a guarded temporary DB', { timeout: 240000 }, async t => {
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
  await setClock('2026-10-02T12:00:00Z')
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
  browser = await openBrowser()
  await browser.send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' })
  await browser.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(()=>{const OriginalDate=Date;window.__crudNow=${now};window.confirm=()=>true;window.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:[window.__crudNow]));}static now(){return window.__crudNow;}};})()`,
  })
  let failSave=false, holdSave=false, releaseSave, failDelete=false, holdRead=false, heldRead, staleProjects
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
      if(url.pathname==='/projects' && request.method==='GET' && holdRead) {
        holdRead=false;heldRead={requestId,item};await browser.evaluate('window.__projectReadHeld=true');return
      }
      if(url.pathname.startsWith('/projects') && ['POST','PUT'].includes(request.method)) {
        if(failSave){item.status=500;await browser.fulfill(requestId,{detail:'Controlled save failure'},500);return}
        if(holdSave){await browser.evaluate('window.__projectSaveHeld=true');await new Promise(resolve=>{releaseSave=resolve})}
      }
      if(failDelete && request.method==='DELETE' && url.pathname.startsWith('/projects/')) {
        item.status=500;await browser.fulfill(requestId,{detail:'Controlled delete failure'},500);return
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

  const reports = () => Promise.all([
    '/reports/daily?date=2026-10-02&timezone=UTC',
    '/reports/weekly?date=2026-10-02&timezone=UTC',
    '/reports/monthly?month=2026-10&timezone=UTC',
  ].map(route => api(route)))
  const card = id => `document.querySelector('.project-card[data-project-id="${id}"]')`
  const row = id => `document.querySelector('.task-table-row[data-task-id="${id}"]')`
  async function input(selector, value) {
    await browser.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(String(value))});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`)
  }
  const size = width => browser.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false})
  async function projects(reload=false) {
    if(reload) await browser.navigate(true)
    await browser.until('document.querySelector(".icon-rail [aria-label=プロジェクト]")','Global navigation mounted')
    await browser.click('.icon-rail [aria-label="プロジェクト"]')
    await browser.until('document.querySelector(".projects-list-panel")','Projects list')
    await settle()
  }
  async function settle() {
    for(let attempt=0;attempt<70;attempt++) {
      const count=requests.length
      await sleep(80)
      if(count===requests.length && requests.every(r=>r.status!==undefined)) return
    }
    assert.fail('Background requests did not settle')
  }
  async function clickCard(id, selector) {
    await browser.until(`Boolean(${card(id)})`, 'Project card rendered')
    if (selector.startsWith('[data-action')) await browser.evaluate(`${card(id)}.querySelector('.project-menu-trigger').click()`)
    await browser.until(`${card(id)}?.querySelector(${JSON.stringify(selector)})`,'Project action rendered')
    await browser.evaluate(`${card(id)}.querySelector(${JSON.stringify(selector)}).click()`)
  }
  async function detail(id) {
    await clickCard(id,'.project-card-open')
    await browser.until(`document.querySelector('.project-detail-panel[data-project-id="${id}"]')`,'Project details')
  }
  async function closeForm() {await browser.click('.project-composer .icon-close')}
  async function saveProject(name, waitForReads=true) {
    await input('.project-form input',name)
    await browser.click('.project-form button[type=submit]')
    await browser.until('!document.querySelector(".project-composer")','Project saved')
    if(waitForReads) await settle()
  }
  async function createProject(name) {
    await browser.click('[data-project-create]')
    await browser.until('document.querySelector(".project-composer[open]")','Project form')
    await saveProject(name)
    return (await api('/projects')).find(p=>p.name===name.trim())
  }
  async function addTask(title, estimate='') {
    await browser.click('.project-heading-actions .primary-action')
    await input('.task-form [name=title]',title)
    await input('.task-form [name=estimatedMinutes]',estimate)
    await browser.click('.task-form button[type=submit]')
    await browser.until('!document.querySelector(".task-composer")','Task added')
    await projects()
    const value=(await api('/tasks')).find(t=>t.title===title)
    await detail(value.projectId)
    return value
  }
  async function toggleTask(id, status) {
    const task = await api(`/tasks/${id}`)
    const project = (await api('/projects')).find(p => p.id === task.projectId)
    const completed = project.completedCount + Number(status === '完了') - Number(task.status === 'COMPLETED')
    const expected = `タスク進捗 ${completed} / ${project.taskCount} ${Math.round(completed / project.taskCount * 100)}%`
    await chooseTaskStatus(browser, row(id), status === '完了' ? 'COMPLETED' : 'NOT_STARTED')
    // Receiving a response does not mean React has rendered the updated aggregate yet.
    await browser.until(`document.querySelector('.project-summary [aria-label="タスク進捗"]')?.getAttribute('aria-valuetext')===${JSON.stringify(expected)}`, 'Updated completion aggregate rendered')
    await settle()
  }
  async function progress(id, where='card') {
    const scope=where==='card'?card(id):`document.querySelector('.project-detail-panel[data-project-id="${id}"]')`
    await browser.until(`${scope}?.querySelectorAll('[role=progressbar]').length===2`,'Project progress rendered')
    return browser.evaluate(`(()=>{const e=${scope};return Array.from(e.querySelectorAll('[role=progressbar]')).map(bar=>({label:bar.getAttribute('aria-label'),value:Number(bar.getAttribute('aria-valuenow')),min:bar.getAttribute('aria-valuemin'),max:bar.getAttribute('aria-valuemax'),text:bar.getAttribute('aria-valuetext'),width:parseFloat(bar.firstElementChild.style.width),color:getComputedStyle(bar.firstElementChild).backgroundColor}))})()`)
  }
  async function screenshot(name) {
    if(!process.env.PROJECT_VISUAL_OUTPUT) return
    const destination=path.resolve(process.env.PROJECT_VISUAL_OUTPUT)
    const relative=path.relative(path.resolve(tmpdir()),destination)
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
    const shot=await browser.send('Page.captureScreenshot',{format:'png',fromSurface:true})
    await writeFile(path.join(destination,name+'.png'),Buffer.from(shot.data,'base64'))
  }
  let main, estimated, unknown, moved, overflow, zero, disposable
  await browser.navigate();await projects()
  const scenarioNames = [
    'empty Projects', 'name-only Project', 'zero Tasks', 'detail Task add', 'partial,', 'Timer adds',
    'actual above', 'moving a Task', 'history-protected', 'rename synchronizes', 'Project create/edit',
    'history-free', 'Active Snapshot', 'four viewports', 'keyboard create/cancel',
  ]
  await isolateScenarios(t, { browser, directory, python,
    reset: async () => {
      failSave = holdSave = failDelete = holdRead = false
      releaseSave?.(); releaseSave = undefined
      if (heldRead) { const held = heldRead; heldRead = undefined; if (held.item.status === undefined) { held.item.status = 200; await browser.fulfill(held.requestId, await api('/projects')) } }
    },
    prepare: async name => {
      const index = scenarioNames.findIndex(prefix => name.startsWith(prefix))
      assert(index >= 0, `Missing independent fixture for ${name}`)
      await setClock('2026-10-02T12:00:00Z')
      if (index >= 2) main = await api('/projects', { name: index >= 10 ? 'Renamed Progress Project' : 'Progress Project' })
      if (index >= 4) {
        estimated = await api('/tasks', { title: 'Estimated Project Task', estimatedMinutes: 20, projectId: main.id })
        unknown = await api('/tasks', { title: 'Unknown Project Task', estimatedMinutes: null, projectId: main.id })
      }
      if (index >= 5) await api(`/tasks/${unknown.id}/complete`, { completed: true }, 'PATCH')
      if (index >= 6) {
        await setClock('2026-10-02T12:10:00Z')
        await api('/time-entries', { taskId: estimated.id, startedAt: '2026-10-02T12:00:00Z', endedAt: '2026-10-02T12:10:00Z' })
      }
      if (index >= 7) overflow = await api('/projects', { name: 'Over estimate' })
      if (index >= 8) {
        moved = await api('/projects', { name: 'Moved current membership' })
        await api(`/tasks/${estimated.id}`, { projectId: moved.id }, 'PUT')
        zero = await api('/projects', { name: 'All NULL estimates' })
        await api('/tasks', { title: 'Only NULL estimate', projectId: zero.id })
      }
      if (index >= 12) await setClock('2026-10-02T14:40:00Z')
    },
    ready: async name => { await size(1440); await projects(); if (/^(detail Task add|partial,)/.test(name)) await detail(main.id) },
  })
  await t.test('empty Projects has exactly one Create entry, shared Workspace Sidebar and four global destinations',async()=>{
    assert.equal(await browser.evaluate('document.querySelectorAll("[data-project-create]").length'),1)
    assert.equal(await browser.evaluate('document.querySelector(".projects-list-panel").textContent.includes("プロジェクトがありません")'),true)
    assert.equal(await browser.evaluate('document.querySelector(".app-sidebar")!==null'),true)
    assert.equal(await browser.evaluate('document.querySelectorAll(".sidebar-project-list button").length'),0)
    assert.deepEqual(await browser.evaluate('Array.from(document.querySelectorAll(".icon-rail button")).map(b=>b.getAttribute("aria-label"))'),['ホーム','タスク','プロジェクト','レポート'])
    await screenshot('projects-empty')
  })
  await t.test('name-only Project Create uses existing API and updates the list without reload',async()=>{
    await browser.click('[data-project-create]')
    assert.equal(await browser.evaluate('document.querySelectorAll(".project-form input:not([type=color])").length'),1)
    assert.equal(await browser.evaluate('document.activeElement.name'),'name')
    main=await (async()=>{await saveProject('  Progress Project  ');return (await api('/projects')).find(p=>p.name==='Progress Project')})()
    assert(main)
    assert.deepEqual(requests.findLast(r=>r.path==='/projects'&&r.method==='POST').payload,{name:'Progress Project'})
    assert.equal(await browser.evaluate(`Boolean(${card(main.id)})`),true)
    assert.equal(await browser.evaluate('document.querySelectorAll("[data-project-create]").length'),1)
  })
  await t.test('zero Tasks gives two zero-percent ARIA bars with no division by zero',async()=>{
    const bars=await progress(main.id)
    assert.equal(bars.length,2)
    assert.deepEqual(bars.map(b=>b.value),[0,0])
    assert.deepEqual(bars.map(b=>b.text),['完了タスク 0 / 0 0%','時間消費 0分 / 未設定'])
    for(const b of bars) {assert.equal(b.min,'0');assert.equal(b.max,'100');assert.equal(b.width,0)}
    assert.notEqual(bars[0].color,bars[1].color)
    await detail(main.id)
    assert.equal(await browser.evaluate('document.querySelector(".app-sidebar")!==null'),true)
    assert.deepEqual((await progress(main.id,'detail')).map(b=>b.value),bars.map(b=>b.value))
  })
  await t.test('detail Task add reuses the current Project and preserves NULL estimates',async()=>{
    estimated=await addTask('Estimated Project Task','20')
    unknown=await addTask('Unknown Project Task')
    assert.equal(estimated.projectId,main.id);assert.equal(unknown.projectId,main.id);assert.equal(unknown.estimatedMinutes,null)
    const value=(await api('/projects')).find(p=>p.id===main.id)
    assert.equal(value.taskCount,2);assert.equal(value.estimatedMinutes,20)
    assert.deepEqual((await progress(main.id,'detail')).map(b=>b.text),['タスク進捗 0 / 2 0%','時間消費 0分 / 20分 0%'])
    assert.equal(await browser.evaluate(`${row(unknown.id)}.querySelector('[data-label="見積もり"]').textContent`),'')
    assert.equal(await browser.evaluate(`${row(estimated.id)}.querySelector('.task-status-trigger').textContent`),'未着手')
  })
  await t.test('partial, all-completed and reverted completion progress use Backend counts',async()=>{
    await toggleTask(unknown.id,'完了')
    let bars=await progress(main.id,'detail')
    assert.equal(bars[0].value,50);assert.equal(bars[0].text,'タスク進捗 1 / 2 50%')
    await toggleTask(estimated.id,'完了')
    bars=await progress(main.id,'detail')
    assert.equal(bars[0].value,100);assert.equal(bars[0].text,'タスク進捗 2 / 2 100%')
    await toggleTask(estimated.id,'未着手')
    assert.equal((await progress(main.id,'detail'))[0].value,50)
    assert.equal((await api(`/tasks/${unknown.id}`)).completedEstimateMinutes,null)
    await projects()
    assert.equal((await progress(main.id))[0].value,50)
  })
  await t.test('Timer adds actual through Snapshot aggregate and does not use ScheduleBlock occupancy as the denominator',async()=>{
    await api('/schedule-blocks',{taskId:estimated.id,date:'2026-10-02',type:'TIMED',startTime:'12:00',durationMinutes:180})
    await detail(main.id)
    await browser.evaluate(`${row(estimated.id)}.querySelector('.task-timer-always').click()`)
    await browser.until('document.querySelector(".timer-session") && document.querySelector(".task-status-in_progress")','Timer started')
    await setClock('2026-10-02T12:10:00Z')
    await browser.click('.timer-session .timer-stop')
    await browser.until('!document.querySelector(".timer-session")','Stopped')
    await settle()
    await browser.until(`document.querySelector('.project-detail-panel[data-project-id="${main.id}"] [role=progressbar][aria-valuetext="時間消費 10分 / 20分 50%"]')`, 'Project actual refreshed after Stop')
    const bars=await progress(main.id,'detail')
    assert.equal(bars[1].text,'時間消費 10分 / 20分 50%');assert.equal(bars[1].value,50)
    assert.equal((await api('/projects')).find(p=>p.id===main.id).estimatedMinutes,20)
    assert.equal((await reports())[0].plannedOccupiedMinutes,180)
    assert.equal((await api(`/tasks/${estimated.id}/time-entries`))[0].projectIdSnapshot,main.id)
    await projects()
  })
  await t.test('actual above estimate clamps only the visual bar and leaves duration text and API values intact',async()=>{
    overflow=await api('/projects',{name:'Over estimate'})
    const task=await api('/tasks',{title:'Long measured task',estimatedMinutes:90,projectId:overflow.id})
    await api('/tasks/time/start',{taskId:task.id})
    await setClock('2026-10-02T14:40:00Z')
    await api('/tasks/time/stop',{taskId:task.id})
    await projects(true)
    const bars=await progress(overflow.id)
    assert.equal(bars[1].value,100);assert.equal(bars[1].width,100)
    assert.equal(bars[1].text,'時間消費 2時間30分 / 1時間30分 167%')
    assert.equal((await api('/projects')).find(p=>p.id===overflow.id).actualMinutes,150)
    await detail(overflow.id);assert.equal((await progress(overflow.id,'detail'))[1].width,100);await projects()
  })
  await t.test('moving a Task retains historical actual in its Snapshot Project with zero estimated denominator',async()=>{
    moved=await api('/projects',{name:'Moved current membership'})
    await api(`/tasks/${estimated.id}`,{projectId:moved.id},'PUT')
    await projects(true)
    const original=await progress(main.id),current=await progress(moved.id)
    assert.equal(original[1].text,'時間消費 10分 / 未設定');assert.equal(original[1].value,0)
    assert.equal(original[0].text,'完了タスク 1 / 1 100%')
    assert.equal(current[1].text,'時間消費 0分 / 20分 0%')
    assert.equal((await api(`/tasks/${estimated.id}/time-entries`))[0].projectIdSnapshot,main.id)
    zero=await api('/projects',{name:'All NULL estimates'})
    await api('/tasks',{title:'Only NULL estimate',projectId:zero.id})
    await projects(true)
    assert.equal((await progress(zero.id))[1].text,'時間消費 0分 / 未設定')
    assert.equal((await progress(zero.id))[1].value,0)
  })
  await t.test('history-protected Project DELETE shows the 409 by the card and preserves Tasks, entries and Reports',async()=>{
    const projectsBefore=await api('/projects'),tasksBefore=await api('/tasks'),entries=await api(`/tasks/${estimated.id}/time-entries`),reportsBefore=await reports()
    await clickCard(main.id,'[data-action=delete]')
    await browser.until(`${card(main.id)}?.querySelector('.project-action-error')?.textContent.includes('記録履歴')`,'Project card 409')
    assert.equal(requests.findLast(r=>r.method==='DELETE').status,409)
    assert.deepEqual(await api('/projects'),projectsBefore);assert.deepEqual(await api('/tasks'),tasksBefore)
    assert.deepEqual(await api(`/tasks/${estimated.id}/time-entries`),entries);assert.deepEqual(await reports(),reportsBefore)
    await detail(main.id)
    await browser.click('.project-detail-panel .project-menu-trigger'); await browser.click('.project-detail-panel [data-action=delete]')
    await browser.until('document.querySelector(".project-detail-panel .project-action-error")?.textContent.includes("記録履歴")','Detail 409')
    await projects()
  })
  await t.test('rename synchronizes list, Home and Task Project choices without reload; stale reads cannot undo it',async()=>{
    staleProjects=await api('/projects');holdRead=true
    await browser.evaluate('window.dispatchEvent(new Event("focus"))')
    await browser.until('window.__projectReadHeld===true','Old Project read held')
    await clickCard(main.id,'[data-action=edit]')
    await saveProject('Renamed Progress Project',false)
    heldRead.item.status=200;await browser.fulfill(heldRead.requestId,staleProjects)
    await settle()
    await sleep(100)
    assert.equal(await browser.evaluate(`${card(main.id)}.querySelector('strong').textContent`),'Renamed Progress Project')
    await browser.click('.icon-rail [aria-label="ホーム"]')
    await browser.until('document.querySelector(".home-workspace-nav")','Simplified Home Sidebar'); assert.equal(await browser.evaluate('document.querySelector(".sidebar-project-list")'),null)
    assert.equal(await browser.evaluate('Array.from(document.querySelectorAll(".home-projects-panel .sidebar-project-list button")).some(b=>b.textContent.trim()==="Progress Project")'),false)
    await browser.click('.icon-rail [aria-label="タスク"]')
    await browser.click('.task-list-tools .primary-action')
    await browser.click('.task-form .project-picker-trigger')
    assert.equal(await browser.evaluate('Array.from(document.querySelectorAll(".task-form .project-picker-popup [data-project-id]")).some(o=>o.textContent==="Renamed Progress Project")'),true)
    await browser.click('.task-composer .icon-close');await projects()
  })
  await t.test('Project create/edit validation and API errors stay inline, keep input and prevent double submission',async()=>{
    await browser.click('[data-project-create]')
    const before=requests.filter(r=>r.path==='/projects'&&r.method==='POST').length
    await input('.project-form input',' ')
    await browser.evaluate('document.querySelector(".project-form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))')
    await browser.until('document.querySelector(".project-form-error")?.textContent.includes("入力")','Project required')
    assert.equal(requests.filter(r=>r.path==='/projects'&&r.method==='POST').length,before)
    await input('.project-form input','Over estimate')
    await browser.click('.project-form button[type=submit]')
    await browser.until('document.querySelector(".project-form-error")?.textContent.includes("登録")','Duplicate name')
    assert.equal(requests.findLast(r=>r.path==='/projects'&&r.method==='POST').status,409)
    await input('.project-form input','Retry Created');failSave=true
    await browser.click('.project-form button[type=submit]')
    await browser.until('document.querySelector(".project-form-error")?.textContent.includes("エラー")','Project controlled failure')
    assert.equal(await browser.evaluate('document.querySelector(".project-form input").value'),'Retry Created')
    failSave=false;holdSave=true
    await browser.click('.project-form button[type=submit]')
    await browser.until('window.__projectSaveHeld===true','Project saving held')
    await browser.evaluate('document.querySelector(".project-form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));document.querySelector(".project-form").requestSubmit()')
    await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
    await browser.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
    assert.equal(await browser.evaluate('document.querySelector(".project-composer").open'),true)
    holdSave=false;releaseSave()
    await browser.until('!document.querySelector(".project-composer")','Single saved Project')
    assert.equal((await api('/projects')).filter(p=>p.name==='Retry Created').length,1)
    await settle()
    await clickCard(main.id,'[data-action=edit]')
    failSave=true;await input('.project-form input','Rename retry')
    await browser.click('.project-form button[type=submit]')
    await browser.until('document.querySelector(".project-form-error")?.textContent.includes("エラー")','Rename controlled failure')
    assert.equal((await api('/projects')).find(p=>p.id===main.id).name,'Renamed Progress Project')
    failSave=false
    await closeForm()
  })
  await t.test('history-free Project DELETE clears current membership without deleting Task or ScheduleBlock',async()=>{
    disposable=await createProject('Disposable Project')
    const task=await api('/tasks',{title:'Survives Project deletion',projectId:disposable.id})
    const block=await api('/schedule-blocks',{taskId:task.id,date:'2026-10-02',type:'TIME_UNSET'})
    await projects(true)
    failDelete=true;await clickCard(disposable.id,'[data-action=delete]')
    await browser.until(`${card(disposable.id)}?.querySelector('.project-action-error')?.textContent.includes('エラー')`,'Delete controlled failure')
    assert.equal((await api(`/tasks/${task.id}`)).projectId,disposable.id)
    failDelete=false;await detail(disposable.id)
    await browser.click('.project-detail-panel .project-menu-trigger'); await browser.click('.project-detail-panel [data-action=delete]')
    await browser.until('document.querySelector(".projects-list-panel")','Deleted selected Project returns to list')
    await browser.until(`!(${card(disposable.id)})`,'Project removed')
    assert.equal((await api(`/tasks/${task.id}`)).projectId,null)
    assert.equal((await api('/schedule-blocks')).some(b=>b.id===block.id),true)
    await browser.click('.icon-rail [aria-label="タスク"]')
    await browser.until(`Boolean(${row(task.id)})`,'Task survives')
    await browser.until(`${row(task.id)}?.querySelector('[data-label="プロジェクト"]').textContent==='未所属'`,'Task membership refreshed after Project deletion')
    assert.equal(await browser.evaluate(`${row(task.id)}.querySelector('[data-label="プロジェクト"]').textContent`),'未所属')
    await browser.click('.icon-rail [aria-label="ホーム"]')
    assert.equal(await browser.evaluate('document.querySelector(".sidebar-project-list")!==null'),false)
    await projects()
  })
  await t.test('Active Snapshot Project deletion remains protected after moving its Task and keeps the same Timer',async()=>{
    await api('/tasks/time/start',{taskId:estimated.id})
    await setClock('2026-10-02T14:45:00Z')
    await api(`/tasks/${estimated.id}`,{projectId:zero.id},'PUT')
    await projects(true)
    const active=await api('/tasks/time/active')
    assert.equal((await progress(moved.id))[0].text,'完了タスク 0 / 0 0%')
    assert.equal((await progress(moved.id))[1].text,'時間消費 5分 / 未設定')
    await clickCard(moved.id,'[data-action=delete]')
    await browser.until(`${card(moved.id)}?.querySelector('.project-action-error')?.textContent.includes('記録履歴')`,'Active Snapshot 409')
    assert.deepEqual(await api('/tasks/time/active'),active)
    assert.equal((await api(`/tasks/${estimated.id}`)).projectId,zero.id)
    await browser.click('.timer-session .timer-stop')
    await browser.until('!document.querySelector(".timer-session")','Stopped existing Timer')
    await settle()
  })
  await t.test('four viewports keep list/detail text and 32px Kebab actions inside the viewport with two accessible bars',async()=>{
    const long=await api('/projects',{name:'長いProject名'.repeat(8)})
    await api('/tasks',{title:'Long Project task',estimatedMinutes:720,projectId:long.id})
    await projects(true)
    for(const width of [1440,1024,768,375]) {
      await browser.until(`Boolean(${card(long.id)})`, 'Long project rendered')
      await size(width)
      assert.equal(await browser.evaluate('document.querySelector(".app-sidebar")!==null'),true)
      assert.equal(await browser.evaluate('document.querySelectorAll("[data-project-create]").length'),1)
      const data=await browser.evaluate(`(()=>{const e=${card(long.id)},a=e.querySelector('.project-menu');return {overflow:document.documentElement.scrollWidth>innerWidth,gap:24,elements:Array.from(e.querySelectorAll('.project-progress-text,.project-menu-trigger')).map(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,height:r.height,label:e.getAttribute('aria-label'),button:e.tagName==='BUTTON'}})}})()`)
      assert.equal(data.overflow,false,`${width} page overflow`);assert(data.gap>=8)
      for(const e of data.elements) {assert(e.left>=0&&e.right<=width);if(e.button){assert(e.height>=32);assert(e.label)}}
      const bars=await progress(long.id);assert.equal(bars.length,2)
      assert.equal(bars[1].text,'時間消費 0分 / 12時間 0%')
      await screenshot('projects-'+width)
      await detail(long.id)
      assert.equal(await browser.evaluate('document.documentElement.scrollWidth>innerWidth'),false)
      assert.equal(await browser.evaluate(`(()=>{const heading=document.querySelector('.project-page-heading h1').getBoundingClientRect(),actions=document.querySelector('.project-heading-actions').getBoundingClientRect();return heading.right<=actions.left+1 || heading.bottom<=actions.top+1})()`),true,`${width} heading must not overlap its action`)
      assert.equal((await progress(long.id,'detail')).length,2)
      await screenshot('project-detail-'+width)
      await browser.click('.project-detail-panel .project-menu-trigger'); await browser.click('.project-detail-panel [data-action=edit]')
      const rect=await browser.evaluate('(()=>{const r=document.querySelector(".project-composer").getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}})()')
      assert(rect.left>=0&&rect.right<=width&&rect.top>=0&&rect.bottom<=1000)
      assert.equal(await browser.evaluate('document.querySelector(".project-form input").getBoundingClientRect().width >= document.querySelector(".project-form").getBoundingClientRect().width - 1'),true,`${width} name field uses the form width`)
      await screenshot('project-form-'+width)
      await closeForm();await projects()
    }
  })
  await t.test('keyboard create/cancel, detail Back and global navigation remain operable',async()=>{
    await size(1440)
    await browser.click('[data-project-create]')
    await input('.project-form input','Keyboard Project')
    await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'})
    await browser.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13})
    await browser.until('!document.querySelector(".project-composer")','Keyboard saved')
    await settle()
    const project=(await api('/projects')).find(p=>p.name==='Keyboard Project')
    assert(project)
    await clickCard(project.id,'[data-action=edit]')
    await input('.project-form input','Cancelled rename')
    await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
    await browser.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
    await browser.until('!document.querySelector(".project-composer")','Keyboard cancelled')
    assert.equal((await api('/projects')).find(p=>p.id===project.id).name,'Keyboard Project')
    await detail(project.id)
    await browser.click('.project-back')
    await browser.until('document.querySelector(".projects-list-panel")','Detail Back')
    for(const destination of ['ホーム','タスク','プロジェクト','レポート']) await browser.click(`.icon-rail [aria-label="${destination}"]`)
    await browser.until('document.querySelector(".report-toolbar")','Reports navigation')
    await settle()
  })
  assert.deepEqual(errors,[],'No browser crashes, warnings or API forwarding errors')
})
