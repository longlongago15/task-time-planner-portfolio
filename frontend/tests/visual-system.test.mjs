import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { openBrowser, selectTimerTask } from './browser.mjs'
import { startMetadataBackend } from './metadata-backend.mjs'
import { getProjectColor, getTagColor } from '../src/identificationColors.ts'

test('44B-2 common visual system stays aligned and retains colors on a guarded Test DB', { timeout: 240000 }, async t => {
  const { base, api } = await startMetadataBackend(t)
  const project = await api('/projects', { name: '制作プロジェクト — 長い名前もSidebar幅を変更しない', color: '#568BC7' })
  const plain = await api('/projects', { name: 'Default project', color: null })
  await api('/projects', { name: 'White project', color: '#FFFFFF' })
  const tags = []
  for (const [name, color] of [['FE', '#CB729A'], ['AWS', '#529968'], ['確認待ちの長いタグ', null], ['白', '#FFFFFF']]) tags.push(await api('/tags', { name, color }))
  const title = '長いタスク名を二行まで表示して重要な情報を保つ。三行目以降は省略し、編集すると全文を確認できます。'.repeat(2)
  const task = await api('/tasks', { title, projectId: project.id, priority: 'HIGH', estimatedMinutes: 90, tagIds: tags.map(tag => tag.id), deadline: '2026-01-01' })
  for (const priority of ['MEDIUM', 'LOW', null]) await api('/tasks', { title: `Priority ${priority ?? 'none'}`, projectId: plain.id, priority })
  const browser = await openBrowser(); t.after(() => browser.close())
  const errors = []
  browser.listeners.push(message => {
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method !== 'Fetch.requestPaused') return
    const { request, requestId } = message.params
    void (async () => {
      if (request.method === 'OPTIONS') return browser.fulfill(requestId, {})
      const url = new URL(request.url)
      const response = await fetch(base + url.pathname + url.search, { method: request.method, ...(request.postData ? { headers: { 'Content-Type': 'application/json' }, body: request.postData } : {}) })
      await browser.fulfill(requestId, await response.json(), response.status)
    })().catch(error => { if (!/Invalid [Ii]nterception|Invalid requestId/.test(error.message)) errors.push(String(error)) })
  })
  await browser.send('Fetch.enable', { patterns: [{ urlPattern: 'http://localhost:8000/*', requestStage: 'Request' }] })
  const resize = width => browser.send('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: false })
  const row = `.task-table-row[data-task-id="${task.id}"]`
  const go = async page => {
    const index = { home: 0, tasks: 1, projects: 2, reports: 3 }[page === 'projectDetail' ? 'projects' : page]
    await browser.evaluate(`document.querySelectorAll('.mobile-nav button')[${index}].click()`)
    if (page === 'projectDetail') {
      await browser.until(`document.querySelector('.project-card[data-project-id="${project.id}"]')`, 'Project card loaded')
      await browser.click(`.project-card[data-project-id="${project.id}"] .project-card-open`)
    }
    await browser.until(`document.querySelector('.unified-shell')?.dataset.page===${JSON.stringify(page)}`, `${page} opened`)
    if (page === 'tasks' || page === 'projectDetail') await browser.until(`document.querySelector(${JSON.stringify(row)})`, 'Task loaded')
    if (page === 'home') await browser.until('!document.querySelector(".home-section-count").textContent.includes("読込") && !document.querySelector(".calendar-schedule-status [role=status]")', 'Home data loaded')
    if (page === 'tasks' || page === 'projectDetail') await browser.until('[...document.querySelectorAll(".task-filter-switch button span")].every(e=>e.textContent!=="—")', 'Quick View counts loaded')
    await browser.until('document.querySelector(".app-layout").getAnimations().every(a=>a.playState!=="running")', 'Navigation grid transition finished')
    // Wait for actual font/layout/ResizeObserver settling before geometry checks.
    await browser.evaluate('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))')
    await browser.evaluate('window.scrollTo(0,0)')
  }
  const shot = async (width, page) => {
    await mkdir('../docs/screenshots/step44b3', { recursive: true })
    const result = await browser.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    await writeFile(`../docs/screenshots/step44b3/${width}-${page}.png`, Buffer.from(result.data, 'base64'))
  }
  const colors = async (selector, expected) => {
    const found = await browser.evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map(e=>e.dataset.projectColor)`)
    assert(found.length, `Project icons present: ${selector}`)
    assert(found.every(color => color === expected), `${selector}: ${found}`)
  }
  const align = async () => {
    const geometry = await browser.evaluate(`(()=>{const h=[...document.querySelector('.task-table-header').children],r=[...document.querySelector(${JSON.stringify(row)}).children].slice(0,h.length);return h.map((e,i)=>({header:e.getBoundingClientRect().x,row:r[i].getBoundingClientRect().x,width:e.getBoundingClientRect().width,rowWidth:r[i].getBoundingClientRect().width}));})()`)
    for (const cell of geometry) { assert(Math.abs(cell.header - cell.row) <= 1, JSON.stringify(cell)); assert(Math.abs(cell.width - cell.rowWidth) <= 1, JSON.stringify(cell)) }
  }
  await resize(1440); await browser.navigate(); await browser.until('document.querySelector(".workspace-sidebar")', 'Workspace loaded')

  for (const width of [1440, 768, 375]) {
    await resize(width)
    if (width === 768) {
      await browser.until('document.querySelector(".app-layout").dataset.sidebarCollapsed==="true" && document.querySelector(".app-main").getBoundingClientRect().x===0', 'Tablet starts collapsed')
      await browser.click('[data-sidebar-toggle]')
    }
    if (width > 680) await browser.until(`Math.abs(document.querySelector('.app-main').getBoundingClientRect().x-(innerWidth>980?(document.querySelector('.app-layout').dataset.page==='home'?256:64):192))<0.01`, 'Sidebar transition settled')
    let reference
    for (const page of width === 375 ? ['home', 'tasks', 'projects', 'projectDetail'] : ['home', 'tasks', 'projects', 'projectDetail', 'reports']) {
      await t.test(`${width}px ${page}: common shell, local scrolling, sidebar content and screenshots`, async () => {
        await go(page)
        const metrics = await browser.evaluate(`(()=>{const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}};return {rail:rect('.icon-rail'),sidebar:rect('.workspace-sidebar'),main:rect('.app-main'),projects:rect('.sidebar-subnav'),create:rect('.sidebar-subnav button:last-child'),timer:rect('.global-top-timer'),padding:getComputedStyle(document.querySelector('.app-main')).paddingLeft,overflow:document.documentElement.scrollWidth>innerWidth+1,unplanned:!!document.querySelector('.unplanned-panel'),nav:[...document.querySelectorAll('.sidebar-subnav button')].map(e=>e.textContent.trim())}})()`)
        assert.equal(metrics.overflow, false, `${width}/${page} page must not scroll horizontally`)
        assert.equal(metrics.unplanned, page === 'home')
        assert.deepEqual(metrics.nav, ['ホーム画面', 'プロジェクト一覧'])
        if (width > 680) {
          assert.equal(metrics.sidebar.width, width > 980 && page !== 'home' ? 0 : 192); assert.equal(metrics.padding, width > 980 && page === 'home' ? '16px' : '24px')
          if (width > 980) assert.equal(metrics.rail.width, 64)
          assert.equal(metrics.main.x, width > 980 ? page === 'home' ? 256 : 64 : 192)
          if (reference) for (const key of width > 980 ? ['timer'] : ['sidebar', 'main', 'projects', 'create', 'timer']) assert.equal(metrics[key].x, reference[key].x, `${key} x stays fixed`)
          if (reference) { if(width<=980) { assert.equal(metrics.projects.y, reference.projects.y); assert.equal(metrics.create.y, reference.create.y) } assert.equal(metrics.timer.y, reference.timer.y); assert.equal(metrics.timer.height, reference.timer.height) }
          reference = metrics
        } else {
          assert.equal(metrics.padding, '16px')
          if (reference) for (const dimension of ['x', 'y', 'height']) assert.equal(metrics.timer[dimension], reference.timer[dimension], `Mobile Timer ${dimension} stays fixed`)
          reference = metrics
        }
        if (page === 'tasks' || page === 'projectDetail') {
          if (width > 600) await align()
          if (width === 1440) assert(await browser.evaluate('document.querySelector(".task-table-scroll").scrollWidth<=document.querySelector(".task-table-scroll").clientWidth+1'), 'All desktop columns including Kebab fit')
          assert.equal(await browser.evaluate(`!!document.querySelector(${JSON.stringify(row + ' .task-table-project')})`), page === 'tasks')
          assert.equal(await browser.evaluate('!!document.querySelector(".task-filter-buttons [data-filter=project]")'), page === 'tasks')
          const chips = await browser.evaluate(`(()=>{const chips=[...document.querySelectorAll(${JSON.stringify(row + ' .tag-chips > span')})];return chips.map(e=>({top:e.getBoundingClientRect().y+e.getBoundingClientRect().height/2,text:e.textContent}));})()`)
          assert(chips.length); assert(chips.every(chip => chip.top === chips[0].top)); assert(chips.at(-1).text.match(/^\+\d+件$/))
        }
        await shot(width, page)
      })
    }
  }

  await resize(1440)
  await t.test('Ellipsized task names, readable semantic Priority and visible 40px edit Trigger preserve editing', async () => {
    await go('tasks')
    const style = await browser.evaluate(`(()=>{const row=document.querySelector(${JSON.stringify(row)}),name=row.querySelector('.task-table-name button'),menu=row.querySelector('summary');return {clamp:getComputedStyle(name).webkitLineClamp,nowrap:getComputedStyle(name).whiteSpace,height:name.getBoundingClientRect().height,title:name.title,menu:menu.getBoundingClientRect().width,menuOpacity:getComputedStyle(menu).opacity,priorities:[...document.querySelectorAll('.task-priority-pill')].map(e=>({text:e.textContent,color:getComputedStyle(e.querySelector('.shared-pill')??e).color,background:getComputedStyle(e.querySelector('.shared-pill')??e).backgroundColor})),overdue:getComputedStyle(row.querySelector('.task-period-relative.overdue')).color};})()`)
    assert.equal(style.clamp, '2'); assert.equal(style.nowrap, 'nowrap'); assert.equal(style.height, 40); assert.equal(style.title, title)
    assert.equal(style.menu, 40); assert.equal(style.menuOpacity, '1')
    assert.deepEqual(new Set(style.priorities.map(p => p.text)), new Set(['高', '中', '低', '']))
    assert.equal(new Set(style.priorities.map(p => p.color)).size, 4)
    assert.equal(new Set(style.priorities.map(p => p.background)).size, 4)
    await browser.click(row + ' .task-table-name button')
    assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(row + ' .task-title-input input')}).value`), title)
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await browser.until(`document.querySelector(${JSON.stringify(row + ' .task-table-name button')})`, 'Title cancelled')
  })

  await t.test('Saved Project and NULL default colors agree across sidebar, cards, detail, picker and editor', async () => {
    await go('tasks')
    await colors(row + ' .project-picker-trigger svg', '#568BC7')
    await colors(row + ' .project-picker-trigger svg[data-icon=folder]', '#568BC7')
    await browser.click(row + ' .project-picker-trigger')
    assert(await browser.evaluate('document.querySelectorAll(".project-picker-popup [data-project-id] svg").length>0'))
    assert.equal(await browser.evaluate(`document.querySelector('.project-picker-popup [data-project-id=""]').textContent`),'未所属')
    await browser.evaluate(`document.querySelector('.project-picker-popup [data-project-id="${project.id}"]').click()`)
    await browser.until('!document.querySelector(".project-picker-popup")', 'Project selection completed')
    await browser.click(row + ' summary'); await browser.click(row + ' .task-row-edit')
    await browser.until('document.querySelector(".task-editor-panel[open]")', 'Task editor opened')
    await colors('.task-editor-panel .project-picker-trigger svg[data-icon=folder]', '#568BC7')
    await browser.click('.task-editor-panel .icon-close')
    await go('projects'); await colors(`.project-card[data-project-id="${project.id}"] .project-card-heading svg`, '#568BC7')
    await go('projectDetail'); await colors('.project-page-heading h1 svg', '#568BC7')
    assert.equal(await browser.evaluate(`document.querySelectorAll('.sidebar-subnav button').length`), 2)
  })

  await t.test('Tag colors apply to inline chips, Editor, selection, filters and applied chips', async () => {
    await go('tasks')
    await browser.click(row + ' .tag-picker-trigger')
    assert.equal(await browser.evaluate(`document.querySelector('.tag-picker-options [data-tag-id="${tags[0].id}"]').dataset.tagColor`), '#CB729A')
    assert.equal(await browser.evaluate(`document.querySelector('.tag-picker-options [data-tag-id="${tags[2].id}"]').dataset.tagColor`), getTagColor(tags[2]))
    await browser.evaluate('document.querySelector(".tag-picker-trigger[aria-expanded=true]").click()')
    await browser.click('.task-filter-buttons [data-filter=tag] > button')
    await browser.evaluate(`document.querySelector('.task-filter-popover [data-tag-id="${tags[0].id}"]').closest('label').querySelector('input').click()`)
    const chip = await browser.evaluate('(()=>{const e=document.querySelector(".task-filter-chip");return {text:e.textContent,background:getComputedStyle(e).backgroundColor,color:getComputedStyle(e).color};})()')
    assert(chip.text.includes('FE')); assert.notEqual(chip.background, 'rgba(0, 0, 0, 0)'); assert.notEqual(chip.background, chip.color)
    await browser.click('.task-clear-all')
  })

  await t.test('Calendar Schedule detail also uses the saved Project color', async () => {
    const date = await browser.evaluate('(()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`})()')
    const block = await api('/schedule-blocks', { taskId: task.id, date, type: 'TIMED', startTime: '09:00', durationMinutes: 90 })
    await browser.navigate(); await browser.until('document.querySelector(".workspace-sidebar")', 'Reloaded schedule')
    await go('home'); await browser.until(`document.querySelector('[data-schedule-block-id="${block.id}"]')`, 'Schedule loaded')
    await browser.click(`[data-schedule-block-id="${block.id}"]`)
    await browser.until('document.querySelector(".calendar-popover-project")', 'Schedule detail opened')
    await colors('.calendar-popover-project .project-picker-trigger svg[data-icon=folder]', '#568BC7')
    assert.deepEqual(await browser.evaluate(`[...document.querySelectorAll('.calendar-popover-tags .tag-chip')].map(e=>e.textContent).sort()`), tags.map(tag=>tag.name).sort())
    await browser.click('[aria-label="予定の操作を閉じる"]')
    await browser.send('Emulation.setDeviceMetricsOverride', { width:1920, height:1080, deviceScaleFactor:1, mobile:false })
    await browser.evaluate('window.scrollTo(0,0)')
    await selectTimerTask(browser, task.id)
    const navColors = async () => {
      const read = selector => browser.evaluate(`(()=>{const e=document.querySelector('${selector}');return [e,e.querySelector('svg'),e.querySelector('.nav-rail-label')].map(n=>getComputedStyle(n).color)})()`)
      assert.equal(new Set(await read('.icon-rail button.active')).size, 1)
      assert(await browser.evaluate(`(()=>{const button=document.querySelector('.icon-rail button.active'),r=button.getBoundingClientRect(),label=button.querySelector('.nav-rail-label').getBoundingClientRect();return r.height===56&&r.width===56&&label.top>=r.top&&label.bottom<=r.bottom})()`))
      const point = await browser.evaluate(`(()=>{const r=document.querySelector('.icon-rail [aria-label="タスク"]').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
      await browser.send('Input.dispatchMouseEvent', { type:'mouseMoved', ...point })
      assert.equal(new Set(await read('.icon-rail [aria-label="タスク"]')).size, 1)
      await browser.send('Input.dispatchMouseEvent', { type:'mouseMoved', x:1800, y:1000 })
    }
    await navColors()
    const gap = await browser.evaluate(`(()=>{const [week,range]=document.querySelector('.calendar-period-label').children;return range.getBoundingClientRect().left-week.getBoundingClientRect().right})()`)
    assert.equal(gap, 16)
    await browser.evaluate(`document.querySelector('[data-schedule-block-id="${block.id}"]').scrollIntoView({block:'center'})`)
    const tagPoint = await browser.evaluate(`(()=>{const r=document.querySelector('[data-schedule-block-id="${block.id}"] .schedule-block-tag-icon').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    await browser.send('Input.dispatchMouseEvent', { type:'mouseMoved', ...tagPoint })
    await browser.send('Input.dispatchMouseEvent', { type:'mousePressed', button:'left', clickCount:1, ...tagPoint })
    await browser.send('Input.dispatchMouseEvent', { type:'mouseReleased', button:'left', clickCount:1, ...tagPoint })
    await browser.until('document.querySelector(".calendar-popover-tags")', 'Tag indicator uses the existing Block details')
    assert(await browser.evaluate(`document.querySelector('.calendar-popover').contains(document.elementFromPoint(...(()=>{const r=document.querySelector('.calendar-popover').getBoundingClientRect();return[r.x+16,r.y+16]})()))`))
    await browser.click('[aria-label="予定の操作を閉じる"]')
    const inspect = () => browser.evaluate(`(()=>{const e=document.querySelector('[data-schedule-block-id="${block.id}"]'),p=e.querySelector('.calendar-block-project');return{tags:e.querySelectorAll('.schedule-block-tag-icon').length,icons:e.querySelectorAll('[data-icon=folder]').length,project:getComputedStyle(p).color,background:getComputedStyle(e).backgroundColor,text:getComputedStyle(e).color,today:['.calendar-week-header>.today','.calendar-week-metrics>.today','.calendar-schedule-cell.today','.calendar-day-column.today'].map(s=>getComputedStyle(document.querySelector(s)).backgroundColor)}})()`)
    const light=await inspect();assert.equal(light.tags,1);assert.equal(light.icons,1);assert.equal(await browser.evaluate(`document.querySelector('[data-schedule-block-id="${block.id}"] [data-icon=folder]').dataset.projectColor`),'#568BC7');assert.notEqual(light.project,light.text);assert.equal(new Set(light.today).size,1)
    await shot(1920,'home-light')
    await browser.evaluate('document.documentElement.dataset.theme="dark"')
    await navColors()
    const dark=await inspect();assert.notEqual(dark.background,light.background);assert.equal(dark.project,light.project,'Project identity retains its saved base color in both themes');assert.equal(new Set(dark.today).size,1)
    await shot(1920,'home-dark')
    await browser.evaluate('delete document.documentElement.dataset.theme')
    await resize(1440)
  })

  const settings = async () => { await go('projectDetail'); await browser.evaluate(`Array.from(document.querySelectorAll('.project-tabs button')).find(e=>e.textContent==='設定').click()`) }
  const save = async () => { await browser.click('.project-settings button[type=submit]'); await browser.until('document.querySelector(".project-settings [role=status]") && !document.querySelector(".project-settings button[type=submit]").disabled', 'Settings saved') }
  await t.test('Changing Project color persists on reload and updates every shared Project icon', async () => {
    await settings(); await browser.click('.project-settings [data-color="#A079BE"]'); await save()
    await browser.navigate(); await browser.until('document.querySelector(".workspace-sidebar")', 'Reloaded')
    await go('tasks'); await colors(row + ' .project-picker-trigger svg', '#A079BE')
    await go('tasks'); await colors(row + ' .project-picker-trigger svg[data-icon=folder]', '#A079BE')
    await go('projects'); await colors(`.project-card[data-project-id="${project.id}"] .project-card-heading svg`, '#A079BE')
    await go('projectDetail'); await colors('.project-page-heading h1 svg', '#A079BE')
  })
  await t.test('Changing Tag color persists on reload and reset returns its stable default everywhere', async () => {
    await go('tasks'); await browser.click(row + ' .tag-picker-trigger'); await browser.click('.tag-picker-manage')
    const editTag = async () => { await browser.evaluate(`Array.from(document.querySelectorAll('.tag-management-row button')).find(e=>e.getAttribute('aria-label')===${JSON.stringify(tags[0].name + 'の名前を変更')}).click()`) }
    const saveTag = async () => { await browser.click('.tag-management-actions .primary-action'); await browser.until('!document.querySelector(".tag-management-edit") && !document.querySelector(".tag-picker-manage")', 'Tag management save completed') }
    await editTag(); await browser.click('.tag-management-edit [data-color="#717AC5"]'); await saveTag()
    await browser.navigate(); await browser.until('document.querySelector(".workspace-sidebar")', 'Reloaded')
    await go('tasks'); await browser.click(row + ' .tag-picker-trigger')
    assert.equal(await browser.evaluate(`document.querySelector('.tag-picker-options [data-tag-id="${tags[0].id}"]').dataset.tagColor`), '#717AC5')
    await browser.click('.tag-picker-manage'); await editTag(); await browser.click('.tag-management-edit .color-reset'); await saveTag()
    await browser.navigate(); await browser.until('document.querySelector(".workspace-sidebar")', 'Reloaded')
    await go('tasks'); await browser.click(row + ' .tag-picker-trigger')
    assert.equal(await browser.evaluate(`document.querySelector('.tag-picker-options [data-tag-id="${tags[0].id}"]').dataset.tagColor`), getTagColor({ ...tags[0], color: null }))
    assert.equal((await api('/tags')).find(tag => tag.id === tags[0].id).color, null)
  })
  await t.test('Project reset persists NULL and the same stable default across pages', async () => {
    await settings(); await browser.click('.project-settings .color-reset'); await save()
    assert.equal((await api('/projects')).find(p => p.id === project.id).color, null)
    await browser.navigate(); await browser.until('document.querySelector(".workspace-sidebar")', 'Reloaded')
    const expected = getProjectColor({ ...project, color: null })
    await go('tasks'); await colors(row + ' .project-picker-trigger svg', expected)
    await go('tasks'); await colors(row + ' .project-picker-trigger svg[data-icon=folder]', expected)
    await go('projects'); await colors(`.project-card[data-project-id="${project.id}"] .project-card-heading svg`, expected)
    await go('projectDetail'); await colors('.project-page-heading h1 svg', expected)
  })
  assert.deepEqual(errors, [])
})
