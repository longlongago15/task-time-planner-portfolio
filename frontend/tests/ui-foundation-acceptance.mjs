import { assertTaskTable } from './current-task-ui.mjs'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { openBrowser } from './browser.mjs'
import { startMetadataBackend } from './metadata-backend.mjs'

export async function uiFoundationAcceptance(t, output) {
  const { base, api } = await startMetadataBackend(t)
  assert.notEqual(new URL(base).port, '8000')
  const projects = [], tasks = [], blocks = [], requests = [], errors = [], checks = [], measurements = {}
  for (const [index, color] of ['#3B82F6','#E53935','#008A42','#A079BE'].entries()) {
    const project = await api('/projects', { name: `配色確認${index + 1}・長いプロジェクト名`, color }); projects.push(project)
    tasks.push(await api('/tasks', { title: `配色と日付入力の確認${index + 1}`, projectId: project.id, priority: ['HIGH','MEDIUM','LOW',null][index], deadline: '2026-10-08' }))
  }
  const browser = await openBrowser(); t.after(() => browser.close())
  await browser.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' })
  browser.listeners.push(message => {
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method !== 'Fetch.requestPaused') return
    const { request, requestId } = message.params
    void (async () => {
      if (request.method === 'OPTIONS') return browser.fulfill(requestId, {})
      const url = new URL(request.url), effective = base + url.pathname + url.search
      assert.notEqual(new URL(effective).port, '8000')
      requests.push({ source: request.url, effective, method: request.method, payload: request.postData ? JSON.parse(request.postData) : null })
      const response = await fetch(effective, { method: request.method, ...(request.postData ? { headers: { 'Content-Type': 'application/json' }, body: request.postData } : {}) })
      await browser.fulfill(requestId, await response.json(), response.status)
    })().catch(error => { if (!/Invalid [Ii]nterceptionId|Invalid requestId/.test(error.message)) errors.push(String(error)) })
  })
  await browser.send('Fetch.enable', { patterns: [{ urlPattern: 'http://localhost:8000/*', requestStage: 'Request' }, { urlPattern: 'http://127.0.0.1:8000/*', requestStage: 'Request' }] })
  const check = async (name, action) => { let failure; await t.test(name, async () => { try { await action() } catch (error) { failure = error; throw error } }); if (failure) throw failure; checks.push(name) }
  const size = async width => { await browser.send('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: false }); await browser.until(`document.querySelector('.app-layout')?.dataset.device===${JSON.stringify(width > 980 ? 'desktop' : width > 680 ? 'tablet' : 'mobile')}`, 'Device ready') }
  const input = async (selector, value) => browser.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`)
  const enter = async () => { await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }); await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }) }
  const go = async page => {
    await browser.until('document.querySelector(".mobile-nav")', 'Workspace mounted')
    const index = { home: 1, tasks: 2, projects: 3, reports: 4 }[page]
    await browser.click(`.mobile-nav button:nth-child(${index})`)
    await browser.until(`document.querySelector('.app-layout')?.dataset.page===${JSON.stringify(page)}`, 'Page ' + page)
    if (page === 'tasks') await browser.until(`document.querySelector('.task-table-row[data-task-id="${tasks[0].id}"]')`, 'Task ready')
    if (page === 'projects') await browser.until(`document.querySelector('.project-card[data-project-id="${projects[0].id}"]')`, 'Project ready')
  }
  const shot = async name => { if (!output) return; await mkdir(output, { recursive: true }); const result = await browser.send('Page.captureScreenshot', { format: 'png', fromSurface: true }); await writeFile(new URL(name + '.png', output), Buffer.from(result.data, 'base64')) }
  await browser.navigate(); await size(1440)
  const today = await browser.evaluate('(()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`})()')
  for (const task of tasks) blocks.push(await api('/schedule-blocks', { taskId: task.id, date: today, type: 'TIMED', startTime: '09:00', durationMinutes: 480 }))
  await browser.navigate(true); await browser.until('document.querySelector(".workspace-sidebar")', 'Workspace')

  await check('Simplified Sidebar has Home, Projects and Home Inbox without Project enumeration or duplicate Task route', async () => {
    assert.deepEqual(await browser.evaluate('[...document.querySelectorAll(".sidebar-subnav button")].map(e=>e.textContent.trim())'), ['ホーム画面','プロジェクト一覧'])
    assert.equal(await browser.evaluate('document.querySelector(".sidebar-project-list,.home-projects-panel")'), null)
    assert(await browser.evaluate('!!document.querySelector(".unplanned-panel")'))
    await go('tasks'); assert.equal(await browser.evaluate('document.querySelector(".unplanned-panel")'), null)
  })
  await check('Neutral Light semantic tokens and stable system typography replace cream surfaces', async () => {
    const values = await browser.evaluate(`(()=>{const root=getComputedStyle(document.documentElement),page=getComputedStyle(document.querySelector('.app-main')),title=getComputedStyle(document.querySelector('.task-list-heading h1'));return{page:root.getPropertyValue('--color-bg').trim(),surface:root.getPropertyValue('--color-surface').trim(),muted:root.getPropertyValue('--color-surface-muted').trim(),border:root.getPropertyValue('--color-border').trim(),text:root.getPropertyValue('--color-text').trim(),font:root.fontFamily,body:root.fontSize,title:title.fontSize,titleWeight:title.fontWeight,section:root.getPropertyValue('--font-section').trim(),header:root.getPropertyValue('--font-table-header').trim(),line:root.getPropertyValue('--line-height-table').trim()}})()`)
    assert.deepEqual([values.page,values.surface,values.muted,values.border,values.text], ['#F8FAFC','#FFFFFF','#F1F5F9','#E2E8F0','#0F172A'])
    assert.match(values.font, /Segoe UI/); assert.match(values.font, /Yu Gothic/)
    assert.equal(values.body, '14px'); assert.equal(values.title,'24px'); assert.equal(values.titleWeight,'700'); assert.equal(values.section,'18px'); assert.equal(values.header,'13px'); assert.equal(values.line,'1.4')
    measurements.typography = values
  })
  await check('Count stays in the Page Header; the full-width Table and separate edit/Timer columns align at 1920px', async () => {
    await size(1920)
    await browser.until('document.querySelector(".app-layout").getAnimations().every(a=>a.playState!=="running")', 'Shell resize transition finished')
    const value = await browser.evaluate(`(()=>{const panel=document.querySelector('.task-list-v43'),count=document.querySelector('.task-counts'),header=document.querySelector('.task-table-header'),row=document.querySelector('.task-table-row'),rect=e=>e.getBoundingClientRect(),p=rect(panel),c=rect(count),h=rect(header),r=rect(row),menu=rect(row.querySelector('summary')),hc=rect(header.children[8]);return{available:(()=>{const m=document.querySelector('.app-main'),s=getComputedStyle(m);return m.clientWidth-parseFloat(s.paddingLeft)-parseFloat(s.paddingRight)})(),width:p.width,padding:getComputedStyle(panel).paddingLeft,countInside:c.left>=document.querySelector('.app-main').getBoundingClientRect().left&&c.bottom<h.top,columns:[...header.children].map(e=>rect(e).width),aligned:[...header.children].every((e,i)=>Math.abs(rect(e).x-rect(row.children[i]).x)<.1&&Math.abs(rect(e).width-rect(row.children[i]).width)<.1),menuWidth:menu.width,menuInside:menu.right<=r.right&&menu.left>=r.left,menuCenter:Math.abs(menu.x-hc.x-8)<.1,overflow:document.documentElement.scrollWidth>innerWidth}})()`)
    assert(value.countInside && value.aligned && value.menuInside && value.menuCenter); assert.equal(value.menuWidth,40); assert.equal(value.padding,'16px'); assert(Math.abs(value.width-value.available)<.5, 'Table Card fills the Main content width, accounting for the reserved scrollbar gutter'); assert.equal(value.overflow,false)
    await assertTaskTable(browser); assert.equal(value.columns[2],144); assert.equal(value.columns[3],192);
    assert.deepEqual(value.columns.slice(-6),[88,168,88,88,56,56]); measurements.table=value
    await shot('1920-bounded-table'); await size(1440)
  })
  const row = id => `.task-table-row[data-task-id="${id}"]`
  await check('Project cell has no Chevron or select border, opens its existing Picker and uses the filled base-color Folder', async () => {
    const scope=row(tasks[0].id)
    const value=await browser.evaluate(`(()=>{const b=document.querySelector('${scope} .project-picker-trigger'),s=b.querySelector('svg'),c=getComputedStyle(b),i=getComputedStyle(s);return{chevron:!!b.querySelector('[data-icon=chevronDown]'),color:s.dataset.projectColor,fill:i.fill,stroke:i.strokeWidth,border:c.borderTopWidth,borderStyle:c.borderTopStyle,title:b.title}})()`)
    assert.equal(value.chevron,false); assert.equal(value.color,projects[0].color); assert.equal(value.fill,'rgb(59, 130, 246)'); assert.equal(value.stroke,'0px'); assert.equal(value.border,'0px'); assert.equal(value.borderStyle,'none')
    await browser.click(scope+' .project-picker-trigger'); await browser.until('document.querySelector(".project-picker-popup")', 'Project Picker')
    assert(await browser.evaluate('document.querySelectorAll(".project-picker-popup [data-project-id] svg").length>0'))
    await browser.click(`.project-picker-popup [data-project-id="${projects[0].id}"]`); await browser.until('!document.querySelector(".project-picker-popup")', 'Project chosen')
    assert.equal((await api(`/tasks/${tasks[0].id}`)).projectId,projects[0].id)
  })
  await check('Priority has no Chevron; unset is an accessible blank hit target and colored options still save and clear', async () => {
    const scope=row(tasks[3].id)
    assert.equal(await browser.evaluate(`document.querySelector('${scope} .task-priority-pill').textContent`),'')
    assert.equal(await browser.evaluate(`document.querySelector('${scope} .task-priority-pill svg')`),null)
    await browser.click(scope+' .task-priority-pill'); await browser.until('document.querySelector(".priority-popup")','Priority menu')
    const colors=await browser.evaluate('[...document.querySelectorAll(".priority-option-label")].map(e=>getComputedStyle(e).backgroundColor)'); assert.equal(new Set(colors).size,4)
    await browser.click('.priority-popup [data-priority=HIGH]'); await browser.until(`document.querySelector('${scope} .task-priority-pill').textContent==='高'`,'Priority saved')
    assert.equal((await api(`/tasks/${tasks[3].id}`)).priority,'HIGH')
    await browser.click(scope+' .task-priority-pill'); await browser.click('.priority-popup [data-priority=""]'); await browser.until(`document.querySelector('${scope} .task-priority-pill').textContent===''`,'Priority cleared')
    assert.equal((await api(`/tasks/${tasks[3].id}`)).priority,null)
  })
  const openDeadline=async()=>{await go('projects');await browser.click('.project-card[data-project-id="'+projects[0].id+'"] .project-card-open');await browser.until(`document.querySelector('${row(tasks[0].id)} .task-table-deadline > button')`,'Project Task deadline');await browser.click(row(tasks[0].id)+' .task-table-deadline > button');await browser.until('document.querySelector(".task-deadline-editor input")','Deadline editor')}
  for (const text of ['20261008','2026/10/8','2026-10-08']) await check(`Deadline ${text} normalizes to ISO and persists`, async()=>{
    await openDeadline();await input('.task-deadline-editor input',text);await enter();await browser.until('!document.querySelector(".task-deadline-editor")','Saved deadline')
    assert.equal((await api(`/tasks/${tasks[0].id}`)).deadline,'2026-10-08')
  })
  await check('Deadline partial year and day remain unpadded; separated year cannot grow past four digits',async()=>{
    await openDeadline()
    for(const value of ['2','20','202','2026','2026/10/1']){await input('.task-deadline-editor input',value);assert.equal(await browser.evaluate('document.querySelector(".task-deadline-editor input").value'),value)}
    await browser.send('Input.insertText',{text:'0'});assert.equal(await browser.evaluate('document.querySelector(".task-deadline-editor input").value'),'2026/10/10')
    await input('.task-deadline-editor input','2026/10/1');await input('.task-deadline-editor input','20261/10/1');assert.equal(await browser.evaluate('document.querySelector(".task-deadline-editor input").value'),'2026/10/1')
    await input('.task-deadline-editor input','20261008');await enter();await browser.until('!document.querySelector(".task-deadline-editor")','Saved')
  })
  for(const text of ['20261','00801008','20261301','20260230'])await check(`Deadline rejects ${text} and Calendar stays in today's month`,async()=>{
    await openDeadline();const writes=requests.filter(r=>r.method==='PUT').length;await input('.task-deadline-editor input',text);await enter()
    assert(await browser.evaluate('document.querySelector(".task-deadline-editor input").getAttribute("aria-invalid")==="true"'))
    await browser.click('.task-deadline-editor .deadline-calendar-trigger')
    assert.equal(await browser.evaluate('document.querySelector(".deadline-calendar-heading strong").textContent'),await browser.evaluate('`${new Date().getFullYear()}年${new Date().getMonth()+1}月`'))
    assert.equal(requests.filter(r=>r.method==='PUT').length,writes)
    await input('.task-deadline-editor input','20261008');await enter();await browser.until('!document.querySelector(".task-deadline-editor")','Editor closed')
  })
  const openSchedule=async()=>{
    await go('home');await browser.until(`document.querySelector('[data-schedule-block-id="${blocks[0].id}"]')`,'Schedule Block')
    await browser.click(`[data-schedule-block-id="${blocks[0].id}"]`);await browser.until('document.querySelector(".calendar-popover")','Schedule detail')
    await browser.click('.calendar-popover [data-schedule-field=date]')
    await browser.until('document.querySelector(".calendar-detail-form [name=date]")','Schedule Date Input')
  }
  for(const text of ['20261008','2026/10/8','2026-10-08'])await check(`Schedule date ${text} uses the shared input and saves ISO`,async()=>{
    await api(`/schedule-blocks/${blocks[0].id}`,{date:today},'PATCH');await browser.navigate(true);await openSchedule()
    await input('.calendar-dialog [name=date]',text);await browser.click('.calendar-detail-form button[type=submit]');await browser.until('!document.querySelector(".calendar-detail-form [name=date]")','Schedule inline edit saved')
    assert.equal((await api(`/schedule-blocks?taskId=${tasks[0].id}`))[0].date,'2026-10-08')
  })
  for(const text of ['20261','00801008','20261301','20260230'])await check(`Schedule date rejects ${text} without sending a PATCH`,async()=>{
    await api(`/schedule-blocks/${blocks[0].id}`,{date:today},'PATCH');await browser.navigate(true);await openSchedule();const writes=requests.filter(r=>r.method==='PATCH').length
    await input('.calendar-dialog [name=date]',text);await browser.click('.calendar-detail-form button[type=submit]')
    assert(await browser.evaluate('!!document.querySelector(".calendar-dialog [role=alert]")'));assert.equal(requests.filter(r=>r.method==='PATCH').length,writes)
    await browser.click('.calendar-dialog [aria-label="予定の操作を閉じる"]')
  })
  await check('Schedule date keeps partial day editable and the picker starts at a valid existing date',async()=>{
    await openSchedule();await input('.calendar-dialog [name=date]','2026/10/1');assert.equal(await browser.evaluate('document.querySelector(".calendar-dialog [name=date]").value'),'2026/10/1')
    await browser.send('Input.insertText',{text:'0'});assert.equal(await browser.evaluate('document.querySelector(".calendar-dialog [name=date]").value'),'2026/10/10')
    await browser.click('.calendar-dialog .deadline-calendar-trigger');assert.equal(await browser.evaluate('document.querySelector(".deadline-calendar-heading strong").textContent'),'2026年10月')
    await shot('1440-schedule-date');await browser.click('.calendar-dialog [aria-label="予定の操作を閉じる"]')
  })
  await api(`/schedule-blocks/${blocks[0].id}`,{date:today},'PATCH');await browser.navigate(true);await go('home')
  await check('Blue Red Green Purple Calendar Blocks retain Project names and colors with shared Project Icons after reload',async()=>{
    await browser.until('document.querySelectorAll(".calendar-event.planned").length===4','Four colored blocks')
    const collect=()=>browser.evaluate(`Array.from(document.querySelectorAll('.calendar-event.planned')).map(e=>{const s=getComputedStyle(e);return{id:Number(e.dataset.scheduleBlockId),bg:s.backgroundColor,text:s.color,accent:e.style.borderLeftColor,folders:e.querySelectorAll('svg[data-icon=folder]').length,project:e.querySelector('.calendar-block-project')?.textContent}})`)
    const before=await collect();assert.equal(new Set(before.map(v=>v.bg)).size,4)
    for(const item of before){const project=projects[tasks.findIndex(task=>task.id===blocks.find(b=>b.id===item.id).taskId)];assert.equal(item.folders,1);assert.equal(item.project,project.name);assert.equal(item.accent,`rgb(${[1,3,5].map(offset=>parseInt(project.color.slice(offset,offset+2),16)).join(', ')})`);assert.equal(item.text,'rgb(15, 23, 42)');assert.notEqual(item.bg,item.accent)}
    await shot('1440-calendar-tints');await browser.navigate(true);await browser.until('document.querySelectorAll(".calendar-event.planned").length===4','Reloaded blocks');assert.deepEqual(await collect(),before);measurements.calendar=before
  })
  await check('Dark tokens and Calendar helper can share user base colors without enabling OS theme or a Toggle',async()=>{
    await browser.evaluate('document.documentElement.dataset.theme="dark"')
    const value=await browser.evaluate('(()=>{const s=getComputedStyle(document.documentElement),e=document.querySelector(".calendar-event.planned"),b=getComputedStyle(e);return{bg:s.getPropertyValue("--color-bg").trim(),surface:s.getPropertyValue("--color-surface").trim(),text:b.color,folders:e.querySelectorAll("svg[data-icon=folder]").length,project:e.querySelector(".calendar-block-project")?.textContent}})()')
    assert.equal(value.bg,'#0F172A');assert.equal(value.surface,'#111827');assert.equal(value.text,'rgb(248, 250, 252)');assert.equal(value.folders,1);assert(projects.some(p=>p.name===value.project))
    await browser.evaluate('delete document.documentElement.dataset.theme');measurements.darkFoundation=value
  })
  for(const width of [768,375])await check(`${width}px Calendar / shared Date Dialog fit the viewport; Mobile has no desktop Toggle`,async()=>{
    await size(width);await openSchedule()
    const value=await browser.evaluate('(()=>{const d=document.querySelector(".calendar-dialog").getBoundingClientRect(),i=document.querySelector(".calendar-dialog [name=date]").getBoundingClientRect();return{left:d.left,right:d.right,inputRight:i.right,overflow:document.documentElement.scrollWidth>innerWidth,controls:document.querySelectorAll("[data-sidebar-toggle]").length}})()')
    assert(value.left>=0&&value.right<=width&&value.inputRight<=width);assert.equal(value.overflow,false);if(width===375)assert.equal(value.controls,0)
    await shot(`${width}-date-dialog`);await browser.click('.calendar-dialog [aria-label="予定の操作を閉じる"]');await shot(`${width}-home`)
  })
  assert.deepEqual(errors,[])
  return { base, checks, measurements, requests, errors, normalBackendWrites: 0 }
}
