import assert from 'node:assert/strict'
import test from 'node:test'
import { openBrowser } from './browser.mjs'
import { selectReportRange, selectReportAnchor } from './report-picker.mjs'

test('Reports Day Week Month use plan/actual/difference, snapshots and live records (API mocked, no DB)', { timeout: 120000 }, async t => {
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
  const ready = () => browser.until('!!document.querySelector(".reports-v2 .report-summary") && document.querySelector(".reports-v2").getAttribute("aria-busy")==="false"', 'Report ready')
  const summary = () => browser.evaluate('Array.from(document.querySelectorAll(".reports-v2 .report-summary strong")).map(e=>e.textContent)')
  const mode = async name => { await browser.evaluate(`Array.from(document.querySelectorAll('.report-mode button')).find(e=>e.textContent===${JSON.stringify(name)}).click()`); await browser.until(`Array.from(document.querySelectorAll('.report-mode button')).some(e=>e.textContent===${JSON.stringify(name)} && e.getAttribute('aria-pressed')==='true')`, 'Displayed Report mode'); await ready() }
  await ready()
  await t.test('Day Summary time bands Task and snapshot Project tables omit estimates', async () => {
    assert.deepEqual(await summary(), ['3時間45分', '2時間', '-1時間45分'])
    assert.equal(await browser.evaluate('document.querySelectorAll(".reports-v2 .summary-item").length'), 3)
    assert.equal(await browser.evaluate('document.querySelectorAll("[data-chart-hour]").length'), 24)
    assert.deepEqual(await browser.evaluate('Array.from(document.querySelectorAll(".reports-v2 [data-report-table]")).map(e=>e.dataset.reportTable)'), ['tasks', 'projects'])
    assert(await browser.evaluate('document.querySelector(".reports-v2").textContent.includes("Record only")'))
    await browser.click('#report-tab-activity')
    await browser.until('!!document.querySelector("[data-report-table=activity]")','Activity tab exposes records')
    assert.equal(await browser.evaluate('document.querySelectorAll("[data-report-table=activity] tbody tr").length'),2)
    await browser.click('#report-tab-analysis')
    await ready()
    assert(!await browser.evaluate('document.querySelector(".reports-v2").textContent.includes("見積")'))
    assert.deepEqual(await browser.evaluate(`Array.from(document.querySelector('[data-report-table="projects"] [data-report-id="2"]').querySelectorAll('td')).map(e=>e.textContent)`), ['1時間', '1時間', '±0', '50%'])
    assert(await browser.evaluate(`!!document.querySelector('[data-report-table="projects"] [data-icon="folder"]')`))
  })
  await t.test('Week has seven day bars daily table and Task Top10', async () => {
    await mode('週')
    assert.deepEqual(await summary(), ['4時間30分', '2時間', '-2時間30分'])
    assert.equal(await browser.evaluate('document.querySelectorAll("[data-chart-date]").length'), 7)
    assert.equal(await browser.evaluate('document.querySelectorAll("[data-report-table=days] tbody tr").length'), 7)
    assert.equal(await browser.evaluate('document.querySelectorAll("[data-report-table=projects]").length'), 1)
    assert(await browser.evaluate('document.querySelector(".reports-v2").textContent.includes("タスク別Top10")'))
  })
  await t.test('Month charts all dates and fetches Report period independent of Home', async () => {
    await mode('月')
    assert.equal(await browser.evaluate('document.querySelectorAll("[data-chart-date]").length'), 31)
    assert.equal(await browser.evaluate('document.querySelectorAll("[data-report-table=projects]").length'), 1)
    assert(requests.some(request => request.path === '/schedule-blocks' && request.query === '?endDate=2026-10-31'))
    for (const [month, count] of [['2027-02', 0], ['2026-10', 31]]) {
      const [year, number] = month.split('-').map(Number)
      const last = new Date(year, number, 0).getDate()
      await selectReportRange(browser, `${month}-01`, `${month}-${last}`)
      await ready()
      assert.equal(await browser.evaluate('document.querySelectorAll("[data-chart-date]").length'), count)
      if (count === 0) {
        assert.deepEqual(await summary(), ['0分', '0分', '－'])
        assert(await browser.evaluate('document.querySelector(".reports-v2").textContent.includes("対象期間の記録はありません")'))
      }
    }
  })
  await t.test('Live minutes update without duplicate Entry fetch or writes; Header stays outside Report', async () => {
    await mode('日')
    await selectReportAnchor(browser, '2026-10-07')
    await ready()
    const count = requests.filter(request => request.path.endsWith('/time-entries')).length
    await browser.evaluate('window.reportClockOffset=60000; document.dispatchEvent(new Event("visibilitychange"))')
    await browser.until('document.querySelectorAll(".reports-v2 .report-summary strong")[1]?.textContent === "2時間1分"', 'Active minute update')
    assert.equal(requests.filter(request => request.path.endsWith('/time-entries')).length, count)
    assert(await browser.evaluate('!!document.querySelector(".app-header .timer-session") && !document.querySelector(".reports-v2 .timer-session")'))
  })
  await t.test('Narrow screen contains Chart and Table scrolling', async () => {
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: false })
    assert(await browser.evaluate('document.documentElement.scrollWidth<=window.innerWidth+1'))
  })
  assert.deepEqual(errors, [])
})
