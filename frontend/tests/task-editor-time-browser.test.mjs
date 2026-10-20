import assert from 'node:assert/strict'
import test from 'node:test'
import {openBrowser} from './browser.mjs'
import {mkdir,writeFile} from 'node:fs/promises'

test('Editor time details reuse Entry and Calendar editing; Home Mode position stays fixed (mock only)', {timeout:180000}, async t => {
  const b=await openBrowser();t.after(()=>b.close())
  const projects=[{id:1,name:'Blue',color:'#368AD8'},{id:2,name:'Red',color:'#DC6262'}]
  const tags=[{id:1,name:'Tag 1'},{id:2,name:'Tag 2'}]
  const tasks=[1,2].map(id=>({id,title:`Task ${id}`,status:'IN_PROGRESS',completed:false,projectId:1,projectName:'Blue',tags:[tags[0]],estimatedMinutes:120,priority:null,deadline:null,actualMinutes:40}))
  let entries=[{id:1,taskId:1,projectIdSnapshot:1,startedAt:'2026-10-06T23:40:00+09:00',endedAt:'2026-10-07T00:20:00+09:00'}, {id:2,taskId:2,projectIdSnapshot:2,startedAt:'2026-10-07T10:00:00+09:00',endedAt:'2026-10-07T11:00:00+09:00'}]
  let blocks=[{id:1,taskId:1,date:'2026-10-07',type:'TIMED',startTime:'23:30:00',durationMinutes:60},{id:2,taskId:1,date:'2026-11-01',type:'TIMED',startTime:'14:00:00',durationMinutes:120},{id:3,taskId:2,date:'2026-10-07',type:'TIMED',startTime:'10:00:00',durationMinutes:60}]
  const writes=[],errors=[];let rejectEntry=false,rejectSchedule=false
  const taskData=id=>({...tasks.find(t=>t.id===id),actualMinutes:entries.filter(e=>e.taskId===id).reduce((n,e)=>n+Math.floor((Date.parse(e.endedAt)-Date.parse(e.startedAt))/60000),0)})
  await b.send('Emulation.setTimezoneOverride',{timezoneId:'Asia/Tokyo'})
  await b.send('Emulation.setDeviceMetricsOverride',{width:1920,height:1080,deviceScaleFactor:1,mobile:false})
  await b.send('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{const D=Date,n=${Date.parse('2026-10-07T16:00:00+09:00')};window.Date=class extends D{constructor(...a){super(...(a.length?a:[n]))}static now(){return n}};window.confirm=()=>true})()`})
  b.listeners.push(m=>{
    if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails)
    if(m.method!=='Fetch.requestPaused')return
    const {request,requestId}=m.params,url=new URL(request.url),p=url.pathname,id=Number(p.split('/').at(-1))
    void(async()=>{
      if(request.method==='OPTIONS')return b.fulfill(requestId,{})
      if(request.method!=='GET'){
        const input=request.postData?JSON.parse(request.postData):null;writes.push({method:request.method,path:p,input})
        if(p.startsWith('/time-entries/')){
          if(rejectEntry)return b.fulfill(requestId,{detail:'この時間帯には別の実績があります'},409)
          if(request.method==='DELETE'){entries=entries.filter(e=>e.id!==id);return b.fulfill(requestId,{deleted:true})}
          entries=entries.map(e=>e.id===id?{...e,...input}:e);return b.fulfill(requestId,entries.find(e=>e.id===id))
        }
        if(p.startsWith('/schedule-blocks/')){
          if(rejectSchedule)return b.fulfill(requestId,{detail:'同じタスクの予定と重複しています'},409)
          if(request.method==='DELETE'){blocks=blocks.filter(e=>e.id!==id);return b.fulfill(requestId,{deleted:true})}
          blocks=blocks.map(e=>e.id===id?{...e,...input,startTime:input.startTime?`${input.startTime.slice(0,5)}:00`:null}:e);return b.fulfill(requestId,blocks.find(e=>e.id===id))
        }
        if(request.method==='PUT' && /^\/tasks\/\d+$/.test(p)){Object.assign(tasks.find(t=>t.id===id),input.tagIds?{tags:input.tagIds.map(id=>tags.find(t=>t.id===id))}:input);return b.fulfill(requestId,taskData(id))}
        throw new Error(`Unexpected write ${request.method} ${p}`)
      }
      let data=[]
      if(p==='/tasks')data=tasks.map(t=>taskData(t.id))
      else if(/^\/tasks\/\d+$/.test(p))data=taskData(id)
      else if(/^\/tasks\/\d+\/time-entries$/.test(p))data=entries.filter(e=>e.taskId===Number(p.split('/')[2]))
      else if(p==='/projects')data=projects
      else if(p==='/tags')data=tags
      else if(p==='/schedule-blocks')data=blocks.filter(e=>!url.searchParams.has('taskId')||e.taskId===Number(url.searchParams.get('taskId'))).filter(e=>!url.searchParams.has('startDate')||e.date>=url.searchParams.get('startDate')).filter(e=>!url.searchParams.has('endDate')||e.date<=url.searchParams.get('endDate'))
      else if(p==='/tasks/time/active')data={taskId:null,running:false,startedAt:null}
      else if(p==='/reports/daily')data={date:url.searchParams.get('date'),tasks:[]}
      await b.fulfill(requestId,data)
    })().catch(e=>errors.push(String(e)))
  })
  await b.send('Fetch.enable',{patterns:[{urlPattern:'http://localhost:8000/*',requestStage:'Request'}]})
  await b.navigate();await b.until("!!document.querySelector('[data-schedule-block-id=\"1\"]')",'Calendar block')
  const key=name=>b.send('Input.dispatchKeyEvent',{type:'keyDown',key:name,code:name,windowsVirtualKeyCode:name==='Enter'?13:27})
  const input=async(s,value)=>b.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(s)});e.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  const totals=()=>b.evaluate('Array.from(document.querySelectorAll(".task-time-totals strong")).map(e=>e.textContent)')
  const shot=async name=>{await b.evaluate(`document.querySelector('.task-time-history')?.scrollIntoView({block:'center'})`);await mkdir(new URL('../../docs/screenshots/home-time-section/',import.meta.url),{recursive:true});await writeFile(new URL(`../../docs/screenshots/home-time-section/${name}.png`,import.meta.url),Buffer.from((await b.send('Page.captureScreenshot',{format:'png'})).data,'base64'))}
  await t.test('Home Mode X is stable across Day Week Month, Navigation and responsive views',async()=>{
    const xs=[]
    for(const label of ['日','週','月','週']){
      await b.evaluate(`Array.from(document.querySelectorAll('[aria-label="カレンダー表示"] button')).find(e=>e.textContent===${JSON.stringify(label)}).click()`)
      await b.until(`document.querySelector('.calendar-period-navigation').dataset.mode===${JSON.stringify(label==='日'?'day':label==='週'?'week':'month')}`,'Mode committed')
      xs.push(await b.evaluate('document.querySelector("[aria-label=カレンダー表示]").getBoundingClientRect().x'))
    }
    assert(Math.max(...xs)-Math.min(...xs)<1)
    assert(await b.evaluate('document.querySelector("[aria-label=カレンダー表示]").getBoundingClientRect().x>document.querySelector(".calendar-period-navigation").getBoundingClientRect().right'))
    await b.click('.calendar-period-navigation [aria-label="次の期間"]');await b.click('.today-button')
    for(const width of [768,375]){await b.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});await b.until('document.documentElement.scrollWidth<=innerWidth+1','Responsive toolbar contained');assert.equal(await b.evaluate('document.querySelectorAll(".home-view-switch button").length'),2)}
    await b.send('Emulation.setDeviceMetricsOverride',{width:1920,height:1080,deviceScaleFactor:1,mobile:false})
  })
  await b.until("!!document.querySelector('[data-schedule-block-id=\"1\"]')",'Current Calendar')
  await b.click('[data-schedule-block-id="1"]');await b.until('!!document.querySelector(".task-detail-edit")','Detail');await b.click('.task-detail-edit')
  await b.until('!!document.querySelector(".task-editor-panel[open]") && document.querySelectorAll(".task-time-totals strong")[1]?.textContent==="3h"','Editor times')
  await t.test('Summary headings share Task header typography; semantic Footer and centered values use eight-pixel spacing',async()=>{
    assert(await b.evaluate(`Array.from(document.querySelectorAll('.home-full-editor .task-time-summary dt')).every(e=>{const s=getComputedStyle(e);return s.fontSize==='14px'&&s.fontWeight==='700'})`))
    assert(await b.evaluate(`Array.from(document.querySelectorAll('.home-full-editor .composer-footer .ui-button')).length===3&&Array.from(document.querySelectorAll('.home-full-editor .composer-footer .ui-button')).every(e=>getComputedStyle(e).height==='40px')`))
    assert.equal(await b.evaluate(`getComputedStyle(document.querySelector('.home-full-editor .composer-footer')).gap`),'8px')
    assert(await b.evaluate(`Array.from(document.querySelectorAll('.home-full-editor .task-time-summary dd strong')).every(e=>{const r=e.getBoundingClientRect(),p=e.closest('dd').getBoundingClientRect();return Math.abs((r.left+r.right-p.left-p.right)/2)<1})`))
    assert.equal(await b.evaluate(`document.querySelector('.home-full-editor .ui-button-primary').disabled`),true)
  })
  await t.test('Estimate Card shares parser, accepts three formats and null, rejects invalid and Escape',async()=>{
    for(const text of ['2h 30m','2.5h','150m','']){
      await b.click('[data-time-estimate]');await input('[aria-label="時間の見積もり"]',text);const count=writes.length;await key('Enter')
      await b.until('!!document.querySelector("[data-time-estimate]")','Estimate saved')
      assert.equal(writes.length,count)
      assert.equal((await totals())[2],text?'2h 30m':'未設定')
      assert.equal(await b.evaluate('document.querySelector(".task-form [name=estimatedMinutes]").value'),text?'2h 30m':'')
    }
    await b.click('[data-time-estimate]');await input('[aria-label="時間の見積もり"]','bad');const count=writes.length;await key('Enter');await b.until('!!document.querySelector(".task-time-estimate-editor [role=alert]")','Invalid estimate');assert.equal(writes.length,count)
    await key('Escape');await b.until('!!document.querySelector("[data-time-estimate]")','Discard');assert.equal((await totals())[2],'未設定')
    await b.click('[data-time-estimate]');await input('[aria-label="時間の見積もり"]','150m');await b.evaluate('document.querySelector(".task-form [name=title]").focus()');await b.until('!!document.querySelector("[data-time-estimate]")','Estimate blur saved');assert.equal((await totals())[2],'2h 30m')
    assert.equal(await b.evaluate(`getComputedStyle(document.querySelector('.home-full-editor .ui-button-primary')).backgroundColor`),'rgb(79, 70, 229)')
  })
  await t.test('Record details stay in Drawer, scoped to Task; snapshot and Tags use existing mutations',async()=>{
    await b.click('[data-time-detail=recorded]');await b.until("!!document.querySelector('.task-editor-records [data-entry-id=\"1\"]')",'Record details')
    assert.equal(await b.evaluate('document.querySelectorAll(".task-editor-records [data-entry-id]").length'),1)
    assert.equal(await b.evaluate('document.querySelectorAll(".task-editor-records select").length'),0)
    assert.equal(await b.evaluate('document.querySelectorAll(".task-editor-records th").length'),0)
    assert(await b.evaluate(`Array.from(document.querySelectorAll('.time-entry-log-compact > td')).every(e=>getComputedStyle(e,'::before').content==='none')`))
    assert(await b.evaluate(`(()=>{const r=document.querySelector('.time-entry-log-compact'),cells=label=>r.querySelector('[data-label="'+label+'"]').getBoundingClientRect();return Math.abs(cells('日付').top-cells('計測期間').top)<1&&Math.abs(cells('日付').top-cells('記録').top)<1&&Math.abs(cells('プロジェクト名').top-cells('タグ').top)<1&&r.getBoundingClientRect().height<160})()`))
    assert.equal(await b.evaluate(`document.querySelector('.task-editor-records .entry-log-duration button').textContent`),'40m')
    await shot('recorded-1920')
    const recordColumns=()=>b.evaluate(`['日付','計測期間','記録'].map(label=>{const r=document.querySelector('.time-entry-log-compact [data-label="'+label+'"]').getBoundingClientRect();return [r.left,r.width]})`)
    const recordNormal=await recordColumns(),beforeDate=writes.length
    await b.click('.task-editor-records .entry-display-date > button')
    assert.deepEqual(await recordColumns(),recordNormal)
    assert(await b.evaluate(`Array.from(document.querySelectorAll('.task-editor-records .compact-input input')).every(e=>e.type==='text'&&getComputedStyle(e).height==='32px')`))
    await b.click('.task-editor-records [aria-label="開始日のカレンダーを開く"]');await b.until('!!document.querySelector(".task-editor-records .deadline-calendar")','Record Calendar')
    assert.equal(await b.evaluate(`getComputedStyle(document.querySelector('.task-editor-records .deadline-calendar')).position`),'fixed')
    assert.deepEqual(await recordColumns(),recordNormal)
    await shot('record-edit-calendar-1920')
    await b.click('.task-editor-records .deadline-calendar [aria-label="2026/10/05"]')
    assert.equal(await b.evaluate(`document.querySelector('.task-editor-records [aria-label="開始日"]').value`),'2026/10/05')
    assert.equal(writes.length,beforeDate);await key('Escape')
    await b.click('.task-editor-records .entry-time-control > button')
    for(const [text,expected] of [['1516','15:16'],['0915','09:15'],['915','09:15'],['15:16','15:16'],['0030','00:30']]){await input('.task-editor-records [aria-label="終了時刻"]',text);await b.evaluate(`document.querySelector('.task-editor-records [aria-label="開始時刻"]').focus()`);assert.equal(await b.evaluate(`document.querySelector('.task-editor-records [aria-label="終了時刻"]').value`),expected)}
    await shot('record-edit-1920');await key('Escape')
    await b.click('.task-editor-records [data-label="プロジェクト名"] > button');await b.until('!!document.querySelector(".task-editor-records .project-picker-popup")','Project')
    await b.click('.task-editor-records [data-project-id="2"]');await b.until('!document.querySelector(".task-editor-records .project-picker-trigger").disabled','Chosen');await b.evaluate('document.querySelector(".task-editor-records .project-picker-trigger").focus()');await key('Enter');await b.until('!document.querySelector(".task-editor-records .project-picker")','Snapshot saved')
    assert.equal(entries[0].projectIdSnapshot,2);assert.equal(tasks[0].projectId,1)
    await b.click('.task-editor-records [data-label="タグ"] > button');await b.until('!!document.querySelector(".task-editor-records .tag-picker-popup")','Tags')
    await b.evaluate('Array.from(document.querySelectorAll(".task-editor-records .tag-picker-options label")).find(e=>e.textContent.includes("Tag 2")).querySelector("input").click()')
    await b.click('.task-editor-records .tag-picker-trigger');await b.evaluate('document.querySelector(".task-editor-records .tag-picker-trigger").focus()');await key('Enter');await b.until('!document.querySelector(".task-editor-records .tag-picker")','Tag saved')
    assert.deepEqual(tasks[0].tags.map(t=>t.id),[1,2]);assert(!('tagIds' in writes.find(w=>w.method==='PATCH'&&w.path==='/time-entries/1').input))
    await b.click('[data-time-detail=recorded]');assert.equal(await b.evaluate('!!document.querySelector(".task-editor-records")'),false)
    await b.click('[data-time-detail=recorded]')
  })
  await t.test('Record overnight correction preserves one Entry; 409 retains draft; Delete updates total',async()=>{
    const end='.task-editor-records [aria-label="終了時刻"]'
    await b.click('.task-editor-records .entry-time-control > button');await input(end,'00:30');await key('Enter');await b.until('!document.querySelector(".task-editor-records .entry-inline-dates") && document.querySelector(".task-time-totals strong")?.textContent==="50m"','Record total')
    assert.equal(entries.filter(e=>e.taskId===1).length,1);assert.equal(writes.at(-1).input.startedAt,'2026-10-06T23:40:00+09:00')
    await b.click('.task-editor-records .entry-time-control > button');await input(end,'00:40');rejectEntry=true;await key('Enter');await b.until('!!document.querySelector(".task-editor-records [role=alert]")','409');assert.equal(await b.evaluate(`document.querySelector(${JSON.stringify(end)}).value`),'00:40');rejectEntry=false;await key('Escape')
    await b.click('.task-editor-records .entry-menu summary');await b.click('.task-editor-records .entry-menu .danger');await b.until('document.querySelector(".task-time-totals strong")?.textContent==="0m"','Deleted total');assert.equal(entries.filter(e=>e.taskId===2).length,1)
  })
  await t.test('Planned details show all Task Blocks, reuse validation, overnight edit and Delete outside visible week',async()=>{
    await b.click('[data-time-detail=planned]');await b.until('document.querySelectorAll(".task-editor-schedule").length===2','Task Blocks')
    assert.equal(await b.evaluate('!!document.querySelector(".task-editor-records")'),false)
    assert(await b.evaluate(`(()=>{const r=document.querySelector('.task-editor-schedule-compact'),a=[...r.children].slice(0,3).map(e=>e.getBoundingClientRect().top);return Math.max(...a)-Math.min(...a)<1&&r.getBoundingClientRect().height<120&&r.querySelector('[data-schedule-field=durationMinutes]').textContent==='1h'})()`))
    await shot('planned-1920')
    const block='[data-task-placement-id="1"]'
    const planColumns=()=>b.evaluate(`[...document.querySelector('${block}').children].slice(0,3).map(e=>{const r=e.getBoundingClientRect();return [r.left,r.width]})`)
    const planNormal=await planColumns(),beforePlan=writes.length
    await b.click(`${block} [data-schedule-field="date"]`)
    assert.deepEqual(await planColumns(),planNormal)
    await b.click(`${block} [aria-label="予定の日付のカレンダーを開く"]`);await b.until(`document.querySelector('${block} .deadline-calendar')`,'Plan Calendar')
    assert.deepEqual(await planColumns(),planNormal)
    await b.click(`${block} .deadline-calendar [aria-label="2026/10/09"]`)
    assert.equal(await b.evaluate(`document.querySelector('${block} [aria-label="予定の日付"]').value`),'2026/10/09')
    assert.equal(writes.length,beforePlan);await key('Escape')
    await b.click(`${block} [data-schedule-field="durationMinutes"]`)
    assert.deepEqual(await planColumns(),planNormal);await shot('plan-duration-edit-1920');await key('Escape')
    await b.click(`${block} [data-schedule-field="startTime"]`)
    assert.deepEqual(await planColumns(),planNormal)
    assert.equal(await b.evaluate(`document.querySelectorAll('${block} input[type=time]').length`),0)
    await input(`${block} [aria-label="予定の開始時刻"]`,'1516');await b.evaluate(`document.querySelector('${block} [aria-label="予定の終了時刻"]').focus()`)
    assert.equal(await b.evaluate(`document.querySelector('${block} [aria-label="予定の開始時刻"]').value`),'15:16')
    await input(`${block} [aria-label="予定の終了時刻"]`,'2560')
    assert.equal(await b.evaluate(`document.querySelector('${block} .calendar-inline-schedule-actions button:last-child').disabled`),true)
    await shot('plan-time-edit-1920');await key('Escape')
    await b.click(`${block} [data-schedule-field="startTime"]`);await input(`${block} [aria-label="予定の終了時刻"]`,'00:45');await key('Enter')
    await b.until('document.querySelectorAll(".task-time-totals strong")[1]?.textContent==="3h 15m"','Plan total');assert.equal(blocks.find(b=>b.id===1).durationMinutes,75);assert.equal(blocks.filter(b=>b.id===1).length,1)
    await b.click(`${block} [data-schedule-field="date"]`);await input(`${block} [aria-label="予定の日付"]`,'2026/10/09');await b.click(`${block} .calendar-inline-schedule-actions button:last-child`)
    await b.until(`document.querySelector('${block} [data-schedule-field="date"]')?.textContent==='2026/10/09'`,'Schedule date saved');assert.equal(blocks.find(b=>b.id===1).date,'2026-10-09')
    await b.click(`${block} [data-schedule-field="durationMinutes"]`);await input(`${block} [aria-label="予定の長さ"]`,'bad');const count=writes.length;await key('Enter');await b.until(`!!document.querySelector('${block} [role=alert]')`,'Invalid schedule');assert.equal(writes.length,count);await key('Escape')
    await b.click(`${block} [data-schedule-field="durationMinutes"]`);await input(`${block} [aria-label="予定の長さ"]`,'2h');rejectSchedule=true;await key('Enter');await b.until(`!!document.querySelector('${block} [role=alert]')`,'Schedule error');assert.equal(await b.evaluate(`document.querySelector('${block} [aria-label="予定の長さ"]').value`),'2h');rejectSchedule=false;await b.until(`document.activeElement===document.querySelector('${block} [aria-label="予定の長さ"]') && !document.activeElement.disabled`,'Schedule failure focus');await key('Escape')
    await b.click('[data-task-placement-id="2"] .danger');await b.until('document.querySelectorAll(".task-time-totals strong")[1]?.textContent==="1h 15m"','Plan deleted')
    assert.equal(blocks.find(b=>b.id===2),undefined);assert(blocks.find(b=>b.id===3))
    await b.click('[data-time-detail=planned]');assert.equal(await b.evaluate('!!document.querySelector(".task-editor-placements")'),false)
    assert.equal(await b.evaluate('document.querySelectorAll("dialog[open]").length'),1)
    assert.deepEqual(errors,[])
  })
})
