import { ColorPicker } from './ColorPicker'
import { KebabButton } from './KebabButton'
import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ProjectIcon, UiIcon } from './UiIcon'
import { ProjectProgress } from './ProjectProgress'
import type { ProjectStats } from './ProjectProgress'
import { TaskList } from './TaskList'
import type { ListTask } from './taskListModel'
import { useTaskSchedules } from './useTaskSchedules'
import { formatDuration } from './duration'
import { ProjectRecords } from './ProjectRecords'
import type { EntryActions, EntryCorrection } from './timeEntryInlineState'
import type { EntryTimerActions } from './TaskRowActions'
import type { TimeEntry } from './timer'

export type Project = ProjectStats & { id: number; name: string; color?: string | null }
type Actions = { onEdit: (project: Project) => void; onDelete: (project: Project) => void; deletingIds: number[] }

function ProjectMenu({ project, onEdit, onDelete, deletingIds }: Actions & { project: Project }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const id = useId()
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (!event.composedPath().includes(root.current!)) setOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus() } }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    root.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus()
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [open])
  const action = (callback: () => void) => { setOpen(false); trigger.current?.focus(); callback() }
  return <div ref={root} className="project-menu project-head-actions" onClick={event => event.stopPropagation()}>
    <KebabButton ref={trigger} className="secondary-button project-menu-trigger" aria-label={`${project.name}の操作`} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)} />
    {open && <div id={id} className="project-menu-popup" role="menu" aria-label="プロジェクトの操作" onKeyDown={event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
      const index = items.indexOf(document.activeElement as HTMLButtonElement)
      items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length]?.focus()
    }}>
      <button role="menuitem" type="button" data-action="edit" onClick={() => action(() => onEdit(project))}>プロジェクトを編集</button>
      <div className="task-menu-divider" role="separator" />
      <button role="menuitem" type="button" data-action="delete" className="danger" disabled={deletingIds.includes(project.id)} onClick={() => action(() => onDelete(project))}>削除</button>
    </div>}
  </div>
}

export function ProjectList({ projects, onCreate, onOpen, actionError, ...actions }: Actions & {
  projects: Project[]; onCreate: () => void; onOpen: (id: number) => void; actionError: { id: number; message: string } | null
}) {
  return <section className="projects-list-panel" aria-labelledby="project-list-title">
    <header className="project-page-heading workspace-page-heading"><div><h1 id="project-list-title">プロジェクト一覧</h1><p>{projects.length}件</p></div><button type="button" className="primary-action" data-project-create onClick={onCreate}><UiIcon name="plus" />プロジェクトを作成</button></header>
    {!projects.length ? <p className="empty-state">プロジェクトがありません。「＋ プロジェクトを作成」から追加できます。</p> : <div className="project-grid">
      {projects.map(project => <article className="project-card" key={project.id} data-project-id={project.id}>
        <button type="button" className="project-card-open" aria-label={`${project.name}の詳細を開く`} onClick={() => onOpen(project.id)}><span className="project-card-heading"><ProjectIcon project={project} /><strong>{project.name}</strong></span></button>
        <ProjectMenu project={project} {...actions} />
        <ProjectProgress project={project} formatDuration={formatDuration} />
        {actionError?.id === project.id && <p className="error project-action-error" role="alert">{actionError.message}</p>}
      </article>)}
    </div>}
  </section>
}

function ProjectSettings({ project, onRename, onDelete, deleting }: {
  project: Project; onRename: (id: number, name: string, color?: string | null) => Promise<void>; onDelete: () => void; deleting: boolean
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const name = draft ?? project.name
  const [draftColor, setDraftColor] = useState<string | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const pending = useRef(false)
  return <section className="panel project-settings">
    <form onSubmit={async event => {
      event.preventDefault()
      if (pending.current) return
      setSaved(false); setError('')
      if (!name.trim()) { setError('プロジェクト名を入力してください'); return }
      pending.current = true; setBusy(true)
      try { await onRename(project.id, name.trim(), draftColor); setDraft(null); setDraftColor(undefined); setSaved(true) }
      catch (failure) { setError(failure instanceof Error ? failure.message : 'プロジェクトを保存できませんでした') }
      finally { pending.current = false; setBusy(false) }
    }} noValidate>
      <label>プロジェクト名<input name="projectName" value={name} maxLength={255} disabled={busy} onChange={event => { setDraft(event.target.value); setSaved(false) }} /></label>
      <ColorPicker kind="project" entityId={project.id} name={name} value={draftColor === undefined ? project.color ?? null : draftColor}
        onChange={color => { setDraftColor(color); setSaved(false) }} disabled={busy} />
      {error && <p className="error" role="alert">{error}</p>}
      {saved && <p role="status">変更を保存しました</p>}
      <button type="submit" className="primary-action" disabled={busy}>{busy ? '保存中…' : '変更を保存'}</button>
    </form>
    <div className="project-danger-zone"><h2>プロジェクトの削除</h2><p>タスクは未所属で残ります。記録履歴があるプロジェクトは削除できません。</p><button type="button" className="danger" disabled={deleting || busy} onClick={onDelete}>プロジェクトを削除</button></div>
  </section>
}

export function ProjectDetail<T extends ListTask>({ project, tasks, projects, refresh, renderTask, onCreate, onBack, onRename, entries, entriesStatus, onRetryEntries, onSaveEntry, onDeleteEntry, onUpdateTags, onCreateProject, actionError, activeTaskId, timerDisabled, onStart, onStop, now, ...actions }: Actions & EntryTimerActions & Pick<EntryActions, 'onUpdateTags' | 'onCreateProject'> & {
  now: number; project: Project; tasks: T[]; projects: Project[]; refresh: number; renderTask: (task: T) => ReactNode
  onCreate: () => void; onBack: () => void; onRename: (id: number, name: string, color?: string | null) => Promise<void>
  onSaveEntry: (input: EntryCorrection, entryId: number) => Promise<void>; onDeleteEntry: (entryId: number) => Promise<void>
  entries: TimeEntry[]; entriesStatus: 'loading' | 'ready' | 'error'; onRetryEntries: () => void; actionError: { id: number; message: string } | null
}) {
  const [tab, setTab] = useState<'tasks' | 'records' | 'settings'>('tasks')
  const schedules = useTaskSchedules(refresh)
  const projectTasks = tasks.filter(task => task.projectId === project.id)
  const scheduled = new Set(schedules.blocks.map(block => block.taskId))
  const unplanned = projectTasks.filter(task => !scheduled.has(task.id)).length
  const tabs = [{ value: 'tasks', label: 'タスク' }, { value: 'records', label: '時間記録' }, { value: 'settings', label: '設定' }] as const
  const id = useId()
  return <section className="project-detail-panel" data-project-id={project.id}>
    <button type="button" className="secondary-button project-back" onClick={onBack}>プロジェクト一覧へ戻る</button>
    <header className="project-page-heading"><div><h1><ProjectIcon project={project} />{project.name}</h1><p>{project.taskCount}件のタスク</p></div><div className="project-heading-actions"><button type="button" className="primary-action" onClick={onCreate}><UiIcon name="plus" />このプロジェクトにタスクを追加</button><ProjectMenu project={project} {...actions} /></div></header>
    {actionError?.id === project.id && <p className="error project-action-error" role="alert">{actionError.message}</p>}
    <div className="project-summary"><ProjectProgress project={project} formatDuration={formatDuration} summary /><div className="project-summary-unplanned"><span className="project-metric-label">未配置タスク</span><strong>{schedules.status === 'ready' ? `${unplanned}件` : '—'}</strong><small>予定未配置</small>{schedules.status === 'error' && <p className="error" role="alert">予定を取得できませんでした。<button type="button" onClick={schedules.retry}>再取得</button></p>}</div></div>
    <div className="project-tabs" role="tablist" aria-label="プロジェクト詳細">{tabs.map(({ value, label }, index) => <button key={value} type="button" role="tab" id={`${id}-${value}`} aria-controls={`${id}-panel-${value}`} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const next = tabs[event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length].value
      setTab(next); document.getElementById(`${id}-${next}`)?.focus()
    }}>{label}</button>)}</div>
    <div role="tabpanel" id={`${id}-panel-tasks`} aria-labelledby={`${id}-tasks`} hidden={tab !== 'tasks'}>
      <TaskList tasks={projectTasks} projects={projects} refresh={refresh} projectContext schedules={schedules} projectFilter="all" onProjectFilter={() => {}} onCreate={onCreate} renderTask={renderTask} />
    </div>
    {tab === 'records' && <div role="tabpanel" id={`${id}-panel-records`} aria-labelledby={`${id}-records`}><ProjectRecords projectId={project.id} projects={projects} onSave={onSaveEntry} onDelete={onDeleteEntry} onUpdateTags={onUpdateTags} onCreateProject={onCreateProject} entries={entries} tasks={tasks} status={entriesStatus} onRetry={onRetryEntries} now={now} activeTaskId={activeTaskId} timerDisabled={timerDisabled} onStart={onStart} onStop={onStop} /></div>}
    {tab === 'settings' && <div role="tabpanel" id={`${id}-panel-settings`} aria-labelledby={`${id}-settings`}><ProjectSettings project={project} onRename={onRename} onDelete={() => actions.onDelete(project)} deleting={actions.deletingIds.includes(project.id)} /></div>}
  </section>
}
