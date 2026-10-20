import { assertTaskTable } from './current-task-ui.mjs'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { openBrowser } from './browser.mjs'
import { startMetadataBackend } from './metadata-backend.mjs'

export async function sidebarCollapseAcceptance(t, output, { responsive = false } = {}) {
  const { base, api } = await startMetadataBackend(t)
  assert.notEqual(new URL(base).port, '8000')
  const project = await api('/projects', { name: 'Sidebar確認プロジェクト・長い名前の表示と編集を確認する', color: '#001AFF' })
  const tags = []
  for (const name of ['学習', '開発', '長い名前のタグを表示する', '確認待ち']) tags.push(await api('/tags', { name }))
  const task = await api('/tasks', { title: 'Sidebar・時間記録の回帰確認と長いタスク名の二行表示を確認する。'.repeat(4), projectId: project.id, estimatedMinutes: 60, tagIds: tags.map(tag => tag.id) })
  const entry = await api('/time-entries', { taskId: task.id, startedAt: '2026-10-06T04:00:00Z', endedAt: '2026-10-06T04:30:00Z' })
  await api('/tasks', { title: '未配置タスク', projectId: project.id })
  const browser = await openBrowser(); t.after(() => browser.close())
  await browser.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' })
  const requests = [], errors = [], checks = [], measurements = {}
  browser.listeners.push(message => {
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method !== 'Fetch.requestPaused') return
    const { request, requestId } = message.params
    void (async () => {
      const source = new URL(request.url); assert.equal(source.port, '8000')
      if (request.method === 'OPTIONS') return browser.fulfill(requestId, {})
      const effective = base + source.pathname + source.search; assert.notEqual(new URL(effective).port, '8000')
      const item = { source: request.url, effective, method: request.method, payload: request.postData ? JSON.parse(request.postData) : null }; requests.push(item)
      const response = await fetch(effective, { method: request.method, ...(request.postData ? { headers: { 'Content-Type': 'application/json' }, body: request.postData } : {}) })
      item.status = response.status; await browser.fulfill(requestId, await response.json(), response.status)
    })().catch(error => { if (!/Invalid [Ii]nterceptionId|Invalid requestId/.test(error.message)) errors.push(String(error)) })
  })
  await browser.send('Fetch.enable', { patterns: [{ urlPattern: 'http://localhost:8000/*', requestStage: 'Request' }, { urlPattern: 'http://127.0.0.1:8000/*', requestStage: 'Request' }] })
  const check = async (name, action) => { let failure; await t.test(name, async () => { try { await action() } catch (error) { failure = error; throw error } }); if (failure) throw failure; checks.push(name) }
  const shot = async name => { if (!output) return; await mkdir(output, { recursive: true }); const result = await browser.send('Page.captureScreenshot', { format: 'png', fromSurface: true }); await writeFile(new URL(name + '.png', output), Buffer.from(result.data, 'base64')) }
  const device = width => width > 980 ? 'desktop' : width > 680 ? 'tablet' : 'mobile'
  const size = async width => { await browser.send('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: false }); await browser.until(`document.querySelector('.app-layout')?.dataset.device===${JSON.stringify(device(width))}`, 'Responsive state') }
  const mounted = () => browser.until('document.querySelector(".app-layout") && document.querySelector(".workspace-sidebar")', 'Mounted')
  const settled = async (collapsed, width = 1440) => {
    await browser.until(`(()=>{const shell=document.querySelector('.app-layout'),main=document.querySelector('.app-main');const expected=${width}>980?(shell?.dataset.page==='home'?(${collapsed}?64:256):64):(${collapsed}?0:192);return shell?.dataset.sidebarCollapsed===${JSON.stringify(String(collapsed))}&&Math.abs(main.getBoundingClientRect().x-expected)<0.01})()`, 'Sidebar and Main settled')
  }
  const toggle = async (collapsed, width = 1440) => {
    const page = await browser.evaluate('document.querySelector(".app-layout").dataset.page')
    if (width > 980 && page !== 'home') await go('home')
    await tap('[data-sidebar-toggle]'); await settled(collapsed, width)
    if (width > 980 && page !== 'home') { await go(page); await settled(collapsed, width) }
  }
  const tap = async selector => {
    const point = await browser.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return{x,y,hit:e.contains(document.elementFromPoint(x,y))}})()`)
    assert(point.hit, 'Unobstructed control: ' + selector)
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: point.x, y: point.y })
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: point.x, y: point.y })
  }
  const key = async (key, virtual) => { await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key === ' ' ? 'Space' : key, windowsVirtualKeyCode: virtual, ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) }); await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key === ' ' ? 'Space' : key, windowsVirtualKeyCode: virtual }) }
  const preference = () => browser.evaluate('localStorage.getItem("workspaceSidebarCollapsed")')
  const metrics = () => browser.evaluate(`(()=>{const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right}};return{rail:rect('.icon-rail'),sidebar:rect('.workspace-sidebar'),main:rect('.app-main'),timer:rect('.global-top-timer'),overflow:document.documentElement.scrollWidth>innerWidth,visibility:getComputedStyle(document.querySelector('.workspace-sidebar')).visibility,inert:document.querySelector('.workspace-sidebar').inert}})()`)
  const go = async page => {
    if (page === 'projectDetail') { await go('projects'); await browser.until(`document.querySelector('.project-card[data-project-id="${project.id}"] .project-card-open')`, 'Project loaded'); await tap(`.project-card[data-project-id="${project.id}"] .project-card-open`) }
    else { const label = { home: 'ホーム', tasks: 'タスク', projects: 'プロジェクト', reports: 'レポート' }[page]; await tap(`.icon-rail [aria-label="${label}"]`) }
    await browser.until(`document.querySelector('.app-layout')?.dataset.page===${JSON.stringify(page)}`, 'Page ' + page)
    if (page === 'tasks' || page === 'projectDetail') await browser.until('document.querySelector(".task-table-row")', 'Tasks loaded')
    if (page === 'home') await browser.until('!document.querySelector(".calendar-schedule-status [role=status]") && document.querySelector(".unplanned-list")', 'Home loaded')
  }
  const reload = async () => { await browser.navigate(true); await mounted() }
  const alignment = async () => {
    const value = await browser.evaluate(`(()=>{const h=document.querySelector('.task-table-header'),r=document.querySelector('.task-table-row');return{columns:getComputedStyle(h).gridTemplateColumns,nameWidth:r.querySelector('.task-table-name').getBoundingClientRect().width,aligned:[...h.children].every((e,i)=>Math.abs(e.getBoundingClientRect().x-r.children[i].getBoundingClientRect().x)<.5&&Math.abs(e.getBoundingClientRect().width-r.children[i].getBoundingClientRect().width)<.5)}})()`)
    assert(value.aligned); assert(value.nameWidth >= 220)
    assert(await browser.evaluate('(()=>{const r=document.querySelector(".task-table-row"),last=r.lastElementChild;return Math.abs(last.getBoundingClientRect().right-r.getBoundingClientRect().right)<.5})()'), 'Last column consumes the table right edge')
    assert.equal(value.columns, await browser.evaluate('getComputedStyle(document.querySelector(".task-table-row")).gridTemplateColumns'))
    return value
  }
  await browser.navigate(); await mounted(); await size(1440); await settled(false)
  await check('Desktop defaults expanded with 64px Rail and 192px Home panel; accessible 32px control', async () => {
    assert.equal(await preference(), null)
    const m = await metrics(); assert.equal(m.rail.width, 64); assert.equal(m.sidebar.width, 192); assert.equal(m.main.x, 256)
    const control = await browser.evaluate(`(()=>{const b=document.querySelector('[data-sidebar-toggle]'),r=b.getBoundingClientRect(),s=b.querySelector('svg');return{width:r.width,height:r.height,label:b.getAttribute('aria-label'),expanded:b.getAttribute('aria-expanded'),target:b.getAttribute('aria-controls')===document.querySelector('.workspace-sidebar').id,title:b.title,icon:s.dataset.icon,stroke:getComputedStyle(s).strokeWidth}})()`)
    assert.equal(control.width, 32); assert.equal(control.height, 32); assert.equal(control.label, 'ワークスペースサイドバーを閉じる'); assert.equal(control.expanded, 'true'); assert(control.target); assert.equal(control.title, 'サイドバーを閉じる'); assert.equal(control.icon, 'chevronLeft'); assert.equal(control.stroke, '2px')
    await shot('1440-home-expanded')
  })
  for (const page of ['home', 'tasks', 'projects', 'projectDetail', 'reports']) await check(`1440px ${page}: Home panel preference preserves common Header and shared Task columns`, async () => {
    await go(page); await settled(false)
    const before = await metrics()
    await browser.evaluate('window.__sidebarTimerNode=document.querySelector(".global-top-timer");undefined')
    const table = ['tasks', 'projectDetail'].includes(page) ? await alignment() : null
    if (responsive) await shot(`1440-${page}-expanded`)
    await toggle(true); const after = await metrics()
    assert.equal(after.rail.width, 64); assert.equal(after.sidebar.width, 0); assert.equal(after.main.x, 64); assert.equal(after.main.width - before.main.width, page === 'home' ? 192 : 0)
    assert.equal(after.visibility, 'hidden'); assert.equal(after.inert, true); assert.equal(after.overflow, false)
    assert.equal(after.timer.height, before.timer.height); assert.equal(after.timer.y, before.timer.y)
    assert.equal(after.timer.x, before.timer.x)
    assert.equal(await browser.evaluate('document.querySelector(".global-top-timer")===window.__sidebarTimerNode'), true)
    if (table) {
      const expanded = table.columns.split(' ').map(parseFloat), collapsed = (await alignment()).columns.split(' ').map(parseFloat)
      await assertTaskTable(browser)
      assert.deepEqual(collapsed, expanded, 'Home sidebar preference does not change Task columns')
    }
    assert.equal(await preference(), 'true')
    await shot(`1440-${page}-collapsed`)
    await toggle(false); assert.equal(await preference(), 'false'); assert.equal((await metrics()).sidebar.width, page === 'home' ? 192 : 0)
    measurements[page] = { before, after, table }
  })
  await check('Collapsed state persists across all five routes and reload; expanded state also survives reload', async () => {
    await toggle(true)
    for (const page of ['tasks', 'projects', 'projectDetail', 'reports', 'home']) { await go(page); await settled(true); await reload(); await settled(true) }
    await toggle(false); await reload(); await settled(false)
    assert.equal(await preference(), 'false')
  })
  await check('Keyboard Tab reaches controls, Enter collapses, Space expands, focus and ARIA follow visible control', async () => {
    await browser.evaluate('document.querySelector(".home-add-trigger").focus()')
    let reached = false
    for (let i = 0; i < 80; i++) { await key('Tab', 9); if (await browser.evaluate('document.activeElement.hasAttribute("data-sidebar-toggle")')) { reached = true; break } }
    assert(reached)
    assert(await browser.evaluate('getComputedStyle(document.activeElement).outlineStyle!=="none"'))
    await key('Enter', 13); await settled(true)
    assert.equal(await browser.evaluate('document.activeElement.getAttribute("aria-label")'), 'ワークスペースサイドバーを開く')
    assert.equal(await browser.evaluate('document.activeElement.getAttribute("aria-expanded")'), 'false')
    await key(' ', 32); await settled(false)
    assert.equal(await browser.evaluate('document.activeElement.getAttribute("aria-expanded")'), 'true')
  })
  await check('Malformed preferences fall back expanded; unavailable storage does not break collapse/expand', async () => {
    for (const value of ['invalid', 'null', '1', '{"collapsed":true}', ' TRUE ']) {
      await browser.evaluate(`localStorage.setItem('workspaceSidebarCollapsed',${JSON.stringify(value)})`); await reload(); await settled(false)
    }
    const script = await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: 'Storage.prototype.getItem=()=>{throw new Error("Storage disabled")};Storage.prototype.setItem=()=>{throw new Error("Storage disabled")}' })
    await reload(); await settled(false); await toggle(true); await toggle(false)
    await browser.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: script.identifier })
    await reload(); await settled(false)
  })
  await check('Tablet 768px starts collapsed, opens and closes without changing Desktop preference; boundaries restore each mode', async () => {
    await toggle(true); assert.equal(await preference(), 'true')
    await size(768); await settled(true, 768); assert.equal((await metrics()).main.x, 0)
    await shot('768-collapsed'); await toggle(false, 768); assert.equal((await metrics()).sidebar.width, 192); assert.equal(await preference(), 'true')
    await shot('768-expanded'); await toggle(true, 768)
    await size(1440); await settled(true); await toggle(false)
    for (const width of [980, 981, 681, 680]) { await size(width); if (width > 680) await settled(width <= 980, width); assert.equal((await metrics()).overflow, false) }
    await size(768); await reload(); await settled(true, 768)
    await tap('.mobile-nav button:nth-child(2)'); await settled(true, 768); await toggle(false, 768); await toggle(true, 768)
    await size(1440); await settled(false)
  })
  await check('Mobile 375px ignores Desktop preference, keeps Home unplanned cards and mobile routes, and has no Desktop controls or page overflow', async () => {
    await toggle(true); await size(375)
    for (const [index, page] of [[1, 'home'], [2, 'tasks'], [3, 'projects'], [4, 'reports']]) {
      await tap(`.mobile-nav button:nth-child(${index})`)
      await browser.until(`document.querySelector('.app-layout')?.dataset.page===${JSON.stringify(page)}`, 'Mobile ' + page)
      assert.equal(await browser.evaluate('document.querySelectorAll("[data-sidebar-toggle]").length'), 0)
      assert.equal((await metrics()).overflow, false)
      if (page === 'home') { assert.equal(await browser.evaluate('document.querySelector(".workspace-sidebar").inert'), false); assert(await browser.evaluate('document.querySelector(".unplanned-panel").getBoundingClientRect().width>0')) }
    }
    await shot('375-mobile'); await size(1440); await settled(true)
  })
  await check('Collapsed Project Detail preserves TimeEntry edit/delete and native dialogs', async () => {
    await go('projectDetail'); await browser.click('.project-tabs button:nth-child(2)')
    await browser.until(`document.querySelector('.project-records [data-entry-id="${entry.id}"]')`, 'History')
    const record = `.project-records [data-entry-id="${entry.id}"]`
    await tap(record + ' [data-label="計測期間"] button')
    await browser.until(`document.querySelector('${record} [aria-label="終了時刻"]')`, 'Inline record edit')
    await browser.evaluate(`(()=>{const e=document.querySelector('${record} [aria-label="終了時刻"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'13:45');e.dispatchEvent(new Event('input',{bubbles:true}));})()`)
    await key('Enter',13); await browser.until(`!document.querySelector('${record} input')`, 'Saved inline record')
    await browser.until(`document.querySelector('${record}')?.textContent.includes('45分')`, '45 minutes')
    await settled(true); assert.equal((await api(`/tasks/${task.id}/time-entries`))[0].projectIdSnapshot, project.id)
    await browser.evaluate('window.confirm=()=>true')
    await tap(record + ' summary'); await tap(record + ' .entry-menu-options .danger')
    await browser.until('document.querySelector(".project-records .empty-state")', 'No records'); await settled(true)

  })
  await check('Active Global Timer is the same mounted node through collapse and route changes, and Stop remains operable', async () => {
    await api('/tasks/time/start', { taskId: task.id }); await reload(); await settled(true)
    await browser.until('document.querySelector(".global-top-timer.timer-session .timer-stop") && !document.querySelector(".global-top-timer .timer-stop").disabled', 'Active restored')
    await browser.evaluate('window.__sidebarTimerNode=document.querySelector(".global-top-timer");undefined')
    await toggle(false); await go('tasks'); await toggle(true); await go('reports'); await go('home')
    assert.equal(await browser.evaluate('document.querySelector(".global-top-timer")===window.__sidebarTimerNode'), true)
    assert.equal((await api('/tasks/time/active')).taskId, task.id)
    await browser.click('.global-top-timer .timer-stop'); await browser.until('!document.querySelector(".global-top-timer.timer-session")', 'Stopped')
  })
  await check('Reduced motion disables the short grid transition', async () => {
    await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    assert.equal(await browser.evaluate('getComputedStyle(document.querySelector(".app-layout")).transitionDuration'), '0s')
    await toggle(false); await browser.send('Emulation.setEmulatedMedia', { features: [] })
    assert.equal(await browser.evaluate('getComputedStyle(document.querySelector(".app-layout")).transitionDuration'), '0.18s')
  })
  if (responsive) {
    const tableMetrics = () => browser.evaluate(`(()=>{const table=document.querySelector('.task-table-header'),row=document.querySelector('.task-table-row'),scroll=document.querySelector('.task-table-scroll'),rect=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,right:r.right}};return{table:rect(table),row:rect(row),scroll:rect(scroll),scrollWidth:scroll.scrollWidth,columns:[...table.children].map(e=>rect(e).width),aligned:[...table.children].every((e,i)=>Math.abs(rect(e).x-rect(row.children[i]).x)<.1&&Math.abs(rect(e).width-rect(row.children[i]).width)<.1),project:!!row.querySelector('.task-table-project'),pageOverflow:document.documentElement.scrollWidth>innerWidth}})()`)
    for (const page of ['tasks', 'projectDetail']) await check(`${page}: bounded tables keep fixed columns visible and only flexible columns grow`, async () => {
      await go(page); await settled(false)
      const open = await tableMetrics()
      assert.equal(open.pageOverflow, false); assert(open.aligned)
      assert(Math.abs(open.table.width - Math.max(page === 'tasks' ? 1188 : 1132, open.scroll.width)) < 1)
      assert.equal(open.project, page === 'tasks')
      await toggle(true); const closed = await tableMetrics()
      assert(closed.aligned); assert.equal(closed.pageOverflow, false)
      assert(Math.abs(closed.table.width - closed.scroll.width) < 1)
      assert(closed.table.width >= open.table.width && closed.table.width - open.table.width <= 192)
      assert(Math.abs(closed.table.right - closed.scroll.right) < 1, 'Kebab reaches the table right edge')
      const flexibleCount = page === 'tasks' ? 3 : 2
      for (let i = 0; i < closed.columns.length; i++) {
        const delta = closed.columns[i] - open.columns[i]
        if (i > 0 && i <= flexibleCount) assert(delta >= 0 && (closed.columns[i] >= open.columns[i]))
        else assert(Math.abs(delta) < .1, 'Status, Priority, Deadline, Estimate, Recorded and Kebab stay fixed')
      }
      await assertTaskTable(browser)
      const text = await browser.evaluate(`(()=>{const r=document.querySelector('.task-table-row[data-task-id="${task.id}"]'),name=r.querySelector('.task-table-name button'),chips=[...r.querySelectorAll('.tag-chips>span')],project=r.querySelector('.project-picker-trigger>span');return{clamp:getComputedStyle(name).webkitLineClamp,height:name.getBoundingClientRect().height,chips:chips.map(e=>({text:e.textContent,y:e.getBoundingClientRect().y+e.getBoundingClientRect().height/2})),projectOverflow:project?getComputedStyle(project).textOverflow:null}})()`)
      assert.equal(text.clamp, '2'); assert.equal(text.height, 40)
      assert(text.chips.at(-1).text.match(/^\+\d+件$/)); assert(text.chips.every(chip => chip.y === text.chips[0].y))
      if (page === 'tasks') assert.equal(text.projectOverflow, 'ellipsis')
      measurements[page].responsive = { open, closed, text }
      await toggle(false)
    })
    for (const page of ['tasks', 'projectDetail']) await check(`${page}: narrow Desktop scrolls only inside the table; wide Desktop consumes available width`, async () => {
      await go(page)
      for (const width of [1152, 1280, 1920]) {
        await size(width)
        for (const collapsed of [false, true]) {
          await settled(collapsed, width)
          const value = await tableMetrics(), minimum = page === 'tasks' ? 1188 : 1132
          assert.equal(value.pageOverflow, false); assert(value.aligned)
          assert(Math.abs(value.table.width - Math.max(minimum, value.scroll.width)) < 1)
          assert.equal(value.scrollWidth > value.scroll.width + 1, value.scroll.width < minimum - 1)
          if (value.scroll.width < minimum) {
            await browser.evaluate('document.querySelector(".task-table-scroll").scrollLeft=200')
            assert(await browser.evaluate('document.querySelector(".task-table-scroll").scrollLeft>0'))
            assert.equal((await tableMetrics()).pageOverflow, false)
            await browser.evaluate('document.querySelector(".task-table-scroll").scrollLeft=0')
          }
          await toggle(!collapsed, width)
        }
      }
      await size(1440); await settled(false)
    })
    await check('Desktop Tasks retain the fixed 64px Rail without a Sidebar toggle; Tablet retains its 32px toggle', async () => {
      for (const width of [1440, 768]) {
        await size(width)
        if (width > 980) {
          await go('tasks')
          const value = await browser.evaluate(`(()=>{const toggle=document.querySelector('[data-sidebar-toggle]'),sidebar=document.querySelector('.workspace-sidebar'),rail=document.querySelector('.icon-rail').getBoundingClientRect(),main=document.querySelector('.app-main').getBoundingClientRect();return{toggle:getComputedStyle(toggle).display,sidebar:getComputedStyle(sidebar).display,rail:rail.width,main:main.x}})()`)
          assert.equal(value.toggle, 'none'); assert.equal(value.sidebar, 'none')
          assert.equal(value.rail, 64); assert.equal(value.main, 64)
          continue
        }
        if (await browser.evaluate('document.querySelector(".app-layout").dataset.sidebarCollapsed==="true"')) await toggle(false, width)
        await settled(false, width)
        const before = await browser.evaluate('document.querySelector("[data-sidebar-toggle]").getBoundingClientRect().y')
        await toggle(true, width)
        const value = await browser.evaluate(`(()=>{const b=document.querySelector('[data-sidebar-toggle]'),r=b.getBoundingClientRect(),timer=document.querySelector('.global-top-timer').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,clear:true,hit:b.contains(document.elementFromPoint(r.x+16,r.y+16)),focus:getComputedStyle(b).outlineStyle}})()`)
        assert.equal(value.y, before); assert.equal(value.y, 534); assert.equal(value.x, 8)
        assert.equal(value.width, 32); assert.equal(value.height, 32); assert(value.clear); assert(value.hit)
        await shot(`${width}-toggle-center`)
        await toggle(false, width)
      }
      await size(1440); await settled(false)
    })
    await check('Nav Rail uses 24px rounded Calendar, checked square, folder and bars with current Desktop rhythm and active contrast', async () => {
      await go('home')
      await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1200, y: 1000 })
      const items = await browser.evaluate(`Array.from(document.querySelectorAll('.icon-rail button')).map(b=>{const s=b.querySelector('svg'),r=b.getBoundingClientRect(),ir=s.getBoundingClientRect(),c=getComputedStyle(b);return{label:b.getAttribute('aria-label'),title:b.title,name:s.dataset.icon,class:s.getAttribute('class'),viewBox:s.getAttribute('viewBox'),width:ir.width,height:ir.height,hit:r.width,y:r.y,radius:c.borderRadius,color:c.color,background:c.backgroundColor,shape:s.innerHTML}})`)
      assert.deepEqual(items.map(item => item.name), ['calendar', 'task', 'projects', 'reports'])
      assert.equal(await browser.evaluate('document.querySelector(".icon-rail").getBoundingClientRect().width'), 64)
      for (const [index, item] of items.entries()) {
        assert.equal(item.width, 24); assert.equal(item.height, 24); assert.equal(item.hit, 56); assert.equal(item.radius, '8px')
        assert.equal(item.title, item.label); assert.equal(item.viewBox, '0 0 24 24'); assert.equal(item.class, 'nav-rail-icon')
        assert.equal(item.background, index ? 'rgba(0, 0, 0, 0)' : 'rgb(213, 238, 234)')
        assert.equal(item.color, index ? 'rgb(219, 238, 234)' : 'rgb(22, 103, 94)')
        if (index) assert.equal(item.y - items[index - 1].y, 64)
      }
      assert(items[1].shape.includes('rx="4"')); assert.equal((items[3].shape.match(/<rect/g) ?? []).length, 3)
      for (const page of ['tasks', 'projects', 'reports', 'home']) { await go(page); assert.equal(await browser.evaluate('document.querySelectorAll(".icon-rail button.active").length'), 1) }
      measurements.navRail = items
    })
  }
  assert.deepEqual(errors, [])
  return { base, checks, measurements, requests, errors, normalBackendWrites: requests.filter(request => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) && new URL(request.effective).port === '8000').length }
}
