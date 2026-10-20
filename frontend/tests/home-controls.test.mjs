import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { openBrowser, pauseOrResumeTimer, selectTimerTask } from './browser.mjs'

test('Home Fix2 controls and blank creation use a guarded temporary DB', { timeout: 240000 }, async t => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const python = process.env.TIMER_TEST_PYTHON ?? path.join(root, 'backend', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  const directory = await mkdtemp(path.join(tmpdir(), 'task-timer-db-'))
  const day = '2026-10-05'
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
    window.confirm=()=>true;const D=Date;window.__zoomNow=${now};
    window.Date=class extends D{constructor(...a){super(...(a.length?a:[window.__zoomNow]));}static now(){return window.__zoomNow;}};
  })()` })

  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    window.__calendarTicks=new Map();const start=window.setInterval,stop=window.clearInterval;
    window.setInterval=(fn,delay,...args)=>{const id=start(fn,delay,...args);if(delay===60000)window.__calendarTicks.set(id,fn);return id;};
    window.clearInterval=id=>{window.__calendarTicks.delete(id);stop(id);};
  })()` })
  let holdQuickTask=false, releaseQuickTask, failStart=false, failTaskUpdate=false
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
      if(failTaskUpdate&&request.method==='PUT'&&url.pathname.startsWith('/tasks/')){await browser.fulfill(requestId,{detail:'Controlled Task update failure'},500);return}
      if(holdQuickTask&&request.method==='POST'&&url.pathname==='/tasks')await new Promise(resolve=>{releaseQuickTask=resolve})
      if(failStart&&request.method==='POST'&&url.pathname==='/tasks/time/start'){await browser.fulfill(requestId,{detail:'Controlled Start conflict'},409);return}
      const response=await fetch(`${base}${url.pathname}${url.search}`,{method:request.method,...(request.postData?{headers:{'Content-Type':'application/json'},body:request.postData}:{})})
      const body=await response.text()
      let data
      try { data=JSON.parse(body) }
      catch { throw new Error(`${request.method} ${url.pathname}${url.search}: ${response.status} ${body}\nTemporary Backend: ${log.slice(-6000)}`) }
      await browser.fulfill(requestId,data,response.status)
    })().catch(async error=>{
      if(/Invalid [Ii]nterception|Invalid requestId/.test(error.message))return
      errors.push(error.message)
      try{await browser.send('Fetch.failRequest',{requestId,errorReason:'ConnectionFailed'})}catch{/* Closing. */}
    }).finally(()=>{inFlight--})
  })
  await browser.send('Fetch.enable',{patterns:[{urlPattern:'http://localhost:8000/*',requestStage:'Request'}]})
  const project=await api('/projects',{name:'開発'})
  const otherProject=await api('/projects',{name:'学習'})
  const existing=await api('/tasks',{title:'講義を進める',projectId:otherProject.id,estimatedMinutes:720})
  const inbox=await api('/tasks',{title:'Monthへ配置するTask',projectId:project.id,estimatedMinutes:120})
  for(let i=0;i<8;i++)await api('/tasks',{title:`候補Task ${i+1}`,projectId:project.id})
  const unset=await api('/schedule-blocks',{taskId:existing.id,date:day,type:'TIME_UNSET'})
  const allDay=await api('/schedule-blocks',{taskId:existing.id,date:'2026-10-06',type:'ALL_DAY'})
  await api('/schedule-blocks',{taskId:existing.id,date:day,type:'TIMED',startTime:'09:00',durationMinutes:60})
  const monthAllDay=await api('/schedule-blocks',{taskId:existing.id,date:'2026-10-15',type:'ALL_DAY'})
  const monthTimed=await api('/schedule-blocks',{taskId:existing.id,date:'2026-10-16',type:'TIMED',startTime:'14:15',durationMinutes:75})
  async function ready(){
    await browser.until('document.querySelector(".calendar-schedule-status") && !document.querySelector(".calendar-schedule-status [role=status]") && !document.querySelector(".unplanned-panel [role=status]")','Calendar ready')
    for(let i=0;i<200;i++){if(!inFlight){await sleep(60);if(!inFlight)return}await sleep(20)}assert.fail('API reads did not settle')
  }
  async function shot(name){
    if(!process.env.HOME_FIX2_VISUAL_OUTPUT)return
    const folder=path.resolve(process.env.HOME_FIX2_VISUAL_OUTPUT),relative=path.relative(path.resolve(tmpdir()),folder)
    assert(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative))
    await browser.evaluate('window.scrollTo(0,0)')
    const result=await browser.send('Page.captureScreenshot',{format:'png',fromSurface:true})
    await writeFile(path.join(folder,name+'.png'),Buffer.from(result.data,'base64'))
  }
  const blocks=()=>api('/schedule-blocks')
  const tasks=()=>api('/tasks')
  const mode=async value=>{await browser.click(`.calendar-mode-switch[aria-label="カレンダー表示"] button:nth-child(${['day','week','month'].indexOf(value)+1})`);await ready()}
  async function input(selector,value){await browser.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),p=e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(String(value))});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`)}
  const search=value=>input('.timer-task-picker input',value)
  async function start(){await browser.click('.global-top-timer [aria-label="計測開始"]');await browser.until('document.querySelector(".global-top-timer.timer-session:not(.paused)") && !document.querySelector(".global-top-timer .timer-stop").disabled','Active');await ready()}
  async function stop(){await browser.click('.global-top-timer .timer-stop');await browser.until('!document.querySelector(".global-top-timer.timer-session") && !document.querySelector(".timer-play-button").disabled','Idle');await ready()}
  async function projectChoice(id){await browser.click('.timer-project-trigger');await browser.until('document.querySelector(".timer-project-popup")','Project Popup');await browser.click(`.timer-project-popup [data-project-id="${id??''}"]`)}
  async function drag(sourceSelector,targetSelector){
    await browser.evaluate(`(()=>{const source=document.querySelector(${JSON.stringify(sourceSelector)}),target=document.querySelector(${JSON.stringify(targetSelector)}),dataTransfer=new DataTransfer(),options={bubbles:true,cancelable:true,dataTransfer};source.dispatchEvent(new DragEvent('dragstart',options));target.dispatchEvent(new DragEvent('dragover',options));target.dispatchEvent(new DragEvent('drop',options));target.dispatchEvent(new DragEvent('drop',options));source.dispatchEvent(new DragEvent('dragend',options));source.dispatchEvent(new MouseEvent('click',{bubbles:true}));})()`)
    await ready();await sleep(320)
  }
  const monthCell=date=>`.month-day[data-date="${date}"]`
  const chip=id=>`[data-schedule-block-id="${id}"]`
  const todayHeaders=()=>browser.evaluate('[...document.querySelectorAll(".calendar-week-header:not(.calendar-lane-header) > button.today")].map(e=>e.querySelector("strong").textContent)')
  await browser.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false})
  await browser.navigate();await ready()
  await t.test('Idle shows a single placeholder, input then Project, Start enabled, and no Stop',async()=>{
    assert.equal(await browser.evaluate('document.querySelectorAll(".global-timer-prompt").length'),0)
    assert.equal(await browser.evaluate('document.querySelector(".timer-task-picker input").placeholder'),'何に取り組みますか？')
    assert.equal(await browser.evaluate('document.querySelector(".timer-task-picker input").value'),'')
    assert.equal(await browser.evaluate('document.querySelector(".global-top-timer .timer-stop")'),null)
    assert(await browser.evaluate('!document.querySelector(".timer-play-button").disabled'))
    assert(await browser.evaluate('document.querySelector(".timer-task-picker").getBoundingClientRect().right<=document.querySelector(".timer-context-actions").getBoundingClientRect().left'))
    await shot('01-idle-timer')
  })
  await t.test('Desktop has one labelled Navigation and Home panel below a full common Header',async()=>{
    await browser.send('Emulation.setDeviceMetricsOverride',{width:1920,height:1080,deviceScaleFactor:1,mobile:false})
    await browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    const geometry=await browser.evaluate(`(()=>{const r=s=>document.querySelector(s).getBoundingClientRect().toJSON();return{header:r('.app-header'),panel:r('.workspace-sidebar'),rail:r('.icon-rail'),labels:[...document.querySelectorAll('.nav-rail-label')].map(e=>e.textContent),duplicate:getComputedStyle(document.querySelector('.sidebar-subnav')).display,period:document.querySelector('.calendar-period-controls strong').textContent,right:document.body.getBoundingClientRect().right}})()`)
    assert.equal(geometry.rail.width,64);assert.equal(geometry.panel.width,192)
    assert.equal(geometry.header.left,64);assert.equal(geometry.header.height,80);assert(Math.abs(geometry.header.right-geometry.right)<1,JSON.stringify(geometry))
    assert(geometry.panel.top>=geometry.header.bottom)
    assert.deepEqual(geometry.labels,['ホーム','タスク一覧','プロジェクト','レポート']);assert.equal(geometry.duplicate,'none')
    assert.match(geometry.period,/^W41\s+10\/5 - 10\/11$/)
    const reference=await browser.evaluate(`(()=>{const e=document.querySelector('.global-top-timer'),r=e.getBoundingClientRect();window.__homeHeaderTimer=e;return{x:r.x,y:r.y,height:r.height,buttons:[...e.querySelectorAll('button')].map(b=>[b.offsetWidth,b.offsetHeight])}})()`)
    for(const label of ['タスク','プロジェクト','レポート','ホーム']){
      await browser.click(`.icon-rail [aria-label="${label}"]`)
      const next=await browser.evaluate(`(()=>{const e=document.querySelector('.global-top-timer'),r=e.getBoundingClientRect();return{x:r.x,y:r.y,height:r.height,buttons:[...e.querySelectorAll('button')].map(b=>[b.offsetWidth,b.offsetHeight])}})()`)
      assert.deepEqual(next,reference);assert(await browser.evaluate('window.__homeHeaderTimer===document.querySelector(".global-top-timer")'))
    }
    await ready()
    assert.deepEqual(await browser.evaluate('[...document.querySelectorAll(".home-workspace-nav button")].map(e=>e.textContent)'),['ホーム画面','プロジェクト一覧'])
    assert(await browser.evaluate('document.querySelector(".icon-rail") && !document.querySelector(".sidebar-project-list") && document.querySelector(".unplanned-list") && !document.querySelector(".today-tasks-panel")'))
    assert(await browser.evaluate('parseFloat(getComputedStyle(document.querySelector(".home-sidebar")).borderRightWidth)>0'))
    await shot('04-workspace-sidebar')
    await browser.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false})
  })
  await t.test('Sidebar sections are flat while individual Task Cards remain compact and bordered',async()=>{
    const result=await browser.evaluate('(()=>{const sections=[...document.querySelectorAll(".home-sidebar-section")];return{count:sections.length,flat:sections.every(e=>e.parentNode.matches(".home-sidebar")&&!e.classList.contains("panel")&&parseFloat(getComputedStyle(e).borderRadius)===0&&getComputedStyle(e).backgroundColor==="rgba(0, 0, 0, 0)"),cards:[...document.querySelectorAll(".inbox-task-card")].every(e=>parseFloat(getComputedStyle(e).borderWidth)>0&&e.getBoundingClientRect().height<=100),nav:document.querySelector(".home-workspace-nav").parentNode.matches(".home-sidebar")}})()')
    assert.equal(result.count,1);assert(result.flat&&result.cards&&result.nav,JSON.stringify(result))
    assert.equal(await browser.evaluate('document.querySelectorAll(".home-sidebar .panel").length'),0)
  })
  for(const value of ['week','day'])await t.test(`${value} Zoom belongs to the date-header gutter with a vertical separator and no weekly count`,async()=>{
    await mode(value)
    const result=await browser.evaluate('(()=>{const z=document.querySelector(".calendar-zoom-control"),c=document.querySelector(".calendar-date-separator"),zr=z.getBoundingClientRect(),cr=c.getBoundingClientRect(),first=document.querySelector(".calendar-week-header > button").getBoundingClientRect(),g=z.closest(".calendar-date-gutter");return{inGutter:g===document.querySelector(".calendar-week-header").firstElementChild,sameParent:z.parentNode===c.parentNode,left:zr.right<=cr.left&&Math.abs(cr.right-first.left)<=1,sameRow:Math.abs(zr.top+zr.height/2-cr.top-cr.height/2)<2,vertical:c.getAttribute("aria-orientation")==="vertical"&&cr.height>=24,noNavigation:!document.querySelector(".home-calendar-controls .calendar-zoom-control"),noCount:!document.querySelector(".calendar-plan-count")}})()')
    assert(result.inGutter&&result.sameParent&&result.left&&result.sameRow&&result.vertical&&result.noNavigation&&result.noCount,JSON.stringify(result))
  })
  await t.test('Zoom clamps five levels, changes height, and never changes Row expansion or writes DB',async()=>{
    const previous=await blocks(),expanded=await browser.evaluate('document.querySelector(".calendar-row-toggle").getAttribute("aria-expanded")')
    for(let i=0;i<5;i++){if(!await browser.evaluate('document.querySelector("[aria-label=時間軸を縮小]").disabled'))await browser.click('[aria-label="時間軸を縮小"]')}
    assert.equal(await browser.evaluate('document.querySelector(".calendar-zoom-control").dataset.zoomLevel'),'1')
    const low=await browser.evaluate('document.querySelector(".calendar-day-column").getBoundingClientRect().height')
    for(let i=0;i<4;i++)await browser.click('[aria-label="時間軸を拡大"]')
    assert.equal(await browser.evaluate('document.querySelector(".calendar-zoom-control").dataset.zoomLevel'),'5')
    assert(await browser.evaluate('document.querySelector("[aria-label=時間軸を拡大]").disabled'))
    assert(await browser.evaluate(`document.querySelector('.calendar-day-column').getBoundingClientRect().height>${low}`))
    assert.equal(await browser.evaluate('document.querySelector(".calendar-row-toggle").getAttribute("aria-expanded")'),expanded)
    assert.deepEqual(await blocks(),previous)
    await browser.click('[aria-label="時間軸を縮小"]');await browser.click('[aria-label="時間軸を縮小"]');await mode('week');await shot('05-zoom-position')
  })
  await t.test('Exactly one Chevron in the left gutter opens and closes the whole Row, independently of Zoom',async()=>{
    assert.equal(await browser.evaluate('document.querySelectorAll(".calendar-row-toggle").length'),1)
    assert.equal(await browser.evaluate('document.querySelectorAll(".calendar-date-toggle").length'),0)
    assert(await browser.evaluate('document.querySelector(".calendar-combined-row").firstElementChild.contains(document.querySelector(".calendar-row-toggle"))'))
    assert(await browser.evaluate(`document.querySelector('${chip(unset.id)}')!==null && document.querySelector('${chip(allDay.id)}')!==null`))
    const zoom=await browser.evaluate('document.querySelector(".calendar-zoom-control").dataset.zoomLevel')
    assert.equal(await browser.evaluate('document.querySelector(".calendar-row-toggle svg").dataset.icon'),'chevronDown');await shot('06-combined-open')
    await browser.click('.calendar-row-toggle')
    assert.equal(await browser.evaluate('document.querySelector(".calendar-row-toggle svg").dataset.icon'),'chevronRight')
    assert.equal(await browser.evaluate('document.querySelectorAll(".calendar-combined-row [data-schedule-block-id]").length'),0)
    assert.equal(await browser.evaluate('document.querySelector(".calendar-zoom-control").dataset.zoomLevel'),zoom)
    await shot('07-combined-closed');await browser.click('.calendar-row-toggle')
    assert.equal(await browser.evaluate('document.querySelectorAll(".calendar-combined-row [data-schedule-block-id]").length'),2)
    const visual=await browser.evaluate('(()=>{const t=getComputedStyle(document.querySelector(".calendar-row-toggle")),z=getComputedStyle(document.querySelector(".calendar-zoom-control button"));return t.borderRadius!==z.borderRadius||t.backgroundColor!==z.backgroundColor})()');assert(visual)
  })
  for(const [index,count] of [1,1,0,0,0,0,0].entries())await t.test(`Day ${index+1} counts only ALL_DAY and TIME_UNSET`,async()=>{
    const date=`2026-10-${String(5+index).padStart(2,'0')}`
    assert.equal(await browser.evaluate(`document.querySelector('[data-count-date="${date}"] dd').textContent`),`${count}件`)
  })
  await t.test('ALL_DAY and TIME_UNSET on the same day add to one count and exclude TIMED',async()=>{
    const extra=await api('/schedule-blocks',{taskId:existing.id,date:day,type:'ALL_DAY'})
    await browser.navigate(true);await ready()
    assert.equal(await browser.evaluate(`document.querySelector('[data-count-date="${day}"] dd').textContent`),'2件')
    const response=await fetch(`${base}/schedule-blocks/${extra.id}`,{method:'DELETE'});assert.equal(response.status,200)
    await browser.navigate(true);await ready()
  })
  await t.test('Collapsed and expanded rows retain all seven daily counts',async()=>{
    const counts=await browser.evaluate('[...document.querySelectorAll("[data-count-date] dd")].map(e=>e.textContent)')
    await browser.click('.calendar-row-toggle')
    assert.deepEqual(await browser.evaluate('[...document.querySelectorAll("[data-count-date] dd")].map(e=>e.textContent)'),counts)
    assert.equal(await browser.evaluate('document.querySelectorAll(".calendar-combined-row [data-schedule-block-id]").length'),0)
    await browser.click('.calendar-row-toggle')
    assert.deepEqual(await browser.evaluate('[...document.querySelectorAll("[data-count-date] dd")].map(e=>e.textContent)'),counts)
  })
  await t.test('Combined Chevron row follows the time Summary and retains every daily count',async()=>{
    const layout=await browser.evaluate('(()=>{const summary=document.querySelector(".calendar-week-metrics"),tasks=document.querySelector(".calendar-combined-row");return{ordered:summary.nextElementSibling===tasks,cells:tasks.querySelectorAll("[data-count-date]").length,noSummaryCounts:!summary.querySelector("[data-count-date]"),oneChevron:tasks.querySelectorAll(".calendar-row-toggle").length===1,noSeparateCountRow:!document.querySelector(".calendar-count-row")}})()')
    assert(layout.ordered&&layout.cells===7&&layout.noSummaryCounts&&layout.oneChevron&&layout.noSeparateCountRow,JSON.stringify(layout))
    await mode('day')
    assert.equal(await browser.evaluate('document.querySelectorAll(".calendar-combined-row [data-count-date]").length'),1)
    assert(await browser.evaluate('document.querySelector(".home-day-metrics").nextElementSibling.matches(".calendar-combined-row")'))
    await mode('week');await shot('fix4-count-row')
  })
  await t.test('Chevron is neutral normally and highlighted on real hover and keyboard focus',async()=>{
    await browser.evaluate('document.activeElement?.blur();document.querySelector(".calendar-row-toggle").scrollIntoView({block:"center"})')
    await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:5,y:5})
    await browser.until('getComputedStyle(document.querySelector(".calendar-row-toggle")).backgroundColor==="rgba(0, 0, 0, 0)"','Neutral Chevron')
    await shot('fix4-chevron-normal')
    const point=await browser.evaluate('(()=>{const r=document.querySelector(".calendar-row-toggle").getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()')
    await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',...point})
    await browser.until('getComputedStyle(document.querySelector(".calendar-row-toggle")).backgroundColor!=="rgba(0, 0, 0, 0)"','Hover Chevron highlight')
    await shot('fix4-chevron-hover')
    await browser.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1})
    try{
      assert(await browser.evaluate('(()=>{const b=document.querySelector(".calendar-row-toggle"),s=getComputedStyle(b);return b.matches(":active")&&s.backgroundColor!=="rgba(0, 0, 0, 0)"&&s.color!=="rgb(255, 255, 255)"})()'))
    }finally{
      await browser.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1})
    }
    await browser.click('.calendar-row-toggle')
    await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:5,y:5})
    await browser.evaluate('document.querySelector("[aria-label=時間軸を拡大]").focus()')
    for(let i=0;i<12&&!await browser.evaluate('document.activeElement?.matches(".calendar-row-toggle")');i++){
      await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9})
      await browser.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9})
    }
    assert(await browser.evaluate('document.activeElement?.matches(".calendar-row-toggle:focus-visible")'))
    assert(await browser.evaluate('getComputedStyle(document.activeElement).outlineStyle!=="none" && getComputedStyle(document.activeElement).backgroundColor!=="rgba(0, 0, 0, 0)"'))
    await shot('fix4-chevron-focus');await browser.evaluate('document.activeElement.blur()')
  })
  await t.test('Home metric labels are Planned and Recorded without Estimate or legacy labels',async()=>{
    assert.deepEqual(await browser.evaluate('[...document.querySelector(".home-metrics").querySelectorAll("dt")].map(e=>e.textContent)'),['計画済み','記録'])
    assert(await browser.evaluate('![...document.querySelectorAll(".home-metrics")].some(e=>/見積|実績|予定時間|予定種別/.test(e.textContent))'))
  })
  await t.test('Actual local Today alone is highlighted even when UTC date is the day before',async()=>{
    await setClock('2026-10-04T15:05:00Z');await browser.evaluate('for(const tick of window.__calendarTicks.values())tick()');await ready()
    assert.equal(await browser.evaluate('new Date(Date.now()).toISOString().slice(0,10)'),'2026-10-04')
    assert.deepEqual(await todayHeaders(),['5']);await shot('08-today-week')
  })
  await t.test('Previous week and next week have no same-weekday Today highlight; empty week retains gutter toggle',async()=>{
    await browser.click('[aria-label="前の期間"]');await ready();assert.deepEqual(await todayHeaders(),[])
    assert.equal(await browser.evaluate('document.querySelectorAll(".calendar-row-toggle").length'),1)
    assert.equal(await browser.evaluate('document.querySelectorAll(".calendar-combined-row [data-schedule-block-id]").length'),0)
    await browser.click('.calendar-row-toggle');await browser.click('.calendar-row-toggle')
    await browser.click('[aria-label="次の期間"]');await ready();await browser.click('[aria-label="次の期間"]');await ready()
    assert.deepEqual(await todayHeaders(),[]);await shot('09-next-week');await browser.click('.today-button');await ready()
    assert.deepEqual(await todayHeaders(),['5']);await setClock(`${day}T12:34:00+09:00`)
  })
  await t.test('Task suggestions include Project, show about five rows, and scroll inside the list',async()=>{
    await browser.click('.timer-task-picker input');await search('候補Task')
    const r=await browser.evaluate('(()=>{const e=document.querySelector(".timer-task-suggestions");return{count:e.querySelectorAll("[role=option]").length,height:e.getBoundingClientRect().height,overflow:getComputedStyle(e).overflowY,scroll:e.scrollHeight>e.clientHeight,project:[...e.querySelectorAll("small")].every(n=>n.textContent==="開発")}})()')
    assert.equal(r.count,8);assert(r.height<=240&&r.scroll&&r.overflow==='auto'&&r.project);await shot('03-task-suggestions');await search('')
    await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
  })
  let firstQuickTask
  await t.test('Project popup selection plus blank Start creates a fresh nullable-estimate Task and one Timer',async()=>{
    await projectChoice(project.id)
    const previous=await tasks(),postCount=requests.filter(r=>r.method==='POST'&&r.path==='/tasks').length
    holdQuickTask=true
    await browser.evaluate('document.querySelector(".timer-play-button").click();document.querySelector(".timer-play-button").click();document.querySelector(".timer-play-button").click()')
    for(let i=0;i<100&&!releaseQuickTask;i++)await sleep(20)
    assert(releaseQuickTask);assert.equal(requests.filter(r=>r.method==='POST'&&r.path==='/tasks').length,postCount+1)
    holdQuickTask=false;releaseQuickTask();releaseQuickTask=undefined
    await browser.until('document.querySelector(".timer-session") && !document.querySelector(".timer-stop").disabled','Blank Active');await ready()
    firstQuickTask=(await tasks()).find(task=>!previous.some(item=>item.id===task.id))
    assert.equal(firstQuickTask.title,'名称未設定');assert.equal(firstQuickTask.projectId,project.id);assert.equal(firstQuickTask.estimatedMinutes,null)
    assert.equal((await api('/tasks/time/active')).taskId,firstQuickTask.id)
    assert(!(await blocks()).some(block=>block.taskId===firstQuickTask.id))
    assert.equal((await api(`/tasks/${firstQuickTask.id}/time-entries`)).filter(e=>e.endedAt===null).length,1)
    assert.equal(await browser.evaluate('document.querySelector(".timer-stop [data-icon=stop]") !== null'),true)
    assert(await browser.evaluate('parseFloat(getComputedStyle(document.querySelector(".timer-elapsed")).fontSize)>=22'));await shot('02-active-timer')
  })
  await t.test('Active rename updates only Task title and keeps the same running TimeEntry',async()=>{
    const active=await api('/tasks/time/active'),entries=await api(`/tasks/${firstQuickTask.id}/time-entries`)
    const starts=requests.filter(r=>r.path==='/tasks/time/start').length,stops=requests.filter(r=>r.path==='/tasks/time/stop').length
    await input('.global-top-timer .task-title-input input','基本情報の勉強')
    await browser.evaluate('document.querySelector(".global-top-timer .task-title-input input").focus();document.querySelector(".global-top-timer .task-title-input input").blur()')
    await browser.until('document.querySelector(".timer-task-title").textContent==="基本情報の勉強"','Active renamed')
    assert.equal((await api(`/tasks/${firstQuickTask.id}`)).title,'基本情報の勉強')
    assert.deepEqual(await api('/tasks/time/active'),active);assert.deepEqual(await api(`/tasks/${firstQuickTask.id}/time-entries`),entries)
    assert.equal(requests.filter(r=>r.path==='/tasks/time/start').length,starts);assert.equal(requests.filter(r=>r.path==='/tasks/time/stop').length,stops)
    await shot('12-active-rename')
  })
  await t.test('Active Project change preserves the current historical Snapshot',async()=>{
    const entries=await api(`/tasks/${firstQuickTask.id}/time-entries`),active=await api('/tasks/time/active')
    await projectChoice(otherProject.id);await browser.until('document.querySelector(".timer-project-name")?.textContent==="学習"','Active Project updated')
    assert.equal((await api(`/tasks/${firstQuickTask.id}`)).projectId,otherProject.id)
    assert.deepEqual(await api(`/tasks/${firstQuickTask.id}/time-entries`),entries);assert.deepEqual(await api('/tasks/time/active'),active)
    assert.equal(entries[0].projectIdSnapshot,project.id)
  })
  await t.test('Active rename failure retains the draft and supports retry without stopping Timer',async()=>{
    const active=await api('/tasks/time/active');failTaskUpdate=true
    await input('.global-top-timer .task-title-input input','応用問題の勉強')
    await browser.evaluate('document.querySelector(".global-top-timer .task-title-input input").focus();document.querySelector(".global-top-timer .task-title-input input").blur()')
    await browser.until('document.querySelector(".global-top-timer .task-title-error")','Rename error')
    assert.equal((await api(`/tasks/${firstQuickTask.id}`)).title,'基本情報の勉強');assert.deepEqual(await api('/tasks/time/active'),active)
    failTaskUpdate=false
    await browser.evaluate('document.querySelector(".global-top-timer .task-title-input input").focus();document.querySelector(".global-top-timer .task-title-input input").blur()')
    await browser.until('document.querySelector(".timer-task-title").textContent==="応用問題の勉強"','Rename retry')
  })
  await t.test('Pause then Resume snapshots the latest Project and preserves the earlier segment',async()=>{
    await setClock(`${day}T12:34:20+09:00`);await pauseOrResumeTimer(browser)
    const entries=await api(`/tasks/${firstQuickTask.id}/time-entries`),first=entries.find(e=>e.endedAt!==null)
    await setClock(`${day}T12:34:30+09:00`);await pauseOrResumeTimer(browser)
    const resumed=await api(`/tasks/${firstQuickTask.id}/time-entries`)
    assert.deepEqual(resumed.find(e=>e.id===first.id),first)
    assert.equal(resumed.find(e=>e.endedAt===null).projectIdSnapshot,otherProject.id)
  })
  await t.test('Stop preserves history and clears input; the next blank Start never reuses old placeholder Tasks',async()=>{
    await setClock(`${day}T12:35:15+09:00`);await stop()
    assert.equal(await browser.evaluate('document.querySelector(".timer-task-picker input").value'),'')
    assert((await api(`/tasks/${firstQuickTask.id}/time-entries`)).every(e=>e.endedAt!==null))
    await start();assert.notEqual((await api('/tasks/time/active')).taskId,firstQuickTask.id);await stop()
  })
  await t.test('Selected existing Task uses its own Project without creating or changing a Task',async()=>{
    await projectChoice(project.id);await selectTimerTask(browser,existing.id)
    assert.equal(await browser.evaluate('document.querySelector(".timer-project-trigger").title'),otherProject.name)
    const count=(await tasks()).length;await start();assert.equal((await api('/tasks/time/active')).taskId,existing.id)
    assert.equal((await tasks()).length,count);assert.equal((await api(`/tasks/${existing.id}`)).projectId,otherProject.id)
  })
  await t.test('Details Pause and Resume show closed segments plus current elapsed without changing old entries',async()=>{
    await setClock(`${day}T12:36:15+09:00`);await browser.until('document.querySelector(".timer-elapsed").textContent==="0:01:00"','First minute')
    await pauseOrResumeTimer(browser);const closed=(await api(`/tasks/${existing.id}/time-entries`)).filter(e=>e.endedAt!==null)
    await setClock(`${day}T12:37:00+09:00`);await pauseOrResumeTimer(browser)
    await browser.until('document.querySelector(".timer-session:not(.paused)") && !document.querySelector(".timer-stop").disabled','Resume')
    assert.equal(await browser.evaluate('document.querySelector(".timer-elapsed").textContent'),'0:01:00')
    await setClock(`${day}T12:37:30+09:00`);await browser.until('document.querySelector(".timer-elapsed").textContent==="0:01:30"','Cumulative')
    await stop();for(const entry of closed)assert.deepEqual((await api(`/tasks/${existing.id}/time-entries`)).find(e=>e.id===entry.id),entry)
  })
  await t.test('Start failure retains the created Task for explicit retry and never assumes an Active exists',async()=>{
    failStart=true;const count=(await tasks()).length
    await browser.click('.timer-play-button');await browser.until('document.querySelector(".global-error[role=alert]") && !document.querySelector(".timer-play-button").disabled','Start rejected');await ready()
    assert.equal((await tasks()).length,count+1);assert.equal((await api('/tasks/time/active')).running,false)
    assert.equal(await browser.evaluate('document.querySelector(".timer-task-picker input").value'),'名称未設定')
    failStart=false;await start();assert.equal((await tasks()).length,count+1);await stop()
  })
  let clickTask
  await t.test('Calendar empty click accepts blank title and links a real placeholder Task ID',async()=>{
    const before=await tasks();await browser.click(`[data-timed-drop-date="${day}"]`)
    await browser.until('document.querySelector(".calendar-dialog [name=title]")','Create Dialog')
    assert.equal(await browser.evaluate('document.querySelector(".calendar-dialog [name=title]").required'),false)
    await browser.click('.calendar-dialog [type=submit]');await browser.until('!document.querySelector(".calendar-dialog")','Blank saved');await ready()
    clickTask=(await tasks()).find(task=>!before.some(item=>item.id===task.id));assert.equal(clickTask.title,'名称未設定');assert.equal(clickTask.estimatedMinutes,null)
    const block=(await blocks()).find(block=>block.taskId===clickTask.id);assert(block&&Number.isInteger(block.taskId)&&block.type==='TIMED')
  })
  await t.test('Calendar pointer Drag accepts blank title and keeps the selected duration',async()=>{
    const before=await tasks()
    const p=await browser.evaluate(`(async()=>{const e=document.querySelector('[data-timed-drop-date="${day}"]'),grid=e.closest('.calendar-time-grid');grid.scrollTop=Math.max(0,600*.9-grid.clientHeight/2);await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const b=e.getBoundingClientRect();return{x:b.left+b.width*.6,y:b.top+600*.9}})()`)
    await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',...p});await browser.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p})
    await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',buttons:1,x:p.x,y:p.y+45*.9});await browser.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x:p.x,y:p.y+45*.9})
    await browser.until('document.querySelector(".calendar-dialog [name=title]")','Drag Create')
    assert.equal(await browser.evaluate('document.querySelector(".calendar-dialog [name=durationMinutes]").value'),'45m')
    await browser.click('.calendar-dialog [type=submit]');await browser.until('!document.querySelector(".calendar-dialog")','Blank Drag saved');await ready()
    const task=(await tasks()).find(task=>!before.some(item=>item.id===task.id)),block=(await blocks()).find(b=>b.taskId===task.id)
    assert.equal(task.title,'名称未設定');assert.equal(block.durationMinutes,45);assert.equal(block.startTime,'10:00:00');assert.notEqual(task.id,clickTask.id)
  })
  await t.test('Placeholder Task can be renamed through the same standard Editor Panel',async()=>{
    await browser.click('.icon-rail [aria-label="タスク"]');await browser.until(`document.querySelector('[data-task-id="${clickTask.id}"] .task-row-edit')`,'Tasks loaded')
    await browser.click(`[data-task-id="${clickTask.id}"] .task-row-edit`)
    await browser.until('document.querySelector(".task-editor-panel")','Normal Editor');await input('.task-form [name=title]','後から名前を決めたTask')
    await browser.click('.task-composer .composer-footer [type=submit]');await browser.until('!document.querySelector(".task-editor-panel")','Renamed')
    assert.equal((await api(`/tasks/${clickTask.id}`)).title,'後から名前を決めたTask');await browser.click('.icon-rail [aria-label="ホーム"]');await ready()
  })
  let monthUnset
  await t.test('Inbox to Month creates TIME_UNSET without duration and Month hides Zoom',async()=>{
    await mode('month');assert.equal(await browser.evaluate('document.querySelector(".calendar-zoom-control")'),null)
    await drag(`[data-inbox-task-id="${inbox.id}"]`,monthCell('2026-10-15'))
    monthUnset=(await blocks()).find(b=>b.taskId===inbox.id);assert.equal(monthUnset.type,'TIME_UNSET');assert.equal(monthUnset.startTime,null);assert.equal(monthUnset.durationMinutes,null)
    assert.equal((await api(`/tasks/${inbox.id}`)).estimatedMinutes,120);await shot('10-month-before-move')
  })
  for(const [name,getBlock,to] of [['TIME_UNSET',()=>monthUnset,'2026-10-18'],['ALL_DAY',()=>monthAllDay,'2026-10-18'],['TIMED',()=>monthTimed,'2026-10-19']])await t.test(`Month ${name} moves existing ID once, preserves type and time fields, and removes old date`,async()=>{
    const before=await blocks(),block=getBlock();await drag(chip(block.id),monthCell(to))
    const after=await blocks(),updated=after.find(b=>b.id===block.id)
    assert.equal(after.length,before.length);assert.equal(updated.date,to);assert.equal(updated.type,block.type);assert.equal(updated.startTime,block.startTime);assert.equal(updated.durationMinutes,block.durationMinutes)
    assert.equal(after.filter(b=>b.id===block.id).length,1)
    assert(await browser.evaluate(`document.querySelector('${monthCell(to)} ${chip(block.id)}')!==null && !document.querySelector('${monthCell(block.date)} ${chip(block.id)}')`))
    assert(await browser.evaluate('!document.querySelector(".calendar-dialog")'))
  })
  await t.test('Month move screenshots show old dates cleared and destination populated',async()=>{await shot('11-month-after-move')})
  for(const value of ['week','day'])await t.test(`Month moved untimed Blocks appear on new date in ${value} only and contribute zero planned minutes`,async()=>{
    if(value==='week'){await browser.click(monthCell('2026-10-18'));await browser.until('document.querySelector(".calendar-dialog")','Choose destination');await browser.click('.calendar-dialog [aria-label="予定の操作を閉じる"]')}
    await mode(value)
    for(const block of [monthUnset,monthAllDay])assert(await browser.evaluate(`document.querySelector('.calendar-combined-row [data-drop-date="2026-10-18"] ${chip(block.id)}')!==null`))
    assert.equal(await browser.evaluate(`document.querySelector('[data-metric-date="2026-10-18"] dd').textContent`),'0分')
    assert(await browser.evaluate(`!document.querySelector('[data-drop-date="2026-10-15"] ${chip(monthUnset.id)}')`))
  })
  await t.test('All four viewports keep the Timer and independent controls inside the page',async()=>{
    for(const width of [1440,1024,768,375]){
      await browser.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false})
      assert(await browser.evaluate('document.documentElement.scrollWidth<=innerWidth'),String(width))
      const result=await browser.evaluate('(()=>{const t=document.querySelector(".global-top-timer").getBoundingClientRect(),z=document.querySelector(".calendar-zoom-control").getBoundingClientRect();return{timer:t.left>=0&&t.right<=innerWidth,zoom:z.left>=0&&z.right<=innerWidth}})()');assert(result.timer&&result.zoom,JSON.stringify({width,result}))
      await shot('responsive-'+width)
    }
  })
  await t.test('Week labels follow ISO year boundaries without changing period navigation',async()=>{
    await browser.send('Emulation.setDeviceMetricsOverride',{width:1920,height:1080,deviceScaleFactor:1,mobile:false})
    await mode('week')
    for(const [date,week] of [['2021-01-01','W53'],['2024-12-30','W1']]){
      await setClock(`${date}T12:00:00+09:00`)
      await browser.evaluate('window.__calendarTicks.forEach(fn=>fn())')
      await browser.click('.today-button');await ready()
      assert(await browser.evaluate(`document.querySelector('.calendar-period-controls strong').textContent.startsWith('${week} ')`))
    }
  })
  assert.deepEqual(errors,[],'No runtime or forwarding errors')
})
