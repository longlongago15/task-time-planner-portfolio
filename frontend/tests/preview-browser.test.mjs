import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { build } from 'vite'
import { openBrowser } from './browser.mjs'

const frontend = fileURLToPath(new URL('../', import.meta.url))
const backend = fileURLToPath(new URL('../../backend/', import.meta.url))

test('Built preview serves authenticated same-origin UI and retains a new isolated SQLite database', { timeout: 180000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'task-preview-integration-'))
  const data = path.join(directory, 'data'), dist = path.join(directory, 'dist')
  await mkdir(data)
  await build({ root: frontend, logLevel: 'error', define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('') }, build: { outDir: dist } })
  const port = await new Promise(resolve => { const socket = createServer(); socket.listen(0, '127.0.0.1', () => { const n = socket.address().port; socket.close(() => resolve(n)) }) })
  const origin = `http://127.0.0.1:${port}`
  const username = 'local-preview-owner', password = 'Only-for-isolated-preview-test-12345'
  const authorization = 'Basic ' + Buffer.from(username+':'+password).toString('base64')
  const python = process.env.TIMER_TEST_PYTHON ?? path.join(backend, '.venv/Scripts/python.exe')
  const env = { ...process.env, APP_ENV: 'preview', DB_ENV: 'preview', DB_BACKEND: 'sqlite',
    DATABASE_URL: 'sqlite:///' + path.join(data, 'preview.db').replaceAll('\\','/'),
    PREVIEW_DATA_DIR: data, PREVIEW_STATIC_DIR: dist, PREVIEW_PUBLIC_ORIGIN: origin,
    PREVIEW_USERNAME: username, PREVIEW_PASSWORD: password, PORT: String(port), PYTHONDONTWRITEBYTECODE: '1' }
  delete env.RAILWAY_ENVIRONMENT_ID; delete env.RAILWAY_VOLUME_MOUNT_PATH
  let server, browser, output = '', launches = 0
  const stop = async () => {
    if (!server || server.exitCode !== null) return
    const exiting = new Promise(resolve => server.once('exit', resolve))
    if (process.platform === 'win32') execFileSync('taskkill.exe', ['/PID', String(server.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    else server.kill('SIGTERM')
    await exiting
  }
  t.after(async () => {
    try { if (browser) await browser.close() } finally { await stop(); await writeFile(path.join(directory, 'server.log'), output) }
    assert(!output.includes(password))
    t.diagnostic('Preview evidence: '+directory)
  })
  const start = async () => {
    server = spawn(python, ['-B','-m','app.preview'], { cwd: backend, env, windowsHide: true, stdio: ['ignore','pipe','pipe'] }); launches++
    server.stdout.on('data', chunk => { output+=chunk }); server.stderr.on('data', chunk => { output+=chunk })
    const deadline=Date.now()+15000
    while (true) {
      assert.equal(server.exitCode, null, 'Preview stopped before readiness')
      try { if ((await fetch(origin+'/_health/ready')).status===200) return } catch { /* Readiness is not available yet. */ }
      assert(Date.now()<deadline,'Preview readiness deadline')
      await new Promise(resolve=>setTimeout(resolve,30))
    }
  }
  const api = async (route, method='GET', input) => {
    const response=await fetch(origin+route,{method,headers:{Authorization:authorization,...(input?{'Content-Type':'application/json'}:{})},...(input?{body:JSON.stringify(input)}:{})})
    assert(response.ok, 'Authenticated API failed: '+route+' '+response.status)
    return response.json()
  }
  await start()
  let taskId, entryId
  await t.test('Knowing the URL grants no HTML, asset, API, docs or OpenAPI access', async () => {
    for(const route of ['/','/favicon.svg','/tasks','/projects','/tags','/docs','/redoc','/openapi.json','/health']) {
      assert.equal((await fetch(origin+route)).status,401)
      assert.equal((await fetch(origin+route,{headers:{Authorization:'Basic aW52YWxpZDppbnZhbGlk'}})).status,401)
    }
  })
  await t.test('Real API routing wins and missing API/assets remain JSON 404', async () => {
    assert.deepEqual(await api('/health'),{status:'ok'})
    assert.deepEqual(await api('/tasks'),[])
    const html=await (await fetch(origin,{headers:{Authorization:authorization}})).text()
    const script=html.match(/src="([^" ]+\.js)"/)[1]
    const asset=await fetch(origin+script,{headers:{Authorization:authorization}})
    assert.equal(asset.status,200); assert(asset.headers.get('content-type').includes('javascript'))
    const missing=await fetch(origin+'/api/no-such-route',{headers:{Authorization:authorization}})
    assert.equal(missing.status,404);assert(missing.headers.get('content-type').includes('application/json'))
    assert((await api('/openapi.json')).paths['/tasks'])
  })
  await t.test('Desktop and mobile load the production build and fetch only the same origin', async () => {
    browser=await openBrowser()
    const errors=[], requests=[]
    const listener=message=>{
      if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails)
      if(message.method==='Network.requestWillBeSent'&&/^https?:/.test(message.params.request.url))requests.push(message.params.request.url)
    }
    browser.listeners.push(listener)
    await browser.send('Network.setExtraHTTPHeaders',{headers:{Authorization:authorization}})
    await browser.send('Network.setBlockedURLs',{urls:['http://localhost:8000/*','http://127.0.0.1:8000/*','https://*']})
    await browser.send('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{const fetch=window.fetch;window.fetch=function(input,init){const url=new URL(typeof input==='string'?input:input.url,location.href);if(url.origin!==location.origin)throw new Error('External API blocked by isolated test');return fetch.call(this,input,init)}})()`})
    try {
      for(const width of [1920,375]) {
        await browser.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false})
        const token=String(width)
        await browser.evaluate(`document.documentElement.dataset.previewToken=${JSON.stringify(token)}`)
        await browser.send('Page.navigate',{url:origin})
        await browser.until(`document.documentElement.dataset.previewToken!==${JSON.stringify(token)} && document.querySelector(".home-view-switch")`,'Built Home ready')
        await browser.until('document.readyState==="complete"','Assets loaded')
        assert.equal(await browser.evaluate('location.origin'),origin)
        assert(await browser.evaluate('document.querySelector("#root").textContent.length>0'))
      }
      await browser.evaluate('document.documentElement.dataset.previewToken="refresh"')
      await browser.send('Page.reload')
      await browser.until('document.documentElement.dataset.previewToken!=="refresh" && document.querySelector(".home-view-switch")','Browser refresh retains application')
      assert(requests.some(url=>url===origin+'/tasks')); assert(requests.every(url=>new URL(url).origin===origin))
      assert.deepEqual(errors,[])
      await writeFile(path.join(directory,'browser.json'),JSON.stringify({widths:[1920,375],requests,errors},null,2))
    } finally {browser.listeners.splice(browser.listeners.indexOf(listener),1)}
  })
  await t.test('Authenticated create/update/manual record retains the existing API contract', async () => {
    const project=await api('/projects','POST',{name:'Isolated preview project',color:'#368AD8'})
    const task=await api('/tasks','POST',{title:'Preview integration',projectId:project.id,estimatedMinutes:60})
    taskId=task.id
    assert.equal((await api('/tasks/'+taskId,'PUT',{title:'Saved on shared preview'})).title,'Saved on shared preview')
    const day=new Date(Date.now()-86400000).toISOString().slice(0,10)
    const entry=await api('/time-entries','POST',{taskId,startedAt:day+'T12:00:00Z',endedAt:day+'T12:30:00Z'})
    entryId=entry.id; assert.equal(entry.projectIdSnapshot,project.id)
    await api('/time-entries/'+entryId,'PATCH',{startedAt:day+'T12:00:00Z',endedAt:day+'T12:45:00Z'})
    assert.equal((await api('/reports/daily?date='+day+'&timezone=UTC')).dailyActualMinutes,45)
  })
  await t.test('A real process restart reconnects to the same new DB without reinitializing data', async () => {
    await stop();await start()
    assert.equal((await api('/tasks/'+taskId)).title,'Saved on shared preview')
    const entries=await api('/tasks/'+taskId+'/time-entries')
    assert.equal(entries.length,1);assert.equal(entries[0].id,entryId)
    assert.equal(launches,2)
  })
  await t.test('Deleted record stays deleted after another process restart', async () => {
    await api('/time-entries/'+entryId,'DELETE')
    assert.deepEqual(await api('/tasks/'+taskId+'/time-entries'),[])
    await stop();await start()
    assert.deepEqual(await api('/tasks/'+taskId+'/time-entries'),[])
    const memory={platform:process.platform,scope:'Owned preview processes; not Linux container/cgroup usage'}
    if(process.platform==='win32') {
      const command=`$ownedPid=${server.pid};$ids=@($ownedPid)+@(Get-CimInstance Win32_Process|Where-Object ParentProcessId -eq $ownedPid|Select-Object -ExpandProperty ProcessId);@(Get-Process -Id $ids|Where-Object ProcessName -match "^python"|Select-Object Id,ProcessName,WorkingSet64,PeakWorkingSet64,CPU)|ConvertTo-Json -Compress`
      memory.processes=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command',command],{encoding:'utf8',windowsHide:true}))
    }
    await writeFile(path.join(directory,'runtime-memory.json'),JSON.stringify(memory,null,2))
  })
})
