import assert from 'node:assert/strict'
import test from 'node:test'
import { openBrowser } from './browser.mjs'

test('Global scroll gutter and three Page Headers stay aligned across navigation (API mock only)', { timeout: 120000 }, async t => {
  const browser = await openBrowser()
  t.after(() => browser.close())
  const tasks = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, title: `Task ${i + 1}`, projectId: 1, projectName: 'Project 1', status: 'NOT_STARTED', completed: false, estimatedMinutes: 60, actualMinutes: 60, tags: [], priority: null, deadline: null }))
  const projects = [1, 2].map(id => ({ id, name: `Project ${id}`, color: '#368AD8', taskCount: id === 1 ? 30 : 0, completedCount: 0, estimatedMinutes: 1800, actualMinutes: 1800 }))
  const entries = tasks.map(task => ({ id: task.id, taskId: task.id, projectIdSnapshot: 1, startedAt: '2026-10-07T10:00:00+09:00', endedAt: '2026-10-07T11:00:00+09:00' }))
  const errors = []
  await browser.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' })
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false })
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{const D=Date,now=${Date.parse('2026-10-07T12:00:00+09:00')};window.Date=class extends D{constructor(...a){super(...(a.length?a:[now]));}static now(){return now}}})()` })
  browser.listeners.push(message => {
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method !== 'Fetch.requestPaused') return
    const { requestId, request } = message.params, url = new URL(request.url), path = url.pathname
    void (async () => {
      if (request.method === 'OPTIONS') return browser.fulfill(requestId, {})
      assert.equal(request.method, 'GET', 'Navigation must not mutate data')
      let data = []
      if (path === '/tasks' || path === '/tasks/inbox') data = tasks
      else if (path === '/projects') data = projects
      else if (path === '/tasks/time/active') data = { taskId: null, running: false, startedAt: null }
      else if (/^\/tasks\/\d+\/time-entries$/.test(path)) data = entries.filter(entry => entry.taskId === Number(path.split('/')[2]))
      else if (path === '/reports/daily') data = { date: url.searchParams.get('date'), tasks: [], plannedOccupiedMinutes: 0, dailyEstimatedMinutes: 0, dailyActualMinutes: 0, dailyDifference: 0 }
      await browser.fulfill(requestId, data)
    })().catch(error => { if (!/Invalid .*nterception|Invalid requestId/.test(error.message)) errors.push(String(error)) })
  })
  await browser.send('Fetch.enable', { patterns: [{ urlPattern: 'http://localhost:8000/*', requestStage: 'Request' }] })
  await browser.navigate()
  await browser.until('!!document.querySelector(".icon-rail") && document.querySelectorAll(".inbox-task-card").length===30', 'Workspace ready')
  const nav = async (label, page, ready) => {
    await browser.click(`.icon-rail [aria-label="${label}"]`)
    await browser.until(`document.querySelector('.app-layout').dataset.page===${JSON.stringify(page)} && (${ready})`, `${page} ready`)
    await browser.until('document.querySelector(".app-layout").getAnimations().every(animation=>animation.playState!=="running")', 'Shell transition complete')
    await browser.evaluate('window.scrollTo(0,0)')
  }
  const measure = () => browser.evaluate(`(()=>{
    const rect=selector=>{const e=document.querySelector(selector),r=e?.getBoundingClientRect();return r?{x:r.x,right:r.right,width:r.width,top:r.top}:null};
    const header=Array.from(document.querySelectorAll('.workspace-page-heading')).find(e=>e.getBoundingClientRect().width>0),title=header?.querySelector('h1'),style=title&&getComputedStyle(title),count=header?.querySelector('p'),action=header?.querySelector('.primary-action');
    const root=document.scrollingElement;
    return {page:document.querySelector('.app-layout').dataset.page,owner:root.tagName,scrollHeight:root.scrollHeight,clientHeight:root.clientHeight,rootWidth:root.clientWidth,rootGutter:getComputedStyle(root).scrollbarGutter,
      candidates:['html','body','#root','.app-layout','.app-main'].map(selector=>{const e=document.querySelector(selector),s=getComputedStyle(e);return {selector,overflowY:s.overflowY,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight}}),
      header:rect('.app-header'),timer:rect('.global-top-timer'),search:rect('.global-top-timer .header-timer-task'),project:rect('.global-top-timer .timer-project-trigger'),tag:rect('.global-top-timer .tag-picker-trigger'),start:rect('.global-top-timer .timer-play-button'),main:rect('.app-main'),
      title:title?{x:title.getBoundingClientRect().x,top:title.getBoundingClientRect().top,fontSize:style.fontSize,fontWeight:style.fontWeight,lineHeight:style.lineHeight,color:style.color}:null,
      pageHeader:header?{marginBottom:getComputedStyle(header).marginBottom,actionTop:action?.getBoundingClientRect().top,actionRight:action?.getBoundingClientRect().right,countStyle:count?{fontSize:getComputedStyle(count).fontSize,color:getComputedStyle(count).color,lineHeight:getComputedStyle(count).lineHeight,marginTop:getComputedStyle(count).marginTop}:null}:null};
  })()`)
  const measurements = [await measure()]
  await nav('タスク', 'tasks', 'document.querySelectorAll(".task-table-row").length===30'); measurements.push(await measure())
  await nav('プロジェクト', 'projects', 'document.querySelectorAll(".project-card").length===2'); measurements.push(await measure())
  await browser.click('.project-card-open')
  await browser.until('!!document.querySelector(".project-detail-panel") && document.querySelectorAll(".task-table-row").length===30', 'Project detail ready')
  measurements.push(await measure())
  await nav('レポート', 'reports', '!!document.querySelector(".reports-v2 .report-summary")'); measurements.push(await measure())
  if (process.env.HEADER_SCROLL_INSPECT) { console.log(JSON.stringify(measurements, null, 2)); return }
  await t.test('Real root scroll owner reserves gutter for overflowing and short pages', () => {
    assert(measurements.some(row => row.scrollHeight > row.clientHeight))
    assert(measurements.some(row => row.scrollHeight <= row.clientHeight))
    for (const row of measurements) { assert.equal(row.owner, 'HTML'); assert.equal(row.rootGutter, 'stable') }
  })
  await t.test('Header Timer search Project Tag Start and main edges do not shift', () => {
    for (const row of measurements) for (const name of ['header','timer','search','project','tag','start','main']) {
      assert(row[name], name)
      // Home intentionally retains its 192px task panel; compare other main
      // edges against Tasks after the existing shell transition has completed.
      const reference = name === 'main' && row.page !== 'home' ? measurements[1] : measurements[0]
      for (const key of ['x','right','width']) assert(Math.abs(row[name][key]-reference[name][key])<0.6, `${row.page} ${name}.${key}: ${row[name][key]} vs ${reference[name][key]}`)
    }
  })
  await t.test('Tasks Projects Reports share title geometry and count/action rules', () => {
    const pages = measurements.filter(row => ['tasks','projects','reports'].includes(row.page))
    for (const row of pages) { assert.deepEqual(row.title,pages[0].title); assert.equal(row.pageHeader.marginBottom,pages[0].pageHeader.marginBottom) }
    assert.deepEqual(pages[0].pageHeader.countStyle,pages[1].pageHeader.countStyle)
    assert.equal(pages[0].pageHeader.actionTop,pages[1].pageHeader.actionTop)
    assert.equal(pages[0].pageHeader.actionRight,pages[1].pageHeader.actionRight)
  })
  await t.test('Reports has no eyebrow and Task filters keep their own panel', async () => {
    assert.equal(await browser.evaluate('document.querySelector(".app-main").textContent.includes("REPORTS")'), false)
    await nav('タスク','tasks','!!document.querySelector(".task-list-heading")')
    assert(await browser.evaluate('!document.querySelector(".task-list-toolbar .task-list-heading") && !!document.querySelector(".task-list-toolbar.panel .task-search") && !!document.querySelector(".task-list-toolbar.panel .task-filter-area")'))
  })
  assert.deepEqual(errors, [])
})
