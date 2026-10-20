import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { openBrowser, selectTimerTask, pauseOrResumeTimer } from './browser.mjs'

test('Calendar current time and five scales use a guarded temporary DB', { timeout: 240000 }, async t => {
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
      const response=await fetch(`${base}${url.pathname}${url.search}`,{method:request.method,...(request.postData?{headers:{'Content-Type':'application/json'},body:request.postData}:{})})
      await browser.fulfill(requestId,await response.json(),response.status)
    })().catch(async error=>{
      if(/Invalid [Ii]nterception|Invalid requestId/.test(error.message))return
      errors.push(error.message)
      try{await browser.send('Fetch.failRequest',{requestId,errorReason:'ConnectionFailed'})}catch{/* Closing. */}
    }).finally(()=>{inFlight--})
  })
  await browser.send('Fetch.enable',{patterns:[{urlPattern:'http://localhost:8000/*',requestStage:'Request'}]})
  const project=await api('/projects',{name:'Zoom Project'})
  const task=await api('/tasks',{title:'Scale reference',projectId:project.id,estimatedMinutes:720})
  const reference=await api('/schedule-blocks',{taskId:task.id,date:'2026-10-02',type:'TIMED',startTime:'10:00',durationMinutes:120})
  const actual=await api('/time-entries',{taskId:task.id,startedAt:'2026-10-02T01:00:00Z',endedAt:'2026-10-02T03:00:00Z'})
  const timerTask=await api('/tasks',{title:'Independent Timer'})
  const hours=[36,45,54,72,90], dates=['2026-09-28','2026-09-29','2026-09-30','2026-10-01','2026-10-03']
  const planSelector=id=>`.weekly-schedule-event[data-schedule-block-id="${id}"]`
  const actualSelector=id=>`.calendar-event.actual[data-time-entry-id="${id}"]`
  async function ready(){
    await browser.until('document.querySelector(".calendar-schedule-status")&&!document.querySelector(".calendar-schedule-status [role=status]")&&!document.querySelector(".calendar-schedule-status [role=alert]")','Calendar ready')
    for(let attempt=0;attempt<100;attempt++){if(!inFlight){await sleep(40);if(!inFlight)return}await sleep(20)}
    assert.fail('Temporary API requests did not settle')
  }
  async function mode(value){
    await browser.click(`[aria-label="カレンダー表示"] button:nth-child(${({day:1,week:2,month:3})[value]})`)
    await ready();await browser.until(value==='month'?'document.querySelector(".month-grid")':'document.querySelector(".week-calendar-panel")','Mode displayed')
  }
  async function chooseDay(date){
    await browser.evaluate(`Array.from(document.querySelectorAll('.calendar-week-header > button')).find(e=>e.querySelector('strong')?.textContent===${JSON.stringify(String(Number(date.slice(8,10))))}).click()`)
    await ready();await mode('day')
    await browser.until(`document.querySelector('.calendar-day-column')?.dataset.calendarDate===${JSON.stringify(date)}`,'Selected day displayed')
  }
  const level=()=>browser.evaluate('Number(document.querySelector(".calendar-zoom-control").dataset.zoomLevel)')
  async function zoom(target){
    while(await level()!==target)await browser.click(`[aria-label="${await level()<target?'時間軸を拡大':'時間軸を縮小'}"]`)
    await browser.until(`Number(document.querySelector('.week-calendar-panel').dataset.zoomLevel)===${target}`,'Scale displayed')
  }
  const line=()=>browser.evaluate('Array.from(document.querySelectorAll(".calendar-current-time")).map(e=>({date:e.dataset.currentDate,minute:Number(e.dataset.currentMinute),top:parseFloat(e.style.top),pointer:getComputedStyle(e).pointerEvents,marker:getComputedStyle(e,"::before").width}))')
  async function tick(value){await setClock(value);await browser.evaluate('for(const callback of window.__calendarTicks.values())callback()')}
  async function input(name,value,scope='.calendar-dialog'){
    await browser.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(scope+` [name="${name}"]`)});Object.getOwnPropertyDescriptor(e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(String(value))});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`)
  }
  async function point(minute,date,actualLane=false){
    const selector=actualLane?`[data-actual-date="${date}"]`:`[data-timed-drop-date="${date}"]`
    const value=await browser.evaluate(`(async()=>{const lane=document.querySelector('${selector}'),grid=lane.closest('.calendar-time-grid'),rate=parseFloat(getComputedStyle(lane).getPropertyValue('--calendar-hour-height'))/60,y=${minute}*rate;
      grid.scrollTop=Math.max(0,y-grid.clientHeight/2);lane.scrollIntoView({block:'nearest',inline:'center'});const r=lane.getBoundingClientRect();window.scrollBy(0,r.top+y-320);
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const rect=lane.getBoundingClientRect();return{x:rect.left+rect.width*.7,y:rect.top+y,rate};})()`)
    await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:value.x,y:value.y})
    return value
  }
  async function selectRange(start,end,date,actualLane=false){
    const p=await point(start,date,actualLane)
    await browser.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,x:p.x,y:p.y})
    await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x:p.x,y:p.y+(end-start)*p.rate})
    return p
  }
  async function releaseRange(p,minutes){
    await browser.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,x:p.x,y:p.y+minutes*p.rate})
  }
  async function screenshot(name){
    if(!process.env.CALENDAR_ZOOM_VISUAL_OUTPUT)return
    const directory=path.resolve(process.env.CALENDAR_ZOOM_VISUAL_OUTPUT),relative=path.relative(path.resolve(tmpdir()),directory)
    assert(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative))
    const shot=await browser.send('Page.captureScreenshot',{format:'png',fromSurface:true})
    await writeFile(path.join(directory,name+'.png'),Buffer.from(shot.data,'base64'))
  }
  const size=width=>browser.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false})
  const near=selector=>`(()=>{const a=document.querySelector('${selector}').getBoundingClientRect(),p=document.querySelector('.calendar-popover').getBoundingClientRect();return p.left>=0&&p.right<=innerWidth&&p.top>=0&&p.bottom<=innerHeight&&Math.min(Math.abs(p.left-a.right),Math.abs(a.left-p.right))<=12})()`
  await size(1440);await browser.navigate();await ready()
  await browser.until('!document.querySelector(".header-timer-control .timer-play-button").disabled','Timer ready')
  await t.test('Week mounts one current-time line in the local today column even while Timer is idle',async()=>{
    assert.equal(await level(),3)
    const values=await line();assert.equal(values.length,1);assert.equal(values[0].date,day);assert.equal(values[0].minute,754)
    assert(Math.abs(values[0].top-754*.9)<.01);assert.equal(values[0].pointer,'none');assert.equal(values[0].marker,'6px')
    assert.equal(await browser.evaluate('window.__calendarTicks.size'),1)
    assert.equal((await api('/tasks/time/active')).running,false)
  })
  await t.test('a minute clock tick moves the line without fetching or starting a Timer',async()=>{
    const count=requests.length
    await tick('2026-10-04T03:35:00Z');await browser.until('document.querySelector(".calendar-current-time").dataset.currentMinute==="755"','Minute tick')
    assert.equal((await line())[0].top,755*.9);assert.equal(requests.length,count);assert.equal((await api('/tasks/time/active')).running,false)
  })
  await t.test('Day today shows the line, past and future days hide it, and Today restores it',async()=>{
    await mode('day');assert.equal((await line()).length,1)
    await browser.click('[aria-label="前の期間"]');await ready();assert.equal((await line()).length,0)
    await browser.click('[aria-label="次の期間"]');await ready();await browser.click('[aria-label="次の期間"]');await ready();assert.equal((await line()).length,0)
    await browser.click('.today-button');await ready();assert.equal((await line())[0].date,day)
  })
  await t.test('five zoom levels clamp at both ends without API calls, DB writes, auto scroll or loading replacement',async()=>{
    const before=await api('/schedule-blocks'),entries=await api(`/tasks/${task.id}/time-entries`),count=requests.length
    const scroll=await browser.evaluate('({page:scrollY,grid:document.querySelector(".calendar-time-grid").scrollTop})')
    await zoom(1);assert(await browser.evaluate(`document.querySelector('[aria-label="時間軸を縮小"]').disabled`))
    await browser.evaluate(`document.querySelector('[aria-label="時間軸を縮小"]').click()`);assert.equal(await level(),1)
    await zoom(5);assert(await browser.evaluate(`document.querySelector('[aria-label="時間軸を拡大"]').disabled`))
    await browser.evaluate(`document.querySelector('[aria-label="時間軸を拡大"]').click()`);assert.equal(await level(),5)
    assert.equal(requests.length,count);assert.deepEqual(await api('/schedule-blocks'),before);assert.deepEqual(await api(`/tasks/${task.id}/time-entries`),entries)
    assert.deepEqual(await browser.evaluate('({page:scrollY,grid:document.querySelector(".calendar-time-grid").scrollTop})'),scroll)
    assert.equal(await browser.evaluate('document.querySelector(".calendar-schedule-status [role=status]")===null'),true)
  })
  await t.test('Day and Week share the level, Month has neither line nor controls and its cells retain their geometry',async()=>{
    await zoom(4);await mode('week');assert.equal(await level(),4)
    await mode('month');assert.equal((await line()).length,0);assert.equal(await browser.evaluate('document.querySelector(".calendar-zoom-control")===null'),true)
    const height=await browser.evaluate('document.querySelector(".month-day").getBoundingClientRect().height')
    await mode('day');assert.equal(await level(),4);await zoom(2);await mode('month')
    assert.equal(await browser.evaluate('document.querySelector(".month-day").getBoundingClientRect().height'),height)
    await mode('week');assert.equal(await level(),2);await zoom(3)
  })
  await t.test('Start Pause Resume Stop never control the current-time line',async()=>{
    const before=await line()
    await selectTimerTask(browser, timerTask.id)
    await browser.click('.header-timer-control .timer-play-button');await browser.until('document.querySelector(".header-timer-control.timer-session")&&!document.querySelector(".timer-stop").disabled','Started')
    assert.deepEqual(await line(),before)
    await setClock('2026-10-04T03:35:10Z');await pauseOrResumeTimer(browser);await browser.until('document.querySelector(".header-timer-control.paused")&&!document.querySelector(".timer-play-button").disabled','Paused')
    assert.deepEqual(await line(),before)
    await pauseOrResumeTimer(browser);await browser.until('document.querySelector(".header-timer-control.timer-session:not(.paused)")&&!document.querySelector(".timer-stop").disabled','Resumed')
    await setClock('2026-10-04T03:35:20Z');await browser.click('.header-timer-control .timer-stop');await browser.until('!document.querySelector(".header-timer-control.timer-session")','Stopped');await ready()
    assert.deepEqual(await line(),before)
  })
  for(const current of [1,2,3,4,5]){
    const rate=hours[current-1]/60,date=dates[current-1]
    let createdTask,block,entry
    await t.test(`Level ${current}: plans Actual hour labels grid and current time share the same scale`,async()=>{
      await zoom(current)
      const values=await browser.evaluate(`(()=>{const p=document.querySelector('${planSelector(reference.id)}'),a=document.querySelector('${actualSelector(actual.id)}'),labels=document.querySelectorAll('.calendar-time-labels span'),column=p.closest('.calendar-day-column'),grid=document.querySelector('.calendar-time-grid');return{pt:parseFloat(p.style.top),ph:parseFloat(p.style.height),at:parseFloat(a.style.top),ah:parseFloat(a.style.height),hour:labels[11].getBoundingClientRect().top-labels[10].getBoundingClientRect().top,background:getComputedStyle(column).backgroundImage,column:column.getBoundingClientRect().height,viewport:grid.getBoundingClientRect().height,scroll:grid.scrollHeight}})()`)
      assert.equal(values.pt,600*rate);assert.equal(values.ph,120*rate);assert.equal(values.at,600*rate);assert.equal(values.ah,120*rate)
      assert.equal(values.hour,hours[current-1]);assert.equal(values.column,1440*rate);assert(values.viewport<=1296.1)
      assert(values.background.includes(`${hours[current-1]}px`),values.background)
      assert(!values.background.includes(`${hours[current-1]/2}px`),'Minor lines are not displayed')
      assert.equal((await line())[0].top,755*rate)
      assert.equal((await api('/schedule-blocks')).find(e=>e.id===reference.id).durationMinutes,120)
      assert.deepEqual((await api(`/tasks/${task.id}/time-entries`))[0],actual)
      await screenshot('zoom-'+current)
      await chooseDay('2026-10-02');assert.equal(await level(),current)
      const dayValues=await browser.evaluate(`(()=>{const p=document.querySelector('${planSelector(reference.id)}'),a=document.querySelector('${actualSelector(actual.id)}');return[parseFloat(p.style.top),parseFloat(p.style.height),parseFloat(a.style.top),parseFloat(a.style.height),document.querySelectorAll('.calendar-day-column').length]})()`)
      assert.deepEqual(dayValues,[600*rate,120*rate,600*rate,120*rate,1]);assert.equal((await line()).length,0)
      await mode('week')
    })
    await t.test(`Level ${current}: planned Drag Create previews and saves 10:00 to 11:30 with fifteen-minute snap`,async()=>{
      await chooseDay(date)
      const count=(await api('/schedule-blocks')).length,p=await selectRange(601,691,date)
      await browser.until('document.querySelector(".calendar-create-preview:not(.actual-create-preview)")','Plan preview')
      const preview=await browser.evaluate('(()=>{const e=document.querySelector(".calendar-create-preview:not(.actual-create-preview)");return[parseFloat(e.style.top),parseFloat(e.style.height)]})()')
      assert.deepEqual(preview,[600*rate,90*rate]);assert.equal((await api('/schedule-blocks')).length,count)
      await releaseRange(p,90);await browser.until('document.querySelector(".calendar-dialog[open]")','Create form')
      await input('title','Zoom plan '+current);await input('estimatedMinutes',720)
      await browser.click('.calendar-dialog button[type=submit]');await browser.until('!document.querySelector(".calendar-dialog")','Created');await ready()
      createdTask=(await api('/tasks')).find(e=>e.title==='Zoom plan '+current)
      block=(await api('/schedule-blocks')).find(e=>e.taskId===createdTask.id)
      assert.equal(block.date,date);assert.equal(block.startTime,'10:00:00');assert.equal(block.durationMinutes,90)
      await mode('week')
    })
    await t.test(`Level ${current}: Move and Drop preview resolve to 13:00 without changing duration or opening details`,async()=>{
      const target='[data-timed-drop-date="2026-10-02"]',p=await point(781,'2026-10-02')
      await browser.evaluate(`(()=>{const source=document.querySelector('${planSelector(block.id)}'),target=document.querySelector('${target}'),dataTransfer=new DataTransfer(),options={bubbles:true,cancelable:true,dataTransfer,clientX:${p.x},clientY:${p.y}};window.__zoomDrag={source,target,options};source.dispatchEvent(new DragEvent('dragstart',options));target.dispatchEvent(new DragEvent('dragover',options));})()`)
      await browser.until('document.querySelector(".calendar-timed-drop-preview")','Drop preview')
      assert.equal(await browser.evaluate('parseFloat(document.querySelector(".calendar-timed-drop-preview").style.top)'),780*rate)
      assert.equal((await api('/schedule-blocks')).find(e=>e.id===block.id).startTime,'10:00:00')
      await browser.evaluate("(()=>{const {source,target,options}=window.__zoomDrag;target.dispatchEvent(new DragEvent('drop',options));source.dispatchEvent(new DragEvent('dragend',options));source.dispatchEvent(new MouseEvent('click',{bubbles:true}));})()")
      await browser.until(`document.querySelector('${planSelector(block.id)}')?.dataset.date==='2026-10-02'&&document.querySelector('${planSelector(block.id)}')?.getAttribute('aria-busy')==='false'`,'Moved');await ready()
      block=(await api('/schedule-blocks')).find(e=>e.id===block.id);assert.equal(block.startTime,'13:00:00');assert.equal(block.durationMinutes,90)
      assert.equal(await browser.evaluate('document.querySelector(".calendar-popover")===null'),true)
    })
    await t.test(`Level ${current}: Resize adds thirty minutes and preserves Task overall estimate and Actual`,async()=>{
      const handle=`${planSelector(block.id)} .schedule-resize-handle`
      await browser.evaluate(`document.querySelector('${handle}').scrollIntoView({block:'center',inline:'center'})`);await sleep(40)
      const p=await browser.evaluate(`(()=>{const r=document.querySelector('${handle}').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`)
      await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',...p});await browser.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...p})
      await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x:p.x,y:p.y+30*rate})
      await browser.until('document.querySelector(".schedule-resize-preview")','Resize preview')
      assert.equal(await browser.evaluate(`parseFloat(document.querySelector('${planSelector(block.id)}').style.height)`),120*rate)
      await browser.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,x:p.x,y:p.y+30*rate})
      await browser.until(`document.querySelector('${planSelector(block.id)}')?.getAttribute('aria-busy')==='false'&&!document.querySelector('.schedule-resize-preview')`,'Resize saved');await ready()
      assert.equal((await api('/schedule-blocks')).find(e=>e.id===block.id).durationMinutes,120);assert.equal((await api(`/tasks/${createdTask.id}`)).estimatedMinutes,720)
      assert.deepEqual((await api(`/tasks/${task.id}/time-entries`))[0],actual);assert.equal(await browser.evaluate('document.querySelector(".calendar-popover")===null'),true)
    })
    await t.test(`Level ${current}: Actual Drag Create previews and saves the same local ninety-minute interval`,async()=>{
      await chooseDay(date)
      const p=await selectRange(601,691,date,true);await browser.until('document.querySelector(".actual-create-preview")','Actual preview')
      assert.deepEqual(await browser.evaluate('(()=>{const e=document.querySelector(".actual-create-preview");return[parseFloat(e.style.top),parseFloat(e.style.height)]})()'),[600*rate,90*rate])
      assert.equal((await api(`/tasks/${createdTask.id}/time-entries`)).length,0)
      await releaseRange(p,90);await browser.until('document.querySelector(".time-entry-dialog[open]")','Actual form')
      assert.equal(await browser.evaluate('document.querySelector(".time-entry-form [name=startedAt]").value'),date+'T10:00')
      assert.equal(await browser.evaluate('document.querySelector(".time-entry-form [name=endedAt]").value'),date+'T11:30')
      await input('taskId',createdTask.id,'.time-entry-dialog');await browser.click('.time-entry-dialog button[type=submit]');await browser.until('!document.querySelector(".time-entry-dialog")','Actual saved');await ready()
      entry=(await api(`/tasks/${createdTask.id}/time-entries`))[0];assert.equal(entry.durationMinutes,90);assert.equal((await api(`/tasks/${createdTask.id}`)).actualMinutes,90)
      await mode('week')
    })
    await t.test(`Level ${current}: Schedule and Closed Actual Popovers anchor to their current scaled Blocks`,async()=>{
      await sleep(320)
      for(const selector of [planSelector(block.id),actualSelector(entry.id)]){
        await browser.evaluate(`document.querySelector('${selector}').scrollIntoView({block:'center',inline:'center'})`);await browser.click(selector)
        await browser.until(near(selector),'Popover uses scaled source')
        assert.equal(await browser.evaluate('document.querySelector("dialog[open]")===null'),true)
        await screenshot('zoom-'+current+'-popover')
        await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
        await browser.until('!document.querySelector(".calendar-popover")','Esc closes')
      }
    })
  }
  for(const width of [1440,1024,768,375])await t.test(`${width}px preserves usable Zoom controls and contains horizontal Calendar scrolling`,async()=>{
    await size(width);await mode(width===375?'day':'week');await zoom(4)
    if(width===375){await browser.click('.today-button');await ready()}
    const bounds=await browser.evaluate('(()=>{const group=document.querySelector(".calendar-zoom-control"),r=group.getBoundingClientRect(),buttons=Array.from(group.querySelectorAll("button")).map(e=>{const b=e.getBoundingClientRect();return{width:b.width,height:b.height,left:b.left,right:b.right,top:b.top,bottom:b.bottom}});return{left:r.left,right:r.right,buttons,overflow:document.documentElement.scrollWidth>innerWidth}})()')
    assert(bounds.left>=0&&bounds.right<=width&&!bounds.overflow);assert(bounds.buttons.every(e=>e.width>=40&&e.height>=40));assert(bounds.buttons[0].right<=bounds.buttons[1].left)
    if(width===375){
      await browser.evaluate('document.querySelector(".calendar-zoom-control").scrollIntoView({block:"center"})')
      await browser.send('Emulation.setTouchEmulationEnabled',{enabled:true})
      const p=await browser.evaluate(`(()=>{const r=document.querySelector('[aria-label="時間軸を拡大"]').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`)
      await browser.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[p]});await browser.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await browser.until('document.querySelector(".calendar-zoom-control").dataset.zoomLevel==="5"','Touch zoom applied');assert.equal(await level(),5)
      await browser.send('Emulation.setTouchEmulationEnabled',{enabled:false})
      await browser.evaluate(`document.querySelector('${actualSelector(actual.id)}')?.click()`)
      // Today has Timer history, and its Active/Closed detail still uses a Sheet.
      const measured=await api(`/tasks/${timerTask.id}/time-entries`)
      await browser.click(actualSelector(measured[0].id));await browser.until('document.querySelector(".calendar-popover")','Mobile Actual Sheet')
      await browser.until('Math.abs(document.querySelector(".calendar-popover").getBoundingClientRect().bottom-innerHeight+8)<2','Sheet fits')
      await screenshot('zoom-responsive-'+width)
      await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await browser.until('!document.querySelector(".calendar-popover")','Sheet closed')
    }else await screenshot('zoom-responsive-'+width)
  })
  await t.test('midnight moves the local today marker; an old week has no line and Today selects the new date',async()=>{
    await mode('week');await tick('2026-10-04T15:01:00Z');await browser.until('!document.querySelector(".calendar-current-time")','Old week hides line after midnight')
    await mode('day');await browser.click('.today-button');await ready()
    const values=await line();assert.equal(values.length,1);assert.equal(values[0].date,'2026-10-05');assert.equal(values[0].minute,1);assert.equal(values[0].top,1.5)
  })
  assert.deepEqual(errors,[],'No runtime or forwarding errors')
})
