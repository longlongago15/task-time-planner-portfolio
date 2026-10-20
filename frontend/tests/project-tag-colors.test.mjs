import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { openBrowser } from './browser.mjs'
import { startMetadataBackend } from './metadata-backend.mjs'
import { getProjectColor, getTagColor } from '../src/identificationColors.ts'

test('44B-1 shared color controls save, reset and preserve Task drafts on isolated DB', { timeout: 240000 }, async t => {
  const { base, api } = await startMetadataBackend(t)
  const plain = await api('/projects', { name: 'Default project' })
  const browser = await openBrowser()
  t.after(() => browser.close())
  const errors = [], requests = []
  let failSave = false
  browser.listeners.push(message => {
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method !== 'Fetch.requestPaused') return
    const { request, requestId } = message.params
    void (async () => {
      if (request.method === 'OPTIONS') return browser.fulfill(requestId, {})
      const url = new URL(request.url)
      const record = { method: request.method, path: url.pathname, body: request.postData ? JSON.parse(request.postData) : null }
      requests.push(record)
      if (failSave && ['POST', 'PUT', 'PATCH'].includes(request.method)) return browser.fulfill(requestId, { detail: 'Controlled failure' }, 500)
      const response = await fetch(base + url.pathname + url.search, { method: request.method, ...(request.postData ? { headers: { 'Content-Type': 'application/json' }, body: request.postData } : {}) })
      record.status = response.status
      await browser.fulfill(requestId, await response.json(), response.status)
    })().catch(error => { if (!/Invalid [Ii]nterception|Invalid requestId/.test(error.message)) errors.push(String(error)) })
  })
  await browser.send('Fetch.enable', { patterns: [{ urlPattern: 'http://localhost:8000/*', requestStage: 'Request' }] })
  const input = (selector, value) => browser.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`)
  const textClick = (selector, value) => browser.evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(e=>e.textContent.trim()===${JSON.stringify(value)}).click()`)
  const preview = (scope = '') => browser.evaluate(`document.querySelector('${scope} .color-preview').dataset.color`)
  const custom = (scope, color) => input(`${scope} input[type=color]`, color)
  const shot = async name => {
    await mkdir('../docs/screenshots/step44b1', { recursive: true })
    const result = await browser.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    await writeFile(`../docs/screenshots/step44b1/${name}.png`, Buffer.from(result.data, 'base64'))
  }
  const projects = async () => { await browser.click('.icon-rail [aria-label="プロジェクト"]'); await browser.until('document.querySelector("[data-project-create]")', 'Projects ready') }
  const composer = async () => { await browser.click('[data-project-create]'); await browser.until('document.querySelector(".project-composer[open]")', 'Project Composer') }
  const saveProject = async () => { await browser.click('.project-form button[type=submit]'); await browser.until('!document.querySelector(".project-composer")', 'Project saved') }
  const edit = async id => {
    await browser.until(`document.querySelector('.project-card[data-project-id="${id}"] .project-menu-trigger')`, 'Project loaded')
    await browser.click(`.project-card[data-project-id="${id}"] .project-menu-trigger`)
    await browser.click('.project-menu-popup [data-action=edit]')
    await browser.until('document.querySelector(".project-composer[open]")', 'Edit Composer')
  }
  await browser.navigate()
  await browser.until('document.querySelector(".icon-rail")', 'Workspace ready')
  await projects()
  let colored, taskProject, tag, task

  await t.test('Preset selection, keyboard access, preview and cancel do not save', async () => {
    await composer(); await input('.project-form input[name=name]', 'Cancelled project')
    assert.equal(await browser.evaluate('document.querySelectorAll(".project-form .color-swatch").length'), 15)
    await browser.evaluate(`document.querySelector('.color-swatch[data-color="#568BC7"]').focus()`)
    for (const type of ['keyDown', 'keyUp']) await browser.send('Input.dispatchKeyEvent', { type, key: ' ', code: 'Space', windowsVirtualKeyCode: 32 })
    await browser.until(`document.querySelector('.color-swatch[data-color="#568BC7"]')?.getAttribute('aria-pressed')==='true'`, 'Keyboard preset selected')
    assert.equal(await preview('.project-form'), '#568BC7')
    assert.equal(await browser.evaluate('document.querySelector(".project-color-preview").textContent'), 'Cancelled project')
    assert(await browser.evaluate('!!document.querySelector(".project-color-preview svg")'))
    await shot('project-create')
    await textClick('.project-form .composer-footer button', 'キャンセル')
    assert.equal((await api('/projects')).length, 1)
  })

  await t.test('Project custom color, API normalization and failed save preserve the draft', async () => {
    await composer(); await input('.project-form input[name=name]', 'Colored project')
    await custom('.project-form', '#abc123')
    assert.equal(await preview('.project-form'), '#ABC123')
    failSave = true; await browser.click('.project-form button[type=submit]')
    await browser.until('document.querySelector(".project-form [role=alert]") && !document.querySelector(".project-form button[type=submit]").disabled', 'Failure remains editable')
    assert.equal(await preview('.project-form'), '#ABC123')
    failSave = false; await saveProject()
    colored = (await api('/projects')).find(p => p.name === 'Colored project')
    assert.equal(colored.color, '#ABC123')
    assert.equal(requests.findLast(r => r.method === 'POST' && r.path === '/projects').body.color, '#ABC123')
  })

  await t.test('Project edit cancel, preset save, reset and default preview after reload', async () => {
    await edit(colored.id); assert.equal(await preview('.project-form'), '#ABC123')
    await browser.click('.project-form [data-color="#A079BE"]'); await browser.click('.project-composer .icon-close')
    assert.equal((await api('/projects')).find(p => p.id === colored.id).color, '#ABC123')
    await edit(colored.id); await browser.click('.project-form [data-color="#A079BE"]'); await saveProject()
    assert.equal((await api('/projects')).find(p => p.id === colored.id).color, '#A079BE')
    await edit(colored.id); await browser.click('.project-form .color-reset')
    assert.equal(await preview('.project-form'), getProjectColor({ id: colored.id, color: null }))
    await saveProject(); assert.equal((await api('/projects')).find(p => p.id === colored.id).color, null)
    await browser.navigate(); await browser.until('document.querySelector(".icon-rail")', 'Reloaded'); await projects()
    await edit(colored.id); assert.equal(await preview('.project-form'), getProjectColor({ id: colored.id, color: null }))
    await browser.click('.project-composer .icon-close')
  })

  await t.test('Project creation without a color persists NULL', async () => {
    await composer(); await input('.project-form input[name=name]', 'No color'); await saveProject()
    assert.equal((await api('/projects')).find(p => p.name === 'No color').color, null)
  })

  await t.test('Project Settings uses the same picker, saves custom color and resets', async () => {
    await browser.click(`.project-card[data-project-id="${plain.id}"] .project-card-open`)
    await browser.click('.project-tabs button:nth-child(3)')
    assert.equal(await preview('.project-settings'), getProjectColor(plain))
    await custom('.project-settings', '#ffffff')
    assert(await browser.evaluate('document.querySelector(".project-settings .project-color-preview svg").style.filter.includes("drop-shadow")'))
    await custom('.project-settings', '#000000')
    await browser.click('.project-settings button[type=submit]')
    await browser.until('document.querySelector(".project-settings [role=status]")', 'Settings saved')
    assert.equal((await api('/projects')).find(p => p.id === plain.id).color, '#000000')
    await browser.click('.project-settings .color-reset'); await browser.click('.project-settings button[type=submit]')
    await browser.until('document.querySelector(".project-settings [role=status]")', 'Settings reset')
    assert.equal((await api('/projects')).find(p => p.id === plain.id).color, null)
    await shot('project-settings')
  })

  await t.test('ProjectPicker creates with color while preserving the Task name, estimate and deadline', async () => {
    await browser.click('.icon-rail [aria-label="タスク"]'); await browser.click('.task-list-heading .primary-action')
    await input('.task-form [name=title]', 'Preserved draft'); await input('.task-form [name=estimatedMinutes]', '45')
    await input('.task-form [name=deadline]', '2026/12/31')
    await browser.click('.task-form .project-picker-trigger'); await browser.click('.project-picker-create')
    await input('.project-form input[name=name]', 'Task-created project')
    await browser.click('.project-form [data-color="#529968"]'); await saveProject()
    taskProject = (await api('/projects')).find(p => p.name === 'Task-created project')
    assert.equal(taskProject.color, '#529968')
    assert.equal(await browser.evaluate('document.querySelector(".task-form [name=title]").value'), 'Preserved draft')
    assert.equal(await browser.evaluate('document.querySelector(".task-form [name=estimatedMinutes]").value'), '45')
    assert.equal(await browser.evaluate('document.querySelector(".task-form [name=deadline]").value'), '2026/12/31')
    await browser.until(`document.querySelector('.task-form [name=projectId]').value==='${taskProject.id}'`, 'New Project selected')
  })

  await t.test('Tag creation preview, custom color and auto-selection preserve Task draft', async () => {
    await browser.click('.task-form .tag-picker-trigger'); await browser.click('.tag-picker-create')
    await input('.tag-create-form input:not([type=color])', 'FE'); await custom('.tag-create-form', '#ffffff')
    assert.equal(await preview('.tag-create-form'), '#FFFFFF')
    assert.equal(await browser.evaluate('document.querySelector(".tag-create-form .color-preview .tag-chip").textContent'), 'FE')
    await shot('tag-create')
    await browser.click('.tag-create-actions .primary-action')
    await browser.until('!document.querySelector(".tag-create-form") && document.querySelector(".tag-picker-options input:checked")', 'Tag created and selected')
    tag = (await api('/tags')).find(p => p.name === 'FE')
    assert.equal(tag.color, '#FFFFFF')
    assert.equal(await browser.evaluate('document.querySelector(".task-form [name=title]").value'), 'Preserved draft')
    await browser.click('.task-form .tag-picker-trigger')
    await browser.click('.task-form button[type=submit]'); await browser.until('!document.querySelector(".task-editor-panel")', 'Task saved')
    task = (await api('/tasks')).find(p => p.title === 'Preserved draft')
    assert.equal(task.projectId, taskProject.id); assert.deepEqual(task.tags.map(p => p.id), [tag.id])
  })

  await t.test('Tag management rename plus color preserves Task links; cancel and reset work', async () => {
    await browser.click(`[data-task-id="${task.id}"] .tag-picker-trigger`); await browser.click('.tag-picker-manage')
    await browser.click('[aria-label="FEの名前を変更"]'); await input('[aria-label="新しいタグ名"]', 'Cancelled tag')
    await browser.click('.tag-management-edit [data-color="#568BC7"]')
    await textClick('.tag-management-actions button', 'キャンセル')
    assert.equal((await api('/tags')).find(p => p.id === tag.id).name, 'FE')
    await browser.click('[aria-label="FEの名前を変更"]'); await input('[aria-label="新しいタグ名"]', '基本情報')
    await browser.click('.tag-management-edit [data-color="#A079BE"]'); await textClick('.tag-management-actions button', '保存')
    await browser.until('!document.querySelector(".tag-management-edit")', 'Tag updated')
    assert.equal((await api('/tasks'))[0].tags[0].color, '#A079BE')
    assert.equal((await api('/tasks'))[0].tags[0].id, tag.id)
    await browser.click('[aria-label="基本情報の名前を変更"]'); await browser.click('.tag-management-edit .color-reset')
    assert.equal(await preview('.tag-management-edit'), getTagColor({ id: tag.id, color: null }))
    await shot('tag-edit'); await textClick('.tag-management-actions button', '保存')
    await browser.until('!document.querySelector(".tag-management-edit")', 'Tag reset')
    assert.equal((await api('/tags')).find(p => p.id === tag.id).color, null)
  })

  await t.test('Tag duplicate validation and cancel preserve draft without mutation', async () => {
    await textClick('.tag-picker-heading button', '戻る'); await browser.click('.tag-picker-create')
    await input('.tag-create-form input:not([type=color])', '基本情報'); await browser.click('.tag-create-form [data-color="#DC6262"]')
    await browser.click('.tag-create-actions .primary-action'); await browser.until('document.querySelector(".tag-picker-popup [role=alert]")', 'Duplicate rejected')
    assert.equal(await preview('.tag-create-form'), '#DC6262')
    assert.equal((await api('/tags')).length, 1)
    await textClick('.tag-create-actions button', 'キャンセル')
    await browser.click(`[data-task-id="${task.id}"] .tag-picker-trigger`)
  })

  await t.test('Global Timer ProjectPicker shares color creation without losing its typed Task title', async () => {
    await input('.timer-task-picker input', 'Timer draft remains')
    await browser.click('.global-top-timer .project-picker-trigger,.global-top-timer .timer-project-trigger')
    await browser.click('.project-picker-create'); await input('.project-form input[name=name]', 'Timer-created project')
    await custom('.project-form', '#ff00ff'); await saveProject()
    assert.equal((await api('/projects')).find(p => p.name === 'Timer-created project').color, '#FF00FF')
    assert.equal(await browser.evaluate('document.querySelector(".timer-task-picker input").value'), 'Timer draft remains')
    assert.equal((await api('/tasks/time/active')).running, false)
  })

  await t.test('Project list creation reuses ColorPicker and preserves default reset behavior', async () => {
    await browser.click('.icon-rail [aria-label="ホーム"]')
    await browser.click('.icon-rail [aria-label="プロジェクト"]'); await browser.until('document.querySelector("[data-project-create]")','Project list'); await browser.click('[data-project-create]')
    await input('.project-form input[name=name]', 'Home colored project')
    await browser.click('.project-composer [data-color="#CB729A"]')
    assert.equal(await preview('.project-composer'), '#CB729A')
    await browser.click('.project-form button[type=submit]')
    await browser.until('!document.querySelector(".project-form")', 'Home Project saved')
    assert.equal((await api('/projects')).find(p => p.name === 'Home colored project').color, '#CB729A')
  })

  await t.test('Tag rename alone preserves color; API failure retains name and custom color until save', async () => {
    await browser.click('.icon-rail [aria-label="タスク"]')
    await browser.click(`[data-task-id="${task.id}"] .tag-picker-trigger`); await browser.click('.tag-picker-manage')
    await browser.click('[aria-label="基本情報の名前を変更"]')
    await custom('.tag-management-edit', '#000000'); await input('[aria-label="新しいタグ名"]', 'Black tag')
    failSave = true; await textClick('.tag-management-actions button', '保存')
    await browser.until('document.querySelector(".tag-picker-popup [role=alert]") && !document.querySelector(".tag-management-actions button").disabled', 'Failed Tag save retains fields')
    assert.equal(await preview('.tag-management-edit'), '#000000')
    assert.equal(await browser.evaluate('document.querySelector("[aria-label=新しいタグ名]").value'), 'Black tag')
    failSave = false; await textClick('.tag-management-actions button', '保存')
    await browser.until('!document.querySelector(".tag-management-edit")', 'Tag saved')
    await browser.click('[aria-label="Black tagの名前を変更"]'); await input('[aria-label="新しいタグ名"]', 'Black renamed')
    await textClick('.tag-management-actions button', '保存'); await browser.until('!document.querySelector(".tag-management-edit")', 'Tag renamed')
    assert.equal((await api('/tags')).find(p => p.id === tag.id).color, '#000000')
    assert.equal(requests.findLast(r => r.method === 'PATCH' && r.path === `/tags/${tag.id}`).body.color, undefined)
    await browser.click(`[data-task-id="${task.id}"] .tag-picker-trigger`)
  })

  await t.test('Color controls stay within viewport at desktop, tablet and phone widths', async () => {
    await projects(); await edit(colored.id)
    for (const width of [1440, 768, 375]) {
      await browser.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false })
      assert(await browser.evaluate('Array.from(document.querySelectorAll(".project-composer .color-swatch,.project-composer input[type=color],.project-composer .color-preview")).every(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.width>0})'))
      assert.equal(await browser.evaluate('document.querySelector(".project-composer input[type=color]").getBoundingClientRect().width'), 32)
      await shot(`project-composer-${width}`)
    }
    await browser.click('.project-composer .icon-close')
  })
  assert.deepEqual(errors, [])
  await writeFile('../docs/step44b1-browser-requests.json', JSON.stringify(requests, null, 2))
})
