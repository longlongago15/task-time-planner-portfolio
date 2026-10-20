import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { openBrowser } from './browser.mjs'
import { startMetadataBackend } from './metadata-backend.mjs'
import { getISOWeekNumber, getMonthGridDates, getWeekDates } from '../src/calendarDates.ts'

test('Calendar shares Monday start and ISO week numbering at month/year boundaries', () => {
  for (const [date, monday, number] of [
    ['2026-10-09', '2026-10-05', 41], ['2025-12-28', '2025-12-22', 52],
    ['2020-12-31', '2020-12-28', 53], ['2021-01-01', '2020-12-28', 53],
    ['2021-01-04', '2021-01-04', 1], ['2026-12-31', '2026-12-28', 53],
    ['2027-01-04', '2027-01-04', 1],
  ]) {
    assert.equal(getWeekDates(date)[0], monday)
    assert.equal(getISOWeekNumber(date), number)
    assert.equal(getISOWeekNumber(monday), number)
  }
  assert.deepEqual(getMonthGridDates('2026-10-09').slice(0, 7), getWeekDates('2026-10-01'))
})

test('Shared Navigation Picker selects day/week/month without changing existing Navigation', { timeout: 180000 }, async t => {
  const { base } = await startMetadataBackend(t)
  const browser = await openBrowser(); t.after(() => browser.close())
  const errors = []
  await browser.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' })
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `const RealDate=Date;window.Date=class extends RealDate{constructor(...args){super(...(args.length?args:['2026-10-09T00:00:00Z']))}static now(){return new RealDate('2026-10-09T00:00:00Z').getTime()}}` })
  browser.listeners.push(message => {
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method !== 'Fetch.requestPaused') return
    const { request, requestId } = message.params
    void (async () => {
      if (request.method === 'OPTIONS') return browser.fulfill(requestId, {})
      const url = new URL(request.url), effective = base + url.pathname + url.search
      assert.notEqual(new URL(effective).port, '8000')
      const response = await fetch(effective, { method: request.method, ...(request.postData ? { headers: { 'Content-Type': 'application/json' }, body: request.postData } : {}) })
      await browser.fulfill(requestId, await response.json(), response.status)
    })().catch(error => { if (!/Invalid [Ii]nterceptionId|Invalid requestId/.test(error.message)) errors.push(String(error)) })
  })
  await browser.send('Fetch.enable', { patterns: [{ urlPattern: 'http://localhost:8000/*', requestStage: 'Request' }, { urlPattern: 'http://127.0.0.1:8000/*', requestStage: 'Request' }] })
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false })
  await browser.navigate()
  const ready = () => browser.until('document.querySelector(".calendar-period-trigger") && !document.querySelector(".calendar-schedule-status [role=status]")', 'Calendar loaded')
  await ready()
  const picker = '#calendar-navigation-picker'
  const trigger = '.calendar-period-trigger'
  const open = async () => { await browser.click(trigger); await browser.until(`document.querySelector('${picker}')`, 'Picker opened') }
  const closed = () => browser.until(`!document.querySelector('${picker}')`, 'Picker closed')
  const mode = async index => { await browser.click('.calendar-mode-switch[aria-label="カレンダー表示"] button:nth-child(' + index + ')'); await ready() }
  const label = () => browser.evaluate('document.querySelector(".calendar-period-label").textContent')
  const shot = async name => {
    const directory = new URL('../../docs/screenshots/home-picker/', import.meta.url)
    await mkdir(directory, { recursive: true })
    const data = await browser.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    await writeFile(new URL(name + '.png', directory), Buffer.from(data.data, 'base64'))
  }
  const geometry = () => browser.evaluate(`[...document.querySelector('.calendar-period-navigation').children].map(e=>{const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height]})`)
  const initial = await geometry()
  await t.test('Only center opens; outside click / Escape close and restore focus; Arrows keep their handlers', async () => {
    for (const control of ['[aria-label="前の期間"]', '[aria-label="次の期間"]', '.today-button']) {
      await browser.click(control); await ready(); assert.equal(await browser.evaluate(`!!document.querySelector('${picker}')`), false)
    }
    await open()
    assert.equal(await browser.evaluate('document.activeElement.closest("#calendar-navigation-picker")!==null'), true)
    await browser.click('.today-button'); await closed()
    await open()
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', windowsVirtualKeyCode: 27 })
    await closed()
    assert.equal(await browser.evaluate('document.activeElement.matches(".calendar-period-trigger")'), true)
    assert.deepEqual(await geometry(), initial)
  })
  await t.test('Day: selected / Today markers, month movement, selected day updates Navigation and closes', async () => {
    await mode(1); await open()
    assert.equal(await browser.evaluate(`document.querySelector('${picker} [aria-pressed="true"]').dataset.pickerDate`), '2026-10-09')
    assert.equal(await browser.evaluate(`document.querySelector('${picker} [aria-current="date"]').dataset.pickerDate`), '2026-10-09')
    await browser.click(`${picker} [aria-label="前月"]`)
    assert.equal(await browser.evaluate('document.querySelector("#calendar-navigation-picker-title").textContent'), '2026年9月')
    await browser.click(`${picker} [aria-label="次月"]`)
    await shot('1920-day')
    await browser.click(`${picker} [data-picker-date="2026-10-01"]`); await closed(); await ready()
    assert.match(await label(), /10\/1/)
    assert.equal(await browser.evaluate('document.querySelector(".calendar-period-navigation").dataset.mode'), 'day')
    assert.deepEqual(await geometry(), initial)
  })
  await t.test('Week: W number and entire selected row; clicking across a month selects Monday', async () => {
    await mode(2); await open()
    assert.equal(await browser.evaluate(`document.querySelector('${picker} [aria-pressed="true"]').dataset.pickerWeek`), '2026-09-28')
    assert.match(await browser.evaluate(`document.querySelector('${picker} [data-picker-week="2026-09-28"]').textContent`), /^W40/)
    await shot('1920-week')
    await browser.click(`${picker} [data-picker-date="2026-10-11"]`); await closed(); await ready()
    assert.match(await label(), /^W41\s+10\/5 - 10\/11$/)
    assert.equal(await browser.evaluate('document.querySelector(".calendar-period-navigation").dataset.mode'), 'week')
  })
  await t.test('Month: selected / Today month, prior / next year and 12-month grid', async () => {
    await mode(3); await open()
    assert.equal(await browser.evaluate(`document.querySelector('${picker} [aria-pressed="true"]').dataset.pickerMonth`), '2026-10')
    assert.equal(await browser.evaluate(`document.querySelector('${picker} [aria-current="date"]').dataset.pickerMonth`), '2026-10')
    assert.equal(await browser.evaluate(`document.querySelectorAll('${picker} [data-picker-month]').length`), 12)
    await browser.click(`${picker} [aria-label="前年"]`)
    assert.equal(await browser.evaluate('document.querySelector("#calendar-navigation-picker-title").textContent'), '2025年')
    await browser.click(`${picker} [aria-label="翌年"]`)
    await shot('1920-month')
    await browser.click(`${picker} [data-picker-month="2026-11"]`); await closed(); await ready()
    assert.equal(await label(), '2026年11月')
    assert.equal(await browser.evaluate('document.querySelector(".calendar-period-navigation").dataset.mode'), 'month')
    assert.deepEqual(await geometry(), initial)
  })
  await t.test('Week: year crossing W53 / W1 uses the same Monday and ISO rules', async () => {
    await open()
    for (let i = 0; i < 6; i++) await browser.click(`${picker} [aria-label="前年"]`)
    await browser.click(`${picker} [data-picker-month="2020-12"]`); await closed(); await ready()
    await mode(2); await open()
    await browser.click(`${picker} [data-picker-date="2021-01-01"]`); await closed(); await ready()
    assert.match(await label(), /^W53\s+12\/28 - 1\/3$/)
    await open(); await browser.click(`${picker} [aria-label="次月"]`)
    assert.equal(await browser.evaluate(`document.querySelector('${picker} [aria-pressed="true"]').dataset.pickerWeek`), '2020-12-28')
    await browser.click(`${picker} [data-picker-date="2021-01-04"]`); await closed(); await ready()
    assert.match(await label(), /^W1\s+1\/4 - 1\/10$/)
    await browser.click('.today-button'); await ready()
  })
  await t.test('All modes fit Desktop / Tablet / Mobile viewport; common Light / Dark style', async () => {
    for (const width of [1920,768,375]) {
      await browser.send('Emulation.setDeviceMetricsOverride', { width, height: 1080, deviceScaleFactor: 1, mobile: false })
      await browser.until(`document.querySelector('.app-layout')?.dataset.device==='${width>980?'desktop':width>680?'tablet':'mobile'}'`, 'Responsive settled')
      for (const theme of ['light','dark']) {
        await browser.evaluate(`document.documentElement.dataset.theme='${theme}'; undefined`)
        for (const index of [1,2,3]) {
          await mode(index)
          const labelBounds = await browser.evaluate(`(()=>{const b=document.querySelector('.calendar-period-trigger'),r=b.getBoundingClientRect(),text=document.createRange();text.selectNodeContents(b);const t=text.getBoundingClientRect();return{width:r.width,left:r.left,right:r.right,textLeft:t.left,textRight:t.right,style:getComputedStyle(b).width}})()`)
          assert(labelBounds.textLeft>=labelBounds.left-1&&labelBounds.textRight<=labelBounds.right+1, JSON.stringify(labelBounds))
          await open()
          const result = await browser.evaluate(`(()=>{const e=document.querySelector('${picker}'),r=e.getBoundingClientRect(),s=getComputedStyle(e);return {inside:r.left>=7&&r.right<=innerWidth-7&&r.top>=7&&r.bottom<=innerHeight-7,overflow:e.scrollWidth>e.clientWidth,bg:s.backgroundColor,radius:s.borderRadius,z:s.zIndex,pageOverflow:document.documentElement.scrollWidth>innerWidth}})()`)
          assert(result.inside && !result.overflow && !result.pageOverflow, JSON.stringify(result))
          assert.equal(result.radius,'8px'); assert.equal(result.z,'60'); assert.notEqual(result.bg,'rgba(0, 0, 0, 0)')
          if (width===375 || width===1920) await shot(`${width}-${theme}-${index}`)
          await browser.click(`${picker} [aria-label="カレンダーピッカーを閉じる"]`); await closed()
        }
      }
    }
  })
  assert.deepEqual(errors, [])
})
