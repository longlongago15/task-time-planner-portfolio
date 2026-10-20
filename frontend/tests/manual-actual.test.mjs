import { setTaskFilter } from './current-task-ui.mjs'
import { openReport, selectReportAnchor } from './report-picker.mjs'
import { isolateScenarios } from './scenario-fixture.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { openBrowser, pauseOrResumeTimer } from './browser.mjs'

test('Manual Actual UX preserves Timer and snapshots on a guarded temporary DB', { timeout: 240000 }, async t => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const python = process.env.TIMER_TEST_PYTHON ?? path.join(root, 'backend', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  const directory = await mkdtemp(path.join(tmpdir(), 'task-timer-db-'))
  let backend, browser, base, now
  let clockVersion = 0
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  async function setClock(value) {
    const staging = path.join(directory, `clock-${++clockVersion}.txt`)
    await writeFile(staging, value)
    for (let attempt = 0; ; attempt += 1) {
      try { await rename(staging, path.join(directory, 'clock.txt')); break } catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 30) throw error
        await sleep(20)
      }
    }
    now = Date.parse(value)
    if (browser) await browser.evaluate(`window.__crudNow = ${now}; undefined`)
  }
  t.after(async () => {
    try { await browser?.close() } finally {
      if (backend?.exitCode === null) {
        const exited = new Promise(resolve => backend.once('exit', resolve))
        if (process.platform === 'win32') {
          const killer = spawn('taskkill.exe', ['/PID', String(backend.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
          await new Promise((resolve, reject) => { killer.once('error', reject); killer.once('exit', resolve) })
        } else backend.kill()
        await exited
      }
      assert.equal(path.dirname(directory), path.resolve(tmpdir()))
      assert(path.basename(directory).startsWith('task-timer-db-'))
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
    }
  })
  await setClock('2026-10-04T03:00:00Z')
  backend = spawn(python, ['-B', fileURLToPath(new URL('./isolated-backend.py', import.meta.url)), directory], {
    cwd: root, windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = '', log = ''
  backend.stdout.on('data', chunk => { output += chunk.toString() })
  backend.stderr.on('data', chunk => { log += chunk.toString() })
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const port = output.match(/TIMER_TEST_PORT=(\d+)/)?.[1]
    if (port) {
      base = `http://127.0.0.1:${port}`
      try { if ((await fetch(`${base}/health`)).ok) break } catch { /* Starting. */ }
    }
    assert.equal(backend.exitCode, null, `Temporary Backend exited: ${output}\n${log}`)
    if (attempt === 199) assert.fail(`Temporary Backend did not start: ${output}\n${log}`)
    await sleep(50)
  }
  async function api(route, payload, method = 'POST') {
    const response = await fetch(`${base}${route}`, payload === undefined ? {} : {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })
    assert(response.ok, `${route}: ${response.status} ${await response.clone().text()}`)
    return response.json()
  }
  browser = await openBrowser()
  await browser.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' })
  await browser.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(()=>{const OriginalDate=Date;window.__crudNow=${now};window.confirm=()=>true;window.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:[window.__crudNow]));}static now(){return window.__crudNow;}};})()`,
  })
  const requests=[],errors=[]
  let failWrite=false,holdWrite=false,releaseWrite
  let holdHistory=false,failHistory=false
  const heldHistories=[]
  browser.listeners.push(message=>{
    if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails)
    if(message.method==='Runtime.consoleAPICalled'&&['error','warning','warn'].includes(message.params.type))errors.push(message.params.args)
    if(message.method!=='Fetch.requestPaused')return
    const {request,requestId}=message.params
    void(async()=>{
      if(request.method==='OPTIONS'){await browser.fulfill(requestId,{});return}
      const url=new URL(request.url)
      const item={method:request.method,path:url.pathname,payload:request.postData?JSON.parse(request.postData):undefined}
      requests.push(item)
      if(url.pathname.startsWith('/time-entries')&&request.method!=='GET'){
        if(failWrite){item.status=500;await browser.fulfill(requestId,{detail:'記録の保存に失敗しました'},500);return}
        if(holdWrite){await browser.evaluate('window.__manualHeld=true');await new Promise(resolve=>{releaseWrite=resolve})}
      }
      const response=await fetch(`${base}${url.pathname}${url.search}`,{method:request.method,...(request.postData?{headers:{'Content-Type':'application/json'},body:request.postData}:{})})
      item.status=response.status
      const body=await response.json()
      if(failHistory&&request.method==='GET'&&url.pathname.endsWith('/time-entries')){
        item.status=500;await browser.fulfill(requestId,{detail:'Controlled history failure'},500);return
      }
      if(holdHistory&&request.method==='GET'&&url.pathname.endsWith('/time-entries')){heldHistories.push({requestId,body});return}
      await browser.fulfill(requestId,body,response.status)
    })().catch(async error=>{
      if(/Invalid [Ii]nterception|Invalid requestId/.test(error.message))return
      errors.push(error.message)
      try{await browser.send('Fetch.failRequest',{requestId,errorReason:'ConnectionFailed'})}catch{/* Closing. */}
    })
  })
  await browser.send('Fetch.enable',{patterns:[{urlPattern:'http://localhost:8000/*',requestStage:'Request'}]})
  const day='2026-10-02'
  const projectA=await api('/projects',{name:'Original Snapshot'}),projectB=await api('/projects',{name:'Corrected Snapshot'})
  const a=await api('/tasks',{title:'Measured task',estimatedMinutes:60,projectId:projectA.id})
  const b=await api('/tasks',{title:'Other task',estimatedMinutes:30,projectId:projectB.id})
  const c=await api('/tasks',{title:'Completed task',estimatedMinutes:null,projectId:projectA.id})
  const n=await api('/tasks',{title:'Unassigned task'})
  const completed=await api(`/tasks/${c.id}/complete`,{completed:true},'PATCH')
  await api('/schedule-blocks',{taskId:a.id,date:day,type:'TIMED',startTime:'09:00',durationMinutes:180})
  const plansBefore=await api('/schedule-blocks')
  const history=tid=>api(`/tasks/${tid}/time-entries`)
  const manualRequests=()=>requests.filter(r=>r.path.startsWith('/time-entries'))
  const selector=id=>`.calendar-event.actual[data-time-entry-id="${id}"]`
  const ready=()=>browser.until('document.querySelector(".calendar-schedule-status") && !document.querySelector(".calendar-schedule-status [role=status]") && !document.querySelector(".calendar-schedule-status [role=alert]")','Plans ready')
  async function home(reload=false){if(reload){await browser.navigate(true);await browser.evaluate(`window.__crudNow=${now};undefined`)}await browser.until('document.querySelector(".icon-rail")','Mounted');await browser.click('.icon-rail [aria-label="ホーム"]');await ready()}
  async function mode(value){await browser.click(`[aria-label="カレンダー表示"] button:nth-child(${value==='day'?1:2})`);await ready()}
  async function input(name,value,scope='.time-entry-dialog'){
    await browser.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(scope+` [name="${name}"]`)});Object.getOwnPropertyDescriptor(e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(String(value))});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`)
  }
  const dialog=()=>browser.until('document.querySelector(".time-entry-dialog:is([open], .calendar-popover)")','Actual surface')
  async function close(){await browser.click('.time-entry-dialog [aria-label="記録の操作を閉じる"]');await browser.until('!document.querySelector(".time-entry-dialog")','Actual closed')}
  async function point(minute,date=day){
    return browser.evaluate('(()=>{const e=document.querySelector('+JSON.stringify('[data-actual-date="'+date+'"]')+');e.scrollIntoView({block:"nearest",inline:"center"});const scroll=e.closest(".calendar-time-grid"),initial=e.getBoundingClientRect();if(scroll){const clip=scroll.getBoundingClientRect();scroll.scrollTop+=initial.top+initial.height*'+minute+'/1440-(clip.top+clip.height/2)}const r=e.getBoundingClientRect();return{x:r.left+r.width*.7,y:r.top+r.height*'+minute+'/1440}})()')
  }
  async function clickTime(minute,date=day){const p=await point(minute,date);await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',...p});await browser.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p});await browser.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p});await dialog()}
  async function open(id){await browser.until(`(()=>{const e=document.querySelector(${JSON.stringify(selector(id))});if(!e)return false;e.click();return true})()`,'Actual rendered and selected');await dialog()}
  async function save(){await browser.click('.time-entry-dialog button[type=submit]');await browser.until('!document.querySelector(".time-entry-dialog")','Saved closed');await ready()}
  async function edit(id,fields){await open(id);await browser.click('.actual-dialog-actions button:first-child');for(const[name,value]of Object.entries(fields))await input(name,value);await save()}
  async function report(modeName,expected){
    await openReport(browser,modeName)
    await selectReportAnchor(browser,day)
    await browser.until('document.querySelector(".report-summary-actual strong")?.textContent==='+JSON.stringify(expected),modeName+' actual refreshed')
  }
  async function screenshot(name){if(!process.env.ACTUAL_VISUAL_OUTPUT)return;const dest=path.resolve(process.env.ACTUAL_VISUAL_OUTPUT),relative=path.relative(path.resolve(tmpdir()),dest);assert(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));const shot=await browser.send('Page.captureScreenshot',{format:'png',fromSurface:true});await writeFile(path.join(dest,name+'.png'),Buffer.from(shot.data,'base64'))}
  let entry,dragged,adjacent,cross
  await browser.navigate();await home()
  const scenarioNames = ['Actual lane click', 'closed Actual details', 'same-task correction', 'history correction', 'Daily Weekly Monthly,', 'closed delete', 'desktop Actual drag', 'global overlap', 'equal,', 'cross-midnight', 'Active details', '375px', 'API failures', 'keyboard Actual', 'manual Actual inputs', 'successful Actual Delete', 'Closed Actual Popover', 'Active Actual Popover', 'Active Actual Stop', 'dragging an Actual']
  await isolateScenarios(t, { browser, directory, python,
    reset: async () => {
      failWrite = holdWrite = holdHistory = failHistory = false
      releaseWrite?.(); releaseWrite = undefined
      for (const held of heldHistories.splice(0)) await browser.fulfill(held.requestId, held.body)
    },
    prepare: async name => {
      const index = scenarioNames.findIndex(prefix => name.startsWith(prefix))
      assert(index >= 0, `Missing independent fixture for ${name}`)
      await setClock('2026-10-04T03:00:00Z')
      if (index >= 1 && index <= 5) {
        entry = await api('/time-entries', { taskId: a.id, startedAt: index === 2 ? '2026-10-02T00:15:00Z' : '2026-10-02T00:00:00Z', endedAt: index === 2 || index === 3 ? '2026-10-02T01:00:00Z' : '2026-10-02T00:30:00Z' })
        if (index >= 2) await api(`/tasks/${a.id}`, { projectId: projectB.id }, 'PUT')
      }
      if (index === 7) dragged = await api('/time-entries', { taskId: a.id, startedAt: '2026-10-02T01:00:00Z', endedAt: '2026-10-02T02:00:00Z' })
      if (index === 15) precise = await api('/time-entries', { taskId: n.id, startedAt: '2026-10-01T00:00:30.123Z', endedAt: '2026-10-01T00:30:45.456Z' })
      if (index === 18 || index === 19) {
        await setClock('2026-10-04T03:20:00Z'); await api('/tasks/time/start', { taskId: a.id })
        await setClock('2026-10-04T03:25:00Z')
        if (index === 19) await api('/tasks/time/stop', { taskId: a.id })
      }
    }, ready: async name => { await browser.evaluate(`window.__crudNow=${now};undefined`); await home(); if (name.startsWith('Active Actual Stop')) await pauseOrResumeTimer(browser) },
  })
  await t.test('Actual lane click opens a separate name-independent closed form with a thirty-minute local default',async()=>{
    await clickTime(540)
    assert.equal(await browser.evaluate('document.querySelector(".calendar-dialog")===null'),true)
    assert.equal(await browser.evaluate('document.querySelector(".time-entry-dialog h2").textContent'),'記録を追加')
    assert.equal(await browser.evaluate('new Date(document.querySelector("[name=startedAt]").value).toISOString()'),'2026-10-02T00:00:00.000Z')
    assert.equal(await browser.evaluate('new Date(document.querySelector("[name=endedAt]").value).toISOString()'),'2026-10-02T00:30:00.000Z')
    assert.equal(await browser.evaluate('document.querySelector(".time-entry-form select").value'),'')
    assert.equal(await browser.evaluate('Array.from(document.querySelectorAll(".time-entry-form option")).some(o=>o.textContent.includes("Completed task"))'),true)
    await input('taskId',a.id);await save();entry=(await history(a.id))[0]
    assert.equal(entry.startedAt,'2026-10-02T00:00:00Z');assert.equal(entry.endedAt,'2026-10-02T00:30:00Z')
    assert.equal(entry.projectIdSnapshot,projectA.id);assert.equal((await api(`/tasks/${a.id}`)).status,'IN_PROGRESS')
    assert.deepEqual(await api('/schedule-blocks'),plansBefore)
    assert.equal(manualRequests().length,1)
  })
  await t.test('closed Actual details are accessible and start/end corrections retain the entry identity',async()=>{
    await open(entry.id)
    assert.equal(await browser.evaluate('document.querySelector(".time-entry-dialog h2").textContent'),a.title)
    assert(await browser.evaluate('document.querySelector(".actual-detail").textContent.includes("30分")'))
    await close();await edit(entry.id,{startedAt:'2026-10-02T09:15'})
    assert.equal((await history(a.id))[0].durationMinutes,15)
    await edit(entry.id,{endedAt:'2026-10-02T10:00'})
    const value=(await history(a.id))[0];assert.equal(value.durationMinutes,45);assert.equal(value.id,entry.id);assert.equal(value.createdAt,entry.createdAt)
  })
  await t.test('same-task correction after moving its Project preserves the original Snapshot',async()=>{
    await api(`/tasks/${a.id}`,{projectId:projectB.id},'PUT');await home(true)
    await edit(entry.id,{startedAt:'2026-10-02T09:00'})
    assert.equal((await history(a.id))[0].projectIdSnapshot,projectA.id)
    assert.equal((await api('/projects')).find(p=>p.id===projectA.id).actualMinutes,60)
  })
  await t.test('history correction keeps Task and Snapshot read-only and preserves completed Task fields',async()=>{
    await open(entry.id);await browser.click('.actual-dialog-actions button:first-child')
    assert.equal(await browser.evaluate('document.querySelector(".time-entry-form [name=taskId]")'),null)
    assert(await browser.evaluate('document.querySelector(".time-entry-form .actual-detail").textContent.includes("Original Snapshot")'))
    await input('endedAt','2026-10-02T09:30');await save()
    const value=(await history(a.id))[0];assert.equal(value.taskId,a.id);assert.equal(value.projectIdSnapshot,projectA.id)
    assert.equal((await history(b.id)).length,0)
    const current=await api(`/tasks/${c.id}`)
    for(const key of ['status','completed','completedAt','completedEstimateMinutes'])assert.equal(current[key],completed[key])
    assert.deepEqual(Object.keys(manualRequests().findLast(r=>r.method==='PATCH').payload).sort(),['endedAt','startedAt'])
  })
  await t.test('Daily Weekly Monthly, Task actual and Project Progress update without reload or client addition',async()=>{
    for(const value of ['day','week','month'])await report(value,'30分')
    await browser.click('.icon-rail [aria-label="タスク"]')
    await setTaskFilter(browser,'status',[])
    await browser.until(`document.querySelector('.task-table-row[data-task-id="${a.id}"] [data-label="記録"]')?.textContent==='30m'`,'Task actual')
    await browser.click('.icon-rail [aria-label="プロジェクト"]')
    await browser.until(`document.querySelector('.project-card[data-project-id="${projectA.id}"] .time .project-progress-text')?.textContent.startsWith('30分 /')`,'Snapshot Project recorded minutes')
    await home()
  })
  await t.test('closed delete confirms, preserves other records, refreshes all Reports and never guesses status',async()=>{
    await open(entry.id);await browser.evaluate('window.confirm=()=>false');await browser.click('.actual-dialog-actions .danger')
    assert.equal((await history(a.id)).length,1)
    await browser.evaluate('window.confirm=()=>true');await browser.click('.actual-dialog-actions .danger')
    await browser.until('!document.querySelector(".time-entry-dialog")','Deleted closed')
    await browser.until(`!document.querySelector(${JSON.stringify(selector(entry.id))})`,'Removed from Calendar')
    assert.equal((await history(a.id)).length,0);assert.equal((await api(`/tasks/${c.id}`)).status,'COMPLETED')
    assert.deepEqual(await api('/schedule-blocks'),plansBefore)
    for(const value of ['day','week','month'])await report(value,'0分')
    await home()
  })
  await t.test('desktop Actual drag previews a snapped interval and creates no schedule or entry before Save',async()=>{
    const before=await history(a.id),p=await point(601),q={x:p.x,y:p.y+59*.9}
    await browser.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p})
    await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,...q})
    await browser.until('document.querySelector(".actual-create-preview")','Actual drag preview')
    assert(await browser.evaluate('document.querySelector(".actual-create-preview").textContent.includes("記録")'))
    assert.deepEqual(await history(a.id),before)
    await browser.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...q});await dialog()
    assert.equal(await browser.evaluate('new Date(document.querySelector("[name=startedAt]").value).toISOString()'),'2026-10-02T01:00:00.000Z')
    assert.equal(await browser.evaluate('new Date(document.querySelector("[name=endedAt]").value).toISOString()'),'2026-10-02T02:00:00.000Z')
    await input('taskId',a.id);await save();dragged=(await history(a.id))[0]
    assert.equal(dragged.durationMinutes,60);assert.deepEqual(await api('/schedule-blocks'),plansBefore)
  })
  await t.test('global overlap 409 remains by the form; adjacent retry keeps the prior entry intact',async()=>{
    await clickTime(780);await input('taskId',b.id);await input('startedAt','2026-10-02T10:15');await input('endedAt','2026-10-02T10:45')
    await browser.click('.time-entry-dialog button[type=submit]')
    await browser.until('document.querySelector(".time-entry-dialog [role=alert]")?.textContent.includes("この時間帯にはすでに記録があります。重ならない時間を指定してください。")','Overlap error')
    assert.equal(manualRequests().at(-1).status,409);assert.deepEqual((await history(a.id))[0],dragged)
    await input('startedAt','2026-10-02T11:00');await input('endedAt','2026-10-02T12:00');await save()
    adjacent=(await history(b.id))[0];assert.equal(adjacent.durationMinutes,60)
  })
  await t.test('equal, reversed and future times are rejected without an API mutation',async()=>{
    await clickTime(780);await input('taskId',n.id)
    const before=manualRequests().length
    for(const[start,end]of [['2026-10-02T13:00','2026-10-02T13:00'],['2026-10-02T14:00','2026-10-02T13:00'],['2026-10-05T13:00','2026-10-05T14:00']]){
      await input('startedAt',start);await input('endedAt',end);await browser.click('.time-entry-dialog button[type=submit]')
      await browser.until('document.querySelector(".time-entry-dialog [role=alert]")','Time validation')
    }
    assert.equal(manualRequests().length,before);await close()
  })
  await t.test('cross-midnight input stores one entry, renders both days and uses existing daily overlap totals',async()=>{
    const before=await api('/reports/daily?date=2026-10-02&timezone=Asia/Tokyo')
    await clickTime(1410);await input('taskId',n.id);await input('endedAt','2026-10-03T00:30');await save()
    cross=(await history(n.id))[0];assert.equal(cross.durationMinutes,60)
    await browser.until(`document.querySelectorAll(${JSON.stringify(selector(cross.id))}).length===2`,'Midnight entry rendered in both days')
    assert.equal((await api('/reports/daily?date=2026-10-02&timezone=Asia/Tokyo')).dailyActualMinutes,before.dailyActualMinutes+30)
    assert.equal((await api('/reports/daily?date=2026-10-03&timezone=Asia/Tokyo')).dailyActualMinutes,30)
  })
  await t.test('Active details disable Edit/Delete and past manual add leaves the exact same global Timer',async()=>{
    const active=await api('/tasks/time/start',{taskId:a.id})
    await setClock('2026-10-04T03:10:00Z');await home(true)
    const entry=(await history(a.id)).find(e=>e.endedAt===null)
    await open(entry.id)
    assert(await browser.evaluate('document.querySelector(".time-entry-dialog").textContent.includes("計測中")'))
    assert(await browser.evaluate('Array.from(document.querySelectorAll(".actual-dialog-actions button")).slice(0,2).every(b=>b.disabled)'))
    await close();await clickTime(690,'2026-10-04');await input('taskId',b.id);await save()
    assert.deepEqual(await api('/tasks/time/active'),active)
    await clickTime(780,'2026-10-04');await input('taskId',b.id);await input('startedAt','2026-10-04T12:00');await input('endedAt','2026-10-04T12:05')
    await browser.click('.time-entry-dialog button[type=submit]')
    await browser.until('document.querySelector(".time-entry-dialog [role=alert]")?.textContent.includes("この時間帯にはすでに記録があります。重ならない時間を指定してください。")','Active overlap')
    assert.deepEqual(await api('/tasks/time/active'),active);await close()
    await browser.click('.header-timer-control .timer-stop');await browser.until('!document.querySelector(".header-timer-control.timer-session")','Existing Timer Stop')
  })
  await t.test('375px Touch tap supports manual creation and the separate Dialog fits all four viewports',async()=>{
    await browser.send('Emulation.setDeviceMetricsOverride',{width:375,height:1000,deviceScaleFactor:1,mobile:true})
    await browser.send('Emulation.setTouchEmulationEnabled',{enabled:true})
    await mode('day')
    const p=await point(600,'2026-10-04')
    await browser.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:p.x,y:p.y}]});await browser.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await dialog()
    await input('taskId',c.id);await save()
    const value=(await history(c.id))[0];assert.equal(value.durationMinutes,30)
    await open(value.id)
    for(const width of [1440,1024,768,375]){
      await browser.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false})
      await browser.until(`(()=>{const e=document.querySelector('.time-entry-dialog');if(!e)return false;const r=e.getBoundingClientRect();return r.left>=0&&r.right<=${width}&&r.top>=0&&r.bottom<=1000&&e.scrollWidth<=e.clientWidth})()`,'Actual surface fits resized viewport')
      const bounds=await browser.evaluate('(()=>{const e=document.querySelector(".time-entry-dialog"),r=e.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,overflow:e.scrollWidth>e.clientWidth}})()')
      assert(bounds.left>=0&&bounds.right<=width&&bounds.top>=0&&bounds.bottom<=1000&&!bounds.overflow)
      await screenshot('actual-detail-'+width)
    }
    await browser.click('.actual-dialog-actions button:first-child');await screenshot('actual-edit-375');await close()
    await browser.send('Emulation.setTouchEmulationEnabled',{enabled:false});await mode('week')
  })
  await t.test('API failures preserve input and history; pending save rejects duplicate submits and Escape dismissal',async()=>{
    await clickTime(810,'2026-10-03');await input('taskId',n.id);failWrite=true
    await browser.click('.time-entry-dialog button[type=submit]')
    await browser.until('document.querySelector(".time-entry-dialog [role=alert]")?.textContent.includes("失敗")','Save failure')
    assert.equal(await browser.evaluate('document.querySelector("[name=taskId]").value'),String(n.id))
    failWrite=false;holdWrite=true;const count=manualRequests().filter(r=>r.method==='POST').length
    await browser.click('.time-entry-dialog button[type=submit]');await browser.until('window.__manualHeld===true','Pending save')
    await browser.evaluate('document.querySelector(".time-entry-form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));document.querySelector(".time-entry-form").requestSubmit()')
    await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
    await browser.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
    assert(await browser.evaluate('document.querySelector(".time-entry-dialog").open'))
    holdWrite=false;releaseWrite();await browser.until('!document.querySelector(".time-entry-dialog")','Saved once')
    assert.equal(manualRequests().filter(r=>r.method==='POST').length,count+1)
    const saved=(await history(n.id)).find(e=>e.startedAt==='2026-10-03T04:30:00Z')
    assert(saved)
    const before=await history(n.id)
    await open(saved.id);failWrite=true;await browser.click('.actual-dialog-actions .danger')
    await browser.until('document.querySelector(".time-entry-dialog [role=alert]")','Delete failure')
    assert.deepEqual(await history(n.id),before,'A failed Delete preserves the full history')
    failWrite=false;await browser.click('.actual-dialog-actions .danger')
    await browser.until('!document.querySelector(".time-entry-dialog")','Delete retry succeeds')
    assert.deepEqual(await history(n.id),before.filter(e=>e.id!==saved.id))
  })
  await t.test('keyboard Actual selection focuses the form and Escape cancels without writing',async()=>{
    await browser.evaluate(`document.querySelector('[data-actual-date="2026-10-03"]').focus()`)
    await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13})
    await browser.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await dialog()
    assert.equal(await browser.evaluate('document.activeElement.name'),'taskId')
    const count=manualRequests().length
    await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
    await browser.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
    await browser.until('!document.querySelector(".time-entry-dialog")','Escape cancel')
    assert.equal(manualRequests().length,count)
    assert.equal(await browser.evaluate('document.activeElement.dataset.actualDate'),'2026-10-03')
  })
  let precise
  await t.test('manual Actual inputs contain minutes only and unchanged saves retain API precision',async()=>{
    precise=await api('/time-entries',{taskId:n.id,startedAt:'2026-10-01T00:00:30.123Z',endedAt:'2026-10-01T00:30:45.456Z'})
    await home(true);await open(precise.id)
    assert.equal(await browser.evaluate('/\\d{2}:\\d{2}:\\d{2}|\\.\\d{3}/.test(document.querySelector(".actual-detail").textContent)'),false)
    await browser.click('.actual-dialog-actions button:first-child')
    assert(await browser.evaluate('Array.from(document.querySelectorAll(".time-entry-form input[type=datetime-local]")).every(e=>e.step==="60"&&/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$/.test(e.value))'))
    await save()
    const stored=(await history(n.id)).find(e=>e.id===precise.id)
    assert.equal(stored.startedAt,precise.startedAt);assert.equal(stored.endedAt,precise.endedAt)
  })
  await t.test('successful Actual Delete disappears before held refetches finish and remains absent after a read failure',async()=>{
    const before=await browser.evaluate('Array.from(document.querySelectorAll(".calendar-event.actual")).map(e=>e.dataset.timeEntryId)')
    assert(before.includes(String(precise.id)))
    await open(precise.id);holdHistory=true
    await browser.click('.actual-dialog-actions .danger')
    await browser.until(`!document.querySelector('.time-entry-dialog')&&!document.querySelector('${selector(precise.id)}')`, 'DELETE success immediately removes Actual')
    await browser.until('document.querySelector(".calendar-schedule-status").textContent.includes("記録を更新中")','Actual refetch pending')
    const after=await browser.evaluate('Array.from(document.querySelectorAll(".calendar-event.actual")).map(e=>e.dataset.timeEntryId)')
    assert.deepEqual(after,before.filter(id=>id!==String(precise.id)),'Only the deleted Actual disappears during fetch')
    for(let attempt=0;!heldHistories.length&&attempt<100;attempt++)await sleep(20)
    assert(heldHistories.length>0)
    // Fail subsequent reads too: a Task refresh can start a newer history request
    // after the currently held batch. Keep the failure deterministic until Retry.
    failHistory=true;holdHistory=false
    for(const item of heldHistories.splice(0)){
      try{await browser.fulfill(item.requestId,{detail:'Controlled history failure'},500)}catch(error){if(!/Invalid [Ii]nterception|Invalid requestId/.test(error.message))throw error}
    }
    await browser.until('document.querySelector(".calendar-schedule-status [role=alert]")?.textContent.includes("記録")','History failure handled')
    assert.equal(await browser.evaluate(`document.querySelector('${selector(precise.id)}')===null`),true)
    failHistory=false
    await browser.click('.calendar-schedule-status [role=alert] button');await ready()
    assert.equal((await history(n.id)).some(e=>e.id===precise.id),false)
  })
  await t.test('Closed Actual Popover displays its historical Project, minute dates and Edit without changing Snapshot',async()=>{
    const entry=await api('/time-entries',{taskId:n.id,startedAt:'2026-10-01T01:00:00Z',endedAt:'2026-10-01T02:00:00Z'})
    await api(`/tasks/${n.id}`,{projectId:projectB.id},'PUT');await home(true);await open(entry.id)
    assert.equal(await browser.evaluate('document.querySelector(".time-entry-dialog").tagName'),'DIV')
    assert.equal(await browser.evaluate('document.querySelector(".time-entry-dialog").getAttribute("aria-modal")'),'false')
    assert.equal(await browser.evaluate('document.querySelector(".time-entry-dialog h2").textContent'),n.title)
    assert(await browser.evaluate('(()=>{const p=document.querySelector(".actual-dialog-actions");return getComputedStyle(p.querySelector(".danger")).color!==getComputedStyle(p.querySelector(".secondary-button")).color})()'),'Delete retains the shared Danger appearance')
    assert.equal(await browser.evaluate('document.querySelector(".calendar-popover-project").textContent'),'未所属')
    assert(await browser.evaluate('document.querySelector(".actual-detail").textContent.includes("1時間")'))
    await screenshot('closed-actual-popover');await browser.click('.actual-dialog-actions button:first-child')
    assert.equal(await browser.evaluate('document.querySelector(".time-entry-dialog").tagName'),'DIALOG')
    await input('endedAt','2026-10-01T11:30');await save()
    const edited=(await history(n.id)).find(e=>e.id===entry.id);assert.equal(edited.durationMinutes,90);assert.equal(edited.projectIdSnapshot,null)
    await open(entry.id);await browser.click('.actual-dialog-actions .danger');await browser.until(`!document.querySelector('${selector(entry.id)}')&&!document.querySelector('.time-entry-dialog')`,'Popover DELETE immediately removes Actual');await ready()
  })
  await t.test('Active Actual Popover shows elapsed minutes, forbids Edit/Delete and Pause closes the same entry',async()=>{
    await setClock('2026-10-04T03:20:00Z');await api('/tasks/time/start',{taskId:a.id});await setClock('2026-10-04T03:25:00Z');await home(true)
    const entry=(await history(a.id)).find(e=>e.endedAt===null);await open(entry.id)
    assert.equal(await browser.evaluate('document.querySelector(".time-entry-dialog h2").textContent'),a.title)
    assert(await browser.evaluate('document.querySelector(".actual-detail").textContent.includes("5分 · 計測中")'))
    assert(await browser.evaluate('Array.from(document.querySelectorAll(".actual-dialog-actions button")).slice(0,2).every(e=>e.disabled)'))
    await screenshot('active-actual-popover')
    await browser.until('Array.from(document.querySelectorAll(".actual-dialog-actions button")).find(e=>e.textContent==="一時停止")?.disabled===false','Active reconciled')
    await browser.evaluate('Array.from(document.querySelectorAll(".actual-dialog-actions button")).find(e=>e.textContent==="一時停止").click()')
    await browser.until('!document.querySelector(".time-entry-dialog")','Paused from Popover');await ready()
    assert((await history(a.id)).find(e=>e.id===entry.id).endedAt);assert.equal((await api('/tasks/time/active')).running,false)
    assert(await browser.evaluate('document.querySelector(".header-timer-control.paused")!==null'))
  })
  await t.test('Active Actual Stop reuses the existing lifecycle and retains the recorded interval',async()=>{
    await pauseOrResumeTimer(browser);await browser.until('document.querySelector(".header-timer-control.timer-session:not(.paused)")&&!document.querySelector(".timer-stop").disabled','Resumed')
    await setClock('2026-10-04T03:30:00Z');const entry=(await history(a.id)).find(e=>e.endedAt===null);await open(entry.id)
    await browser.evaluate('Array.from(document.querySelectorAll(".actual-dialog-actions button")).find(e=>e.textContent==="終了して保存").click()')
    await browser.until('!document.querySelector(".time-entry-dialog")&&!document.querySelector(".header-timer-control.timer-session")','Stopped from Popover');await ready()
    assert((await history(a.id)).find(e=>e.id===entry.id).endedAt);assert.equal((await api('/tasks/time/active')).running,false)
  })
  await t.test('dragging an Actual Block does not open details or change history; a later click still opens',async()=>{
    const entry=(await history(a.id)).find(e=>e.endedAt!==null)
    const before=await history(a.id)
    const point=await browser.evaluate(`(()=>{const e=document.querySelector('${selector(entry.id)}');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.left+10,y:r.top+5}})()`)
    await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x,y:point.y})
    await browser.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,x:point.x,y:point.y})
    await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x:point.x+8,y:point.y})
    await browser.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,x:point.x+8,y:point.y})
    assert.equal(await browser.evaluate('document.querySelector(".time-entry-dialog")===null'),true)
    assert.deepEqual(await history(a.id),before)
    await sleep(320);await open(entry.id);await close()
  })
  assert.deepEqual(await api('/schedule-blocks'),plansBefore,'Manual CRUD never changes plans')
  assert.deepEqual(errors,[],'No browser or forwarding errors')
})
