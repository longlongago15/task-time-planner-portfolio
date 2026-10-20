import assert from 'node:assert/strict'
import test from 'node:test'
import { deadlineDisplay, emptyFilters, localDate, quickCounts, selectTasks } from '../src/taskListModel.ts'

const today = '2026-10-07'
const tasks = [
  { id: 1, title: 'Alpha', status: 'NOT_STARTED', projectId: 1, projectName: 'AWS', priority: 'HIGH', deadline: '2026-10-07', estimatedMinutes: 150, actualMinutes: 35, updatedAt: '2026-10-06', createdAt: '2026-10-01' },
  { id: 2, title: 'Beta', status: 'IN_PROGRESS', projectId: null, projectName: null, priority: 'LOW', deadline: '2026-10-03', estimatedMinutes: 30, actualMinutes: 10, updatedAt: '2026-10-07', createdAt: '2026-10-02' },
  { id: 3, title: 'Old complete', status: 'COMPLETED', projectId: 2, projectName: 'Learning', priority: 'MEDIUM', deadline: '2026-10-12', estimatedMinutes: 60, actualMinutes: 60, updatedAt: '2025-01-01', createdAt: '2024-01-01' },
  { id: 4, title: 'No fields', status: 'NOT_STARTED', projectId: 2, projectName: 'Learning', estimatedMinutes: null, actualMinutes: 0, updatedAt: '2026-10-05', createdAt: '2026-10-03' },
]
const blocks = [{ taskId: 1, date: today }, { taskId: 1, date: today }, { taskId: 2, date: '2026-12-01' }]
test('unified filters include all statuses; every status combination ORs and empty selection includes all',()=>{
  for(const status of [[],['NOT_STARTED'],['IN_PROGRESS'],['COMPLETED'],['NOT_STARTED','IN_PROGRESS'],['NOT_STARTED','COMPLETED'],['IN_PROGRESS','COMPLETED'],['NOT_STARTED','IN_PROGRESS','COMPLETED']]){
    const actual=selectTasks(tasks,blocks,today,'all','',{...emptyFilters(),status},'title',true).map(t=>t.id).sort()
    assert.deepEqual(actual,tasks.filter(t=>!status.length||status.includes(t.status)).map(t=>t.id).sort())
  }
})
test('placement uses all blocks; categories AND while Project Priority and Tags OR',()=>{
  const values=tasks.map(t=>({...t,tags:t.id===1?[{id:1,name:'A'}]:t.id===2?[{id:2,name:'B'}]:[{id:1,name:'A'},{id:2,name:'B'}]}))
  const run=(filters,search='')=>selectTasks(values,blocks,today,'all',search,{...emptyFilters(),...filters},'title',true).map(t=>t.id).sort()
  assert.deepEqual(run({status:['NOT_STARTED','IN_PROGRESS'],placement:['unplanned']}),[4])
  assert.deepEqual(run({status:['NOT_STARTED'],priority:['HIGH']}),[1])
  assert.deepEqual(run({status:['IN_PROGRESS'],project:['unassigned']}),[2])
  assert.deepEqual(run({status:['IN_PROGRESS'],project:['unassigned'],tag:['2']}),[2])
  assert.deepEqual(run({tag:['1']}),[1,3,4]);assert.deepEqual(run({tag:['2']}),[2,3,4]);assert.deepEqual(run({tag:['1','2']}),[1,2,3,4])
  assert.deepEqual(run({project:['1','2'],priority:['HIGH','MEDIUM']}),[1,3])
  assert.deepEqual(run({status:['NOT_STARTED','IN_PROGRESS']},' alpha '),[1])
})
test('unified deadlines use inclusive local month and range boundaries',()=>{
  const run=filters=>selectTasks(tasks,blocks,today,'all','',{...emptyFilters(),...filters},'title',true).map(t=>t.id).sort()
  assert.deepEqual(run({deadline:['month']}),[1,2,3])
  assert.deepEqual(run({deadline:['range'],deadlineRange:{start:'2026-10-03',end:'2026-10-07'}}),[1,2])
  assert.deepEqual(run({deadline:['range'],deadlineRange:{start:'2026-10-12',end:''}}),[3])
  assert.deepEqual(run({deadline:['range'],deadlineRange:{start:'2026-10-12',end:'2026-10-03'}}),[])
})
const ids = (quick = 'incomplete', filters = emptyFilters(), sort = 'updatedAt', ascending = false, search = '') => selectTasks(tasks, blocks, today, quick, search, filters, sort, ascending).map(t => t.id)
test('counts include all statuses and unique scheduled tasks without a period cutoff', () => assert.deepEqual(quickCounts(tasks, blocks, today), { total: 4, incomplete: 3, today: 1, unplanned: 2, completed: 1 }))
test('Quick View uses all ScheduleBlocks, including future placement and unscheduled completed tasks', () => {
  assert.deepEqual(ids(), [2, 1, 4]); assert.deepEqual(ids('today'), [1]); assert.deepEqual(ids('unplanned'), [4, 3]); assert.deepEqual(ids('completed'), [3])
})
test('title search composes with Quick View and ignores surrounding spaces and case', () => assert.deepEqual(ids('incomplete', emptyFilters(), 'updatedAt', false, ' ALP '), [1]))
test('multiple status and project choices OR within a category and AND across categories', () => {
  assert.deepEqual(ids('incomplete', { ...emptyFilters(), status: ['NOT_STARTED', 'IN_PROGRESS'], project: ['1', 'unassigned'] }), [2, 1])
})
test('priority choices use priority and tolerate APIs without this field', () => assert.deepEqual(ids('incomplete', { ...emptyFilters(), priority: ['HIGH', 'LOW'] }), [2, 1]))
for (const [value, expected] of [['none', [4]], ['today', [1]], ['week', [1]], ['has', [2, 1]], ['overdue', [2]]]) {
  test(`deadline filter ${value} uses local calendar dates`, () => assert.deepEqual(ids('incomplete', { ...emptyFilters(), deadline: [value] }), expected))
}
test('deadline alternatives OR together', () => assert.deepEqual(ids('incomplete', { ...emptyFilters(), deadline: ['none', 'overdue'] }), [2, 4]))
for (const sort of ['updatedAt', 'createdAt', 'title', 'projectName', 'priority', 'status', 'deadline', 'estimatedMinutes']) {
  test(`sort ${sort} switches ASC/DESC with missing values last`, () => {
    const present = tasks.filter(t => t.status !== 'COMPLETED' && t[sort] != null)
    const asc = ids('incomplete', emptyFilters(), sort, true).filter(id => present.some(t => t.id === id))
    const desc = ids('incomplete', emptyFilters(), sort, false).filter(id => present.some(t => t.id === id))
    // Ties retain stable ID order in either direction.
    if (sort !== 'status' && sort !== 'projectName') assert.deepEqual(desc, [...asc].reverse())
    assert.equal(new Set(asc).size, present.length)
  })
}
test('deadline has only none/normal/overdue and only the relative overdue text is separate', () => {
  assert.deepEqual(deadlineDisplay(null, today), { state: 'none', date: '期限なし', relative: '' })
  assert.deepEqual(deadlineDisplay('2026-10-12', today), { state: 'normal', date: '2026/10/12', relative: 'あと5日' })
  assert.equal(deadlineDisplay(today, today).relative, '今日')
  assert.equal(deadlineDisplay('2026-10-08', today).state, 'normal')
  assert.deepEqual(deadlineDisplay('2026-10-03', today), { state: 'overdue', date: '2026/10/03', relative: '4日超過' })
})
test('deadline counts days through month, year and DST transitions', () => {
  assert.equal(deadlineDisplay('2027-01-01', '2026-12-31').relative, 'あと1日')
  assert.equal(deadlineDisplay('2026-03-09', '2026-03-07').relative, 'あと2日')
})

test('current local week includes both Monday and Sunday but excludes previous and next week', () => {
  const tasks = ['2026-10-04','2026-10-05','2026-10-07','2026-10-11','2026-10-12'].map((deadline, i) => ({ id: i+1, title: deadline, status:'NOT_STARTED', projectId:null, projectName:null, estimatedMinutes:null, actualMinutes:0, deadline }))
  for (const day of ['2026-10-05','2026-10-07','2026-10-11']) {
    assert.deepEqual(selectTasks(tasks, [], day, 'incomplete', '', { ...emptyFilters(), deadline:['week'] }, 'deadline', true).map(t=>t.id), [2,3,4])
  }
})

test('overdue filter excludes completed tasks even in Today Quick View', () => {
  const overdue = tasks.map(task=>({...task,deadline:'2026-10-01'}))
  const blocks = overdue.map(task=>({taskId:task.id,date:today}))
  assert.deepEqual(selectTasks(overdue,blocks,today,'today','',{...emptyFilters(),deadline:['overdue']},'title',true).map(t=>t.id),[1,2,4])
})

test('priority and numeric estimate sort both directions leave NULL last', () => {
  const values = tasks.map((task,i)=>({...task,status:'NOT_STARTED',priority:['LOW','HIGH','MEDIUM',null][i],estimatedMinutes:[30,150,120,null][i]}))
  for(const [sort,asc,desc] of [['priority',[2,3,1,4],[1,3,2,4]],['estimatedMinutes',[1,3,2,4],[2,3,1,4]]]) {
    assert.deepEqual(selectTasks(values,[],today,'incomplete','',emptyFilters(),sort,true).map(t=>t.id),asc)
    assert.deepEqual(selectTasks(values,[],today,'incomplete','',emptyFilters(),sort,false).map(t=>t.id),desc)
  }
})

test('local date changes at Tokyo midnight rather than UTC midnight', () => {
  const previous = process.env.TZ
  try {
    process.env.TZ = 'Asia/Tokyo'
    assert.equal(localDate(new Date('2026-10-06T14:59:59Z')), '2026-10-06')
    assert.equal(localDate(new Date('2026-10-06T15:00:00Z')), '2026-10-07')
    assert.equal(deadlineDisplay('2026-10-07', localDate(new Date('2026-10-06T15:00:00Z'))).relative, '今日')
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
})
