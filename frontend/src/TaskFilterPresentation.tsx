import type { ReactNode } from 'react'
import type { Tag } from './TagStore'
import { ProjectIcon, UiIcon } from './UiIcon'
import { TagChip } from './TagChip'
import { TaskStatusChip } from './TaskStatusChip'
import { getProjectColor, getTagChipStyle, getTagColor } from './identificationColors'

type Project = { id: number; name: string; color?: string | null }
export function FilterProjectValue({ project, label, applied = false }: { project?: Project; label: string; applied?: boolean }) {
  return <span className={applied ? `task-filter-project-value ${project ? '' : 'unset-value'}` : undefined}
    style={project ? { color: getProjectColor(project) } : undefined}><ProjectIcon project={project} />{label}</span>
}

// Presentation only: each screen owns its options, open state and filtering logic.
export function FilterChoices({ options, selected, onToggle, search }: {
  options: { value: string; label: string; content?: ReactNode }[]; selected: string[]; onToggle: (value: string) => void
  search?: { label: string; value: string; onChange: (value: string) => void }
}) {
  return <>
    {search && <input type="search" aria-label={search.label} placeholder={`${search.label}...`} value={search.value} onChange={event => search.onChange(event.target.value)} />}
    {options.filter(option => !search || option.label.toLocaleLowerCase().includes(search.value.toLocaleLowerCase())).map(option =>
      <label key={option.value}><input type="checkbox" checked={selected.includes(option.value)} onChange={() => onToggle(option.value)} />{option.content ?? option.label}</label>)}
  </>
}

export function FilterTrigger({ category, label, id, open, onClick, children }: {
  category: string; label: string; id: string; open: boolean; onClick: (button: HTMLButtonElement) => void; children: ReactNode
}) {
  return <div className="task-filter-anchor" data-filter={category}><button type="button" className="secondary-button" aria-expanded={open} aria-haspopup="dialog" aria-controls={open ? id : undefined}
    onClick={event => onClick(event.currentTarget)}>{label}<UiIcon name="chevronDown" /></button>{children}</div>
}

export function AppliedFilterChip({ category, label, name, onRemove, project, tag, children }: {
  category: string; label: string; name: string; onRemove: () => void; project?: Project; tag?: Tag; children?: ReactNode
}) {
  return <div className={`task-filter-chip${category === 'status' ? ' task-filter-status-chip' : ''}`}
    style={tag ? getTagChipStyle(getTagColor(tag)) : undefined}>
    {children ?? (category === 'status' ? <TaskStatusChip status={name} /> : category === 'project' ? <FilterProjectValue project={project} label={name} applied />
      : tag ? <><UiIcon name="tag" /><TagChip tag={tag} /></> : <span>{label}：{name}</span>)}
    <button type="button" aria-label={`${label}：${name}を解除`} onClick={onRemove}><UiIcon name="close" /></button>
  </div>
}
