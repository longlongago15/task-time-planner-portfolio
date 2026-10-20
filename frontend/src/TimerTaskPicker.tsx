import { useEffect, useId, useRef, useState } from 'react'

type Choice = { id: number; title: string; projectName: string | null; completed?: boolean; status?: string }

export function TimerTaskPicker({ tasks, choice, disabled, onChoice, onQueryChange }: { tasks: Choice[]; choice: string; disabled: boolean; onChoice: (value: string) => void; onQueryChange: (value: string) => void }) {
  const id = useId()
  const [query, setQuery] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [index, setIndex] = useState(0)
  const list = useRef<HTMLUListElement>(null)
  const available = tasks.filter(task => !task.completed && task.status !== 'COMPLETED')
  const matches = available.filter(task => `${task.title} ${task.projectName ?? ''}`.toLocaleLowerCase().includes((query ?? '').trim().toLocaleLowerCase()))
  const select = (task: Choice) => { onChoice(String(task.id)); onQueryChange(''); setQuery(null); setOpen(false) }
  useEffect(() => {
    const container = list.current
    const option = container?.children[index] as HTMLElement | undefined
    if (!container || !option) return
    if (option.offsetTop < container.scrollTop) container.scrollTop = option.offsetTop
    else if (option.offsetTop + option.offsetHeight > container.scrollTop + container.clientHeight) container.scrollTop = option.offsetTop + option.offsetHeight - container.clientHeight
  }, [index, open])
  return <div className="timer-task-picker">
    <input role="combobox" aria-label="何に取り組みますか？ Taskを検索" placeholder="何に取り組みますか？" autoComplete="off" disabled={disabled}
      aria-expanded={open && !disabled} aria-controls={id} aria-autocomplete="list"
      aria-activedescendant={open && matches[index] ? `${id}-${matches[index].id}` : undefined}
      value={query ?? available.find(task => String(task.id) === choice)?.title ?? ''}
      onFocus={() => { setOpen(true); setIndex(0) }} onBlur={() => setOpen(false)}
      onClick={() => { setOpen(true); setIndex(0) }}
      onChange={event => { setQuery(event.target.value); onQueryChange(event.target.value); onChoice(''); setOpen(true); setIndex(0) }}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); setOpen(false); return }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); setOpen(true); setIndex(current => Math.max(0, Math.min(matches.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1))))
        } else if (event.key === 'Enter' && open && matches[index]) { event.preventDefault(); select(matches[index]) }
      }} />
    {open && !disabled && <ul ref={list} id={id} role="listbox" className="timer-task-suggestions">
      {matches.map((task, position) => <li id={`${id}-${task.id}`} key={task.id} data-task-id={task.id} role="option" aria-selected={position === index}>
        <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => select(task)}><strong>{task.title}</strong><small>{task.projectName ?? '未所属'}</small></button>
      </li>)}
      {!matches.length && <li className="timer-no-match">該当するTaskはありません</li>}
    </ul>}
  </div>
}
