// Own-process loopback API, new local SQLite and fresh browser profile only.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openBrowser, selectTimerTask } from '../tests/browser.mjs'

const root=fileURLToPath(new URL('../../',import.meta.url))
const mode=process.argv[2]
assert(['--seed','--capture'].includes(mode),'Use --seed once, then --capture.')
const replace=process.argv.includes('--replace')
const python=process.env.TIMER_TEST_PYTHON ?? path.join(root,'backend','.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python')
await access(python)
const database=path.join(root,'.local-data','demo','portfolio.sqlite3')
const checks=[]
let child, browser
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const childEnvironment={...process.env,PYTHONDONTWRITEBYTECODE:'1',PYTHONIOENCODING:'utf-8'}
for(const key of Object.keys(childEnvironment))if(/^(DATABASE_URL|DB_|MYSQL_|PREVIEW_|APP_ENV|APPLY_)/.test(key))delete childEnvironment[key]
async function stop(){
  if(child?.exitCode===null){const done=new Promise(resolve=>child.once('exit',resolve));child.kill();await done}
}
async function start(initialize=false){
  child=spawn(python,['-B',path.join(root,'backend','run_portfolio.py'),'--data-dir','demo','--port','0',...(initialize?['--initialize']:[])],
    {cwd:path.join(root,'backend'),env:childEnvironment,windowsHide:true,stdio:['ignore','pipe','pipe']})
  let output=''
  child.stdout.on('data',data=>{output+=data});child.stderr.resume()
  for(let i=0;i<200;i++){
    assert.equal(child.exitCode,null,'Dedicated local launcher stopped; preserve demo data and inspect it.')
    const port=output.match(/PORTFOLIO_PORT=(\d+)/)?.[1]
    if(port){const base=`http://127.0.0.1:${port}`;try{if((await fetch(base+'/health')).ok)return base}catch{/* Own process startup. */}}
    await delay(50)
  }
  throw Error('Dedicated local launcher did not become ready. Preserve local state.')
}
function api(base){return async(route,payload,method='POST')=>{
  assert(base.startsWith('http://127.0.0.1:'))
  const response=await fetch(base+route,payload===undefined?{}:{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
  const result=await response.json()
  assert(response.ok,`${route}: ${response.status} ${JSON.stringify(result)}`)
  return result
}}
const today=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Tokyo'})
const day=offset=>{const d=new Date(today+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+offset);return d.toISOString().slice(0,10)}
const stamp=(date,time)=>`${date}T${time}:00+09:00`
try{
  let base=await start(mode==='--seed')
  let call=api(base)
  if(mode==='--seed'){
    assert.equal((await call('/tasks')).length,0)
    const projects=await Promise.all([
      {name:'ポートフォリオ開発',color:'#26786B'}, {name:'学習',color:'#5E71C4'}, {name:'日常',color:'#C27A36'},
    ].map(value=>call('/projects',value)))
    const tags=await Promise.all([
      {name:'設計',color:'#548DA0'},{name:'実装',color:'#6B8E51'}, {name:'テスト',color:'#A8759F'}, {name:'復習',color:'#C39345'},
    ].map(value=>call('/tags',value)))
    const definitions=[
      ['画面設計を整理する',90,0,'HIGH',[0],0,2],['APIのテストを書く',60,0,'HIGH',[1,2],0,3],
      ['TypeScriptの復習',45,1,'MEDIUM',[3],0,4],['入力フォームを実装する',75,0,'MEDIUM',[1],1,5],
      ['読書メモをまとめる',30,1,'LOW',[3],0,6],['公開READMEを見直す',45,0,'MEDIUM',[0],-1,2],
      ['来週の学習を計画する',null,1,null,[],null,null],['日用品のリストを整理する',20,2,'LOW',[],null,null],
      ['検証記録を整理する',30,0,'MEDIUM',[2],-1,0],
    ]
    const tasks=[]
    for(const [title,estimatedMinutes,p,priority,tagIndices,start,end] of definitions){
      tasks.push(await call('/tasks',{title,estimatedMinutes,projectId:projects[p].id,priority,
        tagIds:tagIndices.map(index=>tags[index].id),startDate:start===null?null:day(start),deadline:end===null?null:day(end)}))
    }
    for(const [task,offset,start,duration] of [[0,0,'09:00:00',90],[1,0,'10:30:00',60],[2,0,'13:00:00',45],[3,1,'10:00:00',75],[4,0,'15:30:00',30],[5,-1,'11:00:00',45],[8,-1,'14:00:00',30]]){
      await call('/schedule-blocks',{taskId:tasks[task].id,date:day(offset),type:'TIMED',startTime:start,durationMinutes:duration})
    }
    await call('/schedule-blocks',{taskId:tasks[6].id,date:day(2),type:'TIME_UNSET'})
    await call('/schedule-blocks',{taskId:tasks[7].id,date:day(3),type:'ALL_DAY'})
    for(const [task,offset,start,end] of [[0,0,'09:10','10:05'],[1,0,'10:35','11:15'],[5,-1,'11:00','11:40'],[8,-1,'14:00','14:25']]){
      await call('/time-entries',{taskId:tasks[task].id,startedAt:stamp(day(offset),start),endedAt:stamp(day(offset),end)})
    }
    const temporary=await call('/time-entries',{taskId:tasks[4].id,startedAt:stamp(day(-2),'08:00'),endedAt:stamp(day(-2),'08:20')})
    await call(`/time-entries/${temporary.id}`,{endedAt:stamp(day(-2),'08:25')},'PATCH')
    await call(`/time-entries/${temporary.id}`,{},'DELETE')
    await call(`/tasks/${tasks[8].id}/complete`,{completed:true},'PATCH')
    const before=await call('/tasks')
    await stop();base=await start();call=api(base)
    const after=await call('/tasks')
    assert.deepEqual(after,before,'Normal restart must preserve saved task fields and actual values.')
    checks.push('new_database_initialized','nine_tasks_and_tags_saved','manual_entry_create_edit_delete',
      'normal_restart_preserves_data','existing_database_not_reinitialized')
    await mkdir(path.dirname(database),{recursive:true})
    await writeFile(path.join(path.dirname(database),'seed-checks.json'),JSON.stringify({checks,today,tasks:after.length},null,2)+'\n')
    console.log(JSON.stringify({status:'PASS',mode:'seed',checks,tasks:after.length}))
  }else{
    const tasks=await call('/tasks')
    assert.equal(tasks.length,9,'Use the sample DB created by --seed.')
    process.env.VITE_API_BASE_URL=base
    browser=await openBrowser()
    const errors=[]
    browser.listeners.push(message=>{if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails)})
    await browser.send('Emulation.setTimezoneOverride',{timezoneId:'Asia/Tokyo'})
    await browser.send('Emulation.setDeviceMetricsOverride',{width:1600,height:1100,deviceScaleFactor:1,mobile:false})
    await browser.navigate()
    await browser.until('document.body.innerText.includes("画面設計を整理する")','Own API data displayed')
    const showWorkingHours=()=>browser.evaluate('(() => { const grid=document.querySelector(".calendar-time-grid"); if(grid)grid.scrollTop=grid.scrollHeight/3; })()')
    const directory=path.join(root,'docs','screenshots')
    await mkdir(directory,{recursive:true})
    const capture=async name=>{
      await browser.evaluate('document.fonts.ready.then(()=>undefined)')
      await delay(450)
      assert.equal(errors.length,0,'No browser runtime exceptions before capture.')
      const shot=await browser.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})
      await writeFile(path.join(directory,name+'.png'),Buffer.from(shot.data,'base64'),{flag:replace?'w':'wx'})
      checks.push(name)
    }
    await showWorkingHours()
    await capture('home')
    await browser.click('button[aria-label="タスク"]')
    await browser.until('document.body.innerText.includes("並び替え") && document.body.innerText.includes("期限") && document.body.innerText.includes("画面設計を整理する")','Task list')
    await capture('tasks')
    await browser.click('button[aria-label="プロジェクト"]')
    await browser.until('document.body.innerText.includes("ポートフォリオ開発") && document.body.innerText.includes("学習")','Project list')
    await capture('projects')
    await browser.click('button[aria-label="ホーム"]')
    await showWorkingHours()
    await selectTimerTask(browser,tasks.find(task=>task.title==='入力フォームを実装する').id)
    await browser.click('.global-top-timer [aria-label="計測開始"]')
    await browser.until('document.querySelector(".global-top-timer .timer-stop")?.disabled === false','Timer start confirmed')
    assert.equal((await call('/tasks/time/active')).running,true)
    await delay(2000)
    await browser.click('.timer-time-button')
    await browser.until('document.querySelector(".timer-modal")','Timer details')
    await capture('timer')
    await browser.click('.timer-modal .icon-close')
    await browser.click('.global-top-timer .timer-stop')
    await browser.until('document.querySelector(".global-top-timer .timer-stop") === null','Timer stop confirmed')
    assert.equal((await call('/tasks/time/active')).running,false)
    checks.push('timer_start_and_stop_saved')
    await browser.click('button[aria-label="レポート"]')
    await browser.until('document.querySelector(".reports-v2")?.getAttribute("aria-busy") === "false"','Report loaded')
    await browser.evaluate('Array.from(document.querySelectorAll(".report-mode button")).find(button=>button.textContent==="日").click()')
    await browser.until('document.querySelector(".report-mode [aria-pressed=true]")?.textContent === "日" && document.querySelector(".reports-v2")?.getAttribute("aria-busy") === "false"','Day report loaded')
    await capture('reports-day')
    await browser.evaluate('Array.from(document.querySelectorAll(".report-mode button")).find(button=>button.textContent==="月").click()')
    await browser.until('document.querySelector(".report-mode [aria-pressed=true]")?.textContent === "月" && document.querySelector(".reports-v2")?.getAttribute("aria-busy") === "false"','Month report loaded')
    await capture('reports-month')
    assert.equal(errors.length,0)
    await writeFile(path.join(path.dirname(database),'capture-checks.json'),JSON.stringify({status:'PASS',checks,today,browser_errors:errors.length},null,2)+'\n')
    console.log(JSON.stringify({status:'PASS',mode:'capture',checks,browser_errors:errors.length}))
  }
}finally{await browser?.close();await stop()}
