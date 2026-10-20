import { useEffect, useRef } from 'react'
import type { MouseEvent } from 'react'
import type { TimeEntry } from './timer'
import type { Tag } from './TagStore'
import { recordDateTime } from './timeEntryInput'
import { formatDuration } from './duration'
import { formatCompactDuration } from './durationInput'
import { Button } from './Button'
import { TaskProjectLine } from './TaskProjectLine'
import { TagChip } from './TagChip'
import { ProjectPicker } from './ProjectPicker'
import { TagPicker } from './TagPicker'
import { TaskTimerButton } from './TaskTimerButton'
import { EntryTaskControl, EntryTimeControl, EntryMenu } from './TimeEntryInline'
import { useTimeEntryInline } from './timeEntryInlineState'
import type { EntryActions, EntryTask } from './timeEntryInlineState'
import type { EntryEditor } from './timeEntryInlineState'
import type { EntryTimerActions } from './TaskRowActions'

export type LogTask = EntryTask & {tags?: Tag[]}
export type LogProject = {id: number; name: string; color?: string | null}
function ProjectControl({editor, projects, onCreateProject}: {editor: EntryEditor; projects: LogProject[]; onCreateProject: EntryActions['onCreateProject']}) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => { const frame = requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>('.project-picker-trigger')?.click()); return () => cancelAnimationFrame(frame) }, [])
  return <div ref={root}><ProjectPicker projects={projects} projectId={editor.draft!.projectIdSnapshot} disabled={editor.busy} colorSelection coloredOptions allowCreate={false} onCancel={editor.cancel}
    onChange={projectIdSnapshot => editor.setDraft(current => current ? {...current, projectIdSnapshot} : current)} onCreateProject={onCreateProject} /></div>
}
function TagsControl({editor, tags}: {editor: EntryEditor; tags: Tag[]}) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => { const frame = requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>('.tag-picker-trigger')?.click()); return () => cancelAnimationFrame(frame) }, [])
  return <div ref={root}><TagPicker tagIds={editor.draft!.tagIds} selectedTags={tags} disabled={editor.busy} onCancel={editor.cancel}
    onChange={tagIds => editor.setDraft(current => current ? {...current, tagIds} : current)} /></div>
}
export function TimeEntryLogRow({ entry, tasks, projects, now, showProject = true, showDate = true, showTimer = true, lockTask = false, compact = false, display, activeTaskId, timerDisabled, onStart, onStop, ...actions }: EntryActions & EntryTimerActions & {
  entry: TimeEntry; tasks: LogTask[]; projects: LogProject[]; now: number; showProject?: boolean; showDate?: boolean; showTimer?: boolean; lockTask?: boolean; compact?: boolean; display?: {clock: string; date: string; minutes: number}
}) {
  const task = tasks.find(task => task.id === entry.taskId), project = projects.find(project => project.id === entry.projectIdSnapshot)
  const editor = useTimeEntryInline(entry, actions, id => tasks.find(task => task.id === id)?.tags?.map(tag => tag.id) ?? [], task?.title)
  const start = recordDateTime(entry.startedAt), end = recordDateTime(entry.endedAt ?? '')
  const days = entry.endedAt ? Math.round((Date.parse(`${end.date.replaceAll('/','-')}T00:00:00Z`) - Date.parse(`${start.date.replaceAll('/','-')}T00:00:00Z`)) / 86400000) : 0
  const clock = display?.clock ?? `${start.time} - ${entry.endedAt ? end.time : '計測中'}${days > 0 ? ` (+${days}日)` : ''}`
  const minutes = display?.minutes ?? Math.max(0, Math.floor(((entry.endedAt ? Date.parse(entry.endedAt) : now) - Date.parse(entry.startedAt)) / 60000))
  const hit = (field: 'task' | 'project' | 'tag' | 'time') => (event: MouseEvent<HTMLElement>) => {
    if (event.target instanceof Element && !event.target.closest('button,input,select,textarea,a,.project-picker,.tag-picker,.date-input')) editor.begin(field)
  }
  return <tr className={`time-entry-log-row${compact ? ' time-entry-log-compact' : ''}`} data-entry-id={entry.id} data-task-entry-id={lockTask ? entry.id : undefined} aria-busy={editor.busy} {...editor.rowEvents}>
    {!compact && <th scope="row" data-label="タスク名" onClick={lockTask ? undefined : hit('task')}>{lockTask ? <span>{task?.title ?? `タスク ${entry.taskId}`}</span> : <EntryTaskControl editor={editor} tasks={tasks} title={task?.title ?? `タスク ${entry.taskId}`} />}</th>}
    {showProject && <td data-label="プロジェクト名" onClick={hit('project')}>{editor.isEditing('project') ? <ProjectControl editor={editor} projects={projects} onCreateProject={actions.onCreateProject} /> : <button type="button" className="entry-inline-value" disabled={editor.disabled} onClick={() => editor.begin('project')}><TaskProjectLine project={project} name={entry.projectIdSnapshot === null ? '未所属' : project?.name ?? `プロジェクト ${entry.projectIdSnapshot}`} hasTags={false} projectClassName="entry-project-name" /></button>}</td>}
    <td data-label="タグ" onClick={hit('tag')}>{editor.isEditing('tag') ? <TagsControl editor={editor} tags={tasks.find(task => task.id === editor.draft?.taskId)?.tags ?? []} /> : <button type="button" className="entry-inline-value" disabled={editor.disabled || !task} onClick={() => editor.begin('tag')}><span className="report-log-tags">{task?.tags?.map(tag => <TagChip key={tag.id} tag={tag} />)}</span></button>}</td>
    <td data-label="計測期間" onClick={hit('time')}><EntryTimeControl editor={editor} label={clock} compact={compact} /></td>
    {showDate && <td className="entry-display-date" data-label="日付">{compact ? editor.isEditing('time') ? <EntryTimeControl editor={editor} label={start.date} compact part="dates" /> : <button type="button" className="entry-inline-value" disabled={editor.disabled} onClick={()=>editor.begin('time')}>{display?.date ?? start.date}</button> : display?.date ?? start.date}</td>}
    <td data-label="記録" className="entry-log-duration" onClick={hit('time')}><button type="button" className="entry-inline-value" disabled={editor.disabled} onClick={() => editor.begin('time')}>{compact ? formatCompactDuration(minutes) : formatDuration(minutes)}</button></td><td data-label="操作">{compact&&editor.draft&&<span className="entry-editor-actions"><Button variant="secondary" type="button" disabled={editor.busy} onClick={editor.cancel}>キャンセル</Button><Button variant="primary" type="button" disabled={editor.busy} onClick={()=>void editor.save()}>保存</Button></span>}<EntryMenu editor={editor} /></td>
    {showTimer && <td data-label="時間計測"><TaskTimerButton task={task ?? {id: entry.taskId, title: `タスク ${entry.taskId}`}} activeTaskId={activeTaskId} disabled={Boolean(actions.disabled) || timerDisabled || !task} onStart={() => onStart(entry.taskId)} onStop={onStop} alwaysVisible /></td>}
  </tr>
}
