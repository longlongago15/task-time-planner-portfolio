import type { Tag } from './TagStore'
import type { TimeEntry } from './timer'

export function isReportDemoEnabled(development: boolean, search: string) {
  return development && new URLSearchParams(search).get('reportDemo') === '1'
}

// Reports-only, in-memory data. Never passed to Workspace's editing/Timer state.
export function createReportDemoData() {
  const projects = ['IT学習', '個人開発', '就活', '生活'].map((name, index) => ({
    id: 9001 + index, name, color: ['#568BC7', '#529968', '#D9793A', '#A079BE'][index],
    taskCount: [3, 1, 3, 3][index], completedCount: [0, 0, 1, 1][index], estimatedMinutes: 0, actualMinutes: 0,
  }))
  const tags: Tag[] = ['基本情報', 'Python', 'AWS', 'ポートフォリオ', '応募', '面接', '家事', '健康', '読書']
    .map((name, index) => ({ id: 9101 + index, name }))
  const taskDefinitions: [string, number, number[], 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED'][] = [
    ['基本情報の過去問', 0, [0], 'IN_PROGRESS'], ['SQL復習', 0, [], 'IN_PROGRESS'],
    ['AWS学習', 0, [2], 'NOT_STARTED'], ['タスク管理アプリ開発', 1, [1, 3], 'IN_PROGRESS'],
    ['応募書類', 2, [4], 'COMPLETED'], ['企業研究', 2, [4], 'IN_PROGRESS'],
    ['面接対策', 2, [5], 'IN_PROGRESS'], ['読書', 3, [8], 'IN_PROGRESS'],
    ['家事', 3, [6], 'COMPLETED'], ['運動', 3, [7], 'IN_PROGRESS'],
  ]
  const tasks = taskDefinitions.map(([title, project, tagIndexes, status], index) => ({
    id: 9201 + index, title, projectId: projects[project].id, projectName: projects[project].name,
    tags: tagIndexes.map(i => tags[i]), status, completed: status === 'COMPLETED',
    completedAt: null, completedEstimateMinutes: null, estimatedMinutes: null,
    actualMinutes: 0, differenceMinutes: null, actualStartedAt: null, priority: null, deadline: null,
  }))
  const timestamp = (date: string, time: string) => new Date(`${date}T${time}:00+09:00`).toISOString()
  const stamp = timestamp('2026-10-01', '00:00')
  // Task index, day of October, start, duration. Sources remain single records.
  const plans: [number, number, string, number][] = [
    [0, 5, '09:00', 120], [4, 5, '14:00', 60],
    [3, 6, '09:00', 180], [1, 6, '14:00', 90],
    [0, 7, '08:30', 120], [6, 7, '13:00', 90],
    [3, 8, '09:00', 240], [2, 8, '14:00', 90],
    [5, 9, '10:00', 90], [4, 9, '13:00', 60],
    [3, 10, '09:00', 120], [8, 10, '11:00', 60],
    [6, 11, '10:00', 120], [7, 11, '20:00', 60],
    [7, 12, '23:30', 60],
  ]
  const blocks = plans.map(([task, day, startTime, durationMinutes], index) => ({
    id: 9301 + index, taskId: tasks[task].id, date: `2026-10-${String(day).padStart(2, '0')}`,
    type: 'TIMED' as const, startTime: `${startTime}:00`, durationMinutes, createdAt: stamp, updatedAt: stamp,
  }))
  const records: [number, number, string, number][] = [
    [0, 5, '09:10', 90], [4, 5, '14:00', 80], [8, 5, '18:00', 30],
    [3, 6, '09:15', 210], [1, 6, '14:00', 75],
    [0, 7, '08:40', 120], [6, 7, '13:00', 60], [9, 7, '19:00', 45],
    [3, 8, '09:05', 180], [2, 8, '14:10', 120],
    [5, 9, '10:00', 120], [7, 9, '21:00', 40],
    [3, 10, '09:00', 90], [8, 10, '11:00', 60], [0, 10, '15:00', 60],
    [6, 11, '10:00', 90], [7, 11, '20:00', 60],
    [7, 12, '23:40', 40],
  ]
  const entries: TimeEntry[] = records.map(([task, day, start, durationMinutes], index) => {
    const startedAt = timestamp(`2026-10-${String(day).padStart(2, '0')}`, start)
    const endedAt = new Date(Date.parse(startedAt) + durationMinutes * 60000).toISOString()
    return { id: 9401 + index, taskId: tasks[task].id, projectIdSnapshot: tasks[task].projectId,
      startedAt, endedAt, startAt: startedAt, endAt: endedAt, durationMinutes, createdAt: stamp, updatedAt: stamp }
  })
  return { projects, tags, tasks, blocks, entries }
}
