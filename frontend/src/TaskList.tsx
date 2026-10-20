import { dismissPopupOnEscape, focusPopupControl, listenOutsidePopup } from './popupInteraction'
import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useTags } from './TagStore'
import { ProjectIcon, UiIcon } from './UiIcon'
import { TagChip } from './TagChip'
import { TaskStatusChip } from './TaskStatusChip'
import { AppliedFilterChip, FilterChoices, FilterProjectValue, FilterTrigger } from './TaskFilterPresentation'
import { useCalendarClock } from './useCalendarClock'
import { taskStatusLabels } from './taskStatus'
import { emptyFilters, localDate, priorityLabels, selectTasks, sortLabels } from './taskListModel'
import type { Filters, ListTask, SortItem } from './taskListModel'
import { useTaskSchedules } from './useTaskSchedules'
import type { TaskSchedules } from './useTaskSchedules'

type Category = 'status' | 'placement' | 'project' | 'priority' | 'deadline' | 'tag'
const labels: Record<Category, string> = { status: 'ステータス', placement: '配置', project: 'プロジェクト', priority: '優先度', deadline: '期限', tag: 'タグ' }
type Option = { value: string; label: string }

export function TaskList<T extends ListTask>({ tasks, projects, refresh, projectFilter, onProjectFilter, onCreate, renderTask, projectContext = false, schedules }: {
  tasks: T[]; projects: { id: number; name: string; color?: string | null }[]; refresh: number; projectFilter: string
  onProjectFilter: (value: string) => void; onCreate: () => void; renderTask: (task: T) => ReactNode
  projectContext?: boolean; schedules?: TaskSchedules
}) {
  const tagStore = useTags()
  const tagsLoaded = useRef(false)
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<Filters>(() => ({ ...emptyFilters(), project: projectContext || projectFilter === 'all' ? [] : [projectFilter] }))
  const [sort, setSort] = useState<SortItem>('updatedAt')
  const [ascending, setAscending] = useState(false)
  const [open, setOpen] = useState<Category | 'sort' | null>(null)
  const [projectSearch, setProjectSearch] = useState('')
  const ownSchedules = useTaskSchedules(refresh, !schedules)
  const { blocks, status: scheduleStatus, retry } = schedules ?? ownSchedules
  const now = useCalendarClock(true)
  const today = localDate(new Date(now))
  const root = useRef<HTMLDivElement>(null)
  const lastTrigger = useRef<HTMLButtonElement | null>(null)
  const id = useId()
  useEffect(() => {
    if (!open) return
    const disposeOutside = listenOutsidePopup(() => [root.current], () => setOpen(null))
    const escape = (event: KeyboardEvent) => { dismissPopupOnEscape(event, () => { setOpen(null); focusPopupControl(lastTrigger.current) }) }
    document.addEventListener('keydown', escape)
    focusPopupControl(root.current?.querySelector<HTMLElement>('.task-filter-popover input, .task-filter-popover button'), { preventScroll: false })
    return () => { disposeOutside(); document.removeEventListener('keydown', escape) }
  }, [open])
  const options: Record<Category, Option[]> = {
    status: Object.entries(taskStatusLabels).map(([value, label]) => ({ value, label })),
    placement: [{ value: 'unplanned', label: '未配置' }, { value: 'scheduled', label: '配置済み' }],
    project: [{ value: 'unassigned', label: '未所属' }, ...projects.map(p => ({ value: String(p.id), label: p.name }))],
    priority: Object.entries(priorityLabels).map(([value, label]) => ({ value, label })),
    tag: tagStore.tags.map(tag => ({ value: String(tag.id), label: tag.name })),
    deadline: [{ value: 'today', label: '今日' }, { value: 'week', label: '今週' }, { value: 'month', label: '今月' }, { value: 'overdue', label: '期限切れ' }, { value: 'none', label: '期限なし' }, { value: 'range', label: '期間指定' }],
  }
  useEffect(() => {
    if (tagStore.status === 'ready') tagsLoaded.current = true
    if (tagsLoaded.current) setFilters(current => ({ ...current, tag: current.tag.filter(id => tagStore.tags.some(tag => String(tag.id) === id)) }))
  }, [tagStore.tags, tagStore.status])
  const update = (category: Category, values: string[]) => {
    setFilters(current => ({ ...current, [category]: values }))
    if (category === 'project') onProjectFilter(values.length === 1 ? values[0] : 'all')
  }
  const toggle = (category: Category, value: string) => {
    const values = filters[category] ?? []
    update(category, values.includes(value) ? values.filter(v => v !== value) : (category === 'placement' || category === 'deadline') ? [value] : [...values, value])
  }
  const effectiveFilters = { ...filters, tag: tagsLoaded.current ? filters.tag.filter(id => tagStore.tags.some(tag => String(tag.id) === id)) : filters.tag }
  const visible = selectTasks(tasks, blocks, today, 'all', search, effectiveFilters, sort, ascending)
  const categories: Category[] = projectContext ? ['status', 'placement', 'priority', 'deadline', 'tag'] : Object.keys(labels) as Category[]
  const applied = categories.some(category => filters[category]?.length)
  const trigger = (category: Category | 'sort', button: HTMLButtonElement) => { lastTrigger.current = button; setOpen(current => current === category ? null : category); setProjectSearch('') }
  const popover = (category: Category | 'sort') => open === category && <div id={`${id}-${category}`} className="task-filter-popover" role="dialog" aria-label={category === 'sort' ? '並び替え' : `${labels[category]}の絞り込み`}>
    {category === 'sort' ? (Object.entries(sortLabels) as [SortItem, string][]).filter(([value]) => !projectContext || value !== 'projectName').map(([value, label]) => <button type="button" key={value} aria-pressed={sort === value} onClick={() => { setSort(value); setOpen(null); lastTrigger.current?.focus() }}>{label}</button>)
      : <>
        <FilterChoices options={options[category].map(option => ({ ...option, content: category === 'tag' ? <TagChip tag={tagStore.tags.find(tag => String(tag.id) === option.value)!} />
          : category === 'project' ? <FilterProjectValue project={projects.find(project => String(project.id) === option.value)} label={option.label} />
          : category === 'priority' ? <span className={`priority-option-label priority-${option.value.toLowerCase() || 'none'}`}>{option.label}</span> : undefined }))}
          selected={filters[category] ?? []} onToggle={value => toggle(category, value)} search={category === 'project' || category === 'tag' ? { label: `${labels[category]}を検索`, value: projectSearch, onChange: setProjectSearch } : undefined} />
        {category === 'deadline' && filters.deadline.includes('range') && <div className="task-filter-date-range">
          <label>開始日<input type="date" aria-label="期限の開始日" value={filters.deadlineRange?.start ?? ''} max={filters.deadlineRange?.end || undefined} onChange={e => setFilters(current => ({ ...current, deadlineRange: { start: e.target.value, end: current.deadlineRange?.end ?? '' } }))} /></label>
          <label>終了日<input type="date" aria-label="期限の終了日" value={filters.deadlineRange?.end ?? ''} min={filters.deadlineRange?.start || undefined} onChange={e => setFilters(current => ({ ...current, deadlineRange: { start: current.deadlineRange?.start ?? '', end: e.target.value } }))} /></label>
        </div>}
        {category === 'tag' && tagStore.status === 'error' && <p className="error" role="alert">タグを取得できませんでした。<button type="button" onClick={() => void tagStore.reload()}>再取得</button></p>}
        <button type="button" onClick={() => update(category, [])}>この条件を解除</button>
      </>}
  </div>
  const direction = sort === 'priority' ? ascending ? '高い順' : '低い順' : sort === 'deadline' ? ascending ? '近い順' : '遠い順' : sort === 'estimatedMinutes' ? ascending ? '短い順' : '長い順' : sort === 'title' ? ascending ? 'A→Z' : 'Z→A' : ascending ? '昇順' : '降順'
  const sortControls = <div className="task-sort-controls"><div className="task-filter-anchor" data-filter="sort"><button type="button" className="secondary-button" aria-expanded={open === 'sort'} aria-haspopup="dialog" onClick={e => trigger('sort', e.currentTarget)}>並び替え：{sortLabels[sort]}<UiIcon name="chevronDown" /></button>{popover('sort')}</div><button type="button" className="secondary-button" aria-label={`並び替え方向：${direction}`} title={direction} onClick={() => setAscending(value => !value)}><UiIcon name={ascending ? 'arrowUp' : 'arrowDown'} /></button></div>
  return <>
    {!projectContext && <header className="task-list-heading workspace-page-heading"><div><h1>タスク一覧</h1><p className="task-counts">{applied || search.trim() ? `${tasks.length}件中 ${visible.length}件を表示` : `${tasks.length}件`}</p></div><div className="task-list-tools"><button type="button" className="primary-action" onClick={onCreate}><UiIcon name="plus" />新規タスク</button></div></header>}
    <section className="task-list-toolbar panel task-list-unified">
      {projectContext && <p className="task-counts">{applied || search.trim() ? `${tasks.length}件中 ${visible.length}件を表示` : `${tasks.length}件`}</p>}
      <label className="task-search"><UiIcon name="search" /><input type="search" aria-label="タスクを検索" placeholder="タスクを検索..." value={search} onChange={e => setSearch(e.target.value)} /></label>
      <div ref={root} className="task-filter-area">
        <div className="task-filter-sort-row"><div className="task-filter-buttons">
          {categories.map(category => <FilterTrigger key={category} category={category} label={labels[category]} id={`${id}-${category}`} open={open === category} onClick={button => trigger(category, button)}>{popover(category)}</FilterTrigger>)}
        </div>{sortControls}</div>
        {applied && <div className="task-applied-filters"><div className="task-applied-filter-chips"><span>適用中：</span>{categories.flatMap(category => {
          const values = filters[category] ?? [], names = values.map(value => value === 'range' ? `期間指定 ${filters.deadlineRange?.start ?? ''}～${filters.deadlineRange?.end ?? ''}` : options[category].find(o => o.value === value)?.label ?? value)
          return values.map((value, index) => {
            const project = category === 'project' ? projects.find(p => String(p.id) === value) : undefined
            return <AppliedFilterChip key={`${category}-${value}`} category={category} label={labels[category]} name={names[index]} project={project}
              tag={category === 'tag' ? tagStore.tags.find(tag => String(tag.id) === value) : undefined} onRemove={() => toggle(category, value)}>
              {category === 'status' ? <TaskStatusChip status={value} /> : category === 'project' && !projectContext ? <FilterProjectValue project={project} label={names[index]} applied /> : <span>{labels[category]}：{names[index]}</span>}
            </AppliedFilterChip>
          })
        })}</div><button type="button" className="task-clear-all" onClick={() => { setFilters(emptyFilters()); onProjectFilter('all') }}>すべて解除</button></div>}
      </div>
    </section>
    <section className={`panel task-list-panel task-list-v43 task-list-unified-table ${projectContext ? 'task-list-project-context' : 'task-list-standard'}`}>
      {scheduleStatus === 'error' && <p className="error" role="alert">予定を取得できませんでした。<button type="button" onClick={retry}>再取得</button></p>}
      <div className="task-table-scroll" tabIndex={0} aria-label="タスク一覧の表">
      <div className="task-table-header" aria-hidden="true">{['ステータス', 'タスク名', 'タグ', ...(!projectContext ? ['プロジェクト'] : []), '優先度', projectContext ? '期限' : '期間', '見積もり', '記録', ...(projectContext ? ['⋮'] : ['編集', '計測'])].map(label => <span key={label}>{!projectContext && (label === 'タグ' ? <UiIcon name="tagFilled" /> : label === 'プロジェクト' ? <ProjectIcon tone="neutral" style={{ color: 'inherit' }} /> : label === '優先度' ? <UiIcon name="flag" style={{ fill: 'currentColor' }} /> : label === '期間' ? <UiIcon name="calendar" /> : null)}{label}</span>)}</div>
      {!!filters.placement?.length && scheduleStatus !== 'ready' ? <p className="empty-state" role="status">{scheduleStatus === 'loading' ? '予定を読み込んでいます' : '予定を再取得してください'}</p> : visible.length ? <ul className="task-list">{visible.map(renderTask)}</ul> : <p className="empty-state">{tasks.length ? '条件に一致するTaskがありません' : 'Taskがありません'}</p>}
      </div>
    </section>
  </>
}
