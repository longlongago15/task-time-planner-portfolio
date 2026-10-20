import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdir, writeFile} from 'node:fs/promises'
import {openBrowser} from './browser.mjs'
import {selectReportAnchor} from './report-picker.mjs'
import {startEntryInlineDiagnostics} from './entry-inline-diagnostics.mjs'

test('Home List and Reports edit raw TimeEntries in one Row transaction (API mocks, no DB)', {timeout:180000}, async t=>{
  const b=await openBrowser(); t.after(()=>b.close())
  const projects=[{id:1,name:'Blue',color:'#368AD8',taskCount:1,completedTaskCount:0,estimatedMinutes:120,actualMinutes:120},{id:2,name:'Red',color:'#DC6262',taskCount:1,completedTaskCount:1,estimatedMinutes:120,actualMinutes:120}]
  const tasks=[1,2].map(id=>({id,title:`Task ${id}`,projectId:id,projectName:id===1?'Blue':'Red',tags:[{id,name:`Tag ${id}`}],status:id===2?'COMPLETED':'IN_PROGRESS',completed:id===2,priority:null,deadline:null,estimatedMinutes:null,actualMinutes:120}))
  let entries=[{id:1,taskId:1,projectIdSnapshot:1,startedAt:'2026-10-07T09:00:00+09:00',endedAt:'2026-10-07T10:00:00+09:00'},
    {id:2,taskId:1,projectIdSnapshot:1,startedAt:'2026-10-06T23:40:00+09:00',endedAt:'2026-10-07T00:20:00+09:00'},
    {id:3,taskId:2,projectIdSnapshot:2,startedAt:'2026-10-07T11:00:00+09:00',endedAt:'2026-10-07T12:00:00+09:00'}]
  const blocks=[{id:1,taskId:1,date:'2026-10-07',type:'TIMED',startTime:'09:00:00',durationMinutes:60}]
  const taskWrites=[]; const patches=[],deletes=[],errors=[],timerWrites=[],reads=[]; let reject=false,rejectTags=false,active=null
  await b.send('Emulation.setTimezoneOverride',{timezoneId:'Asia/Tokyo'})
  await b.send('Emulation.setDeviceMetricsOverride',{width:1920,height:1080,deviceScaleFactor:1,mobile:false})
  await b.send('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{const D=Date,now=${Date.parse('2026-10-07T16:00:00+09:00')};window.Date=class extends D{constructor(...a){super(...(a.length?a:[now]))}static now(){return now}};window.confirm=()=>true})()`})
  b.listeners.push(m=>{
    if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails)
    if(m.method!=='Fetch.requestPaused')return
    const {request,requestId}=m.params,url=new URL(request.url),path=url.pathname
    void(async()=>{
      if(request.method==='OPTIONS')return b.fulfill(requestId,{})
      if(request.method==='POST' && path.startsWith('/tasks/time/')){
        const {taskId}=JSON.parse(request.postData);timerWrites.push({path,taskId})
        if(path.endsWith('/start')){active={taskId,running:true,startedAt:'2026-10-07T06:59:00.000Z'};return b.fulfill(requestId,active)}
        active=null;const closed={id:99+timerWrites.length,taskId,projectIdSnapshot:1,startedAt:'2026-10-07T06:59:00.000Z',endedAt:'2026-10-07T07:00:00.000Z'};entries.push(closed);return b.fulfill(requestId,closed)
      }
      if(request.method==='PUT' && /^\/tasks\/\d+$/.test(path)){const id=Number(path.split('/').at(-1)),input=JSON.parse(request.postData);taskWrites.push({id,input});if(rejectTags)return b.fulfill(requestId,{detail:'Tag update failed'},500);const task=tasks.find(t=>t.id===id);task.tags=input.tagIds.map(id=>({id,name:`Tag ${id}`}));return b.fulfill(requestId,task)}
      if(request.method==='PATCH'){
        const id=Number(path.split('/').at(-1)),input=JSON.parse(request.postData);patches.push({id,input})
        if(reject)return b.fulfill(requestId,{detail:'この時間帯には別の実績があります'},409)
        const old=entries.find(e=>e.id===id);entries=entries.map(e=>e.id===id?{...e,...input}:e)
        if (!('projectIdSnapshot' in input)) assert.equal(entries.find(e=>e.id===id).projectIdSnapshot,old.projectIdSnapshot)
        return b.fulfill(requestId,entries.find(e=>e.id===id))
      }
      if(request.method==='DELETE'){const id=Number(path.split('/').at(-1));deletes.push(id);entries=entries.filter(e=>e.id!==id);return b.fulfill(requestId,{deleted:true})}
      assert.equal(request.method,'GET')
      reads.push(path)
      let data=[]
      if(path==='/tasks')data=tasks
      else if(path==='/projects')data=projects
      else if(path==='/tags')data=[{id:1,name:'Tag 1'},{id:2,name:'Tag 2'}]
      else if(path==='/tasks/time/active')data=active??{taskId:null,running:false,startedAt:null}
      else if(/^\/tasks\/\d+\/time-entries$/.test(path))data=entries.filter(e=>e.taskId===Number(path.split('/')[2]))
      else if(/^\/tasks\/\d+$/.test(path))data=tasks.find(t=>t.id===Number(path.split('/')[2]))
      else if(path==='/schedule-blocks')data=blocks
      else if(path==='/reports/daily')data={date:url.searchParams.get('date'),tasks:[]}
      await b.fulfill(requestId,data)
    })().catch(e=>errors.push(String(e)))
  })
  await b.send('Fetch.enable',{patterns:[{urlPattern:'http://localhost:8000/*',requestStage:'Request'}]})
  await b.navigate(); await b.until('!!document.querySelector(".home-view-switch") && !!document.querySelector(".calendar-grid-content")','Home Calendar')
  const activity=()=>b.click('#report-tab-activity'), analysis=()=>b.click('#report-tab-analysis')
  const row=id=>`[data-entry-id="${id}"]`
  const input=async(selector,value)=>b.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  const key=async(name)=>b.send('Input.dispatchKeyEvent',{type:'keyDown',key:name,code:name,windowsVirtualKeyCode:name==='Enter'?13:27})
  const end=id=>`${row(id)} input[aria-label="終了時刻"]`
  const edit=async(id)=>{await b.click(`${row(id)} .entry-time-control > button`);await b.until(`!!document.querySelector(${JSON.stringify(end(id))})`,'Inline input')}
  const waitClosed=id=>b.until(`!document.querySelector(${JSON.stringify(row(id)+" select,"+row(id)+" input,"+row(id)+" .project-picker,"+row(id)+" .tag-picker")})`,'Edit committed')
  const shot=async(name)=>{await b.evaluate('window.scrollTo(0,0)');const {cssContentSize}=await b.send('Page.getLayoutMetrics');const {data}=await b.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width:cssContentSize.width,height:cssContentSize.height,scale:1}});await mkdir('../docs/screenshots/entry-inline',{recursive:true});await writeFile(`../docs/screenshots/entry-inline/${name}.png`,Buffer.from(data,'base64'))}
  await t.test('Calendar is default; List preserves Week/date and groups only Entries newest first',async()=>{
    const before=await b.evaluate('[document.querySelector(".calendar-period-label").textContent,document.querySelector("[aria-label=カレンダー表示] [aria-pressed=true]").textContent]')
    await b.click('.home-view-switch button:last-child');await b.until('document.querySelectorAll(".time-entry-log-row").length===3','Entries')
    assert.deepEqual(await b.evaluate('[document.querySelector(".calendar-period-label").textContent,document.querySelector("[aria-label=カレンダー表示] [aria-pressed=true]").textContent]'),before)
    assert.deepEqual(await b.evaluate('Array.from(document.querySelectorAll("[data-entry-date]")).map(e=>e.dataset.entryDate)'),['2026/10/07','2026/10/06'])
    assert.deepEqual(await b.evaluate('Array.from(document.querySelectorAll(".time-entry-log-row")).map(e=>e.dataset.entryId)'),['3','1','2'])
    assert.match(await b.evaluate('document.querySelector("[data-entry-date]").textContent'),/合計 2時間/)
    assert.match(await b.evaluate(`document.querySelector('${row(2)}').textContent`),/23:40 - 00:20 \(\+1日\).*40分/)
    assert.equal(await b.evaluate('document.querySelectorAll(".home-entry-list [data-schedule-block-id]").length'),0)
    await shot('home-list')
  })
  await t.test('Enter commits once; moving between date/time Inputs does not save; Escape discards',async()=>{
    await edit(1);await input(end(1),'10:15')
    await b.evaluate(`document.querySelector('${row(1)} input[aria-label="開始時刻"]').focus()`)
    assert.equal(patches.length,0)
    await input(end(1),'10:15');await key('Enter');await waitClosed(1)
    assert.equal(patches.length,1);assert.equal(patches[0].input.endedAt,'2026-10-07T01:15:00.000Z')
    assert.match(await b.evaluate(`document.querySelector('${row(1)} .entry-log-duration').textContent`),/1時間15分/)
    await edit(1);await input(end(1),'10:30');await key('Escape');await waitClosed(1)
    assert.equal(patches.length,1)
    assert.equal(await b.evaluate('!!document.querySelector(".home-entry-list .composer-footer,.task-editor-panel,.task-detail")'),false)
    assert(!await b.evaluate('document.querySelector(".home-entry-list").textContent.includes("保存")'))
  })
  await t.test('Row-outside blur saves; invalid range does not PATCH; conflict retains draft and error',async()=>{
    await edit(1);await input(end(1),'10:20');await b.evaluate('document.querySelector(".home-view-switch button:last-child").focus()');await waitClosed(1)
    assert.equal(patches.length,2)
    await edit(1);await input(end(1),'08:00');await key('Enter');await b.until('!!document.querySelector(".time-entry-log-row [role=alert]")','Validation')
    assert.equal(patches.length,2);assert.equal(await b.evaluate(`document.querySelector('${end(1)}').value`),'08:00')
    reject=true;await input(end(1),'10:30');await key('Enter');await b.until('document.querySelector(".time-entry-log-row [role=alert]")?.textContent.includes("重ならない時間")','Overlap')
    assert.equal(patches.length,3);assert.equal(await b.evaluate(`document.querySelector('${end(1)}').value`),'10:30')
    await b.until(`document.activeElement===document.querySelector('${end(1)}') && !document.querySelector('${end(1)}').disabled`,'Focus retained after error')
    await shot('home-overlap');reject=false;await key('Escape');await waitClosed(1)
  })
  await t.test('Aligned Home columns, full Cell hit areas and isolated Project/Tag editors',async()=>{
    const grids=await b.evaluate('Array.from(document.querySelectorAll(".home-entry-table thead tr")).map(row=>Array.from(row.children).map(e=>{const r=e.getBoundingClientRect();return [r.x,r.width]}))')
    assert.deepEqual(grids[0],grids[1])
    const cell=field=>`${row(2)} [data-label="${field}"]`
    const blank=async selector=>{const r=await b.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.right-2,y:r.top+2}})()`);await b.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...r});await b.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...r})}
    await blank(cell('タスク名'));await b.until(`!!document.querySelector('${row(2)} select')`,'Task Cell full hit')
    assert.equal(await b.evaluate(`document.querySelectorAll('${row(2)} .entry-inline-dates,${row(2)} .project-picker,${row(2)} .tag-picker').length`),0)
    await key('Escape');await waitClosed(2)
    await blank(cell('プロジェクト名'));await b.until(`!!document.querySelector('${row(2)} .project-picker-popup')`,'Project Cell full hit')
    assert.equal(await b.evaluate(`document.querySelectorAll('${row(2)} select,${row(2)} .entry-inline-dates').length`),0)
    await b.click(`${row(2)} [data-project-id="2"]`);await b.until(`!document.querySelector('${row(2)} .project-picker-popup')`,'Project chosen')
    await b.until(`!document.querySelector('${row(2)} .project-picker-trigger').disabled`,'Project chosen');await b.evaluate(`document.querySelector('${row(2)} .project-picker-trigger').focus()`);const before=patches.length;await key('Enter');await waitClosed(2)
    assert.equal(patches.length,before+1);assert.equal(patches.at(-1).input.projectIdSnapshot,2);assert.equal(tasks[0].projectId,1)
    await blank(cell('プロジェクト名'));await b.until(`!!document.querySelector('${row(2)} .project-picker-popup')`,'Project reopened')
    await b.click(`${row(2)} [data-project-id="1"]`);await b.until(`!document.querySelector('${row(2)} .project-picker-trigger').disabled`,'Project chosen');await b.evaluate(`document.querySelector('${row(2)} .project-picker-trigger').focus()`);await key('Enter');await waitClosed(2)
    await blank(cell('タグ'));await b.until(`!!document.querySelector('${row(2)} .tag-picker-popup')`,'Tag Cell full hit')
    assert.equal(await b.evaluate(`document.querySelectorAll('${row(2)} select,${row(2)} .entry-inline-dates').length`),0)
    await b.evaluate(`Array.from(document.querySelectorAll('${row(2)} .tag-picker-options label')).find(e=>e.textContent.includes('Tag 2')).querySelector('input').click()`)
    assert.equal(taskWrites.length,0)
    await b.click(`${row(2)} .tag-picker-trigger`);await b.evaluate(`document.querySelector('${row(2)} .tag-picker-trigger').focus()`);await key('Enter');await waitClosed(2)
    assert.deepEqual(taskWrites.at(-1),{id:1,input:{tagIds:[1,2]}})
    assert(await b.evaluate(`document.querySelector('${row(1)} [data-label="タグ"]').textContent.includes('Tag 2')`))
    await blank(cell('タグ'));await b.until(`!!document.querySelector('${row(2)} .tag-picker-popup')`,'Tags again')
    await b.evaluate(`Array.from(document.querySelectorAll('${row(2)} .tag-picker-options label')).find(e=>e.textContent.includes('Tag 2')).querySelector('input').click()`)
    await b.click(`${row(2)} .tag-picker-trigger`);await b.evaluate(`document.querySelector('${row(2)} .tag-picker-trigger').focus()`);await key('Enter');await waitClosed(2)
    await blank(cell('記録'));await b.until(`!!document.querySelector('${end(2)}')`,'Duration edits interval')
    assert.equal(await b.evaluate(`document.querySelectorAll('${row(2)} select').length`),0)
    await key('Escape');await waitClosed(2)
    await b.click(`${row(2)} .entry-menu summary`)
    assert.deepEqual(await b.evaluate(`Array.from(document.querySelectorAll('${row(2)} .entry-menu button')).map(e=>e.textContent)`),['削除'])
    await b.click(`${row(2)} .entry-menu summary`)
  })
  await t.test('Snapshot null and save failures retain edits; moving across Cell whitespace does not save',async child=>{
    const diagnostic=await startEntryInlineDiagnostics(b)
    child.after(async()=>child.diagnostic('Entry Escape trace: '+await diagnostic.finish()))
    const project=async value=>{
      await b.click(`${row(2)} [data-label="プロジェクト名"] > button`);await b.until(`!!document.querySelector('${row(2)} .project-picker-popup')`,'Project')
      await b.click(`${row(2)} [data-project-id="${value}"]`);await b.until(`!document.querySelector('${row(2)} .project-picker-trigger').disabled`,'Chosen')
      await b.evaluate(`document.querySelector('${row(2)} .project-picker-trigger').focus()`);await key('Enter')
    }
    await project('');await waitClosed(2);assert.equal(entries.find(e=>e.id===2).projectIdSnapshot,null)
    await project('1');await waitClosed(2)
    reject=true;await project('2');await b.until(`!!document.querySelector('${row(2)} [role=alert]')`,'Project failure retained')
    assert.equal(entries.find(e=>e.id===2).projectIdSnapshot,1)
    assert.equal(await b.evaluate(`document.querySelector('${row(2)} input[name=projectId]').value`),'2')
    reject=false;await key('Escape');await waitClosed(2)
    await b.click(`${row(2)} [data-label="タグ"] > button`);await b.until(`!!document.querySelector('${row(2)} .tag-picker-popup')`,'Tag')
    await b.evaluate(`Array.from(document.querySelectorAll('${row(2)} .tag-picker-options label')).find(e=>e.textContent.includes('Tag 2')).querySelector('input').click()`)
    await b.click(`${row(2)} .tag-picker-trigger`);await b.evaluate(`document.querySelector('${row(2)} .tag-picker-trigger').focus()`)
    const beforeTagFailure=taskWrites.length
    rejectTags=true;await key('Enter');await b.until(`!!document.querySelector('${row(2)} [role=alert]')`,'Tag failure retained')
    assert.deepEqual(tasks[0].tags.map(t=>t.id),[1]);assert(await b.evaluate(`!!document.querySelector('${row(2)} .tag-picker')`))
    assert.equal(taskWrites.length,beforeTagFailure+1,'One Enter must issue one Task tag PUT')
    await b.until(`document.activeElement===document.querySelector('${row(2)} .tag-picker-trigger') && !document.querySelector('${row(2)} .tag-picker-trigger').disabled`,'Tag failure restores Focus automatically')
    rejectTags=false;await key('Escape');await waitClosed(2)
    assert.equal(taskWrites.length,beforeTagFailure+1,'Escape never resaves the failed draft')
    await b.click(`${row(2)} .entry-task-value`);await b.until(`!!document.querySelector('${row(2)} select')`,'Task')
    const before=patches.length
    const r=await b.evaluate(`(()=>{const r=document.querySelector('${row(2)} [data-label="計測期間"]').getBoundingClientRect();return {x:r.right-2,y:r.top+2}})()`)
    await b.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...r});await b.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...r})
    await b.until(`!!document.querySelector('${end(2)}')`,'Interval whitespace')
    assert.equal(patches.length,before);await key('Escape');await waitClosed(2)
  })
  await t.test('Task selection reuses native manual selector and preserves historical Project and current Tags',async()=>{
    await b.click(`${row(1)} .entry-task-value`)
    await b.until(`!!document.querySelector('${row(1)} select')`,'Task select')
    await b.evaluate(`(()=>{const e=document.querySelector('${row(1)} select');e.value='2';e.dispatchEvent(new Event('change',{bubbles:true}));e.focus()})()`)
    await key('Enter');await waitClosed(1)
    assert.equal(patches.at(-1).input.taskId,2);assert.equal(entries.find(e=>e.id===1).projectIdSnapshot,1)
    await b.until(`document.querySelector('${row(1)} .entry-task-value')?.textContent==='Task 2'`,'Task updated')
    assert.match(await b.evaluate(`document.querySelector('${row(1)} ').textContent`),/Blue.*Tag 2/)
    assert.equal(await b.evaluate(`document.querySelectorAll('${row(1)} .tag-picker').length`),0)
  })
  await t.test('Reports Summary hierarchy, Log columns and raw overnight editing synchronize all analyses',async()=>{
    await b.click('.icon-rail [aria-label="レポート"]');await b.until('!!document.querySelector(".report-tabs")','Reports');await analysis();await b.until('!!document.querySelector(".report-summary")','Analysis');await selectReportAnchor(b,'2026-10-07')
    assert.deepEqual(await b.evaluate('Array.from(document.querySelectorAll(".report-summary strong")).map(e=>e.textContent)'),['1時間','2時間40分','+1時間40分'])
    const borders=await b.evaluate('getComputedStyle(document.querySelector(".report-summary-actual")).borderTopColor')
    assert.notEqual(borders,'rgb(29, 78, 216)')
    assert.equal(await b.evaluate('document.querySelector(".report-summary-difference small").textContent'),'計画と記録の差')
    await activity()
    assert.deepEqual(await b.evaluate('Array.from(document.querySelectorAll("[data-report-table=activity] thead th")).map(e=>e.textContent)'),['タスク名','プロジェクト名','タグ','計測期間','日付','記録','⋮','時間計測'])
    assert.equal(await b.evaluate(`document.querySelector('${row(2)} .entry-time-control > button').textContent`),'00:00〜00:20')
    await edit(2)
    await shot('reports-editing')
    assert.equal(await b.evaluate(`document.querySelector('${row(2)} input[aria-label="開始日"]').value`),'2026/10/06')
    assert.equal(await b.evaluate(`document.querySelector('${row(2)} input[aria-label="開始時刻"]').value`),'23:40')
    await input(end(2),'00:30');await key('Enter');await waitClosed(2)
    assert.equal(patches.at(-1).input.startedAt,'2026-10-06T23:40:00+09:00')
    assert.equal(entries.filter(e=>e.id===2).length,1)
    await b.until(`document.querySelector('${row(2)} td:nth-child(6)')?.textContent==='30分'`,'Updated Activity contribution')
    assert.equal(await b.evaluate(`document.querySelector('${row(2)} td:nth-child(6)').textContent`),'30分')
    await analysis()
    await b.until('document.querySelectorAll(".report-summary strong")[1]?.textContent==="2時間50分"','Summary sync')
    assert.equal(await b.evaluate('document.querySelector(".report-donut-total strong").textContent'),'2時間50分')
    assert.match(await b.evaluate(`document.querySelector('[data-chart-hour="0"]').getAttribute("aria-label")`),/記録 30分/)
    assert.equal(await b.evaluate(`document.querySelector('[data-report-table=tasks] [data-report-id="1"] td:nth-child(4)').textContent`),'30分')
    assert.equal(await b.evaluate('!!document.querySelector(".time-entry-dialog,.task-editor-panel")'),false)
    await shot('reports-inline')
  })
  await t.test('Every Chart Mode provides visible hover/focus Tooltip with finite values',async()=>{
    for(const name of ['日','週','月','期間']){
      await b.evaluate(`Array.from(document.querySelectorAll('.report-mode button')).find(e=>e.textContent===${JSON.stringify(name)}).click()`)
      await b.until(`document.querySelector('.report-mode [aria-pressed=true]')?.textContent===${JSON.stringify(name)}`,'Mode')
      await b.evaluate(`document.querySelector('.period-chart-bar.actual').dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'mouse'}))`)
      await b.until('!!document.querySelector("[role=tooltip]")','Hover tooltip')
      assert.equal(await b.evaluate('document.querySelectorAll("[role=tooltip]").length'),1)
      assert.equal(await b.evaluate('document.querySelectorAll(".period-chart [title]").length'),0)
      assert.notEqual(await b.evaluate('getComputedStyle(document.querySelector(".period-chart-bar.actual")).cursor'),'help')
      if(name==='日')await shot('reports-tooltip')
      const text=await b.evaluate('document.querySelector("[role=tooltip]").textContent')
      assert.match(text,/計画済み/);assert.match(text,/記録/);assert.match(text,/差/);assert(!text.includes('NaN'))
      await b.evaluate(`document.querySelector('.report-tooltip-bars').dispatchEvent(new PointerEvent('pointerout',{bubbles:true,relatedTarget:document.body}))`)
      await b.until('!document.querySelector("[role=tooltip]")','Hover leave')
      await b.evaluate('document.querySelector(".report-period-label").focus();document.querySelector(".period-chart-bar.actual").focus()');await b.until('!!document.querySelector("[role=tooltip]")','Focus tooltip')
      await key('Escape');await b.until('!document.querySelector("[role=tooltip]")','Tooltip Escape')
      await b.evaluate(`document.querySelector('.period-chart-bar.actual').click()`)
      await b.until('document.querySelectorAll("[role=tooltip]").length===1','Tap tooltip')
      await b.evaluate(`document.querySelectorAll('.period-chart-bar.actual')[1].dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'mouse'}))`)
      assert.equal(await b.evaluate('document.querySelectorAll("[role=tooltip]").length'),1)
      await b.evaluate(`document.querySelectorAll('.period-chart-bar.actual')[1].dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
      await b.until('!document.querySelector("[role=tooltip]")','Only active tooltip closed')
    }
  })
  await t.test('Row menu deletes only the selected Entry and Reports refresh stays populated',async()=>{
    await b.evaluate(`Array.from(document.querySelectorAll('.report-mode button')).find(e=>e.textContent==='日').click()`)
    await b.until(`document.querySelector('.report-mode [aria-pressed=true]')?.textContent==='日' && document.querySelector('.report-page')?.getAttribute('aria-busy')!=='true'`,'Day Mode committed')
    await selectReportAnchor(b,'2026-10-07')
    await activity()
    await b.until(`!!document.querySelector('${row(3)} .entry-menu summary')`,'Selected day Activity loaded')
    await b.click(`${row(3)} .entry-menu summary`);await b.click(`${row(3)} .entry-menu .danger`)
    await b.until(`!document.querySelector('${row(3)}')`,'Deleted');assert.deepEqual(deletes,[3])
    await analysis()
    await b.until('document.querySelectorAll(".report-summary strong")[1]?.textContent==="1時間50分"','Delete aggregate')
    assert(await b.evaluate('!!document.querySelector(".report-summary,.period-chart-panel")'))
  })
  await t.test('Home retains Day/Week/Month date across toggles, empty periods and narrow views',async()=>{
    await b.click('.icon-rail [aria-label="ホーム"]');await b.until('!!document.querySelector(".home-entry-list")','List retained')
    for(const width of [1920,768,375]){
      await b.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false})
      assert(await b.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),`Home ${width}`)
      await shot(`home-${width}`)
      await b.click('.icon-rail [aria-label="レポート"]');await b.until('!!document.querySelector(".report-tabs")','Reports');await analysis();await b.until('!!document.querySelector(".report-summary")','Analysis')
      assert(await b.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),`Reports ${width}`)
      await b.click('.icon-rail [aria-label="ホーム"]');await b.until('!!document.querySelector(".home-entry-list")','Home')
    }
    await b.send('Emulation.setDeviceMetricsOverride',{width:1920,height:1080,deviceScaleFactor:1,mobile:false})
    for(const name of ['日','月','週']){
      await b.evaluate(`Array.from(document.querySelectorAll('[aria-label=カレンダー表示] button')).find(e=>e.textContent===${JSON.stringify(name)}).click()`)
      await b.until(`document.querySelector('[aria-label=カレンダー表示] [aria-pressed=true]')?.textContent===${JSON.stringify(name)}`,'Calendar Mode')
      await b.until(`document.querySelector('.calendar-period-navigation').dataset.mode===${JSON.stringify({日:'day',週:'week',月:'month'}[name])}`,'Displayed Calendar committed')
      const before=await b.evaluate('document.querySelector(".calendar-period-label").textContent')
      await b.click('.home-view-switch button:first-child');await b.click('.home-view-switch button:last-child')
      assert.equal(await b.evaluate('document.querySelector(".calendar-period-label").textContent'),before)
    }
    await b.click('.calendar-period-navigation [aria-label="次の期間"]')
    await b.until('document.querySelector(".home-entry-list").textContent.includes("この期間の記録はありません")','Empty')
    assert.deepEqual(errors,[])
  })
  await t.test('Shared Timer starts from Task actions and stops from Project records, preserving snapshots',async()=>{
    await b.click('.icon-rail [aria-label="\u30bf\u30b9\u30af"]');await b.until(`!!document.querySelector('[data-task-id="1"] .task-row-actions')`,'Task actions')
    const selector='[data-task-id="1"] .task-timer-always'
    await b.until(`document.querySelector('${selector}')?.disabled===false`,'Task Timer mutation completed');await b.click(selector);await b.until(`document.querySelector('${selector}').getAttribute('aria-pressed')==='true'`,'Running action')
    assert.equal(timerWrites.length,1)
    await b.click('.icon-rail [aria-label="\u30db\u30fc\u30e0"]');await b.until('!!document.querySelector(".home-entry-list")','Home')
    await b.click('.today-button')
    await b.until('document.querySelectorAll(".home-entry-list .task-timer-always[aria-pressed=true]").length>0','Home active Task synchronized')
    assert(await b.evaluate('Array.from(document.querySelectorAll(".home-entry-list .task-timer-always[aria-pressed=true]")).length>0'))
    await b.click('.icon-rail [aria-label="\u30d7\u30ed\u30b8\u30a7\u30af\u30c8"]');await b.until('!!document.querySelector(".project-card")','Projects')
    await b.click('.project-card-open');await b.until('!!document.querySelector(".project-tabs")','Detail')
    await b.click('.project-tabs button:nth-child(2)');await b.until('document.querySelectorAll(".project-records [data-entry-id]").length===2','Snapshot records')
    assert.deepEqual(await b.evaluate('Array.from(document.querySelectorAll(".project-records [data-entry-id]")).map(e=>e.dataset.entryId)'),['1','2'])
    assert.equal(await b.evaluate('document.querySelectorAll(".project-records thead th").length'),7)
    assert.equal(await b.evaluate(`document.querySelectorAll('.project-records [data-label="プロジェクト名"]').length`),0)
    await edit(2);await input(end(2),'00:40');await key('Enter');await waitClosed(2)
    assert.equal(patches.at(-1).input.startedAt,'2026-10-06T23:40:00+09:00');assert.equal(entries.find(e=>e.id===2).projectIdSnapshot,1)
    await b.click('.project-records [data-entry-id="2"] .task-timer-always');await b.until('!document.querySelector(".project-records .task-timer-always[aria-pressed=true]")','Stopped')
    assert.deepEqual(timerWrites.map(r=>r.path),['/tasks/time/start','/tasks/time/stop'])
    await b.click('.project-tabs button:first-child');await b.until('!!document.querySelector(".task-row-actions")','Project Task actions')
    await b.until(`document.querySelector('${selector}')?.disabled===false`,'Task Timer mutation completed');await b.click(selector);await b.until(`document.querySelector('${selector}').getAttribute('aria-pressed')==='true'`,'Project Task start')
    await b.until(`document.querySelector('${selector}')?.disabled===false`,'Task Timer mutation completed');await b.click(selector);await b.until(`document.querySelector('${selector}').getAttribute('aria-pressed')==='false'`,'Project Task stop')
  })
  await t.test('Reports tabs preserve period and Filters without fetching; monthly Activity and responsive Timer remain usable',async()=>{
    await b.click('.icon-rail [aria-label="\u30ec\u30dd\u30fc\u30c8"]');await analysis();await b.until('!!document.querySelector(".report-summary")','Analysis')
    const before=await b.evaluate('[document.querySelector(".report-period-label").textContent,document.querySelector(".report-mode [aria-pressed=true]").textContent]')
    await b.until('document.querySelector(".reports-v2").getAttribute("aria-busy")==="false"','Report fully ready');const count=reads.filter(p=>p.startsWith('/reports')||p==='/schedule-blocks').length;await activity();assert.equal(await b.evaluate('!!document.querySelector(".report-summary")'),false);await analysis();assert.equal(reads.filter(p=>p.startsWith('/reports')||p==='/schedule-blocks').length,count)
    assert.deepEqual(await b.evaluate('[document.querySelector(".report-period-label").textContent,document.querySelector(".report-mode [aria-pressed=true]").textContent]'),before)
    assert.equal(await b.evaluate('document.querySelectorAll(".report-target-period").length'),0)
    await b.evaluate('Array.from(document.querySelectorAll(".report-mode button")).find(e=>e.textContent==="\u6708").click()');await b.until('document.querySelector(".report-mode [aria-pressed=true]")?.textContent==="\u6708"','Month')
    await activity();assert(await b.evaluate('document.querySelectorAll(".report-activity [data-entry-id]").length>0'))
    for(const width of [768,375]){await b.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});assert(await b.evaluate('document.documentElement.scrollWidth<=innerWidth+1'));assert(await b.evaluate('Array.from(document.querySelectorAll(".report-activity .task-timer-always")).every(e=>{const r=e.getBoundingClientRect();return r.right<=innerWidth+1})'))}
    await b.send('Emulation.setDeviceMetricsOverride',{width:1920,height:1080,deviceScaleFactor:1,mobile:false})
  })
  await t.test('Demo editing is disabled, Summary differentiates shorter/equal with aligned values, no writes',async()=>{
    const count=patches.length,deleted=deletes.length
    await b.evaluate('document.documentElement.dataset.entryDemoNavigation="pending";window.location.search="?reportDemo=1"')
    await b.until('document.documentElement?.dataset.entryDemoNavigation!=="pending" && new URLSearchParams(location.search).get("reportDemo")==="1" && !!document.querySelector(".icon-rail [aria-label=レポート]")','New Demo document and Navigation')
    await b.click('.icon-rail [aria-label="レポート"]');await b.until('!!document.querySelector("[data-report-demo]")','Demo')
    await selectReportAnchor(b,'2026-10-08')
    assert.deepEqual(await b.evaluate('Array.from(document.querySelectorAll(".report-summary strong")).map(e=>e.textContent)'),['5時間30分','5時間','-30分'])
    assert.equal(await b.evaluate('document.querySelector(".report-summary-difference small").textContent'),'計画と記録の差')
    const positions=await b.evaluate('Array.from(document.querySelectorAll(".report-summary strong")).map(e=>e.getBoundingClientRect().y)')
    assert(Math.max(...positions)-Math.min(...positions)<1)
    await activity()
    assert(await b.evaluate('Array.from(document.querySelectorAll(".report-activity .entry-inline-value,.report-activity .entry-menu button")).every(e=>e.disabled)'))
    await analysis()
    await b.click('.report-filters [data-filter=project] > button')
    await b.evaluate('Array.from(document.querySelectorAll(".report-filters .task-filter-popover label")).find(e=>e.textContent.trim()==="未所属").querySelector("input").click()')
    await b.click('.report-filters [data-filter=project] > button')
    assert.deepEqual(await b.evaluate('Array.from(document.querySelectorAll(".report-summary strong")).map(e=>e.textContent)'),['0分','0分','－'])
    assert.equal(await b.evaluate('document.querySelector(".report-summary-difference small").textContent'),'計画と記録の差')
    const filteredPeriod=await b.evaluate('document.querySelector(".report-period-label").textContent')
    await activity()
    assert.equal(await b.evaluate('document.querySelectorAll(".report-activity [data-entry-id]").length'),0)
    assert(await b.evaluate('!!document.querySelector(".report-filters .task-applied-filters")'))
    assert.equal(await b.evaluate('document.querySelector(".report-period-label").textContent'),filteredPeriod)
    await analysis()
    assert.equal(patches.length,count);assert.equal(deletes.length,deleted)
  })
})
