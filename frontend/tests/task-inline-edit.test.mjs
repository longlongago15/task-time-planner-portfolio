import { selectPriority } from './browser.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { openBrowser, selectProject } from './browser.mjs'
import { startMetadataBackend } from './metadata-backend.mjs'

test('43A-2 inline edits and shared Picker use guarded temporary Backend', { timeout: 240000 }, async t => {
  const { base, api } = await startMetadataBackend(t)
  const project = await api('/projects', { name: '既存プロジェクト' })
  const task = await api('/tasks', { title: '一覧編集', estimatedMinutes: 150, priority: 'MEDIUM', deadline: '2026-10-12', projectId: project.id })
  const protectedTask = await api('/tasks', { title: '履歴保護', projectId: project.id })
  await api('/tasks/time/start', { taskId: protectedTask.id }); await api('/tasks/time/stop', { taskId: protectedTask.id })
  const browser = await openBrowser()
  t.after(() => browser.close())
  const errors = [], requests = []
  let failProject = false, failTask = false, holdProject = false, releaseProject
  await browser.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' })
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{const D=Date;window.Date=class extends D{constructor(...a){super(...(a.length?a:['2026-10-07T03:00:00Z']));}static now(){return ${Date.parse('2026-10-07T03:00:00Z')};}};window.confirm=()=>true;})()` })
  browser.listeners.push(message => {
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warn', 'warning'].includes(message.params.type)) errors.push(message.params.args)
    if (message.method !== 'Fetch.requestPaused') return
    const { request, requestId } = message.params
    void (async () => {
      if (request.method === 'OPTIONS') return browser.fulfill(requestId, {})
      const url = new URL(request.url)
      requests.push({ method: request.method, path: url.pathname, payload: request.postData ? JSON.parse(request.postData) : null })
      if (url.pathname === '/projects' && request.method === 'POST') {
        if (failProject) return browser.fulfill(requestId, { detail: 'Controlled failure' }, 500)
        if (holdProject) { await browser.evaluate('window.__heldProject = true'); await new Promise(resolve => { releaseProject = resolve }) }
      }
      if (failTask && request.method === 'PUT') return browser.fulfill(requestId, { detail: 'Controlled failure' }, 500)
      const response = await fetch(base + url.pathname + url.search, { method: request.method, ...(request.postData ? { headers: { 'Content-Type': 'application/json' }, body: request.postData } : {}) })
      await browser.fulfill(requestId, await response.json(), response.status)
    })().catch(error => { if (!/Invalid InterceptionId|Invalid interceptionId|Invalid requestId/.test(error.message)) errors.push(String(error)) })
  })
  await browser.send('Fetch.enable', { patterns: [{ urlPattern: 'http://localhost:8000/*', requestStage: 'Request' }] })
  await browser.navigate()
  await browser.until('document.querySelector(".icon-rail")', 'Workspace loaded')
  await browser.click('.icon-rail [aria-label="タスク"]')
  const row = `[data-task-id="${task.id}"]`
  await browser.until(`document.querySelector('${row} .task-status-trigger')`, 'Task list ready')
  const input = async (selector, value) => browser.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.focus();Object.getOwnPropertyDescriptor(e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`)
  const key = async (name, code) => { await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: name, windowsVirtualKeyCode: code }); await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: code }) }
  const updated = () => api(`/tasks/${task.id}`)
  const editValue = async (selector, value, cancel = false) => {
    await browser.click(selector + ' button'); await input(selector + ' input', value); await key(cancel ? 'Escape' : 'Enter', cancel ? 27 : 13)
  }
  const openCreate = async selector => { await browser.click(selector); await browser.click('.project-picker-popup .project-picker-create'); await browser.until('document.querySelector(".project-composer[open]")', 'Project creation dialog') }
  const createProject = async name => { await input('.project-composer [name=name]', name); await browser.click('.project-composer [type=submit]'); await browser.until('!document.querySelector(".project-composer")', 'Project created') }

  await t.test('Status Picker requires explicit choices and does not start Timer', async () => {
    assert.equal(await browser.evaluate(`document.querySelector('${row} .task-status-trigger').tagName`), 'BUTTON')
    await browser.click(`${row} .task-status-trigger`)
    assert.equal((await updated()).status, 'NOT_STARTED')
    assert.equal(await browser.evaluate(`document.querySelectorAll('${row} .task-table-status [role=menuitemradio]').length`), 3)
    await browser.click(`${row} .task-table-status [data-value=IN_PROGRESS]`)
    await browser.until(`!document.querySelector('${row} .task-table-status [role=menu]') && !document.querySelector('${row} .task-status-trigger').disabled`, 'Status saved')
    assert.equal((await updated()).status, 'IN_PROGRESS'); assert.equal((await api('/tasks/time/active')).running, false)
  })
  await t.test('title Enter, blur, Escape, empty validation and failed save retain server state', async () => {
    await editValue(`${row} .task-table-name`, '編集後')
    await browser.until(`document.querySelector('${row} .task-table-name button')?.textContent==='編集後'`, 'Title Enter saved')
    await editValue(`${row} .task-table-name`, 'キャンセル', true); assert.equal((await updated()).title, '編集後')
    const before = requests.filter(r => r.method === 'PUT').length
    await editValue(`${row} .task-table-name`, '   ')
    await browser.until(`document.querySelector('${row} .task-title-input .inline-editor-error')`, 'Empty title validation')
    assert.equal(requests.filter(r => r.method === 'PUT').length, before)
    assert.equal(await browser.evaluate(`document.querySelector('${row} .task-table-name input').value`), '   ')
    assert.equal((await updated()).title, '編集後'); await key('Escape', 27)
    await browser.click(`${row} .task-table-name button`); await input(`${row} .task-table-name input`, 'Blur保存')
    await browser.evaluate(`document.querySelector('${row} .task-table-name input').blur()`)
    await browser.until(`document.querySelector('${row} .task-table-name button')?.textContent==='Blur保存'`, 'Blur saved')
    failTask = true; await editValue(`${row} .task-table-name`, '再試行')
    await browser.until(`document.querySelector('${row} .task-title-input .inline-editor-error')`, 'API error visible'); assert.equal((await updated()).title, 'Blur保存')
    failTask = false; await browser.evaluate(`document.querySelector('${row} .task-table-name input').focus()`); await key('Enter', 13)
    await browser.until(`document.querySelector('${row} .task-table-name button')?.textContent==='再試行'`, 'Title retry saved')
  })
  await t.test('priority, deadline setting and clearing persist using only metadata writes', async () => {
    await selectPriority(browser, row, 'HIGH'); await browser.until(`document.querySelector('${row} .task-status-trigger').disabled===false`, 'Priority saved')
    assert.equal((await updated()).priority, 'HIGH')
    await editValue(`${row} .task-period-input`, '2026/10/03')
    await browser.until(`document.querySelector('${row} .task-period-relative')?.textContent==='4\u65e5\u8d85\u904e'`, 'Overdue deadline saved')
    assert.equal((await updated()).deadline, '2026-10-03')
    assert.equal((await updated()).startDate, null)
    await editValue(`${row} .task-period-input`, '')
    await browser.until(`document.querySelector('${row} .task-period-dates')?.textContent===''`, 'Deadline cleared')
    assert.equal((await updated()).deadline, null)
    await selectPriority(browser, row, ''); await browser.until(`document.querySelector('${row} .task-status-trigger').disabled===false`, 'Priority cleared'); assert.equal((await updated()).priority, null)
  })
  for (const [value, expected] of [['120',120],['120m',120],['2h',120],['2h 30m',150],['2.5h',150],['30m',30],['',null]]) await t.test(`inline estimate ${value || 'blank'}`, async () => {
    await editValue(`${row} .task-inline-estimate`, value)
    await browser.until(`document.querySelector('${row} .task-inline-estimate button')`, 'Estimate saved')
    assert.equal((await updated()).estimatedMinutes, expected)
  })
  for (const value of ['0','-1h','abc','2:30']) await t.test(`invalid estimate ${value} makes no request`, async () => {
    const before = requests.filter(r => r.method === 'PUT').length
    await editValue(`${row} .task-inline-estimate`, value)
    await browser.until(`document.querySelector('${row} .task-inline-estimate .inline-editor-error')`, 'Invalid estimate shown')
    assert.equal(requests.filter(r => r.method === 'PUT').length, before); assert.equal((await updated()).estimatedMinutes, null)
    assert.equal(await browser.evaluate(`document.querySelector('${row} .task-inline-estimate input').value`), value)
    await key('Escape', 27)
  })
  await t.test('record is read only and inline Project can select existing, unassigned and create', async () => {
    assert.equal(await browser.evaluate(`document.querySelector('${row} [data-label="記録"]').querySelectorAll('input,button,select').length`), 0)
    await selectProject(browser, `${row} [name=projectId]`, ''); assert.equal((await updated()).projectId, null)
    await selectProject(browser, `${row} [name=projectId]`, project.id); assert.equal((await updated()).projectId, project.id)
    await openCreate(`${row} .project-picker-trigger`); await createProject('一覧から作成')
    await browser.until(`document.querySelector('${row} .project-picker-trigger')?.textContent.includes('一覧から作成')`, 'Inline project auto selected')
    assert.equal((await updated()).projectId, (await api('/projects')).find(p => p.name === '一覧から作成').id)
  })
  await t.test('Task creation keeps title, estimate, priority and deadline through Project creation and cancel', async () => {
    await browser.click('.task-list-heading .primary-action')
    await input('.task-form [name=title]', '入力保持'); await input('.task-form [name=estimatedMinutes]', '2h'); await selectPriority(browser, '.task-form', 'HIGH'); await input('.task-form [name=deadline]', '2026/10/12')
    await openCreate('.task-form .project-picker-trigger'); await input('.project-composer [name=name]', 'キャンセル'); await key('Escape',27)
    await browser.until('!document.querySelector(".project-composer") && document.querySelector(".task-composer[open]")', 'Nested cancel keeps Task editor')
    await openCreate('.task-form .project-picker-trigger'); await createProject('入力保持プロジェクト')
    assert.deepEqual(await browser.evaluate(`['title','estimatedMinutes','priority','deadline'].map(name=>document.querySelector('.task-form [name='+name+']').value)`), ['入力保持','2h','HIGH','2026/10/12'])
    await browser.click('.task-form [type=submit]'); await browser.until('!document.querySelector(".task-composer")', 'Task saved')
    const created = (await api('/tasks')).find(t => t.title === '入力保持')
    assert.equal(created.projectId, (await api('/projects')).find(p=>p.name==='入力保持プロジェクト').id); assert.equal(created.estimatedMinutes,120); assert.equal(created.priority,'HIGH'); assert.equal(created.deadline,'2026-10-12')
  })
  await t.test('Project API error and duplicate submission keep the Task draft and allow retry', async () => {
    await browser.click('.task-list-heading .primary-action'); await input('.task-form [name=title]','エラー時保持'); await openCreate('.task-form .project-picker-trigger')
    failProject=true; await input('.project-composer [name=name]','再試行プロジェクト'); await browser.click('.project-composer [type=submit]')
    await browser.until('document.querySelector(".project-form-error")', 'Project error'); assert.equal(await browser.evaluate('document.querySelector(".task-form [name=title]").value'),'エラー時保持')
    failProject=false; holdProject=true; const before=requests.filter(r=>r.path==='/projects'&&r.method==='POST').length
    await browser.click('.project-composer [type=submit]'); await browser.until('window.__heldProject', 'Project request held')
    await browser.evaluate('document.querySelector(".project-composer form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))'); await key('Escape',27)
    assert.equal(requests.filter(r=>r.path==='/projects'&&r.method==='POST').length,before+1); assert(await browser.evaluate('document.querySelector(".project-composer").open'))
    holdProject=false; releaseProject(); await browser.until('!document.querySelector(".project-composer")','Project retry saved'); await browser.click('.task-composer .icon-close')
  })
  await t.test('Kebab opens, closes outside and on Escape, shows created date and opens existing editor',async()=>{
    await browser.click(`${row} summary`); assert.match(await browser.evaluate(`document.querySelector('${row} .task-created-date').textContent`), /^作成 \d{4}\/\d{2}\/\d{2}$/)
    await key('Escape',27); assert.equal(await browser.evaluate(`document.querySelector('${row} details').open`),false)
    await browser.click(`${row} summary`); await browser.click('.task-counts'); assert.equal(await browser.evaluate(`document.querySelector('${row} details').open`),false)
    await browser.click(`${row} summary`); await browser.click(`${row} .task-row-edit`); await browser.until('document.querySelector(".task-composer[open]")','Existing editor opened')
    await openCreate('.task-form .project-picker-trigger'); await createProject('詳細から作成'); await browser.click('.task-form [type=submit]'); await browser.until('!document.querySelector(".task-composer")','Detail edit saved')
  })
  await t.test('Timer Cell starts Timer, conflicts do not switch, active Project creation keeps snapshots',async()=>{
    await browser.click(`${row} summary`); await browser.click(`${row} .task-timer-button`); await browser.until('document.querySelector(".global-top-timer.timer-session")','Timer started')
    const active=await api('/tasks/time/active'), entries=await api(`/tasks/${task.id}/time-entries`), before=requests.filter(r=>r.path==='/tasks/time/stop').length
    await browser.click(`[data-task-id="${protectedTask.id}"] summary`); await browser.click(`[data-task-id="${protectedTask.id}"] .task-timer-button`)
    await browser.until(`document.querySelector('[data-task-id="${protectedTask.id}"] .task-row-error')`, 'Timer conflict visible')
    assert.deepEqual(await api('/tasks/time/active'),active); assert.equal(requests.filter(r=>r.path==='/tasks/time/stop').length,before)
    await openCreate('.global-top-timer .timer-project-trigger'); await createProject('計測中作成')
    await browser.until('document.querySelector(".timer-project-name")?.textContent==="計測中作成"','Active project selected')
    assert.deepEqual(await api('/tasks/time/active'),active); assert.deepEqual(await api(`/tasks/${task.id}/time-entries`),entries)
    await browser.until('document.querySelector(".global-top-timer.timer-session") && document.querySelector(".global-top-timer .timer-stop")?.disabled===false','Active timer ready to stop')
    await browser.click('.global-top-timer .timer-stop'); await browser.until('!document.querySelector(".global-top-timer.timer-session")','Timer stopped')
  })
  await t.test('protected deletion is confirmed and returns 409 without destroying history',async()=>{
    const entries=await api(`/tasks/${protectedTask.id}/time-entries`)
    await browser.click(`[data-task-id="${protectedTask.id}"] summary`); await browser.click(`[data-task-id="${protectedTask.id}"] .task-row-icon`)
    await browser.until(`document.querySelector('[data-task-id="${protectedTask.id}"] .task-row-error')`,'Delete protected error')
    assert.deepEqual(await api(`/tasks/${protectedTask.id}/time-entries`),entries)
  })
  await t.test('Home Task and Calendar creation share Picker and keep entered fields',async()=>{
    await browser.click('.icon-rail [aria-label="ホーム"]'); await browser.until('document.querySelector(".unplanned-panel .home-add-trigger")','Home ready')
    await browser.click('.unplanned-panel .home-add-trigger'); await input('.task-form [name=title]','Home入力'); await input('.task-form [name=estimatedMinutes]','30m')
    await openCreate('.task-form .project-picker-trigger'); await createProject('Homeから作成'); assert.equal(await browser.evaluate('document.querySelector(".task-form [name=title]").value'),'Home入力')
    await browser.click('.task-form [type=submit]'); await browser.until('!document.querySelector(".task-composer")','Home task saved')
    await browser.until('document.querySelector("[data-drop-date]")','Calendar loaded')
    await browser.click('[data-drop-date]'); await browser.until('document.querySelector(".calendar-dialog.task-editor-panel[open] .task-form")','Calendar create')
    await input('.calendar-dialog [name=title]','Calendar入力'); await input('.calendar-dialog [name=estimatedMinutes]','2h 30m')
    await openCreate('.calendar-dialog .project-picker-trigger'); await createProject('Calendarから作成')
    assert.equal(await browser.evaluate('document.querySelector(".calendar-dialog [name=title]").value'),'Calendar入力'); assert.equal(await browser.evaluate('document.querySelector(".calendar-dialog [name=estimatedMinutes]").value'),'2h 30m')
    await browser.click('.calendar-dialog [type=submit]'); await browser.until('!document.querySelector(".calendar-dialog")','Calendar saved')
    const created=(await api('/tasks')).find(t=>t.title==='Calendar入力'); assert.equal(created.projectId,(await api('/projects')).find(p=>p.name==='Calendarから作成').id)
  })
  await t.test('idle Global Timer keeps query through creation and applies Project at start',async()=>{
    await input('.timer-task-picker input','Timer入力保持'); await openCreate('.global-top-timer .timer-project-trigger'); await createProject('Timer下書き')
    assert.equal(await browser.evaluate('document.querySelector(".timer-task-picker input").value'),'Timer入力保持')
    await browser.click('.global-top-timer .timer-play-button'); await browser.until('document.querySelector(".global-top-timer.timer-session") && document.querySelector(".global-top-timer .timer-stop")?.disabled===false','Draft timer started and ready to stop')
    const created=(await api('/tasks')).find(t=>t.title==='Timer入力保持'); assert.equal(created.projectId,(await api('/projects')).find(p=>p.name==='Timer下書き').id)
    await browser.click('.global-top-timer .timer-stop'); await browser.until('!document.querySelector(".global-top-timer.timer-session")','Timer stopped')
  })
  await t.test('Desktop Tablet and 375px cards preserve all editable fields and visible Picker',async()=>{
    await browser.click('.icon-rail [aria-label="タスク"]')
    await mkdir(new URL('../../docs/screenshots/step43a-2/',import.meta.url),{recursive:true})
    for(const width of [1440,768,375]){
      await browser.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false})
      assert.equal(await browser.evaluate('document.documentElement.scrollWidth>innerWidth'),false,`${width} overflow`)
      for(const selector of ['.task-status-trigger','.task-table-name button','.project-picker-trigger','.task-priority-pill','.task-period-input > button','.task-inline-estimate button','summary']) assert(await browser.evaluate(`document.querySelector('${row} ${selector}').getClientRects().length>0`))
      await browser.evaluate(`document.querySelector('${row} .project-picker-trigger').scrollIntoView({block:'center',inline:'nearest'}); undefined`)
      await browser.click(`${row} .project-picker-trigger`)
      const box=await browser.evaluate('(()=>{const r=document.querySelector(".project-picker-popup").getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}})()')
      assert(box.left>=0&&box.right<=width&&box.top>=0&&box.bottom<=1000,JSON.stringify(box))
      const shot=await browser.send('Page.captureScreenshot',{format:'png',fromSurface:true});await writeFile(new URL(`../../docs/screenshots/step43a-2/tasks-picker-${width}.png`,import.meta.url),Buffer.from(shot.data,'base64'));await key('Escape',27)
    }
    assert.equal(await browser.evaluate('Array.from(document.querySelectorAll("h1,h2,button,label,[aria-label]")).some(e=>/\\bProjects?\\b/.test(e.textContent+" "+(e.getAttribute("aria-label")||"")))'),false)
  })
  assert.deepEqual(errors,[])
})
