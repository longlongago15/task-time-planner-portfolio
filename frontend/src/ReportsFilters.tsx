import { dismissPopupOnEscape, focusPopupControl, listenOutsidePopup } from './popupInteraction'
import { useEffect, useId, useRef, useState } from 'react'
import type { Tag } from './TagStore'
import { TagChip } from './TagChip'
import { TaskStatusChip } from './TaskStatusChip'
import { taskStatusLabels } from './taskStatus'
import { AppliedFilterChip, FilterChoices, FilterProjectValue, FilterTrigger } from './TaskFilterPresentation'
import { emptyReportFilters } from './reportFilters'
import type { ReportFilters } from './reportFilters'

const labels = { project: 'プロジェクト', tag: 'タグ', status: 'ステータス' }
type Category = keyof ReportFilters
type Project = { id: number; name: string; color?: string | null }

export function ReportsFilters({ projects, tags, filters, onChange }: {
  projects: Project[]; tags: Tag[]; filters: ReportFilters; onChange: (filters: ReportFilters) => void
}) {
  const [open, setOpen] = useState<Category | null>(null)
  const [search, setSearch] = useState('')
  const root = useRef<HTMLElement>(null), trigger = useRef<HTMLButtonElement | null>(null)
  const id = useId()
  useEffect(() => {
    if (!open) return
    const disposeOutside = listenOutsidePopup(() => [root.current], () => setOpen(null))
    const escape = (event: KeyboardEvent) => { dismissPopupOnEscape(event, () => { setOpen(null); focusPopupControl(trigger.current) }) }
    document.addEventListener('keydown', escape)
    focusPopupControl(root.current?.querySelector<HTMLElement>('.task-filter-popover input, .task-filter-popover button'), { preventScroll: false })
    return () => { disposeOutside(); document.removeEventListener('keydown', escape) }
  }, [open])
  const options = {
    project: [{ value: 'unassigned', label: '未所属', content: <FilterProjectValue label="未所属" /> }, ...projects.map(project => ({ value: String(project.id), label: project.name, content: <FilterProjectValue project={project} label={project.name} /> }))],
    tag: tags.map(tag => ({ value: String(tag.id), label: tag.name, content: <TagChip tag={tag} /> })),
    status: Object.entries(taskStatusLabels).map(([value, label]) => ({ value, label, content: <TaskStatusChip status={value} /> })),
  }
  const toggle = (category: Category, value: string) => onChange({ ...filters, [category]: filters[category].includes(value) ? filters[category].filter(item => item !== value) : [...filters[category], value] })
  const categories = Object.keys(labels) as Category[]
  return <section ref={root} className="panel task-filter-area report-filters" aria-label="レポートの絞り込み">
    <div className="task-filter-buttons">{categories.map(category => <FilterTrigger key={category} category={category} label={labels[category]} id={`${id}-${category}`} open={open === category}
      onClick={button => { trigger.current = button; setOpen(current => current === category ? null : category); setSearch('') }}>
      {open === category && <div id={`${id}-${category}`} className="task-filter-popover" role="dialog" aria-label={`${labels[category]}の絞り込み`}>
        <FilterChoices options={options[category]} selected={filters[category]} onToggle={value => toggle(category, value)}
          search={category !== 'status' ? { label: `${labels[category]}を検索`, value: search, onChange: setSearch } : undefined} />
        <button type="button" onClick={() => onChange({ ...filters, [category]: [] })}>この条件を解除</button>
      </div>}
    </FilterTrigger>)}</div>
    {categories.some(category => filters[category].length) && <div className="task-applied-filters"><div className="task-applied-filter-chips"><span>適用中：</span>
      {categories.flatMap(category => filters[category].map(value => {
        const name = options[category].find(option => option.value === value)?.label ?? value
        return <AppliedFilterChip key={`${category}-${value}`} category={category} label={labels[category]} name={name} onRemove={() => toggle(category, value)}
          project={category === 'project' ? projects.find(project => String(project.id) === value) : undefined} tag={category === 'tag' ? tags.find(tag => String(tag.id) === value) : undefined}>
          {category === 'status' ? <TaskStatusChip status={value} /> : undefined}
        </AppliedFilterChip>
      }))}</div><button type="button" className="task-clear-all" onClick={() => onChange(emptyReportFilters())}>すべて解除</button></div>}
  </section>
}
