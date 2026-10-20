import assert from 'node:assert/strict'
import test from 'node:test'
import { openBrowser, pauseOrResumeTimer } from './browser.mjs'

test('Publication UI regressions (intercepted API, no DB connections)', { timeout: 120000 }, async t => {
  const browser = await openBrowser()
  t.after(() => browser.close())
  const date = '2026-10-02'
  const clock = `${date}T23:36:30+09:00`
  const stamp = time => `${date}T${time}+09:00`
  const task = { id: 1, title: 'UI regression task', estimatedMinutes: 60, projectId: 1, projectName: 'Demo project',
    completed: false, status: 'IN_PROGRESS', completedAt: null, completedEstimateMinutes: null,
    actualMinutes: 60, differenceMinutes: 0, actualStartedAt: stamp('10:00:00') }
  const entries = [
    { id: 1, startedAt: stamp('10:00:00'), endedAt: stamp('11:00:00'), durationMinutes: 60 },
    { id: 2, startedAt: stamp('13:00:00'), endedAt: stamp('13:00:30'), durationMinutes: 0 },
    { id: 3, startedAt: stamp('23:36:00'), endedAt: null, durationMinutes: null },
  ].map(entry => ({ ...entry, taskId: 1, projectIdSnapshot: 1, createdAt: entry.startedAt, updatedAt: entry.startedAt }))
  const errors = []
  let clockScript
  async function configure(now, locale = 'ja-JP', timezone = 'Asia/Tokyo') {
    await browser.send('Emulation.setTimezoneOverride', { timezoneId: timezone })
    await browser.send('Emulation.setLocaleOverride', { locale })
    if (clockScript) await browser.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: clockScript })
    clockScript = (await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      const RealDate = Date;
      window.Date = class extends RealDate {
        constructor(...args) { super(...(args.length ? args : [${Date.parse(now)}])); }
        static now() { return ${Date.parse(now)}; }
      };
    })()` })).identifier
  }
  const summary = day => ({ date: day, plannedOccupiedMinutes: 0, dailyEstimatedMinutes: 0,
    dailyActualMinutes: 60, dailyDifference: 60, tasks: [] })
  browser.listeners.push(message => {
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method !== 'Fetch.requestPaused') return
    const { requestId, request } = message.params
    void (async () => {
      const url = new URL(request.url)
      let body
      if (request.method === 'OPTIONS') body = {}
      else if (request.method === 'POST' && url.pathname === '/tasks/time/stop') {
        entries[2].endedAt = clock; entries[2].durationMinutes = 0; body = entries[2]
      } else if (request.method !== 'GET') throw new Error(`Unexpected mutation ${request.method} ${url.pathname}`)
      else if (url.pathname === '/tasks/time/active') body = entries[2].endedAt === null
        ? { running: true, taskId: 1, startedAt: entries[2].startedAt }
        : { running: false, taskId: null, startedAt: null }
      else if (url.pathname === '/tasks') body = url.searchParams.has('inbox') ? [] : [task]
      else if (url.pathname === '/tags') body = []
      else if (url.pathname === '/projects') body = [{ id: 1, name: 'Demo project', taskCount: 1, completedCount: 0, estimatedMinutes: 60, actualMinutes: 60 }]
      else if (url.pathname === '/schedule-blocks') body = []
      else if (url.pathname === '/tasks/1/time-entries') body = entries
      else if (url.pathname === '/reports/daily') body = summary(url.searchParams.get('date'))
      else if (url.pathname === '/reports/monthly') {
        const month = url.searchParams.get('month')
        body = { month, monthStart: `${month}-01`, monthEnd: `${month}-31`, daily: [],
          monthlyEstimatedMinutes: 0, monthlyPlannedOccupiedMinutes: 0, monthlyActualMinutes: 0,
          weekdayTotals: Array.from({ length: 7 }, (_, weekday) => ({ weekday, estimatedMinutes: 0, plannedOccupiedMinutes: 0, actualMinutes: 0 })) }
      } else throw new Error(`Unexpected read ${url.pathname}`)
      await browser.fulfill(requestId, body)
    })().catch(async error => {
      if (/Invalid InterceptionId|Invalid interceptionId|Invalid requestId/.test(error.message)) return
      errors.push(error.message)
      try { await browser.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }) } catch { /* Reloaded. */ }
    })
  })
  await browser.send('Fetch.enable', { patterns: [{ urlPattern: 'http://localhost:8000/*', requestStage: 'Request' }] })
  const labels = () => browser.evaluate('[...document.querySelectorAll(".calendar-week-header:not(.calendar-lane-header) > button > span")].map(e=>e.textContent)')
  const weekdays = ['月', '火', '水', '木', '金', '土', '日']
  async function ready() {
    await browser.until('document.querySelector(".calendar-week-header > button") && !document.querySelector(".calendar-schedule-status [role=status]")', 'Calendar ready')
  }
  async function size(width) {
    await browser.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false })
  }
  async function tap(selector) {
    const point = await browser.evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({block:'nearest'}); const r=e.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,visible:r.width>0&&r.height>0}; })()`)
    assert(point.visible, `Visible control: ${selector}`)
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  }
  await t.test('all seven Day Week Month weekdays survive different dates locales and timezones', async () => {
    await size(1600)
    for (const [now, locale, timezone] of [[clock, 'ja-JP', 'Asia/Tokyo'], ['2024-02-29T12:00:00Z', 'en-US', 'America/New_York'], ['2027-01-01T12:00:00Z', 'fr-FR', 'UTC']]) {
      await configure(now, locale, timezone); await browser.navigate(); await ready()
      assert.deepEqual(await labels(), weekdays)
      for (let day = 0; day < 7; day++) {
        await browser.click(`.calendar-week-header > button:nth-of-type(${day + 1})`)
        assert.equal(await browser.evaluate('document.querySelector(".home-calendar-controls .calendar-mode-switch button:nth-child(2)").getAttribute("aria-pressed")'), 'true')
        await browser.click('.calendar-mode-switch[aria-label="カレンダー表示"] button:nth-child(1)')
        await browser.until('document.querySelector(".week-calendar-panel.single-day")', 'Day mode')
        await ready(); assert.deepEqual(await labels(), [weekdays[day]])
        await browser.click('.calendar-mode-switch[aria-label="カレンダー表示"] button:nth-child(2)'); await ready()
      }
      await browser.click('.calendar-mode-switch[aria-label="カレンダー表示"] button:nth-child(3)')
      await browser.until('document.querySelector(".month-weekdays")', 'Month mode')
      assert.deepEqual(await browser.evaluate('[...document.querySelectorAll(".month-weekdays span")].map(e=>e.textContent)'), weekdays)
    }
  })
  await t.test('375px visible navigation reaches Home Tasks Projects Reports and back without page overflow', async () => {
    await configure(clock); await size(375); await browser.navigate(); await ready()
    for (const [index, heading] of [[2, 'タスク一覧'], [3, 'プロジェクト一覧'], [4, 'レポート'], [1, '今週の予定'], [3, 'プロジェクト一覧'], [2, 'タスク一覧']]) {
      await tap(`.mobile-nav button:nth-child(${index})`)
      await browser.until(`document.querySelector('h1')?.textContent === ${JSON.stringify(heading)}`, `Navigation to ${heading}`)
      assert(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth'), heading)
      assert.equal(await browser.evaluate('document.querySelectorAll(".mobile-nav button.active").length'), 1)
    }
  })
  async function visibleActual(id, minutes, height) {
    const selector = `.calendar-event.actual[data-time-entry-id="${id}"]`
    await browser.until(`document.querySelector(${JSON.stringify(selector)})`, 'Actual loaded')
    const geometry = await browser.evaluate(`(() => {
      const e=document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({block:'center'});
      const r=e.getBoundingClientRect(), header=document.querySelector('.home-header').getBoundingClientRect();
      const nav=document.querySelector('.mobile-nav'), navRect=nav.getBoundingClientRect();
      const x=r.left+r.width/2, y=r.top+r.height/2;
      return {top:parseFloat(e.style.top),height:r.height,viewportTop:r.top,viewportBottom:r.bottom,headerBottom:header.bottom,
        bottomLimit:getComputedStyle(nav).display==='none'?innerHeight:navRect.top,
        unobscured:e.contains(document.elementFromPoint(x,y)),bottomTimer:document.querySelector('.timer-dock')!==null};
    })()`)
    assert(Math.abs(geometry.top - minutes * .9) < .01)
    assert(Math.abs(geometry.height - height) < .1)
    assert(geometry.viewportTop >= geometry.headerBottom && geometry.viewportBottom < geometry.bottomLimit, JSON.stringify(geometry))
    assert(geometry.unobscured, 'Actual can be inspected above the Timer bar')
    assert.equal(geometry.bottomTimer, false)
  }
  await t.test('Day normal short and bottom Active Actual retain geometry with one top Timer and no bottom bar', async () => {
    await configure(clock)
    for (const width of [1600, 375]) {
      await size(width); await browser.navigate(); await ready()
      await browser.click('.calendar-mode-switch[aria-label="カレンダー表示"] button:nth-child(1)'); await ready()
      await visibleActual(1, 600, 54)
      await visibleActual(2, 780, 20)
      await visibleActual(3, 1416, 20)
    }
    await pauseOrResumeTimer(browser)
    await browser.until('document.querySelector(".header-timer-control.paused") && !document.querySelector(".active-entry")', 'Paused entry is closed')
    await visibleActual(3, 1416, 20)
  })
  await t.test('search and current-month text remain on one line', async () => {
    await size(1600); await browser.navigate(); await ready()
    await browser.click('.icon-rail [aria-label="タスク"]')
    assert.equal(await browser.evaluate('getComputedStyle(document.querySelector(".task-search")).whiteSpace'), 'nowrap')
    await browser.click('.icon-rail [aria-label="レポート"]')
    await browser.click('.report-mode button:nth-child(3)')
    await browser.until('document.querySelector(".report-period-controls .secondary-button")', 'Current month button')
    assert.equal(await browser.evaluate('getComputedStyle(document.querySelector(".report-period-controls .secondary-button")).whiteSpace'), 'nowrap')
  })
  assert.deepEqual(errors, [], 'No runtime errors or unhandled API requests')
})
