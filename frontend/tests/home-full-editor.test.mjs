import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { openBrowser } from './browser.mjs'
import { startMetadataBackend } from './metadata-backend.mjs'

test('Home Full Editor shares controls while all Task/Schedule fields stay draft until Footer save', { timeout: 180000 }, async t => {
  const { base, api } = await startMetadataBackend(t)
  const project = await api('/projects', { name: 'Blue Project', color: '#568BC7' })
  const tags = await Promise.all(['AAA', 'BBB', 'CCC'].map(name => api('/tags', { name, color: '#568BC7' })))
  const inbox = await api('/tasks', { title: 'Inbox edit' })
  const unset = await api('/tasks', { title: 'Unset edit' })
  const timed = await api('/tasks', { title: 'Timed edit' })
  const unsetBlock = await api('/schedule-blocks', { taskId: unset.id, date: '2026-10-07', type: 'TIME_UNSET', startTime: null, durationMinutes: null })
  const timedBlock = await api('/schedule-blocks', { taskId: timed.id, date: '2026-10-07', type: 'TIMED', startTime: '13:00', durationMinutes: 30 })
  const b = await openBrowser(); t.after(() => b.close())
  const writes = [], errors = []
  await b.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' })
  await b.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false })
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{const D=Date;window.Date=class extends D{constructor(...a){super(...(a.length?a:['2026-10-07T03:00:00Z']))}static now(){return ${Date.parse('2026-10-07T03:00:00Z')}}};window.__confirmAnswer=true;window.__confirmCount=0;window.confirm=()=>{window.__confirmCount++;return window.__confirmAnswer}})()` })
  b.listeners.push(message => {
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method !== 'Fetch.requestPaused') return
    const { request, requestId } = message.params, url = new URL(request.url)
    void (async () => {
      if (request.method === 'OPTIONS') return b.fulfill(requestId, {})
      if (request.method !== 'GET') writes.push({ path: url.pathname, method: request.method, body: request.postData ? JSON.parse(request.postData) : null })
      const response = await fetch(base + url.pathname + url.search, { method: request.method, ...(request.postData ? { headers: { 'Content-Type': 'application/json' }, body: request.postData } : {}) })
      await b.fulfill(requestId, await response.json(), response.status)
    })().catch(error => { if (!/Invalid InterceptionId|Invalid interceptionId|Invalid requestId|CDP connection closed/.test(String(error))) errors.push(String(error)) })
  })
  await b.send('Fetch.enable', { patterns: [{ urlPattern: 'http://localhost:8000/*', requestStage: 'Request' }] })
  await b.navigate(); await b.until(`document.querySelector('[data-inbox-task-id="${inbox.id}"] .inbox-card-open')`, 'Home loaded')
  const editor = '.home-full-editor[open]'
  const input = async (name, value) => b.evaluate(`(()=>{const e=document.querySelector('${editor} [name="${name}"]');e.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  const key = key => b.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: key === 'Escape' ? 27 : 13 })
  const shot = async name => {
    await mkdir(new URL('../../docs/screenshots/home-full-editor/',import.meta.url),{recursive:true})
    await writeFile(new URL(`../../docs/screenshots/home-full-editor/${name}.png`,import.meta.url),Buffer.from((await b.send('Page.captureScreenshot',{format:'png'})).data,'base64'))
  }
  const openInbox = async () => { await b.until(`(()=>{const card=document.querySelector('[data-inbox-task-id="${inbox.id}"] .inbox-card-open');if(!card||card.disabled)return false;card.click();return true})()`, 'Inbox ready to open'); await b.until(`document.querySelector('${editor}')`, 'Full Editor') }
  const footer = async () => { await b.click(editor + ' .composer-footer [type=submit]'); await b.until(`!document.querySelector('${editor}')`, 'Footer saved') }
  const close = async () => { await b.click(editor + ' .icon-close'); await b.until(`!document.querySelector('${editor}')`, 'Closed') }
  await t.test('Shared Pill/Options edit draft only; child Escape preserves Drawer; dirty Cancel/Close contract remains', async () => {
    await openInbox(); const baseline = writes.length
    await input('title', 'Draft title')
    await b.click(editor + ' .task-status-trigger'); await b.click(editor + ' [data-value=IN_PROGRESS]')
    await b.click(editor + ' .project-picker-trigger'); await b.click(editor + ` [data-project-id="${project.id}"]`)
    await b.click(editor + ' .task-priority-pill'); await b.click(editor + ' [data-priority=HIGH]')
    await b.click(editor + ' .tag-picker-trigger')
    for (const tag of tags) await b.click(editor + ` .tag-picker-options label:has([data-tag-id="${tag.id}"]) input`)
    assert(await b.evaluate(`document.querySelectorAll('${editor} .tag-picker-trigger .tag-chip').length===3 && !!document.querySelector('${editor} .tag-picker-popup')`))
    await key('Escape')
    await input('deadline', '20261020'); await input('estimatedMinutes', '2.5h')
    await b.evaluate(`document.querySelector('${editor} [name=title]').focus()`)
    assert.equal(writes.length, baseline)
    for (const [trigger, popup] of [['.task-status-trigger','.task-table-status .shared-picker-popup'],['.task-priority-pill','.priority-popup'],['.project-picker-trigger','.project-picker-popup'],['.tag-picker-trigger','.tag-picker-popup']]) {
      await b.click(editor + ' ' + trigger)
      assert(await b.evaluate(`(()=>{const p=document.querySelector('${editor} ${popup === '.task-table-status .shared-picker-popup' ? '.single-select-picker .shared-picker-popup' : popup}'),r=p.getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()`),'Picker stays in viewport')
      if(trigger==='.task-priority-pill')await shot('priority-picker-1920')
      await key('Escape')
      assert(await b.evaluate(`!!document.querySelector('${editor}')`)); assert.equal(await b.evaluate(`!!document.querySelector('${editor} ${popup === '.task-table-status .shared-picker-popup' ? '.single-select-picker .shared-picker-popup' : popup}')`), false)
    }
    assert(await b.evaluate(`[...document.querySelectorAll('${editor} :is(.task-status-trigger,.task-priority-pill) > .shared-pill')].every(p=>p.getBoundingClientRect().width===80&&p.getBoundingClientRect().height===32)`))
    assert(await b.evaluate(`[...document.querySelectorAll('${editor} .tag-picker-trigger .tag-chip')].every(p=>{const s=getComputedStyle(p);return s.height==='28px'&&s.fontSize==='13px'&&s.fontWeight==='600'&&s.borderTopWidth==='0px'})`))
    assert(await b.evaluate(`(()=>{const project=document.querySelector('${editor} .project-picker-trigger'),tag=document.querySelector('${editor} .tag-picker-trigger');return getComputedStyle(project).backgroundColor==='rgba(0, 0, 0, 0)'&&getComputedStyle(tag).backgroundColor==='rgba(0, 0, 0, 0)'&&!project.querySelector('[data-icon=chevronDown]')&&getComputedStyle(tag.querySelector(':scope > .ui-icon')).display==='none'&&!!document.querySelector('${editor} .task-status-field .shared-pill')&&!document.querySelector('${editor} .task-name-label .shared-pill')})()`),'Content triggers and Status attribute row replace old Select visuals')
    const projectPoint=await b.evaluate(`(()=>{const r=document.querySelector('${editor} .project-picker-trigger').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    await b.send('Input.dispatchMouseEvent',{type:'mouseMoved',...projectPoint})
    assert.equal(await b.evaluate(`getComputedStyle(document.querySelector('${editor} .task-project-field .task-attribute-control')).backgroundColor`),'rgb(229, 231, 235)')
    await b.evaluate(`document.querySelector('${editor} .project-picker-trigger').focus()`)
    assert(await b.evaluate(`(()=>{const s=getComputedStyle(document.querySelector('${editor} .project-picker-trigger'));return s.borderTopWidth==='2px'&&s.borderTopColor==='rgb(156, 163, 175)'&&s.outlineStyle==='none'&&s.boxShadow==='none'})()`),'Project has a single gray focus border')
    await b.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:1900,y:1000})
    await shot('draft-selected-1920')
    await b.evaluate('window.__confirmAnswer=false'); await key('Escape'); assert(await b.evaluate(`!!document.querySelector('${editor}')`))
    await b.click(editor + ' .composer-footer .secondary-button'); assert(await b.evaluate(`!!document.querySelector('${editor}')`))
    await b.evaluate('window.__confirmAnswer=true'); await close(); assert.equal(writes.length, baseline)
    assert.equal((await api(`/tasks/${inbox.id}`)).title, 'Inbox edit')
    for (const trigger of ['.task-status-trigger','.project-picker-trigger','.tag-picker-trigger','.task-priority-pill']) {
      await openInbox(); await b.click(editor+' '+trigger); await key('Escape'); assert(await b.evaluate(`!!document.querySelector('${editor}')`))
      await key('Escape'); await b.until(`!document.querySelector('${editor}')`, 'Next Escape follows Editor Close contract')
    }
  })
  await t.test('Input geometry and all time formats preserve draft; invalid time blocks Footer; one-minute Schedule save remains', async () => {
    await openInbox(); const baseline = writes.length
    await b.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:1900,y:1000})
    assert(await b.evaluate(`[...document.querySelectorAll('${editor} :is([name=title],[name=deadline],[name=estimatedMinutes],[name=date],[name=startTime])')].every(e=>getComputedStyle(e).backgroundColor==='rgb(255, 255, 255)')`),'Editable inputs have white normal backgrounds')
    for (const name of ['title','deadline','estimatedMinutes','date','startTime']) {
      await input(name, name === 'title' ? 'Saved Inbox' : name === 'startTime' ? '915' : name === 'estimatedMinutes' ? '150m' : '20261007')
      assert(await b.evaluate(`(()=>{const e=document.querySelector('${editor} [name=${name}]'),s=getComputedStyle(e);return s.height==='40px'&&s.borderRadius==='8px'&&s.fontSize==='14px'&&s.borderTopWidth==='2px'&&s.borderTopColor==='rgb(156, 163, 175)'&&s.outlineStyle==='none'&&s.boxShadow==='none'})()`))
      const point=await b.evaluate(`(()=>{const r=document.querySelector('${editor} [name=${name}]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
      await b.send('Input.dispatchMouseEvent',{type:'mouseMoved',...point})
      assert.equal(await b.evaluate(`getComputedStyle(document.querySelector('${editor} [name=${name}]')).backgroundColor`),'rgb(229, 231, 235)')
    }
    for (const [value, normalized] of [['1516','15:16'],['0915','09:15'],['915','09:15'],['15:16','15:16']]) {
      await input('startTime', value); await b.evaluate(`document.querySelector('${editor} [name=title]').focus()`)
      assert.equal(await b.evaluate(`document.querySelector('${editor} [name=startTime]').value`), normalized)
    }
    for (const value of ['2560','abcd']) {
      await input('startTime', value); await b.click(editor + ' .composer-footer [type=submit]')
      assert.equal(writes.length, baseline); assert(await b.evaluate(`!!document.querySelector('${editor} .time-input [role=alert]')`))
    }
    await input('startTime','1516'); await b.evaluate(`document.querySelector('${editor} [name=title]').focus()`)
    await b.click(editor + ' [data-time-estimate]'); await b.until(`document.querySelector('${editor} [aria-label="時間の見積もり"]')`,'Estimate draft input')
    await b.evaluate(`(()=>{const e=document.querySelector('${editor} [aria-label="時間の見積もり"]');e.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'150m');e.dispatchEvent(new Event('input',{bubbles:true}))})()`); await key('Enter')
    assert.equal(writes.length, baseline)
    await footer()
    const saved = await api(`/tasks/${inbox.id}`), blocks = await api(`/schedule-blocks?taskId=${inbox.id}`)
    assert.equal(saved.title,'Saved Inbox'); assert.equal(saved.estimatedMinutes,150)
    assert.equal(blocks.length,1); assert.equal(blocks[0].startTime.slice(0,5),'15:16'); assert.equal(blocks[0].durationMinutes,60)
  })
  await t.test('TIME_UNSET and TIMED open unchanged Quick Detail then shared Full Editor; existing Schedule edit survives', async () => {
    await b.evaluate(`(()=>{const toggle=document.querySelector('.calendar-row-toggle');if(toggle.getAttribute('aria-expanded')!=='true')toggle.click()})()`); await b.until(`document.querySelector('[data-schedule-block-id="${unsetBlock.id}"]')`, 'Unset visible')
    for (const block of [unsetBlock,timedBlock]) {
      await b.click(`[data-schedule-block-id="${block.id}"]`); await b.until('document.querySelector(".task-detail")','Quick Detail')
      assert(await b.evaluate('!!document.querySelector(".task-detail .task-status-control select") && !document.querySelector(".task-detail .home-full-editor")'))
      await b.click('.task-detail-edit'); await b.until(`document.querySelector('${editor}')`,'Full Editor from Schedule')
      assert.equal(await b.evaluate(`document.querySelector('${editor} [name=date]').value`),'2026/10/07')
      if (block.type==='TIMED') await input('startTime','0915')
      await input('title', block.type + ' changed'); await footer()
      const saved = (await api(`/schedule-blocks?taskId=${block.taskId}`))[0]
      assert.equal(saved.id,block.id); assert.equal(saved.type,block.type)
      if(block.type==='TIMED'){assert.equal(saved.startTime.slice(0,5),'09:15');assert.equal(saved.durationMinutes,30)}
    }
  })
  await t.test('Unplanned/TIME_UNSET/TIMED creation all reuse the draft Editor and original Schedule creation', async () => {
    for (const mode of ['unplanned','TIME_UNSET','TIMED']) {
      if(mode==='unplanned') await b.click('.home-add-trigger')
      else if(mode==='TIME_UNSET') await b.click('[data-all-day-drop-date="2026-10-07"] .calendar-date-count')
      else await b.evaluate(`document.querySelector('[data-timed-drop-date="2026-10-07"]').click()`)
      await b.until(`document.querySelector('${editor}')`,'Create Editor')
      const before=writes.length;await input('title','Create '+mode);assert.equal(writes.length,before)
      await footer()
      const task=(await api('/tasks')).find(task=>task.title==='Create '+mode), blocks=await api(`/schedule-blocks?taskId=${task.id}`)
      assert.equal(blocks.length,mode==='unplanned'?0:1)
      if(mode!=='unplanned')assert.equal(blocks[0].type,mode)
    }
  })
  await mkdir(new URL('../../docs/screenshots/home-full-editor/',import.meta.url),{recursive:true})
  await b.click('.home-add-trigger');await b.until(`document.querySelector('${editor}')`,'Visual Editor')
  await t.test('Full-width fields share neutral presentation and edge hit areas without stretching semantic Pills', async () => {
    const fields=['project','tag','priority','deadline','estimate','schedule-date','schedule-time','status']
    const rows=await b.evaluate(`[...document.querySelectorAll('${editor} .task-attribute-row')].map(row=>{const field=row.querySelector('.task-attribute-control'),r=field.getBoundingClientRect();return {label:row.querySelector('.task-attribute-label').textContent,left:r.left,right:r.right,width:r.width}})`)
    assert(rows.every(r=>Math.abs(r.left-rows[0].left)<1&&Math.abs(r.right-rows[0].right)<1),JSON.stringify(rows))
    console.log('1920px field bounds:',JSON.stringify(rows))
    for(const field of fields){
      const selector=editor+' '+({estimate:'.task-attribute-control:has([name=estimatedMinutes])','schedule-date':'.task-attribute-control:has([name=date])','schedule-time':'.task-attribute-control:has([name=startTime])'}[field]??'.task-'+field+'-field .task-attribute-control')
      const point=await b.evaluate(`(()=>{const r=document.querySelector('${selector}').getBoundingClientRect();return {x:r.right-3,y:r.y+r.height/2}})()`)
      await b.send('Input.dispatchMouseEvent',{type:'mouseMoved',...point})
      assert.equal(await b.evaluate(`getComputedStyle(document.querySelector('${selector}')).backgroundColor`),'rgb(229, 231, 235)',field+' full-field hover')
      if(['project','tag','priority','status'].includes(field)){
        await b.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await b.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point})
        await b.until(`document.querySelector('${selector} [aria-expanded=true]')`,field+' edge opens existing Picker');await key('Escape')
      }
      else {
        await b.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await b.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point})
        if(['deadline','schedule-date'].includes(field)) { await b.until(`document.querySelector('${selector} .deadline-calendar-trigger[aria-expanded=true]')`,field+' edge opens Calendar');await b.click(selector+' .deadline-calendar-trigger');await b.until(`document.querySelector('${selector} .deadline-calendar-trigger[aria-expanded=false]')`,field+' Calendar closed before the next field') }
        else assert(await b.evaluate(`document.activeElement===document.querySelector('${selector} input')`),field+' edge focuses existing input')
      }
    }
    await b.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:1900,y:1000})
    assert(await b.evaluate(`(()=>{const ref=document.createElement('span');ref.style.color='var(--text-secondary)';document.body.append(ref);const expected=getComputedStyle(ref).color;ref.remove();return ['.project-picker-trigger > span','.tag-empty','.task-priority-pill > span','[name=deadline]','[name=estimatedMinutes]','[name=date]','[name=startTime]'].every(selector=>{const e=document.querySelector('${editor} '+selector);return getComputedStyle(e,e instanceof HTMLInputElement&&e.type!=='hidden'&&e.name!=='startTime'?'::placeholder':null).color===expected})})()`),'Unset values reuse the existing secondary token')
    assert(await b.evaluate(`(()=>{const priority=document.querySelector('${editor} .task-priority-pill .shared-pill'),status=document.querySelector('${editor} .task-status-trigger .shared-pill');return getComputedStyle(priority).backgroundColor==='rgba(0, 0, 0, 0)'&&getComputedStyle(status).backgroundColor==='rgba(0, 0, 0, 0)'&&!!status.querySelector('[data-icon=circle]')&&[priority,status].every(p=>p.getBoundingClientRect().width===80&&p.getBoundingClientRect().height===32)})()`),'Unset Priority is neutral and NOT_STARTED retains its outline circle without a Chip background')
    const calendars=await b.evaluate(`[...document.querySelectorAll('${editor} .deadline-calendar-trigger')].map(e=>e.getBoundingClientRect().right)`)
    assert(Math.abs(calendars[0]-calendars[1])<1)
  })
  await t.test('Neutral text origins align and Status Popup never changes Trigger or Drawer geometry',async()=>{
    await b.evaluate(`document.querySelector('${editor} [name=title]').focus()`)
    await b.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:1900,y:1000})
    const values=await b.evaluate(`['.project-picker-trigger > span','.tag-empty','.task-priority-pill > span','[name=deadline]','[name=estimatedMinutes]','[name=date]','[name=startTime]'].map(selector=>{const e=document.querySelector('${editor} '+selector),s=getComputedStyle(e),r=e.getBoundingClientRect();let start;if(e instanceof HTMLInputElement)start=r.left+parseFloat(s.borderLeftWidth)+parseFloat(s.paddingLeft);else {const range=document.createRange();range.selectNodeContents(e);start=range.getBoundingClientRect().left}const textStyle=getComputedStyle(e,e instanceof HTMLInputElement&&e.name!=='startTime'?'::placeholder':null);return {selector,start,color:textStyle.color,weight:textStyle.fontWeight,opacity:textStyle.opacity}})`)
    assert(values.every(v=>Math.abs(v.start-values[0].start)<0.5&&v.color===values[0].color&&v.weight==='400'&&v.opacity==='1'),JSON.stringify(values))
    console.log('Neutral text computed styles:',JSON.stringify(values))
    const geometry=()=>b.evaluate(`(()=>{const box=e=>{const r=e.getBoundingClientRect();return [r.left,r.top,r.width,r.height]};return {drawer:box(document.querySelector('${editor}')),trigger:box(document.querySelector('${editor} .task-status-trigger')),pill:box(document.querySelector('${editor} .task-status-trigger .shared-pill')),scrollHeight:document.querySelector('${editor}').scrollHeight}})()`)
    const before=await geometry(),baseline=writes.length
    for(const value of ['IN_PROGRESS','COMPLETED','NOT_STARTED']){
      await b.click(editor+' .task-status-trigger');await b.until(`document.querySelector('${editor} .task-status-field .shared-picker-popup')`,'Status overlay')
      assert.deepEqual(await geometry(),before)
      assert(await b.evaluate(`(()=>{const p=document.querySelector('${editor} .task-status-field .shared-picker-popup');return getComputedStyle(p).position==='fixed'&&p.querySelectorAll('[aria-checked=true]').length===1&&getComputedStyle(document.querySelector('${editor} .task-status-trigger')).backgroundColor==='rgba(0, 0, 0, 0)'})()`))
      await shot('status-picker-1920')
      await b.click(editor+' .task-status-field [data-value='+value+']')
      assert.deepEqual(await geometry(),before)
      assert(await b.evaluate(`(()=>{const p=document.querySelector('${editor} .task-status-trigger .shared-pill'),s=getComputedStyle(p),ref=document.createElement('span');ref.style.color='var(${value==='IN_PROGRESS'?'--priority-low-text':value==='COMPLETED'?'--color-success':'--text-secondary'})';document.body.append(ref);const expected=getComputedStyle(ref).color;ref.remove();return s.color===expected})()`))
    }
    assert.equal(writes.length,baseline)
  })
  assert(await b.evaluate(`(()=>{const status=document.querySelector('${editor} .task-status-trigger'),priority=document.querySelector('${editor} .task-priority-pill');return getComputedStyle(status).backgroundColor==='rgba(0, 0, 0, 0)'&&getComputedStyle(priority,'::before').content==='none'&&priority.textContent==='未設定'})()`))
  await writeFile(new URL('../../docs/screenshots/home-full-editor/1920.png',import.meta.url),Buffer.from((await b.send('Page.captureScreenshot',{format:'png'})).data,'base64'))
  await close()
  assert.deepEqual(errors,[])
})
