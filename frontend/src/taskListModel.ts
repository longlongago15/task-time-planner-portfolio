export type ListTask = {
  id: number; title: string; status: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED'
  projectId: number | null; projectName: string | null; estimatedMinutes: number | null; actualMinutes: number
  tags?: { id: number; name: string }[]
  createdAt?: string; updatedAt?: string; priority?: 'HIGH' | 'MEDIUM' | 'LOW' | null; deadline?: string | null; startDate?: string | null
}
export type QuickView = 'incomplete' | 'today' | 'unplanned' | 'completed' | 'all'
export type Filters = { status: string[]; project: string[]; priority: string[]; deadline: string[]; tag: string[]; placement?: string[]; deadlineRange?: { start: string; end: string } }
export type SortItem = 'updatedAt' | 'createdAt' | 'title' | 'projectName' | 'priority' | 'status' | 'deadline' | 'estimatedMinutes'
export const emptyFilters = (): Filters => ({ status: [], project: [], priority: [], deadline: [], tag: [], placement: [] })
export const sortLabels: Record<SortItem, string> = { updatedAt: '更新日', createdAt: '作成日', title: '名前', projectName: 'プロジェクト', priority: '優先度', status: 'ステータス', deadline: '期限', estimatedMinutes: '見積もり' }
export const priorityLabels: Record<string, string> = { HIGH: '高', MEDIUM: '中', LOW: '低', '': '未設定' }
export function localDate(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}
// Calendar dates, rather than elapsed milliseconds, keep DST days at one day.
const dayNumber = (date: string) => { const [y, m, d] = date.slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000 }
export function deadlineDisplay(deadline: string | null | undefined, today: string) {
  if (!deadline) return { state: 'none', date: '期限なし', relative: '' }
  const days = dayNumber(deadline) - dayNumber(today)
  return { state: days < 0 ? 'overdue' : 'normal', date: deadline.slice(0, 10).replaceAll('-', '/'), relative: days < 0 ? `${-days}日超過` : days === 0 ? '今日' : `あと${days}日` }
}
export function quickCounts(tasks: ListTask[], blocks: { taskId: number; date: string }[], today: string) {
  const scheduled = new Set(blocks.map(b => b.taskId)), todayIds = new Set(blocks.filter(b => b.date === today).map(b => b.taskId))
  return { total: tasks.length, incomplete: tasks.filter(t => t.status !== 'COMPLETED').length, today: tasks.filter(t => todayIds.has(t.id)).length, unplanned: tasks.filter(t => !scheduled.has(t.id)).length, completed: tasks.filter(t => t.status === 'COMPLETED').length }
}
export function selectTasks<T extends ListTask>(tasks: T[], blocks: { taskId: number; date: string }[], today: string, quick: QuickView, search: string, filters: Filters, sort: SortItem, ascending: boolean) {
  const scheduled = new Set(blocks.map(b => b.taskId)), todayIds = new Set(blocks.filter(b => b.date === today).map(b => b.taskId))
  const weekday = new Date(`${today}T12:00:00`).getDay()
  const weekStart = dayNumber(today) - ((weekday + 6) % 7)
  const weekEnd = weekStart + 6
  const deadlineMatches = (task: ListTask, value: string) => {
    if (value === 'none') return !task.deadline
    if (!task.deadline) return false
    const day = dayNumber(task.deadline)
    return value === 'has' || value === 'today' && day === dayNumber(today) || value === 'week' && day >= weekStart && day <= weekEnd
      || value === 'month' && task.deadline.slice(0, 7) === today.slice(0, 7)
      || value === 'range' && !!filters.deadlineRange && (!!filters.deadlineRange.start || !!filters.deadlineRange.end)
        && (!filters.deadlineRange.start || day >= dayNumber(filters.deadlineRange.start)) && (!filters.deadlineRange.end || day <= dayNumber(filters.deadlineRange.end))
      || value === 'overdue' && day < dayNumber(today) && (quick === 'all' || task.status !== 'COMPLETED')
  }
  const ranks: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2, NOT_STARTED: 0, IN_PROGRESS: 1, COMPLETED: 2 }
  return tasks.filter(t => (
    (quick === 'all' || (quick === 'incomplete' ? t.status !== 'COMPLETED' : quick === 'completed' ? t.status === 'COMPLETED' : quick === 'today' ? todayIds.has(t.id) : !scheduled.has(t.id)))
    && t.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
    && (!filters.status.length || filters.status.includes(t.status))
    && (!filters.placement?.length || filters.placement.includes(scheduled.has(t.id) ? 'scheduled' : 'unplanned'))
    && (!filters.project.length || filters.project.includes(t.projectId === null ? 'unassigned' : String(t.projectId)))
    && (!filters.tag?.length || (t.tags ?? []).some(tag => filters.tag.includes(String(tag.id))))
    && (!filters.priority.length || filters.priority.includes(t.priority ?? ''))
    && (!filters.deadline.length || filters.deadline.some(value => deadlineMatches(t, value)))
  )).sort((a, b) => {
    const av = a[sort], bv = b[sort]
    if (av == null || av === '') return bv == null || bv === '' ? a.id - b.id : 1
    if (bv == null || bv === '') return -1
    const compared = sort === 'priority' || sort === 'status' ? ranks[String(av)] - ranks[String(bv)] : typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv), 'ja', { numeric: true })
    return (ascending ? compared : -compared) || a.id - b.id
  })
}
