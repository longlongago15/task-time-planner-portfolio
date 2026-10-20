import assert from 'node:assert/strict'
import test from 'node:test'
import { openBrowser } from './browser.mjs'

test('Design tokens retain their computed values and separate Button and Timer roles (API mock only)', { timeout: 120000 }, async t => {
  const b = await openBrowser()
  t.after(() => b.close())
  const task = { id: 1, title: 'Token fixture', projectId: 1, projectName: 'Project 1', status: 'NOT_STARTED', completed: false,
    estimatedMinutes: 60, actualMinutes: 0, tags: [{ id: 1, name: 'Tag 1', color: '#368AD8' }], priority: 'HIGH', deadline: null, startDate: null }
  const errors = [], writes = []
  await b.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false })
  b.listeners.push(message => {
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method !== 'Fetch.requestPaused') return
    const { requestId, request } = message.params, url = new URL(request.url)
    void (async () => {
      if (url.origin === b.url) return b.send('Fetch.continueRequest', { requestId })
      assert.equal(url.origin, 'http://localhost:8000', 'No unmocked external request')
      if (request.method === 'OPTIONS') return b.fulfill(requestId, {})
      if (request.method !== 'GET') { writes.push(request.method + ' ' + url.pathname); return b.fulfill(requestId, {}, 403) }
      let data = []
      if (url.pathname === '/tasks' || url.pathname === '/tasks/inbox') data = [task]
      else if (url.pathname === '/tasks/1') data = task
      else if (url.pathname === '/projects') data = [{ id: 1, name: 'Project 1', color: '#368AD8', taskCount: 1, completedCount: 0, estimatedMinutes: 60, actualMinutes: 0 }]
      else if (url.pathname === '/tags') data = task.tags
      else if (url.pathname === '/tasks/time/active') data = { taskId: null, running: false, startedAt: null }
      else if (url.pathname === '/reports/daily') data = { date: url.searchParams.get('date'), tasks: [], plannedOccupiedMinutes: 0, dailyEstimatedMinutes: 0, dailyActualMinutes: 0, dailyDifference: 0 }
      await b.fulfill(requestId, data)
    })().catch(error => { if (!/Invalid .*nterception|Invalid requestId/.test(error.message)) errors.push(String(error)) })
  })
  await b.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
  await b.navigate()
  await b.until("document.querySelector('.inbox-card-open')", 'Mock Home ready')
  const tokens = () => b.evaluate("(()=>{const s=getComputedStyle(document.documentElement);return Object.fromEntries(['--font-section','--text-secondary','--surface-hover','--spacing-sm','--spacing-lg','--base-radius','--control-medium','--focus-ring'].map(k=>[k,s.getPropertyValue(k).trim()]));})()")
  const appearance = selector => b.evaluate("(()=>{const e=document.querySelector(" + JSON.stringify(selector) + "),s=getComputedStyle(e),r=e.getBoundingClientRect();return {background:s.backgroundColor,color:s.color,outline:s.outlineColor,width:r.width,height:r.height,radius:s.borderRadius};})()")

  await t.test('Current type, neutral surfaces and compatibility aliases keep their rendered values', async () => {
    assert.deepEqual(await tokens(), { '--font-section': '18px', '--text-secondary': '#64748B', '--surface-hover': '#F1F5F9',
      '--spacing-sm': '8px', '--spacing-lg': '24px', '--base-radius': '8px', '--control-medium': '40px', '--focus-ring': '2px solid #0F766E' })
    assert.equal(await b.evaluate("getComputedStyle(document.body).backgroundColor"), 'rgb(248, 250, 252)')
  })

  await t.test('Token values do not depend on index.css preceding theme.css', async () => {
    const before = await tokens()
    await b.evaluate("(()=>{const styles=[...document.querySelectorAll('style[data-vite-dev-id]')],index=styles.find(e=>e.dataset.viteDevId.endsWith('/src/index.css')),theme=styles.find(e=>e.dataset.viteDevId.endsWith('/src/theme.css'));if(!index||!theme)throw new Error('Expected Vite stylesheet sources');const marker=document.createComment('restore index stylesheet');index.before(marker);theme.after(index);window.__restoreTokenStyle=()=>{marker.replaceWith(index);delete window.__restoreTokenStyle};})()")
    try { assert.deepEqual(await tokens(), before) }
    finally { await b.evaluate('window.__restoreTokenStyle()') }
  })

  await t.test('Changing Timer palette does not recolor semantic Button normal, Hover or Focus', async () => {
    await b.click('.inbox-card-open')
    await b.until("document.querySelector('.home-full-editor[open]')", 'Home Editor')
    await b.evaluate("(()=>{const e=document.querySelector('.home-full-editor [name=title]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'Unsaved token draft');e.dispatchEvent(new Event('input',{bubbles:true}));})()")
    const button = '.home-full-editor button.ui-button-primary'
    await b.until("!document.querySelector('.home-full-editor button.ui-button-primary').disabled", 'Draft enables save Button')
    const normal = await appearance(button)
    assert.equal(normal.background, 'rgb(79, 70, 229)')
    await b.evaluate("(()=>{const s=document.documentElement.style;s.setProperty('--timer-bg-active','#AA0000');s.setProperty('--timer-bg-active-hover','#BB0000');s.setProperty('--timer-icon-active','#00AA00');s.setProperty('--timer-border','#00BB00');s.setProperty('--timer-bg','#CC0000');})()")
    try {
      assert.deepEqual(await appearance(button), normal)
      await b.until("getComputedStyle(document.querySelector('.home-full-editor .task-timer-button')).backgroundColor==='rgb(204, 0, 0)'", 'Timer palette transition completed')
      assert.equal((await appearance('.home-full-editor .task-timer-button')).background, 'rgb(204, 0, 0)')
      const point = await b.evaluate("(()=>{const e=document.querySelector(" + JSON.stringify(button) + ");e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()")
      await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
      await b.until("getComputedStyle(document.querySelector('.home-full-editor button.ui-button-primary')).backgroundColor==='rgb(67, 56, 202)'", 'Button Hover transition completed')
      assert.equal((await appearance(button)).background, 'rgb(67, 56, 202)')
      await b.evaluate("document.querySelector('.home-full-editor button.ui-button-primary').focus()")
      assert.equal((await appearance(button)).outline, 'rgb(199, 210, 254)')
    } finally {
      await b.evaluate("['--timer-bg-active','--timer-bg-active-hover','--timer-icon-active','--timer-border','--timer-bg'].forEach(k=>document.documentElement.style.removeProperty(k))")
    }
  })
  assert.deepEqual(writes, [], 'Style checks never save data')
  assert.deepEqual(errors, [])
})
