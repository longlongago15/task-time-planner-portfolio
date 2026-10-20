import assert from 'node:assert/strict'
import test from 'node:test'
import { openBrowser } from './browser.mjs'
import { selectReportAnchor, selectReportRange } from './report-picker.mjs'

test('Reports Demo is isolated from real Workspace and cannot save Demo data (API mocks, no DB)', { timeout: 120000 }, async t => {
  const browser = await openBrowser()
  t.after(() => browser.close())
  const realTask = { id: 1, title: 'Real workspace task', projectId: 1, projectName: 'Real project',
    status: 'NOT_STARTED', completed: false, tags: [], estimatedMinutes: null, actualMinutes: 60 }
  const requests = [], errors = []
  await browser.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' })
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{const D=Date,now=${Date.parse('2026-10-05T12:00:00+09:00')};window.Date=class extends D{constructor(...a){super(...(a.length?a:[now]))}static now(){return now}}})()` })
  browser.listeners.push(message => {
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method !== 'Fetch.requestPaused') return
    const { request, requestId } = message.params, path = new URL(request.url).pathname
    void (async () => {
      if (request.method === 'OPTIONS') return browser.fulfill(requestId, {})
      requests.push({ method: request.method, path })
      let value = []
      if (path === '/tasks') value = [realTask]
      else if (path === '/projects') value = [{ id: 1, name: 'Real project', color: '#568BC7' }]
      else if (path === '/tasks/time/active') value = { taskId: null, running: false, startedAt: null }
      else if (path === '/tasks/1') value = realTask
      else if (path.endsWith('/time-entries')) value = [{ id: 1, taskId: 1, projectIdSnapshot: 1, startedAt: '2026-10-05T09:00:00+09:00', endedAt: '2026-10-05T10:00:00+09:00' }]
      else if (path === '/reports/daily') value = { date: '2026-10-05', plannedOccupiedMinutes: 0, dailyActualMinutes: 60, dailyEstimatedMinutes: 0, tasks: [] }
      await browser.fulfill(requestId, value)
    })().catch(error => errors.push(String(error)))
  })
  await browser.send('Fetch.enable', { patterns: [{ urlPattern: 'http://localhost:8000/*', requestStage: 'Request' }] })
  const ready = () => browser.until('!!document.querySelector(".icon-rail [aria-label=レポート]")', 'Navigation')
  const report = async () => {
    await ready(); await browser.click('.icon-rail [aria-label="レポート"]')
    await browser.until('!!document.querySelector(".report-summary") && document.querySelector(".reports-v2").getAttribute("aria-busy")==="false"', 'Report ready')
  }
  const values = () => browser.evaluate('Array.from(document.querySelectorAll(".report-summary strong")).map(e=>e.textContent)')
  await browser.navigate()
  await t.test('Normal URL uses real data without DEMO', async () => {
    await report()
    assert.equal(await browser.evaluate('!!document.querySelector("[data-report-demo]")'), false)
    assert.deepEqual(await values(), ['0分', '1時間', '+1時間'])
  })
  await browser.evaluate('window.location.search="?reportDemo=1"')
  await ready()
  await t.test('Demo Week uses the complete Demo dataset, without merging real data', async () => {
    await report()
    assert.equal(await browser.evaluate('document.querySelector("[data-report-demo]")?.textContent'), 'DEMO')
    await browser.evaluate('Array.from(document.querySelectorAll(".report-mode button")).find(e=>e.textContent==="週").click()')
    await browser.until('document.querySelector(".report-mode [aria-pressed=true]")?.textContent==="週"', 'Demo Week')
    assert.deepEqual(await values(), ['25時間', '25時間30分', '+30分'])
    const text = await browser.evaluate('document.querySelector(".reports-v2").textContent')
    assert(!text.includes(realTask.title))
    assert(text.includes('基本情報の過去問'))
    assert.equal(await browser.evaluate('document.querySelectorAll("[data-report-table=tasks] tbody tr").length'), 10)
  })
  await t.test('Month, range and overnight days continue using existing metrics and Picker', async () => {
    await browser.evaluate('Array.from(document.querySelectorAll(".report-mode button")).find(e=>e.textContent==="月").click()')
    await browser.until('document.querySelector(".report-mode [aria-pressed=true]")?.textContent==="月"', 'Demo Month')
    assert.deepEqual(await values(), ['26時間', '26時間10分', '+10分'])
    await selectReportRange(browser, '2026-10-05', '2026-10-11')
    assert.deepEqual(await values(), ['25時間', '25時間30分', '+30分'])
    await browser.evaluate('Array.from(document.querySelectorAll(".report-mode button")).find(e=>e.textContent==="日").click()')
    for (const date of ['2026-10-12', '2026-10-13']) {
      await selectReportAnchor(browser, date)
      assert.deepEqual(await values(), ['30分', '20分', '-10分'])
    }
  })
  await t.test('Home and Task list retain real data; Timer remains real and no mutation is sent', async () => {
    await browser.click('.icon-rail [aria-label="ホーム"]')
    await browser.until('!!document.querySelector(".inbox-task-card")', 'Real Inbox')
    const home = await browser.evaluate('document.querySelector(".inbox-task-card").textContent')
    assert(home.includes(realTask.title)); assert(!home.includes('基本情報の過去問'))
    await browser.click('.icon-rail [aria-label="タスク"]')
    await browser.until('!!document.querySelector(".task-table-row")', 'Real Task list')
    assert.equal(await browser.evaluate('document.querySelector(".task-table-row").dataset.taskId'), '1')
    assert.equal(await browser.evaluate('!!document.querySelector(".global-top-timer")'), true)
    assert.equal(requests.filter(r => r.method !== 'GET').length, 0)
    assert(!requests.some(r => /\/tasks\/9\d{3}/.test(r.path)))
    assert.deepEqual(errors, [])
  })
})
