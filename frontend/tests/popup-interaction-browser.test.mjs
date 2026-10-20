import assert from 'node:assert/strict'
import test from 'node:test'
import { openBrowser } from './browser.mjs'

test('Popup interactions retain nested, pending, keyboard and focus contracts (all API mocked)', { timeout: 240000 }, async t => {
  const b = await openBrowser(); t.after(() => b.close())
  const tags = [{ id: 1, name: 'First', color: '#368AD8' }, { id: 2, name: 'Second', color: '#EAB308' }]
  const projects = [1, 2].map(id => ({ id, name: 'Project ' + id, color: '#368AD8', taskCount: 3 }))
  const initial = [1, 2, 3].map(id => ({ id, title: 'Task ' + id, status: 'NOT_STARTED', completed: false, projectId: 1, tags: [tags[0]], estimatedMinutes: 60, actualMinutes: 0, priority: 'HIGH', startDate: null, deadline: '2026-10-20', createdAt: '2026-10-01', updatedAt: '2026-10-0' + id }))
  let tasks = structuredClone(initial), reject = false, hold = false, release
  const writes = [], errors = []
  b.listeners.push(message => {
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text)
    if (message.method !== 'Fetch.requestPaused') return
    const { requestId, request } = message.params, u = new URL(request.url)
    void (async () => {
      if (u.origin === new URL(b.url).origin) return b.send('Fetch.continueRequest', { requestId })
      assert.equal(u.hostname, 'localhost'); assert.equal(u.port, '8000')
      if (request.method === 'OPTIONS') return b.fulfill(requestId, {})
      if (request.method !== 'GET') {
        const body = JSON.parse(request.postData); writes.push({ method: request.method, path: u.pathname, body })
        if (request.method === 'POST' && u.pathname === '/tags') {
          const tag = { id: tags.length + 1, ...body }; tags.push(tag); return b.fulfill(requestId, tag, 201)
        }
        assert.equal(request.method, 'PUT'); assert.equal(u.pathname, '/tasks/1')
        if (hold) await new Promise(resolve => { release = resolve })
        if (reject) return b.fulfill(requestId, { detail: 'Controlled failure' }, 500)
        Object.assign(tasks[0], body, { updatedAt: '2026-10-08' }); tasks[0].completed = tasks[0].status === 'COMPLETED'
        if (body.tagIds) tasks[0].tags = tags.filter(tag => body.tagIds.includes(tag.id))
        return b.fulfill(requestId, tasks[0])
      }
      let data = []
      if (u.pathname === '/tasks' || u.pathname === '/tasks/inbox') data = tasks
      else if (u.pathname === '/projects') data = projects
      else if (u.pathname === '/tags') data = tags
      else if (u.pathname === '/tasks/time/active') data = { taskId: null, running: false, startedAt: null }
      else if (/^\/tasks\/\d+$/.test(u.pathname)) data = tasks.find(task => task.id === Number(u.pathname.split('/')[2]))
      else if (u.pathname === '/reports/daily') data = { date: u.searchParams.get('date'), tasks: [] }
      await b.fulfill(requestId, data)
    })().catch(error => { if (!/Invalid [Ii]nterceptionId|Invalid requestId/.test(error.message)) errors.push(String(error)) })
  })
  t.after(() => release?.())
  await b.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
  await b.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' })
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: '(()=>{const D=Date,n=' + Date.parse('2026-10-07T03:00:00Z') + ';window.Date=class extends D{constructor(...a){super(...(a.length?a:[n]))}static now(){return n}};window.confirm=()=>true})()' })
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: '(()=>{const add=document.addEventListener.bind(document),remove=document.removeEventListener.bind(document),counts=new Map();document.addEventListener=(type,fn,options)=>{if(["pointerdown","click","keydown"].includes(type)){const key=type+Boolean(options===true||options?.capture);if(!counts.has(key))counts.set(key,new Set());counts.get(key).add(fn)}return add(type,fn,options)};document.removeEventListener=(type,fn,options)=>{counts.get(type+Boolean(options===true||options?.capture))?.delete(fn);return remove(type,fn,options)};window.popupInteractionListeners=()=>[...counts].filter(([,items])=>items.size).map(([key,items])=>[key,items.size]).sort()})()' })
  const listeners = () => b.evaluate('window.popupInteractionListeners()')
  const frames = () => b.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  const q = selector => 'document.querySelector(' + JSON.stringify(selector) + ')'
  const focus = async selector => { await b.until('document.activeElement===' + q(selector), 'Focus returns to ' + selector); return true }
  const key = async (name, modifiers = 0) => {
    const code = { Enter: 13, ' ': 32, Escape: 27, Tab: 9, ArrowDown: 40, ArrowUp: 38, Home: 36, End: 35 }[name]
    for (const type of ['keyDown', 'keyUp']) await b.send('Input.dispatchKeyEvent', { type, key: name, code: name === ' ' ? 'Space' : name, windowsVirtualKeyCode: code, modifiers, ...(type === 'keyDown' && name === 'Enter' ? { text: '\r' } : {}) })
  }
  async function pointer(selector) {
    const measure = '(()=>{const e='+q(selector)+';if(!e||e.disabled)return null;e.scrollIntoView({block:"center",inline:"nearest"});const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return r.width>0&&r.height>0&&e.contains(document.elementFromPoint(x,y))?{x,y}:null})()'
    // Inbox can replace its enabled DOM while the independent fetches settle.
    // Recheck atomically; never dereference a Node found in a previous CDP call.
    let point = null
    try {
      while (!point) { await b.until(measure, 'Uncovered pointer target: '+selector); point = await b.evaluate(measure) }
    } catch (error) {
      // Failure evidence only: do not retry, suppress or replace the assertion.
      const evidence = await b.evaluate('(()=>{const e='+q(selector)+';if(!e)return {missing:true};const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,chain=[];for(let n=e;n;n=n.parentElement){const s=getComputedStyle(n),b=n.getBoundingClientRect();chain.push({tag:n.tagName,class:n.className,open:n.open,rect:[b.x,b.y,b.width,b.height],position:s.position,overflow:s.overflow,z:s.zIndex,transform:s.transform,scroll:[n.scrollLeft,n.scrollTop]})}return {selector:'+JSON.stringify(selector)+',active:document.activeElement?.getAttribute("class"),chain,hits:document.elementsFromPoint(x,y).slice(0,6).map(n=>({tag:n.tagName,class:n.className}))}})()')
      console.error('Popup pointer failure geometry:', JSON.stringify(evidence))
      throw error
    }
    for (const type of ['mousePressed', 'mouseReleased']) await b.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
  }

  const input = (selector, value) => b.evaluate('(()=>{const e='+q(selector)+';e.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(e,'+JSON.stringify(value)+');e.dispatchEvent(new Event("input",{bubbles:true}))})()')
  async function navigate(view = 'tasks') {
    await b.navigate(); await b.until(q('.icon-rail'), 'Navigation')
    if (view === 'reports') {
      await b.evaluate('document.documentElement.dataset.popupReload="pending";window.location.search="?reportDemo=1"')
      await b.until('!document.documentElement.dataset.popupReload&&'+q('.icon-rail'), 'Demo document')
      await b.click('.icon-rail [aria-label="\u30ec\u30dd\u30fc\u30c8"]')
      await b.until(q('.report-summary'), 'Reports Demo')
    } else if (view === 'tasks') {
      await b.click('.icon-rail [aria-label="\u30bf\u30b9\u30af"]')
      await b.until(q('[data-task-id="1"] .task-status-trigger'), 'Task Row')
    } else await b.until(q('[data-inbox-task-id="1"] .inbox-card-open')+'&&!'+q('[data-inbox-task-id="1"] .inbox-card-open')+'.disabled', 'Enabled Inbox')
    // Home -> Tasks changes grid columns; a wrapping Filter row can move the
    // target between MouseDown and MouseUp. Measure only the committed layout.
    await frames()
    await b.until('document.querySelector(".app-layout").getAnimations().every(a=>a.playState!=="running")', 'Navigation grid transition completed before pointer input')
  }
  async function filter(scope) {
    const trigger = scope+' [data-filter=project] > button', popup = scope+' .task-filter-popover'
    await pointer(trigger); assert(await focus(popup+' input'))
    await key('Tab'); assert(await b.evaluate(q(popup)+'.contains(document.activeElement)'))
    await key('Tab', 8); assert(await focus(popup+' input'))
    await key('Escape'); await b.until('!'+q(popup), 'Filter Escape'); assert(await focus(trigger))
    await pointer(trigger); await pointer(scope === '.report-filters' ? '.report-toolbar button' : '.task-search input')
    await b.until('!'+q(popup), 'Filter Outside')
  }
  for (const width of [1920, 1024, 768, 601, 600, 375]) {
    await t.test(width+'px Tasks: real pointer, keyboard, Tag form replacement, nested Project and Filters', async () => {
      await b.send('Emulation.setDeviceMetricsOverride', { width, height: 1080, deviceScaleFactor: 1, mobile: false })
      tasks = structuredClone(initial); await navigate()
      const baseline = await listeners()
      const row = '[data-task-id="1"]', trigger = row+' .task-status-trigger', popup = row+' .single-select-picker .shared-picker-popup'
      await pointer(trigger); assert(await focus(popup+' [aria-checked=true]'))
      await key('End'); assert(await focus(popup+' [data-value=COMPLETED]'))
      await key('Home'); await key('ArrowDown'); assert(await focus(popup+' [data-value=IN_PROGRESS]'))
      await key('ArrowUp'); assert(await focus(popup+' [data-value=NOT_STARTED]'))
      await key('Escape'); await b.until('!'+q(popup), 'Status Escape'); assert(await focus(trigger))
      await key('Enter'); await b.until(q(popup), 'Enter opens Status'); await key('Tab')
      await b.until('!'+q(popup), 'Tab closes Status'); assert(await b.evaluate('document.activeElement!==document.body'))
      await b.evaluate(q(trigger)+'.focus()'); await key(' '); await b.until(q(popup), 'Space opens Status'); await key('Escape')
      await pointer(trigger); await pointer('.task-search input'); await b.until('!'+q(popup), 'Outside closes Status'); assert(await focus('.task-search input'))
      await pointer(row+' .tag-picker-trigger'); assert(await focus('.tag-picker-popup input[type=search]'))
      await key('Tab'); assert(await b.evaluate(q('.tag-picker-popup')+'.contains(document.activeElement)'))
      await key('Tab', 8); assert(await focus('.tag-picker-popup input[type=search]'))
      await pointer('.tag-picker-create'); await b.until(q('.tag-create-form input'), 'Create form stays open after real click')
      await input('.tag-create-form input', 'Retained draft'); await pointer('.tag-create-actions .secondary-button')
      await b.until(q('.tag-picker-create'), 'Cancel keeps Tag Picker'); await key('Escape')
      await b.until('!'+q('.tag-picker-popup'), 'Tag Escape'); assert(await focus(row+' .tag-picker-trigger'))
      await pointer(row+' .project-picker-trigger'); assert(await focus(row+' [data-project-id="1"]'))
      await key('End'); assert(await focus('.project-picker-create')); await key('Enter')
      await b.until(q('.project-composer[open]'), 'Project creation overlay'); await key('Escape')
      await b.until('!'+q('.project-composer[open]'), 'Nested creation Escape'); assert(await focus(row+' .project-picker-trigger'))
      await filter('.task-filter-area'); assert.equal(writes.length, 0, 'Navigation, keyboard and cancellation never save')
      await frames(); assert.deepEqual(await listeners(), baseline, 'Repeated Picker and Filter cycles release document listeners')
    })
    for (const source of ['home', 'tasks']) await t.test(width+'px '+source+' Full Editor: nested Escape and Tag form keep draft', async () => {
      await navigate(source)
      if (source === 'home') {
        if (await b.evaluate('getComputedStyle(document.querySelector(".workspace-sidebar")).visibility==="hidden"')) {
          await pointer('.unified-shell > .sidebar-toggle')
          await b.until('document.querySelector(".app-layout").getAnimations().every(a=>a.playState!=="running")', 'Sidebar expanded before pointer interaction')
        }
        // Opening the Editor is setup here; use Step 5A's atomic enabled-card
        // activation while independent Inbox responses can replace that DOM.
        // Every Picker and Tag Create/Cancel below still uses real pointer coordinates.
        await b.until('(()=>{const e=document.querySelector(\'[data-inbox-task-id="1"] .inbox-card-open\');if(!e||e.disabled)return false;e.focus();e.click();return true})()', 'Ready Inbox Editor setup')
      }
      else { await pointer('[data-task-id="1"] summary'); await pointer('[data-task-id="1"] .task-row-edit') }
      await b.until(q('.task-editor-panel[open]'), 'Full Editor')
      const scope = '.task-editor-panel[open]'
      await input(scope+' [name=title]', 'Unsubmitted draft')
      await pointer(scope+' .task-status-trigger'); await b.until(q(scope+' .single-select-picker .shared-picker-popup'), 'Status opened before Escape'); await key('Escape'); assert(await b.evaluate('Boolean('+q(scope)+')'))
      await pointer(scope+' .tag-picker-trigger'); await pointer('.tag-picker-create')
      await input('.tag-create-form input', 'Unsubmitted Tag'); await key('Escape')
      await b.until('!'+q('.tag-picker-popup'), 'Tag closes before Editor')
      assert.equal(await b.evaluate(q(scope+' [name=title]')+'.value'), 'Unsubmitted draft')
      await pointer(scope+' .project-picker-trigger'); await pointer('.project-picker-create')
      await b.until(q('.project-composer[open]'), 'Nested Project dialog'); await key('Escape')
      await b.until('!'+q('.project-composer[open]'), 'Only Project dialog closes')
      assert(await b.evaluate('Boolean('+q(scope)+')')); assert(await focus(scope+' .project-picker-trigger'))
      await pointer(scope+' .icon-close'); await b.until('!'+q(scope), 'Discard through existing confirmation')
      assert.equal(writes.length, 0, 'Draft and Escape never save')
    })
    await t.test(width+'px Reports: Filter focus, Tab, Escape and Outside remain independent', async () => { await navigate('reports'); await filter('.report-filters'); assert.equal(writes.length, 0) })
  }
  await t.test('Project initial focus reveals the selected option in a scrollable Popup', async () => {
    await b.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 320, deviceScaleFactor: 1, mobile: false })
    for (let id = 3; id <= 20; id++) projects.push({ id, name: 'Project ' + id, color: '#368AD8' })
    tasks = structuredClone(initial); tasks[0].projectId = 20; await navigate()
    await pointer('[data-task-id="1"] .project-picker-trigger')
    await b.until('document.activeElement==='+q('[data-project-id="20"]'), 'Selected Project receives initial focus')
    assert(await b.evaluate('(()=>{const p=document.querySelector(".project-picker-popup"),e=document.activeElement,r=e.getBoundingClientRect(),box=p.getBoundingClientRect();return p.scrollTop>0&&r.top>=box.top&&r.bottom<=box.bottom})()'))
    await key('Escape'); assert(await focus('[data-task-id="1"] .project-picker-trigger'))
  })
  await t.test('Failure, pending guard, row sorting and removal preserve save and focus contracts', async () => {
    await b.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false })
    for (let attempt = 0; attempt < 3; attempt++) {
    const before = writes.length
    tasks = structuredClone(initial); await navigate()
    const trigger = '[data-task-id="1"] .task-status-trigger', popup = '[data-task-id="1"] .shared-picker-popup', option = popup+' [data-value=IN_PROGRESS]'
    reject = true; await pointer(trigger); await pointer(option)
    await b.until(q(popup+' [role=alert]'), 'Failed save keeps Popup'); assert(await focus(option))
    assert.equal(writes.length, before + 1); assert.deepEqual(writes[before].body, { status: 'IN_PROGRESS' })
    reject = false; hold = true; await pointer(option); await b.until(q(popup+' button:disabled'), 'Pending')
    await key('Escape'); await pointer('.task-search input'); await b.evaluate(q(option)+'.click()')
    assert(await b.evaluate('Boolean('+q(popup)+')')); assert.equal(writes.length, before + 2)
    hold = false; release(); release = undefined
    await b.until('!'+q(popup), 'Retry success closes Popup'); await b.until('document.activeElement==='+q(trigger), 'Focus after sort')
    assert.equal(await b.evaluate('document.querySelector(".task-table-row").dataset.taskId'), '1')
    await pointer('[data-filter=status] > button'); await pointer('[data-filter=status] label:nth-of-type(2) input'); await key('Escape')
    await pointer(trigger); await pointer(popup+' [data-value=COMPLETED]')
    await b.until('!'+q('[data-task-id="1"]'), 'Selected status removes Task from filtered list')
    await b.until('document.activeElement==='+q('.task-table-scroll'), 'Focus falls back to existing Table after Task unmount')
    assert.equal(writes.length, before + 3); assert.deepEqual(writes[before + 2].body, { status: 'COMPLETED' })
    }
  })
  assert.deepEqual(errors, [])
})
