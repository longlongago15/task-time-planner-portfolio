import assert from 'node:assert/strict'
import test from 'node:test'
import { openBrowser } from './browser.mjs'
import { selectReportAnchor } from './report-picker.mjs'

test('Reports preserve committed content during delayed refresh, focus and rapid navigation (API mocked, no DB)', { timeout: 120000 }, async t => {
  const browser = await openBrowser()
  t.after(() => browser.close())
  const projects = [{ id: 1, name: 'Blue', color: '#368AD8' }, { id: 2, name: 'Red', color: '#DC6262' }]
  const tasks = [1, 2, 3].map(id => ({ id, title: id === 3 ? 'Record only' : `Task ${id}`, projectId: id === 2 ? 2 : 1, projectName: id === 2 ? 'Red' : 'Blue', status: 'IN_PROGRESS', completed: false, estimatedMinutes: 60, actualMinutes: 60, tags: [], priority: null, deadline: null }))
  const blocks = [{ id: 1, taskId: 1, date: '2026-10-07', type: 'TIMED', startTime: '10:00:00', durationMinutes: 60 }, { id: 2, taskId: 2, date: '2026-10-07', type: 'TIMED', startTime: '10:30:00', durationMinutes: 60 }, { id: 3, taskId: 1, date: '2026-10-06', type: 'TIMED', startTime: '23:15:00', durationMinutes: 180 }]
  const entries = [{ id: 1, taskId: 1, projectIdSnapshot: 2, startedAt: '2026-10-07T10:00:00+09:00', endedAt: '2026-10-07T11:00:00+09:00' }, { id: 2, taskId: 3, projectIdSnapshot: 1, startedAt: '2026-10-07T11:00:00+09:00', endedAt: null }]
  const errors = [], requests = [], pending = []
  let hold = false
  await browser.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' })
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false })
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{const D=Date,base=${Date.parse('2026-10-07T12:00:00+09:00')};window.reportClockOffset=0;window.Date=class extends D{constructor(...a){super(...(a.length?a:[base+window.reportClockOffset]));}static now(){return base+window.reportClockOffset}}})()` })
  browser.listeners.push(message => {
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method !== 'Fetch.requestPaused') return
    const { request, requestId } = message.params, url = new URL(request.url), path = url.pathname
    void (async () => {
      if (request.method === 'OPTIONS') return browser.fulfill(requestId, {})
      requests.push({ path, query: url.search, method: request.method })
      assert.equal(request.method, 'GET', 'Report viewing must not mutate data')
      let data = []
      if (path === '/tasks') data = tasks
      else if (path === '/projects') data = projects
      else if (path === '/tasks/time/active') data = { taskId: 3, running: true, startedAt: entries[1].startedAt }
      else if (/^\/tasks\/\d+\/time-entries$/.test(path)) data = entries.filter(entry => entry.taskId === Number(path.split('/')[2]))
      else if (/^\/tasks\/\d+$/.test(path)) data = tasks.find(task => task.id === Number(path.split('/')[2]))
      else if (path === '/schedule-blocks') data = blocks.filter(block => (!url.searchParams.has('startDate') || block.date >= url.searchParams.get('startDate')) && (!url.searchParams.has('endDate') || block.date <= url.searchParams.get('endDate')))
      else if (path === '/reports/daily') data = { date: url.searchParams.get('date'), plannedOccupiedMinutes: 0, dailyEstimatedMinutes: 0, dailyActualMinutes: 0, dailyDifference: 0, tasks: [] }
      if (hold && (path === '/schedule-blocks' || path.endsWith('/time-entries'))) {
        pending.push({ requestId, data, path, query: url.search })
        return
      }
      await browser.fulfill(requestId, data)
    })().catch(error => { if (!/Invalid .*nterception|Invalid requestId/.test(error.message)) errors.push(String(error)) })
  })
  await browser.send('Fetch.enable', { patterns: [{ urlPattern: 'http://localhost:8000/*', requestStage: 'Request' }] })
  await browser.navigate()
  await browser.until(`!!document.querySelector('.icon-rail [aria-label="レポート"]') && !!document.querySelector('.timer-session')`, 'Navigation and shared Timer')
  await browser.click('.icon-rail [aria-label="レポート"]')

  await browser.until('!!document.querySelector(".report-summary") && document.querySelector(".reports-v2").getAttribute("aria-busy")==="false"', 'Initial Report')
  await browser.evaluate(`(()=>{
    window.reportSamples=[];
    window.sampleReport=()=>{
      const root=document.querySelector('.reports-v2');
      window.reportSamples.push({
        mode:root.querySelector('.report-mode [aria-pressed=true]')?.textContent,
        date:root.querySelector('.report-period-controls strong')?.textContent,
        summary:!!root.querySelector('.report-summary'),
        loading:!!root.querySelector(':scope > [role=status]'),
        values:Array.from(root.querySelectorAll('.report-summary strong')).map(e=>e.textContent),
        chart:root.querySelector('.period-chart-panel')?.textContent,
        dates:Array.from(root.querySelectorAll('[data-chart-date]')).map(e=>e.dataset.chartDate),
        dayRows:Array.from(root.querySelectorAll('[data-report-date]')).map(e=>e.dataset.reportDate),
        tables:root.querySelectorAll('.report-table-panel,.weekly-breakdown-panel').length
      });
    };
    new MutationObserver(window.sampleReport).observe(document.querySelector('.reports-v2'),{subtree:true,childList:true,characterData:true,attributes:true});
    window.sampleReport();
  })()`)
  const snapshot = () => browser.evaluate(`(()=>{window.sampleReport();return window.reportSamples.at(-1)})()`)
  const release = async list => {
    for (const item of list) {
      try { await browser.fulfill(item.requestId, item.data) }
      catch (error) { if (!/Invalid .*nterception|Invalid requestId/.test(error.message)) throw error }
    }
  }
  const flush = async () => { hold=false; await release(pending.splice(0)) }
  const waitPending = async count => {
    // Existing polling helper, waiting on intercepted requests rather than a sleep.
    await browser.evaluate('window.reportFetchPending=false')
    const mark = setInterval(() => { if (pending.length >= count) void browser.evaluate('window.reportFetchPending=true') }, 10)
    try { await browser.until('window.reportFetchPending', 'Delayed Report request') } finally { clearInterval(mark) }
  }
  const clickMode = name => browser.evaluate(`Array.from(document.querySelectorAll('.report-mode button')).find(e=>e.textContent===${JSON.stringify(name)}).click()`)
  const waitMode = name => browser.until(`document.querySelector('.report-mode [aria-pressed=true]')?.textContent===${JSON.stringify(name)}`, 'Committed Report mode')
  const periodLabel = () => browser.evaluate(`document.querySelector('.report-period-controls strong').textContent`)
  const waitLabel = label => browser.until(`document.querySelector('.report-period-controls strong')?.textContent===${JSON.stringify(label)}`, 'Committed period label')

  await t.test('Day to Week to Period to Month to Day retains Summary and synchronizes mode with body', async () => {
    for (const name of ['週','期間','月','日']) {
      const previous=await snapshot(); hold=true
      await clickMode(name); await waitPending(1)
      assert.deepEqual(await snapshot(), previous, 'Pending request must preserve all Report content and labels')
      await flush(); await waitMode(name)
      const next=await snapshot()
      assert.equal(next.dates.length, name==='週'||name==='期間'?7:name==='月'?31:0)
      assert.equal(next.tables,name==='週'?3:2)
    }
    await clickMode('期間'); await waitMode('期間')
    const previous=await snapshot()
    await browser.click('.report-period-label')
    await browser.until('!!document.querySelector(".calendar-navigation-picker")','Range Picker')
    await browser.click('.calendar-navigation-picker button[data-picker-date="2026-10-06"]')
    hold=true
    await browser.click('.calendar-navigation-picker button[data-picker-date="2026-10-07"]')
    await waitPending(1)
    assert.deepEqual(await snapshot(),previous,'Pending Range retains labels and body together')
    await flush(); await waitLabel('10/6 - 10/7')
    assert.deepEqual((await snapshot()).dates,['2026-10-06','2026-10-07'])
    await clickMode('日')
    await browser.until('document.querySelector(".reports-v2").getAttribute("aria-busy")==="false"','Standard Day restored')
    await selectReportAnchor(browser,'2026-10-07')
  })
  await t.test('Previous and next Day Week Month commit labels and content together', async () => {
    for (const [name,labels] of [['日',['2026/10/06(火)','2026/10/07(水)']],['週',['9/28 - 10/4','10/5 - 10/11']],['月',['2026年9月','2026年10月']]]) {
      await clickMode(name); await waitMode(name)
      for (const [i,label] of labels.entries()) {
        const previous=await snapshot(); hold=true
        await browser.click(`.report-period-controls [aria-label="${i===0?'前の期間':'次の期間'}"]`)
        await waitPending(1)
        assert.deepEqual(await snapshot(),previous)
        await flush(); await waitLabel(label)
        const next=await snapshot()
        if(name==='週') assert.equal(next.dayRows[0],i===0?'2026-09-28':'2026-10-05')
        if(name==='月' && next.dates.length) assert(next.dates.every(date=>date.startsWith(i===0?'2026-09':'2026-10')))
      }
    }
  })
  await t.test('Focus and visibility retain Summary Chart and Tables while history and schedules refresh', async () => {
    await clickMode('日'); await waitMode('日')
    await browser.until('document.querySelector(".reports-v2").getAttribute("aria-busy")==="false"', 'Report idle before focus')
    const previous=await snapshot(); const count=requests.length; hold=true
    await browser.evaluate('window.dispatchEvent(new Event("blur"));window.dispatchEvent(new Event("focus"));document.dispatchEvent(new Event("visibilitychange"))')
    await waitPending(5)
    assert.deepEqual(await snapshot(),previous)
    const recent=requests.slice(count)
    assert.equal(recent.filter(r=>r.path==='/schedule-blocks' && r.query==='?endDate=2026-10-01').length,1)
    for (const id of [1,2,3]) assert.equal(recent.filter(r=>r.path===`/tasks/${id}/time-entries`).length,1)
    assert(!recent.some(r=>/reports\/(weekly|monthly)/.test(r.path)))
    await flush()
    await browser.until('document.querySelector(".reports-v2").getAttribute("aria-busy")==="false"', 'Refreshed content')
    assert.deepEqual(await snapshot(),previous)
  })
  await t.test('Rapid previous next next ignores obsolete responses', async () => {
    await selectReportAnchor(browser, '2026-10-07'); await waitLabel('2026/10/07(水)')
    await clickMode('週'); await waitMode('週'); hold=true
    const previous=await snapshot()
    await browser.click('.report-period-controls [aria-label="前の期間"]'); await waitPending(1)
    await browser.click('.report-period-controls [aria-label="次の期間"]'); await waitPending(2)
    await browser.click('.report-period-controls [aria-label="次の期間"]'); await waitPending(3)
    assert.deepEqual(await snapshot(),previous)
    const held=pending.splice(0); hold=false
    await release([held.at(-1)]); await waitLabel('10/12 - 10/18')
    await release(held.slice(0,-1).reverse())
    assert.equal(await periodLabel(),'10/12 - 10/18')
    assert.equal((await snapshot()).dayRows[0],'2026-10-12')
  })
  await t.test('Active minute advances values without Loading, fetch or empty chart', async () => {
    await clickMode('日'); await waitMode('日')
    await selectReportAnchor(browser, '2026-10-07')
    await waitLabel('2026/10/07(水)')
    const count=requests.length
    await browser.evaluate('window.reportClockOffset=60000;document.dispatchEvent(new Event("visibilitychange"))')
    await browser.until('document.querySelectorAll(".report-summary strong")[1]?.textContent==="2時間1分"', 'Active minute')
    assert.equal(requests.length,count)
    const samples=await browser.evaluate('window.reportSamples')
    assert(samples.every(sample=>sample.summary && !sample.loading && sample.tables>0))
    assert(samples.filter(sample=>sample.mode==='日' && sample.date==='2026/10/07(水)').every(sample=>sample.values[1]!=='0分' && !sample.chart.includes('対象期間の記録はありません')))
    assert(samples.filter(sample=>sample.mode==='週' && sample.date==='10/12 - 10/18').every(sample=>sample.dayRows[0]==='2026-10-12'))
  })
  assert.deepEqual(errors,[])
})
