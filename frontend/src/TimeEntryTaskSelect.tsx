// Shared native selector from the existing manual TimeEntry form.
export function TimeEntryTaskSelect({ tasks, value, disabled, onChange, autoFocus = false }: {
  tasks: {id: number; title: string; projectName: string | null}[]; value: string; disabled: boolean; onChange: (value: string) => void; autoFocus?: boolean
}) {
  return <select name="taskId" aria-label="記録のTaskを選択" required disabled={disabled} value={value} autoFocus={autoFocus} onChange={event=>onChange(event.target.value)}>
    <option value="">Taskを選択</option>{tasks.map(task=><option key={task.id} value={task.id}>{task.projectName ?? '未所属'} · {task.title}</option>)}
  </select>
}
