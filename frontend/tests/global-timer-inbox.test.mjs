import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { openBrowser, selectTimerTask, pauseOrResumeTimer } from './browser.mjs'

test('Global Header Timer and Inbox release use a guarded temporary DB', { timeout: 240000 }, async t => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const python = process.env.TIMER_TEST_PYTHON ?? path.join(root, 'backend', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  const directory = await mkdtemp(path.join(tmpdir(), 'task-timer-db-'))
  const day = '2026-10-04'
  let browser, backend, base, clockVersion = 0
  let now = Date.parse(`${day}T12:34:00+09:00`)
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  async function setClock(value) {
    now = Date.parse(value)
    const staging = path.join(directory, `clock-${++clockVersion}.txt`)
    await writeFile(staging, value)
    for (let attempt = 0; ; attempt++) {
      try { await rename(staging, path.join(directory, 'clock.txt')); break } catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 30) throw error
        await sleep(20)
      }
    }
    if (browser) await browser.evaluate(`window.__zoomNow=${now}; undefined`)
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
  await setClock(new Date(now).toISOString())
  backend = spawn(python, ['-B', fileURLToPath(new URL('./isolated-backend.py', import.meta.url)), directory], {
    cwd: root, windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = '', log = ''
  backend.stdout.on('data', chunk => { output += chunk.toString() })
  backend.stderr.on('data', chunk => { log += chunk.toString() })
  for (let attempt = 0; attempt < 200; attempt++) {
    const port = output.match(/TIMER_TEST_PORT=(\d+)/)?.[1]
    if (port) {
      base = `http://127.0.0.1:${port}`
      try { if ((await fetch(`${base}/health`)).ok) break } catch { /* Starting. */ }
    }
    assert.equal(backend.exitCode, null, `Temporary Backend exited: ${log}`)
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
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const D=Date;window.__zoomNow=${now};
    window.Date=class extends D{constructor(...a){super(...(a.length?a:[window.__zoomNow]));}static now(){return window.__zoomNow;}};
  })()` })

  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    window.__calendarTicks=new Map();const start=window.setInterval,stop=window.clearInterval;
    window.setInterval=(fn,delay,...args)=>{const id=start(fn,delay,...args);if(delay===60000)window.__calendarTicks.set(id,fn);return id;};
    window.clearInterval=id=>{window.__calendarTicks.delete(id);stop(id);};
  })()` })
  let failDelete=false,holdReads=false,failTasks=false
  const pendingReads=[]
  const errors=[],requests=[]
  let inFlight=0
  browser.listeners.push(message=>{
    if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails)
    if(message.method!=='Fetch.requestPaused')return
    const {request,requestId}=message.params
    inFlight++
    void(async()=>{
      if(request.method==='OPTIONS'){await browser.fulfill(requestId,{});return}
      const url=new URL(request.url)
      requests.push({method:request.method,path:url.pathname,payload:request.postData?JSON.parse(request.postData):null})
      if(failTasks&&request.method==='GET'&&url.pathname==='/tasks'){await browser.fulfill(requestId,{detail:'Controlled Task list failure'},500);return}
      if(failDelete&&request.method==='DELETE'&&url.pathname.startsWith('/schedule-blocks/')){await browser.fulfill(requestId,{detail:'Controlled release failure'},500);return}
      if(holdReads&&request.method==='GET'&&(url.pathname.startsWith('/schedule-blocks')||url.pathname.startsWith('/reports'))){await new Promise(resolve=>pendingReads.push(resolve))}
      const response=await fetch(`${base}${url.pathname}${url.search}`,{method:request.method,...(request.postData?{headers:{'Content-Type':'application/json'},body:request.postData}:{})})
      await browser.fulfill(requestId,await response.json(),response.status)
    })().catch(async error=>{
      if(/Invalid [Ii]nterception|Invalid requestId/.test(error.message))return
      errors.push(error.message)
      try{await browser.send('Fetch.failRequest',{requestId,errorReason:'ConnectionFailed'})}catch{/* Closing. */}
    }).finally(()=>{inFlight--})
  })
  await browser.send('Fetch.enable',{patterns:[{urlPattern:'http://localhost:8000/*',requestStage:'Request'}]})
  const project=await api('/projects',{name:'Shared Timer Project'})
  const tags=[]
  for(const name of ['Backend','Review','Release'])tags.push(await api('/tags',{name,color:'#529968'}))
  const task=await api('/tasks',{title:'Global Timer Task',projectId:project.id,estimatedMinutes:720,tagIds:tags.map(tag=>tag.id)})
  const other=await api('/tasks',{title:'Other Timer Task'})
  const completed=await api('/tasks',{title:'Completed Timer Task'})
  await api(`/tasks/${completed.id}/complete`,{completed:true},'PATCH')
  const timed=await api('/schedule-blocks',{taskId:task.id,date:day,type:'TIMED',startTime:'10:00',durationMinutes:60})
  await api('/schedule-blocks',{taskId:other.id,date:day,type:'TIME_UNSET'})
  await api('/schedule-blocks',{taskId:completed.id,date:day,type:'ALL_DAY'})
  const selector=id=>`[data-schedule-block-id="${id}"]`
  const size=width=>browser.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false})
  async function ready(){
    for(let attempt=0;attempt<200;attempt++){if(!inFlight){await sleep(60);if(!inFlight){await browser.until('!document.querySelector(".unplanned-panel [role=status],.calendar-schedule-status [role=status]")','View published');return}}await sleep(20)}
    assert.fail('API requests did not settle')
  }
  async function headerReady(){await browser.until('document.querySelector(".global-top-timer .timer-play-button")&&!document.querySelector(".global-top-timer .timer-play-button").disabled','Header ready');await ready()}
  async function go(page){
    const labels={home:'ホーム',tasks:'タスク',projects:'プロジェクト',reports:'レポート'}
    const nav=await browser.evaluate('getComputedStyle(document.querySelector(".mobile-nav")).display!=="none"')?'.mobile-nav':'.icon-rail'
    if(nav==='.mobile-nav')await browser.click(`${nav} button:nth-child(${['home','tasks','projects','reports'].indexOf(page)+1})`)
    else await browser.click(`${nav} [aria-label="${labels[page]}"]`)
    await ready()
  }
  async function choose(id){await selectTimerTask(browser,id)}
  async function state(value){await browser.until(`document.querySelector('.global-top-timer')?.classList.contains('timer-session')===${value!=='idle'}&&document.querySelector('.global-top-timer')?.classList.contains('paused')===${value==='paused'}`,'Timer '+value);await headerReady()}
  const start=async()=>{await pauseOrResumeTimer(browser);await state('active')}
  const pause=async()=>{await pauseOrResumeTimer(browser);await state('paused')}
  const stop=async()=>{await browser.click('.global-top-timer .timer-stop');await state('idle')}
  async function responsive(value){
    for(const width of [1440,1024,768,375]){
      await size(width)
      for(const page of ['home','tasks','projects','reports']){
        await go(page)
        const r=await browser.evaluate('(()=>{const e=document.querySelector(".global-top-timer"),r=e.getBoundingClientRect(),buttons=Array.from(e.querySelectorAll("button")).map(b=>{const r=b.getBoundingClientRect();return{left:r.left,right:r.right,width:r.width,height:r.height,top:r.top,bottom:r.bottom,label:b.getAttribute("aria-label")}});return{count:document.querySelectorAll(".global-top-timer").length,inHeader:!!e.closest(".app-header"),left:r.left,right:r.right,top:r.top,bottom:r.bottom,overflow:document.documentElement.scrollWidth>innerWidth,buttons,dock:!!document.querySelector(".timer-dock")}})()')
        assert.equal(r.count,1);assert(r.inHeader&&!r.dock&&!r.overflow&&r.left>=0&&r.right<=width&&r.top>=0&&r.bottom<500,JSON.stringify({width,page,value,r}))
        // The first two buttons are the shared 32px Folder/Tag control shell.
        assert(r.buttons.every((b,i)=>b.width>=(i<2?32:40)&&b.height>=(i<2?32:40)&&b.label&&b.left>=0&&b.right<=width),JSON.stringify({width,page,value,r}))
        assert(r.buttons[0].right<=r.buttons[1].left&&r.buttons[1].right<=r.buttons[2].left)
      }
      if(process.env.GLOBAL_TIMER_VISUAL_OUTPUT){
        const dest=path.resolve(process.env.GLOBAL_TIMER_VISUAL_OUTPUT),relative=path.relative(path.resolve(tmpdir()),dest)
        assert(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative))
        await go('home')
        const shot=await browser.send('Page.captureScreenshot',{format:'png',fromSurface:true})
        await writeFile(path.join(dest,`timer-${value}-${width}.png`),Buffer.from(shot.data,'base64'))
      }
    }
    await size(1440);await go('home')
  }
  async function details(block){
    await sleep(320)
    await browser.evaluate(`document.querySelector('${selector(block.id)}').scrollIntoView({block:'center',inline:'center'})`)
    await browser.click(selector(block.id));await browser.until('document.querySelector(".calendar-popover")','Schedule Popover')
  }
  async function close(){await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await browser.until('!document.querySelector(".calendar-popover")','Popover closed')}
  async function release(block){await details(block);await browser.click('.calendar-dialog-actions .danger');await browser.until(`!document.querySelector('${selector(block.id)}')&&!document.querySelector('.calendar-popover')`,'Block released');await ready()}
  async function drag(block,drop=true){
    await browser.evaluate(`(()=>{const source=document.querySelector('${selector(block.id)}'),target=document.querySelector('.unplanned-panel'),dataTransfer=new DataTransfer();const options={bubbles:true,cancelable:true,dataTransfer};window.__releaseDrag={source,target,options};source.dispatchEvent(new DragEvent('dragstart',options));target.dispatchEvent(new DragEvent('dragover',options));})()`)
    await browser.until('document.querySelector(".unplanned-panel.inbox-release-over")','Inbox drop highlight')
    assert(await browser.evaluate('document.querySelector(".inbox-release-hint").textContent.includes("この予定を解除")'))
    if(drop)await browser.evaluate("(()=>{const{source,target,options}=window.__releaseDrag;target.dispatchEvent(new DragEvent('drop',options));target.dispatchEvent(new DragEvent('drop',options));source.dispatchEvent(new DragEvent('dragend',options));source.dispatchEvent(new MouseEvent('click',{bubbles:true}));})()")
  }
  async function refresh(){await go('tasks');await go('home');await browser.click('.calendar-mode-switch[aria-label="カレンダー表示"] button:nth-child(2)');await ready()}
  const entries=()=>api(`/tasks/${task.id}/time-entries`)
  await size(1440);await browser.navigate();await headerReady()
  await t.test('Idle uses one compact Header Timer in all four pages and removes the bottom dock',()=>responsive('idle'))
  await t.test('Desktop Timer shows empty metadata labels; selected Project and Tags show compact labels',async()=>{
    assert.equal(await browser.evaluate('document.querySelector(".timer-project-trigger .timer-selection-label").textContent'),"プロジェクトなし")
    assert.equal(await browser.evaluate('document.querySelector(".tag-picker-trigger .timer-selection-label").textContent'),"タグなし")
    assert.equal(await browser.evaluate('getComputedStyle(document.querySelector(".tag-picker-trigger [data-icon=tag]")).fill'),await browser.evaluate('getComputedStyle(document.querySelector(".tag-picker-trigger [data-icon=tag]")).color'))
    await choose(task.id)
    await browser.until('document.querySelectorAll(".global-top-timer .timer-selection-label").length===2','Selected metadata visible')
    assert.equal(await browser.evaluate('document.querySelector(".timer-project-trigger .timer-selection-label").textContent'),project.name)
    assert.equal(await browser.evaluate('document.querySelector(".global-top-timer .tag-picker-trigger .tag-chip").textContent'),tags[0].name)
    assert.equal(await browser.evaluate('document.querySelector(".timer-selection-extra").textContent'),'+2')
    await responsive('idle')
  })
  await t.test('Start uses the existing Task API and shows title Project elapsed Pause and Stop',async()=>{
    await choose(task.id);await start();assert.equal((await api('/tasks/time/active')).taskId,task.id)
    assert.equal(await browser.evaluate('document.querySelector(".timer-task-title").textContent'),task.title)
    assert.equal(await browser.evaluate('document.querySelector(".timer-project-name").textContent'),project.name)
  })
  await t.test('Active shares the same mounted Header node and canonical Active across page changes',async()=>{
    const active=await api('/tasks/time/active');await browser.evaluate('window.__globalTimer=document.querySelector(".global-top-timer");undefined')
    for(const page of ['tasks','projects','reports','home']){await go(page);assert(await browser.evaluate('window.__globalTimer===document.querySelector(".global-top-timer")'));assert.deepEqual(await api('/tasks/time/active'),active)}
  })
  await t.test('second ticks update only the readout and Actual lanes without fetching or rewriting Calendar plans',async()=>{
    await browser.send('Profiler.enable');await browser.send('Profiler.startPreciseCoverage',{callCount:true,detailed:true})
    // Establish coverage while Workspace really renders. Subsequent coverage may
    // omit an uncalled script entirely, which is also evidence of no render.
    await go('tasks');await go('home')
    const primed=await browser.send('Profiler.takePreciseCoverage')
    const workspaceFunctions=result=>result.filter(script=>script.url.includes('/src/Workspace.tsx')).flatMap(script=>script.functions).filter(fn=>fn.functionName==='Workspace')
    assert(workspaceFunctions(primed.result).some(fn=>fn.ranges[0].count>0),'Page navigation must record Workspace renders')
    await browser.evaluate("window.__planMutations=0;window.__planObserver=new MutationObserver(()=>window.__planMutations++);window.__planObserver.observe(document.querySelector('.calendar-plan-lane'),{subtree:true,attributes:true,childList:true,characterData:true});undefined")
    const count=requests.length
    await setClock('2026-10-04T03:34:10Z');await browser.until('document.querySelector(".global-top-timer .timer-elapsed").textContent==="0:00:10"','Canonical readout tick')
    assert.equal(requests.length,count);assert.equal(await browser.evaluate('window.__planMutations'),0)
    const coverage=await browser.send('Profiler.takePreciseCoverage')
    assert(workspaceFunctions(coverage.result).every(fn=>fn.ranges[0].count===0),'A second tick must not render Workspace')
    await browser.send('Profiler.stopPreciseCoverage');await browser.send('Profiler.disable')
    await browser.evaluate('window.__planObserver.disconnect()')
  })
  await t.test('same Task shows shared Stop, another Task conflict never automatically stops Active, and Completed Start is disabled',async()=>{
    await details(timed);assert.equal(await browser.evaluate('document.querySelector(".task-detail-top-actions .task-timer-button [data-icon]").dataset.icon'),'stop');assert(await browser.evaluate('document.querySelector(".task-detail-top-actions .task-timer-button").getAttribute("aria-pressed")==="true" && !document.querySelector(".task-detail-top-actions .task-timer-button").disabled'));await close()
    const blocks=await api('/schedule-blocks'),active=await api('/tasks/time/active'),count=requests.filter(r=>r.path==='/tasks/time/stop').length
    await details(blocks.find(b=>b.taskId===other.id));await browser.click('.task-detail-top-actions .task-timer-button');await browser.until('document.querySelector(".calendar-popover [role=alert]")','Conflict inline');assert.deepEqual(await api('/tasks/time/active'),active);assert.equal(requests.filter(r=>r.path==='/tasks/time/stop').length,count);await close()
    await details(blocks.find(b=>b.taskId===completed.id));assert(await browser.evaluate('document.querySelector(".task-detail-top-actions .task-timer-button").disabled'));await close()
  })
  await t.test('Active fits all four widths and all main pages',()=>responsive('active'))
  await t.test('Reload restores the same DB Active in the top Header',async()=>{const active=await api('/tasks/time/active');await browser.navigate(true);await state('active');assert.deepEqual(await api('/tasks/time/active'),active)})
  await t.test('Pause closes the same TimeEntry and freezes the canonical elapsed time',async()=>{
    const id=(await entries())[0].id;await pause();assert.equal((await entries())[0].id,id);assert((await entries())[0].endedAt)
    assert.equal(await browser.evaluate('document.querySelector(".timer-elapsed").textContent'),'0:00:10');await setClock('2026-10-04T03:34:20Z');await sleep(1100);assert.equal(await browser.evaluate('document.querySelector(".timer-elapsed").textContent'),'0:00:10')
  })
  await t.test('Paused state and measured time remain in the same Header across all pages and widths',()=>responsive('paused'))
  await t.test('Resume creates a new interval and Stop closes that interval through existing APIs',async()=>{await start();await setClock('2026-10-04T03:34:30Z');await stop();assert.equal((await entries()).length,2);assert((await entries()).every(e=>e.endedAt!==null))})
  for(const type of ['TIMED','TIME_UNSET','ALL_DAY'])await t.test(`${type} Popover release of the last Block returns Task to Inbox while retaining estimate and actual`,async()=>{
    const item=await api('/tasks',{title:'Popover '+type,estimatedMinutes:345})
    const block=await api('/schedule-blocks',{taskId:item.id,date:day,type,...(type==='TIMED'?{startTime:'15:00',durationMinutes:30}:{})})
    await refresh();await release(block)
    assert(await browser.evaluate(`!!document.querySelector('[data-inbox-task-id="${item.id}"]')`));assert.equal((await api(`/tasks/${item.id}`)).estimatedMinutes,345)
  })
  for(const type of ['TIMED','TIME_UNSET','ALL_DAY'])await t.test(`${type} Drag to Inbox highlights the target and removes only its last ScheduleBlock`,async()=>{
    const item=await api('/tasks',{title:'Drag '+type,estimatedMinutes:720})
    const block=await api('/schedule-blocks',{taskId:item.id,date:day,type,...(type==='TIMED'?{startTime:'16:00',durationMinutes:30}:{})})
    await refresh();const count=requests.filter(r=>r.method==='DELETE').length;await drag(block);await ready()
    assert.equal(requests.filter(r=>r.method==='DELETE').length,count+1);assert(await browser.evaluate(`!!document.querySelector('[data-inbox-task-id="${item.id}"]')`));assert.equal((await api(`/tasks/${item.id}`)).estimatedMinutes,720)
    assert.equal(await browser.evaluate('document.querySelector(".calendar-popover")===null'),true)
  })
  await t.test('releasing one of multiple Blocks keeps the Task placed, its other Block, estimate and history unchanged',async()=>{
    const extra=await api('/schedule-blocks',{taskId:task.id,date:day,type:'ALL_DAY'});await refresh();const before=await entries()
    await drag(extra);await ready();assert((await api('/schedule-blocks')).some(b=>b.id===timed.id));assert(!await browser.evaluate(`!!document.querySelector('[data-inbox-task-id="${task.id}"]')`));assert.deepEqual(await entries(),before);assert.equal((await api(`/tasks/${task.id}`)).estimatedMinutes,720)
  })
  await t.test('failed Drag DELETE preserves the Block and an accessible inline error; retry uses the same ID',async()=>{
    failDelete=true;await drag(timed);await ready();assert(await browser.evaluate(`!!document.querySelector('${selector(timed.id)}')`));assert(await browser.evaluate('document.querySelector(".unplanned-panel [role=alert]").textContent.includes("解除できません")'))
    failDelete=false;await release(timed);assert(await browser.evaluate(`!!document.querySelector('[data-inbox-task-id="${task.id}"]')`))
  })
  await t.test('successful release disappears before held schedule and report reads finish and never removes actuals',async()=>{
    const block=await api('/schedule-blocks',{taskId:task.id,date:day,type:'TIMED',startTime:'18:00',durationMinutes:30});await refresh();const before=await entries()
    holdReads=true;await drag(block);await browser.until(`!document.querySelector('${selector(block.id)}')`,'Removed before refetch');assert(await browser.evaluate('document.querySelector(".week-calendar-panel")!==null'));assert.deepEqual(await entries(),before)
    holdReads=false;for(const resolve of pendingReads.splice(0))resolve();await ready();assert(!await browser.evaluate(`!!document.querySelector('${selector(block.id)}')`))
  })
  await t.test('external forged ScheduleBlock data and dragging an Inbox Task back onto Inbox produce no DELETE',async()=>{
    const count=requests.filter(r=>r.method==='DELETE').length
    await browser.evaluate("(()=>{const target=document.querySelector('.unplanned-panel'),dataTransfer=new DataTransfer();dataTransfer.setData('application/x-schedule-block-id','1');target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer}));const source=document.querySelector('.unplanned-list li'),transfer=new DataTransfer();source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:transfer}));target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));source.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:transfer}));})()")
    await ready();assert.equal(requests.filter(r=>r.method==='DELETE').length,count)
  })
  await t.test('recovered Active can Stop from Header even when its Task list cannot be loaded',async()=>{
    await api('/tasks/time/start',{taskId:task.id})
    failTasks=true;await browser.navigate(true)
    // The intentionally failed Task list cannot satisfy Calendar readiness.
    // Timer recovery and operations must still be independently available.
    await browser.until('document.querySelector(".global-top-timer.timer-session .timer-play-button:not(:disabled)")','Active recovered without Task list')
    assert.equal(await browser.evaluate('document.querySelector(".timer-task-title").textContent'),`タスク #${task.id}`)
    await browser.click('.global-top-timer .timer-stop')
    await browser.until('document.querySelector(".global-top-timer")&&!document.querySelector(".global-top-timer.timer-session")','Stopped without Task list')
    assert.equal((await api('/tasks/time/active')).running,false)
    assert((await entries()).every(entry=>entry.endedAt!==null))
    failTasks=false;await browser.navigate(true);await headerReady()
  })
  assert.deepEqual(errors,[],'No runtime or forwarding errors')
})
