import { DateInput } from './DateInput'
import { TimeInput } from './TimeInput'
import { TimeEntryTaskSelect } from './TimeEntryTaskSelect'
import { KebabSummary } from './KebabButton'
import type { EntryEditor, EntryTask } from './timeEntryInlineState'

export function EntryTaskControl({ editor, tasks, title }: { editor: EntryEditor; tasks: EntryTask[]; title: string }) {
  return editor.draft && editor.isEditing('task') ? <TimeEntryTaskSelect tasks={tasks} value={String(editor.draft.taskId || '')} disabled={editor.busy} autoFocus={editor.draft.field === 'task'}
    onChange={value => editor.setDraft(current => { const tagIds = tasks.find(task => task.id === Number(value))?.tags?.map(tag => tag.id) ?? []; return current ? {...current, taskId: Number(value), tagIds, originalTagIds: tagIds} : current })} />
    : <button type="button" className="entry-inline-value entry-task-value" disabled={editor.disabled} onClick={() => editor.begin('task')}>{title}</button>
}
export function EntryTimeControl({ editor, label, compact = false, part = 'times' }: {editor: EntryEditor; label: string; compact?: boolean; part?: 'dates' | 'times'}) {
  if (compact && editor.draft && editor.isEditing('time')) {
    if (part === 'dates') return <div className="entry-inline-dates entry-compact-dates">{(['start','end'] as const).map((kind,index) => <DateInput key={kind} variant="compact" name={`${kind}Date`} label={index===0?'開始日':'終了日'} value={editor.draft![kind].date} disabled={editor.busy}
      onChange={date=>editor.setDraft(current=>current?{...current,[kind]:{...current[kind],date}}:current)} />)}</div>
    return <div className="entry-time-control"><span className="entry-compact-times">{(['start','end'] as const).map((kind,index)=><span key={kind}>{index>0&&<span aria-hidden="true">–</span>}<TimeInput variant="compact" name={`${kind}Clock`} label={index===0?'開始時刻':'終了時刻'} autoFocus={index===0&&editor.draft?.field==='time'} value={editor.draft![kind].time} disabled={editor.busy}
      onChange={time=>editor.setDraft(current=>current?{...current,[kind]:{...current[kind],time}}:current)} /></span>)}</span>{editor.error&&<p className="error entry-inline-error" role="alert">{editor.error}</p>}{editor.busy&&<small role="status">更新中…</small>}</div>
  }
  return <div className="entry-time-control">{editor.draft && editor.isEditing('time') ? <div className="entry-inline-dates">
    {(['start','end'] as const).map((kind,index) => <span className="entry-inline-endpoint" key={kind}>
      <DateInput name={`${kind}Date`} label={index === 0 ? '開始日' : '終了日'} value={editor.draft![kind].date} disabled={editor.busy}
        onChange={date => editor.setDraft(current => current ? {...current, [kind]: {...current[kind], date}} : current)} />
      <input aria-label={index === 0 ? '開始時刻' : '終了時刻'} autoFocus={index === 0 && editor.draft?.field === 'time'} value={editor.draft![kind].time} disabled={editor.busy} inputMode="numeric"
        onChange={event => editor.setDraft(current => current ? {...current, [kind]: {...current[kind], time: event.target.value}} : current)} />
    </span>)}
  </div> : <button type="button" className="entry-inline-value" disabled={editor.disabled} onClick={() => editor.begin('time')}>{label}</button>}
    {editor.error && <p className="error entry-inline-error" role="alert">{editor.error}</p>}
    {editor.busy && <small role="status">更新中…</small>}
  </div>
}
export function EntryMenu({ editor }: {editor: EntryEditor}) {
  return <details className="entry-menu" onClick={event => event.stopPropagation()}>
    <KebabSummary label="記録の操作" />
    <div className="entry-menu-options">
      <button type="button" className="danger" disabled={editor.disabled || editor.busy} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); void editor.remove() }}>削除</button></div>
  </details>
}
