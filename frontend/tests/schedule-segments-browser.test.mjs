import assert from 'node:assert/strict'
import test from 'node:test'
import { openBrowser } from './browser.mjs'

test('Home Day and Week split overnight schedules, preserve source Detail and collision layout (API mocks only)', { timeout: 120000 }, async t => {
  const browser = await openBrowser()
  t.after(() => browser.close())
  const tasks = [1, 2].map(id => ({ id, title: `Overnight ${id}`, projectId: null, projectName: null, status: 'NOT_STARTED', completed: false, estimatedMinutes: 180, actualMinutes: 0, tags: [], priority: null, deadline: null }))
  const blocks = [
    { id: 7, taskId: 1, date: '2026-10-07', type: 'TIMED', startTime: '23:15:00', durationMinutes: 180 },
    { id: 8, taskId: 2, date: '2026-10-08', type: 'TIMED', startTime: '01:00:00', durationMinutes: 120 },
  ]
  const errors = [], mutations = []
  await browser.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' })
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false })
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{const D=Date,now=${Date.parse('2026-10-08T03:00:00Z')};window.Date=class extends D{constructor(...a){super(...(a.length?a:[now]));}static now(){return now}}})()` })
  browser.listeners.push(message => {
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method !== 'Fetch.requestPaused') return
    const { request, requestId } = message.params, url = new URL(request.url), path = url.pathname
    void (async () => {
      if (request.method === 'OPTIONS') return browser.fulfill(requestId, {})
      if (request.method !== 'GET') mutations.push(request)
      assert.equal(request.method, 'GET')
      let data = []
      if (path === '/tasks') data = tasks
      else if (/^\/tasks\/\d+$/.test(path)) data = tasks.find(task => task.id === Number(path.split('/')[2]))
      else if (path === '/tasks/time/active') data = { taskId: null, running: false, startedAt: null }
      else if (path === '/schedule-blocks') data = blocks.filter(block => (!url.searchParams.has('startDate') || block.date >= url.searchParams.get('startDate')) && (!url.searchParams.has('endDate') || block.date <= url.searchParams.get('endDate')))
      else if (path === '/reports/daily') data = { date: url.searchParams.get('date'), tasks: [], dailyActualMinutes: 0, dailyEstimatedMinutes: 0, plannedOccupiedMinutes: 0 }
      else if (path === '/reports/weekly') data = { daily: [], weeklyActualMinutes: 0, weeklyEstimatedMinutes: 0, weeklyPlannedOccupiedMinutes: 0 }
      await browser.fulfill(requestId, data)
    })().catch(error => { if (!/Invalid .*nterception|Invalid requestId/.test(error.message)) errors.push(String(error)) })
  })
  await browser.send('Fetch.enable', { patterns: [{ urlPattern: 'http://localhost:8000/*', requestStage: 'Request' }] })
  await browser.navigate()
  await browser.until(`document.querySelectorAll('.weekly-schedule-event[data-schedule-block-id="7"]').length===2`, 'Two overnight segments')
  const segments = await browser.evaluate(`Array.from(document.querySelectorAll('.weekly-schedule-event[data-schedule-block-id="7"]')).map(e=>({date:e.dataset.date,top:parseFloat(e.style.top),height:parseFloat(e.style.height),columnHeight:e.closest('.calendar-day-column').getBoundingClientRect().height,duration:e.querySelector('.schedule-block-duration').textContent,overlap:e.classList.contains('has-schedule-overlap')}))`)
  assert.deepEqual(segments.map(s => [s.date, s.duration]), [['2026-10-07', '45分'], ['2026-10-08', '2時間15分']])
  assert(segments.every(s => s.top + s.height <= s.columnHeight + 1))
  assert.equal(segments[1].top, 0)
  assert.equal(segments[1].overlap, true)
  assert.equal(await browser.evaluate(`document.querySelector('[data-metric-date="2026-10-07"] dd').textContent`), '45分')
  assert.equal(await browser.evaluate(`document.querySelector('[data-metric-date="2026-10-08"] dd').textContent`), '3時間')
  for (const date of ['2026-10-07', '2026-10-08']) {
    await browser.click(`.weekly-schedule-event[data-schedule-block-id="7"][data-date="${date}"]`)
    await browser.until('!!document.querySelector("#schedule-detail")', 'Source schedule Detail')
    const detail = await browser.evaluate('document.querySelector("#schedule-detail").textContent')
    assert(detail.includes('23:15 – 02:15 (+1日)'))
    assert(detail.includes('3時間'))
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await browser.until('!document.querySelector("#schedule-detail")', 'Detail closed')
  }
  await browser.evaluate(`Array.from(document.querySelectorAll('[aria-label="カレンダー表示"] button')).find(e=>e.textContent==='日').click()`)
  await browser.until(`!!document.querySelector('.single-day .weekly-schedule-event[data-schedule-block-id="7"]')`, 'Previous-day source in Day')
  assert.equal(await browser.evaluate(`document.querySelector('.single-day [data-schedule-block-id="7"]').dataset.date`), '2026-10-08')
  await browser.evaluate(`Array.from(document.querySelectorAll('[aria-label="カレンダー表示"] button')).find(e=>e.textContent==='月').click()`)
  await browser.until(`!!document.querySelector('.month-task-chip[data-schedule-block-id="7"]')`, 'Original Month source')
  assert.equal(await browser.evaluate(`document.querySelectorAll('.month-task-chip[data-schedule-block-id="7"]').length`), 1)
  assert.deepEqual(mutations, [])
  assert.deepEqual(errors, [])
})
