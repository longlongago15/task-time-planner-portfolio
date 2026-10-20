import assert from 'node:assert/strict'
import test from 'node:test'
import { openBrowser } from './browser.mjs'

test('Project Task Tab reuses unified browsing and Cells (all API mocked, no database)', { timeout: 120000 }, async t => {
  const browser = await openBrowser()
  t.after(() => browser.close())
  const tags = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE'].map((name, index) => ({ id: index + 1, name, color: '#368AD8' }))
  const projects = [1, 2].map(id => ({ id, name: `Project ${id}`, color: '#368AD8', taskCount: id === 1 ? 6 : 1, completedCount: 1, estimatedMinutes: 120, actualMinutes: 30 }))
  const tasks = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, title: `Task ${i + 1}`, projectId: i === 6 ? 2 : 1, projectName: i === 6 ? 'Project 2' : 'Project 1',
    status: i === 1 ? 'IN_PROGRESS' : i === 5 ? 'COMPLETED' : 'NOT_STARTED', completed: i === 5, completedAt: null, completedEstimateMinutes: null,
    estimatedMinutes: i === 4 ? null : 60, actualMinutes: i === 4 ? 0 : 30, priority: ['HIGH', 'LOW', 'MEDIUM', 'HIGH', null, 'LOW', 'HIGH'][i],
    deadline: ['2026-10-07', '2026-10-03', '2026-10-12', '2026-10-08', null, null, null][i],
    tags: i === 0 ? [tags[0]] : i === 1 ? [tags[1]] : i === 2 ? tags : [], createdAt: `2026-10-0${i + 1}`, updatedAt: `2026-10-0${i + 1}` }))
  const blocks = [{ id: 1, taskId: 1, date: '2027-01-01', type: 'ALL_DAY', startTime: null, durationMinutes: null }, { id: 2, taskId: 2, date: '2026-10-07', type: 'TIME_UNSET', startTime: null, durationMinutes: null }]
  const errors = [], writes = []
  await browser.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' })
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false })
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{const D=Date,now=${Date.parse('2026-10-07T03:00:00Z')};window.Date=class extends D{constructor(...a){super(...(a.length?a:[now]));}static now(){return now}};})()` })
  browser.listeners.push(message => {
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method !== 'Fetch.requestPaused') return
    const { request, requestId } = message.params, url = new URL(request.url), path = url.pathname
    void (async () => {
      if (request.method === 'OPTIONS') return browser.fulfill(requestId, {})
      if (request.method === 'PUT' && path === '/tasks/1') {
        const body = JSON.parse(request.postData)
        assert.deepEqual(Object.keys(body), ['title'])
        writes.push(body); tasks[0].title = body.title
        return browser.fulfill(requestId, tasks[0])
      }
      assert.equal(request.method, 'GET', 'No real or unrelated mutations')
      let data = []
      if (path === '/tasks') data = tasks
      else if (/^\/tasks\/\d+$/.test(path)) data = tasks.find(task => task.id === Number(path.split('/')[2]))
      else if (path === '/projects') data = projects
      else if (path === '/tags') data = tags
      else if (path === '/tasks/time/active') data = { taskId: null, running: false, startedAt: null }
      else if (path === '/tasks/inbox') data = tasks.slice(2)
      else if (path === '/schedule-blocks') data = blocks.filter(block => (!url.searchParams.has('taskId') || block.taskId === Number(url.searchParams.get('taskId'))) && (!url.searchParams.has('startDate') || block.date >= url.searchParams.get('startDate')) && (!url.searchParams.has('endDate') || block.date <= url.searchParams.get('endDate')))
      else if (path === '/reports/daily') data = { date: url.searchParams.get('date'), tasks: [], plannedOccupiedMinutes: 0, dailyEstimatedMinutes: 0, dailyActualMinutes: 0, dailyDifference: 0 }
      else if (path === '/reports/weekly') data = { daily: [], weeklyEstimatedMinutes: 0, weeklyPlannedOccupiedMinutes: 0, weeklyActualMinutes: 0 }
      await browser.fulfill(requestId, data)
    })().catch(error => { if (!/Invalid [Ii]nterceptionId|Invalid requestId/.test(error.message)) errors.push(String(error)) })
  })
  await browser.send('Fetch.enable', { patterns: [{ urlPattern: 'http://localhost:8000/*', requestStage: 'Request' }] })
  await browser.navigate()
  await browser.until(`!!document.querySelector('.icon-rail [aria-label="プロジェクト"]')`, 'Project navigation button')
  await browser.click('.icon-rail [aria-label="プロジェクト"]')
  await browser.until('document.querySelector(".project-card-open")', 'Project cards')
  await browser.click('.project-card-open')
  await browser.until('document.querySelector(".project-detail-panel .task-counts")?.textContent==="6件"', 'Project Task Tab')
  const rows = () => browser.evaluate('[...document.querySelectorAll(".project-detail-panel .task-table-row")].map(e=>Number(e.dataset.taskId))')
  const close = () => browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  const filter = category => browser.click(`[data-filter="${category}"] > button`)
  const select = label => browser.evaluate(`(()=>{const label=[...document.querySelectorAll('.task-filter-popover label')].find(e=>e.textContent===${JSON.stringify(label)});label.querySelector('input').click()})()`)
  const clear = async () => { await close(); if (await browser.evaluate('!!document.querySelector(".task-clear-all")')) await browser.click('.task-clear-all') }
  const input = (selector, value) => browser.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  const whitespace = async selector => {
    const point = await browser.evaluate(`(()=>{const box=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:box.right-2,y:box.top+box.height/2}})()`)
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  }
  await browser.until('document.querySelector(".project-summary-unplanned strong")?.textContent === "4件"', 'Project Summary unplanned count loaded')
  const summary = await browser.evaluate('document.querySelector(".project-summary").outerHTML')
  await t.test('No Quick View; five Filters and Sort share a row; counts and eight Grid columns fill the Container', async () => {
    assert.equal(await browser.evaluate('document.querySelector(".task-filter-switch,.task-applied-filters")'), null)
    assert.deepEqual(await rows(), [6, 5, 4, 3, 2, 1])
    assert.deepEqual(await browser.evaluate('[...document.querySelectorAll(".task-filter-buttons > div")].map(e=>e.dataset.filter)'), ['status', 'placement', 'priority', 'deadline', 'tag'])
    assert.deepEqual(await browser.evaluate('[...document.querySelectorAll(".task-table-header > span")].map(e=>e.textContent)'), ['ステータス', 'タスク名', 'タグ', '優先度', '期限', '見積もり', '記録', '⋮'])
    assert(await browser.evaluate(`(()=>{const row=document.querySelector('.task-filter-sort-row'),a=row.querySelector('.task-filter-buttons').getBoundingClientRect(),b=row.querySelector('.task-sort-controls').getBoundingClientRect();return Math.abs(a.top-b.top)<1&&a.right<=b.left})()`))
    assert(await browser.evaluate(`(()=>{const container=document.querySelector('.task-table-scroll').getBoundingClientRect();return [...document.querySelectorAll('.task-table-header,.task-table-row')].every(e=>{const box=e.getBoundingClientRect(),cols=getComputedStyle(e).gridTemplateColumns.split(' ').map(parseFloat);return cols.length===8&&[cols[0],...cols.slice(3)].every(n=>n===128)&&Math.abs(cols[1]-2*cols[2])<1&&Math.abs(cols.reduce((s,n)=>s+n,0)-container.width)<1&&Math.abs(box.left-container.left)<1&&Math.abs(box.right-container.right)<1})})()`))
  })
  await t.test('Shared OR/AND filters include future placements; Applied chips sync and clear; search and Sort stay usable', async () => {
    for (const [category, label, expected] of [['status','進行中',[2]],['placement','未配置',[6,5,4,3]],['placement','配置済み',[2,1]],['priority','未設定',[5]],['deadline','今月',[4,3,2,1]],['deadline','期限切れ',[2]],['deadline','今日',[1]],['deadline','今週',[4,1]],['deadline','期限なし',[6,5]]]) {
      await filter(category); await select(label); await close()
      assert.deepEqual(await rows(), expected)
      assert.equal(await browser.evaluate('document.querySelector(".task-counts").textContent'), `6件中 ${expected.length}件を表示`)
      await clear()
    }
    await filter('status'); await select('未着手'); await select('進行中'); await close()
    assert.deepEqual(await rows(), [5,4,3,2,1])
    assert.equal(await browser.evaluate('document.querySelectorAll(".task-filter-chip .task-status-control").length'), 2)
    await filter('priority'); await select('高'); await select('中'); await close(); assert.deepEqual(await rows(), [4,3,1])
    await filter('placement'); await select('未配置'); await close(); assert.deepEqual(await rows(), [4,3])
    await browser.click('[aria-label="配置：未配置を解除"]'); await filter('placement'); assert.equal(await browser.evaluate('document.querySelectorAll(".task-filter-popover input:checked").length'), 0); await close(); await clear()
    await filter('tag'); await select('AAA'); await select('BBB'); await close(); assert.deepEqual(await rows(), [3,2,1]); await clear()
    await filter('deadline'); await select('期間指定'); await input('[aria-label="期限の開始日"]','2026-10-07'); await input('[aria-label="期限の終了日"]','2026-10-08'); await close(); assert.deepEqual(await rows(), [4,1]); await clear()
    await input('.task-search input','Task 2'); await filter('status'); await select('進行中'); await close(); assert.deepEqual(await rows(), [2]); await clear(); assert.equal(await browser.evaluate('document.querySelector(".task-search input").value'), 'Task 2'); await input('.task-search input','')
    await filter('sort'); await browser.evaluate("[...document.querySelectorAll('.task-filter-popover button')].find(e=>e.textContent==='名前').click()"); await browser.click('.task-sort-controls > button'); assert.deepEqual(await rows(), [1,2,3,4,5,6])
    await filter('sort'); await browser.evaluate("[...document.querySelectorAll('.task-filter-popover button')].find(e=>e.textContent==='更新日').click()"); await browser.click('.task-sort-controls > button')
    assert.equal(await browser.evaluate('document.querySelector(".task-applied-filters")'), null)
  })
  await t.test('Shared Chips blank fields whole-Cell triggers Hover and Row Menu; titles edit inline and save only title', async () => {
    assert.equal(await browser.evaluate('document.querySelectorAll(".task-table-status .task-status-trigger").length'), 6)
    assert.deepEqual(await browser.evaluate(`(()=>{const row=document.querySelector('[data-task-id="3"] .task-table-tags');return [row.querySelectorAll('.tag-chip:not(.tag-overflow)').length,row.querySelector('.tag-overflow').textContent,getComputedStyle(row.querySelector('[data-icon=chevronDown]')).display]})()`), [2,'+3件','none'])
    assert(await browser.evaluate(`(()=>{const row=document.querySelector('[data-task-id="5"]');return ['.task-table-tags','.task-table-priority','.task-table-deadline','[data-label="見積もり"]'].every(s=>row.querySelector(s).textContent==='')&&row.querySelector('[data-label="記録"]').textContent==='0分'})()`))
    for (const id of [1,2,3,4,5,6]) { await whitespace(`[data-task-id="${id}"] .task-table-name`); await browser.until(`document.querySelector('[data-task-id="${id}"] .task-title-input > input')`,'Inline title'); assert.equal(await browser.evaluate('document.querySelector(".task-editor-panel[open],.task-detail")'),null); await close() }
    for (const [cell, popup] of [['.task-table-tags','.tag-picker-popup'],['.task-table-priority','.priority-popup'],['.task-table-deadline','.task-deadline-editor'],['[data-label="見積もり"]','.task-inline-estimate > input'],['.task-row-menu','.task-row-menu[open]']]) { await whitespace(`[data-task-id="5"] ${cell}`); await browser.until(`document.querySelector('[data-task-id="5"] ${popup}')`,'Shared Cell operation'); await close() }
    await browser.click('[data-task-id="1"] .task-title-input > button'); await input('[data-task-id="1"] .task-title-input > input','Renamed'); await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13}); await browser.until(`document.querySelector('[data-task-id="1"] .task-title-input > button')?.textContent==='Renamed'`,'Title saved')
    assert.deepEqual(writes,[{title:'Renamed'}])
    await browser.click('[data-task-id="1"] .task-title-input > button'); await input('[data-task-id="1"] .task-title-input > input','Task 1'); await browser.evaluate(`document.querySelector('[data-task-id="1"] .task-title-input > input').blur()`); await browser.until(`document.querySelector('[data-task-id="1"] .task-title-input > button')?.textContent==='Task 1'`,'Blur saved')
    await whitespace('[data-task-id="1"] .task-row-menu'); await browser.click('[data-task-id="1"] .task-row-edit'); await browser.until('document.querySelector(".task-editor-panel[open]")','Menu retains Full Editor'); await browser.click('.task-editor-panel .icon-close')
    await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:0,y:0}); const normal=await browser.evaluate(`getComputedStyle(document.querySelector('[data-task-id="1"]')).backgroundColor`)
    for(let i=0;i<8;i++){ const point=await browser.evaluate(`(()=>{const r=document.querySelector('[data-task-id="1"]').children[${i}].getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`); await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',...point}); assert.notEqual(await browser.evaluate(`getComputedStyle(document.querySelector('[data-task-id="1"]')).backgroundColor`),normal) }
    await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:0,y:0}); assert.equal(await browser.evaluate(`getComputedStyle(document.querySelector('[data-task-id="1"]')).backgroundColor`),normal)
    assert.equal(await browser.evaluate('document.querySelector(".project-summary").outerHTML'),summary)
  })
  await t.test('Project columns stay readable and Cards contain existing controls at seven widths', async () => {
    for (const width of [1920,1024,980,768,680,600,375]) {
      await browser.send('Emulation.setDeviceMetricsOverride',{width,height:1080,deviceScaleFactor:1,mobile:false})
      await browser.until(`document.querySelector('.app-layout').dataset.device===${JSON.stringify(width>980?'desktop':width>680?'tablet':'mobile')} && document.querySelector('.app-layout').getAnimations().every(a=>a.playState!=='running')`, 'Responsive layout settled')
      const layout = await browser.evaluate(`(()=>{
        const table=document.querySelector('.task-table-scroll'), header=document.querySelector('.task-table-header'), rows=[...document.querySelectorAll('.task-table-row')]
        const columns=e=>getComputedStyle(e).gridTemplateColumns.split(' ').map(parseFloat)
        return {pageOverflow:document.documentElement.scrollWidth>innerWidth, display:getComputedStyle(header).display,
          viewport:table.clientWidth, content:table.scrollWidth, header:columns(header), rows:rows.map(row=>{
            const r=row.getBoundingClientRect(), menu=row.querySelector('summary').getBoundingClientRect(), timer=row.querySelector('.task-timer-button').getBoundingClientRect()
            return {columns:columns(row), width:r.width, controlsContained:menu.left>=r.left&&menu.right<=r.right+.5&&timer.left>=r.left&&timer.right<=r.right+.5,
              menuWidth:menu.width, timerWidth:timer.width}
          })}
      })()`)
      assert.equal(layout.pageOverflow,false,`${width}px page overflow`)
      assert.equal(layout.display,width<=600?'none':'grid')
      for (const row of layout.rows) {
        if (width>600) {
          assert.equal(row.columns.length,8)
          assert(row.columns[1]>=220&&row.columns[2]>=144,`${width}px readable title and tags`)
          assert.deepEqual(row.columns,layout.header,'Header and Row share columns')
          assert(Math.abs(row.width-Math.max(layout.viewport,1132))<1,'Only the Table scrolls at narrow widths')
        } else {
          assert(row.columns[1]>0)
          assert(row.controlsContained,'Menu and Timer must fit inside each Card')
          assert(row.menuWidth>=32&&row.timerWidth>=24,'Existing hit areas stay available')
        }
      }
      if (width<=600) assert(layout.content<=layout.viewport+1,'Cards need no horizontal scrolling')
      else assert.equal(layout.content>layout.viewport,width!==1920,'Local scrolling preserves narrow columns')
      for (const [cell,popup] of [['.task-table-name','.task-title-input > input'],['.task-table-tags','.tag-picker-popup'],['.task-table-priority','.priority-popup'],['.task-table-deadline','.task-deadline-editor'],['[data-label="\u898b\u7a4d\u3082\u308a"]','.task-inline-estimate > input'],['.task-row-menu','.task-row-menu[open]']]) {
        const selector=`[data-task-id="5"] ${cell}`
        await browser.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',inline:'nearest'})`)
        await whitespace(selector)
        await browser.until(`document.querySelector('[data-task-id="5"] ${popup}')`,'Responsive Cell operation')
        assert.equal(await browser.evaluate('document.querySelector(".task-editor-panel[open],.task-detail")'),null)
        await close()
      }
    }
    assert.deepEqual(writes,[{title:'Renamed'},{title:'Task 1'}],'Responsive checks must not save data')
  })
  assert.deepEqual(errors,[])
})
