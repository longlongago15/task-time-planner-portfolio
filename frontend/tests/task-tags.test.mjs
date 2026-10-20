import { chooseTaskStatus } from './current-task-ui.mjs'
import { isolateScenarios } from './scenario-fixture.mjs'
import { selectPriority } from './browser.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { openBrowser, selectProject, selectTimerTask } from './browser.mjs'
import { startMetadataBackend } from './metadata-backend.mjs'
import { emptyFilters, selectTasks } from '../src/taskListModel.ts'

test('Tag filter ORs selected IDs and composes with existing filters', () => {
  const values = [1, 2, 3].map(id => ({ id, title: `Task ${id}`, status: 'NOT_STARTED', projectId: id === 2 ? 8 : null, projectName: null,
    estimatedMinutes: null, actualMinutes: 0, tags: id === 3 ? [] : [{ id, name: `Tag ${id}` }] }))
  const ids = filters => selectTasks(values, [], '2026-10-07', 'incomplete', '', filters, 'title', true).map(t => t.id)
  assert.deepEqual(ids({ ...emptyFilters(), tag: ['1', '2'] }), [1, 2])
  assert.deepEqual(ids({ ...emptyFilters(), tag: ['1', '2'], project: ['8'] }), [2])
  assert.deepEqual(ids({ ...emptyFilters(), tag: ['999'] }), [])
  assert.deepEqual(ids(emptyFilters()), [1, 2, 3])
})

test('43A-3B shared Tags and Task Editor operate on guarded temporary DB', { timeout: 300000 }, async t => {
  const { base, api, directory, python } = await startMetadataBackend(t)
  const project = await api('/projects', { name: 'タグ検証Project' })
  const tags = []
  for (const name of ['FE', 'AWS', 'Java', '復習']) tags.push(await api('/tags', { name }))
  const task = await api('/tasks', { title: 'タグ検証', projectId: project.id, estimatedMinutes: 150, priority: 'HIGH', deadline: '2026-10-12', tagIds: tags.map(tag => tag.id) })
  const empty = await api('/tasks', { title: 'タグなし' })
  const block = await api('/schedule-blocks', { taskId: task.id, date: '2026-10-07', type: 'TIMED', startTime: '09:00', durationMinutes: 60 })
  const browser = await openBrowser()
  t.after(() => browser.close())
  const errors = [], requests = []
  let failUpdate = false, failTags = false, failCreate = false
  await browser.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' })
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{const D=Date;window.Date=class extends D{constructor(...a){super(...(a.length?a:['2026-10-07T03:00:00Z']));}static now(){return ${Date.parse('2026-10-07T03:00:00Z')};}};window.confirm=()=>true;})()` })
  browser.listeners.push(message => {
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method !== 'Fetch.requestPaused') return
    const { request, requestId } = message.params
    void (async () => {
      if (request.method === 'OPTIONS') return browser.fulfill(requestId, {})
      const url = new URL(request.url)
      requests.push({ method: request.method, path: url.pathname, payload: request.postData ? JSON.parse(request.postData) : null })
      if (failUpdate && request.method === 'PUT' || failTags && request.method === 'GET' && url.pathname === '/tags' || failCreate && request.method === 'POST' && url.pathname === '/tags') return browser.fulfill(requestId, { detail: 'Controlled failure' }, 500)
      const response = await fetch(base + url.pathname + url.search, { method: request.method, ...(request.postData ? { headers: { 'Content-Type': 'application/json' }, body: request.postData } : {}) })
      await browser.fulfill(requestId, await response.json(), response.status)
    })().catch(error => { if (!/Invalid [Ii]nterception|Invalid requestId/.test(error.message)) errors.push(String(error)) })
  })
  await browser.send('Fetch.enable', { patterns: [{ urlPattern: 'http://localhost:8000/*', requestStage: 'Request' }] })
  const input = (selector, value) => browser.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`)
  const clickText = (selector, text) => browser.evaluate(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)throw new Error('Missing control');e.click();})()`)
  const escape = async () => { await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await browser.until('!document.querySelector(".tag-picker-popup")', 'Tag Picker closes') }
  const row = `[data-task-id="${task.id}"]`
  const openPicker = async selector => { await browser.click(selector); await browser.until('document.querySelector(".tag-picker-popup input[type=search]")', 'Tag Picker open') }
  const toggle = async name => {
    const checked = await browser.evaluate(`[...document.querySelectorAll('.tag-picker-options label')].find(e=>e.textContent===${JSON.stringify(name)}).querySelector('input').checked`)
    await clickText('.tag-picker-options label', name)
    await browser.until(`document.querySelector('.tag-picker-popup')?.getAttribute('aria-busy')!=='true' && ([...document.querySelectorAll('.tag-picker-options label')].find(e=>e.textContent===${JSON.stringify(name)})?.querySelector('input').checked!==${checked} || document.querySelector('.tag-picker-popup [role=alert]'))`, 'Tag assignment settled')
  }
  const createTag = async name => { await browser.click('.tag-picker-create'); await input('.tag-create-form input', name); await browser.click('.tag-create-form .primary-action') }
  const listReady = async () => { await browser.until('document.querySelector(".icon-rail")', 'Workspace ready'); await browser.click('.icon-rail [aria-label="タスク"]'); await browser.until(`document.querySelector('${row} .tag-chip')`, 'Task Tags loaded') }
  const closeEditor = async () => { await browser.click('.task-editor-panel .icon-close'); await browser.until('!document.querySelector(".task-editor-panel")', 'Editor closed') }
  const readyHome = () => browser.until('document.querySelector(".calendar-schedule-status") && !document.querySelector(".calendar-schedule-status [role=status]")', 'Calendar ready')
  const shot = async name => { await mkdir('../docs/screenshots/step43a-3b', { recursive: true }); const value = await browser.send('Page.captureScreenshot', { format: 'png', fromSurface: true }); await writeFile(`../docs/screenshots/step43a-3b/${name}.png`, Buffer.from(value.data, 'base64')) }
  await browser.navigate()
  await browser.until('document.querySelector(".icon-rail")', 'Workspace loaded')
  await listReady()

  await isolateScenarios(t, { browser, directory, python,
    reset: async () => { failUpdate = failTags = failCreate = false },
    prepare: async name => {
      if (name.startsWith('Inline save failure')) await api(`/tasks/${task.id}`, { tagIds: tags.slice(0, 2).map(tag => tag.id) }, 'PUT')
      if (name.startsWith('Timer reads existing')) await api(`/tasks/${task.id}`, { tagIds: tags.filter(tag => tag.name !== 'Java').map(tag => tag.id) }, 'PUT')
    }, ready: async name => {
      if (/^(Calendar creation|TIMED and|Blank Timer)/.test(name)) { await browser.until('document.querySelector(".icon-rail")', 'Workspace loaded'); await readyHome() }
      else if (name.startsWith('Project detail uses')) { await browser.until('document.querySelector(".icon-rail")', 'Workspace loaded'); await readyHome() }
      else await listReady()
    },
  })
  await t.test('Task list keeps ten columns and shows empty, multiple, overflow and full title', async () => {
    assert.equal(await browser.evaluate('document.querySelectorAll(".task-table-header > span").length'), 10)
    assert.equal(await browser.evaluate(`document.querySelector('[data-task-id="${empty.id}"] .tag-empty').textContent`), '')
    assert.equal(await browser.evaluate(`document.querySelectorAll('${row} .tag-chip:not(.tag-overflow)').length`), 1)
    assert.equal(await browser.evaluate(`document.querySelector('${row} .tag-overflow').textContent`), '+3件')
    assert.equal(await browser.evaluate(`document.querySelector('${row} .tag-chips').title.split(' / ').length`), 4)
    await shot('task-list')
  })
  await t.test('Common Picker searches, toggles multiple choices, closes with Escape and outside click', async () => {
    await openPicker(`${row} .tag-picker-trigger`)
    await input('.tag-picker-popup input[type=search]', 'FE')
    assert.deepEqual(await browser.evaluate('[...document.querySelectorAll(".tag-picker-options label")].map(e=>e.textContent)'), ['FE'])
    await input('.tag-picker-popup input[type=search]', '')
    await toggle('復習'); await toggle('Java')
    assert.equal((await api(`/tasks/${task.id}`)).tags.length, 2)
    await escape(); await browser.until('!document.querySelector(".tag-picker-popup")', 'Escape closes Picker')
    await openPicker(`${row} .tag-picker-trigger`); await browser.click('.task-list-heading h1')
    assert.equal(await browser.evaluate('document.querySelector(".tag-picker-popup")===null'), true)
  })
  await t.test('Inline save failure preserves server selection and displays Japanese retry error', async () => {
    const before = (await api(`/tasks/${task.id}`)).tags
    await openPicker(`${row} .tag-picker-trigger`); failUpdate = true; await toggle('Java')
    await browser.until('document.querySelector(".tag-picker-popup [role=alert]")', 'Failure shown')
    assert.deepEqual((await api(`/tasks/${task.id}`)).tags, before)
    assert.equal(await browser.evaluate('[...document.querySelectorAll(".tag-picker-options label")].find(e=>e.textContent==="Java").querySelector("input").checked'), false)
    failUpdate = false; await toggle('Java'); await escape()
  })
  await t.test('Explicit empty selection clears all tags and can restore multiple Tags', async () => {
    await openPicker(`${row} .tag-picker-trigger`); await clickText('.tag-picker-popup > button', 'タグをすべて解除')
    await browser.until(`document.querySelector('${row} .tag-empty')`, 'All Tags cleared')
    assert.deepEqual((await api(`/tasks/${task.id}`)).tags, [])
    for (const tag of tags) await toggle(tag.name)
    await escape()
  })
  await t.test('Tag Filter uses one popover, OR semantics, individual chips, category and all clear', async () => {
    await browser.click('[data-filter=tag] > button')
    await input('[data-filter=tag] input[type=search]', 'FE')
    assert.equal(await browser.evaluate('document.querySelectorAll("[data-filter=tag] label").length'), 1)
    await clickText('[data-filter=tag] label', 'FE')
    assert.equal(await browser.evaluate('document.querySelector(".task-counts").textContent'), '2件中 1件を表示')
    await input('[data-filter=tag] input[type=search]', '')
    await clickText('[data-filter=tag] label', 'AWS')
    assert.equal(await browser.evaluate('document.querySelectorAll(".task-applied-filters .task-filter-chip:not(.aggregate)").length'), 2)
    await browser.click('[aria-label="タグ：FEを解除"]')
    await clickText('[data-filter=tag] label', 'FE'); await clickText('[data-filter=tag] label', 'Java')
    assert.equal(await browser.evaluate('document.querySelectorAll(".task-applied-filters .task-filter-chip").length'), 3)
    assert.equal(await browser.evaluate('document.querySelectorAll(".tag-picker-popup").length'), 0)
    await shot('tag-filter')
    const outside = await browser.evaluate('(()=>{const r=document.querySelector(".task-list-heading h1").getBoundingClientRect();return {x:r.left+8,y:r.top+8}})()')
    for(const type of ['mousePressed','mouseReleased']) await browser.send('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...outside})
    await browser.until('!document.querySelector("[data-filter=tag] .task-filter-popover")', 'Outside pointer click closes Filter')
    await browser.click('[data-filter=tag] > button')
    await browser.until('document.querySelector("[data-filter=tag] .task-filter-popover")', 'Trigger reopens Filter')
    assert.deepEqual(await browser.evaluate('[...document.querySelectorAll("[data-filter=tag] label")].filter(e=>e.querySelector("input").checked).map(e=>e.textContent).sort()'), ['AWS','FE','Java'])
    assert.deepEqual(await browser.evaluate('[...document.querySelectorAll(".task-table-row")].map(e=>Number(e.dataset.taskId))'), [task.id])
    await clickText('[data-filter=tag] .task-filter-popover > button', 'この条件を解除')
    await clickText('[data-filter=tag] label', 'FE'); await browser.click('.task-clear-all')
    assert.equal(await browser.evaluate('document.querySelector(".task-applied-filters")'), null)
    await browser.click('.task-list-heading h1')
  })
  await t.test('New Tag trims, auto-selects and preserves all new Task fields; duplicate and API errors stay local', async () => {
    await browser.click('.task-list-heading .primary-action')
    await input('.task-editor-panel [name=title]', '新規タグ付きTask')
    await selectProject(browser, '.task-editor-panel [name=projectId]', project.id)
    await selectPriority(browser, '.task-editor-panel', 'MEDIUM'); await input('.task-editor-panel [name=deadline]', '2026-10-20'); await input('.task-editor-panel [name=estimatedMinutes]', '3h')
    await openPicker('.task-editor-panel .tag-picker-trigger'); await createTag('  新規  ')
    await browser.until('document.querySelector(".task-editor-panel .tag-chip")?.textContent==="新規"', 'Created Tag automatically selected')
    await createTag('新規'); await browser.until('document.querySelector(".tag-picker-popup [role=alert]")?.textContent.includes("同じタグ名")', 'Duplicate error')
    failCreate = true; await input('.tag-create-form input', 'API失敗'); await browser.click('.tag-create-form .primary-action')
    await browser.until('document.querySelector(".tag-picker-popup [role=alert]")?.textContent.includes("再試行")', 'Tag API failure')
    failCreate = false; await escape()
    assert.equal(await browser.evaluate('document.querySelector(".task-editor-panel [name=title]").value'), '新規タグ付きTask')
    await shot('new-task')
    await browser.click('.task-editor-panel [type=submit]'); await browser.until('!document.querySelector(".task-editor-panel")', 'Task created')
    const created = (await api('/tasks')).find(value => value.title === '新規タグ付きTask')
    assert.equal(created.projectId, project.id); assert.equal(created.estimatedMinutes, 180); assert.equal(created.priority, 'MEDIUM'); assert.equal(created.deadline, '2026-10-20')
    assert.deepEqual(created.tags.map(tag => tag.name), ['新規'])
  })
  await t.test('Task list detail opens common Editor with status and Tag; cancel and save preserve expected fields', async () => {
    await browser.click(`${row} .task-row-edit`)
    await browser.until('document.querySelector(".task-editor-panel .task-status-trigger")', 'Common editor')
    await openPicker('.task-editor-panel .tag-picker-trigger'); await toggle('Java'); await escape()
    await closeEditor(); assert.equal((await api(`/tasks/${task.id}`)).tags.length, 4)
    await browser.click(`${row} .task-row-edit`); await chooseTaskStatus(browser, '.task-editor-panel', 'IN_PROGRESS')
    await openPicker('.task-editor-panel .tag-picker-trigger'); await toggle('Java'); await escape()
    await browser.until('document.querySelector(".task-editor-panel [type=submit]")?.disabled===false', 'Editor save ready')
    await browser.click('.task-editor-panel [type=submit]'); await browser.until('!document.querySelector(".task-editor-panel")', 'Common editor saved')
    assert.equal((await api(`/tasks/${task.id}`)).status, 'IN_PROGRESS'); assert.equal((await api(`/tasks/${task.id}`)).tags.length, 3)
  })
  await t.test('Home creation and existing Task details use the same Editor and shared Tag/Project controls', async () => {
    await browser.click('.icon-rail [aria-label="ホーム"]'); await readyHome()
    await browser.click('[aria-label="未配置タスクを作成"]')
    await input('.task-editor-panel [name=title]', 'HomeタグTask')
    await openPicker('.task-editor-panel .tag-picker-trigger')
    assert(await browser.evaluate('[...document.querySelectorAll(".task-editor-panel .tag-picker-options input[type=checkbox]")].every(e=>{const r=e.getBoundingClientRect();return r.width===16&&r.height===16})'))
    await toggle('FE'); await escape()
    assert.equal(await browser.evaluate('getComputedStyle(document.querySelector(".task-editor-panel .tag-picker-trigger .tag-chip")).opacity'),'1')
    await browser.until('document.querySelector(".task-editor-panel [type=submit]")?.disabled===false', 'Home Task save ready')
    await browser.click('.task-editor-panel [type=submit]'); await browser.until('!document.querySelector(".task-editor-panel")', 'Home create saved')
    const home = (await api('/tasks')).find(value => value.title === 'HomeタグTask')
    assert.deepEqual(home.tags.map(tag => tag.name), ['FE'])
    await browser.until(`document.querySelector('[data-inbox-task-id="${home.id}"] .inbox-card-open')`, 'Home Task appears')
    assert(await browser.evaluate(`(()=>{const row=document.querySelector('[data-inbox-task-id="${home.id}"] .task-project-tags'),project=row.querySelector('.inbox-card-project'),tags=row.querySelector('.schedule-block-tag-icon');return !!tags&&row.querySelectorAll('[data-icon=tag]').length===1&&!row.querySelector('.tag-chips')&&!row.textContent.includes('FE')&&tags.getBoundingClientRect().left>=project.getBoundingClientRect().right})()`))
    await browser.click(`[data-inbox-task-id="${home.id}"] .inbox-card-open`)
    assert.equal(await browser.evaluate('document.querySelector("#task-detail")'),null)
    await browser.until('document.querySelector(".task-editor-panel .tag-chip")','Home Editor tags')
    assert.equal(await browser.evaluate('document.querySelector(".task-editor-panel .tag-chip").textContent'),'FE')
    await browser.until('document.querySelector(".task-editor-panel .task-status-trigger")', 'Home editor same component'); await closeEditor()
  })
  await t.test('Calendar creation selects Tags and schedule detail opens common Task Editor without changing placement', async () => {
    await readyHome()
    await browser.evaluate(`(()=>{const e=document.querySelector('[data-timed-drop-date="2026-10-07"]');const r=e.getBoundingClientRect();e.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:r.left+40,clientY:r.top+11*60*.9}));})()`)
    await browser.until('document.querySelector(".calendar-dialog[open] [name=title]")', 'Calendar create')
    await input('.calendar-dialog [name=title]', 'CalendarタグTask')
    await openPicker('.calendar-dialog .tag-picker-trigger'); await toggle('FE'); await escape()
    assert(await browser.evaluate('document.querySelector(".calendar-dialog[open]")!==null'))
    await shot('calendar-create')
    await browser.click('.calendar-dialog [type=submit]'); await browser.until('!document.querySelector(".calendar-dialog")', 'Calendar created')
    const created = (await api('/tasks')).find(value => value.title === 'CalendarタグTask')
    assert.deepEqual(created.tags.map(tag => tag.name), ['FE'])
    await readyHome(); await browser.click(`[data-schedule-block-id="${block.id}"]`)
    await browser.until('document.querySelector(".calendar-popover")', 'Schedule Popover')
    await clickText('.calendar-dialog-actions button', 'タスクを編集')
    await browser.until('document.querySelector(".task-editor-panel .task-status-trigger")', 'Schedule common editor')
    assert.equal(await browser.evaluate('document.querySelector(".task-editor-panel [name=title]").value'), task.title)
    assert.deepEqual((await api('/schedule-blocks')).find(value => value.id === block.id), block)
    await shot('schedule-task-editor'); await closeEditor()
  })
  await t.test('TIMED and TIME_UNSET keep Tag beside Project and Quick Detail Picker remains visible and usable', async () => {
    const unset = await api('/schedule-blocks', { taskId: task.id, date: '2026-10-08', type: 'TIME_UNSET' })
    await browser.navigate(true); await readyHome()
    for (const id of [block.id, unset.id]) {
      await browser.until(`document.querySelector('[data-schedule-block-id="${id}"] .task-project-tags .schedule-block-tag-icon')`, 'Project and Tag metadata rendered')
      assert(await browser.evaluate(`(()=>{const row=document.querySelector('[data-schedule-block-id="${id}"] .task-project-tags'),project=row.querySelector('.calendar-block-project'),tag=row.querySelector('.schedule-block-tag-icon');return tag.getBoundingClientRect().left>=project.getBoundingClientRect().right&&getComputedStyle(tag).position==='static'})()`))
    }
    await browser.click(`[data-schedule-block-id="${unset.id}"]`)
    await browser.until('document.querySelector(".task-detail .tag-picker-trigger .tag-chip")', 'Quick Detail Tag values')
    assert(await browser.evaluate('[...document.querySelectorAll(".task-detail .tag-picker-trigger .tag-chip")].every(e=>getComputedStyle(e).opacity==="1"&&e.getBoundingClientRect().width>0)'))
    await openPicker('.task-detail .tag-picker-trigger')
    assert(await browser.evaluate('[...document.querySelectorAll(".task-detail .tag-picker-options input[type=checkbox]")].every(e=>{const r=e.getBoundingClientRect();return r.width===16&&r.height===16})'))
    await toggle('Java'); await toggle('Java'); await escape()
    assert(await browser.evaluate('!!document.querySelector(".task-detail")'))
    await browser.click('.task-detail-close')
    await api(`/schedule-blocks/${unset.id}`, {}, 'DELETE')
  })
  await t.test('Project metadata shares exact colors and available width with a single adjacent Tag icon', async () => {
    const colored = await api('/projects', { name: 'こんにちは', color: '#368AD8' })
    const fixtures = [], schedules = []
    for (const [index, count] of [0, 1, 4].entries()) {
      for (const placed of [false, true]) {
        const value = await api('/tasks', { title: 'Metadata-' + count + '-' + placed, projectId: colored.id, tagIds: tags.slice(0, count).map(tag => tag.id) })
        fixtures.push(value)
        if (placed) schedules.push(await api('/schedule-blocks', { taskId: value.id, date: '2026-10-07', type: 'TIMED', startTime: (11 + index * 2) + ':00', durationMinutes: 60 }))
      }
    }
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false })
    await browser.navigate(true)
    await browser.until('document.querySelector(".icon-rail")', 'Workspace ready')
    await browser.click('.icon-rail [aria-label="ホーム"]'); await readyHome()
    await clickText('[aria-label="カレンダー表示"] button', '週')
    await browser.until('document.querySelector(".calendar-comparison-switch")', 'Week controls ready')
    await clickText('.calendar-comparison-switch button', '計画済みのみ')
    for (const value of fixtures) {
      const schedule = schedules.find(s => s.taskId === value.id)
      const selector = schedule ? '[data-schedule-block-id="' + schedule.id + '"]' : '[data-inbox-task-id="' + value.id + '"]'
      await browser.until('document.querySelector(' + JSON.stringify(selector + ' .task-project-name') + ')', 'Metadata ready')
      const result = await browser.evaluate('(()=>{const row=document.querySelector(' + JSON.stringify(selector + ' .task-project-tags') + '),name=row.querySelector(".task-project-name"),folder=row.querySelector("[data-icon=folder]"),tag=row.querySelector("[data-icon=tag]"),nr=name.getBoundingClientRect();return {name:name.textContent,color:getComputedStyle(name).color,folder:getComputedStyle(folder).color,tagCount:row.querySelectorAll("[data-icon=tag]").length,chips:row.querySelectorAll(".tag-chip,.tag-chips").length,fits:name.scrollWidth<=name.clientWidth,adjacent:!tag||(tag.getBoundingClientRect().left>=nr.right&&tag.getBoundingClientRect().left-nr.right<=8)}})()')
      assert.equal(result.name, 'こんにちは'); assert.equal(result.color, 'rgb(54, 138, 216)'); assert.equal(result.folder, result.color)
      assert.equal(result.tagCount, value.tags.length ? 1 : 0); assert.equal(result.chips, 0); assert(result.adjacent); assert(result.fits, 'Short Project fits the available metadata width')
      assert(await browser.evaluate('(()=>{const row=document.querySelector(' + JSON.stringify(selector + ' .task-project-tags') + '),name=row.querySelector(".task-project-name"),old=row.style.maxWidth;row.style.maxWidth="48px";const ok=name.scrollWidth>name.clientWidth&&getComputedStyle(name).textOverflow==="ellipsis"&&row.scrollWidth<=row.clientWidth;row.style.maxWidth=old;return ok})()'), 'Narrow metadata truncates without overflowing')
    }
    for (const schedule of schedules) await api('/schedule-blocks/' + schedule.id, {}, 'DELETE')
    for (const value of fixtures) await api('/tasks/' + value.id, {}, 'DELETE')
    await api('/projects/' + colored.id, {}, 'DELETE')
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false })
    await browser.navigate(true); await readyHome()
  })
  await t.test('Project detail uses common Task Editor without changing Project UI', async () => {
    await browser.click('.icon-rail [aria-label="プロジェクト"]')
    await browser.until('document.querySelector(".project-card")', 'Projects ready')
    await browser.click(`[data-project-id="${project.id}"] .project-card-open`)
    await browser.until(`document.querySelector('${row} .task-row-edit')`, 'Project detail Task')
    await browser.click(`${row} .task-row-edit`); await browser.until('document.querySelector(".task-editor-panel .task-status-trigger")', 'Project common Editor')
    await closeEditor()
  })
  await t.test('Timer reads existing Tags; active add/remove/create retains canonical timer and Project Snapshot', async () => {
    await selectTimerTask(browser, task.id)
    await openPicker('.global-top-timer .tag-picker-trigger')
    assert.equal(await browser.evaluate('document.querySelectorAll(".tag-picker-options input:checked").length'), 3)
    await escape(); await browser.click('.global-top-timer .timer-play-button')
    await browser.until('document.querySelector(".global-top-timer.timer-session:not(.paused)") && document.querySelector(".global-top-timer .timer-stop")?.disabled===false', 'Timer started and ready')
    const active = await api('/tasks/time/active'), history = await api(`/tasks/${task.id}/time-entries`), plans = await api('/schedule-blocks')
    await openPicker('.global-top-timer .tag-picker-trigger'); await toggle('Java'); await toggle('AWS')
    await createTag('Timer追加'); await browser.until('document.querySelector(".tag-picker-popup")?.getAttribute("aria-busy")!=="true" && !document.querySelector(".tag-create-form")', 'Active Tag created')
    await escape()
    assert.deepEqual(await api('/tasks/time/active'), active)
    assert.deepEqual(await api(`/tasks/${task.id}/time-entries`), history)
    assert.deepEqual(await api('/schedule-blocks'), plans)
    assert.equal((await api(`/tasks/${task.id}`)).tags.some(tag => tag.name === 'Timer追加'), true)
    assert.equal((await api(`/tasks/${task.id}`)).tags.some(tag => tag.name === 'AWS'), false)
    await shot('active-timer-tag')
    await browser.click('.global-top-timer .timer-stop')
    await browser.until('!document.querySelector(".global-top-timer.timer-session") && document.querySelector(".global-top-timer .tag-picker-trigger")?.disabled === false && document.querySelector(".global-top-timer .timer-play-button")?.disabled === false', 'Timer stopped and resynchronized')
    assert.deepEqual(await api('/tasks/time/active'), { taskId: null, running: false, startedAt: null })
  })
  await t.test('Blank Timer draft Tags are passed to placeholder Task creation', async () => {
    await openPicker('.global-top-timer .tag-picker-trigger'); await toggle('FE'); await escape()
    await browser.click('.global-top-timer .timer-play-button'); await browser.until('document.querySelector(".global-top-timer.timer-session") && document.querySelector(".global-top-timer .timer-stop")?.disabled===false', 'Placeholder timer started and ready to stop')
    const active = await api('/tasks/time/active'), created = await api(`/tasks/${active.taskId}`)
    assert.equal(created.title, '名称未設定'); assert.deepEqual(created.tags.map(tag => tag.name), ['FE'])
    await browser.click('.global-top-timer .timer-stop')
    await browser.until('!document.querySelector(".global-top-timer.timer-session") && document.querySelector(".global-top-timer .tag-picker-trigger")?.disabled === false && document.querySelector(".global-top-timer .timer-play-button")?.disabled === false', 'Placeholder stopped and resynchronized')
    assert.deepEqual(await api('/tasks/time/active'), { taskId: null, running: false, startedAt: null })
  })
  await t.test('Management rename and used Tag deletion refresh lists and filters while preserving Tasks and history', async () => {
    await listReady()
    const beforeHistory = await api(`/tasks/${task.id}/time-entries`), beforePlans = await api('/schedule-blocks'), beforeTasks = (await api('/tasks')).length
    await browser.click('[data-filter=tag] > button'); await clickText('[data-filter=tag] label', 'FE'); await browser.click('.task-list-heading h1')
    await openPicker(`${row} .tag-picker-trigger`); await browser.click('.tag-picker-manage')
    await browser.click('[aria-label="FEの名前を変更"]'); await input('[aria-label="新しいタグ名"]', '  FE改名  '); await clickText('.tag-management-row button', '保存')
    await browser.until('document.querySelector(".task-applied-filters")?.textContent.includes("FE改名")', 'Rename reaches applied filter')
    failTags = true
    await browser.click('[aria-label="FE改名を削除"]')
    await browser.until('!document.querySelector(".task-applied-filters")', 'Deleted filter cleared')
    await browser.until('document.querySelector(".tag-picker-popup [role=alert]")?.textContent.includes("取得")', 'Catalog refresh can fail after confirmed deletion')
    failTags = false; await clickText('.tag-picker-popup [role=alert] button', '再取得')
    await browser.until('!document.querySelector(".tag-picker-popup [role=alert]")', 'Catalog refresh retried')
    await escape()
    assert.equal((await api('/tasks')).length, beforeTasks)
    assert.deepEqual(await api(`/tasks/${task.id}/time-entries`), beforeHistory); assert.deepEqual(await api('/schedule-blocks'), beforePlans)
    assert.equal((await api(`/tasks/${task.id}`)).tags.some(tag => tag.id === tags[0].id), false)
  })
  await t.test('GET Tags failure leaves Task list and Timer usable with local retry', async () => {
    failTags = true; await browser.navigate(true); await listReady()
    await openPicker(`${row} .tag-picker-trigger`)
    await browser.until('document.querySelector(".tag-picker-popup [role=alert]")?.textContent.includes("取得")', 'Local catalog error')
    assert.equal(await browser.evaluate('document.querySelector(".global-top-timer .timer-play-button").disabled'), false)
    failTags = false; await clickText('.tag-picker-popup [role=alert] button', '再取得')
    await browser.until('!document.querySelector(".tag-picker-popup [role=alert]") && document.querySelectorAll(".tag-picker-options label").length>0', 'Tag retry succeeds'); await escape()
  })
  for (const width of [1600, 768, 375]) await t.test(`Common Editor and Tag Picker fit ${width}px without collapsing nine columns`, async () => {
    await browser.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false })
    await browser.click(`${row} .task-row-edit`); await openPicker('.task-editor-panel .tag-picker-trigger')
    await browser.until(`(()=>{const r=document.querySelector('.tag-picker-popup').getBoundingClientRect();return r.left>=0&&r.right<=${width}&&r.top>=0&&r.bottom<=1000})()`, 'Picker fits viewport')
    assert(await browser.evaluate(`(()=>{const r=document.querySelector('.task-editor-panel').getBoundingClientRect();return r.left>=0&&r.right<=${width}})()`))
    if (width > 680) assert(await browser.evaluate('document.querySelector(".task-table-header").getBoundingClientRect().width>=1088'))
    else assert.equal(await browser.evaluate('document.documentElement.scrollWidth>innerWidth'), false)
    await shot(`editor-${width}`); await escape(); assert(await browser.evaluate('document.querySelector(".task-editor-panel[open]")!==null')); await closeEditor()
  })
  assert.deepEqual(errors, [])
  assert(requests.some(request => request.method === 'PUT' && request.payload?.tagIds))
})
