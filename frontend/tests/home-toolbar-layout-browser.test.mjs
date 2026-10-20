import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openBrowser } from './browser.mjs'

test('Home Toolbar wraps only when needed and routes pointer and keyboard actions correctly (API mocks)', { timeout: 180000 }, async t => {
  const output = process.env.LAYOUT_AUDIT_DIR ?? await mkdtemp(path.join(tmpdir(), 'home-toolbar-layout-'))
  await mkdir(output, { recursive: true })
  const baseline = process.env.LAYOUT_BASELINE ? JSON.parse(await readFile(process.env.LAYOUT_BASELINE, 'utf8')) : {}
  const b = await openBrowser(), metrics = [], errors = [], writes = []
  let rejectSchedules = false
  t.after(async () => { await writeFile(path.join(output, 'home.json'), JSON.stringify({ metrics, writes, errors }, null, 2)); await b.close() })
  await b.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' })
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{const D=Date,now=${Date.parse('2026-10-16T12:00:00+09:00')};window.Date=class extends D{constructor(...a){super(...(a.length?a:[now]))}static now(){return now}};window.__toolbarHits=[];document.addEventListener('click',e=>{const button=e.target.closest('button');window.__toolbarHits.push({expected:button===window.__expectedToolbarTarget,text:button?.textContent,label:button?.getAttribute('aria-label')})},true)})()` })
  b.listeners.push(message => {
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method !== 'Fetch.requestPaused') return
    const { requestId, request } = message.params, u = new URL(request.url)
    void (async () => {
      assert.equal(u.hostname, 'localhost'); assert.equal(u.port, '8000')
      if (request.method === 'OPTIONS') return b.fulfill(requestId, {})
      if (request.method !== 'GET') { writes.push({ method: request.method, path: u.pathname }); assert.fail('Toolbar must not mutate data') }
      if (u.pathname === '/schedule-blocks' && rejectSchedules) return b.fulfill(requestId, { detail: 'Controlled schedule failure' }, 500)
      let data = []
      if (u.pathname === '/tasks/time/active') data = { taskId: null, running: false, startedAt: null }
      else if (u.pathname === '/reports/daily') data = { date: u.searchParams.get('date'), tasks: [] }
      await b.fulfill(requestId, data)
    })().catch(error => { if (!/Invalid [Ii]nterceptionId|Invalid requestId/.test(error.message)) errors.push(String(error)) })
  })
  await b.send('Fetch.enable', { patterns: [{ urlPattern: 'http://localhost:8000/*', requestStage: 'Request' }] })
  const modeSelector = '.calendar-period-controls > .calendar-mode-switch', today = '.home-calendar-controls .today-button'
  const frames = () => b.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  const settle = async () => { await b.until('!!document.querySelector(".calendar-update-status.is-idle") && !document.querySelector(".calendar-schedule-status [role=status],.calendar-loading-status [role=status]")', 'Calendar data committed before measuring or changing periods'); await b.until('document.querySelector(".app-layout").getAnimations({subtree:true}).every(a=>a.playState!=="running")', 'Layout transition settled'); await frames() }
  const key = async (name, code) => {
    await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: name, windowsVirtualKeyCode: code, ...(name === 'Enter' ? { text: '\r' } : {}) })
    await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: code })
  }
  const pointer = async selector => {
    await b.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest',inline:'nearest'});window.__expectedToolbarTarget=e})()`); await frames()
    const p = await b.evaluate(`(()=>{const e=window.__expectedToolbarTarget,r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;const hit=document.elementFromPoint(x,y);return{x,y,hit:e.contains(hit),hitClass:hit?.getAttribute('class'),hitTag:hit?.tagName,hitHtml:hit?.outerHTML.slice(0,350)}})()`)
    const before = await b.evaluate('window.__toolbarHits.length')
    for (const type of ['mousePressed', 'mouseReleased']) await b.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, x: p.x, y: p.y })
    await b.until(`window.__toolbarHits.length>${before}`, 'Real pointer click captured')
    return { ...p, ...await b.evaluate('window.__toolbarHits.at(-1)') }
  }
  const boundaryModePositions = new Map(), modeOrigins = new Map()
  for (const width of [375, 600, 768, 1024, 1440, 1920]) for (const collapsed of width >= 768 ? [false, true] : [false]) {
    await b.send('Emulation.setDeviceMetricsOverride', { width, height: 1080, deviceScaleFactor: 1, mobile: false })
    await b.navigate(); await b.until('!!document.querySelector(".home-calendar-controls") && !!document.querySelector(".calendar-grid-content")', 'Home Calendar')
    if (width >= 768 && await b.evaluate('document.querySelector(".app-layout").dataset.sidebarCollapsed') !== String(collapsed)) await b.click('[data-sidebar-toggle]')
    await b.until(`document.querySelector('.app-layout').dataset.sidebarCollapsed===${JSON.stringify(String(collapsed))}`, 'Sidebar state'); await settle()
    for (const mode of ['day', 'week', 'month']) await t.test(`${width}px Sidebar ${collapsed ? 'closed' : 'open'} ${mode} layout and hit targets`, async () => {
      await b.click(modeSelector + ` > button:nth-child(${['day', 'week', 'month'].indexOf(mode) + 1})`)
      await b.until(`document.querySelector('.calendar-period-navigation').dataset.mode===${JSON.stringify(mode)}`, 'Mode displayed'); await settle()
      const measurement = await b.evaluate(`(()=>{const header=document.querySelector('.home-calendar-header'),toolbar=header.querySelector('.home-calendar-controls'),rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};const buttons=[...toolbar.querySelectorAll('button')].map(e=>({text:e.textContent,rect:rect(e)}));return {width:${width},collapsed:${collapsed},mode:${JSON.stringify(mode)},rects:{toolbar:rect(toolbar),nav:rect(toolbar.querySelector('.calendar-navigation-controls')),period:rect(toolbar.querySelector('.calendar-period-navigation')),mode:rect(toolbar.querySelector('.calendar-period-controls > .calendar-mode-switch')),today:rect(toolbar.querySelector('.today-button')),compare:rect(toolbar.querySelector('.home-calendar-display-controls')),view:rect(toolbar.querySelector('.home-view-switch'))},header:rect(header),body:rect(document.querySelector('.calendar-page .week-calendar-panel,.calendar-page .month-calendar-panel')),buttons,page:{client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth},overflow:getComputedStyle(header).overflow}})()`)
      const originKey = `${width}:${collapsed}`
      const origin = [measurement.rects.mode.left, measurement.rects.mode.top]
      if (mode === 'day') modeOrigins.set(originKey, origin)
      assert.deepEqual(origin, modeOrigins.get(originKey), 'Day/Week/Month keep the approved Mode origin')
      metrics.push(measurement)
      if (mode === 'week' && ([375, 768, 1024].includes(width) || width === 1920 && !collapsed)) { const { data } = await b.send('Page.captureScreenshot', { format: 'png' }); await writeFile(path.join(output, `home-${width}-${collapsed}.png`), Buffer.from(data, 'base64')) }
      const label = () => b.evaluate('document.querySelector(".calendar-period-label").textContent')
      const original = await label(); await b.click('.calendar-period-navigation > button:first-child')
      await b.until(`document.querySelector('.calendar-period-label').textContent!==${JSON.stringify(original)}`, 'Previous period shown')
      measurement.todayHit = await pointer(today)
      if (measurement.todayHit.expected) await b.until(`document.querySelector('.calendar-period-label').textContent===${JSON.stringify(original)}`, 'Today restores period')
      if (mode === 'week') {
        measurement.planHit = await pointer('.calendar-comparison-switch > button:first-child')
        measurement.compareHit = await pointer('.calendar-comparison-switch > button:last-child')
        assert.equal(await b.evaluate('document.querySelector(".calendar-comparison-switch > button:last-child").getAttribute("aria-pressed")'), 'true')
        const beforeView = await label(); await b.click('.home-view-switch > button:last-child'); await b.until('!!document.querySelector(".home-entry-list")', 'List opened')
        assert.equal(await label(), beforeView); await b.click('.home-view-switch > button:first-child'); await b.until('!!document.querySelector(".calendar-grid-content")', 'Calendar restored')
      }
      await b.evaluate('document.querySelector(".home-calendar-controls button").focus()')
      const count = await b.evaluate('document.querySelectorAll(".home-calendar-controls button").length')
      for (let index = 1; index < count; index++) {
        await key('Tab', 9)
        assert.equal(await b.evaluate(`document.activeElement===document.querySelectorAll('.home-calendar-controls button')[${index}]`), true, 'Keyboard order follows existing DOM order')
      }
      await b.evaluate(`document.querySelector(${JSON.stringify(today)}).focus()`)
      measurement.focus = await b.evaluate(`(()=>{const e=document.activeElement,s=getComputedStyle(e),r=e.getBoundingClientRect();return {outline:s.outlineStyle,outlineWidth:s.outlineWidth,shadow:s.boxShadow,visible:r.width>0&&r.height>0,ancestors:[e.parentElement,e.closest('.calendar-navigation-controls'),e.closest('.home-calendar-header')].map(a=>getComputedStyle(a).overflow)}})()`)
      await key('Enter', 13); await b.until(`document.querySelector('.calendar-period-label').textContent===${JSON.stringify(original)}`, 'Keyboard Today restores period')
      assert(measurement.todayHit.hit && measurement.todayHit.expected, 'Today must receive its own click')
      if (mode === 'week') assert(measurement.planHit.hit && measurement.planHit.expected && measurement.compareHit.hit && measurement.compareHit.expected, 'Comparison buttons must receive their own clicks')
      assert(measurement.body.top >= measurement.header.bottom, 'Calendar body must follow Toolbar')
      if (width >= 981) assert.equal(measurement.rects.view.right, measurement.rects.toolbar.right, 'Calendar/List stays right aligned even after wrapping')
      assert(measurement.page.scroll <= measurement.page.client, 'Page must not overflow horizontally')
      const intersect = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
      for (let i = 0; i < measurement.buttons.length; i++) for (let j = i + 1; j < measurement.buttons.length; j++) assert.equal(intersect(measurement.buttons[i].rect, measurement.buttons[j].rect), 0, 'Toolbar buttons must not overlap')
      assert(measurement.focus.visible); assert(measurement.focus.ancestors.every(overflow => overflow === 'visible'), 'Today Focus ring must not be clipped')
      assert(measurement.focus.outline !== 'none' || measurement.focus.shadow !== 'none', 'Keyboard Focus remains visible')
      const before = baseline.metrics?.find(m => m.width === width && m.collapsed === collapsed && m.mode === mode)
      if (before && width === 1920) assert.deepEqual(measurement.rects, before.rects, 'Preserve wide Desktop placement')
      // The approved fixed Mode origin corrects the old Mobile/Tablet positions.
      // Preserve the control sizes and all hit/Focus/overflow checks instead.
      if (before && width <= 768) for (const name of ['mode', 'today']) {
        assert.equal(measurement.rects[name].width, before.rects[name].width, `${name} control width is unchanged`)
        assert.equal(measurement.rects[name].height, before.rects[name].height, `${name} control height is unchanged`)
      }
      if (width === 1024) for (const boundaryWidth of [980, 981, 982]) {
        await b.send('Emulation.setDeviceMetricsOverride', { width: boundaryWidth, height: 1080, deviceScaleFactor: 1, mobile: false })
        await b.until(`document.querySelector('.app-layout').dataset.device===${JSON.stringify(boundaryWidth > 980 ? 'desktop' : 'tablet')}`, 'Boundary device ready')
        if (await b.evaluate('document.querySelector(".app-layout").dataset.sidebarCollapsed') !== String(collapsed)) await b.click('[data-sidebar-toggle]')
        await b.until(`document.querySelector('.app-layout').dataset.sidebarCollapsed===${JSON.stringify(String(collapsed))}`, 'Boundary Sidebar state'); await settle()
        const boundary = await b.evaluate(`(()=>{const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}},toolbar=document.querySelector('.home-calendar-controls');return {width:${boundaryWidth},collapsed:${collapsed},mode:${JSON.stringify(mode)},rects:{toolbar:rect(toolbar),nav:rect(toolbar.querySelector('.calendar-navigation-controls')),mode:rect(toolbar.querySelector('.calendar-period-controls > .calendar-mode-switch')),today:rect(toolbar.querySelector('.today-button')),compare:toolbar.querySelector('.home-calendar-display-controls')?rect(toolbar.querySelector('.home-calendar-display-controls')):null,view:rect(toolbar.querySelector('.home-view-switch'))},buttons:[...toolbar.querySelectorAll('button')].map(rect),header:rect(document.querySelector('.home-calendar-header')),body:rect(document.querySelector('.calendar-page .week-calendar-panel,.calendar-page .month-calendar-panel'))}})()`)
        if (boundaryWidth >= 981) {
          assert.equal(boundary.rects.nav.left, boundary.rects.toolbar.left, 'A wrapped first row must keep Navigation at the left edge')
          const positionKey = `${boundaryWidth}:${collapsed}`
          if (mode === 'day') boundaryModePositions.set(positionKey, boundary.rects.mode.left)
          assert.equal(boundary.rects.mode.left, boundaryModePositions.get(positionKey), 'Desktop Mode position stays fixed across day/week/month')
          assert.equal(boundary.rects.view.right, boundary.rects.toolbar.right)
        }
        assert(boundary.body.top >= boundary.header.bottom)
        for (let i = 0; i < boundary.buttons.length; i++) for (let j = i + 1; j < boundary.buttons.length; j++) assert.equal(intersect(boundary.buttons[i], boundary.buttons[j]), 0)
        const boundaryLabel = await label()
        boundary.previousHit = await pointer('.calendar-period-navigation > button:first-child'); assert(boundary.previousHit.hit && boundary.previousHit.expected)
        await b.until(`document.querySelector('.calendar-period-label').textContent!==${JSON.stringify(boundaryLabel)}`, 'Boundary previous period')
        boundary.nextHit = await pointer('.calendar-period-navigation > button:last-child'); assert(boundary.nextHit.hit && boundary.nextHit.expected)
        await b.until(`document.querySelector('.calendar-period-label').textContent===${JSON.stringify(boundaryLabel)}`, 'Boundary next period')
        boundary.todayHit = await pointer(today); assert(boundary.todayHit.hit && boundary.todayHit.expected)
        await key('Tab', 9)
        await b.evaluate(`document.querySelector(${JSON.stringify(today)}).focus()`)
        boundary.focus = await b.evaluate(`(()=>{const e=document.activeElement,s=getComputedStyle(e);return {correct:e===document.querySelector(${JSON.stringify(today)}),outline:s.outlineStyle,shadow:s.boxShadow}})()`)
        assert(boundary.focus.correct && (boundary.focus.outline !== 'none' || boundary.focus.shadow !== 'none'), JSON.stringify(boundary.focus))
        await key('Enter', 13); assert.equal(await label(), boundaryLabel)
        if (mode === 'week') {
          boundary.planHit = await pointer('.calendar-comparison-switch > button:first-child'); assert(boundary.planHit.hit && boundary.planHit.expected)
          boundary.compareHit = await pointer('.calendar-comparison-switch > button:last-child'); assert(boundary.compareHit.hit && boundary.compareHit.expected)
          const { data } = await b.send('Page.captureScreenshot', { format: 'png' }); await writeFile(path.join(output, `home-${boundaryWidth}-${collapsed}.png`), Buffer.from(data, 'base64'))
        }
        metrics.push(boundary)
        await b.send('Emulation.setDeviceMetricsOverride', { width, height: 1080, deviceScaleFactor: 1, mobile: false }); await settle()
      }
    })
  }
  await t.test('Idle overlay releases Toolbar hits while schedule error Retry stays interactive', async () => {
    await b.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 1080, deviceScaleFactor: 1, mobile: false })
    await b.navigate(); await b.until('!!document.querySelector(".calendar-grid-content") && !!document.querySelector(".calendar-update-status.is-idle")', 'Initial Calendar ready')
    await settle(); rejectSchedules = true; await b.click(modeSelector + ' > button:nth-child(2)')
    const retry = '.calendar-schedule-status [role=alert] button'
    await b.until(`!!document.querySelector(${JSON.stringify(retry)})`, 'Schedule retry visible')
    assert.equal(await b.evaluate('getComputedStyle(document.querySelector(".calendar-schedule-status")).pointerEvents'), 'auto')
    rejectSchedules = false; const hit = await pointer(retry)
    assert(hit.hit && hit.expected, 'Retry button still receives its click')
    await b.until('!document.querySelector(".calendar-schedule-status [role=alert]") && !!document.querySelector(".calendar-update-status.is-idle")', 'Retry recovered')
    assert.equal(await b.evaluate('getComputedStyle(document.querySelector(".calendar-schedule-status")).pointerEvents'), 'none')
    metrics.push({ kind: 'retry', hit })
  })
  assert.deepEqual(writes, []); assert.deepEqual(errors, [])
  console.log('Home measurements:', path.join(output, 'home.json'))
})
