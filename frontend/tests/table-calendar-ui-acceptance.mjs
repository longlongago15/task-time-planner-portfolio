import { assertTaskTable } from './current-task-ui.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openBrowser } from './browser.mjs'
import { startMetadataBackend } from './metadata-backend.mjs'

export async function tableCalendarUiAcceptance(t, output) {
  const { base, api } = await startMetadataBackend(t)
  assert.notEqual(new URL(base).port, '8000')
  const projects = [], tasks = [], entries = [], blocks = [], requests = [], errors = [], checks = [], measurements = {}
  for (const [name, color] of [['Blue', '#568BC7'], ['Red', '#DC6262'], ['Green', '#529968'], ['Purple', '#A079BE']]) projects.push(await api('/projects', { name, color }))
  const tags = []
  for (const name of ['Backend', 'Review', 'Release']) tags.push(await api('/tags', { name, color: '#529968' }))
  for (let i = 0; i < 6; i++) {
    const project = i === 5 ? projects[0] : projects[i]
    const task = await api('/tasks', { title: i === 0 ? '非常に長いタスク名と説明'.repeat(12) : i === 1 ? '名称未設定' : `${project?.name ?? '未所属'}の予定と記録`, projectId: project?.id ?? null, estimatedMinutes: 60, tagIds: i === 2 ? [] : i === 1 ? [tags[0].id] : tags.map(tag => tag.id) })
    tasks.push(task)
    const minute = i * 30, time = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
    entries.push(await api('/time-entries', { taskId: task.id, startedAt: `2026-10-07T${time(minute)}:00Z`, endedAt: `2026-10-07T${time(minute + 30)}:00Z` }))
    blocks.push(await api('/schedule-blocks', { taskId: task.id, date: '2026-10-07', type: 'TIMED', startTime: time(minute + 540), durationMinutes: [90,50,45,15,90,30][i] }))
  }
  await api(`/tasks/${tasks[5].id}`, { projectId: projects[1].id }, 'PUT')
  await api(`/tasks/${tasks[0].id}`, { status: 'NOT_STARTED' }, 'PUT')
  const unsetBlocks = []
  for (let i = 0; i < 8; i++) {
    const task = await api('/tasks', { title: `Unset ${i}`, tagIds: i === 0 ? tags.map(tag=>tag.id) : [] })
    unsetBlocks.push(await api('/schedule-blocks', { taskId: task.id, date: '2026-10-07', type: 'TIME_UNSET' }))
  }
  let loadingGate = null
  t.after(() => loadingGate?.release())
  const browser = await openBrowser(); t.after(() => browser.close())
  await browser.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' })
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `const RealDate=Date;window.Date=class extends RealDate{constructor(...args){super(...(args.length?args:['2026-10-09T00:00:00Z']))}static now(){return new RealDate('2026-10-09T00:00:00Z').getTime()}}` })
  browser.listeners.push(message => {
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method !== 'Fetch.requestPaused') return
    const { request, requestId } = message.params
    void (async () => {
      if (request.method === 'OPTIONS') return browser.fulfill(requestId, {})
      const source = new URL(request.url), effective = base + source.pathname + source.search
      assert.notEqual(new URL(effective).port, '8000')
      requests.push({ source: request.url, effective, method: request.method })
      if (loadingGate && request.method === 'GET' && ['/schedule-blocks','/time-entries'].includes(source.pathname)) await loadingGate.promise
      const response = await fetch(effective, { method: request.method, ...(request.postData ? { headers: { 'Content-Type': 'application/json' }, body: request.postData } : {}) })
      await browser.fulfill(requestId, await response.json(), response.status)
    })().catch(error => { if (!/Invalid [Ii]nterceptionId|Invalid requestId/.test(error.message)) errors.push(String(error)) })
  })
  await browser.send('Fetch.enable', { patterns: [{ urlPattern: 'http://localhost:8000/*', requestStage: 'Request' }, { urlPattern: 'http://127.0.0.1:8000/*', requestStage: 'Request' }] })
  const check = async (name, action) => { let failure; await t.test(name, async () => { try { await action() } catch (error) { failure = error; throw error } }); if (failure) throw failure; checks.push(name) }
  const shot = async name => { if (!output) return; await mkdir(output, { recursive: true }); const shot = await browser.send('Page.captureScreenshot', { format: 'png', fromSurface: true }); await writeFile(new URL(name + '.png', output), Buffer.from(shot.data, 'base64')) }
  const size = async width => {
    await browser.send('Emulation.setDeviceMetricsOverride', { width, height: width === 1920 ? 1080 : 1100, deviceScaleFactor: 1, mobile: false })
    await browser.until(`document.querySelector('.app-layout')?.dataset.device===${JSON.stringify(width > 980 ? 'desktop' : width > 680 ? 'tablet' : 'mobile')}`, 'Device ready')
    await browser.until(`Math.abs(document.querySelector('.app-main').getBoundingClientRect().x-(innerWidth>980?(document.querySelector('.app-layout').dataset.page==='home'?256:64):0))<.1`, 'Sidebar settled')
  }
  const go = async page => {
    if (page === 'projectDetail') {
      await go('projects'); await browser.until(`document.querySelector('.project-card[data-project-id="${projects[0].id}"]')`, 'Project ready')
      await browser.click(`.project-card[data-project-id="${projects[0].id}"] .project-card-open`)
    } else await browser.click(`.mobile-nav button:nth-child(${({ home: 1, tasks: 2, projects: 3, reports: 4 })[page]})`)
    await browser.until(`document.querySelector('.app-layout')?.dataset.page===${JSON.stringify(page)}`, 'Route ready')
    if (page === 'tasks' || page === 'projectDetail') await browser.until('document.querySelector(".task-table-row")', 'Task ready')
  }
  await browser.navigate(); await browser.until('document.querySelector(".app-layout")', 'Mounted'); await size(1440)
  for (const page of ['tasks', 'projectDetail']) for (const width of [1920,1024,768,601,600,375]) await t.test(`${page} ${width}px: full Card width, aligned columns, left-aligned headers and local overflow`, async () => {
    await size(width); await go(page)
    const value = await browser.evaluate(`(()=>{const card=document.querySelector('.task-list-v43'),main=document.querySelector('.app-main'),scroll=card.querySelector('.task-table-scroll'),header=card.querySelector('.task-table-header'),row=card.querySelector('.task-table-row'),box=e=>e.getBoundingClientRect(),style=getComputedStyle(main);return{card:box(card).width,available:main.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),columns:[...header.children].map(e=>box(e).width),aligned:[...header.children].every((e,i)=>Math.abs(box(e).x-box(row.children[i]).x)<.5&&Math.abs(box(e).width-box(row.children[i]).width)<.5),right:box(row.lastElementChild).right-box(row).right,centered:[...header.children].every(e=>{const s=getComputedStyle(e);return s.justifyContent==='flex-start'&&s.textAlign==='left'}),pageOverflow:document.documentElement.scrollWidth>innerWidth,scrollWidth:scroll.scrollWidth,scrollClient:scroll.clientWidth,headerVisible:getComputedStyle(header).display!=='none',name:box(row.querySelector('.task-table-name')).width}})()`)
    console.log('Table/Card geometry',page,width,JSON.stringify(value))
    if(width<=600) console.log('Card overflow descendants',JSON.stringify(await browser.evaluate(`Array.from(document.querySelectorAll('.task-table-row *')).filter(e=>{const r=e.getBoundingClientRect();return r.width&&r.right>document.querySelector('.task-table-scroll').getBoundingClientRect().right+1}).slice(0,12).map(e=>({tag:e.tagName,cls:e.className,width:e.getBoundingClientRect().width,right:e.getBoundingClientRect().right,scroll:e.scrollWidth,client:e.clientWidth}))`)))
    if(width<=600) console.log('Mobile row Cells',JSON.stringify(await browser.evaluate(`(()=>{const r=document.querySelector('.task-table-row'),rect=e=>{const b=e.getBoundingClientRect(),s=getComputedStyle(e);return {class:e.className,width:b.width,left:b.left,right:b.right,display:s.display,position:s.position,padding:s.padding,grid:s.gridTemplateColumns,minWidth:s.minWidth,overflow:s.overflow,visible:e.checkVisibility()}};return {row:rect(r),cells:Array.from(r.children).map(e=>({...rect(e),button:e.querySelector('.task-timer-button')?rect(e.querySelector('.task-timer-button')):null}))}})()`)))
    measurements[`${page}-${width}`] = value; await shot(`${width}-${page}`)
    assert.equal(value.pageOverflow, false); assert(Math.abs(value.card - value.available) < .5)
    if (width > 600) {
      assert(value.aligned && value.centered); assert(Math.abs(value.right) < .5)
      await assertTaskTable(browser)
      assert(value.name >= 220)
      const minimum = page === 'tasks' ? 1188 : 1132
      assert.equal(value.scrollWidth > value.scrollClient + 1, value.scrollClient < minimum)
    } else { assert.equal(value.headerVisible, false); assert(value.scrollWidth <= value.scrollClient + 1) }
  })
  await size(1440); await go('tasks')
  await check('Status is a chevron-free Pill; the common Picker uses keyboard and saves the same status', async () => {
    const selector = `.task-table-row[data-task-id="${tasks[0].id}"]`
    assert.equal(await browser.evaluate(`document.querySelector('${selector} .task-status-trigger').textContent`), '未着手')
    assert.equal(await browser.evaluate(`!!document.querySelector('${selector} .task-status-trigger [data-icon=chevronDown]')`), false)
    await browser.click(selector + ' .task-status-trigger')
    await browser.until(`document.querySelector('${selector} [role=menuitemradio][aria-checked=true]')===document.activeElement`, 'Current status has Focus')
    for (const [key, virtual] of [['ArrowDown', 40], ['Enter', 13]]) {
      await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key, windowsVirtualKeyCode: virtual, ...(key==='Enter'?{text:'\r',unmodifiedText:'\r'}:{}) }); await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: virtual })
    }
    await browser.until(`document.querySelector('${selector} .task-status-trigger')?.textContent==='進行中'`, 'Status saved')
    assert.equal((await api('/tasks')).find(task => task.id === tasks[0].id).status, 'IN_PROGRESS')
    await shot('1440-status-chip')
  })
  await go('home'); await browser.until('document.querySelector(".calendar-comparison-switch")', 'Calendar ready')
  await browser.click('.calendar-comparison-switch button:last-child')
  await browser.until('document.querySelectorAll(".calendar-event.actual").length===6 && document.querySelectorAll(".calendar-event.planned").length===6', 'Calendar data ready')
  await check('Desktop modes share fixed Navigation Arrows and adjacent Mode Selector; comparison text fits', async () => {
    const inspect = () => browser.evaluate(`(()=>{const selectors=['.calendar-period-navigation','[aria-label="前の期間"]','[aria-label="次の期間"]','.today-button','.calendar-mode-switch[aria-label="カレンダー表示"]','.calendar-comparison-switch'],rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,center:r.y+r.height/2,right:r.right}},[w,range]=document.querySelector('.calendar-period-label').children;return {cells:selectors.map(q=>document.querySelector(q)?rect(document.querySelector(q)):null),gap:range?range.getBoundingClientRect().left-w.getBoundingClientRect().right:null,label:document.querySelector('.calendar-period-label').textContent,overflow:document.documentElement.scrollWidth>innerWidth}})()`)
    for (const width of [1920,1024,981]) {
      await size(width)
      const before = await inspect()
      assert(!before.overflow,JSON.stringify(before)); assert.equal(before.gap,16)
      // Keep Navigation and Mode on one line; the comparison Group may wrap when space is insufficient.
      assert(before.cells.slice(0,5).every(c=>Math.abs(c.center-before.cells[0].center)<1),JSON.stringify(before))
      const navigationBottom = Math.max(...before.cells.slice(0,5).map(c=>c.y+c.height))
      assert(Math.abs(before.cells[5].center-before.cells[0].center)<1 || before.cells[5].y>=navigationBottom,JSON.stringify(before))
      for (const control of ['[aria-label="次の期間"]','[aria-label="次の期間"]','[aria-label="前の期間"]','.today-button']) {
        await browser.click(control)
        await browser.until('!document.querySelector(".calendar-schedule-status [role=status]")', 'Navigation loaded')
        const after = await inspect()
        assert.deepEqual(after.cells.slice(1,3),before.cells.slice(1,3), JSON.stringify(after))
      }
      assert.match((await inspect()).label,/^W41\s+10\/5 - 10\/11$/)
      assert(before.cells[4].x>=before.cells[0].right,JSON.stringify(before))
      if (before.cells[5].y<navigationBottom) assert(before.cells[4].right<=before.cells[5].x,JSON.stringify(before))
      const text = await browser.evaluate(`[...document.querySelectorAll('.calendar-comparison-switch button')].map(b=>{const s=getComputedStyle(b),r=b.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(b);const t=range.getBoundingClientRect();return {font:s.fontSize,pad:s.paddingLeft,shrink:s.flexShrink,nowrap:s.whiteSpace,width:r.width,inside:t.left>=r.left+16&&t.right<=r.right-16}})`)
      assert(text.every(b=>b.font==='14px'&&b.pad==='16px'&&b.shrink==='0'&&b.nowrap==='nowrap'&&b.inside),JSON.stringify(text));assert(text[1].width>=144)
      for (const [index,mode] of [[1,'day'],[3,'month'],[2,'week']]) {
        await browser.click('.calendar-mode-switch[aria-label="カレンダー表示"] button:nth-child('+index+')')
        await browser.until(`document.querySelector('.calendar-period-navigation').dataset.mode==='${mode}' && !document.querySelector('.calendar-schedule-status [role=status]')`, 'Mode ready')
        const after = await inspect()
        assert.deepEqual(after.cells.slice(0,4),before.cells.slice(0,4),JSON.stringify(after))
        assert.deepEqual(after.cells[4],before.cells[4],JSON.stringify(after));assert(!after.overflow)
        assert.equal(after.cells[5]!==null,mode==='week')
        for (const control of ['[aria-label="次の期間"]','[aria-label="前の期間"]','.today-button']) {
          const label = (await inspect()).label
          await browser.click(control)
          await browser.until('!document.querySelector(".calendar-schedule-status [role=status]")', 'Period loaded')
          const changed = await inspect()
          assert.deepEqual(changed.cells.slice(1,3),before.cells.slice(1,3));assert.deepEqual(changed.cells[4],before.cells[4])
          if(control!=='.today-button')assert.notEqual(changed.label,label)
        }
      }

    }
    await size(1920); await shot('1920-home-toolbar')
    await size(1440)
  })
  await check('Desktop top rows stay visible while Timeline scrolls; expanded unset rows cap at 128px', async () => {
    await size(1920)
    const inspect = () => browser.evaluate(`(()=>{const box=s=>{const e=document.querySelector(s),r=e.getBoundingClientRect();return{top:r.top,bottom:r.bottom,height:r.height,client:e.clientHeight,scroll:e.scrollHeight}},selectors=['.calendar-week-header:not(.calendar-lane-header)','.calendar-week-metrics','.calendar-time-unset-row','.calendar-date-gutter'];return{header:box('.app-header'),rows:selectors.map(box),timeline:box('.calendar-time-grid'),page:scrollY}})()`)
    const before = await inspect()
    await shot('1920-home-unset-expanded')
    assert(before.rows[2].height <= 128 && before.rows[2].scroll > before.rows[2].client, JSON.stringify(before))
    assert(before.timeline.scroll > before.timeline.client)
    assert(before.rows[0].top >= before.header.bottom && before.timeline.bottom <= 1100)
    await browser.evaluate('document.querySelector(".calendar-time-grid").scrollTop=500;undefined')
    const after = await inspect()
    assert.deepEqual(after.rows, before.rows); assert.equal(after.page, before.page)
    await browser.click('.calendar-row-toggle')
    assert.equal(await browser.evaluate('document.querySelector(".calendar-time-unset-row").dataset.expanded'), 'false')
    assert.equal(await browser.evaluate('document.querySelectorAll(".calendar-time-unset-row .calendar-schedule-chip").length'), 0)
    assert.equal(await browser.evaluate(`document.querySelector('[data-drop-date="2026-10-07"] .calendar-date-count dd').textContent`), '8件')
    await browser.click('.calendar-row-toggle')
    assert.equal(await browser.evaluate('document.querySelectorAll(".calendar-time-unset-row .calendar-schedule-chip").length'), 8)
    assert.equal(await browser.evaluate(`document.querySelectorAll('[data-schedule-block-id="${unsetBlocks[0].id}"] .schedule-block-tag-icon').length`), 1)
    await browser.evaluate('document.querySelector(".calendar-time-unset-row").scrollTop=80;undefined')
    assert.equal(await browser.evaluate('document.querySelector(".calendar-time-grid").scrollTop'), 500)
    const toggle = await browser.evaluate(`(()=>{const row=document.querySelector('.calendar-time-unset-row'),button=row.querySelector('.calendar-row-toggle'),r=row.getBoundingClientRect(),b=button.getBoundingClientRect();return {scrolled:row.scrollTop,inside:b.top>=r.top&&b.bottom<=r.bottom,hit:document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)===button||button.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2))}})()`)
    assert(toggle.scrolled > 0 && toggle.inside && toggle.hit, JSON.stringify(toggle))
    await browser.click('.calendar-row-toggle')
    assert.equal(await browser.evaluate('document.querySelector(".calendar-time-unset-row").dataset.expanded'), 'false')
    await browser.click('.calendar-row-toggle')
    await browser.evaluate('document.querySelector(".calendar-time-unset-row").scrollTop=80;undefined')
    // Keep native event targets and calculate the drop relative to the unchanged lane rect after scroll.
    await browser.evaluate(`(()=>{const source=document.querySelector('[data-schedule-block-id="${unsetBlocks[0].id}"]'),target=document.querySelector('[data-timed-drop-date="2026-10-07"]'),r=target.getBoundingClientRect(),transfer=new DataTransfer(),options={bubbles:true,cancelable:true,dataTransfer:transfer,clientX:r.left+8,clientY:r.top+600};source.dispatchEvent(new DragEvent('dragstart',options));target.dispatchEvent(new DragEvent('dragover',options));target.dispatchEvent(new DragEvent('drop',options));source.dispatchEvent(new DragEvent('dragend',options))})()`)
    await browser.until(`document.querySelector('.weekly-schedule-event[data-schedule-block-id="${unsetBlocks[0].id}"]')`, 'Unset drag into scrolled Timeline saved')
    const moved = (await api('/schedule-blocks')).find(b=>b.id===unsetBlocks[0].id)
    assert.equal(moved.type, 'TIMED')
    assert.equal(moved.startTime.slice(0,5), '11:00')
    await api(`/schedule-blocks/${moved.id}`, { date: '2026-10-07', type: 'TIME_UNSET', startTime: null, durationMinutes: null }, 'PATCH')
    await browser.click('.calendar-mode-switch[aria-label="カレンダー表示"] button:nth-child(2)')
    await browser.until('document.querySelectorAll(".calendar-event.planned").length===6', 'Fixture restored')
    await browser.evaluate('document.querySelector(".calendar-time-grid").scrollTop=0;document.querySelector(".calendar-time-unset-row").scrollTop=0;undefined')
    await size(1440)
  })
  const assertToolbarAccess = async stage => {
    const audit = await browser.evaluate(`(()=>{const toolbar=document.querySelector('.home-calendar-controls'),status=document.querySelector('.calendar-loading-status')??document.querySelector('.calendar-schedule-status'),rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};return {stage:${JSON.stringify(stage)},status:{...rect(status),pointer:getComputedStyle(status).pointerEvents},controls:[...toolbar.querySelectorAll('button')].map(e=>{const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return {text:e.textContent,label:e.getAttribute('aria-label'),rect:rect(e),enabled:!e.disabled,hit:e.contains(hit),hitClass:hit?.getAttribute('class')}})}})()`)
    await browser.evaluate('document.querySelector(".home-calendar-controls button").focus()')
    const focus = []
    for (let index=0;index<audit.controls.length;index++) {
      if(index) for(const type of ['keyDown','keyUp']) await browser.send('Input.dispatchKeyEvent',{type,key:'Tab',code:'Tab',windowsVirtualKeyCode:9})
      focus.push(await browser.evaluate(`document.activeElement===document.querySelectorAll('.home-calendar-controls button')[${index}]`))
    }
    audit.keyboardFocus = focus
    if(stage.endsWith('loading')) {
      const point=await browser.evaluate(`(()=>{const e=document.querySelector('.calendar-mode-switch[aria-label="\u30ab\u30ec\u30f3\u30c0\u30fc\u8868\u793a"] .active'),r=e.getBoundingClientRect();window.__loadingTarget=e;window.__loadingHit=null;document.addEventListener('pointerdown',event=>{window.__loadingHit={expected:e.contains(event.target),target:event.target.className}},{once:true,capture:true});return {x:r.left+r.width/2,y:r.top+r.height/2}})()`)
      for(const type of ['mousePressed','mouseReleased']) await browser.send('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1})
      audit.pointer = await browser.evaluate('window.__loadingHit')
    }
    console.log('Toolbar access',JSON.stringify(audit))
    assert(audit.controls.every(e=>e.enabled&&e.hit),'Loading must not intercept Toolbar button hit targets: '+JSON.stringify(audit))
    assert(focus.every(Boolean),'Toolbar keyboard order remains available during refresh')
    if(audit.pointer) assert(audit.pointer.expected,'Loading must not intercept the real Mode pointer event')
  }
  await check('Desktop refresh and week changes preserve date border and geometry while loading', async () => {
    await size(1920)
    const inspect = () => browser.evaluate(`(()=>{const box=e=>{const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height]},panel=document.querySelector('.week-calendar-panel'),scroll=panel.querySelector('.calendar-grid-scroll');return {date:box(panel.querySelector('.calendar-week-header')),timeline:box(panel.querySelector('.calendar-time-grid')),scroll:box(scroll),border:getComputedStyle(scroll).borderTopWidth,status:getComputedStyle(document.querySelector('.calendar-loading-status')??panel.querySelector('.calendar-schedule-status')).position}})()`)
    const before = await inspect()
    assert.equal(before.border, '1px'); assert.equal(before.status, 'absolute'); await assertToolbarAccess('week-normal')
    for (const control of ['.calendar-mode-switch[aria-label="カレンダー表示"] button:nth-child(2)', '[aria-label="次の期間"]']) {
      let release
      loadingGate = { promise: new Promise(resolve => { release = resolve }), release: () => release() }
      try {
        await browser.click(control)
        await browser.until('document.querySelector(".calendar-schedule-status [role=status]")', 'Loading visible')
        await browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
        assert.deepEqual(await inspect(), before)
        await assertToolbarAccess('week-loading'); await shot('1920-home-loading')
      } finally { loadingGate.release(); loadingGate = null }
      await browser.until('!document.querySelector(".calendar-schedule-status [role=status]")', 'Loading finished')
      assert.deepEqual((await inspect()).date, before.date)
    }
    await browser.click('[aria-label="前の期間"]')
    await browser.until('document.querySelectorAll(".calendar-event.planned").length===6 && !document.querySelector(".calendar-schedule-status [role=status]")', 'Original week restored')
    await browser.click('.calendar-mode-switch[aria-label="カレンダー表示"] button:first-child')
    await browser.until('document.querySelector(".single-day") && !document.querySelector(".calendar-schedule-status [role=status]")', 'Day loaded')
    const dayBefore = await inspect()
    let releaseDay
    loadingGate = { promise: new Promise(resolve => { releaseDay = resolve }), release: () => releaseDay() }
    try {
      await browser.click('[aria-label="次の期間"]')
      await browser.until('document.querySelector(".calendar-schedule-status [role=status]")', 'Day loading visible')
      assert.deepEqual(await inspect(), dayBefore)
      await assertToolbarAccess('day-loading')
      await shot('1920-home-day-loading')
    } finally { loadingGate.release(); loadingGate = null }
    await browser.until('!document.querySelector(".calendar-schedule-status [role=status]")', 'Day request completed')
    await browser.click('.calendar-mode-switch[aria-label="カレンダー表示"] button:nth-child(2)')
    await browser.until('!document.querySelector(".single-day") && document.querySelectorAll(".calendar-event.planned").length===6 && !document.querySelector(".calendar-schedule-status [role=status]")', 'Week restored')
    await browser.evaluate('document.querySelector(".calendar-time-grid").scrollTop=99999;undefined')
    assert.deepEqual((await inspect()).date, before.date)
    await shot('1920-home-timeline-bottom')
    await browser.evaluate('document.querySelector(".calendar-time-grid").scrollTop=0;undefined')
    await size(1440)
  })
  await check('Plan and recorded Blocks share matte project surfaces and neutral text, preserving snapshot colors', async () => {
    const value = await browser.evaluate(`Array.from(document.querySelectorAll('.calendar-event')).map(e=>{const s=getComputedStyle(e);return{task:Number(e.dataset.taskId),actual:e.classList.contains('actual'),bg:s.backgroundColor,text:s.color,accent:s.borderLeftColor,accentStyle:s.borderLeftStyle}})`)
    for (let i = 0; i < 5; i++) {
      const pair = value.filter(item => item.task === tasks[i].id)
      assert.equal(pair.length, 2); assert.equal(pair[0].bg, pair[1].bg); assert.equal(pair[0].accent, pair[1].accent)
      for (const item of pair) { assert.equal(item.text, 'rgb(15, 23, 42)'); assert.equal(item.accent, 'rgba(0, 0, 0, 0)') }
    }
    assert.equal(new Set(value.filter(item => !item.actual && item.task !== tasks[5].id).map(item => item.bg)).size, 5)
    const snapshot = value.find(item => item.task === tasks[5].id && item.actual), blue = value.find(item => item.task === tasks[0].id && item.actual)
    assert.equal(snapshot.bg, blue.bg); assert.equal(snapshot.accent, blue.accent)
    assert.notEqual(snapshot.bg, value.find(item => item.task === tasks[5].id && !item.actual).bg)
    const density = await browser.evaluate(`Array.from(document.querySelectorAll('.weekly-schedule-event')).map(e=>({id:Number(e.dataset.scheduleBlockId),density:e.dataset.density,tags:e.querySelectorAll('.schedule-block-tag-icon').length,tagText:e.querySelectorAll('.tag-chip').length,extra:e.textContent,project:!!e.querySelector('.schedule-block-project'),icons:e.querySelectorAll('[data-icon=folder]').length,duration:getComputedStyle(e.querySelector('.schedule-block-duration')).display,first:e.firstElementChild.tagName,height:e.style.height,durationFits:e.querySelector('.schedule-block-duration').getBoundingClientRect().bottom<=e.getBoundingClientRect().bottom}))`)
    for (const [index, expected] of ['full','medium','short','short'].entries()) {
      const item = density.find(item => item.id === blocks[index].id)
      assert.equal(item.density,expected); assert.equal(item.tags,index===2?0:1); assert.equal(item.tagText,0)
      assert.equal(item.duration,index===3?'none':'block')
      if(index!==3)assert(item.durationFits,JSON.stringify(item))
    }
    assert(density.every(item=>!tags.some(tag=>item.extra.includes(tag.name))&&!item.extra.includes('+2')))
    assert.equal(density.find(item=>item.id===blocks[4].id).project,false)
    assert(density.every(item=>item.first==='STRONG'), 'Task title remains the first content; Project icons never replace it')
    const currentTasks = await api('/tasks')
    const projectLines = await browser.evaluate(`[...document.querySelectorAll('.calendar-event')].map(e=>({taskId:Number(e.dataset.taskId),entryId:Number(e.dataset.timeEntryId),actual:e.classList.contains('actual'),name:e.querySelector('.task-project-name')?.textContent??null,icons:[...e.querySelectorAll('[data-icon=folder]')].map(icon=>({inProject:!!icon.closest('.task-project-value'),inTitle:!!icon.closest('strong'),color:icon.dataset.projectColor,hidden:icon.getAttribute('aria-hidden'),interactive:!!icon.closest('button,a,[role=button]:not(.calendar-event)')}))}))`)
    for (const line of projectLines) {
      const task = currentTasks.find(task=>task.id===line.taskId)
      const projectId = line.actual ? entries.find(entry=>entry.id===line.entryId).projectIdSnapshot : task.projectId
      const project = projects.find(project=>project.id===projectId)
      assert.equal(line.name, project?.name??null, 'Project label follows current Task or historical Entry Snapshot')
      assert.equal(line.icons.length, project ? 1 : 0, 'Only an assigned Project has its semantic ProjectIcon')
      for (const icon of line.icons) {
        assert(icon.inProject && !icon.inTitle && !icon.interactive, 'Folder belongs only to the noninteractive Project label')
        assert.equal(icon.hidden,'true'); assert.equal(icon.color,project.color)
      }
    }
    assert(await browser.evaluate(`[...document.querySelectorAll('.calendar-event')].every(e=>{const style=getComputedStyle(e),title=e.querySelector('strong'),text=getComputedStyle(title),icon=e.querySelector('.schedule-block-tag-icon'),r=e.getBoundingClientRect(),t=title.getBoundingClientRect();return style.minWidth==='0px'&&style.overflow==='hidden'&&style.paddingTop===(e.dataset.density==='full'?'8px':e.dataset.density==='medium'?'4px':'0px')&&style.paddingLeft==='4px'&&style.paddingRight==='4px'&&text.textOverflow==='ellipsis'&&text.whiteSpace==='nowrap'&&t.left>=r.left&&t.right<=r.right&&(!icon||getComputedStyle(icon).pointerEvents==='none'&&!icon.closest('button')&&!icon.onclick)})`), JSON.stringify(await browser.evaluate(`[...document.querySelectorAll('.calendar-event')].map(e=>{const s=getComputedStyle(e),t=getComputedStyle(e.querySelector('strong')),r=e.getBoundingClientRect(),c=e.querySelector('strong').getBoundingClientRect();return{class:e.className,min:s.minWidth,overflow:s.overflow,pad:s.padding,ellipsis:t.textOverflow,white:t.whiteSpace,bounds:[r.left,r.right,c.left,c.right]}})`)))
    const titleSamples = ['名称未設定','Hello!?()...','API-v2_test','12345','【全角！？】','長いTask名 Hello!?()...'.repeat(20)]
    for (const sample of titleSamples) {
      const result = await browser.evaluate(`(()=>{const e=document.querySelector('.weekly-schedule-event[data-density="full"]'),title=e.querySelector('strong'),original=title.textContent,read=()=>{const t=getComputedStyle(title),s=getComputedStyle(e);return [t.fontWeight,t.color,t.lineHeight,t.padding,s.paddingTop]},before=read();title.textContent=${JSON.stringify(sample)};const after=read(),r=e.getBoundingClientRect(),t=title.getBoundingClientRect();title.textContent=original;return{before,after,inside:t.left>=r.left&&t.right<=r.right&&t.top-r.top>=8}})()`)
      assert.deepEqual(result.after,result.before); assert.equal(result.after[0],'800'); assert(result.inside,JSON.stringify(result))
    }
    const footers = await browser.evaluate(`[...document.querySelectorAll('.calendar-event')].map(e=>{const f=e.querySelector('.calendar-block-footer'),d=f.querySelector('small'),icon=f.querySelector('.schedule-block-tag-icon'),r=e.getBoundingClientRect(),dr=d.getBoundingClientRect(),ir=icon?.getBoundingClientRect();return {task:e.dataset.taskId,class:e.className,bounds:[r.left,r.right,r.bottom,dr.left,dr.right,dr.bottom],footer:[f.getBoundingClientRect().width,f.getBoundingClientRect().height],visible:getComputedStyle(f).display!=='none',taskWeight:getComputedStyle(e.querySelector('strong')).fontWeight,projectWeight:e.querySelector('.calendar-block-project')&&getComputedStyle(e.querySelector('.calendar-block-project')).fontWeight,durationWeight:getComputedStyle(d).fontWeight,durationColor:getComputedStyle(d).color,text:getComputedStyle(e).color,inside:dr.left>=r.left&&dr.right<=r.right&&dr.bottom<=r.bottom,iconRight:!ir||ir.left>=dr.right,aligned:!ir||Math.abs(ir.top-dr.top)<1,filled:!icon||getComputedStyle(icon.querySelector('svg')).fill===getComputedStyle(icon.querySelector('svg')).color,same:!icon||icon.querySelector('path').getAttribute('d')===document.querySelector('.global-top-timer [data-icon=tag] path').getAttribute('d')}})`)
    for (const f of footers) { assert.equal(f.taskWeight,'800'); if(f.projectWeight)assert.equal(f.projectWeight,'600'); assert.equal(f.durationWeight,'700'); assert.equal(f.durationColor,f.text); assert(f.filled&&f.same); if(f.visible)assert(f.inside&&f.iconRight&&f.aligned,JSON.stringify(f)) }
    await browser.click(`.calendar-event.actual[data-task-id="${tasks[0].id}"]`)
    await browser.until('document.querySelector(".time-entry-dialog .calendar-popover-tags")', 'Recorded Block also exposes Task Tags in existing details')
    assert.deepEqual(await browser.evaluate(`[...document.querySelectorAll('.time-entry-dialog .calendar-popover-tags .tag-chip')].map(e=>e.textContent).sort()`), tags.map(tag=>tag.name).sort())
    await browser.click('[aria-label="記録の操作を閉じる"]')
    measurements.colors = value
  })
  await check('Each date spans two equal lanes; solid date boundaries align through all rows with neutral non-Today columns', async () => {
    const value = await browser.evaluate(`(()=>{const selectors=['.calendar-week-header:not(.calendar-lane-header)>button','.calendar-week-metrics>div','.calendar-combined-row>.calendar-schedule-cell','.calendar-day-column'],rows=selectors.map(q=>[...document.querySelectorAll(q)].map(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return{left:r.left,right:r.right,border:s.borderLeftWidth,style:s.borderLeftStyle,bg:s.backgroundColor}}));const lanes=[...document.querySelectorAll('.calendar-day-column')].map(e=>{const p=e.querySelector('.calendar-plan-lane').getBoundingClientRect(),a=e.querySelector('.calendar-actual-lane').getBoundingClientRect(),s=getComputedStyle(e.querySelector('.calendar-actual-lane'));return{plan:p.width,actual:a.width,edge:a.left-p.right,border:s.borderLeftWidth,style:s.borderLeftStyle,bg:s.backgroundColor}});return{rows,lanes,labels:[...document.querySelectorAll('.home-metrics dt')].map(e=>e.textContent),laneHeader:getComputedStyle(document.querySelector('.calendar-lane-header')).display}})()`)
    assert.equal(value.rows[0].length, 7)
    for (const row of value.rows) for (const [i, item] of row.entries()) { assert.equal(item.border, '2px'); assert.equal(item.style, 'solid'); assert(Math.abs(item.left - value.rows[0][i].left) < .5 && Math.abs(item.right - value.rows[0][i].right) < .5) }
    assert.equal(value.rows.at(-1)[0].bg, value.rows.at(-1)[1].bg)
    for (const lane of value.lanes) { assert(Math.abs(lane.plan - lane.actual) < .5 && Math.abs(lane.edge) < .5); assert.equal(lane.border, '1px'); assert.equal(lane.style, 'solid'); assert.equal(lane.bg, 'rgba(0, 0, 0, 0)') }
    assert.deepEqual(value.labels, Array.from({length:7},()=>['計画済み','記録']).flat()); assert.equal(value.laneHeader, 'none'); measurements.days = value
    assert(await browser.evaluate(`(()=>{const days=[...document.querySelectorAll('.calendar-day-column')];return [...document.querySelectorAll('.calendar-week-metrics>div')].every((cell,i)=>[...cell.querySelector('dl').children].every((metric,j)=>{const lane=days[i].querySelector(j?'.calendar-actual-lane':'.calendar-plan-lane').getBoundingClientRect(),center=lane.left+lane.width/2;return [...metric.children].every(text=>{const r=text.getBoundingClientRect();return Math.abs(r.left+r.width/2-center)<1})}))})()`), 'Both metric labels and values center on their actual 50% Timeline subcolumn')
    await shot('1440-calendar-week')
  })
  for (const width of [1920, 1024, 768, 375]) await check(`Home Calendar ${width}px retains local scrolling and two-lane date groups`, async () => {
    await size(width)
    assert.equal(await browser.evaluate('document.documentElement.scrollWidth>innerWidth'), false, JSON.stringify(await browser.evaluate(`({width:innerWidth,scroll:document.documentElement.scrollWidth,items:[...document.querySelectorAll('.app-main,.home-workspace,.calendar-page,.home-calendar-header,.home-calendar-layout,.week-calendar-panel,.calendar-grid-scroll,.calendar-grid-content')].map(e=>({class:e.className,left:e.getBoundingClientRect().left,width:e.getBoundingClientRect().width,right:e.getBoundingClientRect().right,min:getComputedStyle(e).minWidth,overflow:getComputedStyle(e).overflowX}))})`)))
    assert.equal(await browser.evaluate('document.querySelectorAll(".calendar-lane-header>div>span").length'), 14)
    if (width === 1024) {
      await browser.evaluate('document.querySelector(".calendar-grid-scroll").scrollLeft=40;undefined')
      assert(await browser.evaluate('document.querySelector(".calendar-grid-scroll").scrollLeft>0'))
      assert(await browser.evaluate(`(()=>{const selectors=['.calendar-week-header:not(.calendar-lane-header)>button','.calendar-week-metrics>div','.calendar-combined-row>.calendar-schedule-cell','.calendar-day-column'],rows=selectors.map(s=>[...document.querySelectorAll(s)].map(e=>e.getBoundingClientRect().left));return rows.every(row=>row.every((x,i)=>Math.abs(x-rows[0][i])<.5))})()`))
      await browser.evaluate('document.querySelector(".calendar-grid-scroll").scrollLeft=0;undefined')
    }
    await shot(`${width}-calendar-week`)
  })
  await size(1440)
  await check('Plan-only and Day views retain their column widths and project colors', async () => {
    await browser.click('.calendar-comparison-switch button:first-child')
    await browser.until('document.querySelectorAll(".calendar-actual-lane").length===0', 'Plan-only')
    assert.equal(await browser.evaluate('document.querySelector(".calendar-plan-lane").style.width'), '100%')
    await shot('1440-calendar-plan-only')
    await browser.click('.calendar-week-header:not(.calendar-lane-header)>button:nth-child(4)')
    await browser.click('.calendar-mode-switch[aria-label="カレンダー表示"] button:first-child')
    await browser.until('document.querySelectorAll(".calendar-day-column").length===1 && document.querySelectorAll(".calendar-event.actual").length===6', 'Day view')
    assert.equal(await browser.evaluate('document.querySelectorAll(".calendar-lane-header>div>span").length'), 2)
    await shot('1440-calendar-day')
    await browser.click('.calendar-mode-switch[aria-label="カレンダー表示"] button:last-child')
    await browser.until('document.querySelector(".month-grid")', 'Month view')
    const monthChips = await browser.evaluate(`[...document.querySelectorAll('.month-task-chip')].map(e=>({task:Number(e.dataset.taskId),icons:e.querySelectorAll('.schedule-block-tag-icon').length}))`)
    const taggedTasks = new Set([...tasks.filter((_,i)=>i!==2).map(t=>t.id), unsetBlocks[0].taskId])
    assert(monthChips.length && monthChips.some(chip=>chip.icons===1))
    assert(monthChips.every(chip=>chip.icons===(taggedTasks.has(chip.task)?1:0)),JSON.stringify(monthChips))
    assert.equal(await browser.evaluate('document.querySelectorAll(".month-task-chip .tag-chip").length'), 0)
    // Shared Project/Tag line owns the marker; the duration remains in its Footer.
    assert(await browser.evaluate(`[...document.querySelectorAll('.month-task-chip[data-schedule-type="TIMED"]')].every(e=>{const f=e.querySelector('.calendar-block-footer'),icon=e.querySelector('.schedule-block-tag-icon'),d=f?.querySelector('small');return f&&d&&(!icon||icon.closest('.task-project-tags')?.parentElement===e&&!icon.closest('button')&&getComputedStyle(icon).position==='static'&&getComputedStyle(icon).pointerEvents==='none')})`))
    assert(await browser.evaluate(`[...document.querySelectorAll('.month-task-chip[data-schedule-type="TIMED"] .calendar-block-project')].every(e=>getComputedStyle(e).fontWeight==='600')`), 'Shared Project label preserves its Month weight through the wrapper')
  })
  for (const page of ['projects', 'reports']) await check(`${page} smoke check retains shared Header and viewport fit`, async () => { await go(page); assert(await browser.evaluate('!!document.querySelector(".global-top-timer") && document.documentElement.scrollWidth<=innerWidth')); await shot(`1440-${page}`) })
  assert.deepEqual(errors, [])
  const result = { base, checks, measurements, requests, errors, normalBackendWrites: 0 }
  if (output) await writeFile(new URL('../../ui-table-calendar-browser-evidence.json', output), JSON.stringify(result, null, 2))
  return result
}

// Synthetic GET-only matrix: measure real Loading geometry and browser input,
// independently of the seeded Table/Calendar acceptance scenarios above.
export async function calendarLoadingPlacementAcceptance(t) {
  const output=process.env.LOADING_AUDIT_DIR??await mkdtemp(path.join(tmpdir(),'calendar-loading-layout-'))
  await mkdir(output,{recursive:true})
  const baseline=process.env.LOADING_BASELINE?JSON.parse(await readFile(process.env.LOADING_BASELINE,'utf8')):{metrics:[]}
  const b=await openBrowser(),metrics=[],errors=[],writes=[]
  let gate=null,failSchedules=false
  t.after(async()=>{gate?.release();await writeFile(path.join(output,'loading.json'),JSON.stringify({metrics,errors,writes},null,2));await b.close()})
  b.listeners.push(message=>{
    if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails)
    if(message.method!=='Fetch.requestPaused')return
    const {requestId,request}=message.params,u=new URL(request.url)
    void(async()=>{
      assert.equal(u.origin,'http://localhost:8000')
      if(request.method==='OPTIONS')return b.fulfill(requestId,{})
      if(request.method!=='GET'){writes.push({method:request.method,path:u.pathname});assert.fail('Loading controls never mutate data')}
      if(gate&&(u.pathname==='/schedule-blocks'||u.pathname==='/time-entries'))await gate.promise
      if(failSchedules&&u.pathname==='/schedule-blocks')return b.fulfill(requestId,{detail:'Controlled loading failure'},500)
      await b.fulfill(requestId,u.pathname==='/tasks/time/active'?{taskId:null,running:false,startedAt:null}:u.pathname==='/reports/daily'?{date:u.searchParams.get('date'),tasks:[]}:[])
    })().catch(error=>{if(!/Invalid [Ii]nterceptionId|Invalid requestId/.test(error.message))errors.push(String(error))})
  })
  await b.send('Fetch.enable',{patterns:[{urlPattern:'http://localhost:8000/*',requestStage:'Request'}]})
  await b.send('Emulation.setTimezoneOverride',{timezoneId:'Asia/Tokyo'})
  await b.send('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{const D=Date,n=${Date.parse('2026-10-09T12:00:00+09:00')};window.Date=class extends D{constructor(...a){super(...(a.length?a:[n]))}static now(){return n}};window.__loadingClicks=[];document.addEventListener('pointerdown',e=>window.__loadingClicks.push({hit:window.__loadingExpected?.contains(e.target),target:e.target.className}),true)})()`})
  const frames=()=>b.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  const ready=async()=>{await b.until('document.querySelector(".calendar-grid-content,.month-grid")&&!document.querySelector(".calendar-page [role=status],.calendar-page [role=alert]")','Calendar ready');await b.until('document.querySelector(".app-layout").getAnimations({subtree:true}).every(a=>a.playState!=="running")','Layout settled');await frames()}
  const pointer=async selector=>{
    await b.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest',inline:'nearest'});window.__loadingExpected=e})()`);await frames()
    const p=await b.evaluate(`(()=>{const e=window.__loadingExpected,r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return{x,y,hit:e.contains(document.elementFromPoint(x,y)),enabled:!e.disabled}})()`)
    assert(p.hit&&p.enabled,'Uncovered enabled pointer target '+selector+': '+JSON.stringify(p))
    for(const type of ['mousePressed','mouseReleased'])await b.send('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,x:p.x,y:p.y})
    const hit=await b.evaluate('window.__loadingClicks.at(-1)');assert(hit.hit,JSON.stringify(hit));return hit
  }
  const key=async(name,code)=>{for(const type of ['keyDown','keyUp'])await b.send('Input.dispatchKeyEvent',{type,key:name,code:name,windowsVirtualKeyCode:code,...(type==='keyDown'&&name==='Enter'?{text:'\r'}:{})})}
  const measure=()=>b.evaluate(`(()=>{const toolbar=document.querySelector('.home-calendar-controls'),rect=e=>{const r=e.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}},visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility==='visible'};return {header:rect(document.querySelector('.home-calendar-header')),global:rect(document.querySelector('.app-header')),toolbar:rect(toolbar),nav:rect(toolbar.querySelector('.calendar-navigation-controls')),grid:rect(document.querySelector('.calendar-grid-scroll,.month-grid')),controls:[...toolbar.querySelectorAll('button')].map(e=>{const r=e.getBoundingClientRect();return{text:e.textContent,rect:rect(e),enabled:!e.disabled,hit:e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))}}),statuses:[...document.querySelectorAll('.calendar-page [role=status]')].filter(visible).map(e=>({rect:rect(e),text:e.textContent,client:e.clientWidth,scroll:e.scrollWidth,visibility:getComputedStyle(e).visibility})),page:{client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}}})()`)
  const overlap=(a,b)=>Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))*Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top))
  const modeButtons='.calendar-period-controls > .calendar-mode-switch > button'
  for(const width of [375,600,768,980,981,982,1024,1440,1920])for(const collapsed of width>=768?[false,true]:[false])for(const mode of ['day','week','month']){
    await t.test(`${width}px Sidebar ${collapsed?'closed':'open'} ${mode}: visible Loading, unchanged controls, pointer, keyboard and recovery`,async()=>{
      failSchedules=false
      await b.send('Emulation.setDeviceMetricsOverride',{width,height:1080,deviceScaleFactor:1,mobile:false});await b.navigate();await ready()
      if(width>=768&&await b.evaluate('document.querySelector(".app-layout").dataset.sidebarCollapsed')!==String(collapsed))await b.click('[data-sidebar-toggle]')
      await b.until(`document.querySelector('.app-layout').dataset.sidebarCollapsed===${JSON.stringify(String(collapsed))}`,'Sidebar state');await ready()
      await pointer(modeButtons+`:nth-child(${['day','week','month'].indexOf(mode)+1})`);await b.until(`document.querySelector('.calendar-period-navigation').dataset.mode===${JSON.stringify(mode)}`,'Selected Mode displayed');await ready()
      const before=await measure(),label=await b.evaluate('document.querySelector(".calendar-period-label").textContent')
      const result={width,collapsed,mode,before};metrics.push(result)
      const old=baseline.metrics.find(m=>m.width===width&&m.collapsed===collapsed&&m.mode===mode)
      if(old)for(const field of ['header','toolbar','nav','grid','controls'])assert.deepEqual(before[field],old.before[field],'Preserve normal-state '+field)
      let release;gate={promise:new Promise(resolve=>release=resolve),release:()=>release()}
      try{
        result.previousHit=await pointer('.calendar-period-navigation > button:first-child')
        await b.until('document.querySelector(".calendar-page [role=status]")','Request held');await frames()
        const loading=await measure();result.loading=loading
        assert(loading.statuses.length>0,'Loading text must have positive visible dimensions')
        for(const status of loading.statuses){assert(status.rect.width>0&&status.rect.height>0&&status.visibility==='visible');assert(status.scroll<=status.client+1,'Loading text fits without clipping');for(const control of loading.controls)assert.equal(overlap(status.rect,control.rect),0,'Loading must not visually overlap a control')}
        for(const field of ['header','toolbar','nav','grid','controls'])assert.deepEqual(loading[field],before[field],'Loading preserves '+field)
        assert(loading.page.scroll<=loading.page.client,'No page horizontal overflow')
        for(let i=0;i<loading.controls.length;i++)for(let j=i+1;j<loading.controls.length;j++)assert.equal(overlap(loading.controls[i].rect,loading.controls[j].rect),0,'Controls never overlap')
        assert(loading.controls.every(e=>e.enabled&&e.hit),'Enabled controls retain their hit targets')
        await b.evaluate('document.querySelector(".home-calendar-controls button").focus()')
        for(let i=1;i<loading.controls.length;i++){await key('Tab',9);assert(await b.evaluate(`document.activeElement===document.querySelectorAll('.home-calendar-controls button')[${i}]`),'Existing Tab order')}
        await b.evaluate('document.querySelector(".home-calendar-controls .today-button").focus()')
        result.focus=await b.evaluate('(()=>{const e=document.activeElement,s=getComputedStyle(e);return{visible:e.matches(":focus-visible"),outline:s.outlineStyle,shadow:s.boxShadow,overflow:getComputedStyle(e.closest(".home-calendar-header")).overflow}})()')
        assert(result.focus.visible&&(result.focus.outline!=='none'||result.focus.shadow!=='none')&&result.focus.overflow==='visible','Visible unclipped Keyboard Focus')
        await key('Enter',13)
        result.nextHit=await pointer('.calendar-period-navigation > button:last-child')
        result.todayHit=await pointer('.home-calendar-controls .today-button')
        result.modeHit=await pointer(modeButtons+'.active')
        if(mode==='week'){result.planHit=await pointer('.calendar-comparison-switch > button:first-child');result.compareHit=await pointer('.calendar-comparison-switch > button:last-child')}
        if(mode==='week'&&[375,981,1024,1920].includes(width)){const {data}=await b.send('Page.captureScreenshot',{format:'png'});await writeFile(path.join(output,`loading-${width}-${collapsed}.png`),Buffer.from(data,'base64'))}
      }finally{release();gate=null;await ready()}
      assert.equal(await b.evaluate('document.querySelector(".calendar-period-label").textContent'),label,'Today selection survives pending navigation')
      const after=await measure();for(const field of ['header','toolbar','nav','grid','controls'])assert.deepEqual(after[field],before[field],'Recovery preserves '+field)
      if(mode==='week'){
        failSchedules=true;await pointer('.calendar-period-navigation > button:last-child');await b.until('document.querySelector(".calendar-schedule-status [role=alert]")','Error visible')
        const error=await measure();result.error=error;assert(error.controls.every(e=>e.enabled&&e.hit),'Errors do not cover Toolbar')
        const retry='.calendar-schedule-status [role=alert] button'
        await b.evaluate(`document.querySelector(${JSON.stringify(retry)}).focus()`);assert(await b.evaluate(`document.activeElement===document.querySelector(${JSON.stringify(retry)})`))
        failSchedules=false;result.retryHit=await pointer(retry);await ready()
        await pointer('.home-calendar-controls .today-button');await ready();assert.equal(await b.evaluate('document.querySelector(".calendar-period-label").textContent'),label)
      }
    })
  }
  assert.deepEqual(errors,[]);assert.deepEqual(writes,[])
  console.log('Loading geometry:',path.join(output,'loading.json'))
}
