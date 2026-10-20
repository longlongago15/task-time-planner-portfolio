import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { openBrowser } from './browser.mjs'
import { createMockRequestLifecycle } from './mock-request-lifecycle.mjs'
import { selectReportAnchor, selectReportRange } from './report-picker.mjs'

test('Final Reports UI stays coherent across Demo Modes, Filters and narrow viewports (API mocks, no DB)', { timeout: 180000 }, async t => {
  const browser = await openBrowser()
  const network = createMockRequestLifecycle(browser)
  const errors = [], writes = []
  await browser.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' })
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false })
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{const D=Date,now=${Date.parse('2026-10-07T12:00:00+09:00')};window.Date=class extends D{constructor(...a){super(...(a.length?a:[now]))}static now(){return now}}})()` })
  const listener = message => {
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method !== 'Fetch.requestPaused') return
    const {request} = message.params
    if (!['GET','OPTIONS'].includes(request.method)) writes.push(request.url)
    void network.fulfill(message.params, request.url.includes('/tasks/time/active') ? {taskId:null,running:false,startedAt:null} : request.url.includes('/reports/daily') ? {date:'2026-10-07',tasks:[]} : []).catch(e=>errors.push(String(e)))
  }
  browser.listeners.push(listener)
  t.after(async () => {
    try {
      await network.dispose()
      assert.deepEqual(errors, [])
    } finally { browser.listeners.splice(browser.listeners.indexOf(listener), 1); await browser.close() }
  })
  await browser.send('Fetch.enable', { patterns: [{urlPattern:'http://localhost:8000/*',requestStage:'Request'}] })
  await browser.navigate(); await browser.evaluate('window.location.search="?reportDemo=1"')
  await browser.until('!!document.querySelector(".icon-rail [aria-label=レポート]")','Navigation')
  await browser.click('.icon-rail [aria-label="レポート"]')
  const ready = () => browser.until('!!document.querySelector("[data-report-demo]") && !!document.querySelector(".report-summary") && document.querySelector(".reports-v2").getAttribute("aria-busy")==="false"', 'Report ready')
  const mode = async name => { await browser.evaluate(`Array.from(document.querySelectorAll('.report-mode button')).find(e=>e.textContent===${JSON.stringify(name)}).click()`); await browser.until(`document.querySelector('.report-mode [aria-pressed=true]')?.textContent===${JSON.stringify(name)}`,'Mode'); await ready() }
  const values = () => browser.evaluate('Array.from(document.querySelectorAll(".report-summary strong")).map(e=>e.textContent)')
  const activity = () => browser.click('#report-tab-activity'), analysis = () => browser.click('#report-tab-analysis')
  const sections = () => browser.evaluate('Array.from(document.querySelectorAll("[data-report-section]")).map(e=>e.dataset.reportSection)')
  const screenshot = async name => {
    // Capture final bar geometry, not the existing 200ms height transition.
    await browser.evaluate(`Promise.all(document.querySelector('.reports-v2').getAnimations({subtree:true}).map(animation=>animation.finished.catch(()=>{})))`)
    await browser.evaluate('window.scrollTo(0,0)')
    const { cssContentSize:r } = await browser.send('Page.getLayoutMetrics')
    const { data } = await browser.send('Page.captureScreenshot', {format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width:r.width,height:r.height,scale:1}})
    await mkdir('../docs/screenshots/reports-final-ui', {recursive:true})
    await writeFile(`../docs/screenshots/reports-final-ui/${name}.png`, Buffer.from(data,'base64'))
  }
  const toggle = async (category, name) => {
    const trigger = `.report-filters [data-filter="${category}"] > button`
    await browser.click(trigger); await browser.until('!!document.querySelector(".report-filters .task-filter-popover")','Filter')
    await browser.evaluate(`Array.from(document.querySelectorAll('.report-filters .task-filter-popover label')).find(e=>e.textContent.trim()===${JSON.stringify(name)}).querySelector('input').click()`)
    await browser.click(trigger); await browser.until('!document.querySelector(".report-filters .task-filter-popover")','Filter closed')
  }
  const clear = () => browser.click('.report-filters .task-clear-all')
  await ready()
  await t.test('Day Summary contrast, target date, 24 paired bars, five fixed ticks and logs', async () => {
    await selectReportAnchor(browser, '2026-10-05')
    assert.equal(await browser.evaluate('document.querySelector(".report-period-label").textContent'),'2026/10/05(月)')
    const styles = await browser.evaluate('Array.from(document.querySelectorAll(".report-summary .summary-item")).map(e=>({bg:getComputedStyle(e).backgroundColor,color:getComputedStyle(e).color}))')
    assert.equal(styles[0].bg,'rgb(21, 59, 57)'); assert.equal(styles[0].color,'rgb(255, 255, 255)'); assert.equal(styles[1].bg,'rgb(255, 255, 255)')
    assert(await browser.evaluate('!!document.querySelector(".report-summary-difference.difference-warm")'))
    assert.deepEqual(await browser.evaluate('Array.from(document.querySelectorAll("[data-chart-hour]")).map(e=>e.dataset.chartHour)'),Array.from({length:24},(_,i)=>String(i)))
    assert.equal(await browser.evaluate('document.querySelectorAll(".report-hourly-chart .period-chart-bar").length'),48)
    assert.deepEqual(await browser.evaluate('Array.from(document.querySelectorAll(".report-y-axis span")).map(e=>e.textContent)'),['0分','15分','30分','45分','60分'])
    assert.equal(await browser.evaluate('document.querySelectorAll(".report-chart-grid span").length'),5)
    assert(await browser.evaluate('Array.from(document.querySelectorAll(".period-chart-bar")).every(e=>Number.isFinite(parseFloat(e.style.height)) && parseFloat(e.style.height)<=100)'))
    assert.match(await browser.evaluate(`document.querySelector('[data-chart-hour="9"]').getAttribute("aria-label")`),/9時台\n計画済み 60分\n記録 50分/)
    assert.deepEqual(await sections(),['tasks','projects'])
    await activity()
    assert.equal(await browser.evaluate('document.querySelectorAll("[data-report-table=activity] tbody tr").length'),3)
    await analysis()
    await screenshot('day')
  })
  await t.test('Week totals, shares, two columns and 17-entry Activity tab', async () => {
    await mode('週')
    assert.deepEqual(await values(),['25時間', '25時間30分', '+30分'])
    assert.equal(await browser.evaluate('document.querySelector(".report-period-label").textContent'),'10/5 - 10/11')
    assert(await browser.evaluate('!!document.querySelector(".report-summary-difference.difference-warm")'))
    assert.equal(await browser.evaluate('document.querySelectorAll("[data-chart-date]").length'),7)
    assert.equal(await browser.evaluate('document.querySelectorAll("[data-report-table=tasks] tbody tr").length'),10)
    const shares = await browser.evaluate('Array.from(document.querySelectorAll("[data-report-table=tasks] [role=progressbar]")).map(e=>Number(e.getAttribute("aria-valuenow")))')
    assert(Math.abs(shares.reduce((n,v)=>n+v,0)-100)<1e-8)
    const pos = await browser.evaluate('Array.from(document.querySelector(".report-week-breakdown").children).map(e=>{const r=e.getBoundingClientRect();return [r.x,r.y]})')
    assert.equal(pos[0][1],pos[1][1]); assert(pos[1][0]>pos[0][0])
    assert.equal(await browser.evaluate('document.querySelector(".report-donut-total strong").textContent'),'25時間30分')
    assert.equal(await browser.evaluate('document.querySelectorAll("[data-project-slice]").length'),4)
    assert(await browser.evaluate('Array.from(document.querySelectorAll("[data-project-slice]")).every(e=>getComputedStyle(e).stroke===getComputedStyle(document.querySelector(`[data-report-table=projects] [data-report-id="${e.dataset.projectSlice}"] .report-project-name`)).color)'))
    await activity()
    assert.equal(await browser.evaluate('document.querySelectorAll("[data-entry-id]").length'),17)
    assert(await browser.evaluate('!!document.querySelector(".report-log-tags .tag-chip")'))
    await analysis(); await screenshot('week')
  })
  await t.test('Month analysis retains sparse labels and Project before Tasks; Activity is available', async () => {
    await mode('月')
    assert.equal(await browser.evaluate('document.querySelector(".report-period-label").textContent'),'2026年10月')
    assert.equal(await browser.evaluate('document.querySelectorAll("[data-chart-date]").length'),31)
    assert.deepEqual(await sections(),['projects','tasks'])
    assert.equal(await browser.evaluate('!!document.querySelector(".report-activity")'),false)
    await activity()
    assert.equal(await browser.evaluate('document.querySelectorAll("[data-entry-id]").length'),18)
    await analysis()
    await screenshot('month')
  })
  await t.test('Range uses daily Chart and separate Activity independently of previous Mode', async () => {
    for (const previous of ['月', '週', '日']) {
      await mode(previous); await selectReportRange(browser,'2026-10-05','2026-10-11')
      assert.deepEqual(await sections(),['tasks','projects'])
      assert.equal(await browser.evaluate('document.querySelectorAll("[data-chart-date]").length'),7)
      assert.equal(await browser.evaluate('!!document.querySelector(".report-week-breakdown")'),false)
      await activity(); assert.equal(await browser.evaluate('document.querySelectorAll("[data-entry-id]").length'),17); await analysis()
    }
    await screenshot('range')
    await selectReportRange(browser,'2026-10-12','2026-10-13')
    await activity()
    assert.equal(await browser.evaluate('document.querySelectorAll("[data-entry-id]").length'),1)
    assert.equal(await browser.evaluate('document.querySelector("[data-entry-id] td:nth-child(4)").textContent'),'23:40〜00:20（日跨ぎ）')
    assert.equal(await browser.evaluate('document.querySelector("[data-entry-id] td:nth-child(5)").textContent'),'2026/10/12〜2026/10/13')
    assert.equal(await browser.evaluate('document.querySelector("[data-entry-id] td:nth-child(6)").textContent'),'40分')
    await analysis()
  })
  await t.test('Overnight day Logs clip contributions without splitting source Entry', async () => {
    await mode('日')
    for (const [date,clock] of [['2026-10-12','23:40〜24:00'],['2026-10-13','00:00〜00:20']]) {
      await selectReportAnchor(browser,date)
      assert.deepEqual(await values(),['30分', '20分', '-10分'])
      await activity()
      assert.equal(await browser.evaluate('document.querySelector("[data-entry-id]").dataset.entryId'),'9418')
      assert.equal(await browser.evaluate('document.querySelector("[data-entry-id] td:nth-child(4)").textContent'),clock)
      assert.equal(await browser.evaluate('document.querySelector("[data-entry-id] td:nth-child(6)").textContent'),'20分')
      await analysis()
    }
  })
  await t.test('Project Tag Status Filters synchronize Summary, shares, Donut, Tables and Activity', async () => {
    await selectReportAnchor(browser,'2026-10-05'); await mode('週')
    await toggle('project','IT学習')
    assert.deepEqual(await values(),['7時間', '7時間45分', '+45分'])
    assert.equal(await browser.evaluate('document.querySelectorAll("[data-project-slice]").length'),1)
    assert.equal(await browser.evaluate('document.querySelector(".report-donut-total strong").textContent'),'7時間45分')
    assert.equal(await browser.evaluate('document.querySelectorAll("[data-report-table=tasks] tbody tr").length'),3)
    await activity()
    assert(await browser.evaluate('document.querySelectorAll("[data-entry-id]").length>0'))
    assert(await browser.evaluate('Array.from(document.querySelectorAll("[data-entry-id] td:nth-child(2)")).every(e=>e.textContent==="IT学習")'))
    await analysis()
    const shares = await browser.evaluate('Array.from(document.querySelectorAll("[data-report-table=tasks] [role=progressbar]")).map(e=>Number(e.getAttribute("aria-valuenow")))')
    assert(Math.abs(shares.reduce((n,v)=>n+v,0)-100)<1e-8)
    await toggle('tag','AWS'); await toggle('status','未着手')
    assert.deepEqual(await values(),['1時間30分', '2時間', '+30分'])
    assert.equal(await browser.evaluate('document.querySelector("[data-report-table=tasks] tbody th").textContent'),'AWS学習')
    assert.equal(await browser.evaluate('document.querySelector("[role=progressbar]").getAttribute("aria-valuenow")'),'100')
    await activity()
    assert.equal(await browser.evaluate('document.querySelectorAll("[data-entry-id]").length'),1)
    await analysis()
    assert.match(await browser.evaluate(`document.querySelector('[data-chart-date="2026-10-08"]').getAttribute("aria-label")`),/計画済み 1時間30分\n記録 2時間/)
    await screenshot('filtered'); await clear()
  })
  await t.test('Plan-only zero recording yields zero shares, no Donut, and equal Summary is neutral', async () => {
    await mode('日'); await selectReportAnchor(browser,'2026-10-09'); await toggle('tag','応募'); await toggle('status','完了')
    assert.equal((await values())[1],'0分')
    assert.equal(await browser.evaluate('document.querySelector("[role=progressbar]").getAttribute("aria-valuenow")'),'0')
    assert.equal(await browser.evaluate('!!document.querySelector(".report-donut svg")'),false)
    assert.match(await browser.evaluate('document.querySelector(".report-project-empty").textContent'),/記録 0分/)
    await clear(); await toggle('project','未所属')
    assert.deepEqual(await values(),['0分', '0分', '－'])
    assert(await browser.evaluate('!!document.querySelector(".report-summary-difference.difference-neutral")'))
    await clear()
  })
  await t.test('Narrow viewports contain all Modes; Donut and weekly columns stack', async () => {
    for (const width of [768,375]) {
      await browser.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false})
      for (const name of ['日','週','月','期間']) {
        await mode(name)
        assert(await browser.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),`${width} ${name} overflow`)
      }
      await mode('週')
      const panels=await browser.evaluate('Array.from(document.querySelector(".report-week-breakdown").children).map(e=>{const r=e.getBoundingClientRect();return [r.x,r.y,r.height]})')
      assert(panels[1][1]>=panels[0][1]+panels[0][2]); assert.equal(panels[0][0],panels[1][0])
      assert.equal(await browser.evaluate('getComputedStyle(document.querySelector(".report-project-breakdown")).gridTemplateColumns.split(" ").length'),1)
    }
    await screenshot('mobile')
    assert.deepEqual(errors,[]); assert.deepEqual(writes,[])
  })
})
