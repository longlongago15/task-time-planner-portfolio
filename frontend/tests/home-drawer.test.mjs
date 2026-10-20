import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { selectProject, selectPriority, openBrowser, pauseOrResumeTimer } from './browser.mjs'

test('Home Cards and Task Drawer use a guarded temporary DB', { timeout: 240000 }, async t => {
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
    window.confirm=()=>true;const D=Date;window.__zoomNow=${now};
    window.Date=class extends D{constructor(...a){super(...(a.length?a:[window.__zoomNow]));}static now(){return window.__zoomNow;}};
  })()` })

  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    window.__calendarTicks=new Map();const start=window.setInterval,stop=window.clearInterval;
    window.setInterval=(fn,delay,...args)=>{const id=start(fn,delay,...args);if(delay===60000)window.__calendarTicks.set(id,fn);return id;};
    window.clearInterval=id=>{window.__calendarTicks.delete(id);stop(id);};
  })()` })
  let failDetail=false,failQuickTask=false
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
      if(failQuickTask&&request.method==='PUT'&&url.pathname.startsWith('/tasks/')){await browser.fulfill(requestId,{detail:'Controlled Quick Edit failure'},500);return}
      if(failDetail&&request.method==='GET'&&url.pathname===`/tasks/${card.id}`){await browser.fulfill(requestId,{detail:'Controlled detail failure'},500);return}
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
  const learning=await api('/projects',{name:'IT学習'})
  const card=await api('/tasks',{title:'Figma応用',projectId:project.id,estimatedMinutes:210})
  await api('/time-entries',{taskId:card.id,startedAt:'2026-09-25T00:00:30.123Z',endedAt:'2026-09-25T03:46:30.123Z'})
  const peer=await api('/tasks',{title:'別の未配置Task',estimatedMinutes:null})
  const lecture=await api('/tasks',{title:'講義を見る',projectId:learning.id,estimatedMinutes:720})
  for(const [date,end] of [['2026-10-01','02:30'],['2026-10-02','03:20'],['2026-10-03','01:40']])await api('/time-entries',{taskId:lecture.id,startedAt:`${date}T00:00:00Z`,endedAt:`${date}T${end}:00Z`})
  const lectureBlocks=[]
  for(const [date,durationMinutes] of [[day,180],['2026-10-05',120],['2026-10-06',60]])lectureBlocks.push(await api('/schedule-blocks',{taskId:lecture.id,date,type:'TIMED',startTime:'09:00',durationMinutes}))
  lectureBlocks.push(await api('/schedule-blocks',{taskId:lecture.id,date:'2026-10-07',type:'TIME_UNSET'}))
  lectureBlocks.push(await api('/schedule-blocks',{taskId:lecture.id,date:'2026-10-08',type:'ALL_DAY'}))
  const longTask=await api('/tasks',{title:'日跨ぎの長い予定',estimatedMinutes:null})
  await api('/schedule-blocks',{taskId:longTask.id,date:'2026-10-09',type:'TIMED',startTime:'23:30',durationMinutes:1800})
  const size=width=>browser.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false})
  async function settle(){for(let i=0;i<200;i++){if(!inFlight){await sleep(70);if(!inFlight)return}await sleep(20)}assert.fail('API reads did not settle')}
  const input=async(name,value)=>name==='projectId'?selectProject(browser,'.task-form [name=projectId]',value):browser.evaluate(`(()=>{const e=document.querySelector('.task-form [name="${name}"]');const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(String(value))});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`)
  const drawer=async()=>{
    await browser.until('document.querySelector(".task-drawer[open]")','Drawer open');await settle()
    // Network completion can precede React's Summary commit. Error cases stay
    // testable; only the transient placeholder is excluded from ready-state assertions.
    await browser.until(`(()=>{const d=document.querySelector('.task-drawer[open]');return d&&(d.querySelector('.task-time-section [role=alert]')||![...d.querySelectorAll('.task-time-totals strong')].some(e=>e.textContent==='\u8aad\u8fbc\u4e2d'))})()`,'Drawer Summary ready or error')
  }
  const close=async()=>{await browser.click('.task-drawer .icon-close');await browser.until('!document.querySelector(".task-drawer")','Drawer closed')}
  async function go(page){
    const mobile=await browser.evaluate('getComputedStyle(document.querySelector(".mobile-nav")).display!=="none"')
    const index={home:1,tasks:2,projects:3,reports:4}[page],labels={home:'ホーム',tasks:'タスク',projects:'プロジェクト',reports:'レポート'}
    await browser.click(mobile?`.mobile-nav button:nth-child(${index})`:`.icon-rail [aria-label="${labels[page]}"]`);await settle()
  }
  const openCard=async(id=card.id)=>{await browser.until(`(()=>{const e=document.querySelector('[data-inbox-task-id="${id}"] .inbox-card-open');if(!e||e.disabled)return false;e.focus();e.click();return true})()`,'Card available');await drawer()}
  const cardAction=async(id,selector)=>browser.until(`(()=>{const e=document.querySelector('[data-inbox-task-id="${id}"] ${selector}');if(!e||e.disabled)return false;e.click();return true})()`,'Card action available')
  const create=async()=>{await browser.click('.unplanned-panel .home-add-trigger');await drawer()}
  async function save(){await browser.click('.task-drawer .composer-footer [type=submit]');await browser.until('!document.querySelector(".task-drawer")','Saved');await settle()}
  async function shot(name){if(!process.env.HOME_DRAWER_VISUAL_OUTPUT)return;const folder=path.resolve(process.env.HOME_DRAWER_VISUAL_OUTPUT),relative=path.relative(path.resolve(tmpdir()),folder);assert(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));const result=await browser.send('Page.captureScreenshot',{format:'png',fromSurface:true});await writeFile(path.join(folder,name+'.png'),Buffer.from(result.data,'base64'))}
  async function drag(sourceSelector,targetSelector){
    await browser.until(`(()=>{const source=document.querySelector(${JSON.stringify(sourceSelector)}),target=document.querySelector(${JSON.stringify(targetSelector)});if(!source||!target)return false;const dataTransfer=new DataTransfer(),o={bubbles:true,cancelable:true,dataTransfer};source.dispatchEvent(new DragEvent('dragstart',o));target.dispatchEvent(new DragEvent('dragover',o));target.dispatchEvent(new DragEvent('drop',o));source.dispatchEvent(new DragEvent('dragend',o));source.querySelector('.inbox-card-open')?.click();return true})()`,'Drag source and target ready');await settle()
  }
  async function alignment(){
    const result=await browser.evaluate(`(()=>{const rows=['.calendar-week-header:not(.calendar-lane-header) > button','.calendar-week-metrics > div','.calendar-combined-row > .calendar-schedule-cell','.calendar-day-column'].map(selector=>Array.from(document.querySelectorAll(selector)).map(e=>{const r=e.getBoundingClientRect();return{left:r.left,right:r.right}}));const timeline=document.querySelector('.calendar-time-grid'),zero=document.querySelector('.calendar-time-labels span'),t=timeline.getBoundingClientRect(),z=zero.getBoundingClientRect();return{rows,zero:{top:z.top,bottom:z.bottom,left:z.left,right:z.right},timeline:{top:t.top,bottom:t.bottom,left:t.left,right:t.right},overflow:document.documentElement.scrollWidth>innerWidth}})()`)
    assert.equal(result.overflow,false)
    for(const row of result.rows){assert.equal(row.length,7);for(let i=0;i<7;i++){assert(Math.abs(row[i].left-result.rows.at(-1)[i].left)<=1,JSON.stringify(result));assert(Math.abs(row[i].right-result.rows.at(-1)[i].right)<=1,JSON.stringify(result))}}
    assert(result.zero.top>=result.timeline.top&&result.zero.bottom<=result.timeline.bottom,JSON.stringify(result))
    return result
  }
  await size(1440);await browser.navigate();await browser.until(`document.querySelector('[data-inbox-task-id="${card.id}"]')`,'Seeded Home');await settle()
  await t.test('Home gives the narrow Workspace Sidebar and remaining width to Calendar beside one Top Timer',async()=>{
    const r=await browser.evaluate(`(()=>{const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width}};return{rail:rect('.icon-rail'),sidebar:rect('.home-sidebar'),calendar:rect('.calendar-page'),timer:rect('.global-top-timer'),controls:rect('.home-calendar-header'),rightSidebar:!!document.querySelector('.calendar-sidebar'),timerCount:document.querySelectorAll('.global-top-timer').length}})()`)
    assert.equal(r.rail.width,64);assert(r.sidebar.width===192);assert(r.calendar.width>900);assert(r.timer.bottom<=r.controls.top);assert(r.timer.left>=r.rail.right);assert(!r.rightSidebar&&r.timerCount===1)
    await alignment();await shot('home-1440')
  })
  await t.test('Inbox Card shows Task Project recorded time and overall estimate with no invented date or Tag',async()=>{
    // Initial/focus refresh can temporarily replace the Inbox after network settlement.
    // Read a complete enabled Card atomically; keep the original content assertions below.
    await browser.until(`(()=>{const e=document.querySelector('[data-inbox-task-id="${card.id}"]');if(!e?.querySelector('.inbox-card-times b')||!e.querySelector('.inbox-card-open')||e.querySelector('.inbox-card-open').disabled)return false;window.__readyInboxText=e.textContent;return true})()`,'Complete enabled Inbox Card')
    const text=await browser.evaluate('window.__readyInboxText')
    for(const value of ['Figma応用','開発','3h 46m / 3h 30m'])assert(text.includes(value),text)
    assert(!/Tag|期限|Oct|09\/25/.test(text))
  })
  await t.test('Inbox stacks compact Status title Project and time rows with one Tag icon at most',async()=>{
    const tags=[await api('/tags',{name:'Card tag A'}),await api('/tags',{name:'Card tag B'})],fixtures=[]
    try {
      for(const count of [0,1,2])fixtures.push(await api('/tasks',{title:'Card layout '+count,projectId:learning.id,tagIds:tags.slice(0,count).map(tag=>tag.id)}))
      await browser.navigate(true);await settle()
      for(const fixture of fixtures){
        const selector=`[data-inbox-task-id="${fixture.id}"]`
        await browser.until(`document.querySelector('${selector} .inbox-card-times')`,'Card rows rendered')
        const result=await browser.evaluate(`(()=>{const card=document.querySelector('${selector}'),open=card.querySelector('.inbox-card-open'),rows=[...open.children],rects=rows.map(e=>e.getBoundingClientRect()),name=card.querySelector('.inbox-card-title strong'),project=card.querySelector('.task-project-name'),tag=card.querySelector('[data-icon=tag]');return {classes:rows.map(e=>e.className),ordered:rects.every((r,i)=>!i||r.top>=rects[i-1].bottom),height:card.getBoundingClientRect().height,titleFits:name.scrollWidth<=name.clientWidth,tagCount:card.querySelectorAll('[data-icon=tag]').length,chips:card.querySelectorAll('.tag-chip,.tag-chips').length,adjacent:!tag||tag.getBoundingClientRect().left-project.getBoundingClientRect().right<=8,time:card.querySelector('.inbox-card-times').textContent.trim(),font:parseFloat(getComputedStyle(card.querySelector('.inbox-card-times b')).fontSize)}})()`)
        assert.deepEqual(result.classes,['task-status-control','inbox-card-title','task-project-tags','inbox-card-times']);assert(result.ordered);assert(result.height<=88);assert(result.titleFits)
        assert.equal(result.tagCount,fixture.tags.length?1:0);assert.equal(result.chips,0);assert(result.adjacent);assert.equal(result.time,'0m / 未設定');assert(result.font>=12)
      }
    } finally {
      for(const fixture of fixtures)await api(`/tasks/${fixture.id}`,{},'DELETE')
      for(const tag of tags)await api(`/tags/${tag.id}`,{},'DELETE')
      await browser.navigate(true);await settle()
      await browser.until(`document.querySelector('[data-inbox-task-id="${card.id}"] .inbox-card-open')`,'Original Card restored after fixture cleanup')
    }
  })
  await t.test('Status Chip stays visible without Checkbox; hover and keyboard focus expose Timer',async()=>{
    const selector=`[data-inbox-task-id="${card.id}"]`
    let point=null
    while(!point){
      await browser.until(`(()=>{const e=document.querySelector('${selector}');if(!e)return false;e.scrollIntoView({block:'center'});return true})()`,'Card restored before Hover')
      point=await browser.evaluate(`(()=>{const e=document.querySelector('${selector}');if(!e)return null;const r=e.getBoundingClientRect();return{x:r.left+12,y:r.top+12}})()`)
    }
    await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',...point})
    await browser.until(`document.querySelector('${selector}').matches(':hover') && getComputedStyle(document.querySelector('${selector} .inbox-card-actions')).opacity==='1'`, 'Hovered Card actions rendered')
    assert.equal(await browser.evaluate(`getComputedStyle(document.querySelector('${selector} .inbox-card-actions')).opacity`),'1')
    assert(await browser.evaluate(`(()=>{const card=document.querySelector('${selector}').getBoundingClientRect(),timer=document.querySelector('${selector} .inbox-card-actions').getBoundingClientRect();return timer.top-card.top<=8&&card.right-timer.right<=12})()`),'Timer stays at the top right')
    await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:1,y:1})
    await browser.evaluate('document.activeElement.blur(); undefined')
    await browser.until(`getComputedStyle(document.querySelector('${selector} .inbox-card-actions')).opacity==='0'`,'Hover leave rendered')
    const initial=await browser.evaluate(`(()=>{const card=document.querySelector('${selector}'),c=card.querySelector('.task-status-chip'),a=card.querySelector('.inbox-card-actions');return{checkbox:!!card.querySelector('input[type=checkbox]'),visible:getComputedStyle(c).opacity,status:c.textContent,actions:getComputedStyle(a).opacity}})()`)
    assert.equal((await api(`/tasks/${card.id}`)).status,'IN_PROGRESS')
    assert.equal(await browser.evaluate(`document.querySelector('${selector} .task-status-control').dataset.taskStatus`),'IN_PROGRESS')
    assert.equal(initial.checkbox,false);assert.equal(initial.visible,'1');assert.equal(initial.status,'進行中');assert.equal(initial.actions,'0')
    await browser.evaluate(`document.querySelector('${selector} .inbox-card-open').focus()`); await browser.until(`getComputedStyle(document.querySelector('${selector} .inbox-card-actions')).opacity==='1'`, 'Focused Card actions rendered')
    assert.equal(await browser.evaluate(`document.querySelectorAll('${selector} .inbox-card-actions button').length`),1)
    assert(await browser.evaluate(`Array.from(document.querySelectorAll('${selector} .inbox-card-actions button')).every(e=>e.getAttribute('aria-label')&&e.getBoundingClientRect().width>=32&&e.getBoundingClientRect().height>=32)`))
    const dragBlocked=await browser.evaluate(`(()=>{const card=document.querySelector('${selector}');return ['.inbox-card-start'].every(s=>{const e=new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:new DataTransfer()});card.querySelector(s).dispatchEvent(e);return e.defaultPrevented&&!card.classList.contains('inbox-task-dragging')})})()`)
    assert(dragBlocked)
  })
  await t.test('Card directly opens common Editor without creating Schedule; Escape and outside close restore Card focus',async()=>{
    const blocks=await api('/schedule-blocks'),writes=requests.filter(r=>r.method!=='GET').length
    for(const method of ['escape','outside']){
      await openCard()
      assert.equal(await browser.evaluate('document.querySelector("#task-detail")'),null)
      assert.equal(await browser.evaluate('document.querySelector(".task-form [name=title]").value'),card.title)
      assert.equal(await browser.evaluate('document.querySelector(".task-form [name=date]").value'),'')
      assert.equal(await browser.evaluate('document.querySelector(".task-form [name=startTime]").value'),'')
      if(method==='escape')await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
      else await close()
      await browser.until('!document.querySelector(".task-editor-panel")','Editor closed')
      await browser.until(`document.activeElement.closest('[data-inbox-task-id]')?.dataset.inboxTaskId==='${card.id}'`,'Card focus restored')
    }
    assert.equal(requests.filter(r=>r.method!=='GET').length,writes);assert.deepEqual(await api('/schedule-blocks'),blocks)
  })
  await t.test('Editor separates neutral Project label from colored value and uses unified controls',async()=>{
    await openCard()
    assert(await browser.evaluate('!!document.querySelector(".task-status-field .task-status-trigger .shared-pill") && !document.querySelector(".task-name-label select[name=status]")'))
    assert.equal(await browser.evaluate('document.querySelectorAll(".task-form > label:has([name=status])").length'),0)
    const icons=()=>browser.evaluate('[...document.querySelectorAll(".task-project-field [data-icon=folder]")].map(e=>getComputedStyle(e).color)')
    const original=await icons();assert.equal(original.length,2);assert.notEqual(original[0],original[1])
    assert.equal(await browser.evaluate('getComputedStyle(document.querySelector(".task-project-field .project-picker-trigger > span")).color'),original[1])
    await input('projectId',learning.id);const changed=await icons();assert.equal(changed[0],original[0]);assert.notEqual(changed[1],original[1])
    assert.equal(await browser.evaluate('getComputedStyle(document.querySelector(".task-project-field .project-picker-trigger > span")).color'),changed[1])
    assert.equal(await browser.evaluate('document.querySelector(".task-priority-field .task-priority-pill [data-icon=chevronDown]")!==null'),false)
    assert(await browser.evaluate('!!document.querySelector(".task-status-trigger .shared-pill .ui-icon")'))
    const controls=await browser.evaluate(`['[name=deadline]','[name=estimatedMinutes]','[name=date]','[name=startTime]'].map(s=>{const e=document.querySelector('.task-editor-panel '+s),c=getComputedStyle(e);return {height:e.getBoundingClientRect().height,border:c.borderTopWidth,radius:c.borderRadius,full:e.getBoundingClientRect().width+(e.closest('.deadline-input-controls')?48:0)>=e.closest('.task-attribute-control').clientWidth-1}})`)
    assert(controls.every(c=>c.height===40&&c.border==='2px'&&c.radius==='8px'&&c.full),JSON.stringify(controls))
    assert(await browser.evaluate(`(()=>{const e=document.querySelector('.task-project-field .project-picker-trigger');return e.getBoundingClientRect().height===40&&e.getBoundingClientRect().width===e.closest('.task-attribute-control').getBoundingClientRect().width&&getComputedStyle(e).backgroundColor==='rgba(0, 0, 0, 0)'&&!e.querySelector('[data-icon=chevronDown]')})()`))
    for(const status of ['IN_PROGRESS','COMPLETED','NOT_STARTED']){await browser.click('.task-status-field .task-status-trigger');await browser.click(`.task-status-field [data-value="${status}"]`);assert(await browser.evaluate(`!!document.querySelector('.task-status-field .shared-pill.status-${status.toLowerCase()}')`))}
    await close()
  })
  await t.test('Editor shared Priority Pills keep semantic colors without a dropdown chevron',async()=>{
    await openCard()
    try {
      for(const theme of ['light','dark']){
        await browser.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`)
        for(const value of ['HIGH','MEDIUM','LOW','']){
          await selectPriority(browser,'.task-priority-field',value)
          const result=await browser.evaluate(`(()=>{const button=document.querySelector('.task-priority-field .task-priority-pill'),label=button.querySelector('span'),reference=document.createElement('span');reference.style.color='var(${value ? '--priority-'+value.toLowerCase()+'-text' : '--text-secondary'})';document.body.append(reference);const expected=getComputedStyle(reference).color;reference.remove();return {color:getComputedStyle(label).color,expected,background:getComputedStyle(button).backgroundColor,referenceBackground:getComputedStyle(document.querySelector('.task-project-field .project-picker-trigger')).backgroundColor,height:button.getBoundingClientRect().height,pillWidth:label.getBoundingClientRect().width,pillHeight:label.getBoundingClientRect().height,dropdown:!!button.querySelector('[data-icon=chevronDown]')}})()`)
          assert.equal(result.color,result.expected);assert.equal(result.background,'rgba(0, 0, 0, 0)');assert.equal(result.height,40);assert.equal(result.pillWidth,80);assert.equal(result.pillHeight,32);assert.equal(result.dropdown,false)
          assert.equal(await browser.evaluate('document.querySelector(".task-priority-field [name=priority]").value'),value)
        }
      }
    } finally { await browser.evaluate('delete document.documentElement.dataset.theme');await close() }
  })
  await t.test('Editor and Quick Detail use one secondary color for every unset value',async()=>{
    const check=async fields=>{
      const result=await browser.evaluate(`(()=>{const reference=document.createElement('span');reference.style.color='var(--text-secondary)';document.body.append(reference);const expected=getComputedStyle(reference).color;reference.remove();return {expected,colors:${JSON.stringify(fields)}.map(([selector,pseudo])=>{const e=document.querySelector(selector);if(!e)throw new Error('Missing unset field '+selector);return getComputedStyle(e,pseudo||null).color})}})()`)
      assert(result.colors.every(color=>color===result.expected),JSON.stringify(result))
    }
    await create()
    try {
      for(const theme of ['light','dark']){
        await browser.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`)
        await check([
          ['.task-editor-panel .project-picker-trigger > span'],['.task-editor-panel .tag-empty'],['.task-editor-panel .task-priority-pill > span'],
          ['.task-editor-panel [name=deadline]','::placeholder'],['.task-editor-panel [name=estimatedMinutes]','::placeholder'],['.task-editor-panel [name=startTime]'],
          ['.task-editor-panel .task-time-summary .unset-value'],
        ])
      }
    } finally {await browser.evaluate('delete document.documentElement.dataset.theme');await close()}
    const task=await api('/tasks',{title:'Unset color Task'}),block=await api('/schedule-blocks',{taskId:task.id,date:day,type:'TIME_UNSET'})
    try {
      await browser.navigate(true);await settle()
      await browser.until(`document.querySelector('[data-schedule-block-id="${block.id}"]')`,'Unset schedule rendered')
      await browser.click(`[data-schedule-block-id="${block.id}"]`)
      await browser.until('document.querySelector(".task-detail .task-time-summary .unset-value")','Unset summary ready')
      for(const theme of ['light','dark']){
        await browser.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`)
        await check([
          ['.task-detail .project-picker-trigger > span'],['.task-detail .tag-empty'],
          ['.task-detail [data-schedule-field=startTime]'],['.task-detail [data-schedule-field=durationMinutes]'],['.task-detail .task-time-summary .unset-value'],
        ])
      }
    } finally {
      await browser.evaluate('delete document.documentElement.dataset.theme')
      if(await browser.evaluate('!!document.querySelector(".task-detail-close")'))await browser.click('.task-detail-close')
      await api(`/schedule-blocks/${block.id}`,{},'DELETE');await api(`/tasks/${task.id}`,{},'DELETE')
      await browser.navigate(true);await settle()
      await browser.until(`document.querySelector('[data-inbox-task-id="${card.id}"] .inbox-card-open')`,'Original Card restored')
    }
  })
  await t.test('Editor reserves scrollbar width when vertical overflow appears and disappears',async()=>{
    await openCard()
    const measure=()=>browser.evaluate(`(()=>{const panel=document.querySelector('.task-editor-panel'),box=e=>{const r=e.getBoundingClientRect();return[r.left,r.right,r.width]};return {overflow:panel.scrollHeight>panel.clientHeight,gutter:getComputedStyle(panel).scrollbarGutter,clientWidth:panel.clientWidth,rows:[...panel.querySelectorAll('.task-attribute-row')].map(box),controls:[...panel.querySelectorAll('.task-attribute-control')].map(box),footer:box(panel.querySelector('.composer-footer'))}})()`)
    try {
      await browser.send('Emulation.setDeviceMetricsOverride',{width:1440,height:700,deviceScaleFactor:1,mobile:false})
      const short=await measure();assert(short.overflow);assert.equal(short.gutter,'stable')
      await browser.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1600,deviceScaleFactor:1,mobile:false})
      const tall=await measure();assert.equal(tall.overflow,false);assert.equal(tall.clientWidth,short.clientWidth);assert.deepEqual(tall.rows,short.rows);assert.deepEqual(tall.controls,short.controls);assert.deepEqual(tall.footer,short.footer)
    } finally { await size(1440);await close() }
  })
  await t.test('Editor delete confirmation cancel and failure retain Editor; successful deletion closes it',async()=>{
    const doomed=await api('/tasks',{title:'削除対象'});await browser.navigate(true);await settle();await browser.until('document.querySelector(".global-top-timer .tag-picker-trigger")?.disabled===false','Workspace data committed before Delete');await openCard(doomed.id)
    await browser.evaluate('window.confirm=()=>false');await browser.click('.task-editor-delete');assert(await browser.evaluate('!!document.querySelector(".task-editor-panel")'));assert.equal(await browser.evaluate('document.querySelector(".task-form-error")'),null)
    await browser.until('document.querySelector(".task-editor-delete")?.disabled===false','Cancelled Delete settled');await browser.evaluate('window.confirm=()=>true');await browser.click('.task-editor-delete');await browser.until('!document.querySelector(".task-editor-panel")','Deleted Editor closed');assert.equal((await fetch(`${base}/tasks/${doomed.id}`)).status,404)
    await openCard();await browser.click('.task-editor-delete');await browser.until('document.querySelector(".task-form-error")','Deletion constraint error');assert(await browser.evaluate('!!document.querySelector(".task-editor-panel")'));await close()
  })
  await t.test('Changed title Project and flexible estimate save only Task fields and retain historical Snapshot',async()=>{
    const entries=await api(`/tasks/${card.id}/time-entries`),blocks=await api('/schedule-blocks')
    await openCard();await input('title','Figma応用・編集');await input('projectId',learning.id);await input('estimatedMinutes','2.5h');await save()
    const updated=await api(`/tasks/${card.id}`);assert.equal(updated.title,'Figma応用・編集');assert.equal(updated.projectId,learning.id);assert.equal(updated.estimatedMinutes,150)
    assert.deepEqual(await api(`/tasks/${card.id}/time-entries`),entries);assert.deepEqual(await api('/schedule-blocks'),blocks)
    assert.deepEqual(Object.keys(requests.findLast(r=>r.method==='PUT'&&r.path===`/tasks/${card.id}`).payload).sort(),['deadline','estimatedMinutes','priority','projectId','status','tagIds','title'])
  })
  await t.test('Cancel Close and Escape discard changes, outside click retains dirty input, and focus stays inside Drawer',async()=>{
    const count=requests.filter(r=>r.method==='PUT').length
    for(const method of ['cancel','close','escape']){
      await openCard();await input('title','破棄する入力')
      await browser.evaluate('window.confirm=()=>false');await browser.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,x:100,y:400});await browser.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x:100,y:400})
      assert(await browser.evaluate('document.querySelector(".task-drawer[open]")!==null'))
      await browser.evaluate('document.querySelector(".task-drawer .composer-footer [type=submit]").focus()')
      await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9})
      assert(await browser.evaluate('document.querySelector(".task-drawer").contains(document.activeElement)'))
      await browser.evaluate('window.confirm=()=>true')
      if(method==='cancel')await browser.click('.task-drawer .composer-footer .secondary-button')
      else if(method==='close')await close()
      else await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
      await browser.until('!document.querySelector(".task-drawer")','Dismissed')
    }
    assert.equal(requests.filter(r=>r.method==='PUT').length,count)
  })
  await t.test('Equivalent estimates cause no update, and partial text is kept while focused',async()=>{
    await openCard();await input('estimatedMinutes','2h 3');assert.equal(await browser.evaluate('document.querySelector(".task-form [name=estimatedMinutes]").value'),'2h 3')
    await input('estimatedMinutes','150m');assert(await browser.evaluate('document.querySelector(".task-drawer .composer-footer [type=submit]").disabled'));await close()
  })
  await t.test('Detail read failure keeps Task input and known totals, and an inline retry loads the missing history',async()=>{
    failDetail=true;await openCard();await input('title','入力を保ったまま再取得')
    await browser.until('document.querySelector(".task-time-section [role=alert]")','Detail failure inline')
    assert.equal(await browser.evaluate('document.querySelector(".task-time-totals strong").textContent'),'3h 46m')
    assert.equal(await browser.evaluate('document.querySelectorAll(".task-time-totals strong")[1].textContent'),'読込中')
    failDetail=false;await browser.click('.task-time-section [role=alert] button')
    await browser.until('!document.querySelector(".task-time-section [role=alert]") && document.querySelectorAll(".task-time-totals strong")[1].textContent==="0m"','Detail retry')
    assert.equal(await browser.evaluate('document.querySelector(".task-form [name=title]").value'),'入力を保ったまま再取得');await close()
  })
  for(const [text,minutes] of [['2h 30m',150],['2.5h',150],['150m',150],['2h',120],['30m',30],['',null]])await t.test(`Create Drawer saves ${JSON.stringify(text)} through the shared parser and shows Inbox immediately`,async()=>{
    await create();const title='新規 '+(text||'未設定');await input('title',title);await input('projectId',project.id);await input('estimatedMinutes',text);await save()
    const created=(await api('/tasks?inbox=true')).find(task=>task.title===title);assert(created);assert.equal(created.estimatedMinutes,minutes);assert.equal(created.projectId,project.id)
    assert(await browser.evaluate(`!!document.querySelector('[data-inbox-task-id="${created.id}"]')`));assert.equal((await api(`/schedule-blocks?taskId=${created.id}`)).length,0)
  })
  await t.test('Create Cancel writes nothing and invalid zero text and clock notation cannot submit',async()=>{
    const count=requests.filter(r=>r.method==='POST'&&r.path==='/tasks').length
    await create();await input('title','保存しない')
    for(const value of ['0m','abc','2:30']){await input('estimatedMinutes',value);assert.equal(await browser.evaluate('document.querySelector(".task-form [name=estimatedMinutes]").checkValidity()'),false);await browser.evaluate('document.querySelector(".task-form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))');assert(await browser.evaluate('document.querySelector(".task-form-error")!==null'))}
    await browser.click('.task-drawer .composer-footer .secondary-button');assert.equal(requests.filter(r=>r.method==='POST'&&r.path==='/tasks').length,count)
  })
  await t.test('Card Timer does not open Drawer; another Task cannot replace Active and no Quick Complete exists',async()=>{
    await cardAction(card.id,'.inbox-card-start');await browser.until('document.querySelector(".global-top-timer.timer-session")','Global Timer active');await settle()
    const active=await api('/tasks/time/active');assert.equal(active.taskId,card.id);assert.equal(await browser.evaluate('document.querySelector(".task-drawer, .task-detail")===null'),true)
    await browser.until(`document.querySelector('[data-inbox-task-id="${card.id}"] .inbox-card-start')?.getAttribute('aria-pressed')==='true' && !document.querySelector('[data-inbox-task-id="${card.id}"] .inbox-card-start').disabled`,'Active Card shows the shared Stop action after Inbox refresh')
    await cardAction(peer.id,'.inbox-card-start');await browser.until(`document.querySelector('[data-inbox-task-id="${peer.id}"] [role=alert]')`,'Conflict shown at target Card');await settle();assert.deepEqual(await api('/tasks/time/active'),active)
    await browser.click('.global-top-timer .timer-stop');await browser.until('!document.querySelector(".global-top-timer.timer-session")','Stopped');await settle()
    assert.equal(await browser.evaluate('document.querySelector(".inbox-card-complete")'),null);assert.equal((await api(`/tasks/${peer.id}`)).completed,false)
  })
  await t.test('Drawer Timer triggers existing lifecycle and same Task cannot Start twice',async()=>{
    await openCard();await browser.click('.task-drawer-start');await browser.until('document.querySelector(".task-drawer-start")?.getAttribute("aria-pressed")==="true" && !document.querySelector(".task-drawer-start").disabled','Canonical Timer rendered before assertions');await settle();const active=await api('/tasks/time/active');assert.equal(active.taskId,card.id)
    assert(await browser.evaluate('document.querySelector(".task-drawer-start").getAttribute("aria-pressed")==="true" && !document.querySelector(".task-drawer-start").disabled'));assert.equal(await browser.evaluate('document.querySelectorAll(".global-top-timer").length'),1)
    await close();await browser.click('.global-top-timer .timer-stop');await browser.until('!document.querySelector(".global-top-timer.timer-session")','Canonical Stop rendered');await settle()
  })
  await t.test('Time section uses Backend recorded total, all-date TIMED durations and separate overall estimate',async()=>{
    await go('tasks');await browser.click(`.task-table-row[data-task-id="${lecture.id}"] .task-row-edit`);await drawer()
    const values=await browser.evaluate('Array.from(document.querySelectorAll(".task-time-totals strong")).map(e=>e.textContent)')
    assert.deepEqual(values,['7時間30分','6時間','12時間']);assert.equal(await browser.evaluate('/進捗|%/.test(document.querySelector(".task-time-section").textContent)'),false)
    assert(requests.some(r=>r.method==='GET'&&r.path==='/schedule-blocks'));await shot('drawer-times-1440')
  })
  await t.test('Recorded detail stays inside Drawer and lists every minute-only date interval and duration',async()=>{
    await browser.click('[data-time-detail=recorded]');assert.equal(await browser.evaluate('document.querySelectorAll("[data-task-entry-id]").length'),3)
    const text=await browser.evaluate('document.querySelector(".task-time-history").textContent');for(const value of ['09:00','11:30','2時間30分','3時間20分','1時間40分','7時間30分'])assert(text.includes(value),text)
    assert(!/\d\d:\d\d:\d\d|\.\d{3}/.test(text));assert.equal(await browser.evaluate('document.querySelectorAll("dialog[open]").length'),1)
    await shot('drawer-recorded-1440')
  })
  await t.test('Planned detail includes TIMED TIME_UNSET ALL_DAY but only three TIMED intervals contribute six hours',async()=>{
    await browser.click('[data-time-detail=planned]');assert.equal(await browser.evaluate('document.querySelectorAll("[data-task-placement-id]").length'),5)
    const text=await browser.evaluate('document.querySelector(".task-time-history").textContent');for(const value of ['09:00 – 12:00','時刻未定','終日','計画済み合計：6時間'])assert(text.includes(value),text)
    for(const block of lectureBlocks.filter(b=>b.type!=='TIMED'))assert.equal(await browser.evaluate(`document.querySelector('[data-task-placement-id="${block.id}"] strong')===null`),true)
    await shot('drawer-planned-1440')
    await close()
  })
  await t.test('A thirty-hour placement shows its actual end date and total without clipping at midnight',async()=>{
    await browser.click(`.task-table-row[data-task-id="${longTask.id}"] .task-row-edit`);await drawer();await browser.click('[data-time-detail=planned]')
    const text=await browser.evaluate('document.querySelector(".task-time-history").textContent')
    for(const value of ['2026-10-09','23:30 – 2026-10-11 05:30','30時間','計画済み合計：30時間'])assert(text.includes(value),text)
    assert.equal(await browser.evaluate('document.querySelectorAll(".task-time-totals strong")[2].textContent'),'未設定');await close();await go('home')
  })
  await t.test('Explicit date creates TIME_UNSET and time creates TIMED sixty minutes; no Schedule exists before save',async()=>{
    for(const timed of [false,true]){
      await create();await input('title',timed?'Editor timed':'Editor date only');await input('date','2026-10-08')
      if(timed)await input('startTime','16:00')
      assert.equal((await api('/tasks')).some(task=>task.title===(timed?'Editor timed':'Editor date only')),false)
      await save();const task=(await api('/tasks')).find(task=>task.title===(timed?'Editor timed':'Editor date only'))
      const blocks=await api(`/schedule-blocks?taskId=${task.id}`);assert.equal(blocks.length,1);assert.equal(blocks[0].type,timed?'TIMED':'TIME_UNSET');assert.equal(blocks[0].durationMinutes,timed?60:null)
      await api(`/schedule-blocks/${blocks[0].id}`,{},'DELETE');await api(`/tasks/${task.id}`,{},'DELETE')
    }
    await browser.navigate(true);await settle()
  })
  await t.test('Calendar Full Editor keeps only clicked Schedule context and TIME_UNSET gains sixty minutes',async()=>{
    const task=await api('/tasks',{title:'Context only Task'}),first=await api('/schedule-blocks',{taskId:task.id,date:day,type:'TIME_UNSET'}),second=await api('/schedule-blocks',{taskId:task.id,date:'2026-10-05',type:'TIME_UNSET'})
    assert.deepEqual((await api(`/schedule-blocks?taskId=${task.id}`)).find(block=>block.id===first.id),first)
    await browser.navigate(true);await browser.until(`document.querySelector('[data-schedule-block-id="${first.id}"]')`,'Created Schedule rendered');await settle();await browser.click(`[data-schedule-block-id="${first.id}"]`);await browser.until('document.querySelector(".task-detail")','Quick Detail')
    await browser.click('.task-detail-edit');await drawer();assert.equal(await browser.evaluate('document.querySelector(".task-form [name=date]").value'),day.replaceAll('-','/'));assert.equal(await browser.evaluate('document.querySelector(".task-form [name=startTime]").value'),'')
    await input('startTime','16:00');await save();const blocks=await api(`/schedule-blocks?taskId=${task.id}`);assert.deepEqual(blocks.find(block=>block.id===second.id),second);assert.equal(blocks.find(block=>block.id===first.id).type,'TIMED');assert.equal(blocks.find(block=>block.id===first.id).durationMinutes,60)
    for(const block of blocks)await api(`/schedule-blocks/${block.id}`,{},'DELETE');await api(`/tasks/${task.id}`,{},'DELETE');await browser.navigate(true);await settle()
  })
  await t.test('Task save failure retains Full Editor draft and retry updates without creating Schedule',async()=>{
    await openCard();await input('title','保存失敗時のdraft');failQuickTask=true;await browser.click('.composer-footer [type=submit]');await browser.until('document.querySelector(".task-form-error")','Failed save remains open')
    assert.equal(await browser.evaluate('document.querySelector(".task-form [name=title]").value'),'保存失敗時のdraft');assert.equal((await api(`/tasks/${card.id}`)).title,'Figma応用・編集')
    failQuickTask=false;await input('title','Figma応用・編集');await input('estimatedMinutes','151m');await save();await openCard();await input('estimatedMinutes','150m');await save();assert.equal((await api(`/schedule-blocks?taskId=${card.id}`)).length,0)
  })
  await t.test('Inbox to Calendar and back remove only the placed Block and never interpret a Drag as Card click',async()=>{
    await drag(`[data-inbox-task-id="${card.id}"]`,`[data-drop-date="${day}"]`);assert.equal(await browser.evaluate('document.querySelector(".task-drawer, .task-detail")===null'),true)
    const block=(await api(`/schedule-blocks?taskId=${card.id}`))[0];assert.equal(block.type,'TIME_UNSET')
    await browser.until(`document.querySelector('[data-schedule-block-id="${block.id}"]')`,'Placed Block available')
    await drag(`[data-schedule-block-id="${block.id}"]`,'.unplanned-panel');assert.equal((await api(`/schedule-blocks?taskId=${card.id}`)).length,0)
    await browser.until(`document.querySelector('[data-inbox-task-id="${card.id}"]')`,'Released Card available');assert.equal((await api(`/tasks/${card.id}`)).estimatedMinutes,150)
  })
  const mode = async value => {
    await browser.click(`[aria-label="カレンダー表示"] button:nth-child(${({day:1,week:2,month:3})[value]})`)
    await browser.until(`document.querySelector('.${value === 'month' ? 'month-calendar-panel' : 'week-calendar-panel'}') && !document.querySelector('.calendar-schedule-status [role=status]')`, 'Calendar mode ready')
    await settle()
  }
  const cell = date => `.calendar-combined-row [data-drop-date="${date}"]`
  const setSearch = value => browser.evaluate(`(()=>{const e=document.querySelector('.timer-task-picker input');e.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`)
  const pointerOutside = async () => {
    const point = await browser.evaluate(`(()=>{const r=document.querySelector('.calendar-page').getBoundingClientRect();return{x:r.right-60,y:400}})()`)
    for(const type of ['mousePressed','mouseReleased'])await browser.send('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point})
  }
  await t.test('Workspace navigation contains Home, Tasks and Projects without duplicate Inbox or Today routes',async()=>{
    assert.deepEqual(await browser.evaluate('[...document.querySelectorAll(".home-workspace-nav button")].map(e=>e.textContent)'),['ホーム画面','プロジェクト一覧'])
    assert(await browser.evaluate('!document.querySelector(".today-tasks-panel")'))
  })
  for(const value of ['week','day'])await t.test(`${value} keeps Zoom in the date-header gutter and readable date labels`,async()=>{
    await mode(value)
    const r=await browser.evaluate(`(()=>{const z=document.querySelector('.calendar-zoom-control').getBoundingClientRect(),p=document.querySelector('.calendar-date-separator').getBoundingClientRect(),h=document.querySelector('.calendar-week-header:not(.calendar-lane-header) > button');return{zoomRight:z.right,countLeft:p.left,periodWidth:document.querySelector('.calendar-period-navigation').getBoundingClientRect().width,weekday:Number.parseFloat(getComputedStyle(h.querySelector('span')).fontSize),date:Number.parseFloat(getComputedStyle(h.querySelector('strong')).fontSize)}})()`)
    assert(r.zoomRight<=r.countLeft);assert(r.periodWidth<360);assert(r.weekday>=16&&r.date>=22)
  })
  await t.test('Month hides Zoom without moving the mode buttons',async()=>{
    await mode('month');assert(await browser.evaluate('!document.querySelector(".calendar-zoom-control")'));await mode('week')
  })
  await t.test('Date Summary Count and Timeline columns align across Zoom inside the Desktop scroller',async()=>{
    await size(1440);await mode('week')
    const scrollbars=[]
    for(const target of [1,5]){
      while(await browser.evaluate('Number(document.querySelector(".calendar-zoom-control").dataset.zoomLevel)')!==target){
        const current=await browser.evaluate('Number(document.querySelector(".calendar-zoom-control").dataset.zoomLevel)')
        await browser.click(`[aria-label="${current<target?'時間軸を拡大':'時間軸を縮小'}"]`)
      }
      await browser.evaluate('document.querySelector(".calendar-time-grid").scrollTop=0;undefined')
      await alignment()
      scrollbars.push(await browser.evaluate('(()=>{const g=document.querySelector(".calendar-time-grid");return g.scrollHeight>g.clientHeight})()'))
    }
    assert.deepEqual(scrollbars,[true,true])
    await browser.click('[aria-label="時間軸を縮小"]');await browser.click('[aria-label="時間軸を縮小"]')
    await shot('fix4-header-count-alignment')
  })
  const combinedBlocks=[]
  for(const type of ['ALL_DAY','TIME_UNSET'])combinedBlocks.push(await api('/schedule-blocks',{taskId:lecture.id,date:day,type}))
  combinedBlocks.push(await api('/schedule-blocks',{taskId:peer.id,date:'2026-10-01',type:'TIME_UNSET'}))
  const overlap=await api('/schedule-blocks',{taskId:peer.id,date:day,type:'TIMED',startTime:'11:00',durationMinutes:90})
  await mode('week')
  await t.test('ALL_DAY and TIME_UNSET share one row with exactly one gutter toggle',async()=>{
    assert.equal(await browser.evaluate('document.querySelectorAll(".calendar-combined-row").length'),1)
    assert.equal(await browser.evaluate('document.querySelectorAll(".calendar-row-toggle").length'),1)
    for(const block of combinedBlocks.slice(0,2))assert(await browser.evaluate(`document.querySelector('${cell(day)} [data-schedule-block-id="${block.id}"][data-schedule-type="${block.type}"]')!==null`))
    assert.equal(await browser.evaluate(`document.querySelector('${cell('2026-10-06')} .calendar-date-toggle')===null`),true)
    assert.equal(await browser.evaluate('document.querySelectorAll(".calendar-date-toggle").length'),0)
  })
  await t.test('The gutter toggle hides the whole date-only row while preserving column alignment',async()=>{
    await browser.click('.calendar-row-toggle')
    assert.equal(await browser.evaluate('document.querySelector(".calendar-row-toggle").getAttribute("aria-expanded")'),'false')
    assert.equal(await browser.evaluate(`document.querySelectorAll('${cell(day)} [data-schedule-block-id]').length`),0)
    assert(await browser.evaluate(`document.querySelector('${cell('2026-10-01')} [data-schedule-block-id="${combinedBlocks[2].id}"]')===null`))
    await alignment();await browser.click('.calendar-row-toggle')
    assert.equal(await browser.evaluate(`document.querySelectorAll('${cell(day)} [data-schedule-block-id]').length`),2);await alignment()
  })
  await t.test('Home displays exactly Planned and Actual; TIMED overlaps use occupied-time union and untimed estimates do not contribute',async()=>{
    const report=await api(`/reports/daily?date=${day}&timezone=Asia%2FTokyo`)
    assert.equal(report.plannedOccupiedMinutes,210)
    assert.deepEqual(await browser.evaluate(`[...document.querySelectorAll('[data-metric-date="${day}"] dt')].map(e=>e.textContent)`),['計画済み','記録'])
    assert.equal(await browser.evaluate(`document.querySelector('[data-metric-date="${day}"] dd').textContent`),'3時間30分')
    assert.equal((await api(`/tasks/${lecture.id}`)).estimatedMinutes,720)
    assert.equal((await api(`/tasks/${peer.id}`)).estimatedMinutes,null)
    assert.equal((await api(`/schedule-blocks?taskId=${peer.id}`)).find(b=>b.id===overlap.id).durationMinutes,90)
    await shot('combined-metrics-1440')
  })
  await t.test('Create and edit Overlay the same Panel without changing Calendar or Block geometry',async()=>{
    for(const open of [create,openCard]){
      const geometry=()=>browser.evaluate(`(()=>{const box=e=>{const r=e.getBoundingClientRect();return[r.x,r.y,r.width,r.height]};return ['.calendar-page','.calendar-day-column','.weekly-schedule-event'].map(s=>[...document.querySelectorAll(s)].map(box))})()`)
      const before=await geometry()
      await open()
      const r=await browser.evaluate(`(()=>{const p=document.querySelector('.task-editor-panel').getBoundingClientRect(),s=document.querySelector('.home-sidebar').getBoundingClientRect(),c=document.querySelector('.calendar-page').getBoundingClientRect();return{panelLeft:p.left,panelRight:p.right,panelWidth:p.width,sidebarRight:s.right,calendarLeft:c.left,calendarRight:c.right}})()`)
      assert(Math.abs(r.panelLeft-r.sidebarRight)<=1,JSON.stringify(r));assert(r.panelWidth>=360&&r.panelWidth<=420)
      assert(r.calendarLeft<r.panelRight&&r.calendarRight-r.calendarLeft>200,JSON.stringify(r));assert.deepEqual(await geometry(),before)
      const rows=await browser.evaluate(`(()=>{const rows=[...document.querySelectorAll('.task-editor-panel .task-attribute-row')];return rows.map(e=>{const i=e.querySelector('.task-attribute-icon').getBoundingClientRect(),l=e.querySelector('.task-attribute-label').getBoundingClientRect(),v=e.querySelector('.task-attribute-control').getBoundingClientRect();return {label:e.querySelector('.task-attribute-label').textContent,aligned:i.right<=l.left&&l.right<=v.left,unset:e.dataset.unset}})})()`)
      assert.deepEqual(rows.map(r=>r.label),['ステータス','プロジェクト','タグ','優先度','期限','見積もり','予定日','時刻']);assert(rows.every(r=>r.aligned))
      if(open===create){
        assert(rows.filter(r=>r.label!=='ステータス').every(r=>r.unset==='true'))
        assert.equal(await browser.evaluate(`document.querySelector('.task-editor-panel .project-picker-trigger span').textContent`),'未設定')
        assert.equal(await browser.evaluate(`document.querySelector('.task-editor-panel .tag-picker-trigger').textContent`),'未設定')
        assert.equal(await browser.evaluate(`document.querySelector('.task-editor-panel .priority-none').textContent`),'未設定')
        for(const name of ['deadline','estimatedMinutes'])assert.equal(await browser.evaluate(`document.querySelector('.task-editor-panel [name="${name}"]').placeholder`),'未設定')
      }
      await pointerOutside()
      await browser.until('!document.querySelector(".task-editor-panel")','Clean outside closes')
    }
  })
  await t.test('Dirty outside and Escape ask before discard, cancellation retains input and confirmation closes',async()=>{
    await openCard();await input('title','未保存の入力')
    await browser.evaluate('window.__discardPrompts=[];window.confirm=message=>{window.__discardPrompts.push(message);return false}')
    await pointerOutside();await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
    assert.equal(await browser.evaluate('document.querySelector(".task-form [name=title]").value'),'未保存の入力')
    assert.deepEqual(await browser.evaluate('window.__discardPrompts'),['変更を破棄しますか？','変更を破棄しますか？'])
    await browser.evaluate('window.confirm=()=>true');await pointerOutside();await browser.until('!document.querySelector(".task-editor-panel")','Confirmed discard')
    assert.equal((await api(`/tasks/${card.id}`)).title,'Figma応用・編集')
  })
  await t.test('Direct Task search offers five visible suggestions and scrolls more candidates internally',async()=>{
    await setSearch('新規')
    const r=await browser.evaluate(`(()=>{const l=document.querySelector('.timer-task-suggestions'),r=l.getBoundingClientRect();return{count:l.querySelectorAll('[role=option]').length,height:r.height,scrollHeight:l.scrollHeight,clientHeight:l.clientHeight,overflow:getComputedStyle(l).overflowY,rows:[...l.querySelectorAll('[role=option]')].filter(e=>{const b=e.getBoundingClientRect();return b.top>=r.top&&b.bottom<=r.bottom}).length}})()`)
    assert(r.count>5);assert(r.height<=240&&r.rows<=5);assert(r.scrollHeight>r.clientHeight&&r.overflow==='auto')
    for(let i=0;i<6;i++)await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40})
    assert(await browser.evaluate('document.querySelector(".timer-task-suggestions").scrollTop>0'))
    await shot('task-search-1440')
    await setSearch('存在しない候補');assert(await browser.evaluate('!document.querySelector(".timer-play-button").disabled'))
    assert.equal(await browser.evaluate('document.querySelectorAll(".timer-task-suggestions [role=option]").length'),0)
  })
  let searchEntryId
  await t.test('Search selection starts only the selected existing Task and saves a canonical Active row',async()=>{
    await setSearch('Figma');await browser.click('.timer-task-suggestions [role=option] button')
    assert.equal(await browser.evaluate('document.querySelector(".timer-task-picker input").value'),'Figma応用・編集')
    assert(await browser.evaluate('!document.querySelector(".timer-task-suggestions")'))
    await browser.click('.timer-task-picker input');await browser.until('document.querySelector(".timer-task-suggestions")','Click reopens suggestions after selection')
    await browser.click(`.timer-task-suggestions [data-task-id="${card.id}"] button`)
    await browser.click('.timer-play-button');await browser.until('document.querySelector(".timer-session") && !document.querySelector(".timer-stop").disabled','Search Start')
    const active=await api('/tasks/time/active');assert.equal(active.taskId,card.id)
    searchEntryId=(await api(`/tasks/${card.id}/time-entries`)).find(e=>e.endedAt===null).id
    assert.equal((await api(`/tasks/${card.id}/time-entries`)).filter(e=>e.endedAt===null).length,1)
  })
  await t.test('Repeated Pause and Resume accumulate visible seconds without altering or combining DB intervals',async()=>{
    await setClock(`${day}T12:35:15+09:00`);await browser.until('document.querySelector(".timer-elapsed").textContent==="0:01:15"','First elapsed')
    await pauseOrResumeTimer(browser);await browser.until('document.querySelector(".timer-session.paused") && !document.querySelector(".timer-pause-resume").disabled','First Pause')
    const closed=(await api(`/tasks/${card.id}/time-entries`)).find(e=>e.id===searchEntryId)
    assert(closed?.endedAt);assert.equal(closed.durationMinutes,1)
    await setClock(`${day}T12:36:00+09:00`);await pauseOrResumeTimer(browser)
    await browser.until('document.querySelector(".timer-session:not(.paused)") && !document.querySelector(".timer-stop").disabled','First Resume')
    assert.equal(await browser.evaluate('document.querySelector(".timer-elapsed").textContent'),'0:01:15')
    await setClock(`${day}T12:36:45+09:00`);await browser.until('document.querySelector(".timer-elapsed").textContent==="0:02:00"','Cumulative elapsed')
    await pauseOrResumeTimer(browser);await browser.until('document.querySelector(".timer-session.paused") && !document.querySelector(".timer-pause-resume").disabled','Second Pause')
    await setClock(`${day}T12:37:00+09:00`);await pauseOrResumeTimer(browser)
    await browser.until('document.querySelector(".timer-session:not(.paused)") && !document.querySelector(".timer-stop").disabled','Second Resume')
    assert.equal(await browser.evaluate('document.querySelector(".timer-elapsed").textContent'),'0:02:00')
    await setClock(`${day}T12:37:10+09:00`);await browser.until('document.querySelector(".timer-elapsed").textContent==="0:02:10"','Third segment elapsed');await shot('timer-resumed-1440')
    await browser.click('.timer-stop');await browser.until('!document.querySelector(".timer-session") && !document.querySelector(".timer-play-button").disabled','Final Stop')
    const entries=await api(`/tasks/${card.id}/time-entries`)
    assert(entries.every(e=>e.endedAt!==null));assert.deepEqual(entries.find(e=>e.id===closed.id),closed)
    assert.equal(entries.filter(e=>e.id>=searchEntryId).length,3)
  })
  let monthBlock
  const monthDate='2026-10-15'
  await t.test('Inbox drop onto Month creates only TIME_UNSET with no duration or Task estimate changes',async()=>{
    await mode('month');await drag(`[data-inbox-task-id="${card.id}"]`,`.month-day[data-date="${monthDate}"]`)
    monthBlock=(await api(`/schedule-blocks?taskId=${card.id}`))[0]
    assert.equal(monthBlock.type,'TIME_UNSET');assert.equal(monthBlock.date,monthDate);assert.equal(monthBlock.startTime,null);assert.equal(monthBlock.durationMinutes,null)
    assert.equal((await api(`/tasks/${card.id}`)).estimatedMinutes,150)
    assert(!(await api('/tasks?inbox=true')).some(e=>e.id===card.id));assert(await browser.evaluate('!document.querySelector(".task-editor-panel, .calendar-dialog")'))
    await shot('month-drop-1440')
    await browser.click(`.month-day[data-date="${monthDate}"]`)
    await browser.until('document.querySelector(".calendar-dialog")','Select the placed date')
    await browser.click('.calendar-dialog [aria-label="予定の操作を閉じる"]');await settle()
  })
  for(const value of ['week','day'])await t.test(`Month-placed Task appears in ${value} combined row with unchanged planned total`,async()=>{
    await mode(value);assert(await browser.evaluate(`document.querySelector('${cell(monthDate)} [data-schedule-block-id="${monthBlock.id}"]')!==null`))
    assert(await browser.evaluate(`!document.querySelector('.calendar-plan-lane [data-schedule-block-id="${monthBlock.id}"]')`))
    assert.equal(await browser.evaluate(`document.querySelector('[data-metric-date="${monthDate}"] dd').textContent`),'0分')
  })
  await t.test('Inbox to Day remains supported and Week Calendar to Inbox releases only the dropped Block',async()=>{
    await mode('week');await drag(`[data-schedule-block-id="${monthBlock.id}"]`,'.unplanned-panel');assert.equal((await api(`/schedule-blocks?taskId=${card.id}`)).length,0)
    await mode('day');await drag(`[data-inbox-task-id="${card.id}"]`,cell(monthDate));const [block]=await api(`/schedule-blocks?taskId=${card.id}`);assert.equal(block.type,'TIME_UNSET')
    await mode('week');await drag(`[data-schedule-block-id="${block.id}"]`,'.unplanned-panel');assert.equal((await api(`/schedule-blocks?taskId=${card.id}`)).length,0)
    await browser.click('.today-button');await browser.until(`document.querySelector('[data-metric-date="${day}"]') && !document.querySelector('.calendar-schedule-status [role=status]')`,'Return to original week');await settle()
  })
  for(const width of [1440,1024,768,375])await t.test(`${width}px keeps Calendar columns and 00:00 aligned, readable Cards and a contained Drawer or Sheet`,async()=>{
    await size(width);await browser.evaluate('window.scrollTo(0,0);document.querySelector(".calendar-time-grid").scrollTop=0;document.querySelector(".calendar-grid-scroll").scrollLeft=0;undefined');await alignment();await shot('home-'+width)
    assert(await browser.evaluate('document.querySelector(".calendar-zoom-control").getBoundingClientRect().right<=document.querySelector(".calendar-date-separator").getBoundingClientRect().left'),'Zoom remains inside the date-header gutter before the first date')
    if(width===375){await browser.evaluate('window.scrollBy(0,document.querySelector(".calendar-page").getBoundingClientRect().top-document.querySelector(".home-header").getBoundingClientRect().height-16);undefined');await shot('calendar-375')}
    await openCard();const r=await browser.evaluate('(()=>{const e=document.querySelector(".task-drawer"),r=e.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,overflow:e.scrollWidth>e.clientWidth}})()')
    assert(r.left>=0&&r.right<=width&&r.top>=0&&r.bottom<=1000&&!r.overflow,JSON.stringify(r));if(width>680)assert(r.width>=360&&r.width<=420,JSON.stringify(r));else assert(r.width>=width-20&&r.width<=width&&r.top>0,JSON.stringify(r))
    await shot('drawer-'+width);await close()
  })
  await size(1440);await go('home');await browser.evaluate('window.scrollTo(0,0)')
  assert.deepEqual(errors,[],'No runtime or forwarding errors')
})
