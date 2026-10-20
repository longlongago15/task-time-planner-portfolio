import { selectPriority } from './browser.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { openBrowser, selectProject, selectTimerTask, pauseOrResumeTimer } from './browser.mjs'
import { startMetadataBackend } from './metadata-backend.mjs'

// Use pointer input and hit testing: HTMLElement.click() can activate covered or
// clipped controls, which was not sufficient coverage for the reported bug.
async function pointerClick(browser, selector) {
  const encoded = JSON.stringify(selector)
  await browser.until(`document.querySelector(${encoded}) && !document.querySelector(${encoded}).disabled`, `Enabled: ${selector}`)
  await browser.evaluate(`document.querySelector(${encoded}).scrollIntoView({block:'center',inline:'nearest'})`)
  await browser.until(`(()=>{const e=document.querySelector(${encoded}),r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return r.width>0&&r.height>0&&x>=0&&x<innerWidth&&y>=0&&y<innerHeight&&e.contains(document.elementFromPoint(x,y))})()`, `Clickable: ${selector}`)
  const { x, y } = await browser.evaluate(`(()=>{const r=document.querySelector(${encoded}).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`)
  await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

test('43A-3D every Tag creation entry is reachable by pointer on an isolated DB', { timeout: 300000 }, async t => {
  const { base, api } = await startMetadataBackend(t)
  const project = await api('/projects', { name: '導線確認プロジェクト' })
  const task = await api('/tasks', { title: '共通編集の元タスク', projectId: project.id, priority: 'LOW', deadline: '2026-10-22', estimatedMinutes: 75 })
  const browser = await openBrowser()
  t.after(() => browser.close())
  const requests = [], errors = []
  let failCreate = false, failAssignment = false
  await browser.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' })
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{const D=Date;window.Date=class extends D{constructor(...a){super(...(a.length?a:['2026-10-07T03:00:00Z']));}static now(){return ${Date.parse('2026-10-07T03:00:00Z')};}};window.confirm=()=>true;})()` })
  browser.listeners.push(message => {
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method !== 'Fetch.requestPaused') return
    const { request, requestId } = message.params
    void (async () => {
      if (request.method === 'OPTIONS') return browser.fulfill(requestId, {})
      const url = new URL(request.url)
      const item = { method: request.method, path: url.pathname, payload: request.postData ? JSON.parse(request.postData) : null }
      requests.push(item)
      if (failCreate && request.method === 'POST' && url.pathname === '/tags') { item.status = 500; return browser.fulfill(requestId, { detail: 'Controlled failure' }, 500) }
      if (failAssignment && request.method === 'PUT' && url.pathname === `/tasks/${task.id}`) { item.status = 500; return browser.fulfill(requestId, { detail: 'Controlled assignment failure' }, 500) }
      const response = await fetch(base + url.pathname + url.search, { method: request.method, ...(request.postData ? { headers: { 'Content-Type': 'application/json' }, body: request.postData } : {}) })
      item.status = response.status
      await browser.fulfill(requestId, await response.json(), response.status)
    })().catch(error => { if (!/Invalid [Ii]nterception|Invalid requestId/.test(error.message)) errors.push(String(error)) })
  })
  await browser.send('Fetch.enable', { patterns: [{ urlPattern: 'http://localhost:8000/*', requestStage: 'Request' }] })
  const click = selector => pointerClick(browser, selector)
  const input = async (selector, value) => {
    await click(selector)
    // Real text input for creation/task titles; native setter covers date/select controls.
    if (await browser.evaluate(`document.querySelector(${JSON.stringify(selector)}).tagName==='INPUT' && ['text','search'].includes(document.querySelector(${JSON.stringify(selector)}).type)`)) {
      await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 })
      await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 })
      await browser.send('Input.insertText', { text: value })
    } else await browser.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`)
  }
  const escape = async () => {
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await browser.until('!document.querySelector(".tag-picker-popup")', 'Picker closed')
  }
  const shot = async name => {
    await mkdir('../docs/screenshots/step43a-3d', { recursive: true })
    const result = await browser.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    await writeFile(`../docs/screenshots/step43a-3d/${name}.png`, Buffer.from(result.data, 'base64'))
  }
  const reset = async view => {
    await browser.navigate(true)
    await browser.until('document.querySelector(".icon-rail") && document.querySelector(".global-top-timer .tag-picker-trigger")?.disabled===false', 'Workspace ready')
    if (await browser.evaluate('innerWidth<=980')) await click(`.mobile-nav button:nth-child(${view === 'ホーム' ? 1 : 2})`)
    else await click(`.icon-rail [aria-label="${view}"]`)
    if (view === 'ホーム') await browser.until('document.querySelector(".calendar-schedule-status") && !document.querySelector(".calendar-schedule-status [role=status]")', 'Calendar ready')
    else await browser.until(`document.querySelector('[data-task-id="${task.id}"]')`, 'Task list ready')
  }
  const openPicker = async selector => {
    await click(selector)
    await browser.until('document.querySelector(".tag-picker-popup input[type=search]")', 'Common Picker open')
  }
  const compose = async (name, artifact) => {
    await click('.tag-picker-create')
    await browser.until('document.querySelector(".tag-create-form input")', 'Composer inside Picker')
    await input('.tag-create-form input', name)
    if (artifact) await shot(`${artifact}-composer`)
    await click('.tag-create-form .primary-action')
  }
  const create = async (name, artifact) => {
    const before = requests.length
    await compose(name, artifact)
    await browser.until(`!document.querySelector('.tag-create-form') && document.querySelector('.tag-picker-popup')?.getAttribute('aria-busy')!=='true' && [...document.querySelectorAll('.tag-picker-options label')].some(e=>e.textContent===${JSON.stringify(name.trim())}&&e.querySelector('input').checked)`, 'Created Tag auto-selected; Picker recovers')
    assert.equal(requests.slice(before).filter(r => r.method === 'POST' && r.path === '/tags').length, 1)
    assert(requests.slice(before).some(r => r.method === 'POST' && r.path === '/tags' && r.status === 201 && r.payload.name === name.trim()))
    await shot(artifact)
    return (await api('/tags')).find(tag => tag.name === name.trim())
  }
  const fields = selector => browser.evaluate(`Object.fromEntries([...document.querySelectorAll(${JSON.stringify(selector + ' [name]')})].map(e=>[e.name,e.value]))`)
  const editorSetup = async title => {
    await browser.until('document.querySelector(".task-editor-panel [name=title]")', 'Common Editor open')
    await input('.task-editor-panel [name=title]', title)
    await selectProject(browser, '.task-editor-panel [name=projectId]', project.id)
    await selectPriority(browser, '.task-editor-panel', 'HIGH')
    await input('.task-editor-panel [name=deadline]', '2026-10-25')
    await input('.task-editor-panel [name=estimatedMinutes]', '2h 30m')
  }
  const saveEditor = async title => {
    await escape()
    await click('.task-editor-panel [type=submit]')
    await browser.until('!document.querySelector(".task-editor-panel")', 'Editor saved')
    return (await api('/tasks')).find(value => value.title === title)
  }
  await browser.navigate()

  await t.test('Task List Inline: empty catalog → FE creation → auto assignment → filter refresh', async () => {
    await reset('タスク')
    assert.deepEqual(await api('/tags'), [])
    await openPicker(`[data-task-id="${task.id}"] .tag-picker-trigger`)
    await shot('inline-before')
    await create('FE', 'inline-created')
    assert.deepEqual((await api(`/tasks/${task.id}`)).tags.map(tag => tag.name), ['FE'])
    await escape()
    await click('[data-filter=tag] > button')
    await browser.until('[...document.querySelectorAll("[data-filter=tag] label")].some(e=>e.textContent==="FE")', 'Created Tag in Filter')
    await click('[data-filter=tag] label input')
    await browser.until('document.querySelector(".task-counts")?.textContent==="1件中 1件を表示"', 'Tag filter works')
    await click('.task-clear-all')
  })

  for (const entry of [{ view: 'タスク', trigger: '.task-list-heading .primary-action', name: '新規タスク', tag: '一覧で作成', artifact: 'new-task' },
    { view: 'ホーム', trigger: '[aria-label="未配置タスクを作成"]', name: 'Home未配置タスク', tag: 'Homeで作成', artifact: 'home-inbox' }]) {
    await t.test(`${entry.name}: create Tag, preserve title/project/priority/deadline/estimate, save auto-selected Tag`, async () => {
      await reset(entry.view); await click(entry.trigger); await editorSetup(entry.name)
      const before = await fields('.task-editor-panel')
      await openPicker('.task-editor-panel .tag-picker-trigger')
      await create(entry.tag, entry.artifact)
      assert.deepEqual(await fields('.task-editor-panel'), before)
      const saved = await saveEditor(entry.name)
      assert.equal(saved.projectId, project.id); assert.equal(saved.priority, 'HIGH'); assert.equal(saved.deadline, '2026-10-25'); assert.equal(saved.estimatedMinutes, 150)
      assert.deepEqual(saved.tags.map(tag => tag.name), [entry.tag])
    })
  }

  await t.test('Timeline empty slot: create Tag and retain Task fields plus all Schedule inputs', async () => {
    await reset('ホーム')
    const selector = '[data-timed-drop-date="2026-10-07"]'
    await browser.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.closest('.calendar-grid-scroll').scrollTop=11*60*.9})()`)
    const point = await browser.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+40,y:r.top+11*60*.9+10}})()`)
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
    await browser.until('document.querySelector(".calendar-dialog[open] [name=title]")', 'Timeline Task create open')
    await input('.calendar-dialog [name=title]', 'Timelineで作成したTask')
    await selectProject(browser, '.calendar-dialog [name=projectId]', project.id)
    await input('.calendar-dialog [name=estimatedMinutes]', '3h')
    await input('.calendar-dialog [name=date]', '2026-10-09')
    await input('.calendar-dialog [name=startTime]', '15:00')
    await input('.calendar-dialog [name=durationMinutes]', '45m')
    const before = await fields('.calendar-dialog')
    await openPicker('.calendar-dialog .tag-picker-trigger')
    await create('Timelineで作成', 'timeline')
    assert.deepEqual(await fields('.calendar-dialog'), before)
    await escape(); assert(await browser.evaluate('document.querySelector(".calendar-dialog[open]")!==null'))
    await click('.calendar-dialog [type=submit]'); await browser.until('!document.querySelector(".calendar-dialog")', 'Timeline Task saved')
    const saved = (await api('/tasks')).find(value => value.title === 'Timelineで作成したTask')
    assert.equal(saved.projectId, project.id); assert.equal(saved.estimatedMinutes, 180)
    assert.deepEqual(saved.tags.map(tag => tag.name), ['Timelineで作成'])
    const block = (await api('/schedule-blocks')).find(value => value.taskId === saved.id)
    assert.equal(block.date, '2026-10-09'); assert.equal(block.startTime.slice(0, 5), '15:00'); assert.equal(block.durationMinutes, 45)
  })

  await t.test('Common Task Editor: ⋮ → details → create Tag; preserve status and existing selection', async () => {
    await reset('タスク')
    await click(`[data-task-id="${task.id}"] .task-row-menu summary`)
    await click(`[data-task-id="${task.id}"] .task-row-edit`)
    await editorSetup(task.title)
    await click('.task-editor-panel .task-status-trigger')
    await click('.task-editor-panel .task-status-field [data-value=IN_PROGRESS]')
    const before = await fields('.task-editor-panel')
    await openPicker('.task-editor-panel .tag-picker-trigger'); await create('共通編集で作成', 'task-editor')
    assert.deepEqual(await fields('.task-editor-panel'), before)
    const saved = await saveEditor(task.title)
    assert.equal(saved.status, 'IN_PROGRESS'); assert.equal(saved.priority, 'HIGH'); assert.equal(saved.estimatedMinutes, 150)
    assert.deepEqual(saved.tags.map(tag => tag.name).sort(), ['FE', '共通編集で作成'].sort())
  })

  await t.test('Global Timer draft: create Tag without erasing typed title or starting Timer', async () => {
    await reset('タスク')
    await click('.global-top-timer .timer-project-trigger')
    await click(`.global-top-timer .project-picker-popup [data-project-id="${project.id}"]`)
    await browser.until('!document.querySelector(".global-top-timer .project-picker-popup")', 'Timer draft Project selected')
    await input('.timer-task-picker input', '入力途中のタイマータスク')
    const active = await api('/tasks/time/active'), plans = await api('/schedule-blocks')
    const offset = requests.length
    await openPicker('.global-top-timer .tag-picker-trigger'); await create('Timer下書きで作成', 'timer-draft')
    assert.equal(await browser.evaluate('document.querySelector(".timer-task-picker input").value'), '入力途中のタイマータスク')
    assert.equal(await browser.evaluate('document.querySelector(".global-top-timer [name=projectId]").value'), String(project.id))
    assert.deepEqual(await api('/tasks/time/active'), active); assert.deepEqual(await api('/schedule-blocks'), plans)
    assert(!requests.slice(offset).some(r => /\/time\/(start|stop|pause|resume)$/.test(r.path)))
    await escape()
    // Starting later is an explicit, separate user action; it must consume the
    // preserved draft and the newly created/selected Tag.
    await click('.global-top-timer .timer-play-button')
    await browser.until('document.querySelector(".global-top-timer.timer-session")', 'Draft started explicitly')
    const created = await api(`/tasks/${(await api('/tasks/time/active')).taskId}`)
    assert.equal(created.title, '入力途中のタイマータスク'); assert.equal(created.projectId, project.id)
    assert.deepEqual(created.tags.map(tag => tag.name), ['Timer下書きで作成'])
    await click('.global-top-timer .timer-stop')
    await browser.until('!document.querySelector(".global-top-timer.timer-session") && document.querySelector(".global-top-timer .tag-picker-trigger")?.disabled===false', 'Draft Timer stopped')
  })

  for (const paused of [false, true]) await t.test(`Global Timer ${paused ? 'paused' : 'active'}: create Tag preserves canonical Timer/history/project Snapshot`, async () => {
    await reset('タスク'); await selectTimerTask(browser, task.id)
    await click('.global-top-timer .timer-play-button')
    await browser.until('document.querySelector(".global-top-timer.timer-session:not(.paused)")', 'Timer started')
    if (paused) await pauseOrResumeTimer(browser)
    const active = await api('/tasks/time/active'), history = await api(`/tasks/${task.id}/time-entries`), plans = await api('/schedule-blocks')
    const offset = requests.length
    await openPicker('.global-top-timer .tag-picker-trigger')
    const tag = `Timer${paused ? '停止中' : '計測中'}で作成`
    await create(tag, paused ? 'timer-paused' : 'timer-active')
    assert.deepEqual(await api('/tasks/time/active'), active); assert.deepEqual(await api(`/tasks/${task.id}/time-entries`), history); assert.deepEqual(await api('/schedule-blocks'), plans)
    assert.equal((await api(`/tasks/${task.id}`)).projectId, project.id)
    assert((await api(`/tasks/${task.id}`)).tags.some(value => value.name === tag))
    assert(!requests.slice(offset).some(r => /\/time\/(start|stop|pause|resume)$/.test(r.path)))
    await escape(); await click('.global-top-timer .timer-stop')
    await browser.until('!document.querySelector(".global-top-timer.timer-session") && document.querySelector(".global-top-timer .tag-picker-trigger")?.disabled===false', 'Timer stopped')
  })

  await t.test('Blank/duplicate/API failure remain inside Picker; cancel/retry/Enter retain parent draft', async () => {
    await reset('タスク'); await click('.task-list-heading .primary-action'); await editorSetup('失敗時も保持するTask')
    const before = await fields('.task-editor-panel')
    await openPicker('.task-editor-panel .tag-picker-trigger')
    const postCount = () => requests.filter(r => r.method === 'POST' && r.path === '/tags').length
    const count = postCount()
    await compose('   '); await browser.until('document.querySelector(".tag-picker-popup [role=alert]")?.textContent.includes("1〜255")', 'Empty name validation')
    assert.equal(postCount(), count)
    await input('.tag-create-form input', '  FE  '); await click('.tag-create-form .primary-action')
    await browser.until('document.querySelector(".tag-picker-popup [role=alert]")?.textContent.includes("同じタグ名")', 'Duplicate error')
    assert.equal((await api('/tags')).filter(tag => tag.name === 'FE').length, 1)
    failCreate = true; await input('.tag-create-form input', '通信失敗'); await click('.tag-create-form .primary-action')
    await browser.until('document.querySelector(".tag-picker-popup [role=alert]")?.textContent.includes("再試行")', 'API failure shown')
    assert.equal(await browser.evaluate('document.querySelector(".tag-create-form input").value'), '通信失敗')
    failCreate = false
    await click('.tag-create-actions .secondary-button')
    await browser.until('document.querySelector(".tag-picker-create") && !document.querySelector(".tag-create-form")', 'Cancel restores Picker')
    await click('.tag-picker-create'); await input('.tag-create-form input', '  再試行成功  ')
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await browser.until('!document.querySelector(".tag-create-form") && [...document.querySelectorAll(".tag-picker-options label")].some(e=>e.textContent==="再試行成功"&&e.querySelector("input").checked)', 'Enter creates only Tag')
    assert.deepEqual(await fields('.task-editor-panel'), before)
    assert(!(await api('/tasks')).some(value => value.title === '失敗時も保持するTask'))
    await escape(); await click('.task-editor-panel .icon-close')
  })

  await t.test('Search remains usable after creating a name outside the current search', async () => {
    await reset('タスク'); await openPicker(`[data-task-id="${task.id}"] .tag-picker-trigger`)
    await input('.tag-picker-popup input[type=search]', 'FE')
    await create('検索外の新しいタグ', 'search-recovery')
    await escape()
  })

  await t.test('Tag creation survives assignment failure; retry assigns it without a duplicate POST', async () => {
    await reset('タスク'); await openPicker(`[data-task-id="${task.id}"] .tag-picker-trigger`)
    const previous = await api(`/tasks/${task.id}`)
    failAssignment = true
    await compose('割当再試行のタグ')
    await browser.until('document.querySelector(".tag-picker-popup [role=alert]") && !document.querySelector(".tag-create-form") && document.querySelector(".tag-picker-popup")?.getAttribute("aria-busy")!=="true"', 'Assignment error remains in recovered Picker')
    assert.deepEqual((await api(`/tasks/${task.id}`)).tags, previous.tags)
    const tag = (await api('/tags')).find(value => value.name === '割当再試行のタグ')
    assert(tag)
    failAssignment = false
    await click(`.tag-picker-options label:has(input):nth-child(${await browser.evaluate('[...document.querySelectorAll(".tag-picker-options label")].findIndex(e=>e.textContent==="割当再試行のタグ")+1')}) input`)
    await browser.until('!document.querySelector(".tag-picker-popup [role=alert]") && document.querySelector(".tag-picker-popup")?.getAttribute("aria-busy")!=="true"', 'Assignment retry succeeds')
    assert((await api(`/tasks/${task.id}`)).tags.some(value => value.id === tag.id))
    assert.equal(requests.filter(r => r.method === 'POST' && r.path === '/tags' && r.payload.name === tag.name).length, 1)
    await escape()
  })

  await t.test('Pointer rename/delete, search/select/deselect and outside closure still work', async () => {
    await reset('タスク')
    const previous = (await api('/tasks')).length, history = await api(`/tasks/${task.id}/time-entries`), plans = await api('/schedule-blocks')
    await openPicker(`[data-task-id="${task.id}"] .tag-picker-trigger`); await click('.tag-picker-manage')
    await click('[aria-label="再試行成功の名前を変更"]'); await input('[aria-label="新しいタグ名"]', '  改名後のタグ  ')
    await click('.tag-management-actions .primary-action')
    await browser.until('document.querySelector("[aria-label=改名後のタグを削除]")', 'Rename reflected')
    await click('[aria-label="改名後のタグを削除"]')
    await browser.until('!document.querySelector("[aria-label=改名後のタグを削除]")', 'Delete reflected')
    assert(!(await api('/tags')).some(tag => ['再試行成功', '改名後のタグ'].includes(tag.name)))
    await click('.tag-picker-heading button')
    await input('.tag-picker-popup input[type=search]', 'FE')
    const checkbox = '.tag-picker-options label input'
    await click(checkbox); await browser.until('document.querySelector(".tag-picker-popup")?.getAttribute("aria-busy")!=="true" && !document.querySelector(".tag-picker-options input").checked', 'Deselected')
    await click(checkbox); await browser.until('document.querySelector(".tag-picker-popup")?.getAttribute("aria-busy")!=="true" && document.querySelector(".tag-picker-options input").checked', 'Selected')
    await click('.task-list-heading h1'); await browser.until('!document.querySelector(".tag-picker-popup")', 'Outside click closes')
    assert.equal((await api('/tasks')).length, previous); assert.deepEqual(await api(`/tasks/${task.id}/time-entries`), history); assert.deepEqual(await api('/schedule-blocks'), plans)
  })

  for (const width of [768, 375]) await t.test(`Picker composer can actually be clicked at ${width}px with a long catalog`, async () => {
    if (width === 768) for (let i = 0; i < 25; i++) await api('/tags', { name: `追加タグ${i}` })
    await browser.send('Emulation.setDeviceMetricsOverride', { width, height: 700, deviceScaleFactor: 1, mobile: false })
    await reset('タスク'); await click('.task-list-heading .primary-action'); await editorSetup(`幅${width}のTask`)
    const before = await fields('.task-editor-panel')
    await openPicker('.task-editor-panel .tag-picker-trigger'); await create(`幅${width}で作成`, `composer-${width}`)
    assert.deepEqual(await fields('.task-editor-panel'), before)
    assert(await browser.evaluate('(()=>{const r=document.querySelector(".tag-picker-popup").getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()'))
    await escape(); await click('.task-editor-panel .icon-close')
  })
  assert.deepEqual(errors, [])
  await writeFile('../docs/step43a-3d-browser-requests.json', JSON.stringify(requests, null, 2) + '\n')
})
