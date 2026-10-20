import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import test from 'node:test'
import { openBrowser } from './browser.mjs'

test('43A-1 task browsing and common Header (intercepted API, no database)', { timeout: 120000 }, async t => {
  const browser = await openBrowser()
  t.after(() => browser.close())
  const day = '2026-10-07', now = Date.parse(`${day}T12:00:00+09:00`)
  const projects = [1, 2, 3, 4].map(id => ({ id, name: `Project ${id}`, color: ['#368AD8','#FFC44D','#AF6BCB','#C37782'][id-1], taskCount: 1, completedCount: 0, estimatedMinutes: 150, actualMinutes: 30 }))
  const tags = [{ id: 1, name: 'AAA', color: '#368AD8' }, { id: 2, name: 'BBB', color: '#AF6BCB' }, ...[3, 4, 5].map(id => ({ id, name: `Tag ${id}`, color: '#368AD8' }))]
  const tasks = Array.from({ length: 6 }, (_, index) => {
    const id = index + 1, projectId = id <= 4 ? id : null
    return { id, title: ['Alpha', 'Beta', 'Gamma', 'Delta', 'No fields', 'Old completed'][index], projectId, projectName: projectId ? `Project ${id}` : null,
      status: id === 6 ? 'COMPLETED' : id === 2 ? 'IN_PROGRESS' : 'NOT_STARTED', completed: id === 6, completedAt: id === 6 ? '2025-01-01T00:00:00Z' : null,
      completedEstimateMinutes: null, estimatedMinutes: id === 5 ? null : 150, actualMinutes: id === 5 ? 0 : 30, differenceMinutes: null, actualStartedAt: null,
      tags: id === 1 ? [tags[0]] : id === 2 ? [tags[1]] : id === 3 ? tags : id === 4 ? tags.slice(2, 4) : id === 5 ? tags.slice(2) : [],
      priority: ['HIGH', 'LOW', 'MEDIUM', 'HIGH', null, 'LOW'][index], deadline: [day, '2026-10-03', '2026-10-12', '2026-10-08', null, null][index],
      createdAt: `2026-10-0${id}T00:00:00Z`, updatedAt: `2026-10-0${id}T00:00:00Z` }
  })
  const blocks = [1, 2, 3, 4].map(id => ({ id, taskId: id, date: day, type: 'ALL_DAY', startTime: null, durationMinutes: null }))
  blocks.push({ ...blocks[0], id: 9 }) // One Task counted once, despite multiple ScheduleBlocks.
  const startedAt = `${day}T02:00:00Z`
  const entries = [{ id: 1, taskId: 2, projectIdSnapshot: 2, startedAt, endedAt: null, createdAt: startedAt, updatedAt: startedAt, durationMinutes: null }]
  const summary = date => ({ date, plannedOccupiedMinutes: 0, dailyEstimatedMinutes: 0, dailyActualMinutes: 0, dailyDifference: 0, tasks: [] })
  const errors = [], requests = []
  let allowTaskUpdates = false
  await browser.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' })
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{const D=Date;window.Date=class extends D{constructor(...a){super(...(a.length?a:[${now}]));}static now(){return ${now};}};})()` })
  browser.listeners.push(message => {
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method !== 'Fetch.requestPaused') return
    const { request, requestId } = message.params, url = new URL(request.url)
    requests.push({ path: url.pathname, method: request.method, body: request.postData ? JSON.parse(request.postData) : undefined })
    void (async () => {
      if (request.method === 'OPTIONS') return browser.fulfill(requestId, {})
      if (request.method === 'PUT' && allowTaskUpdates && /^\/tasks\/(1|5)$/.test(url.pathname)) {
        const changes=JSON.parse(request.postData),task=tasks.find(task=>task.id===Number(url.pathname.split('/')[2]))
        assert(Object.keys(changes).every(key=>['projectId','priority','title'].includes(key)))
        Object.assign(task,changes)
        task.projectName=projects.find(project=>project.id===task.projectId)?.name??null
        return browser.fulfill(requestId,task)
      }
      assert.equal(request.method, 'GET', 'Browsing cannot mutate data')
      const path = url.pathname
      let data = []
      if (path === '/tasks') data = tasks
      else if (/^\/tasks\/\d+$/.test(path)) data = tasks.find(task => task.id === Number(path.split('/')[2]))
      else if (path === '/tags') data = tags
      else if (path === '/projects') data = projects
      else if (path === '/tasks/time/active') data = { taskId: 2, running: true, startedAt }
      else if (path === '/tasks/inbox') data = tasks.filter(task => task.id >= 5)
      else if (path === '/schedule-blocks') data = blocks.filter(b => (!url.searchParams.has('startDate') || b.date >= url.searchParams.get('startDate')) && (!url.searchParams.has('endDate') || b.date <= url.searchParams.get('endDate')))
      else if (/\/tasks\/\d+\/time-entries/.test(path)) data = entries.filter(e => e.taskId === Number(path.split('/')[2]))
      else if (path === '/reports/daily') data = summary(url.searchParams.get('date'))
      else if (path === '/reports/weekly') data = { weekStart: '2026-10-05', weekEnd: '2026-10-11', daily: Array.from({ length: 7 }, (_, i) => summary(`2026-10-${String(i + 5).padStart(2, '0')}`)), weeklyEstimatedMinutes: 0, weeklyPlannedOccupiedMinutes: 0, weeklyActualMinutes: 0 }
      await browser.fulfill(requestId, data)
    })().catch(error => { if (!/Invalid InterceptionId|Invalid interceptionId|Invalid requestId/.test(error.message)) errors.push(error.message) })
  })
  await browser.send('Fetch.enable', { patterns: [{ urlPattern: 'http://localhost:8000/*', requestStage: 'Request' }] })
  if (process.env.TASK_LIST_TEST_URL) await browser.send('Page.navigate', { url: process.env.TASK_LIST_TEST_URL })
  else await browser.navigate()
  await browser.until('document.querySelector(".timer-session") && document.querySelector(".workspace-sidebar")', 'Active Header loaded')
  const nav = label => browser.click(`.icon-rail [aria-label="${label}"]`)
  const rows = () => browser.evaluate('Array.from(document.querySelectorAll(".task-list-v43 .task-table-row")).map(e=>Number(e.dataset.taskId))')
  const filter = async category => browser.click(`[data-filter="${category}"] > button`)
  const select = async value => browser.evaluate(`(()=>{const label=Array.from(document.querySelectorAll('.task-filter-popover label')).find(e=>e.textContent===${JSON.stringify(value)});label.querySelector('input').click()})()`)
  const close = () => browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  const input = async (selector, value) => browser.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`)
  const clear = async () => { if (await browser.evaluate('Boolean(document.querySelector(".task-clear-all"))')) await browser.click('.task-clear-all'); await close() }
  const screenshot = async label => {
    await mkdir(new URL('../../docs/screenshots/step43a-1/', import.meta.url), { recursive: true })
    const shot = await browser.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    await writeFile(new URL(`../../docs/screenshots/step43a-1/${label}.png`, import.meta.url), Buffer.from(shot.data, 'base64'))
  }
  await t.test('one shared Timer on Home, Tasks, Projects, Project detail and Reports preserves active state', async () => {
    for (const label of ['タスク', 'プロジェクト', 'レポート', 'ホーム']) {
      await nav(label)
      await browser.until('document.querySelector(".timer-session .timer-task-title")?.textContent.includes("Beta")', 'Common running Timer')
      assert.equal(await browser.evaluate('document.querySelectorAll(".global-top-timer").length'), 1)
      assert.equal(await browser.evaluate('document.querySelector(".timer-task-title input").value'), 'Beta')
      assert.equal(await browser.evaluate('document.querySelector(".timer-elapsed").textContent'), '1:00:00')
    }
    await nav('プロジェクト'); await browser.until('document.querySelector(".project-card-open")', 'Projects'); await browser.click('.project-card-open')
    assert.equal(await browser.evaluate('document.querySelectorAll(".global-top-timer").length'), 1)
    assert.deepEqual(await browser.evaluate('Array.from(document.querySelector(".global-top-timer").children).map(e=>e.className.split(" ")[0]).slice(0,3)'), ['header-timer-task', 'timer-context-actions', 'timer-time-button'])
  })
  await nav('タスク')
  await browser.until('document.querySelector(".task-counts")?.textContent === "6\u4ef6"', 'Task counts loaded')
  await t.test('Unified list removes Quick View and keeps heading counts search six filters chips sort and ten columns', async () => {
    assert.equal(await browser.evaluate('document.querySelector(".task-filter-switch")'),null)
    assert.deepEqual(await rows(),[6,5,4,3,2,1])
    assert.deepEqual(await browser.evaluate('[...document.querySelectorAll(".task-filter-buttons > div")].map(e=>e.dataset.filter)'),['status','placement','project','priority','deadline','tag'])
    assert.equal(await browser.evaluate('document.querySelectorAll(".app-main .primary-action").length'),1)
    assert.equal(await browser.evaluate('document.querySelectorAll(".task-table-header > span").length'),10)
    assert.equal(await browser.evaluate('document.querySelectorAll(".task-table-row input[type=checkbox]").length'),0)
    assert.equal(await browser.evaluate('document.querySelectorAll(".task-table-status .task-status-trigger").length'),6)
    assert(await browser.evaluate('(()=>{const row=document.querySelector(".task-filter-sort-row"),filter=row.querySelector(".task-filter-buttons").getBoundingClientRect(),sort=row.querySelector(".task-sort-controls").getBoundingClientRect(),box=row.getBoundingClientRect();return Math.abs(filter.top-sort.top)<=1&&filter.right<=sort.left&&Math.abs(sort.right-box.right)<=1&&getComputedStyle(document.querySelector(".task-list-unified")).marginBottom==="8px"&&!document.querySelector(".task-applied-filters")})()'),'Filter and Sort share one row without an empty Applied row')
    await browser.click('.task-list-heading .primary-action');await browser.until('document.querySelector(".task-editor-panel[open]")','Existing Editor');await browser.click('.task-editor-panel .icon-close')
  })
  await t.test('Desktop columns fill the Container and share widths and left edges; existing Pickers remain usable', async () => {
    const layout = await browser.evaluate(`(()=>{
      const header=document.querySelector('.task-table-header'),row=document.querySelector('[data-task-id="3"]'),cells=[...row.children];
      const container=document.querySelector('.task-table-scroll').getBoundingClientRect(),headerRect=header.getBoundingClientRect();
      return {header:getComputedStyle(header).gridTemplateColumns,row:getComputedStyle(row).gridTemplateColumns,
        containerWidth:container.width,headerWidth:headerRect.width,
        edges:[...document.querySelectorAll('.task-table-header,.task-table-row')].every(e=>{const box=e.getBoundingClientRect();return Math.abs(box.left-container.left)<1&&Math.abs(box.right-container.right)<1}),
        aligned:[...header.children].every((cell,i)=>Math.abs(cell.getBoundingClientRect().left-cells[i].getBoundingClientRect().left)<1&&getComputedStyle(cell).textAlign==='left'&&getComputedStyle(cells[i]).textAlign==='left'),
        starts:['.task-status-trigger','.task-title-input > button','.tag-picker-trigger','.project-picker-trigger','.task-priority-pill','.task-inline-value','.task-inline-value',null,'summary',null].map((selector,i)=>selector?Math.abs(cells[i].querySelector(selector).getBoundingClientRect().left+([1,5,6].includes(i)?parseFloat(getComputedStyle(cells[i].querySelector(selector)).paddingLeft)+parseFloat(getComputedStyle(cells[i].querySelector(selector)).borderLeftWidth):0)-cells[i].getBoundingClientRect().left-([0,4].includes(i)?4:8)):0),
        tagCounts:[1,4,5,3,6].map(id=>document.querySelectorAll('[data-task-id="'+id+'"] .task-table-tags .tag-chip:not(.tag-overflow)').length),
        summaries:[1,4,5,3,6].map(id=>document.querySelector('[data-task-id="'+id+'"] .task-table-tags .tag-overflow')?.textContent??null),
        overflow:row.querySelector('.tag-overflow')?.textContent,
        indicator:getComputedStyle(row.querySelector('[data-icon=chevronDown]')).display};
    })()`)
    assert.equal(layout.header,layout.row)
    const widths=layout.row.split(' ').map(parseFloat)
    assert.deepEqual([widths[0],...widths.slice(2)],[88,144,192,88,168,88,88,56,56])
    assert(widths[1]>=220)
    assert(layout.edges);assert(Math.abs(layout.headerWidth-layout.containerWidth)<1)
    assert(Math.abs(widths.reduce((sum,width)=>sum+width,0)-layout.containerWidth)<1)
    assert(layout.aligned);assert(layout.starts.every(offset=>offset<1),JSON.stringify(layout.starts))
    assert.deepEqual(layout.tagCounts,[1,1,1,1,0]);assert.deepEqual(layout.summaries,[null,'+1件','+2件','+4件',null]);assert.equal(layout.overflow,'+4件');assert.equal(layout.indicator,'none')
    await browser.click('[data-task-id="3"] .tag-picker-trigger');await browser.until('document.querySelector(".tag-picker-popup")','Tag editing Popup');await close()
    await browser.click('[data-task-id="3"] .project-picker-trigger');await browser.until('document.querySelector(".project-picker-popup")','Project editing Popup');await close()
  })
  await t.test('Task name text and Cell whitespace start inline editing only; other Cells stay independent and unset values are blank', async () => {
    for(const id of [1,2,3,4,5,6]){
      for(const side of ['text','left','right']){
      const point=await browser.evaluate(`(()=>{const cell=document.querySelector('[data-task-id="${id}"] ${side === 'text' ? '.task-title-input > button' : '.task-table-name'}').getBoundingClientRect();const point={x:${side === 'right' ? 'cell.right-2' : side === 'text' ? 'cell.left+12' : 'cell.left+2'},y:cell.top+cell.height/2};return {...point,hit:document.elementFromPoint(point.x,point.y)?.closest('.task-title-input > button')?.tagName}})()`)
      assert.equal(point.hit,'BUTTON','The existing Button receives the Cell edge click without clipping')
      delete point.hit
      await browser.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point})
      await browser.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point})
      await browser.until(`document.querySelector('[data-task-id="${id}"] .task-title-input > input')`,'Existing inline title input')
      assert.equal(await browser.evaluate(`document.querySelector('[data-task-id="${id}"] .task-title-input > input').value`),tasks.find(task=>task.id===id).title)
      await browser.click(`[data-task-id="${id}"] .task-title-input > input`)
      assert.equal(await browser.evaluate('document.querySelector(".task-editor-panel[open],.task-detail,.calendar-dialog-popover")'),null)
      await close()
      await browser.until(`document.querySelector('[data-task-id="${id}"] .task-title-input > button')`,'Escape returns to title display')
      }
    }
    for(const selector of ['.tag-picker-trigger','.project-picker-trigger','.task-priority-pill','.task-table-period button','.task-row-menu > summary']){
      await browser.click('[data-task-id="1"] '+selector)
      assert.equal(await browser.evaluate('document.querySelector(".task-editor-panel[open]")'),null)
      await close()
    }
    assert(await browser.evaluate(`(()=>{
      const empty=document.querySelector('[data-task-id="5"]'),noTags=document.querySelector('[data-task-id="6"] .task-table-tags');
      return noTags.textContent===''&&getComputedStyle(noTags.querySelector('[data-icon=chevronDown]')).display==='none'
        &&getComputedStyle(empty.querySelector('.project-picker-trigger > .unset-value')).display==='none'
        &&getComputedStyle(empty.querySelector('.project-picker-trigger > [data-icon=folder]')).display==='none'
        &&empty.querySelector('.task-table-priority').textContent===''
        &&empty.querySelector('.task-table-period button').textContent===''
        &&empty.querySelector('[data-label="見積もり"] button').textContent===''
        &&empty.querySelector('[data-label="記録"]').textContent==='0m';})()`))
    for(const id of [1,2,3]) assert(await browser.evaluate(`(()=>{const pill=document.querySelector('[data-task-id="${id}"] .task-priority-pill > .shared-pill'),style=getComputedStyle(pill);return style.paddingLeft==='8px'&&style.paddingRight==='8px'&&style.height==='32px'&&style.backgroundColor!=='rgba(0, 0, 0, 0)'})()`),'Common Priority pill padding alignment and semantic background')
  })
  await t.test('Cell whitespace activates only existing controls and any Cell highlights its Row', async () => {
    const clickWhitespace=async selector=>{
      const point=await browser.evaluate(`(()=>{const box=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:box.right-2,y:box.top+box.height/2}})()`)
      await browser.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point})
      await browser.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point})
    }
    for(const [cell,popup] of [['.task-table-tags','.tag-picker-popup'],['.task-table-project','.project-picker-popup'],['.task-table-priority','.priority-popup'],['.task-table-period','.task-period-calendar'],['[data-label="見積もり"]','.task-inline-estimate input'],['.task-table-operation','.task-row-menu[open]']]){
      await clickWhitespace('[data-task-id="1"] '+cell)
      await browser.until(`document.querySelector(${JSON.stringify('[data-task-id="1"] '+popup)})`,'Cell whitespace opens its existing control once')
      assert.equal(await browser.evaluate('document.querySelector(".task-editor-panel[open]")'),null)
      await close()
    }
    await clickWhitespace('[data-task-id="1"] .task-table-status');await browser.until('document.querySelector(".task-table-status .shared-picker-popup")','Status Cell opens common Picker');await close()
    await clickWhitespace('[data-task-id="1"] [data-label="記録"]');assert.equal(await browser.evaluate('document.querySelector(".task-editor-panel[open]")'),null)
    await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:0,y:0})
    const normal=await browser.evaluate('getComputedStyle(document.querySelector("[data-task-id=\\"1\\"]")).backgroundColor')
    for(let index=0;index<10;index++){
      const point=await browser.evaluate(`(()=>{const box=document.querySelector('[data-task-id="1"]').children[${index}].getBoundingClientRect();return {x:box.left+box.width/2,y:box.top+box.height/2}})()`)
      await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',...point})
      assert.notEqual(await browser.evaluate('getComputedStyle(document.querySelector("[data-task-id=\\"1\\"]")).backgroundColor'),normal)
    }
    await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:0,y:0})
    assert.equal(await browser.evaluate('getComputedStyle(document.querySelector("[data-task-id=\\"1\\"]")).backgroundColor'),normal)
  })
  await t.test('Applied Status uses display-only common chips and existing clear actions without mutations', async () => {
    for(const [label,value] of [['未着手','NOT_STARTED'],['進行中','IN_PROGRESS'],['完了','COMPLETED']]){
      await filter('status');await select(label);await close()
      assert.equal(await browser.evaluate('document.querySelector(".task-filter-status-chip .task-status-control").dataset.taskStatus'),value)
      assert.equal(await browser.evaluate('document.querySelector(".task-filter-status-chip select")'),null)
      assert.equal(await browser.evaluate('getComputedStyle(document.querySelector(".task-filter-status-chip")).borderTopWidth'),'0px')
      await browser.click(`[aria-label="ステータス：${label}を解除"]`)
      await filter('status');assert.equal(await browser.evaluate('document.querySelectorAll(".task-filter-popover input:checked").length'),0);await close()
      assert.deepEqual(await rows(),[6,5,4,3,2,1])
    }
    assert(requests.every(r=>['GET','OPTIONS'].includes(r.method)))
  })
  await t.test('Status choices OR; placement and other categories AND; counts and search stay synchronized', async () => {
    const cases=[['status','\u9032\u884c\u4e2d',[2]],['project','\u672a\u6240\u5c5e',[6,5]],['priority','\u9ad8',[4,1]],['deadline','\u671f\u9650\u5207\u308c',[2]],['deadline','\u671f\u9650\u306a\u3057',[6,5]],['deadline','\u4eca\u65e5',[1]],['deadline','\u4eca\u9031',[4,1]],['deadline','\u4eca\u6708',[4,3,2,1]],['placement','\u672a\u914d\u7f6e',[6,5]],['placement','\u914d\u7f6e\u6e08\u307f',[4,3,2,1]]]
    for(const [category,value,expected]of cases){await filter(category);await select(value);assert.deepEqual(await rows(),expected);assert.equal(await browser.evaluate('document.querySelector(".task-counts").textContent'), '6\u4ef6\u4e2d '+expected.length+'\u4ef6\u3092\u8868\u793a');await close();await clear()}
    await filter('status');await select('\u672a\u7740\u624b');await select('\u9032\u884c\u4e2d');await close();assert.deepEqual(await rows(),[5,4,3,2,1])
    await filter('placement');await select('\u672a\u914d\u7f6e');await close();assert.deepEqual(await rows(),[5]);await clear()
    await input('.task-search input','BETA');await filter('status');await select('\u9032\u884c\u4e2d');await close();assert.deepEqual(await rows(),[2]);await clear();assert.equal(await browser.evaluate('document.querySelector(".task-search input").value'),'BETA');await input('.task-search input','')
  })
  await t.test('Each selected condition has its own removable chip and clear-all preserves search', async () => {
    await filter('project');for(const name of ['Project 1','Project 2','Project 3','Project 4'])await select(name);await close()
    assert.equal(await browser.evaluate('document.querySelectorAll(".task-filter-chip").length'),4)
    assert.equal(await browser.evaluate('document.querySelector(".aggregate")'),null)
    const projectChips=await browser.evaluate('[...document.querySelectorAll(".task-filter-project-value")].map(e=>({text:e.textContent,color:getComputedStyle(e).color,icon:getComputedStyle(e.querySelector("[data-icon=folder]")).color,source:e.querySelector("[data-icon=folder]").dataset.projectColor}))')
    assert.deepEqual(projectChips.map(e=>e.text),projects.map(p=>p.name));assert(projectChips.every(e=>e.color===e.icon));assert.deepEqual(projectChips.map(e=>e.source),projects.map(p=>p.color))
    await browser.click('[aria-label="\u30d7\u30ed\u30b8\u30a7\u30af\u30c8\uff1aProject 1\u3092\u89e3\u9664"]');await filter('project');assert.equal(await browser.evaluate('document.querySelectorAll(".task-filter-popover input:checked").length'),3);await close()
    await input('.task-search input','Beta');await clear();assert.equal(await browser.evaluate('document.querySelector(".task-search input").value'),'Beta');assert.deepEqual(await rows(),[2]);await input('.task-search input','')
    await filter('status');await select('\u672a\u7740\u624b');await close()
    assert(await browser.evaluate('(()=>{const filter=document.querySelector(".task-filter-sort-row").getBoundingClientRect(),chip=document.querySelector(".task-applied-filters").getBoundingClientRect(),clear=document.querySelector(".task-clear-all").getBoundingClientRect(),chips=document.querySelector(".task-applied-filter-chips").getBoundingClientRect();return filter.bottom<=chip.top&&chip.top-filter.bottom<=8&&Math.abs(clear.right-chip.right)<=1&&chips.right<=clear.left&&clear.top>=chip.top&&clear.bottom<=chip.bottom})()'),'Applied Chips sit below Filter/Sort with clear-all at the right')
    await clear()
  })
  await t.test('Tags OR and date range use existing task data without writes', async () => {
    await filter('tag');await select('AAA');assert.deepEqual(await rows(),[3,1]);await select('BBB');assert.deepEqual(await rows(),[3,2,1]);await close();await clear()
    await filter('deadline');await select('期間指定');await input('[aria-label="期限の開始日"]','2026-10-07');await input('[aria-label="期限の終了日"]','2026-10-08');assert.deepEqual(await rows(),[4,1]);await close();await clear()
    assert(await browser.evaluate('!!document.querySelector(".task-table-tags .tag-chip")'))
    assert(await browser.evaluate('[...document.querySelectorAll(".task-table-project .project-picker-trigger")].every(e=>getComputedStyle(e.querySelector("span")).color===getComputedStyle(e.querySelector("[data-icon=folder]")).color||e.querySelector(".unset-value"))'))
    assert(await browser.evaluate('!!document.querySelector(".task-row-menu summary")'))
    await browser.click('[data-task-id="1"] .task-row-menu summary');assert(await browser.evaluate('document.querySelector("[data-task-id=\\"1\\"] .task-row-menu").open'))
    await browser.click('[data-task-id="1"] .task-row-edit');await browser.until('document.querySelector(".task-editor-panel[open]")','Full Editor maintained');await browser.click('.task-editor-panel .icon-close')
  })
  await t.test('all eight sort items and ASC/DESC', async () => {
    for (const label of ['更新日', '作成日', '名前', 'プロジェクト', '優先度', 'ステータス', '期限', '見積もり']) {
      await filter('sort'); await browser.evaluate(`Array.from(document.querySelectorAll('.task-filter-popover button')).find(e=>e.textContent===${JSON.stringify(label)}).click()`)
      assert.equal(await browser.evaluate('document.querySelector("[data-filter=sort] > button").textContent'), `並び替え：${label}`)
      await browser.click('.task-sort-controls > button')
    }
    await filter('sort'); await browser.evaluate("Array.from(document.querySelectorAll('.task-filter-popover button')).find(e=>e.textContent==='名前').click()")
    await browser.click('.task-sort-controls > button')
    assert.deepEqual(await rows(), [1, 2, 4, 3, 5, 6]); await browser.click('.task-sort-controls > button'); assert.deepEqual(await rows(), [6, 5, 3, 4, 2, 1])
  })
  await t.test('compact period, Folder and duration display', async () => {
    assert.equal(await browser.evaluate(`document.querySelector('[data-task-id="2"] .task-table-period .task-period-dates').textContent`), '10/03')
    assert.equal(await browser.evaluate(`document.querySelector('[data-task-id="3"] .task-table-period .task-period-dates').textContent`), '10/12')
    assert.equal(await browser.evaluate(`document.querySelector('[data-task-id="5"] .task-table-period .task-period-dates').textContent`), '')
    assert.equal(await browser.evaluate('document.querySelectorAll(".task-table-row .task-table-project [data-icon=folder]").length'), 6)
    assert.equal(await browser.evaluate(`document.querySelector('[data-task-id="1"] [data-label="見積もり"]').textContent`), '2h 30m')
  })
  await t.test('Inline title Enter and Blur save title only; Escape and empty titles never save; Enter does not double-save', async () => {
    allowTaskUpdates=true
    const selector='[data-task-id="1"] .task-title-input',original=structuredClone(tasks[0]),before=requests.filter(r=>r.method==='PUT').length
    const start=async()=>{await browser.click(selector+' > button');await browser.until(`document.querySelector('${selector} > input')`,'Title draft ready')}
    const finish=async title=>browser.until(`document.querySelector('${selector} > button')?.textContent===${JSON.stringify(title)}`,'Saved title reflected in existing Workspace state')
    const rowHeight=await browser.evaluate(`document.querySelector('[data-task-id="1"]').getBoundingClientRect().height`)
    await start();await input(selector+' > input','Enter title')
    await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13})
    await finish('Enter title');assert.equal(requests.filter(r=>r.method==='PUT').length-before,1)
    await start();await input(selector+' > input','Blur title');await browser.evaluate(`document.querySelector('${selector} > input').blur()`)
    await finish('Blur title');assert.equal(requests.filter(r=>r.method==='PUT').length-before,2)
    await start();await input(selector+' > input','Discarded title');await close();await finish('Blur title')
    assert.equal(requests.filter(r=>r.method==='PUT').length-before,2)
    await start();await input(selector+' > input','   ');await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13})
    await browser.until(`document.querySelector('${selector} .inline-editor-error')`,'Empty title validation retains the inline draft')
    assert.equal(tasks[0].title,'Blur title');assert.equal(requests.filter(r=>r.method==='PUT').length-before,2)
    await close();await start();await input(selector+' > input',original.title);await browser.evaluate(`document.querySelector('${selector} > input').blur()`);await finish(original.title)
    const writes=requests.filter(r=>r.method==='PUT').slice(before)
    assert.deepEqual(writes.map(r=>r.body),[{title:'Enter title'},{title:'Blur title'},{title:original.title}])
    assert.deepEqual(tasks[0],original,'All other attributes remain unchanged')
    assert.equal(await browser.evaluate(`document.querySelector('[data-task-id="1"]').getBoundingClientRect().height`),rowHeight)
    assert.equal(await browser.evaluate('document.querySelector(".task-editor-panel[open],.task-detail")'),null)
    allowTaskUpdates=false
  })
  await t.test('Task-list Project options reuse colors and Icons; blank Priority still selects and saves; menu Icon aligns', async () => {
    allowTaskUpdates=true
    const before=requests.filter(r=>r.method==='PUT').length
    await browser.click('[data-task-id="1"] .project-picker-trigger')
    await browser.until('document.querySelector(".task-table-project .project-picker-popup")','Project candidates')
    const candidates=await browser.evaluate(`[...document.querySelectorAll('.task-table-project .project-picker-popup [data-project-id]')].filter(e=>e.dataset.projectId).map(e=>({color:getComputedStyle(e).color,iconColor:getComputedStyle(e.querySelector('[data-icon=folder]')).color,source:e.querySelector('[data-icon=folder]').dataset.projectColor}))`)
    assert.deepEqual(candidates.map(e=>e.source),projects.map(project=>project.color));assert(candidates.every(e=>e.color===e.iconColor))
    for(const projectId of [2,1]){
      await browser.click(`.task-table-project .project-picker-popup [data-project-id="${projectId}"]`)
      await browser.until(`document.querySelector('[data-task-id="1"] .project-picker input').value==='${projectId}'&&!document.querySelector('.task-table-project .project-picker-popup')`,'Project saved in existing Workspace state')
      if(projectId===2)await browser.click('[data-task-id="1"] .project-picker-trigger')
    }
    for(const priority of ['HIGH','MEDIUM','LOW','']){
      const point=await browser.evaluate(`(()=>{const box=document.querySelector('[data-task-id="5"] .task-table-priority').getBoundingClientRect();return {x:box.right-2,y:box.top+box.height/2}})()`)
      await browser.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await browser.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point})
      await browser.until('document.querySelector("[data-task-id=\\"5\\"] .priority-popup")','Blank or set Priority Cell opens once')
      assert.deepEqual(await browser.evaluate(`[...document.querySelectorAll('[data-task-id="5"] .priority-popup .priority-option-label')].map(e=>e.textContent).sort()`),['高','中','低','未設定'].sort())
      await browser.click(`[data-task-id="5"] .priority-popup [data-priority="${priority}"]`)
      await browser.until(`document.querySelector('[data-task-id="5"] .priority-picker input').value==='${priority}'&&!document.querySelector('.priority-popup')`,'Priority saved without replacing its existing handler')
      assert.equal(await browser.evaluate('document.querySelector(".task-editor-panel[open]")'),null)
    }
    assert.equal(requests.filter(r=>r.method==='PUT').length-before,6,'Exactly one save per selection')
    assert(await browser.evaluate(`(()=>{const header=document.querySelector('.task-table-header > :nth-child(9)').getBoundingClientRect(),icon=document.querySelector('[data-task-id="1"] .task-row-menu [data-icon=more]').getBoundingClientRect();return Math.abs(icon.left-header.left-8)<1&&getComputedStyle(document.querySelector('[data-task-id="1"] .task-row-actions')).width==='56px'})()`),'Menu Icon starts at the shared 8px inset in the separate edit column')
    allowTaskUpdates=false
  })
  for (const width of [1920, 1440, 768, 375]) await t.test(`${width}px browsing is contained, readable and captures visual evidence`, async () => {
    await browser.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false })
    assert.equal(await browser.evaluate('document.documentElement.scrollWidth > innerWidth'), false)
    assert.equal(await browser.evaluate('getComputedStyle(document.querySelector(".task-table-header")).display'), width === 375 ? 'none' : 'grid')
    if(width>=1440) assert(await browser.evaluate(`(()=>{const container=document.querySelector('.task-table-scroll').getBoundingClientRect();return [...document.querySelectorAll('.task-table-header,.task-table-row')].every(e=>{const box=e.getBoundingClientRect(),columns=getComputedStyle(e).gridTemplateColumns.split(' ').map(parseFloat);return Math.abs(box.left-container.left)<1&&Math.abs(box.width-Math.max(container.width,1188))<1&&Math.abs(columns.reduce((sum,width)=>sum+width,0)-box.width)<1&&columns[1]>=220})})()`),'Grid consumes available width, with contained horizontal scroll when the fixed minimum does not fit')
    assert.equal(await browser.evaluate('getComputedStyle(document.querySelector(".task-list-toolbar")).overflowY'), 'visible', 'Toolbar cannot clip filter popovers')
    if (width === 375) assert.equal(await browser.evaluate('document.querySelector(".task-list-v43").scrollWidth > document.querySelector(".task-list-v43").clientWidth'), false)
    await screenshot(`tasks-${width}`)
    for (const category of ['status', 'project', 'priority', 'deadline', 'sort']) {
      await filter(category); const rect = await browser.evaluate('(()=>{const r=document.querySelector(".task-filter-popover").getBoundingClientRect();return {left:r.left,right:r.right}})()'); assert(rect.left >= 0 && rect.right <= width, `${width} ${category} Popover bounds`)
      if (category === 'project') await screenshot(`project-filter-${width}`)
      assert.equal(await browser.evaluate('document.documentElement.scrollWidth > innerWidth'), false, `${width} ${category} open overflow`); await close()
    }
    if(width===375){
      await filter('project');for(const name of projects.map(p=>p.name))await select(name);await close()
      assert(await browser.evaluate('(()=>{const row=document.querySelector(".task-applied-filters").getBoundingClientRect(),clear=document.querySelector(".task-clear-all").getBoundingClientRect(),chips=[...document.querySelectorAll(".task-filter-chip")].map(e=>e.getBoundingClientRect());return chips.every(r=>r.right<=clear.left&&r.left>=row.left)&&clear.right<=row.right&&document.documentElement.scrollWidth<=innerWidth})()'),'Wrapped chips never overlap clear-all on Mobile')
      await clear()
    }
  })
  assert.deepEqual(errors, [])
  assert(requests.every(r => ['GET', 'OPTIONS'].includes(r.method)||r.method==='PUT'&&/^\/tasks\/(1|5)$/.test(r.path)))
})
