import { chooseTaskStatus, setTaskFilter } from './current-task-ui.mjs'
import { isolateScenarios } from './scenario-fixture.mjs'
import { selectPriority } from './browser.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { openBrowser, selectProject } from './browser.mjs'
import { startMetadataBackend } from './metadata-backend.mjs'

test('44A project detail shares task browsing, history and settings on isolated DB', { timeout: 180000 }, async t => {
  const { base, api, directory, python } = await startMetadataBackend(t)
  const main = await api('/projects', { name: '制作プロジェクト' })
  const other = await api('/projects', { name: '別プロジェクト' })
  const empty = await api('/projects', { name: '空のプロジェクト' })
  const tag = await api('/tags', { name: 'デザイン' })
  const alpha = await api('/tasks', { title: 'Alpha', projectId: main.id, estimatedMinutes: 90, priority: 'HIGH', deadline: '2026-10-07', tagIds: [tag.id] })
  const beta = await api('/tasks', { title: 'Beta', projectId: main.id, estimatedMinutes: null, priority: 'LOW' })
  const done = await api('/tasks', { title: 'Done', projectId: main.id })
  await api(`/tasks/${done.id}`, { status: 'COMPLETED' }, 'PUT')
  const moved = await api('/tasks', { title: '移動済みの記録', projectId: main.id })
  const historical = await api('/time-entries', { taskId: moved.id, startedAt: '2026-10-07T00:00:00Z', endedAt: '2026-10-07T02:00:00Z' })
  await api(`/tasks/${moved.id}`, { projectId: other.id }, 'PUT')
  await api('/time-entries', { taskId: moved.id, startedAt: '2026-10-06T00:00:00Z', endedAt: '2026-10-06T01:00:00Z' })
  await api('/schedule-blocks', { taskId: alpha.id, date: '2026-10-07', type: 'ALL_DAY' })
  await api('/schedule-blocks', { taskId: alpha.id, date: '2026-10-07', type: 'TIME_UNSET' })
  await api('/schedule-blocks', { taskId: done.id, date: '2026-10-08', type: 'TIME_UNSET' })
  const browser = await openBrowser()
  t.after(() => browser.close())
  const errors = [], requests = []
  let failRename = false, failSchedule = false, failRecords = false
  await browser.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' })
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{const D=Date;window.Date=class extends D{constructor(...a){super(...(a.length?a:['2026-10-07T03:00:00Z']));}static now(){return ${Date.parse('2026-10-07T03:00:00Z')};}};window.confirm=()=>true;})()` })
  browser.listeners.push(message => {
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method !== 'Fetch.requestPaused') return
    const { request, requestId } = message.params
    void (async () => {
      if (request.method === 'OPTIONS') return browser.fulfill(requestId, {})
      const url = new URL(request.url)
      const item = { method: request.method, path: url.pathname, body: request.postData ? JSON.parse(request.postData) : null }
      requests.push(item)
      if (failRename && request.method === 'PUT' && url.pathname.startsWith('/projects/')) { item.status = 500; return browser.fulfill(requestId, { detail: 'failed' }, 500) }
      if (failSchedule && url.pathname === '/schedule-blocks') { item.status = 500; return browser.fulfill(requestId, { detail: 'failed' }, 500) }
      if (failRecords && url.pathname.endsWith('/time-entries')) { item.status = 500; return browser.fulfill(requestId, { detail: 'failed' }, 500) }
      const response = await fetch(base + url.pathname + url.search, { method: request.method, ...(request.postData ? { headers: { 'Content-Type': 'application/json' }, body: request.postData } : {}) })
      item.status = response.status
      await browser.fulfill(requestId, await response.json(), response.status)
    })().catch(error => { if (!/Invalid [Ii]nterceptionId|Invalid requestId/.test(error.message)) errors.push(String(error)) })
  })
  await browser.send('Fetch.enable', { patterns: [{ urlPattern: 'http://localhost:8000/*', requestStage: 'Request' }] })
  const input = (selector, value) => browser.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`)
  const key = async (key, code) => { await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code }); await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code }) }
  const tab = index => browser.click(`.project-tabs button:nth-child(${index})`)
  const rows = () => browser.evaluate('[...document.querySelectorAll(".project-detail-panel .task-table-row")].map(e=>Number(e.dataset.taskId))')
  const hasRows = async expected => { await browser.until(`[...document.querySelectorAll('.project-detail-panel .task-table-row')].map(e=>Number(e.dataset.taskId)).sort((a,b)=>a-b).join(',')===${JSON.stringify([...expected].sort((a,b)=>a-b).join(','))}`, 'Project rows'); assert.deepEqual((await rows()).sort((a,b)=>a-b), [...expected].sort((a,b)=>a-b)) }
  const row = id => `.project-detail-panel .task-table-row[data-task-id="${id}"]`
  const tap = async selector => {
    const point = await browser.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);return {x,y,hit:e.contains(hit)||(hit?.closest('.project-card')===e.closest('.project-card')&&Boolean(hit?.closest('.project-card-open')))}})()`)
    assert(point.hit, `Click target obstructed: ${selector}`)
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  }
  const projectList = async () => { await browser.until('document.querySelector(".icon-rail")','Workspace ready'); await browser.click('.icon-rail [aria-label="プロジェクト"]'); await browser.until(`document.querySelector('.project-card[data-project-id="${main.id}"]')`, 'Projects ready') }
  const settle = async () => {
    for (let attempt=0; attempt<100; attempt++) {
      const count=requests.length
      await new Promise(resolve=>setTimeout(resolve,80))
      if(count===requests.length && requests.every(r=>r.status!==undefined)) return
    }
    assert.fail('Pending API requests')
  }
  const open = async id => { await projectList(); await browser.click(`.project-card[data-project-id="${id}"] .project-card-open`); await browser.until(`document.querySelector('.project-detail-panel[data-project-id="${id}"]')`, 'Detail ready') }
  const screenshot = async name => { const dir = new URL('../../docs/screenshots/step44a/', import.meta.url); await mkdir(dir, { recursive: true }); const shot = await browser.send('Page.captureScreenshot', { format: 'png', fromSurface: true }); await writeFile(new URL(name + '.png', dir), Buffer.from(shot.data, 'base64')) }
  await browser.navigate()
  await projectList()

  await isolateScenarios(t, { browser, directory, python,
    reset: async () => { failRename = failSchedule = failRecords = false },
    prepare: async name => {
      if (name.startsWith('shared Task Editor')) await api(`/tasks/${beta.id}`, { title: 'Beta\u6539\u540d', status: 'IN_PROGRESS', priority: 'MEDIUM', deadline: '2026-10-12', estimatedMinutes: 30, tagIds: [tag.id] }, 'PUT')
      if (name.startsWith('1440/768')) {
        await api(`/tasks/${beta.id}`, { projectId: other.id }, 'PUT')
        await api('/tasks', { title: '\u8a73\u7d30\u304b\u3089\u8ffd\u52a0', projectId: main.id })
      }
    }, ready: async name => { await projectList(); if (!name.startsWith('list has one') && !name.startsWith('schedule and history')) await open(main.id) },
  })
  await t.test('list has one heading, count, two bars, 133% consumption and a whole-card click target', async () => {
    assert.equal(await browser.evaluate('document.querySelectorAll(".app-main h1").length'), 1)
    assert.equal(await browser.evaluate('document.querySelector(".project-page-heading p").textContent'), '3件')
    const selector = `.project-card[data-project-id="${main.id}"]`
    assert.equal(await browser.evaluate(`document.querySelector('${selector} .time strong').textContent`), '133%')
    assert.equal(await browser.evaluate(`document.querySelector('${selector} .project-over-estimate').textContent`), '見積超過 +33%')
    assert.equal(await browser.evaluate(`document.querySelector('${selector} .time .progress-track > span').style.width`), '100%')
    assert.equal(await browser.evaluate(`document.querySelectorAll('${selector} > button').length`), 1)
    await tap(selector + ' .completion .progress-track')
    await browser.until(`document.querySelector('.project-detail-panel[data-project-id="${main.id}"]')`, 'Whole card opened from bar')
  })
  await t.test('three summary cards, scoped Filters and shared table omit project controls', async () => {
    await browser.until('document.querySelector(".project-summary-unplanned > strong").textContent==="1件"', 'Schedule summary')
    assert.equal(await browser.evaluate('document.querySelector(".project-summary .completion strong").textContent'), '33%')
    assert.equal(await browser.evaluate('document.querySelector(".project-summary .time strong").textContent'), '133%')
    assert.equal(await browser.evaluate('document.querySelectorAll(".project-summary .project-progress-item, .project-summary-unplanned").length'), 3)
    assert.equal(await browser.evaluate('document.querySelectorAll(".project-detail-panel .task-table-project, .project-detail-panel [data-filter=project]").length'), 0)
    assert.deepEqual(await browser.evaluate('[...document.querySelector(".task-table-header").children].map(e=>e.textContent)'), ['ステータス','タスク名','タグ','優先度','期限','見積もり','記録','⋮'])
    assert.equal(await browser.evaluate('document.querySelector(".task-filter-switch")'), null)
    await hasRows([alpha.id,beta.id,done.id])
    await setTaskFilter(browser, 'status', ['NOT_STARTED','IN_PROGRESS'])
    await hasRows([alpha.id,beta.id])
    await setTaskFilter(browser, 'placement', ['scheduled']); await hasRows([alpha.id])
    await setTaskFilter(browser, 'placement', ['unplanned']); await hasRows([beta.id])
    await setTaskFilter(browser, 'placement', []); await setTaskFilter(browser, 'status', ['COMPLETED']); await hasRows([done.id])
    await setTaskFilter(browser, 'status', []); await hasRows([alpha.id,beta.id,done.id])
  })
  await t.test('project search, tags, status, priority, deadline, clearing and shared sort compose', async () => {
    await input('.task-search input', '移動済み'); await hasRows([])
    await input('.task-search input', 'Beta'); await hasRows([beta.id]); await input('.task-search input','')
    for (const [category, label] of [['tag',tag.name],['priority','高'],['deadline','今日'],['status','未着手']]) await setTaskFilter(browser, category, [label])
    await hasRows([alpha.id]); await browser.click('.task-clear-all'); await hasRows([alpha.id,beta.id,done.id])
    await browser.click('[data-filter=sort] > button')
    assert.equal(await browser.evaluate('[...document.querySelectorAll(".task-filter-popover button")].some(e=>e.textContent==="プロジェクト")'), false)
    await browser.evaluate('[...document.querySelectorAll(".task-filter-popover button")].find(e=>e.textContent==="名前").click()')
    await browser.click('.task-sort-controls > button'); assert.deepEqual(await rows(),[alpha.id,beta.id,done.id])
  })
  await t.test('inline status, title, tags, priority, deadline and estimate use shared TaskRow', async () => {
    await chooseTaskStatus(browser, row(beta.id), 'IN_PROGRESS')
    await browser.until(`document.querySelector('${row(beta.id)} .task-status-trigger').textContent.includes('進行中') && !document.querySelector('${row(beta.id)} .task-status-trigger').disabled`, 'Status saved')
    await browser.click(row(beta.id)+' .task-table-name button'); await input(row(beta.id)+' .task-table-name input','Beta改名'); await key('Enter',13)
    await browser.until(`document.querySelector('${row(beta.id)} .task-table-name button')?.textContent==='Beta改名'`, 'Title saved')
    await browser.click(row(beta.id)+' .tag-picker-trigger')
    await browser.click('.tag-picker-popup .tag-picker-options input')
    await key('Escape',27)
    await browser.until(`!document.querySelector('${row(beta.id)} .task-status-trigger').disabled`, 'Tags saved')
    await selectPriority(browser, row(beta.id), 'MEDIUM')
    await browser.until(`!document.querySelector('${row(beta.id)} .task-status-trigger').disabled`, 'Priority saved')
    await browser.click(row(beta.id)+' .task-table-deadline button'); await input(row(beta.id)+' .task-deadline-editor input','2026/10/12'); await browser.evaluate(`document.querySelector('${row(beta.id)} .task-deadline-editor input').blur()`)
    await browser.until(`!document.querySelector('${row(beta.id)} .task-deadline-editor')`, 'Deadline saved')
    await browser.click(row(beta.id)+' .task-inline-estimate button'); await input(row(beta.id)+' .task-inline-estimate input','30'); await key('Enter',13)
    await browser.until(`document.querySelector('${row(beta.id)} .task-inline-estimate button')?.textContent==='30分'`, 'Estimate saved')
    const saved = await api(`/tasks/${beta.id}`)
    assert.equal(saved.status,'IN_PROGRESS'); assert.equal(saved.title,'Beta改名'); assert.equal(saved.priority,'MEDIUM'); assert.equal(saved.deadline,'2026-10-12'); assert.equal(saved.estimatedMinutes,30); assert.deepEqual(saved.tags.map(t=>t.id),[tag.id])
    assert.equal(await browser.evaluate(`document.querySelector('${row(beta.id)} [data-label="記録"]').querySelectorAll('button,input,select').length`),0)
    assert.equal((await api('/tasks/time/active')).running,false)
  })
  await t.test('shared Task Editor moves task out of current project and keeps historical attribution', async () => {
    await browser.until(`document.querySelector('${row(beta.id)} .task-row-menu summary')`, 'Reloaded Task actions ready')
    await browser.click(row(beta.id)+' .task-row-menu summary'); await browser.click(row(beta.id)+' .task-row-edit')
    await browser.until('document.querySelector(".task-editor-panel[open]")', 'Shared editor open')
    await selectProject(browser,'.task-form [name=projectId]',other.id)
    await browser.click('.task-form button[type=submit]'); await browser.until('!document.querySelector(".task-editor-panel")','Editor saved')
    await hasRows([alpha.id,done.id]); assert.equal((await api(`/tasks/${beta.id}`)).projectId,other.id)
    await browser.until('document.querySelector(".project-summary-unplanned > strong").textContent==="0件"','Summary updated')
    await tab(2); await browser.until('document.querySelector(".project-records [data-entry-id]")','Records ready')
    assert.deepEqual(await browser.evaluate('[...document.querySelectorAll(".project-records tbody tr")].map(e=>Number(e.dataset.entryId))'),[historical.id])
    assert.deepEqual(await browser.evaluate('[...document.querySelector(".project-records tbody tr").children].map(e=>e.textContent)'),['移動済みの記録','','09:00 - 11:00','2026/10/07','2時間','削除',''])
    assert.equal(await browser.evaluate('document.querySelectorAll(".project-records .kebab-button").length'),1)
    assert.equal(await browser.evaluate('document.querySelectorAll(".project-records input").length'),0)
  })
  await t.test('task creation preselects current project with shared picker and composer', async () => {
    await browser.click('.project-heading-actions .primary-action'); await browser.until('document.querySelector(".task-composer[open]")','Shared composer')
    assert.equal(await browser.evaluate('document.querySelector(".task-form [name=projectId]").value'),String(main.id))
    await input('.task-form [name=title]','詳細から追加'); await browser.click('.task-form button[type=submit]'); await browser.until('!document.querySelector(".task-composer")','Created')
    assert.equal((await api('/tasks')).find(t=>t.title==='詳細から追加').projectId,main.id)
  })
  await t.test('settings validation, API failure, rename synchronization and protected delete', async () => {
    await tab(3); const inputSelector='.project-settings input'
    const before=requests.filter(r=>r.method==='PUT'&&r.path.startsWith('/projects/')).length
    await input(inputSelector,'   '); await browser.click('.project-settings button[type=submit]'); await browser.until('document.querySelector(".project-settings [role=alert]")','Empty name')
    assert.equal(requests.filter(r=>r.method==='PUT'&&r.path.startsWith('/projects/')).length,before)
    failRename=true; await input(inputSelector,'変更名'); await browser.click('.project-settings button[type=submit]'); await browser.until('document.querySelector(".project-settings [role=alert]")?.textContent.includes("エラー")','Rename failure')
    assert.equal(await browser.evaluate(`document.querySelector('${inputSelector}').value`),'変更名'); assert.equal((await api('/projects')).find(p=>p.id===main.id).name,main.name)
    failRename=false; await browser.click('.project-settings button[type=submit]'); await browser.until('document.querySelector(".project-settings [role=status]")','Rename saved')
    assert.equal(await browser.evaluate('document.querySelector(".project-page-heading h1").textContent'),'変更名')
    assert.equal(await browser.evaluate('document.querySelector(".sidebar-project-list")'),null)
    await projectList(); await browser.until('document.querySelector(".projects-list-panel")?.textContent.includes("変更名")','Project list renamed'); await open(main.id); await tab(3)
    await browser.click('.project-danger-zone button'); await browser.until('document.querySelector(".project-action-error")?.textContent.includes("記録履歴")','Delete protected')
    assert.equal(requests.findLast(r=>r.method==='DELETE').status,409)
    assert.equal((await api(`/tasks/${moved.id}/time-entries`)).find(e=>e.id===historical.id).projectIdSnapshot,main.id)
    assert.equal(await browser.evaluate('document.querySelectorAll(".project-settings input:not([type=color])").length'),1)
  })
  await t.test('zero tasks/estimate summaries and history-free deletion', async () => {
    await open(empty.id); await browser.until('document.querySelector(".project-summary-unplanned > strong").textContent==="0件"','Empty summary')
    assert.equal(await browser.evaluate('document.querySelector(".project-summary .completion strong").textContent'),'0%')
    assert.equal(await browser.evaluate('document.querySelector(".project-summary .time .project-progress-text").textContent'),'0分 / 未設定')
    await tab(3); await browser.click('.project-danger-zone button'); await browser.until('document.querySelector(".projects-list-panel")','Deleted returns to list')
    assert.equal((await api('/projects')).some(p=>p.id===empty.id),false)
  })
  await t.test('schedule and history read failures show retry and avoid stale counts', async () => {
    await settle(); failSchedule=true; await open(main.id); await settle(); await browser.until('document.querySelector(".project-summary-unplanned [role=alert]")','Schedule failed')
    assert.equal(await browser.evaluate('document.querySelector(".project-summary-unplanned > strong").textContent'),'—')
    failSchedule=false; await browser.click('.project-summary-unplanned button'); await browser.until('!document.querySelector(".project-summary-unplanned [role=alert]")','Schedule retry')
    failRecords=true; await browser.navigate(true); await open(main.id); await tab(2); await browser.until('document.querySelector(".project-records [role=alert]")','Records failed')
    await settle(); await browser.until('document.querySelector(".project-records [role=alert] button")','Records failure settled')
    failRecords=false; await browser.click('.project-records button'); await browser.until('document.querySelector(".project-records [data-entry-id]")','Records retry')
  })
  await t.test('active entry remains read-only and tab changes preserve the running timer', async () => {
    await api('/tasks/time/start',{taskId:alpha.id})
    await browser.navigate(true); await open(main.id); await tab(2)
    await browser.until('document.querySelector(".project-records")?.textContent.includes("計測中")','Active record shown')
    const active=await api('/tasks/time/active')
    assert.equal(await browser.evaluate('document.querySelectorAll(".project-records tbody tr:has(.record-active) button,.project-records input").length'),0)
    await tab(3); await tab(1); await tab(2)
    assert.deepEqual(await api('/tasks/time/active'),active)
    assert.equal(await browser.evaluate('document.querySelectorAll(".timer-session").length'),1)
    await browser.click('.timer-session .timer-stop'); await browser.until('!document.querySelector(".timer-session")','Explicit timer stop')
    await settle()
  })
  await t.test('1440/768/375px real clicks, three summaries, local scrolling and operable tabs', async () => {
    for(const width of [1440,768,375]) {
      await browser.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false})
      await projectList(); await screenshot(`list-${width}`)
      assert.equal(await browser.evaluate('document.documentElement.scrollWidth>innerWidth'),false)
      await tap(`.project-card[data-project-id="${main.id}"] .project-card-open`)
      await browser.until('document.querySelector(".project-detail-panel")','Detail clicked')
      await browser.until('document.querySelector(".project-summary-unplanned > strong")?.textContent==="1件"','Summary ready')
      assert.equal(await browser.evaluate('document.querySelectorAll(".global-top-timer").length'),1)
      assert.equal(await browser.evaluate('document.documentElement.scrollWidth>innerWidth'),false)
      assert.equal(await browser.evaluate('getComputedStyle(document.querySelector(".project-summary")).gridTemplateColumns.split(" ").length'),width===1440?3:width===768?2:1)
      if(width===375) assert.equal(await browser.evaluate('document.querySelector(".task-table-row").getBoundingClientRect().width<375'),true)
      else if(width===768) assert.equal(await browser.evaluate('document.querySelector(".task-table-scroll").scrollWidth>document.querySelector(".task-table-scroll").clientWidth'),true)
      await screenshot(`detail-${width}`)
      await browser.evaluate('document.querySelector(".task-list-panel").scrollIntoView({block:"center"})'); await screenshot(`tasks-${width}`)
      await tap('.project-tabs button:nth-child(2)'); await screenshot(`records-${width}`)
      await tap('.project-tabs button:nth-child(3)'); await screenshot(`settings-${width}`)
      await tap('.project-tabs button:nth-child(1)')
      await tap('.project-heading-actions .project-menu-trigger'); await screenshot(`menu-${width}`)
      assert.equal(await browser.evaluate('document.querySelector(".project-menu-popup").getBoundingClientRect().right<=innerWidth'),true)
      await key('Escape',27)
    }
  })
  assert.deepEqual(errors,[])
  await writeFile(new URL('../../docs/step44a-browser-requests.json',import.meta.url),JSON.stringify(requests,null,2))
})
