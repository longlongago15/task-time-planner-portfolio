import assert from 'node:assert/strict'
import test from 'node:test'
import { openBrowser } from './browser.mjs'

test('Standard Task Cells share inline geometry and Pickers without changing other screens (API mock only)', { timeout: 180000 }, async t => {
  const b = await openBrowser(); t.after(() => b.close())
  const tags = [1, 2, 3, 4].map(id => ({ id, name: `Tag ${id}`, color: '#568BC7' }))
  const projects = [1, 2].map(id => ({ id, name: `Project ${id}`, color: id === 1 ? '#568BC7' : '#A079BE', taskCount: 4, completedCount: 0, estimatedMinutes: 240, actualMinutes: 60 }))
  let tasks = [1, 2, 3, 4].map(id => ({ id, title: `Task ${id}`, status: 'NOT_STARTED', completed: false, projectId: id === 3 ? null : 1, projectName: id === 3 ? null : 'Project 1', priority: id === 3 ? null : 'HIGH', deadline: id === 3 ? null : '2026-10-20', startDate: id === 4 ? '2026-10-05' : null, estimatedMinutes: id === 3 ? null : 60, actualMinutes: 0, tags: id === 1 ? tags : id === 2 ? [tags[0]] : [], createdAt: '2026-10-01', updatedAt: '2026-10-01' }))
  let active = null, reject = false, omitStartDate = false
  const writes = [], errors = []
  await b.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' })
  await b.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false })
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{const D=Date,now=${Date.parse('2026-10-07T03:00:00Z')};window.Date=class extends D{constructor(...a){super(...(a.length?a:[now]))}static now(){return now}};window.confirm=()=>true})()` })
  b.listeners.push(m => {
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails)
    if (m.method !== 'Fetch.requestPaused') return
    const { request, requestId } = m.params, url = new URL(request.url), path = url.pathname
    void (async () => {
      if (request.method === 'OPTIONS') return b.fulfill(requestId, {})
      if (request.method !== 'GET') {
        const body = request.postData ? JSON.parse(request.postData) : undefined
        writes.push({ method: request.method, path, body })
        if (request.method === 'PUT') {
          if (reject) return b.fulfill(requestId, { detail: 'Controlled save failure' }, 500)
          const task = tasks.find(task => task.id === Number(path.split('/')[2]))
          Object.assign(task, body)
          if ('tagIds' in body) task.tags = tags.filter(tag => body.tagIds.includes(tag.id))
          if ('projectId' in body) task.projectName = projects.find(p => p.id === task.projectId)?.name ?? null
          if ('status' in body) task.completed = task.status === 'COMPLETED'
          if (omitStartDate) { const { startDate: _startDate, ...legacyTask } = task; return b.fulfill(requestId, legacyTask) }
          return b.fulfill(requestId, task)
        }
        if (path === '/tasks') { const task = { ...tasks[2], ...body, tags: [], id: 5 }; tasks.push(task); return b.fulfill(requestId, task, 201) }
        if (request.method === 'DELETE') { tasks = tasks.filter(task => task.id !== Number(path.split('/')[2])); return b.fulfill(requestId, { deleted: true }) }
        if (path === '/tasks/time/start') { active = { taskId: body.taskId, running: true, startedAt: '2026-10-07T03:00:00Z' }; return b.fulfill(requestId, active) }
        if (path === '/tasks/time/stop') { active = null; return b.fulfill(requestId, { id: 1, taskId: body.taskId, projectIdSnapshot: 1, startedAt: '2026-10-07T03:00:00Z', endedAt: '2026-10-07T03:01:00Z' }) }
        assert.fail(`Unexpected write ${path}`)
      }
      let data = []
      if (path === '/tasks') data = tasks
      else if (path === '/projects') data = projects
      else if (path === '/tags') data = tags
      else if (path === '/tasks/time/active') data = active ?? { taskId: null, running: false, startedAt: null }
      else if (/^\/tasks\/\d+$/.test(path)) data = tasks.find(task => task.id === Number(path.split('/')[2]))
      else if (path === '/reports/daily') data = { date: url.searchParams.get('date'), tasks: [], plannedOccupiedMinutes: 0, actualMinutes: 0 }
      await b.fulfill(requestId, data)
    })().catch(e => errors.push(String(e)))
  })
  await b.send('Fetch.enable', { patterns: [{ urlPattern: 'http://localhost:8000/*', requestStage: 'Request' }] })
  await b.navigate(); await b.until('document.querySelector(".icon-rail [aria-label=タスク]")', 'Navigation')
  await b.click('.icon-rail [aria-label="タスク"]'); await b.until('document.querySelectorAll(".task-list-standard .task-table-row").length===4', 'Standard table')
  const row = id => `[data-task-id="${id}"]`
  const input = async (selector, value) => b.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  const key = async name => b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: name, windowsVirtualKeyCode: name === 'Enter' ? 13 : 27 })
  const hover = async selector => { const point = await b.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`); await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }) }
  const title = row(1) + ' .task-title-input'
  const period = row(1) + ' .task-period-input'
  const estimate = row(1) + ' .task-inline-estimate'
  const geometry = selector => b.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),c=getComputedStyle(e);return {left:r.left+parseFloat(c.borderLeftWidth)+parseFloat(c.paddingLeft),height:r.height,row:e.closest('.task-table-row').getBoundingClientRect().height,outline:c.outlineStyle,shadow:c.boxShadow,border:c.borderLeftWidth,color:c.borderLeftColor,font:c.fontSize}})()`)

  await t.test('Ten columns, left alignment, shared widths, 56px rows and one Tag plus count', async () => {
    assert.deepEqual(await b.evaluate('[...document.querySelectorAll(".task-list-standard .task-table-header > span")].map(e=>e.textContent)'), ['ステータス', 'タスク名', 'タグ', 'プロジェクト', '優先度', '期間', '見積もり', '記録', '編集', '計測'])
    const widths = await b.evaluate('getComputedStyle(document.querySelector(".task-list-standard .task-table-row")).gridTemplateColumns.split(" ").map(parseFloat)')
    assert.deepEqual([widths[0], ...widths.slice(2)], [88, 144, 192, 88, 168, 88, 88, 56, 56])
    assert(await b.evaluate('[...document.querySelectorAll(".task-list-standard .task-table-row")].every(e=>e.getBoundingClientRect().height===56)'))
    assert.equal(await b.evaluate(`document.querySelectorAll('${row(1)} .task-table-tags .tag-chip:not(.tag-overflow)').length`), 1)
    assert.equal(await b.evaluate(`document.querySelector('${row(1)} .tag-overflow').textContent`), '+3件')
    assert.equal(await b.evaluate(`document.querySelector('${row(3)} [data-label=記録]').textContent`), '0m')
  })
  await t.test('Row hover differs from full editable Cell hover; Record stays read-only and Timer colors stay Indigo', async () => {
    await hover(row(1) + ' [data-label=記録]')
    assert.equal(await b.evaluate(`getComputedStyle(document.querySelector('${row(1)}')).backgroundColor`), 'rgb(238, 242, 246)')
    assert.equal(await b.evaluate(`getComputedStyle(document.querySelector('${row(1)} [data-label=記録]')).backgroundColor`), 'rgb(238, 242, 246)')
    assert(await b.evaluate(`[...document.querySelector('${row(1)}').children].every(cell=>getComputedStyle(cell).backgroundColor==='rgb(238, 242, 246)')`), 'Record hover paints every Cell with the Row hover color')
    for (const selector of ['.task-table-status', '.task-table-name', '.task-table-tags', '.task-table-project', '.task-table-priority', '.task-table-period', '[data-label=見積もり]', '.task-table-operation', '.task-table-timer']) {
      await hover(row(1) + ' ' + selector)
      const editable = !['.task-table-status', '.task-table-priority', '.task-table-tags', '.task-table-operation', '.task-table-timer'].includes(selector)
      assert.equal(await b.evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(row(1) + ' ' + selector)})).backgroundColor`), editable ? 'rgb(229, 231, 235)' : 'rgb(238, 242, 246)')
      assert(await b.evaluate(`[...document.querySelector('${row(1)}').children].filter(cell=>!cell.matches(${JSON.stringify(selector)})).every(cell=>getComputedStyle(cell).backgroundColor==='rgb(238, 242, 246)')`), 'Other Cells retain Row hover behind their controls')
    }
    assert.equal(await b.evaluate(`getComputedStyle(document.querySelector('${row(1)} .task-timer-button')).color`), 'rgb(255, 255, 255)')
    await hover('.task-search input')
    assert.equal(await b.evaluate(`getComputedStyle(document.querySelector('${row(1)}')).backgroundColor`), 'rgb(255, 255, 255)')
    assert(await b.evaluate(`[...document.querySelector('${row(1)}').children].every(cell=>getComputedStyle(cell).backgroundColor==='rgba(0, 0, 0, 0)')`), 'Leaving the Row clears every Cell background')
  })
  await t.test('Name Cell edges edit inline; geometry stays fixed; Enter/Blur save once and Escape cancels', async () => {
    for (const side of ['left', 'right']) {
      const before = await geometry(title + ' > button')
      const point = await b.evaluate(`(()=>{const r=document.querySelector('${row(1)} .task-table-name').getBoundingClientRect();return {x:${side === 'left' ? 'r.left+2' : 'r.right-2'},y:r.y+r.height/2}})()`)
      await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point }); await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
      await b.until(`document.querySelector('${title} > input')`, 'Inline title')
      const after = await geometry(title + ' > input')
      assert.equal(after.left, before.left); assert.equal(after.height, 40); assert.equal(after.row, 56); assert.equal(after.outline, 'none'); assert.equal(after.shadow, 'none'); assert.equal(after.border, '2px')
      assert.equal(await b.evaluate('!!document.querySelector(".task-editor-panel[open],.task-detail")'), false)
      await key('Escape')
    }
    const count = writes.length
    await b.click(title + ' > button'); await input(title + ' > input', 'Renamed'); await key('Enter')
    await b.until(`document.querySelector('${title} > button')?.textContent==='Renamed'`, 'Title saved')
    assert.equal(writes.length - count, 1); assert.deepEqual(writes.at(-1).body, { title: 'Renamed' })
    await b.click(title + ' > button'); await input(title + ' > input', 'Blur name'); await b.evaluate('document.querySelector(".task-search input").focus()'); await b.until(`document.querySelector('${title} > button')?.textContent==='Blur name'`, 'Blur saves')
    await b.click(title + ' > button'); await input(title + ' > input', ''); await key('Enter')
    await b.until('document.querySelector(".inline-editor-error")', 'Empty name error')
    assert.equal((await geometry(title + ' > input')).row, 56); await key('Escape')
  })
  await t.test('Status and Priority share Pill/options, apply immediately, and keep selected checks', async () => {
    assert(await b.evaluate(`[...document.querySelectorAll('${row(1)} :is(.task-status-trigger,.task-priority-pill) .shared-pill')].every(p=>{const r=p.getBoundingClientRect();return r.width===80&&r.height===32})`))
    assert(await b.evaluate(`getComputedStyle(document.querySelector('${row(1)} .task-priority-pill .ui-icon')).fill!=='none'`))
    await b.click(row(1) + ' .task-status-trigger')
    assert.equal(await b.evaluate('document.querySelectorAll(".task-table-status .shared-picker-option").length'), 3)
    assert.equal(await b.evaluate('document.querySelectorAll(".task-table-status [aria-checked=true]").length'), 1)
    await b.click(row(1) + ' [data-value=IN_PROGRESS]'); await b.until(`document.querySelector('${row(1)} .task-status-trigger').textContent.includes('進行中')`, 'Status save')
    await b.click(row(1) + ' .task-priority-pill'); await b.click(row(1) + ' [data-priority=LOW]')
    await b.until(`!document.querySelector('${row(1)} .priority-popup')`, 'Priority save')
    assert.equal(tasks[0].priority, 'LOW')
    assert(await b.evaluate(`document.querySelector('${row(1)} .task-priority-pill [data-icon=flag]')!==null`))
  })
  await t.test('Project uses common Options and colors; Tag toggles immediately without closing', async () => {
    await b.click(row(1) + ' .project-picker-trigger')
    assert(await b.evaluate('[...document.querySelectorAll(".project-picker-popup [data-project-id]")].every(e=>e.classList.contains("shared-picker-option"))'))
    await b.click(row(1) + ' .project-picker-popup [data-project-id="2"]'); await b.until('!document.querySelector(".project-picker-popup")', 'Project saved')
    assert.equal(tasks[0].projectId, 2)
    await b.click(row(1) + ' .tag-picker-trigger'); await b.click('.tag-picker-options label:last-child input')
    assert(await b.evaluate(`(()=>{const label=document.querySelector('.tag-picker-options label'),box=label.querySelector('input'),tag=label.querySelector('.tag-chip'),r=tag.getBoundingClientRect(),css=getComputedStyle(tag);return Math.abs(r.left-box.getBoundingClientRect().right-8)<1&&r.height===28&&css.borderTopWidth==='0px'&&css.fontSize==='13px'&&getComputedStyle(box).appearance==='none'})()`))
    await b.until(`document.querySelector('${row(1)} .tag-overflow')?.textContent==='+2件'`, 'Tag saved')
    assert(await b.evaluate('!!document.querySelector(".tag-picker-popup")')); await key('Escape')
  })
  await t.test('Estimate has identical origin, holds invalid/failing drafts and saves null through the existing parser', async () => {
    const before = await geometry(estimate + ' > button')
    await b.click(estimate + ' > button'); const after = await geometry(estimate + ' > input')
    assert.equal(before.left, after.left); assert.equal(after.height, 40); assert.equal(after.row, 56)
    await input(estimate + ' > input', '2h 30m'); await key('Enter'); await b.until(`document.querySelector('${estimate} > button')?.textContent==='2h 30m'`, 'Estimate saved')
    await b.click(estimate + ' > button'); await input(estimate + ' > input', 'abc'); await key('Enter'); await b.until('document.querySelector(".inline-editor-error")', 'Invalid estimate')
    assert.equal(await b.evaluate(`document.querySelector('${estimate} > input').value`), 'abc'); await key('Escape')
    reject = true; await b.click(estimate + ' > button'); await input(estimate + ' > input', '3h'); await key('Enter'); await b.until('document.querySelector(".inline-editor-error")', 'Failed save holds draft'); reject = false
    await key('Enter'); await b.until(`document.querySelector('${estimate} > button')?.textContent==='3h'`, 'Retry saved')
    await b.click(estimate + ' > button'); await input(estimate + ' > input', ''); await key('Enter'); await b.until(`document.querySelector('${estimate} > button')?.textContent===''`, 'Estimate cleared')
    assert.equal(tasks[0].estimatedMinutes, null)
  })
  await t.test('Period accepts five date formats; Calendar stays adjacent and single click creates deadline only', async () => {
    for (const value of ['20261012', '2026/10/13', '2026-10-14', '1015', '10/16']) {
      await b.click(period + ' > button'); await input(period + ' > input', value); await key('Enter'); await b.until(`!document.querySelector('${period} > input')`, 'Period saved')
      assert.equal(tasks[0].startDate, null)
    }
    await b.click(period + ' > button'); await b.click('[data-period-date="2026-10-20"]'); await key('Enter')
    await b.until(`!document.querySelector('${period} > input')`, 'Calendar deadline saved')
    assert.equal(tasks[0].deadline, '2026-10-20'); assert.equal(tasks[0].startDate, null)
  })
  await t.test('Calendar reverse range and same-day range save correctly; invalid dates retain input without growing Row', async () => {
    await b.click(period + ' > button'); await b.click('[data-period-date="2026-10-20"]'); await b.click('[data-period-date="2026-10-12"]'); await key('Enter')
    await b.until(`!document.querySelector('${period} > input')`, 'Range saved')
    assert.equal(tasks[0].startDate, '2026-10-12'); assert.equal(tasks[0].deadline, '2026-10-20')
    assert.equal(await b.evaluate(`document.querySelector('${period} .task-period-dates').textContent`), '10/12 - 10/20')
    await b.click(period + ' > button'); await b.click('[data-period-date="2026-10-12"]'); await b.click('[data-period-date="2026-10-12"]'); await key('Enter'); await b.until(`!document.querySelector('${period} > input')`, 'Equal range saved')
    assert.equal(tasks[0].startDate, tasks[0].deadline)
    for (const value of ['20260230', '10/20 - 10/12']) {
      await b.click(period + ' > button'); await input(period + ' > input', value); await key('Enter'); await b.until('document.querySelector(".inline-editor-error")', 'Invalid period')
      assert.equal((await geometry(period + ' > input')).row, 56); assert.equal(await b.evaluate(`document.querySelector('${period} > input').value`), value); await key('Escape')
    }
    assert(writes.every(write => !write.path.startsWith('/schedule-blocks')))
  })
  await t.test('Period relative days use deadline, remain one line, and Calendar range persists on Blur', async () => {
    for (const [date, text] of [['2026-10-18','あと11日'],['2026-10-07','今日'],['2026-09-26','11日超過']]) {
      await b.click(period + ' > button'); await input(period + ' > input', date); await key('Enter'); await b.until(`!document.querySelector('${period} > input')`, 'Relative date saved')
      assert.equal(await b.evaluate(`document.querySelector('${period} .task-period-relative').textContent`), text)
      assert.equal(await b.evaluate(`getComputedStyle(document.querySelector('${period} .task-period-relative')).fontSize`),'12px')
    }
    await b.click(period + ' > button'); await input(period + ' > input','2026-10-23'); await key('Enter'); await b.until(`!document.querySelector('${period} > input')`,'October selected')
    await b.click(period + ' > button'); await b.click('[data-period-date="2026-10-23"]'); await b.click('[data-period-date="2026-10-12"]')
    await b.evaluate('document.querySelector(".task-search input").focus()'); await b.until(`!document.querySelector('${period} > input')`,'Range Blur saved')
    assert.deepEqual(writes.at(-1).body,{startDate:'2026-10-12',deadline:'2026-10-23'})
    assert.equal(await b.evaluate(`document.querySelector('${period} .task-period-dates').textContent`),'10/12 - 10/23')
    assert.equal((await geometry(period + ' > button')).row,56)
  })
  await t.test('An outdated backend response cannot silently discard the selected start date', async () => {
    omitStartDate = true
    await b.click(period + ' > button'); await input(period + ' > input', '2026/10/12 - 2026/10/24'); await key('Enter')
    await b.until('document.querySelector(".inline-editor-error")', 'Missing start date error')
    assert.equal(await b.evaluate(`document.querySelector('${period} > input').value`), '2026/10/12 - 2026/10/24')
    assert.equal(await b.evaluate(`document.querySelector('${period} > input')!==null`), true)
    omitStartDate = false
    await key('Enter'); await b.until(`!document.querySelector('${period} > input')`, 'Updated backend retry')
    assert.deepEqual(writes.at(-1).body, { startDate: '2026-10-12', deadline: '2026-10-24' })
  })
  await t.test('Enter clears title/period/estimate editing surfaces; Mouse Leave never saves a draft', async () => {
    for (const [editor, value] of [[title, 'Final title'], [period, '2026/10/25'], [estimate, '75m']]) {
      await hover(editor + ' > button'); await b.click(editor + ' > button'); await input(editor + ' > input', value)
      const before = writes.length
      await hover('.task-search input')
      assert(await b.evaluate(`!!document.querySelector('${editor} > input')`))
      assert.equal(writes.length, before)
      await hover(editor + ' > input'); await key('Enter'); await b.until(`!document.querySelector('${editor} > input')`, 'Enter finished')
      assert(await b.evaluate(`(()=>{const root=document.querySelector('${editor}'),button=root.querySelector('button'),cell=root.closest('.task-table-name,[data-label]'),style=getComputedStyle(button);return root.dataset.inlineCommitted==='true'&&getComputedStyle(cell).backgroundColor==='rgb(238, 242, 246)'&&style.borderTopColor==='rgba(0, 0, 0, 0)'&&style.outlineStyle==='none'&&style.boxShadow==='none'&&document.activeElement.tagName!=='INPUT'})()`))
      assert.equal(writes.length, before + 1)
    }
  })
  await t.test('Header Icons, Tag semantic hover and compact edit/Timer surfaces are scoped to Tasks', async () => {
    assert.deepEqual(await b.evaluate(`[...document.querySelector('.task-list-standard .task-table-header').children].map(cell=>cell.querySelector('[data-icon]')?.dataset.icon??null)`), [null, null, 'tagFilled', 'folder', 'flag', 'calendar', null, null, null, null])
    const tag = row(1) + ' .task-table-tags .tag-chip:not(.tag-overflow)'
    await hover('.task-search input'); const normal = await b.evaluate(`getComputedStyle(document.querySelector('${tag}')).backgroundColor`)
    await hover(tag)
    assert.notEqual(await b.evaluate(`getComputedStyle(document.querySelector('${tag}')).backgroundColor`), normal)
    assert.equal(await b.evaluate(`getComputedStyle(document.querySelector('${tag}')).borderTopWidth`), '0px')
    assert.equal(await b.evaluate(`getComputedStyle(document.querySelector('${row(1)} .task-table-tags')).backgroundColor`), 'rgb(238, 242, 246)')
    await hover(row(1) + ' summary')
    assert(await b.evaluate(`(()=>{const s=document.querySelector('${row(1)} summary');return getComputedStyle(s).backgroundColor==='rgba(0, 0, 0, 0)'&&getComputedStyle(s,'::before').width==='34px'&&getComputedStyle(s.querySelector('[data-icon=more]')).strokeWidth==='4px'})()`))
    const timer = row(1) + ' .task-timer-button'
    await hover('.task-search input')
    assert(await b.evaluate(`(()=>{const b=document.querySelector('${timer}'),s=getComputedStyle(b);return b.dataset.timerState==='default'&&s.width==='40px'&&s.height==='40px'&&s.borderTopWidth==='0px'&&s.backgroundColor==='rgb(100, 125, 150)'&&s.color==='rgb(255, 255, 255)'})()`))
    await hover(timer); await b.until(`getComputedStyle(document.querySelector('${timer}')).backgroundColor==='rgb(82, 107, 132)'`, 'Timer hover transition')
    assert(await b.evaluate(`(()=>{const b=document.querySelector('${row(3)} .task-timer-button');b.disabled=true;const s=getComputedStyle(b);return s.opacity==='1'&&s.backgroundColor!==getComputedStyle(document.querySelector('${timer}')).backgroundColor})()`))
    await b.evaluate(`document.querySelector('${row(3)} .task-timer-button').disabled=false`)
  })
  await t.test('Separate edit/Timer columns preserve Menu and canonical start/stop', async () => {
    await b.click(row(1) + ' .task-table-timer .task-timer-button'); await b.until(`document.querySelector('${row(1)} .task-timer-button[aria-pressed=true]') && !document.querySelector('${row(1)} .task-timer-button').disabled`, 'Timer active')
    await hover('.task-search input')
    await b.until(`getComputedStyle(document.querySelector('${row(1)} .task-timer-button')).backgroundColor==='rgb(79, 70, 229)'`, 'Existing Timer Active color')
    await b.click(row(1) + ' .task-timer-button'); await b.until('!document.querySelector(".global-top-timer.timer-session")', 'Timer stopped')
    await b.click(row(1) + ' summary'); await b.click(row(1) + ' .task-row-edit'); await b.until('document.querySelector(".task-editor-panel[open]")', 'Full Editor from Menu')
    await b.click('.task-editor-panel .icon-close')
  })
  await t.test('Create/edit/delete retain existing handlers, while Project Tasks remain eight columns', async () => {
    await b.click('.task-list-heading .primary-action'); await b.until('document.querySelector(".task-editor-panel[open]")', 'Create Editor')
    await input('.task-editor-panel [name=title]', 'Created'); await b.click('.task-editor-panel button[type=submit]'); await b.until(`document.querySelector('${row(5)}')`, 'Created Row')
    await b.click(row(5) + ' summary'); await b.click(row(5) + ' .task-row-edit'); await b.until('document.querySelector(".task-editor-panel[open]")', 'Edit Editor')
    await input('.task-editor-panel [name=title]', 'Edited'); await b.click('.task-editor-panel button[type=submit]'); await b.until(`document.querySelector('${row(5)} .task-title-input > button')?.textContent==='Edited'`, 'Full edit saved')
    await b.click(row(5) + ' summary'); await b.click(row(5) + ' .task-row-icon.danger'); await b.until(`!document.querySelector('${row(5)}')`, 'Deleted')
    await b.click('.icon-rail [aria-label="プロジェクト"]'); await b.until('document.querySelector(".project-card-open")', 'Project list'); await b.click('.project-card-open'); await b.until('document.querySelector(".task-list-project-context")', 'Project Tasks')
    assert.equal(await b.evaluate('document.querySelectorAll(".task-list-project-context .task-table-header > span").length'), 8)
    assert.equal(await b.evaluate('document.querySelector(".task-list-project-context .task-status-trigger")!==null'), true)
  })
  assert.deepEqual(errors, [])
})
