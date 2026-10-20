import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openBrowser } from './browser.mjs'
import { createMockRequestLifecycle } from './mock-request-lifecycle.mjs'
import { selectReportMode, selectReportAnchor } from './report-picker.mjs'

const q = s => 'document.querySelector(' + JSON.stringify(s) + ')'
async function key(b, key) {
  const code = key === ' ' ? 'Space' : key, n = { Enter: 13, Escape: 27, Tab: 9, ' ': 32 }[key]
  for (const type of ['keyDown', 'keyUp']) await b.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: n, ...(key === 'Enter' && type === 'keyDown' ? { text: '\r' } : {}) })
}
async function fixture(t) {
  const b = await openBrowser()
  const out = await mkdtemp(path.join(tmpdir(), 'task-focus-report-geometry-'))
  const capture = async name => { const shot = await b.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await writeFile(path.join(out, name + '.png'), Buffer.from(shot.data, 'base64')) }
  const errors = [], writes = [], metrics = [], held = [], pending = new Set()
  const projects = [{ id: 1, name: 'Project 1', color: '#368AD8' }]
  const tasks = [1, 2].map(id => ({ id, title: 'Task ' + id, status: 'NOT_STARTED', completed: false, projectId: id === 1 ? 1 : null, projectName: id === 1 ? 'Project 1' : null, priority: id === 1 ? 'HIGH' : null, tags: [], estimatedMinutes: 60, actualMinutes: 0, startDate: null, deadline: null }))
  const state = { hold: false, error: false }
  const network = createMockRequestLifecycle(b)
  const listener = m => {
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails)
    if (m.method !== 'Fetch.requestPaused') return
    const { request } = m.params, u = new URL(request.url)
    const operation = (async () => {
      if (u.origin === new URL(b.url).origin) return network.continue(m.params)
      assert.equal(u.origin, 'http://localhost:8000', 'Only the in-memory API mock is reachable')
      if (request.method === 'OPTIONS') return network.fulfill(m.params, {})
      if (request.method !== 'GET') {
        const body = JSON.parse(request.postData)
        writes.push({ method: request.method, path: u.pathname, body })
        assert.equal(request.method, 'PUT'); assert.equal(u.pathname, '/tasks/2')
        assert.equal(Object.keys(body).length, 1); assert(['projectId', 'priority'].includes(Object.keys(body)[0]))
        Object.assign(tasks[1], body)
        tasks[1].projectName = tasks[1].projectId ? 'Project 1' : null
        return network.fulfill(m.params, tasks[1])
      }
      let data = []
      if (u.pathname === '/tasks' || u.pathname === '/tasks/inbox') data = tasks
      else if (u.pathname === '/projects') data = projects
      else if (/^\/tasks\/\d+$/.test(u.pathname)) data = tasks.find(x => x.id === +u.pathname.split('/')[2])
      else if (u.pathname === '/tasks/time/active') data = { taskId: null, running: false, startedAt: null }
      else if (u.pathname === '/reports/daily') data = { date: u.searchParams.get('date'), tasks: [], plannedOccupiedMinutes: 0, dailyEstimatedMinutes: 0, dailyActualMinutes: 0, dailyDifference: 0 }
      if (u.pathname === '/schedule-blocks' && state.hold) { held.push({ ...m.params, data }); return }
      await network.fulfill(m.params, state.error && u.pathname === '/schedule-blocks' ? { detail: 'Controlled geometry error' } : data, state.error && u.pathname === '/schedule-blocks' ? 500 : 200)
    })().catch(e => errors.push(String(e))).finally(() => pending.delete(operation))
    pending.add(operation)
  }
  b.listeners.push(listener)
  await b.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
  await b.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' })
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: '(()=>{const D=Date,n=' + Date.parse('2026-10-07T03:00:00Z') + ';window.Date=class extends D{constructor(...a){super(...(a.length?a:[n]))}static now(){return n}}})()' })
  const frames = () => b.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
  const resize = async width => { await b.send('Emulation.setDeviceMetricsOverride', { width, height: 1080, deviceScaleFactor: 1, mobile: false }); await frames(); await b.until('!document.querySelector(".app-layout") || document.querySelector(".app-layout").getAnimations().every(a=>a.playState!=="running")', 'Responsive Grid settled before comparing Scroll deltas'); await frames() }
  const go = async (page, width, demo = false) => {
    await resize(width); await b.send('Page.navigate', { url: b.url + (demo ? '?reportDemo=1' : '') })
    await b.until('!!document.querySelector(".icon-rail")', 'App')
    await b.click('.icon-rail [aria-label="' + (page === 'tasks' ? '\u30bf\u30b9\u30af' : '\u30ec\u30dd\u30fc\u30c8') + '"]')
    await b.until('!!document.querySelector(' + JSON.stringify(page === 'tasks' ? '.task-table-row' : '.report-period-controls') + ')', 'Page controls')
    await b.until('document.querySelector(".app-layout").getAnimations().every(a=>a.playState!=="running")', 'Shell Grid settled'); await frames()
  }
  t.after(async () => {
    try {
      state.hold = false
      for (const h of held.splice(0)) await network.fulfill(h, h.data)
      // Finish intercepted responses before closing their CDP transport; no sleeps/retries.
      while (pending.size) await Promise.all([...pending])
      await network.dispose()
      assert.deepEqual(errors, [])
    } finally {
      b.listeners.splice(b.listeners.indexOf(listener), 1)
      try { await writeFile(path.join(out, 'metrics.json'), JSON.stringify({ metrics, writes, errors, requests: network.snapshot() }, null, 2)) }
      finally { await b.close() }
    }
  })
  return { b, go, resize, frames, state, writes, metrics, out, capture }
}

test('Cell Focus covers the full Project/Priority hit surface, with and without a value (mock API)', { timeout: 180000 }, async t => {
  const { b, go, writes, metrics, frames, capture } = await fixture(t)
  for (const width of [1920, 768, 375]) {
    await go('tasks', width)
    for (const id of [1, 2]) for (const field of ['project', 'priority']) await t.test(`${width}px Task ${id} ${field}: Focus, Enter/Space, Escape and Tab`, async () => {
      const cell = `[data-task-id="${id}"] .task-table-${field}`, trigger = cell + (field === 'project' ? ' .project-picker-trigger' : ' .task-priority-pill')
      await b.evaluate(q(cell) + '.scrollIntoView({block:"center",inline:"nearest"})'); await key(b, 'Tab'); await b.evaluate(q(trigger) + '.focus()'); await frames()
      const before = await b.evaluate(`(()=>{const e=${q(trigger)},c=${q(cell)},r=c.getBoundingClientRect(),p=getComputedStyle(e,'::after'),pill=e.querySelector('.shared-pill');return {focus:e.matches(':focus-visible'),width:r.width,height:r.height,ringWidth:parseFloat(p.width),ringHeight:parseFloat(p.height),border:p.borderTopWidth,color:p.borderTopColor,radius:p.borderRadius,inset:[p.top,p.right,p.bottom,p.left],boxSizing:p.boxSizing,pill:pill?{width:pill.getBoundingClientRect().width,height:pill.getBoundingClientRect().height}:null}})()`)
      metrics.push({ kind: 'focus', viewportWidth: width, id, field, ...before }); if (id === 2 && field === 'project' && width === 1920) await capture('unset-project-focus')
      assert.equal(before.focus, true); assert(before.ringWidth > 32); assert.equal(before.ringWidth, before.width); assert.equal(before.ringHeight, before.height)
      assert.equal(before.border, '2px'); assert.equal(before.color, 'rgb(156, 163, 175)'); assert.equal(before.radius, '8px'); assert.equal(before.boxSizing, 'border-box'); assert.deepEqual(before.inset, ['0px', '0px', '0px', '0px'])
      if (before.pill) assert.deepEqual(before.pill, { width: 80, height: 32 })
      const count = writes.length
      for (const k of ['Enter', ' ']) {
        await key(b, k); await b.until(q(trigger) + '.getAttribute("aria-expanded")==="true"', 'Keyboard opens Picker')
        await key(b, 'Escape'); await b.until(q(trigger) + '.getAttribute("aria-expanded")==="false" && document.activeElement===' + q(trigger), 'Escape returns Focus')
      }
      await key(b, 'Enter'); await b.until(q(trigger) + '.getAttribute("aria-expanded")==="true"', 'Picker opened for Tab')
      await key(b, 'Tab')
      if (field === 'priority') await b.until(q(trigger) + '.getAttribute("aria-expanded")==="false"', 'Priority Tab closes Picker')
      else {
        // Project retains its existing sequential Tab navigation within the open popup.
        assert(await b.evaluate(q(trigger) + '.getAttribute("aria-expanded")==="true" && document.activeElement!==' + q(trigger)))
        await key(b, 'Escape'); await b.until(q(trigger) + '.getAttribute("aria-expanded")==="false" && document.activeElement===' + q(trigger), 'Project Escape after Tab')
      }
      assert.equal(writes.length, count, 'Opening/canceling/Tab never saves')
      assert.equal(await b.evaluate(q(cell) + '.getBoundingClientRect().width'), before.width)
      assert.equal(await b.evaluate(q(cell) + '.getBoundingClientRect().height'), before.height)
    })
  }
  await t.test('Selection alone sends exactly one existing PUT attribute payload', async () => {
    for (const [field, option, body] of [['project', '.project-picker-popup [data-project-id="1"]', { projectId: 1 }], ['priority', '.priority-popup [data-priority="LOW"]', { priority: 'LOW' }]]) {
      const trigger = '[data-task-id="2"] ' + (field === 'project' ? '.project-picker-trigger' : '.task-priority-pill')
      await b.evaluate(q(trigger) + '.focus()'); await key(b, 'Enter'); await b.until(q(option), 'Selection option')
      const count = writes.length; await b.click(option)
      await b.until(q(trigger) + '.getAttribute("aria-expanded")==="false" && !' + q(trigger) + '.disabled && document.activeElement===' + q(trigger), 'Saved and Focus returned')
      assert.equal(writes.length, count + 1); assert.deepEqual(writes.at(-1), { method: 'PUT', path: '/tasks/2', body })
    }
  })
})

function periodMetrics() {
  const toolbar = document.querySelector('.report-toolbar'), controls = document.querySelector('.report-period-controls'), nav = document.querySelector('.report-period-navigation')
  const box = e => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, height: r.height } }, s = getComputedStyle(toolbar), r = toolbar.getBoundingClientRect()
  return { toolbar: box(toolbar), controls: box(controls), navigation: box(nav), contentLeft: r.left + parseFloat(s.borderLeftWidth) + parseFloat(s.paddingLeft), contentRight: r.right - parseFloat(s.borderRightWidth) - parseFloat(s.paddingRight), buttons: [...nav.children].map(box), font: getComputedStyle(nav.querySelector('strong')).fontSize, textFits: nav.querySelector('strong').scrollWidth <= nav.children[1].clientWidth - 16, page: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }
}
function assertPeriod(m, pageLimit = m.viewport) {
  assert(m.controls.left >= m.contentLeft - 1); assert(m.controls.right <= m.contentRight + 1, JSON.stringify(m))
  assert(m.navigation.right <= m.contentRight + 1); assert(m.navigation.left >= m.contentLeft - 1)
  assert(m.page <= pageLimit + 1, 'No new page overflow'); assert.equal(m.font, '14px'); assert(m.textFits, 'Full date label fits without clipping or smaller text')
  assert.equal(m.buttons[0].width, 40); assert.equal(m.buttons[2].width, 40); assert(m.buttons.every(x => x.height >= 40))
}
test('Reports period controls stay in the padded Card and retain calendar/navigation operations (mock API)', { timeout: 180000 }, async t => {
  const { b, go, resize, metrics, writes, frames, state, capture } = await fixture(t)
  await go('reports', 1920, true)
  for (const width of [320, 375, 390, 600, 768, 1024, 1920]) for (const mode of ['day', 'week', 'month']) await t.test(`${width}px ${mode}: padded fit and full date`, async () => {
    await resize(width); await selectReportMode(b, mode); await frames()
    let pageLimit
    if (width === 320) {
      // Additional boundary: compare to the old parent rule rather than approving unrelated Mode overflow.
      pageLimit = await b.evaluate(`(()=>{const style=document.createElement('style');style.textContent='.reports-v2 .report-period-controls{min-width:auto;max-width:none}';document.head.append(style);const width=document.documentElement.scrollWidth;style.remove();return width})()`)
    }
    const m = await b.evaluate('(' + periodMetrics + ')()'); metrics.push({ kind: 'period', width, mode, legacyPageWidth: pageLimit, ...m }); assertPeriod(m, pageLimit); if (width === 375 && mode === 'week') await capture('reports-375-week')
    if (width >= 600) assert.equal(m.navigation.width, 320, 'Existing wide-screen navigation width')
    const old = await b.evaluate(q('.report-period-label') + '.textContent')
    await b.click('.report-period-navigation .period-arrow:last-child'); await b.until(q('.report-period-label') + '.textContent!==' + JSON.stringify(old), 'Next period')
    await b.click('.report-period-navigation .period-arrow:first-child'); await b.until(q('.report-period-label') + '.textContent===' + JSON.stringify(old), 'Previous period')
    await selectReportAnchor(b, '2026-10-07'); assertPeriod(await b.evaluate('(' + periodMetrics + ')()'), pageLimit)
  })
  for (const width of [375, 768, 1920]) await t.test(`${width}px: initial Loading and Error keep period controls usable`, async () => {
    state.hold = true; await go('reports', width)
    await b.until('!!document.querySelector(".reports-v2 [role=status]")', 'Controlled initial Loading')
    assertPeriod(await b.evaluate('(' + periodMetrics + ')()'))
    state.hold = false; state.error = true; await go('reports', width)
    await b.until('!!document.querySelector(".reports-v2 [role=alert]")', 'Controlled Error')
    assertPeriod(await b.evaluate('(' + periodMetrics + ')()'))
    await b.click('.report-period-label'); await b.until('!!document.querySelector(".calendar-navigation-picker")', 'Error does not block Calendar'); await key(b, 'Escape')
    state.error = false
  })
  assert.deepEqual(writes, [])
})

function tooltipMetrics() {
  const a = window.geometryAnchor, tooltip = document.querySelector('[role=tooltip]'), r = a.getBoundingClientRect(), p = tooltip.getBoundingClientRect(), v = document.documentElement.clientWidth
  const expected = { left: Math.max(8, Math.min(r.left + r.width / 2 - p.width / 2, v - p.width - 8)), top: Math.max(8, Math.min(r.top - p.height - 18, innerHeight - p.height - 8)) }
  return { anchor: { x: r.x, y: r.y }, tooltip: { x: p.x, y: p.y, right: p.right, bottom: p.bottom, width: p.width }, expected, text: tooltip.textContent, pointer: getComputedStyle(tooltip).pointerEvents, viewport: v, height: innerHeight }
}
async function expectTooltip(b) {
  await b.until('!!document.querySelector("[role=tooltip]") && getComputedStyle(document.querySelector("[role=tooltip]")).visibility==="visible"', 'Visible tooltip')
  await b.until('(()=>{const m=(' + tooltipMetrics + ')();return Math.abs(m.tooltip.x-m.expected.left)<1 && Math.abs(m.tooltip.y-m.expected.top)<1})()', 'Tooltip follows anchor').catch(async error => { error.message += '\nGeometry: ' + JSON.stringify(await b.evaluate('(' + tooltipMetrics + ')()')); throw error })
  const m = await b.evaluate('(' + tooltipMetrics + ')()')
  assert(m.tooltip.x >= 8 && m.tooltip.right <= m.viewport - 8 + 1); assert(m.tooltip.y >= 8 && m.tooltip.bottom <= m.height - 8 + 1); assert.equal(m.pointer, 'none')
  return m
}
test('Reports Tooltip follows window/internal Scroll and Resize, and cleans up on removal (mock API)', { timeout: 120000 }, async t => {
  const { b, go, resize, metrics, writes, capture } = await fixture(t)
  await go('reports', 1920, true); await selectReportMode(b, 'week')
  await b.evaluate(`Promise.all(document.querySelector('.reports-v2').getAnimations({subtree:true}).map(a=>a.finished.catch(()=>{})))`)
  await b.evaluate('window.geometryAnchor=[...document.querySelectorAll(".report-daily-chart .period-chart-bar")].find(e=>e.getBoundingClientRect().height>20);geometryAnchor.scrollIntoView({block:"center",inline:"center"});geometryAnchor.focus()')
  await t.test('Focused nonzero bar follows an 80px window Scroll without changing content', async () => {
    const before = await expectTooltip(b); await b.evaluate('window.scrollBy(0,80)'); const after = await expectTooltip(b)
    metrics.push({ kind: 'window-scroll', before, after }); await capture('tooltip-after-scroll'); assert.equal(before.anchor.y - after.anchor.y, 80); assert.equal(before.tooltip.y - after.tooltip.y, 80); assert.equal(after.text, before.text)
    assert(await b.evaluate('document.activeElement===geometryAnchor')); await key(b, 'Escape'); await b.until('!document.querySelector("[role=tooltip]")', 'Escape')
  })
  await t.test('Pointer Hover opens the same read-only tooltip and PointerLeave closes it', async () => {
    await b.evaluate('geometryAnchor.blur();geometryAnchor.scrollIntoView({block:"center",inline:"center"})')
    const point = await b.evaluate('(()=>{const r=geometryAnchor.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()')
    await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 }); await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }); await expectTooltip(b)
    await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 }); await b.until('!document.querySelector("[role=tooltip]")', 'Pointer leave')
  })
  await t.test('Resize clamps inside the viewport; actual horizontal chart scrolling updates the anchor', async () => {
    await b.evaluate('geometryAnchor.focus()'); await resize(375)
    await b.evaluate('geometryAnchor.scrollIntoView({block:"center",inline:"center"})'); metrics.push({kind:'mobile-tooltip',...(await expectTooltip(b))}); await resize(600); await b.evaluate('document.querySelector(".report-chart-scroll").scrollLeft=0;geometryAnchor=[...document.querySelectorAll(".report-daily-chart .period-chart-bar")].find(e=>{const r=e.getBoundingClientRect(),center=r.left+r.width/2;return r.height>20&&center>168&&center<document.documentElement.clientWidth-128});geometryAnchor.scrollIntoView({block:"center",inline:"nearest"});geometryAnchor.focus()'); const before = await expectTooltip(b)
    const delta = await b.evaluate('(()=>{const e=geometryAnchor.closest(".report-chart-scroll"),old=e.scrollLeft;e.scrollLeft+=40;return e.scrollLeft-old})()')
    assert.equal(delta, 40); const after = await expectTooltip(b); metrics.push({ kind: 'internal-scroll', before, after }); assert.equal(before.anchor.x - after.anchor.x, 40); assert.equal(before.tooltip.x - after.tooltip.x, 40); assert.equal(after.text, before.text)
    await resize(768); metrics.push({ kind: 'resize', ...(await expectTooltip(b)) })
  })
  await t.test('Removing a connected anchor closes its tooltip without another Scroll', async () => {
    await b.evaluate('geometryAnchor.remove()'); await b.until('!document.querySelector("[role=tooltip]")', 'Removed anchor cleanup')
  })
  await t.test('Unmount cancels pending frames and unregisters Scroll/Resize and observers', async () => {
    // Isolated mounted instance exercises lifecycle even when its parent removes it mid-frame.
    await b.evaluate(`(async()=>{
      const react=await import('/node_modules/.vite/deps/react.js'),client=await import('/node_modules/.vite/deps/react-dom_client.js'),{ReportBarTooltip}=await import('/src/ReportBarTooltip.tsx');const React=react.default??react,createRoot=client.createRoot??client.default.createRoot;
      window.tooltipHost=document.createElement('div');tooltipHost.style.cssText='position:fixed;left:180px;top:400px;height:160px';document.body.append(tooltipHost);
      window.tooltipRoot=createRoot(tooltipHost);window.tooltipListeners=[];window.tooltipObservers=[];
      const add=window.addEventListener,remove=window.removeEventListener;
      window.addEventListener=function(type,fn,...rest){if(['scroll','resize'].includes(type))tooltipListeners.push({type,fn});return add.call(this,type,fn,...rest)};
      window.removeEventListener=function(type,fn,...rest){tooltipListeners=tooltipListeners.filter(x=>x.type!==type||x.fn!==fn);return remove.call(this,type,fn,...rest)};
      for(const name of ['ResizeObserver','MutationObserver']){const C=window[name];window[name]=class extends C{constructor(...a){super(...a);tooltipObservers.push(this)}disconnect(){this.closed=true;super.disconnect()}}}
      tooltipRoot.render(React.createElement(ReportBarTooltip,{title:'Lifecycle fixture',planned:80,actual:50}));
    })()`)
    await b.until('!!document.querySelector("body > div:last-child .period-chart-bar")', 'Lifecycle fixture')
    await b.evaluate('window.geometryAnchor=tooltipHost.querySelector(".period-chart-bar");geometryAnchor.focus()'); await expectTooltip(b)
    assert.equal(await b.evaluate('tooltipListeners.length'), 2)
    await b.evaluate('window.dispatchEvent(new Event("resize"));tooltipRoot.unmount();tooltipHost.remove()')
    await b.until('!document.querySelector("[role=tooltip]")', 'Unmounted tooltip')
    assert.equal(await b.evaluate('tooltipListeners.length'), 0); assert(await b.evaluate('tooltipObservers.every(o=>o.closed)'))
    await b.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
    assert.equal(await b.evaluate('!!document.querySelector("[role=tooltip]")'), false)
  })
  assert.deepEqual(writes, [])
})
