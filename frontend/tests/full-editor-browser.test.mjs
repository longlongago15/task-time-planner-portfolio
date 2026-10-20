import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openBrowser } from './browser.mjs'

test('Full Editors share presentation while preserving caller save and input contracts (API mock only)', { timeout: 240000 }, async t => {
  const b = await openBrowser()
  t.after(() => b.close())
  const tags = [1, 2, 3].map(id => ({ id, name: 'Tag ' + id, color: '#368AD8' }))
  const projects = [1, 2].map(id => ({ id, name: 'Project ' + id, color: id === 1 ? '#368AD8' : '#DC6262' }))
  const original = id => ({ id, title: 'Task ' + id, projectId: id === 2 ? null : 1, projectName: id === 2 ? null : 'Project 1',
    tags: id === 1 ? tags : [], status: 'NOT_STARTED', completed: false, estimatedMinutes: id === 2 ? null : 60,
    actualMinutes: id === 1 ? 30 : 0, priority: id === 1 ? 'MEDIUM' : null, deadline: id === 1 ? '2026-10-12' : null, startDate: null })
  let tasks = [1, 2, 3].map(original), blocks = [], nextId = 10, rejectTask = false, rejectDelete = false, rejectEstimate = false
  let holdWrite = false, releaseWrite, heldWriteReady
  const writes = [], journal = [], errors = []
  const reset = () => { tasks = [1, 2, 3].map(original); blocks = []; rejectTask = rejectDelete = rejectEstimate = false }
  await b.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' })
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: "(()=>{const D=Date,n=Date.parse('2026-10-07T12:00:00+09:00');window.Date=class extends D{constructor(...a){super(...(a.length?a:[n]))}static now(){return n}};window.__confirmAnswer=true;window.__confirmCount=0;window.confirm=()=>{window.__confirmCount++;return window.__confirmAnswer}})()" })
  b.listeners.push(message => {
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method !== 'Fetch.requestPaused') return
    const { requestId, request } = message.params, url = new URL(request.url), p = url.pathname
    void (async () => {
      if (url.origin === b.url) return b.send('Fetch.continueRequest', { requestId })
      assert.equal(url.origin, 'http://localhost:8000', 'All external requests are intercepted')
      if (request.method === 'OPTIONS') return b.fulfill(requestId, {})
      if (request.method !== 'GET') {
        const body = request.postData ? JSON.parse(request.postData) : null
        writes.push({ method: request.method, path: p, body })
        if (holdWrite) { holdWrite = false; await new Promise(resolve => { releaseWrite = resolve; heldWriteReady?.(); heldWriteReady = undefined }) }
        if (/^\/tasks\/\d+$/.test(p)) {
          const id = Number(p.split('/')[2])
          if (request.method === 'DELETE') {
            if (rejectDelete) return b.fulfill(requestId, { detail: 'Fixture delete rejected' }, 500)
            tasks = tasks.filter(task => task.id !== id); return b.fulfill(requestId, { deleted: true })
          }
          assert.equal(request.method, 'PUT')
          if (rejectTask || (rejectEstimate && Object.keys(body).length === 1)) return b.fulfill(requestId, { detail: 'Fixture save rejected' }, 500)
          const task = tasks.find(task => task.id === id)
          Object.assign(task, body, { tags: body.tagIds ? body.tagIds.map(id => tags.find(tag => tag.id === id)) : task.tags })
          task.projectName = projects.find(project => project.id === task.projectId)?.name ?? null
          task.completed = task.status === 'COMPLETED'
          return b.fulfill(requestId, task)
        }
        if (p === '/tasks') {
          assert.equal(request.method, 'POST')
          if (rejectTask) return b.fulfill(requestId, { detail: 'Fixture create rejected' }, 500)
          const task = { ...original(nextId++), ...body, status: 'NOT_STARTED', actualMinutes: 0, tags: body.tagIds.map(id => tags.find(tag => tag.id === id)) }
          task.projectName = projects.find(project => project.id === task.projectId)?.name ?? null
          tasks.push(task); return b.fulfill(requestId, task)
        }
        if (p === '/schedule-blocks') {
          assert.equal(request.method, 'POST')
          const block = { id: blocks.length + 1, ...body, startTime: body.startTime ? body.startTime + ':00' : null }
          blocks.push(block); return b.fulfill(requestId, block)
        }
        throw new Error('Unexpected mutation ' + request.method + ' ' + p)
      }
      let data = []
      if (p === '/tasks') data = tasks
      else if (p === '/tasks/inbox') data = tasks.filter(task => !blocks.some(block => block.taskId === task.id))
      else if (/^\/tasks\/\d+$/.test(p)) data = tasks.find(task => task.id === Number(p.split('/')[2]))
      else if (p === '/projects') data = projects.map(project => ({ ...project, taskCount: tasks.filter(task => task.projectId === project.id).length, completedCount: 0, estimatedMinutes: 120, actualMinutes: 30 }))
      else if (p === '/tags') data = tags
      else if (p === '/tasks/time/active') data = { taskId: null, running: false, startedAt: null }
      else if (/^\/tasks\/\d+\/time-entries$/.test(p) && Number(p.split('/')[2]) === 1) data = [{ id: 1, taskId: 1, projectIdSnapshot: 1, startedAt: '2026-10-07T09:00:00+09:00', endedAt: '2026-10-07T09:30:00+09:00' }]
      else if (p === '/schedule-blocks') data = blocks.filter(block => (!url.searchParams.has('taskId') || block.taskId === Number(url.searchParams.get('taskId'))) && (!url.searchParams.has('startDate') || block.date >= url.searchParams.get('startDate')) && (!url.searchParams.has('endDate') || block.date <= url.searchParams.get('endDate')))
      else if (p === '/reports/daily') data = { date: url.searchParams.get('date'), tasks: [], plannedOccupiedMinutes: 0, dailyEstimatedMinutes: 0, dailyActualMinutes: 0, dailyDifference: 0 }
      await b.fulfill(requestId, data)
    })().catch(error => { if (!/Invalid .*nterception|Invalid requestId/.test(error.message)) errors.push(String(error)) })
  })
  await b.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
  const dialog = '.task-editor-panel[open]'
  const key = value => b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: value, code: value, windowsVirtualKeyCode: value === 'Enter' ? 13 : value === 'Tab' ? 9 : 27 })
  const input = (selector, value) => b.evaluate("(()=>{const e=document.querySelector(" + JSON.stringify(selector) + ");e.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e," + JSON.stringify(value) + ");e.dispatchEvent(new Event('input',{bubbles:true}));})()")
  const go = async (page, width = 1920) => {
    await b.send('Emulation.setDeviceMetricsOverride', { width, height: 1080, deviceScaleFactor: 1, mobile: false })
    await b.navigate()
    await b.until("document.querySelectorAll('.inbox-card-open').length===3", 'Mock workspace ready')
    if (page !== 'home') {
      await b.click('.icon-rail [aria-label="' + (page === 'tasks' ? '\u30bf\u30b9\u30af' : '\u30d7\u30ed\u30b8\u30a7\u30af\u30c8') + '"]')
      await b.until(page === 'tasks' ? "document.querySelector('.task-table-row')" : "document.querySelector('.project-card-open')", 'Destination ready')
      if (page === 'projectDetail') { await b.click('.project-card-open'); await b.until("document.querySelector('.project-detail-panel .task-table-row')", 'Project Tasks ready') }
    }
  }
  const open = async (page, id = 1, width = 1920) => {
    await go(page, width)
    const trigger = page === 'home' ? '[data-inbox-task-id="' + id + '"] .inbox-card-open' : '[data-task-id="' + id + '"] .task-row-edit'
    if (page !== 'home') await b.click('[data-task-id="' + id + '"] .task-row-menu summary')
    const anchor = page === 'home' ? trigger : '[data-task-id="' + id + '"] .task-row-menu summary'
    await b.until('(()=>{const a=document.querySelector(' + JSON.stringify(anchor) + '),e=document.querySelector(' + JSON.stringify(trigger) + ');if(!a||!e||e.disabled)return false;a.focus();e.click();return true})()', 'Enabled Editor launcher')
    await b.until("document.querySelector('.task-editor-panel[open]')", 'Full Editor ready')
    await b.until("document.querySelector('.task-time-summary') && !document.querySelector('.task-time-summary').textContent.includes('\\u8aad\\u8fbc\\u4e2d')", 'Time data ready')
    return anchor
  }
  const close = async () => { await b.until("document.querySelector('.task-editor-panel .icon-close')?.disabled===false", 'Close enabled after pending operation'); await b.click(dialog + ' .icon-close'); await b.until("!document.querySelector('.task-editor-panel[open]')", 'Editor closed') }
  const footer = async () => { await b.click(dialog + ' .composer-footer [type=submit]'); await b.until("!document.querySelector('.task-editor-panel[open]')", 'Footer saved') }
  const status = async value => {
    if (await b.evaluate("!!document.querySelector('.task-editor-panel .task-status-trigger')")) {
      await b.click(dialog + ' .task-status-trigger'); await b.click(dialog + ' [data-value="' + value + '"]')
    } else {
      await b.evaluate("(()=>{const e=document.querySelector('.task-editor-panel select[name=status]');e.value=" + JSON.stringify(value) + ";e.dispatchEvent(new Event('change',{bubbles:true}))})()")
    }
  }
  const record = (name, start) => journal.push({ name, requests: writes.slice(start) })
  const held = () => releaseWrite ? Promise.resolve() : new Promise(resolve => { heldWriteReady = resolve })

  // CONTRACT PROBE START: also run unchanged against the pre-refactor Editor.
  for (const page of ['home', 'tasks', 'projectDetail']) {
    await t.test(page + ': attributes remain draft; failed Footer and pending guard preserve one save and Schedule payload', async () => {
      reset(); await open(page)
      const start = writes.length
      await input(dialog + ' [name=title]', 'Edited ' + page); await status('IN_PROGRESS')
      await b.click(dialog + ' .project-picker-trigger'); await b.click(dialog + ' [data-project-id="2"]')
      await b.click(dialog + ' .task-priority-pill'); await b.click(dialog + ' [data-priority="LOW"]')
      await b.click(dialog + ' .tag-picker-trigger'); await b.click(dialog + ' .tag-picker-options label:has([data-tag-id="3"]) input'); await key('Escape')
      await input(dialog + ' [name=deadline]', '2026/10/21'); await input(dialog + ' [name=estimatedMinutes]', '2h 15m')
      await input(dialog + ' [name=date]', '2026/10/09'); await input(dialog + ' [name=startTime]', '16:07')
      await b.evaluate("document.querySelector('.task-editor-panel [name=title]').focus()")
      assert.equal(writes.length, start, 'No attribute saves before Footer')
      rejectTask = true; holdWrite = true; releaseWrite = undefined
      await b.click(dialog + ' .composer-footer [type=submit]')
      await b.until("document.querySelector('.task-editor-panel').getAttribute('aria-busy')==='true'", 'Pending Footer')
      await held(); assert.equal(writes.length, start + 1)
      await b.evaluate("document.querySelector('.task-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));document.querySelector('.task-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))")
      await key('Escape')
      assert(await b.evaluate("!!document.querySelector('.task-editor-panel[open]')"))
      assert(await b.evaluate("[...document.querySelectorAll('.composer-footer button')].every(e=>e.disabled)"))
      releaseWrite()
      await b.until("document.querySelector('.task-form-error')", 'Save failure shown')
      assert.equal(await b.evaluate("document.querySelector('.task-editor-panel [name=title]').value"), 'Edited ' + page)
      assert.equal(await b.evaluate("document.querySelector('.task-editor-panel [name=estimatedMinutes]').value"), '2h 15m')
      assert.equal(writes.length, start + 1)
      rejectTask = false; await footer()
      const expected = { title: 'Edited ' + page, estimatedMinutes: 135, projectId: 2, priority: 'LOW', deadline: '2026-10-21', tagIds: [1, 2], status: 'IN_PROGRESS' }
      assert.deepEqual(writes.slice(start), [{ method: 'PUT', path: '/tasks/1', body: expected }, { method: 'PUT', path: '/tasks/1', body: expected },
        { method: 'POST', path: '/schedule-blocks', body: { taskId: 1, date: '2026-10-09', type: 'TIMED', startTime: '16:07', durationMinutes: 60 } }])
      assert.equal(tasks[0].title, expected.title); assert.equal(blocks[0].startTime, '16:07:00')
      record(page + '-footer', start)
    })

    await t.test(page + ': Estimate card keeps its existing immediate/draft contract and Enter/Blur never saves twice', async () => {
      reset(); const anchor = await open(page), start = writes.length
      await b.click(dialog + ' [data-time-estimate]'); await input(dialog + ' .task-time-estimate-editor input', '150m')
      if (page !== 'home') { holdWrite = true; releaseWrite = undefined }
      await key('Enter'); await b.evaluate("document.querySelector('.task-editor-panel [name=title]').focus()")
      if (page !== 'home') {
        await b.until("document.querySelector('.task-time-estimate-editor input')?.disabled", 'Estimate request pending')
        await held(); assert.equal(writes.length, start + 1); releaseWrite()
      }
      await b.until("document.querySelector('.task-editor-panel [data-time-estimate]')", 'Estimate edit finished')
      assert.deepEqual(writes.slice(start), page === 'home' ? [] : [{ method: 'PUT', path: '/tasks/1', body: { estimatedMinutes: 150 } }])
      assert.equal(tasks[0].estimatedMinutes, page === 'home' ? 60 : 150)
      await b.click(dialog + ' [data-time-estimate]'); await input(dialog + ' .task-time-estimate-editor input', 'bad'); await key('Enter')
      await b.until("document.querySelector('.task-time-estimate-editor [role=alert]')", 'Invalid estimate retained')
      await key('Escape'); assert(await b.evaluate("!!document.querySelector('.task-editor-panel[open]')"))
      await close(); await b.until('document.activeElement===document.querySelector(' + JSON.stringify(anchor) + ')', 'Launcher focus restored')
      assert.equal(tasks[0].estimatedMinutes, page === 'home' ? 60 : 150)
      record(page + '-estimate', start)
    })
  }

  for (const page of ['home', 'tasks']) {
    await t.test(page + ': new Task retries failed creation, preserves Status update and one-minute Schedule without duplicate POST', async () => {
      reset(); await go(page, 375)
      await b.click(page === 'home' ? '.home-add-trigger' : '.task-list-heading .primary-action')
      await b.until("document.querySelector('.task-editor-panel[open]')", 'New Task Editor')
      const start = writes.length
      await input(dialog + ' [name=title]', 'Created ' + page); await status('IN_PROGRESS')
      await input(dialog + ' [name=estimatedMinutes]', '90m'); await input(dialog + ' [name=date]', '2026/10/10')
      await input(dialog + ' [name=startTime]', page === 'home' ? '1713' : '17:13')
      await b.evaluate("document.querySelector('.task-editor-panel [name=title]').focus()")
      assert.equal(await b.evaluate("document.querySelector('.task-editor-panel [name=startTime]').value"), '17:13')
      assert.equal(writes.length, start)
      rejectTask = true; await b.click(dialog + ' .composer-footer [type=submit]')
      await b.until("document.querySelector('.task-form-error')", 'Create failure')
      assert.equal(await b.evaluate("document.querySelector('.task-editor-panel [name=title]').value"), 'Created ' + page)
      rejectTask = false; await footer()
      const created = tasks.find(task => task.title === 'Created ' + page)
      assert(created); assert.equal(created.status, 'IN_PROGRESS')
      const payload = { title: 'Created ' + page, estimatedMinutes: 90, projectId: null, priority: null, deadline: null, tagIds: [] }
      assert.deepEqual(writes.slice(start), [{ method: 'POST', path: '/tasks', body: payload }, { method: 'POST', path: '/tasks', body: payload },
        { method: 'PUT', path: '/tasks/' + created.id, body: { status: 'IN_PROGRESS' } },
        { method: 'POST', path: '/schedule-blocks', body: { taskId: created.id, date: '2026-10-10', type: 'TIMED', startTime: '17:13', durationMinutes: 60 } }])
      record(page + '-create', start)
    })
  }

  await t.test('Cancel confirmation and failed/pending Delete retain the Editor without duplicate mutation', async () => {
    reset(); const anchor = await open('tasks', 3), start = writes.length
    await input(dialog + ' [name=title]', 'Unsaved title')
    await b.evaluate('window.__confirmAnswer=false'); await key('Escape')
    assert(await b.evaluate("!!document.querySelector('.task-editor-panel[open]')")); assert.equal(writes.length, start)
    await b.click(dialog + ' .task-editor-delete'); assert.equal(writes.length, start)
    await b.evaluate('window.__confirmAnswer=true'); await close()
    assert.equal(tasks.find(task => task.id === 3).title, 'Task 3')
    await b.until('document.activeElement===document.querySelector(' + JSON.stringify(anchor) + ')', 'Cancelled Editor focus')
    await open('tasks', 3); rejectDelete = true; await b.click(dialog + ' .task-editor-delete')
    await b.until("document.querySelector('.task-form-error')", 'Delete failure retained')
    rejectDelete = false; holdWrite = true; releaseWrite = undefined
    await b.click(dialog + ' .task-editor-delete'); await b.until("document.querySelector('.task-editor-panel').getAttribute('aria-busy')==='true'", 'Delete pending')
    await held(); await b.evaluate("document.querySelector('.task-editor-panel .task-editor-delete').click()"); assert.equal(writes.length, start + 2)
    releaseWrite(); await b.until("!document.querySelector('.task-editor-panel[open]')", 'Delete finished')
    assert(!tasks.some(task => task.id === 3)); record('delete-cancel', start)
  })
  // CONTRACT PROBE END

  // VISUAL CHECKS START
  for (const width of [1920, 1024, 768, 375]) {
    let reference
    for (const page of ['home', 'tasks', 'projectDetail']) {
      await t.test(width + 'px ' + page + ': full-width Fields share Pill, Chip, Input and Popup geometry', async () => {
        reset(); await open(page, 1, width)
        const baseline = writes.length
        assert(await b.evaluate("!!document.querySelector('.shared-full-editor[open]') && !document.querySelector('.task-name-label select')"))
        const appearance = await b.evaluate("(()=>{const d=document.querySelector('.task-editor-panel'),box=e=>{const r=e.getBoundingClientRect();return {width:r.width,height:r.height}},style=e=>{const s=getComputedStyle(e);return {font:s.fontSize,color:s.color,radius:s.borderRadius,border:s.borderTopWidth,padding:s.padding}};return {dialog:box(d),fields:[...d.querySelectorAll('.task-attribute-control')].map(box),title:style(d.querySelector('[name=title]')),pills:[...d.querySelectorAll('.task-attribute-control .shared-pill')].map(e=>({...box(e),...style(e)})),tags:[...d.querySelectorAll('.tag-picker-trigger .tag-chip')].map(e=>({...box(e),...style(e)})),buttons:[...d.querySelectorAll('.composer-footer button')].map(e=>({...box(e),...style(e)}))}})()")
        assert(appearance.fields.length === 8 && appearance.fields.every(field => field.width === appearance.fields[0].width && field.height === 40))
        assert(appearance.pills.every(pill => pill.width === 80 && pill.height === 32))
        assert.equal(appearance.tags.length, 3); assert(appearance.tags.every(chip => chip.height === 28 && chip.font === '13px'))
        assert.equal(appearance.title.radius, '8px'); assert.equal(appearance.title.border, '2px')
        assert.equal(await b.evaluate("document.querySelector('.task-editor-panel [name=startTime]').type"), page === 'home' ? 'text' : 'time')
        if (reference) assert.deepEqual(appearance, reference, 'Same base Fields across entry screens')
        else reference = appearance
        for (const [trigger, popup] of [['.task-status-trigger', '.task-status-field .shared-picker-popup'], ['.task-priority-pill', '.priority-popup'], ['.project-picker-trigger', '.project-picker-popup'], ['.tag-picker-trigger', '.tag-picker-popup'], ['.deadline-calendar-trigger', '.deadline-calendar']]) {
          await b.evaluate('document.querySelector(' + JSON.stringify(dialog + ' ' + trigger) + ').scrollIntoView({block:"center"})')
          if (trigger === '.deadline-calendar-trigger') await b.evaluate("document.querySelector('.task-deadline-field input').focus()")
          await b.click(dialog + ' ' + trigger); await b.until('document.querySelector(' + JSON.stringify(dialog + ' ' + popup) + ')', 'Picker ready')
          if (popup === '.deadline-calendar') await b.evaluate('document.querySelector(' + JSON.stringify(dialog + ' ' + popup) + ').scrollIntoView({block:"center"})')
          await b.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
          assert(await b.evaluate("(()=>{const p=document.querySelector(" + JSON.stringify(dialog + ' ' + popup) + "),r=p.getBoundingClientRect();return getComputedStyle(p).position===" + JSON.stringify(popup === '.deadline-calendar' ? 'static' : 'fixed') + "&&r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()"), 'Popup stays in viewport: ' + trigger + ' ' + JSON.stringify(await b.evaluate('(()=>{const e=document.querySelector(' + JSON.stringify(dialog + ' ' + popup) + '),r=e.getBoundingClientRect();return {position:getComputedStyle(e).position,left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}})()')))
          await key('Escape'); await b.until('!document.querySelector(' + JSON.stringify(dialog + ' ' + popup) + ')', 'Picker closed on Escape'); assert(await b.evaluate("!!document.querySelector('.task-editor-panel[open]')"))
          assert.equal(await b.evaluate('!!document.querySelector(' + JSON.stringify(dialog + ' ' + popup) + ')'), false)
          const focusTarget = trigger === '.deadline-calendar-trigger' ? '.task-deadline-field input' : trigger
          assert(await b.evaluate('document.activeElement===document.querySelector(' + JSON.stringify(dialog + ' ' + focusTarget) + ')'))
        }
        await b.evaluate("document.querySelector('.task-editor-panel [name=title]').focus()")
        const focus = await b.evaluate("(()=>{const s=getComputedStyle(document.querySelector('.task-editor-panel [name=title]'));return [s.borderTopColor,s.outlineStyle,s.boxShadow]})()")
        assert.deepEqual(focus, ['rgb(156, 163, 175)', 'none', 'none'])
        assert.equal(writes.length, baseline); await close()
      })
    }
  }

  await t.test('Unset Fields remain neutral and Mobile Tag wrap preserves all selected tags', async () => {
    for (const page of ['home', 'tasks', 'projectDetail']) {
      reset(); if (page === 'projectDetail') { tasks[1].projectId = 1; tasks[1].projectName = 'Project 1' }; await open(page, 2, 375)
      assert(await b.evaluate("(()=>{const d=document.querySelector('.task-editor-panel');return ['.tag-empty','.shared-pill.priority-none','[name=estimatedMinutes]','[name=startTime]'].every(selector=>getComputedStyle(d.querySelector(selector)).color==='rgb(100, 116, 139)')})()"))
      const start = writes.length
      await b.click(dialog + ' .tag-picker-trigger')
      for (const id of [1, 2, 3]) await b.click(dialog + ' .tag-picker-options label:has([data-tag-id="' + id + '"]) input')
      await key('Escape')
      assert.equal(await b.evaluate("document.querySelectorAll('.task-editor-panel .tag-picker-trigger .tag-chip').length"), 3)
      assert.equal(writes.length, start); await close(); assert.deepEqual(tasks[1].tags, [])
    }
  })
  // VISUAL CHECKS END

  assert.deepEqual(errors, [])
  const directory = await mkdtemp(path.join(tmpdir(), 'full-editor-contract-'))
  await writeFile(path.join(directory, 'journal.json'), JSON.stringify(journal, null, 2))
  console.log('Contract journal: ' + directory)
})
