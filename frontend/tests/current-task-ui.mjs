import assert from 'node:assert/strict'

// Operate the current shared Picker; selectors may also be row expressions.
export async function chooseTaskStatus(browser, target, value) {
  const row = target.startsWith('document.') || target.startsWith('Array.') || target.startsWith('[') && target.includes('querySelector') ? target : `document.querySelector(${JSON.stringify(target)})`
  const trigger = `${row}.querySelector('.task-status-trigger')`
  await browser.until(`${trigger} && !${trigger}.disabled`, 'Status Trigger ready')
  await browser.evaluate(`${trigger}.click()`)
  await browser.until(`${trigger}.getAttribute('aria-expanded')==='true'`, 'Status Picker open')
  const option = `document.getElementById(${trigger}.getAttribute('aria-controls')).querySelector('[data-value="${value}"]')`
  assert(await browser.evaluate(`${option}?.getAttribute('role')==='menuitemradio'`))
  await browser.evaluate(`${option}.click()`)
}

export async function setTaskFilter(browser, category, values) {
  const scope = `[data-filter="${category}"]`
  await browser.click(scope + ' > button')
  await browser.until(`document.querySelector(${JSON.stringify(scope + ' .task-filter-popover')})`, 'Filter open')
  const labels = { NOT_STARTED:'\u672a\u7740\u624b', IN_PROGRESS:'\u9032\u884c\u4e2d', COMPLETED:'\u5b8c\u4e86', scheduled:'\u914d\u7f6e\u6e08\u307f', unplanned:'\u672a\u914d\u7f6e' }
  const selected = values.map(value => labels[value] ?? value)
  const options = `Array.from(document.querySelectorAll(${JSON.stringify(scope + ' .task-filter-popover label')}))`
  const available = await browser.evaluate(`${options}.map(e=>e.textContent.trim())`)
  for (const value of selected) assert(available.includes(value), `Missing ${category} Filter option ${value}`)
  for (const value of available) {
    const input = `${options}.find(e=>e.textContent.trim()===${JSON.stringify(value)}).querySelector('input[type=checkbox]')`
    if (await browser.evaluate(`${input}.checked`) !== selected.includes(value)) await browser.evaluate(`${input}.click()`)
  }
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await browser.until(`!document.querySelector(${JSON.stringify(scope + ' .task-filter-popover')})`, 'Filter closed')
}

// Geometry follows the approved screen contracts, not an arbitrary measured snapshot.
export async function assertTaskTable(browser) {
  const m = await browser.evaluate(`(()=>{const h=document.querySelector('.task-table-header'),r=document.querySelector('.task-table-row'),s=document.querySelector('.task-table-scroll'),rect=e=>e.getBoundingClientRect();return{project:!!document.querySelector('.task-list-project-context'),width:innerWidth,display:getComputedStyle(h).display,columns:getComputedStyle(h).gridTemplateColumns.split(' ').map(parseFloat),name:rect(r.querySelector('.task-table-name')).width,tags:rect(r.querySelector('.task-table-tags')).width,table:rect(r).width,client:s.clientWidth,scroll:s.scrollWidth,overflow:document.documentElement.scrollWidth>innerWidth,aligned:[...h.children].every((c,i)=>Math.abs(rect(c).left-rect(r.children[i]).left)<.5&&Math.abs(rect(c).width-rect(r.children[i]).width)<.5)}})()`)
  assert.equal(m.overflow, false, 'No page horizontal overflow')
  if (m.width <= 600) {
    assert.equal(m.display, 'none'); assert(m.scroll <= m.client + 1, 'Mobile Cards contain their controls')
  } else {
    assert(m.aligned, 'Header and Row share column geometry')
    assert(m.name >= 220 && m.tags >= 144, 'Readable title and Tags')
    if (m.project) {
      assert.equal(m.columns.length, 8)
      assert.deepEqual([m.columns[0],...m.columns.slice(3)], [128,128,128,128,128,128])
      const available = m.table - 6 * 128, tagWidth = Math.max(144, available / 3)
      assert(Math.abs(m.columns[2]-tagWidth)<1 && Math.abs(m.columns[1]-(available-tagWidth))<1, 'Project flexible columns keep 2:1 after respecting both readable minima')
    } else {
      assert.equal(m.columns.length, 10)
      assert.deepEqual([m.columns[0],...m.columns.slice(2)], [88,144,192,88,168,88,88,56,56])
    }
    assert(Math.abs(m.table-Math.max(m.project?1132:1188,m.client))<1, 'Only the Table scrolls below its minimum width')
    assert.equal(m.scroll>m.client+1,m.client<(m.project?1132:1188)-1)
  }
  console.log('Task Table geometry', JSON.stringify(m))
  return m
}
