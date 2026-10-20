import { openReport, selectReportAnchor } from './report-picker.mjs'
import { isolateScenarios } from './scenario-fixture.mjs'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { openBrowser } from './browser.mjs'
import { startMetadataBackend } from './metadata-backend.mjs'

export async function projectRecordsAcceptance(t, output) {
  const { base, api, directory, python } = await startMetadataBackend(t)
  assert.notEqual(new URL(base).port, '8000')
  const a = await api('/projects', { name: 'Project A', color: '#001AFF' })
  const b = await api('/projects', { name: 'Project B' })
  const task = await api('/tasks', { title: 'API学習', projectId: a.id, estimatedMinutes: 60 })
  const original = await api('/time-entries', { taskId: task.id, startedAt: '2026-10-06T04:00:00Z', endedAt: '2026-10-06T04:30:00Z' })
  const browser = await openBrowser(); t.after(() => browser.close())
  await browser.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' })
  const requests = [], errors = [], checks = []
  let failWrite = false, holdWrite = false, releaseWrite
  browser.listeners.push(message => {
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method !== 'Fetch.requestPaused') return
    const { requestId, request } = message.params
    void (async () => {
      const source = new URL(request.url)
      assert.equal(source.port, '8000')
      if (request.method === 'OPTIONS') return browser.fulfill(requestId, {})
      const effective = base + source.pathname + source.search
      assert.notEqual(new URL(effective).port, '8000')
      const record = { method: request.method, path: source.pathname, effective, payload: request.postData ? JSON.parse(request.postData) : null }
      requests.push(record)
      if (source.pathname.startsWith('/time-entries/') && request.method !== 'GET') {
        if (failWrite) { record.status = 500; return browser.fulfill(requestId, { detail: '記録の更新に失敗しました' }, 500) }
        if (holdWrite) { await browser.evaluate('window.__recordHeld=true'); await new Promise(resolve => { releaseWrite = resolve }) }
      }
      const response = await fetch(effective, { method: request.method, ...(request.postData ? { headers: { 'Content-Type': 'application/json' }, body: request.postData } : {}) })
      record.status = response.status
      await browser.fulfill(requestId, await response.json(), response.status)
    })().catch(error => { if (!/Invalid [Ii]nterceptionId|Invalid requestId/.test(error.message)) errors.push(String(error)) })
  })
  await browser.send('Fetch.enable', { patterns: [{ urlPattern: 'http://localhost:8000/*', requestStage: 'Request' }, { urlPattern: 'http://127.0.0.1:8000/*', requestStage: 'Request' }] })
  const row = id => `.project-records [data-entry-id="${id}"]`
  const writes = () => requests.filter(record => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(record.method))
  const history = () => api(`/tasks/${task.id}/time-entries`)
  const input = async (name, value) => {
    const selector = name.endsWith('Time') ? `[aria-label="${name === 'startTime' ? '開始時刻' : '終了時刻'}"]` : `[name="${name}"]`
    await browser.evaluate(`(()=>{const e=document.querySelector('${row(editingId)} .entry-inline-dates ${selector}');e.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`)
  }
  const key = async (key, code = key, virtual = key === 'Escape' ? 27 : 13) => { await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: virtual, ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) }); await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtual }) }
  const shot = async name => {
    if (!output) return
    await mkdir(output, { recursive: true })
    const result = await browser.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    await writeFile(new URL(name + '.png', output), Buffer.from(result.data, 'base64'))
  }
  const check = (name, action) => t.test(name, async () => { await action(); checks.push(name) })
  const recordsReady = () => browser.until('document.querySelector(".project-records") && document.querySelector(".project-records .empty-state")?.textContent!=="\u6642\u9593\u8a18\u9332\u3092\u8aad\u307f\u8fbc\u3093\u3067\u3044\u307e\u3059" && !document.querySelector(".project-records [role=status]")', 'Records ready')
  const recordsTab = async () => { await browser.click('.project-tabs button:nth-child(2)'); await recordsReady() }
  const project = async (id = a.id) => {
    await browser.click('.icon-rail [aria-label="プロジェクト"]')
    await browser.until(`document.querySelector('.project-card[data-project-id="${id}"]')`, 'Project list')
    await browser.click(`.project-card[data-project-id="${id}"] .project-card-open`)
    await browser.until(`document.querySelector('.project-detail-panel[data-project-id="${id}"]')`, 'Project detail')
    await recordsTab()
  }
  let editingId = original.id
  const menu = async (id = original.id) => { editingId = id; await browser.click(row(id) + ' summary'); await browser.until(`document.querySelector('${row(id)} details[open]')`, 'Record menu') }
  const edit = async (id = original.id) => { editingId = id; await browser.click(row(id) + ' [data-label="計測期間"] button'); await browser.until(`document.querySelector('${row(id)} .entry-inline-dates')`, 'Inline edit') }
  const save = async () => { await key('Enter'); await browser.until(`!document.querySelector('${row(editingId)} .entry-inline-dates')`, 'Saved inline record'); await recordsReady() }
  const consumption = value => browser.until(`document.querySelector('.project-summary .time .project-progress-text')?.textContent.startsWith(${JSON.stringify(value + ' /')})`, 'Project consumption ' + value)
  const taskActual = async value => {
    await browser.click('.project-tabs button:first-child')
    await browser.until(`document.querySelector('.task-table-row[data-task-id="${task.id}"] [data-label="記録"]')?.textContent===${JSON.stringify(value)}`, 'Task recorded ' + value)
    await recordsTab()
  }
  const reports = async value => {
    for (const mode of ['day','week','month']) {
      await openReport(browser,mode)
      await selectReportAnchor(browser,'2026-10-06')
      await browser.until('document.querySelector(".report-summary-actual strong")?.textContent==='+JSON.stringify(value),'Report recorded '+value)
    }
    await project()
  }
  await browser.navigate(); await browser.until('document.querySelector(".icon-rail")', 'Mounted'); await project()


  const writeCount = () => writes().filter(r=>r.path===`/time-entries/${original.id}`).length
  const ended = () => `${row(editingId)} [aria-label="\u7d42\u4e86\u6642\u523b"]`
  const cancel = async () => { await key('Escape'); await browser.until(`!document.querySelector('${row(editingId)} .entry-inline-dates')`, 'Escape discards the inline draft') }
  const confirmDelete = async (id, accept) => {
    await menu(id)
    let timeout, resolveDialog
    const observe=message=>{if(message.method==='Page.javascriptDialogOpening')resolveDialog(message.params)}
    const dialog=new Promise((resolve,reject)=>{resolveDialog=resolve;timeout=setTimeout(()=>reject(new Error('Native delete confirmation did not open')),12000)})
    browser.listeners.push(observe)
    const clicked=browser.click(row(id)+' .entry-menu-options .danger').then(()=>null,error=>error)
    try {
      const details=await dialog
      await browser.send('Page.handleJavaScriptDialog',{accept})
      const error=await clicked
      if(error)throw error
      return details
    } finally {
      clearTimeout(timeout)
      browser.listeners.splice(browser.listeners.indexOf(observe),1)
    }
  }
  await isolateScenarios(t,{browser,directory,python,
    reset:async()=>{failWrite=false;holdWrite=false;releaseWrite?.();releaseWrite=undefined},
    prepare:async name=>{
      if(name.startsWith('Delete '))await api(`/time-entries/${original.id}`,{startedAt:original.startedAt,endedAt:'2026-10-06T04:45:00Z'},'PATCH')
      if(name.startsWith('Cross-day'))await api(`/time-entries/${original.id}`,{},'DELETE')
      if(name.startsWith('Active record')){
        await api(`/tasks/${task.id}`,{projectId:b.id},'PUT')
        await api('/tasks/time/start',{taskId:task.id})
      }
    },
    ready:async name=>{
      await browser.until('document.querySelector(".icon-rail")','Mounted')
      await project(name.startsWith('Active record')?b.id:a.id)
    },
  })

  await check('Closed rows have a keyboard Delete menu; time Cell edits inline without changing Task or Snapshot Project',async()=>{
    assert((await browser.evaluate(`document.querySelector('${row(original.id)}').textContent`)).includes('30\u5206'))
    await consumption('30\u5206')
    const before=writes().length
    await browser.evaluate(`document.querySelector('${row(original.id)} summary').focus()`)
    await key('Enter');await browser.until(`document.querySelector('${row(original.id)} details[open]')`,'Keyboard menu')
    assert.deepEqual(await browser.evaluate(`Array.from(document.querySelectorAll('${row(original.id)} .entry-menu-options button')).map(e=>e.textContent)`),['\u524a\u9664'])
    await key('Enter');await browser.until(`!document.querySelector('${row(original.id)} details[open]')`,'Keyboard closes native menu')
    await edit()
    assert.equal(await browser.evaluate(`document.querySelector('${row(original.id)} .entry-task-value').textContent`),task.title)
    assert.equal(await browser.evaluate(`document.querySelectorAll('${row(original.id)} select,${row(original.id)} .project-picker').length`),0)
    await cancel();assert.equal(writes().length,before);assert.deepEqual(await history(),[original])
  })
  await check('Invalid, empty, equal and reversed inputs show errors and send no mutation',async()=>{
    const before=writeCount()
    for(const fields of [{endTime:'13:00'},{endTime:'12:59'},{startDate:'2026/02/30'},{startDate:''},{endTime:'24:00'}]){
      await edit()
      for(const [name,value] of Object.entries(fields))await input(name,value)
      await key('Enter');await browser.until(`document.querySelector('${row(original.id)} [role=alert]')`,'Invalid error')
      assert.equal(writeCount(),before);assert.deepEqual(await history(),[original]);await cancel()
    }
  })
  await check('Unsaved 45-minute draft sends no PATCH or aggregate change; saved values update and survive reload',async()=>{
    const before=writeCount(),savedDuration=await browser.evaluate(`document.querySelector('${row(original.id)} .entry-log-duration').textContent`)
    await edit();await input('endTime','13:45')
    assert.equal(await browser.evaluate(`document.querySelector('${ended()}').value`),'13:45')
    assert.equal(writeCount(),before);assert.deepEqual(await history(),[original])
    assert.equal(await browser.evaluate(`document.querySelector('${row(original.id)} .entry-log-duration').textContent`),savedDuration)
    await consumption('30\u5206');assert.equal((await api('/projects')).find(p=>p.id===a.id).actualMinutes,30)
    await cancel();assert.equal(writeCount(),before);assert.deepEqual(await history(),[original])
    await edit();await input('endTime','13:45');await save()
    assert.equal(writeCount(),before+1)
    assert.deepEqual(writes().at(-1).payload,{startedAt:original.startedAt,endedAt:'2026-10-06T04:45:00.000Z'})
    assert.equal((await history())[0].durationMinutes,45);await consumption('45\u5206')
    await browser.until(`document.querySelector('${row(original.id)} .entry-log-duration').textContent==='45\u5206'`,'Saved duration updated')
    await browser.navigate(true);await browser.until('document.querySelector(".icon-rail")','Reload');await project()
    assert.equal((await history())[0].durationMinutes,45);await consumption('45\u5206')
    assert.equal(await browser.evaluate(`document.querySelector('${row(original.id)} .entry-log-duration').textContent`),'45\u5206')
  })
  await check('Cross-midnight draft stays unsaved; 75-minute saved interval clips across days and survives reload',async()=>{
    const before=writeCount(),savedDuration=await browser.evaluate(`document.querySelector('${row(original.id)} .entry-log-duration').textContent`)
    await edit()
    await input('startDate','2026/10/06');await input('startTime','23:30');await input('endDate','2026/10/07');await input('endTime','00:45')
    assert.equal(writeCount(),before);assert.deepEqual(await history(),[original])
    assert.equal(await browser.evaluate(`document.querySelector('${row(original.id)} .entry-log-duration').textContent`),savedDuration)
    await consumption('30\u5206');await save()
    assert.equal(writeCount(),before+1)
    assert.deepEqual(writes().at(-1).payload,{startedAt:'2026-10-06T14:30:00.000Z',endedAt:'2026-10-06T15:45:00.000Z'})
    const saved=(await history())[0];assert.equal(saved.durationMinutes,75);assert.equal(saved.id,original.id);assert.equal(saved.projectIdSnapshot,a.id)
    for(const [date,minutes] of [['2026-10-06',30],['2026-10-07',45]])assert.equal((await api(`/reports/daily?date=${date}&timezone=Asia/Tokyo`)).dailyActualMinutes,minutes)
    await consumption('1\u6642\u959315\u5206')
    await browser.navigate(true);await browser.until('document.querySelector(".icon-rail")','Reload');await project()
    assert.equal((await history())[0].durationMinutes,75)
    assert((await browser.evaluate(`document.querySelector('${row(original.id)}').textContent`)).includes('(+1\u65e5)'))
    assert.equal(await browser.evaluate(`document.querySelector('${row(original.id)} .entry-log-duration').textContent`),'1\u6642\u959315\u5206')
  })
  await check('Edit failures retain draft; one pending save blocks duplicate requests and refreshes Task/Project/Reports to 45 minutes',async()=>{
    await edit();await input('endTime','13:45');failWrite=true
    await key('Enter');await browser.until(`document.querySelector('${row(original.id)} [role=alert]')?.textContent.includes('\u5931\u6557')`,'Server failure')
    assert.equal(await browser.evaluate(`document.querySelector('${ended()}').value`),'13:45')
    assert.deepEqual(await history(),[original])
    await browser.until(`document.querySelector('${row(original.id)}').getAttribute('aria-busy')!=='true' && !document.querySelector('${ended()}').disabled && document.activeElement===document.querySelector('${ended()}')`,'Failed save restores enabled input Focus before retry')
    failWrite=false;holdWrite=true
    const before=writeCount();await key('Enter');await browser.until('window.__recordHeld','Request held')
    await browser.until(`document.querySelector('${row(original.id)}').getAttribute('aria-busy')==='true'`,'Pending inline save')
    await key('Escape');await key('Enter')
    assert.equal(writeCount(),before+1);assert(await browser.evaluate(`!!document.querySelector('${row(original.id)} .entry-inline-dates')`))
    assert(releaseWrite);holdWrite=false;releaseWrite();await browser.until(`!document.querySelector('${row(original.id)} .entry-inline-dates')`,'Saved inline record');await recordsReady()
    const edited=(await history())[0];assert.equal(edited.durationMinutes,45)
    for(const name of ['id','taskId','projectIdSnapshot','createdAt'])assert.equal(edited[name],original[name])
    const update=writes().at(-1);assert.equal(update.method,'PATCH');assert.equal(update.path,`/time-entries/${original.id}`)
    assert.deepEqual(update.payload,{startedAt:original.startedAt,endedAt:'2026-10-06T04:45:00.000Z'})
    assert.equal(writeCount(),before+1)
    await consumption('45\u5206');await taskActual('45\u5206');await shot('records-45')
    await browser.navigate(true);await browser.until('document.querySelector(".icon-rail")','Reload');await project();await consumption('45\u5206')
    assert((await browser.evaluate(`document.querySelector('${row(original.id)}').textContent`)).includes('45\u5206'))
    // Reports DOM adaptation is Step 5C-2C; keep this original UI assertion.
    await reports('45\u5206')
  })
  await check('Delete confirmation identifies the exact Task, interval and irreversible action',async()=>{
    const before=writes().length,details=await confirmDelete(original.id,false)
    assert.equal(writes().length,before);assert.equal((await history()).length,1)
    // Original safety context remains required; do not accept generic text as equivalent.
    for(const text of [task.title,'2026/10/06','13:00','13:45','45\u5206','\u5143\u306b\u623b\u305b\u307e\u305b\u3093'])assert(details.message.includes(text),`Delete confirmation context: ${text}; actual: ${details.message}`)
  })
  await check('Delete cancel retains record, failure retains data, confirmed deletion refreshes totals and survives reload',async()=>{
    const before=writes().length
    await confirmDelete(original.id,false);assert.equal(writes().length,before);assert.equal((await history()).length,1)
    failWrite=true;await confirmDelete(original.id,true);await browser.until(`document.querySelector('${row(original.id)} [role=alert]')`,'Delete error')
    assert.equal((await history()).length,1);assert.equal(writes().at(-1).status,500)
    failWrite=false;await confirmDelete(original.id,true);await browser.until('document.querySelector(".project-records .empty-state")','Empty records')
    assert.equal(writes().at(-1).method,'DELETE');assert.equal(writes().at(-1).path,`/time-entries/${original.id}`)
    assert.equal(writes().length,before+2);await consumption('0\u5206');await taskActual('0\u5206')
    await browser.navigate(true);await browser.until('document.querySelector(".icon-rail")','Reload');await project();assert.equal((await history()).length,0);await consumption('0\u5206')
    await reports('0\u5206')
  })
  await check('Cross-day edits reorder rows, and moving the Task keeps history in Snapshot Project A',async()=>{
    const old=await api('/time-entries',{taskId:task.id,startedAt:'2026-10-04T04:00:00Z',endedAt:'2026-10-04T04:15:00Z'})
    const recent=await api('/time-entries',{taskId:task.id,startedAt:'2026-10-06T04:00:00Z',endedAt:'2026-10-06T04:30:00Z'})
    await api(`/tasks/${task.id}`,{projectId:b.id},'PUT');await browser.navigate(true);await browser.until('document.querySelector(".icon-rail")','Reload');await project()
    await edit(old.id);assert.equal((await history()).find(e=>e.id===old.id).projectIdSnapshot,a.id)
    await input('startDate','2026/10/06');await input('startTime','23:30');await input('endDate','2026/10/07');await input('endTime','00:45');await save()
    const changed=(await history()).find(e=>e.id===old.id)
    assert.equal(changed.durationMinutes,75);assert.equal(changed.projectIdSnapshot,a.id);assert.equal(changed.taskId,task.id)
    assert.equal(await browser.evaluate('Number(document.querySelector(".project-records tbody tr").dataset.entryId)'),old.id)
    assert((await browser.evaluate(`document.querySelector('${row(old.id)}').textContent`)).includes('(+1\u65e5)'))
    const projects=await api('/projects');assert.equal(projects.find(p=>p.id===a.id).actualMinutes,105);assert.equal(projects.find(p=>p.id===b.id).actualMinutes,0)
    assert.equal((await api('/reports/daily?date=2026-10-07&timezone=Asia/Tokyo')).dailyActualMinutes,45)
    await consumption('1\u6642\u959345\u5206');await shot('snapshot-cross-day')
    await project(b.id);await browser.until('document.querySelector(".project-records .empty-state")','Project B has no Snapshot records')
    assert.equal(await browser.evaluate('!!document.querySelector(".project-records .empty-state")'),true)
    await project();assert.equal((await history()).find(e=>e.id===recent.id).projectIdSnapshot,a.id)
  })
  await check('375px inline record edit stays in the Table scroll area; Calendar Escape retains edit and Delete can cancel',async()=>{
    await browser.send('Emulation.setDeviceMetricsOverride',{width:375,height:850,deviceScaleFactor:1,mobile:false})
    await edit()
    assert(await browser.evaluate('document.documentElement.scrollWidth<=innerWidth'))
    const calendarPoint=await browser.evaluate(`(()=>{const e=document.querySelector('${row(original.id)} .deadline-calendar-trigger');e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`)
    for(const type of ['mousePressed','mouseReleased'])await browser.send('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...calendarPoint})
    await browser.until('document.querySelector(".deadline-calendar")', 'Record date Calendar mounted')
    console.log('Record Calendar Focus before Escape',await browser.evaluate('({label:document.activeElement.getAttribute("aria-label"),insideDateInput:!!document.activeElement.closest(".date-input"),calendar:!!document.querySelector(".deadline-calendar")})'))
    await key('Escape');assert(await browser.evaluate(`!!document.querySelector('${row(original.id)} .entry-inline-dates')`))
    assert.equal(await browser.evaluate('!!document.querySelector(".deadline-calendar")'),false)
    await shot('mobile-edit');await cancel();const before=writes().length;await confirmDelete(original.id,false)
    assert.equal(writes().length,before);assert.equal((await history()).length,1)
  })
  await check('Active record disables edit/delete, API rejects direct mutations and Timer Stop still works',async()=>{
    const active=(await history()).find(e=>e.endedAt===null);assert(active)
    await browser.until(`document.querySelector('${row(active.id)}')`,'Active row ready')
    assert((await browser.evaluate(`document.querySelector('${row(active.id)}').textContent`)).includes('\u8a08\u6e2c\u4e2d'))
    assert(await browser.evaluate(`Array.from(document.querySelectorAll('${row(active.id)} .entry-inline-value,${row(active.id)} .entry-menu-options button')).every(e=>e.disabled)`))
    for(const method of ['PATCH','DELETE']){
      const response=await fetch(`${base}/time-entries/${active.id}`,{method,...(method==='PATCH'?{headers:{'Content-Type':'application/json'},body:JSON.stringify({startedAt:'2026-10-07T02:00:00Z',endedAt:'2026-10-07T02:30:00Z'})}:{})})
      assert.equal(response.status,409)
    }
    await shot('active-protected')
    await browser.until('document.querySelector(".global-top-timer .timer-stop")?.disabled===false','Timer Stop enabled')
    await browser.click('.global-top-timer .timer-stop');await browser.until('!document.querySelector(".global-top-timer.timer-session")','Timer stopped')
    await browser.until(`document.querySelector('${row(active.id)} .entry-menu-options .danger')?.disabled===false`,'Closed record becomes editable')
    assert.equal((await api('/tasks/time/active')).running,false)
  })
  assert.deepEqual(errors,[])
  return {base,checks,requests,errors,normalBackendWrites:requests.filter(r=>['POST','PUT','PATCH','DELETE'].includes(r.method)&&new URL(r.effective).port==='8000').length}
}
