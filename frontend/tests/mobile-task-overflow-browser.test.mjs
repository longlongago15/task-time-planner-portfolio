import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openBrowser } from './browser.mjs'

test('Mobile Tasks contain the 40px Timer without changing Project or Desktop grids (API mocks)', { timeout: 150000 }, async t => {
  const output = process.env.LAYOUT_AUDIT_DIR ?? await mkdtemp(path.join(tmpdir(), 'task-mobile-layout-'))
  await mkdir(output, { recursive: true })
  const baseline = process.env.LAYOUT_BASELINE ? JSON.parse(await readFile(process.env.LAYOUT_BASELINE, 'utf8')) : []
  const b = await openBrowser(), metrics = [], writes = [], errors = []
  t.after(async () => { await writeFile(path.join(output, 'mobile.json'), JSON.stringify({ metrics, writes, errors }, null, 2)); await b.close() })
  const tags = [{ id: 1, name: 'Readable Tag', color: '#368AD8' }]
  const project = { id: 1, name: 'Responsive project', color: '#368AD8', taskCount: 1, completedTaskCount: 0, estimatedMinutes: 60, actualMinutes: 30 }
  const task = { id: 1, title: 'Readable Task title on Mobile', projectId: 1, projectName: project.name, status: 'IN_PROGRESS', completed: false, tags, priority: 'HIGH', startDate: null, deadline: '2026-10-20', estimatedMinutes: 60, actualMinutes: 30 }
  let active = null
  await b.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' })
  b.listeners.push(message => {
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method !== 'Fetch.requestPaused') return
    const { requestId, request } = message.params, u = new URL(request.url)
    void (async () => {
      assert.equal(u.hostname, 'localhost'); assert.equal(u.port, '8000')
      if (request.method === 'OPTIONS') return b.fulfill(requestId, {})
      if (request.method !== 'GET') {
        const body = JSON.parse(request.postData); writes.push({ method: request.method, path: u.pathname, body })
        assert.equal(request.method, 'POST'); assert.deepEqual(body, { taskId: 1 })
        if (u.pathname === '/tasks/time/start') { active = { taskId: 1, running: true, startedAt: new Date(Date.now() - 60000).toISOString() }; return b.fulfill(requestId, active) }
        assert.equal(u.pathname, '/tasks/time/stop'); const startedAt = active.startedAt; active = null
        return b.fulfill(requestId, { id: 1, taskId: 1, projectIdSnapshot: 1, startedAt, endedAt: new Date().toISOString() })
      }
      let data = []
      if (u.pathname === '/tasks' || u.pathname === '/tasks/inbox') data = [task]
      else if (u.pathname === '/projects') data = [project]
      else if (u.pathname === '/tags') data = tags
      else if (u.pathname === '/tasks/1') data = task
      else if (u.pathname === '/tasks/time/active') data = active ?? { taskId: null, running: false, startedAt: null }
      else if (u.pathname === '/reports/daily') data = { date: u.searchParams.get('date'), tasks: [] }
      await b.fulfill(requestId, data)
    })().catch(error => { if (!/Invalid [Ii]nterceptionId|Invalid requestId/.test(error.message)) errors.push(String(error)) })
  })
  await b.send('Fetch.enable', { patterns: [{ urlPattern: 'http://localhost:8000/*', requestStage: 'Request' }] })
  const frames = () => b.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  const pointer = async selector => {
    await b.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',inline:'nearest'})`); await frames()
    const p = await b.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return{x,y,hit:e.contains(document.elementFromPoint(x,y))}})()`)
    assert(p.hit, 'Timer must receive the real pointer')
    await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y })
    assert.equal(await b.evaluate(`document.querySelector(${JSON.stringify(selector)}).matches(':hover')`), true, 'Timer receives Hover')
    for (const type of ['mousePressed', 'mouseReleased']) await b.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, x: p.x, y: p.y })
  }
  for (const width of [375, 600, 601, 768, 1024, 1920]) for (const screen of ['tasks', 'project']) {
    await t.test(`${screen} ${width}px contains its controls and preserves real Timer interaction`, async () => {
      await b.send('Emulation.setDeviceMetricsOverride', { width, height: 1080, deviceScaleFactor: 1, mobile: false })
      await b.navigate(); await b.until('!!document.querySelector(".icon-rail")', 'Navigation')
      if (screen === 'tasks') await b.click('.icon-rail [aria-label="\u30bf\u30b9\u30af"]')
      else { await b.click('.icon-rail [aria-label="\u30d7\u30ed\u30b8\u30a7\u30af\u30c8"]'); await b.until('!!document.querySelector(".project-card-open")', 'Project'); await b.click('.project-card-open') }
      await b.until('!!document.querySelector(".task-table-row")', 'Task row')
      if (screen === 'project') await b.until('document.querySelector(".project-summary-unplanned strong")?.textContent==="1\u4ef6"', 'Summary settled')
      await b.until('document.querySelector(".app-layout").getAnimations({subtree:true}).every(a=>a.playState!=="running")', 'Navigation layout settled'); await frames()
      const geometry = await b.evaluate(`(()=>{const r=document.querySelector('.task-table-row'),table=r.closest('.task-table-scroll'),button=r.querySelector('.task-timer-button'),cell=button.parentElement,rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};return {width:${width},screen:${JSON.stringify(screen)},client:r.clientWidth,scroll:r.scrollWidth,row:rect(r),button:rect(button),cell:rect(cell),grid:getComputedStyle(r).gridTemplateColumns,header:getComputedStyle(document.querySelector('.task-table-header')).gridTemplateColumns,padding:getComputedStyle(cell).paddingInline,overflow:getComputedStyle(cell).overflow,page:{client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth},table:{client:table.clientWidth,scroll:table.scrollWidth},title:r.querySelector('.task-table-name').textContent,tags:r.querySelector('.task-table-tags').textContent}})()`)
      metrics.push(geometry)
      if ([375, 600, 1920].includes(width)) { const { data } = await b.send('Page.captureScreenshot', { format: 'png' }); await writeFile(path.join(output, `${screen}-${width}.png`), Buffer.from(data, 'base64')) }
      assert(geometry.page.scroll <= geometry.page.client, 'Page must not scroll horizontally')
      assert(geometry.button.left >= geometry.cell.left && geometry.button.right <= geometry.cell.right, 'Timer must fit its Cell')
      assert.equal(geometry.overflow, 'visible', 'Do not hide overflow')
      assert(geometry.title.includes(task.title)); assert(geometry.tags.includes(tags[0].name))
      if (width <= 600) assert.equal(geometry.scroll, geometry.client, 'Mobile Card must not scroll internally')
      if (screen === 'tasks') { assert.equal(geometry.button.width, 40); assert.equal(geometry.button.height, 40) }
      const before = baseline.metrics?.find(m => m.width === width && m.screen === screen)
      if (before && (screen === 'project' || width > 600)) for (const key of ['grid', 'header', 'client', 'scroll']) assert.equal(geometry[key], before[key], `Preserve ${screen} ${width}px ${key}`)
      if (screen === 'tasks') {
        const selector = '.task-table-timer .task-timer-button', count = writes.length
        await b.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`)
        assert.equal(await b.evaluate(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`), true)
        await pointer(selector); await b.until('document.querySelector(".task-table-timer .task-timer-button")?.dataset.timerState==="active"', 'Timer started')
        await pointer(selector); await b.until('document.querySelector(".task-table-timer .task-timer-button")?.dataset.timerState==="default"', 'Timer stopped')
        assert.deepEqual(writes.slice(count), [{ method: 'POST', path: '/tasks/time/start', body: { taskId: 1 } }, { method: 'POST', path: '/tasks/time/stop', body: { taskId: 1 } }])
      }
    })
  }
  assert.deepEqual(errors, [])
  console.log('Mobile measurements:', path.join(output, 'mobile.json'))
})
