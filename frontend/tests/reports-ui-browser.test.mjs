import assert from 'node:assert/strict'
import test from 'node:test'
import { openBrowser } from './browser.mjs'
import { assertReportTooltip, selectReportRange } from './report-picker.mjs'
import { reportChartScale } from '../src/reportChart.ts'

test('Reports UI reuses Calendar ranges, readable axes and compact weekly breakdown (API mocked, no DB)', { timeout: 120000 }, async t => {
  const browser = await openBrowser()
  t.after(() => browser.close())
  const projects = [{ id: 1, name: 'Blue', color: '#368AD8' }, { id: 2, name: 'Red', color: '#DC6262' }]
  const tasks = [1, 2, 3].map(id => ({ id, title: id === 3 ? 'Record only' : `Task ${id}`, projectId: id === 2 ? 2 : 1, projectName: id === 2 ? 'Red' : 'Blue', status: 'IN_PROGRESS', completed: false, estimatedMinutes: 60, actualMinutes: 60, tags: [], priority: null, deadline: null }))
  const blocks = [{ id: 1, taskId: 1, date: '2026-10-07', type: 'TIMED', startTime: '10:00:00', durationMinutes: 60 }, { id: 2, taskId: 2, date: '2026-10-07', type: 'TIMED', startTime: '10:30:00', durationMinutes: 60 }, { id: 3, taskId: 1, date: '2026-10-06', type: 'TIMED', startTime: '23:15:00', durationMinutes: 180 }]
  const entries = [{ id: 1, taskId: 1, projectIdSnapshot: 2, startedAt: '2026-10-07T10:00:00+09:00', endedAt: '2026-10-07T11:00:00+09:00' }, { id: 2, taskId: 3, projectIdSnapshot: 1, startedAt: '2026-10-07T11:00:00+09:00', endedAt: null }]
  const errors = [], requests = []
  await browser.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' })
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false })
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{const D=Date,base=${Date.parse('2026-10-07T12:00:00+09:00')};window.reportClockOffset=0;window.Date=class extends D{constructor(...a){super(...(a.length?a:[base+window.reportClockOffset]));}static now(){return base+window.reportClockOffset}}})()` })
  browser.listeners.push(message => {
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method !== 'Fetch.requestPaused') return
    const { request, requestId } = message.params, url = new URL(request.url), path = url.pathname
    void (async () => {
      if (request.method === 'OPTIONS') return browser.fulfill(requestId, {})
      requests.push({ path, query: url.search, method: request.method })
      assert.equal(request.method, 'GET', 'Report viewing must not mutate data')
      let data = []
      if (path === '/tasks') data = tasks
      else if (path === '/projects') data = projects
      else if (path === '/tasks/time/active') data = { taskId: 3, running: true, startedAt: entries[1].startedAt }
      else if (/^\/tasks\/\d+\/time-entries$/.test(path)) data = entries.filter(entry => entry.taskId === Number(path.split('/')[2]))
      else if (/^\/tasks\/\d+$/.test(path)) data = tasks.find(task => task.id === Number(path.split('/')[2]))
      else if (path === '/schedule-blocks') data = blocks.filter(block => (!url.searchParams.has('startDate') || block.date >= url.searchParams.get('startDate')) && (!url.searchParams.has('endDate') || block.date <= url.searchParams.get('endDate')))
      else if (path === '/reports/daily') data = { date: url.searchParams.get('date'), plannedOccupiedMinutes: 0, dailyEstimatedMinutes: 0, dailyActualMinutes: 0, dailyDifference: 0, tasks: [] }
      await browser.fulfill(requestId, data)
    })().catch(error => { if (!/Invalid .*nterception|Invalid requestId/.test(error.message)) errors.push(String(error)) })
  })
  await browser.send('Fetch.enable', { patterns: [{ urlPattern: 'http://localhost:8000/*', requestStage: 'Request' }] })
  await browser.navigate()
  await browser.until(`!!document.querySelector('.icon-rail [aria-label="レポート"]') && !!document.querySelector('.timer-session')`, 'Navigation and shared Timer')
  await browser.click('.icon-rail [aria-label="レポート"]')

  const ready = () => browser.until('!!document.querySelector(".report-summary") && document.querySelector(".reports-v2").getAttribute("aria-busy")==="false"', 'Report ready')
  const mode = async label => { await browser.evaluate(`Array.from(document.querySelectorAll('.report-mode button')).find(e=>e.textContent===${JSON.stringify(label)}).click()`); await browser.until(`document.querySelector('.report-mode [aria-pressed=true]')?.textContent===${JSON.stringify(label)}`, 'Report mode committed'); await ready() }
  const label = () => browser.evaluate('document.querySelector(".report-period-label").textContent')
  const header = await browser.evaluate('(()=>{const r=document.querySelector(".app-header").getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()')
  await ready()
  await t.test('Left Navigation has Day Week Month, Today/current month and no reference-date inputs', async () => {
    assert.equal(await label(),'2026/10/07(水)')
    assert(!await browser.evaluate('document.querySelector(".report-toolbar").textContent.includes("基準日") || !!document.querySelector(".report-toolbar input")'))
    const edges=await browser.evaluate('(()=>{const nav=document.querySelector(".report-period-controls").getBoundingClientRect(),mode=document.querySelector(".report-mode").getBoundingClientRect();return [nav.x,mode.x]})()')
    assert(Math.abs(edges[0]-edges[1])<1)
    await browser.click('.report-period-controls [aria-label="前の期間"]'); await ready()
    assert.equal(await label(),'2026/10/06(火)')
    await browser.click('.report-period-controls [aria-label="次の期間"]'); await ready()
    assert.equal(await label(),'2026/10/07(水)')
    await browser.click('.report-period-controls .secondary-button'); await ready()
    assert.equal(await label(),'2026/10/07(水)')
    await mode('週'); assert.equal(await label(),'10/5 - 10/11')
  })
  await t.test('Week axis gives dates, nice time ticks, aligned Grid and exactly two non-navigating bars', async () => {
    assert.deepEqual(reportChartScale(180), {maximum:180,ticks:[0,60,120,180]})
    assert.deepEqual(reportChartScale(495), {maximum:600,ticks:[0,120,240,360,480,600]})
    assert.deepEqual(await browser.evaluate('Array.from(document.querySelectorAll(".period-chart-label")).map(e=>e.textContent)'), ['10/5(月)','10/6(火)','10/7(水)','10/8(木)','10/9(金)','10/10(土)','10/11(日)'])
    const ticks=await browser.evaluate('Array.from(document.querySelectorAll(".report-y-axis > span")).map(e=>e.textContent)')
    assert(ticks.length>=4 && ticks.length<=6 && ticks.some(tick=>tick.includes('時間')))
    assert.equal(await browser.evaluate('document.querySelectorAll(".report-chart-grid > span").length'),ticks.length)
    assert.deepEqual(await browser.evaluate('Array.from(document.querySelectorAll(".period-chart-column")).map(e=>e.querySelectorAll(".period-chart-bar").length)'),Array(7).fill(2))
    assert(!await browser.evaluate('!!document.querySelector("button.period-chart-column")'))
    const before=await label(); await browser.click('[data-chart-date="2026-10-07"] .period-chart-bar.actual')
    assert.equal(await label(),before)
    assert.equal(await browser.evaluate('document.querySelector(".report-mode [aria-pressed=true]").textContent'),'週')
    await assertReportTooltip(browser, '[data-chart-date="2026-10-07"] .period-chart-bar.actual', '10/7(水)\n計画済み 3時間45分\n記録 2時間\n差 -1時間45分')
    const grid=await browser.evaluate('(()=>{const y=Array.from(document.querySelectorAll(".report-y-axis span")).map(e=>{const r=e.getBoundingClientRect();return r.y+r.height/2});const g=Array.from(document.querySelectorAll(".report-chart-grid span")).map(e=>e.getBoundingClientRect().y);return y.map((v,i)=>Math.abs(v-g[i]))})()')
    assert(grid.every(delta=>delta<2))
  })
  await t.test('Desktop weekly tables share a row; narrow viewport stacks without page overflow', async () => {
    const positions=()=>browser.evaluate('Array.from(document.querySelector(".report-week-breakdown").children).map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})')
    let panels=await positions(); assert(Math.abs(panels[0].y-panels[1].y)<1); assert(panels[1].x>panels[0].x)
    for(const width of [768,375]) {
      await browser.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false})
      panels=await positions(); assert(panels[1].y>=panels[0].y+panels[0].height); assert(Math.abs(panels[0].x-panels[1].x)<1)
      assert(await browser.evaluate('document.documentElement.scrollWidth<=window.innerWidth+1'))
    }
    await browser.send('Emulation.setDeviceMetricsOverride',{width:1920,height:1080,deviceScaleFactor:1,mobile:false})
  })
  await t.test('Period Mode covers all endpoint dates, aggregates cross-month/year and restores previous Mode', async () => {
    await mode('期間')
    await browser.click('.report-period-label')
    await browser.until('!!document.querySelector(".calendar-navigation-picker")','Shared Picker')
    assert.equal(await browser.evaluate('document.querySelectorAll(".calendar-picker-range-week").length'),6)
    assert(await browser.evaluate('document.querySelector(".calendar-navigation-picker").textContent.includes("W41")'))
    await browser.click('.calendar-navigation-picker button[data-picker-date="2026-10-05"]')
    assert(await browser.evaluate('!!document.querySelector(".calendar-navigation-picker")'))
    await browser.click('.calendar-navigation-picker button[data-picker-date="2026-10-11"]'); await ready()
    assert.equal(await label(),'10/5 - 10/11')
    assert.deepEqual(await browser.evaluate('Array.from(document.querySelectorAll(".report-summary strong")).map(e=>e.textContent)'),['4時間30分','2時間','-2時間30分'])
    await browser.click('.report-period-label'); await browser.until('!!document.querySelector(".calendar-navigation-picker")','Range reopened')
    assert.deepEqual(await browser.evaluate('Array.from(document.querySelectorAll(".calendar-picker-range-week button[aria-pressed=true]")).map(e=>e.dataset.pickerDate)'),['2026-10-05','2026-10-06','2026-10-07','2026-10-08','2026-10-09','2026-10-10','2026-10-11'])
    await browser.click('.calendar-navigation-picker [aria-label="カレンダーピッカーを閉じる"]')
    await selectReportRange(browser,'2026-10-06','2026-10-07')
    assert.equal(await label(),'10/6 - 10/7')
    assert.equal(await browser.evaluate('document.querySelectorAll("[data-chart-date]").length'),2)
    assert.deepEqual(await browser.evaluate('Array.from(document.querySelectorAll(".report-summary strong")).map(e=>e.textContent)'),['4時間30分','2時間','-2時間30分'])
    await selectReportRange(browser,'2026-12-31','2027-01-02')
    assert.equal(await label(),'12/31 - 1/2')
    assert(requests.some(request=>request.path==='/schedule-blocks'&&new URLSearchParams(request.query).get('endDate')==='2027-01-02'))
    assert.deepEqual(await browser.evaluate('Array.from(document.querySelectorAll(".report-summary strong")).map(e=>e.textContent)'),['0分','0分','－'])
    assert(await browser.evaluate('document.querySelector(".period-chart-panel").textContent.includes("対象期間の記録はありません")'))
    assert.equal(await browser.evaluate('document.querySelector(".report-mode [aria-pressed=true]").textContent'),'期間')
    await browser.click('.report-period-controls [aria-label="次の期間"]'); await ready(); assert.equal(await label(),'1/3 - 1/5')
    await browser.click('.report-period-controls .secondary-button'); await ready(); assert.equal(await label(),'10/5 - 10/11')
  })
  await t.test('Picker Escape/outside close, focus restore and narrow viewport placement reuse CalendarSurface', async () => {
    await browser.click('.report-period-label'); await browser.until('!!document.querySelector(".calendar-navigation-picker")','Picker')
    await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
    await browser.until('!document.querySelector(".calendar-navigation-picker")','Escape close')
    assert(await browser.evaluate('document.activeElement===document.querySelector(".report-period-label")'))
    await browser.click('.report-period-label'); await browser.until('!!document.querySelector(".calendar-navigation-picker")','Picker')
    await browser.click('.reports-v2 .report-summary'); await browser.until('!document.querySelector(".calendar-navigation-picker")','Outside close')
    await browser.send('Emulation.setDeviceMetricsOverride',{width:375,height:812,deviceScaleFactor:1,mobile:false})
    await browser.click('.report-period-label'); await browser.until('!!document.querySelector(".calendar-navigation-picker")','Mobile Picker')
    assert(await browser.evaluate('(()=>{const r=document.querySelector(".calendar-navigation-picker").getBoundingClientRect();return r.left>=0 && r.right<=document.documentElement.clientWidth && r.top>=0 && r.bottom<=innerHeight})()'))
    await browser.click('.calendar-navigation-picker [aria-label="カレンダーピッカーを閉じる"]')
    await browser.send('Emulation.setDeviceMetricsOverride',{width:1920,height:1080,deviceScaleFactor:1,mobile:false})
  })
  await t.test('Month retains every bar with sparse labels and current-month reset', async () => {
    await mode('月'); assert.equal(await label(),'2026年10月')
    assert.equal(await browser.evaluate('document.querySelectorAll("[data-chart-date]").length'),31)
    assert.deepEqual(await browser.evaluate('Array.from(document.querySelectorAll(".period-chart-label")).map(e=>e.textContent).filter(Boolean)'),['1','5','10','15','20','25','30','31'])
    await browser.click('.report-period-controls [aria-label="前の期間"]'); await ready(); assert.equal(await label(),'2026年9月')
    await browser.click('.report-period-controls [aria-label="次の期間"]'); await ready(); assert.equal(await label(),'2026年10月')
    await browser.click('.report-period-controls .secondary-button'); await ready(); assert.equal(await label(),'2026年10月')
    assert.deepEqual(await browser.evaluate('(()=>{const r=document.querySelector(".app-header").getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()'),header)
  })
  await t.test('Home default Picker still selects a Week in one click, without range controls',async()=>{
    await browser.click('.icon-rail [aria-label="ホーム"]')
    await browser.until('!!document.querySelector(".calendar-period-label")','Home Navigation')
    await browser.click('.calendar-period-label'); await browser.until('!!document.querySelector(".calendar-picker-weeks")','Home Week Picker')
    assert(!await browser.evaluate('!!document.querySelector(".calendar-picker-range-days")'))
    await browser.click('.calendar-picker-weeks [data-picker-week="2026-10-05"]')
    await browser.until('!document.querySelector(".calendar-navigation-picker")','Home Week selection closes')
  })
  assert.deepEqual(errors,[])
})
