import assert from 'node:assert/strict'

export async function selectReportRange(browser, start, end) {
  await browser.evaluate('Array.from(document.querySelectorAll(".report-mode button")).find(e=>e.textContent==="期間").click()')
  await browser.until('document.querySelector(".report-mode [aria-pressed=true]")?.textContent==="期間" && document.querySelector(".reports-v2")?.getAttribute("aria-busy")==="false"', 'Range mode committed')
  await browser.click('.report-period-label')
  await browser.until('!!document.querySelector(".reports-v2 .calendar-navigation-picker")', 'Report Picker open')
  const moveTo = async date => {
    const [year, month] = date.split('-').map(Number)
    const target = `${year}年${month}月`
    while (await browser.evaluate('document.querySelector("#calendar-navigation-picker-title").textContent') !== target) {
      const current = await browser.evaluate('document.querySelector("#calendar-navigation-picker-title").textContent')
      const parts = current.match(/(\d+)年(\d+)月/).slice(1).map(Number)
      const direction = parts[0] * 12 + parts[1] < year * 12 + month ? 1 : -1
      await browser.click(`.calendar-navigation-picker [aria-label="${direction > 0 ? '次月' : '前月'}"]`)
      await browser.until(`document.querySelector('#calendar-navigation-picker-title')?.textContent!==${JSON.stringify(current)}`, 'Picker month moved')
    }
  }
  await moveTo(start)
  await browser.click(`.calendar-navigation-picker button[data-picker-date="${start}"]`)
  await browser.until('document.querySelector(".calendar-picker-range-hint")?.textContent==="終了日を選択"', 'Range start selected')
  await moveTo(end)
  await browser.click(`.calendar-navigation-picker button[data-picker-date="${end}"]`)
  await browser.until('!document.querySelector(".reports-v2 .calendar-navigation-picker") && document.querySelector(".reports-v2")?.getAttribute("aria-busy")==="false"', 'Report range committed')
}

export async function selectReportAnchor(browser, date, {wait=true}={}) {
  if (await browser.evaluate('document.querySelector(".report-mode [aria-pressed=true]")?.textContent==="期間"')) {
    await browser.click('.report-period-controls .secondary-button')
    await browser.until('document.querySelector(".report-mode [aria-pressed=true]")?.textContent!=="期間" && document.querySelector(".reports-v2")?.getAttribute("aria-busy")==="false"', 'Normal mode restored')
  }
  await browser.click('.report-period-label')
  await browser.until('!!document.querySelector(".reports-v2 .calendar-navigation-picker")', 'Date Picker open')
  const [year, month] = date.split('-').map(Number)
  const target = `${year}年${month}月`
  while (await browser.evaluate('document.querySelector("#calendar-navigation-picker-title").textContent') !== target) {
    const current = await browser.evaluate('document.querySelector("#calendar-navigation-picker-title").textContent')
    const parts = current.match(/(\d+)年(\d+)月/).slice(1).map(Number)
    const direction = parts[0] * 12 + parts[1] < year * 12 + month ? 1 : -1
    await browser.click(`.calendar-navigation-picker [aria-label="${direction > 0 ? '次月' : '前月'}"]`)
    await browser.until(`document.querySelector('#calendar-navigation-picker-title')?.textContent!==${JSON.stringify(current)}`, 'Picker month moved')
  }
  await browser.click(`.calendar-navigation-picker button[data-picker-date="${date}"]`)
  await browser.until('!document.querySelector(".reports-v2 .calendar-navigation-picker")'+(wait?' && document.querySelector(".reports-v2")?.getAttribute("aria-busy")==="false"':''), 'Standard period selected')
}

// Verify the shared accessible Tooltip through both keyboard Focus and pointer Hover.
export async function assertReportTooltip(browser, selector, expected) {
  const encoded=JSON.stringify(selector), text=JSON.stringify(expected.replaceAll('\n',''))
  await browser.evaluate('document.querySelector('+encoded+').focus()')
  await browser.until('document.querySelector("[role=tooltip]")?.textContent==='+text,'Focused Report Tooltip content')
  assert(await browser.evaluate('document.querySelector('+encoded+').getAttribute("aria-describedby")===document.querySelector("[role=tooltip]").id'))
  await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
  await browser.until('!document.querySelector("[role=tooltip]")','Tooltip Escape')
  await browser.evaluate('document.activeElement.blur();document.querySelector('+encoded+').scrollIntoView({block:"center"})')
  await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:1,y:1})
  const point=await browser.evaluate('(()=>{const r=document.querySelector('+encoded+').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()')
  await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',...point})
  await browser.until('document.querySelector("[role=tooltip]")?.textContent==='+text,'Hovered Report Tooltip content')
  await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:1,y:1})
  await browser.until('!document.querySelector("[role=tooltip]")','Tooltip pointer leave')
}

export async function reportReady(browser) {
  await browser.until('!!document.querySelector(".report-summary") && document.querySelector(".reports-v2")?.getAttribute("aria-busy")==="false"','Complete displayed Report')
}
export async function selectReportMode(browser, mode) {
  const labels={day:'\u65e5',week:'\u9031',month:'\u6708',range:'\u671f\u9593'},name=labels[mode]??mode
  await browser.until('!!document.querySelector(".report-mode")','Report controls')
  await browser.evaluate('Array.from(document.querySelectorAll(".report-mode [aria-pressed]")).find(e=>e.textContent==='+JSON.stringify(name)+').click()')
  await browser.until('document.querySelector(".report-mode [aria-pressed=true]")?.textContent==='+JSON.stringify(name),'Displayed Report mode')
  await reportReady(browser)
}
export function reportValues(planned, actual) {
  const format=n=>n<60?n+'\u5206':Math.floor(n/60)+'\u6642\u9593'+(n%60?n%60+'\u5206':'')
  const diff=actual===0?'\uff0d':actual===planned?'\u00b10':(actual>planned?'+':'-')+format(Math.abs(actual-planned))
  return [format(planned),format(actual),diff]
}
export async function expectReportSummary(browser, planned, actual) {
  const values=reportValues(planned,actual)
  await reportReady(browser)
  await browser.until('JSON.stringify(Array.from(document.querySelectorAll(".report-summary strong")).map(e=>e.textContent))==='+JSON.stringify(JSON.stringify(values)),'Planned / recorded / signed difference '+values.join(' / '))
  assert.deepEqual(await browser.evaluate('Array.from(document.querySelectorAll(".report-summary .summary-item > span")).map(e=>e.textContent)'),['\u8a08\u753b\u6e08\u307f','\u8a18\u9332','\u8a08\u753b\u5dee'])
}
export async function openReport(browser, mode='day') {
  await browser.until('!!document.querySelector(".icon-rail [aria-label=\u30ec\u30dd\u30fc\u30c8]")','Report Navigation')
  await browser.click('.icon-rail [aria-label="\u30ec\u30dd\u30fc\u30c8"]')
  await browser.until('!!document.querySelector("#report-tab-analysis")','Report Tabs')
  await browser.click('#report-tab-analysis')
  await selectReportMode(browser,mode)
}

// AbortController may cancel an obsolete intercepted request before it is released.
// Accept that specific CDP error only when Network confirms this request was canceled.
export async function releaseReportResponse(browser, response, canceled) {
  try { await browser.fulfill(response.requestId,response.body,response.status) }
  catch(error) {
    if(!/Invalid .*nterception|Invalid requestId/.test(error.message))throw error
    assert(canceled.has(response.networkId),'Obsolete response must be confirmed canceled, not silently ignored')
  }
  await browser.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
}
