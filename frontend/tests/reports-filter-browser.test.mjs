import assert from 'node:assert/strict'
import test from 'node:test'
import { openBrowser } from './browser.mjs'
import { selectReportRange, selectReportAnchor } from './report-picker.mjs'

test('Reports Filters reuse list presentation and recalculate every view (API mocks, no DB)', { timeout: 120000 }, async t => {
  const browser = await openBrowser(); t.after(() => browser.close())
  const errors = [], requests = []
  await browser.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' })
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{const D=Date,now=${Date.parse('2026-10-07T12:00:00+09:00')};window.Date=class extends D{constructor(...a){super(...(a.length?a:[now]))}static now(){return now}}})()` })
  browser.listeners.push(message => {
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method !== 'Fetch.requestPaused') return
    const { request, requestId } = message.params
    void (async () => {
      if (request.method === 'OPTIONS') return browser.fulfill(requestId, {})
      requests.push({ method: request.method, path: new URL(request.url).pathname })
      await browser.fulfill(requestId, request.url.includes('/tasks/time/active') ? { taskId: null, running: false, startedAt: null } : request.url.includes('/reports/daily') ? { date: '2026-10-07', tasks: [] } : [])
    })().catch(e => errors.push(String(e)))
  })
  await browser.send('Fetch.enable', { patterns: [{ urlPattern: 'http://localhost:8000/*', requestStage: 'Request' }] })
  await browser.navigate(); await browser.evaluate('window.location.search="?reportDemo=1"')
  await browser.until('!!document.querySelector(".icon-rail [aria-label=レポート]")', 'Navigation')
  await browser.click('.icon-rail [aria-label="レポート"]')
  await browser.until('!!document.querySelector("[data-report-demo]") && !!document.querySelector(".report-summary")', 'Demo')
  const mode = async name => { await browser.evaluate(`Array.from(document.querySelectorAll('.report-mode button')).find(e=>e.textContent===${JSON.stringify(name)}).click()`); await browser.until(`document.querySelector('.report-mode [aria-pressed=true]')?.textContent===${JSON.stringify(name)}`, 'Mode') }
  const values = () => browser.evaluate('Array.from(document.querySelectorAll(".report-summary strong")).map(e=>e.textContent)')
  const clear = async () => { if (await browser.evaluate('!!document.querySelector(".report-filters .task-clear-all")')) await browser.click('.report-filters .task-clear-all') }
  const toggle = async (category, names) => {
    const trigger = `.report-filters [data-filter="${category}"] > button`
    await browser.click(trigger)
    await browser.until('!!document.querySelector(".report-filters .task-filter-popover")', 'Filter open')
    for (const name of names) await browser.evaluate(`(()=>{const label=Array.from(document.querySelectorAll('.report-filters .task-filter-popover label')).find(e=>e.textContent.trim()===${JSON.stringify(name)});if(!label)throw Error('Missing option');label.querySelector('input').click()})()`)
    await browser.click(trigger)
    await browser.until('!document.querySelector(".report-filters .task-filter-popover")', 'Filter closed')
  }
  const taskNames = () => browser.evaluate('Array.from(document.querySelectorAll("[data-report-table=tasks] tbody th")).map(e=>e.textContent)')
  await mode('週')
  await browser.evaluate(`window.reportEmptySamples=[];new MutationObserver(()=>{const r=document.querySelector('.reports-v2');window.reportEmptySamples.push(!r.querySelector('.report-summary')||!!r.querySelector(':scope > [role=status]'))}).observe(document.querySelector('.reports-v2'),{subtree:true,childList:true,characterData:true})`)
  await t.test('Only Project Tag Status exist between Navigation and Summary', async () => {
    assert.deepEqual(await browser.evaluate('Array.from(document.querySelectorAll(".report-filters [data-filter]")).map(e=>e.dataset.filter)'), ['project', 'tag', 'status'])
    assert(await browser.evaluate('(()=>{const a=document.querySelector(".report-toolbar"),b=document.querySelector(".report-filters"),c=document.querySelector(".report-summary");return !!(a.compareDocumentPosition(b)&Node.DOCUMENT_POSITION_FOLLOWING)&&!!(b.compareDocumentPosition(c)&Node.DOCUMENT_POSITION_FOLLOWING)})()'))
    assert.deepEqual(await values(), ['25時間', '25時間30分', '+30分'])
  })
  await t.test('Project multi-select OR recalculates Summary, Chart, daily breakdown and Tasks', async () => {
    await toggle('project', ['IT学習'])
    assert.deepEqual(await values(), ['7時間', '7時間45分', '+45分'])
    assert.deepEqual((await taskNames()).sort(), ['基本情報の過去問', 'SQL復習', 'AWS学習'].sort())
    assert.equal(await browser.evaluate('document.querySelectorAll(".weekly-breakdown-panel tbody tr")[0].querySelectorAll("td")[0].textContent'), '2時間')
    assert.match(await browser.evaluate(`document.querySelector('[data-chart-date="2026-10-05"]').getAttribute('aria-label')`), /計画済み 2時間\n記録 1時間30分/)
    assert(await browser.evaluate(`parseFloat(document.querySelector('[data-chart-date="2026-10-05"] .period-chart-bar.estimated').style.height)>0`))
    await toggle('project', ['個人開発'])
    assert.deepEqual(await values(), ['16時間', '15時間45分', '-15分'])
    assert.equal((await taskNames()).length, 4)
    await mode('月')
    assert.equal(await browser.evaluate('document.querySelectorAll("[data-report-table=projects] tbody tr").length'), 2)
    await mode('週'); await clear()
  })
  await t.test('Tag OR, Status OR and category AND use current Task attributes', async () => {
    await toggle('tag', ['基本情報', 'AWS']); assert.deepEqual(await values(), ['5時間30分', '6時間30分', '+1時間']); await clear()
    await toggle('status', ['進行中', '完了']); assert.deepEqual(await values(), ['23時間30分', '23時間30分', '±0']); await clear()
    await toggle('project', ['IT学習']); await toggle('tag', ['AWS']); await toggle('status', ['未着手'])
    assert.deepEqual(await values(), ['1時間30分', '2時間', '+30分'])
    assert.deepEqual(await taskNames(), ['AWS学習'])
    await mode('月'); assert.equal(await browser.evaluate('document.querySelector("[data-report-table=projects] tbody th").textContent'), 'IT学習')
  })
  await t.test('Individual Chip remove and clear-all preserve Mode/date/range and source data', async () => {
    await browser.click('.report-filters [aria-label="タグ：AWSを解除"]')
    assert.deepEqual(await values(), ['1時間30分', '2時間', '+30分']) // Status still limits to AWS Task.
    await browser.click('.report-filters [aria-label="ステータス：未着手を解除"]')
    assert.deepEqual(await values(), ['7時間', '7時間45分', '+45分'])
    await selectReportRange(browser, '2026-10-05', '2026-10-11')
    const before = await browser.evaluate('[document.querySelector(".report-mode [aria-pressed=true]").textContent,document.querySelector(".report-period-label").textContent]')
    await clear()
    assert.deepEqual(await browser.evaluate('[document.querySelector(".report-mode [aria-pressed=true]").textContent,document.querySelector(".report-period-label").textContent]'), before)
    assert.deepEqual(await values(), ['25時間', '25時間30分', '+30分'])
    assert.equal(await browser.evaluate('!!document.querySelector(".task-applied-filters")'), false)
  })
  await t.test('Unassigned, search, Escape/focus and every Mode retain consistent filtered results', async () => {
    await toggle('project', ['未所属']); assert.deepEqual(await values(), ['0分', '0分', '－']); await clear()
    await browser.click('.report-filters [data-filter=project] > button')
    await browser.evaluate(`(()=>{const e=document.querySelector('.report-filters input[type=search]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'IT');e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    await browser.until('document.querySelectorAll(".report-filters .task-filter-popover label").length===1', 'Search')
    assert(await browser.evaluate('!!document.querySelector(".report-filters .task-filter-popover [data-icon=folder]")'))
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await browser.until('!document.querySelector(".report-filters .task-filter-popover")', 'Escape')
    assert(await browser.evaluate('document.activeElement===document.querySelector(".report-filters [data-filter=project] > button")'))
    await toggle('project', ['IT学習']); await toggle('tag', ['AWS'])
    for (const name of ['日', '週', '月', '期間']) {
      await mode(name)
      if (name === '日') await selectReportAnchor(browser, '2026-10-08')
      assert.deepEqual(await values(), ['1時間30分', '2時間', '+30分'])
    }
    assert.equal(await browser.evaluate('window.reportEmptySamples.some(Boolean)'), false)
    assert.deepEqual(errors, [])
    assert.equal(requests.filter(r => r.method !== 'GET').length, 0)
  })
})
