
import {openBrowser} from './browser.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {positionPopup} from '../src/popupPosition.ts';
test('Popup placement preserves caller policies and lifecycle (all API mocked)',{timeout:240000},async t=>{
const phase='test';
const dir=await mkdtemp(path.join(tmpdir(),'popup-layout-'+phase+'-'));
const b=await openBrowser();t.after(()=>b.close());
const tags=[1,2,3,4,5,6,7,8,9,10].map(id=>({id,name:'Tag '+id,color:'#368AD8'}));
const projects=[1,2,3,4,5,6,7,8].map(id=>({id,name:'Project '+id,color:'#368AD8',taskCount:30,completedCount:0,estimatedMinutes:180,actualMinutes:90}));
const initial=Array.from({length:30},(_,i)=>i+1).map(id=>({id,title:'Task '+id,status:'NOT_STARTED',completed:false,projectId:1,projectName:'Project 1',tags,estimatedMinutes:60,actualMinutes:30,priority:'HIGH',startDate:null,deadline:'2026-10-20',createdAt:'2026-10-01',updatedAt:'2026-10-01'}));
let tasks=structuredClone(initial);
const errors=[],writes=[];
b.listeners.push(m=>{
 if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);
 if(m.method!=='Fetch.requestPaused')return;
 const {requestId,request}=m.params,u=new URL(request.url);
 void(async()=>{
  if(u.origin===new URL(b.url).origin)return b.send('Fetch.continueRequest',{requestId});
  assert.equal(u.hostname,'localhost');assert.equal(u.port,'8000');
  if(request.method==='OPTIONS')return b.fulfill(requestId,{});
  if(request.method!=='GET'){
   const body=JSON.parse(request.postData);
   writes.push({method:request.method,path:u.pathname,body});
   assert.equal(request.method,'PUT');assert.equal(u.pathname,'/tasks/1');
   const task=tasks[0];Object.assign(task,body);if('status' in body)task.completed=body.status==='COMPLETED';
   return b.fulfill(requestId,task);
  }
  let data=[];
  if(u.pathname==='/tasks')data=tasks;
  else if(u.pathname==='/projects')data=projects;
  else if(u.pathname==='/tags')data=tags;
  else if(u.pathname==='/tasks/time/active')data={taskId:null,running:false,startedAt:null};
  else if(u.pathname==='/tasks/inbox')data=tasks;
  else if(/^\/tasks\/\d+$/.test(u.pathname))data=tasks.find(t=>t.id===Number(u.pathname.split('/')[2]));
  else if(u.pathname==='/reports/daily')data={date:u.searchParams.get('date'),tasks:[],plannedOccupiedMinutes:0,dailyEstimatedMinutes:0,dailyActualMinutes:0,dailyDifference:0};
  await b.fulfill(requestId,data);
 })().catch(e=>{if(!/Invalid [Ii]nterceptionId|Invalid requestId/.test(e.message))errors.push(String(e))});
});
await b.send('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]});
await b.send('Emulation.setTimezoneOverride',{timezoneId:'Asia/Tokyo'});
await b.send('Page.addScriptToEvaluateOnNewDocument',{source:'(()=>{const D=Date,n='+Date.parse('2026-10-07T03:00:00Z')+';window.Date=class extends D{constructor(...a){super(...(a.length?a:[n]))}static now(){return n}}})()'});


await b.send('Page.addScriptToEvaluateOnNewDocument',{source:'(()=>{const add=window.addEventListener.bind(window),remove=window.removeEventListener.bind(window),tracked=new Map();window.addEventListener=(type,fn,options)=>{if(type==="resize"||type==="scroll"){const key=type+Boolean(options===true||options?.capture);if(!tracked.has(key))tracked.set(key,new Set());tracked.get(key).add(fn)}return add(type,fn,options)};window.removeEventListener=(type,fn,options)=>{tracked.get(type+Boolean(options===true||options?.capture))?.delete(fn);return remove(type,fn,options)};window.__popupListeners=()=>[...tracked].filter(([,value])=>value.size).map(([key,value])=>[key,value.size]).sort();const active=new Set(),RO=window.ResizeObserver;window.ResizeObserver=class extends RO{observe(...args){active.add(this);return super.observe(...args)}disconnect(){active.delete(this);return super.disconnect()}};window.__popupObserverCount=()=>active.size})()'});
const listenerCounts=()=>b.evaluate('({listeners:window.__popupListeners(),observers:window.__popupObserverCount()})');
const positions=[];
const esc=()=>b.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
const exists=s=>'document.querySelector('+JSON.stringify(s)+')';
async function frames(){await b.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')}
async function popupRecord(context,width,kind,trigger,popup,state){
 await frames();
 const measurement=await b.evaluate('('+((trigger,popup)=>{
  const a=document.querySelector(trigger),p=document.querySelector(popup);
  const r=e=>{const x=e.getBoundingClientRect();return {left:x.left,right:x.right,top:x.top,bottom:x.bottom,width:x.width,height:x.height}};
  const box=r(p),c=getComputedStyle(p),hit=document.elementFromPoint(Math.min(document.documentElement.clientWidth-1,box.left+box.width/2),Math.min(innerHeight-1,box.top+Math.min(box.height/2,80)));
  return {anchor:r(a),popup:box,viewport:{width:document.documentElement.clientWidth,height:innerHeight},position:c.position,zIndex:c.zIndex,maxHeight:c.maxHeight,overflowY:c.overflowY,hitInside:!!hit&&p.contains(hit),modal:!!p.closest('dialog[open]')};
 }).toString()+')('+JSON.stringify(trigger)+','+JSON.stringify(popup)+')');

 positions.push({context,width,kind,state,...measurement});
 const expected=positionPopup(measurement.anchor,measurement.popup,measurement.viewport,{align:kind==='menu'||kind==='deadline'?'end':'start',vertical:kind==='status'||kind==='priority'?'clamp':'flip',gap:kind==='tag'?8:4});
 assert(Math.abs(expected.left-measurement.popup.left)<1&&Math.abs(expected.top-measurement.popup.top)<1,kind+' follows its own placement policy after '+state);
 assert(measurement.popup.left>=7.5&&measurement.popup.top>=7.5,kind+' preserves top/left inset');
 assert(measurement.popup.right<=measurement.viewport.width-7.5&&measurement.popup.bottom<=measurement.viewport.height-7.5,kind+' fits the visible viewport');
 assert(measurement.hitInside,kind+' is above Header and remains operable');

}
try{
 for(const width of [1920,1024,768,601,600,375])for(const context of ['tasks','project','homeEditor','tasksEditor'])await t.test(context+' '+width+'px placement, scroll, resize and lifecycle',async()=>{
  await b.send('Emulation.setDeviceMetricsOverride',{width,height:1080,deviceScaleFactor:1,mobile:false});
  await b.navigate();await b.until("document.querySelector('.icon-rail')",'Navigation');
  if(context!=='homeEditor'){
   await b.click('.icon-rail [aria-label="'+(context==='project'?'\u30d7\u30ed\u30b8\u30a7\u30af\u30c8':'\u30bf\u30b9\u30af')+'"]');
   if(context==='project'){await b.until("document.querySelector('.project-card-open')",'Project');await b.click('.project-card-open')}
   await b.until("document.querySelector('[data-task-id=\"1\"] .task-status-trigger')",'Rows');
  }else await b.until("document.querySelector('[data-inbox-task-id=\"1\"] .inbox-card-open')",'Home');
  const modal=context.endsWith('Editor');
  if(modal){
   if(context==='homeEditor')await b.until('(()=>{const e=document.querySelector(\'[data-inbox-task-id="1"] .inbox-card-open\');if(!e||e.disabled)return false;e.focus();e.click();return true})()','Enabled Home card');
   else {await b.click('[data-task-id="1"] summary');await b.click('[data-task-id="1"] .task-row-edit')}
   await b.until("document.querySelector('.task-editor-panel[open]')",'Editor');
  }
  await b.until("document.querySelector('.app-layout').getAnimations().every(a=>a.playState!=='running')",'Layout settled');
  const scope=modal?'.task-editor-panel[open]':'[data-task-id="1"]';
  const selectors=[['status','.task-status-trigger','.task-table-status .shared-picker-popup'],['priority','.task-priority-pill','.priority-popup'],['project','.project-picker-trigger','.project-picker-popup'],['tag','.tag-picker-trigger','.tag-picker-popup']];
  for(const [kind,button,suffix]of selectors){
   if(kind==='project'&&context==='project')continue;
   const trigger=scope+' '+button,popup=scope+' '+(kind==='status'&&modal?'.task-status-field .shared-picker-popup':suffix);
   await b.evaluate(exists(trigger)+'.scrollIntoView({block:"center",inline:"nearest"})');

   const listeners=await listenerCounts();
   await b.click(trigger);await b.until(exists(popup),'Popup');

   await popupRecord(context,width,kind,trigger,popup,'normal');
   if(!modal){
    await b.evaluate("document.querySelector('.task-table-scroll').scrollLeft+=120");
    await popupRecord(context,width,kind,trigger,popup,'table-scroll');
    await b.evaluate("(()=>{const a="+exists(trigger)+".getBoundingClientRect();window.scrollBy(0,a.top-(innerHeight-50))})()");
    await popupRecord(context,width,kind,trigger,popup,'bottom-edge');
   }else{
    await b.evaluate("document.querySelector('.task-editor-panel').scrollTop+=90");
    await popupRecord(context,width,kind,trigger,popup,'drawer-scroll');
   }
   await b.send('Emulation.setDeviceMetricsOverride',{width:Math.max(320,width-31),height:320,deviceScaleFactor:1,mobile:false});
   await popupRecord(context,width,kind,trigger,popup,'short-resize');
   if(kind==='tag'){
    await b.click(scope+' .tag-picker-create');
    await popupRecord(context,width,kind,trigger,popup,'create-content');
   }
   if(kind==='project'){
    await b.click(scope+' .project-picker-create');
    await b.until("document.querySelector('.project-composer[open]')",'Nested Project creator');
    await esc();await b.until("!document.querySelector('.project-composer[open]')",'Nested Creator closed');
   }else{await esc();await b.until('!'+exists(popup),'Popup closed')}
   await b.send('Emulation.setDeviceMetricsOverride',{width,height:1080,deviceScaleFactor:1,mobile:false});

   await frames();
   assert.deepEqual(await listenerCounts(),listeners,'Closing releases placement listeners and observers');
   await b.evaluate(exists(trigger)+'.scrollIntoView({block:"center",inline:"nearest"})');
   await b.click(trigger);await b.until(exists(popup),'Reopened Popup');
   if(kind==='status'||kind==='priority'){
    await b.send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40});
    assert(await b.evaluate(exists(popup)+'.contains(document.activeElement)'),'Keyboard stays in Picker');
   }
   await b.evaluate('document.querySelector('+JSON.stringify(modal?scope+' .composer-head h2':'.task-counts')+').dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}))');
   await b.until('!'+exists(popup),'Outside click closes only Picker');
   if(modal)assert(await b.evaluate('Boolean('+exists(scope)+')'),'Outside Picker click keeps Full Editor');
   await frames();assert.deepEqual(await listenerCounts(),listeners,'Repeated opening has no listener leak');
  }
  if(!modal){
   const trigger=scope+' summary',popup=scope+' .task-table-actions';
   await b.evaluate(exists(trigger)+'.scrollIntoView({block:"center",inline:"nearest"})');
   await b.click(trigger);await popupRecord(context,width,'menu',trigger,popup,'normal');await esc();
  }else{await b.click(scope+' .icon-close');await b.until("!document.querySelector('.task-editor-panel[open]')",'Editor closed')}
  const shot=await b.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  await writeFile(path.join(dir,width+'-'+context+'.png'),Buffer.from(shot.data,'base64'));
 });

 await t.test('TaskRow Menu and Deadline retain right alignment during scroll and resize',async()=>{
  for(const width of [1920,1024,768,601,600,375]){
   await b.send('Emulation.setDeviceMetricsOverride',{width,height:1080,deviceScaleFactor:1,mobile:false});
   await b.navigate();await b.until("document.querySelector('.icon-rail')",'Navigation');
   await b.click('.icon-rail [aria-label="\u30d7\u30ed\u30b8\u30a7\u30af\u30c8"]');
   await b.until("document.querySelector('.project-card-open')",'Project');await b.click('.project-card-open');
   await b.until("document.querySelector('[data-task-id=\"1\"] .task-table-deadline > button')",'Project Row');
   for(const [kind,trigger,popup]of [
    ['deadline','[data-task-id="1"] .task-table-deadline > button','[data-task-id="1"] .task-deadline-editor'],
    ['menu','[data-task-id="1"] summary','[data-task-id="1"] .task-table-actions'],
   ]){
    await b.evaluate(exists(trigger)+'.scrollIntoView({block:"center",inline:"nearest"})');
    await b.click(trigger);await b.until(exists(popup),'Right-aligned Popup');
    await popupRecord('project',width,kind,trigger,popup,'right-aligned-normal');
    if(kind==='deadline'){
     await b.click(popup+' .deadline-calendar-trigger');
     await b.until(exists(popup+' .deadline-calendar'),'Inline Calendar');
     await popupRecord('project',width,kind,trigger,popup,'calendar-expanded');
    }
    await b.evaluate("window.scrollBy(0,70);document.querySelector('.task-table-scroll').scrollLeft+=20");
    await popupRecord('project',width,kind,trigger,popup,'right-aligned-scroll');
    await b.send('Emulation.setDeviceMetricsOverride',{width,height:320,deviceScaleFactor:1,mobile:false});
    await popupRecord('project',width,kind,trigger,popup,'right-aligned-resize');
    if(kind==='deadline'){
     await b.evaluate(exists(popup+' input')+'.focus({preventScroll:true})');
     await esc();await b.until('!'+exists(popup+' .deadline-calendar'),'First Escape closes only inline Calendar');
     assert(await b.evaluate('Boolean('+exists(popup)+')'),'Deadline editor survives Calendar Escape');
    }
    await esc();await b.until(kind==='menu'?"!document.querySelector('[data-task-id=\"1\"] .task-row-menu[open]')":'!'+exists(popup),'Right-aligned Popup closed');
    await b.send('Emulation.setDeviceMetricsOverride',{width,height:1080,deviceScaleFactor:1,mobile:false});
   }
  }
 });
 await t.test('Oversized SingleSelect scrolls inside a short viewport',async()=>{
  await b.send('Emulation.setDeviceMetricsOverride',{width:375,height:180,deviceScaleFactor:1,mobile:false});
  await b.navigate();await b.until("document.querySelector('.icon-rail')",'Navigation');
  await b.click('.icon-rail [aria-label="\u30bf\u30b9\u30af"]');
  await b.until("document.querySelector('[data-task-id=\"1\"] .task-priority-pill')",'Priority Trigger');
  const trigger='[data-task-id="1"] .task-priority-pill',popup='[data-task-id="1"] .priority-popup';
  await b.evaluate(exists(trigger)+'.scrollIntoView({block:"center",inline:"nearest"})');
  await b.click(trigger);await b.until(exists(popup),'Priority Popup');
  await popupRecord('tasks',375,'priority',trigger,popup,'180px-height');
  await b.send('Input.dispatchKeyEvent',{type:'keyDown',key:'End',code:'End',windowsVirtualKeyCode:35});
  const bounds=await b.evaluate('(()=>{const p='+exists(popup)+',o=document.activeElement,r=o.getBoundingClientRect(),box=p.getBoundingClientRect();return {scroll:p.scrollTop,height:p.clientHeight,content:p.scrollHeight,visible:r.top>=box.top&&r.bottom<=box.bottom,inside:p.contains(o)}})()');
  assert(bounds.content>bounds.height&&bounds.scroll>0&&bounds.inside&&bounds.visible,'Last option stays accessible through popup scrolling');
  await esc();await b.until('!'+exists(popup),'Escape after internal scroll');
  assert(await b.evaluate('document.activeElement==='+exists(trigger)),'Escape restores Trigger focus');
 });
 assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
}finally{
 await writeFile(path.join(dir,'metrics.json'),JSON.stringify({phase,positions,writes,errors},null,2));
 console.log(JSON.stringify({dir,phase,measurements:positions.length,writes:writes.length,errors}));

}

});
