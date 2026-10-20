export type ReportFilters = { project: string[]; tag: string[]; status: string[] }
export const emptyReportFilters = (): ReportFilters => ({ project: [], tag: [], status: [] })

type Task = { id: number; projectId: number | null; tags?: { id: number }[]; status?: string }
// Preserve source records for clipping, union, snapshots, and future detail views.
export function filterReportDataset<T extends Task, S extends { taskId: number }, E extends { taskId: number; projectIdSnapshot: number | null }>(
  tasks: T[], blocks: S[], entries: E[], filters: ReportFilters,
) {
  const byId = new Map(tasks.map(task => [task.id, task]))
  const matchesTask = (task: T | undefined) => (!filters.tag.length || Boolean(task?.tags?.some(tag => filters.tag.includes(String(tag.id)))))
    && (!filters.status.length || Boolean(task?.status && filters.status.includes(task.status)))
  const matchesProject = (id: number | null) => !filters.project.length || filters.project.includes(id === null ? 'unassigned' : String(id))
  const filteredBlocks = blocks.filter(block => { const task = byId.get(block.taskId); return matchesTask(task) && matchesProject(task?.projectId ?? null) })
  const filteredEntries = entries.filter(entry => matchesTask(byId.get(entry.taskId)) && matchesProject(entry.projectIdSnapshot))
  const ids = new Set([...filteredBlocks, ...filteredEntries].map(item => item.taskId))
  return { tasks: tasks.filter(task => ids.has(task.id)), blocks: filteredBlocks, entries: filteredEntries }
}
