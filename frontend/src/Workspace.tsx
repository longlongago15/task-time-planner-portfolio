import { API } from './api'
import { TaskProjectLine } from './TaskProjectLine'
import { scheduleSegmentsForDay, plannedMinutesForDay } from './scheduleSegments'
import { formatDate, shiftDate, getWeekDates, getMonthGridDates, getISOWeekNumber } from './calendarDates'
import { CalendarNavigationPicker } from './CalendarNavigationPicker'
import { ProjectIcon, UiIcon } from './UiIcon'
import { NavRailIcon } from './NavRailIcon'
import { AppShell, WorkspaceSidebar } from './AppShell'
import { getProjectColor, getScheduleBlockStyle } from './identificationColors'
import { deadlineText, parseDeadline } from './deadline'
import type { ProjectChoice } from './ProjectPicker'
import { startTransition, useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, DragEvent, PointerEvent, MouseEvent as ReactMouseEvent } from 'react'
import { entrySegmentsForLocalDay, formatEntryDate, formatEntryDuration, getElapsedSeconds } from './timer'
import type { TimeEntry } from './timer'
import { useTimer } from './useTimer'
import { buildReportMetrics } from './reportMetrics'
import { createReportDemoData, isReportDemoEnabled } from './reportDemo'
import { reportDifference } from './reportDifference'
import { ReportsFilters } from './ReportsFilters'
import { emptyReportFilters, filterReportDataset } from './reportFilters'
import { reportChartScale } from './reportChart'
import { timeEntryOverlapMessage } from './timeEntryErrors'
import { reportActivityRows, reportHourlyBuckets } from './reportPresentation'
import { ReportActivityLog, ReportHourChart, ReportProjectBreakdown, ReportTaskTable } from './ReportsDetails'
import { ReportBarTooltip } from './ReportBarTooltip'
import { HomeEntryList } from './HomeEntryList'
import { TimeEntryLogRow } from './TimeEntryLogRow'
import type { EntryCorrection } from './timeEntryInlineState'
import { TaskEditorPanel } from './TaskEditorPanel'
import { TagContext, useTagStore } from './TagStore'
import type { Tag } from './TagStore'
import { ProjectList, ProjectDetail } from './ProjectViews'
import { ProjectComposer } from './ProjectComposer'
import { TimeEntryDialog } from './TimeEntryDialog'
import { formatDuration, formatEndTime } from './duration'
import { TaskTimeComparison } from './TaskTimeComparison'
import type { ActualSelection, ManualEntryInput } from './TimeEntryDialog'
import type { TimeEntryUpdateInput } from './timeEntryInput'
import { actualDefaults } from './timeEntryInput'
import { CalendarDialog } from './CalendarDialog'
import type { CalendarDialogSelection, CalendarPlacement, CalendarTaskInput } from './CalendarDialog'
import { createCalendarScale, calendarLocalTime, DEFAULT_CALENDAR_ZOOM } from './calendarScale'
import { useCalendarClock } from './useCalendarClock'
import { GlobalTimer, LiveClock, TimerElapsed } from './GlobalTimer'
import { InboxTaskCard } from './InboxTaskCard'
import { TaskTimerButton } from './TaskTimerButton'
import { TimerUiContext } from './TimerUiContext'
import { TimerActionIcon } from './TimerActionIcon'
import { formatDurationInput, parseDurationInput } from './durationInput'
import { PLACEHOLDER_TASK_TITLE } from './taskPlaceholder'
import { TaskList } from './TaskList'
import { TaskRow } from './TaskRow'
import type { TaskChanges } from './TaskRow'
import type { TaskFormValue } from './TaskEditorPanel'

type View = 'home' | 'tasks' | 'reports'
type TaskSection = 'list' | 'projects' | 'projectDetail'
type ReportMode = 'day' | 'week' | 'month'
type ReportRange = { start: string; end: string }
type CalendarMode = 'day' | 'week' | 'month'

type Task = {
  id: number
  title: string
  estimatedMinutes: number | null
  projectId: number | null
  projectName: string | null
  completed: boolean
  status: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED'
  completedAt: string | null
  completedEstimateMinutes: number | null
  actualMinutes: number
  differenceMinutes: number | null
  actualStartedAt: string | null
  tags?: Tag[]
  createdAt?: string
  updatedAt?: string
  priority?: 'HIGH' | 'MEDIUM' | 'LOW' | null
  deadline?: string | null
  startDate?: string | null
}

type InboxState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; tasks: Task[] }

type ScheduleBlock = {
  id: number
  taskId: number
  date: string
  createdAt: string
  updatedAt: string
} & (
  | { type: 'TIMED'; startTime: string; durationMinutes: number }
  | { type: 'TIME_UNSET' | 'ALL_DAY'; startTime: null; durationMinutes: null }
)

type CalendarData = {
  mode: CalendarMode
  date: string
  range: string
  blocks: ScheduleBlock[]
  summaries: DailySummary[]
}

type CalendarSchedule = { schedule: ScheduleBlock; task: Task }
type CalendarDragSource = { type: 'TASK'; id: number } | { type: 'SCHEDULE_BLOCK'; id: number }
type BlockExpectation = { date: string; type: CalendarPlacement['type']; startTime?: string | null; durationMinutes?: number | null }
type BlockChanges = Partial<CalendarPlacement>
type BlockResize = {
  block: Extract<ScheduleBlock, { type: 'TIMED' }>
  pointerId: number
  startY: number
  column: HTMLElement
  columnTop: number
  scale: ReturnType<typeof createCalendarScale>
  durationMinutes: number
  moved: boolean
  range: string
}
type WeeklyTimelineBlock = {
  schedule: Extract<ScheduleBlock, { type: 'TIMED' }>
  task: Task
  startMinutes: number
  endMinutes: number
  date: string
  lane: number
  overlaps: boolean
}

type Project = {
  color?: string | null
  id: number
  name: string
  taskCount: number
  completedCount: number
  estimatedMinutes: number
  actualMinutes: number
}

type TaskForm = TaskFormValue

type DailySummary = {
  date: string
  plannedOccupiedMinutes: number
  dailyEstimatedMinutes: number
  dailyActualMinutes: number
  dailyDifference: number
  tasks: DailyTaskSummary[]
}

type DailyTaskSummary = {
  taskId: number
  title: string
  estimatedMinutes: number | null
  actualMinutes: number
  differenceMinutes: number | null
}


const readCalendarDayBlocks = async (date: string) => {
  const params = new URLSearchParams({ startDate: date, endDate: date })
  const response = await fetch(`${API}/schedule-blocks?${params.toString()}`)
  if (!response.ok) throw new Error('重複を確認できませんでした')
  return response.json() as Promise<ScheduleBlock[]>
}
const INBOX_TASK_DRAG_TYPE = 'application/x-inbox-task-id'
const SCHEDULE_BLOCK_DRAG_TYPE = 'application/x-time-unset-block-id'
const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone

const getLocalDate = () => {
  const today = new Date()
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
}

const getReportDates = (mode: Exclude<ReportMode, 'day'>, anchorDate: string) => {
  const anchor = new Date(`${anchorDate}T12:00:00`)
  if (mode === 'week') {
    return getWeekDates(anchorDate)
  }

  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1, 12)
  const daysInMonth = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate()
  return Array.from({ length: daysInMonth }, (_, index) => {
    const day = new Date(first)
    day.setDate(index + 1)
    return formatDate(day)
  })
}

const reportPeriodDates = (mode: ReportMode, date: string, range: ReportRange | null) => {
  if (!range) return mode === 'day' ? [date] : getReportDates(mode, date)
  const dates: string[] = []
  for (let current = range.start; current <= range.end; current = shiftDate(current, 1)) dates.push(current)
  return dates
}
const reportPeriodKey = (mode: ReportMode, date: string, refresh: number, range: ReportRange | null) =>
  `${mode}/${date}/${refresh}${range ? `/${range.start}/${range.end}` : ''}`

const formatShortDate = (targetDate: string) => {
  const [, month, day] = targetDate.split('-').map(Number)
  return `${month}/${day}`
}

const formatCalendarDate = (targetDate: string) => new Intl.DateTimeFormat('ja-JP', {
  month: 'numeric',
  day: 'numeric',
  weekday: 'short',
}).format(new Date(`${targetDate}T12:00:00`))

const formatCalendarWeekday = (targetDate: string) => new Intl.DateTimeFormat('ja-JP', {
  weekday: 'short',
}).format(new Date(`${targetDate}T12:00:00`))

const dailySummaryUrl = (targetDate: string) => {
  const params = new URLSearchParams({ date: targetDate, timezone: localTimezone })
  return `${API}/reports/daily?${params.toString()}`
}

const emptyTask: TaskForm = {
  title: '',
  estimatedMinutes: '',
  projectId: '',
  priority: '',
  deadline: '',
  tagIds: [],
  status: 'NOT_STARTED',
}

const formatAxisTime = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(Math.floor(minutes % 60)).padStart(2, '0')}`
const snapCalendarMinute = (minutes: number, maximum = 1425) => Math.min(maximum, Math.max(0, Math.round(minutes / 15) * 15))

const getApiErrorMessage = (status: number, fallback: string) => {
  if (status === 404) return '対象のデータが見つかりません'
  if (status === 409) return '別のタスクを計測中か、同じプロジェクト名が登録されています'
  if (status >= 500) return 'サーバーでエラーが発生しました'
  return fallback
}

const getDeleteErrorMessage = async (response: Response, fallback: string) => {
  if (response.status === 409) {
    const body = await response.json().catch(() => null) as { detail?: unknown } | null
    return typeof body?.detail === 'string' ? displayApiMessage(body.detail) : fallback
  }
  return getApiErrorMessage(response.status, fallback)
}

// Keep existing server wording out of user-facing UI.
const displayApiMessage = (message: string) => message.replaceAll('実績', '記録').replaceAll('予定時間', 'この予定の長さ').replaceAll('時間指定予定', '予定')

const makeScheduleTimelineBlocks = (schedules: CalendarSchedule[], date: string): WeeklyTimelineBlock[] => {
  const timed = schedules.flatMap(({ schedule, task }) => {
    if (schedule.type !== 'TIMED' || typeof schedule.startTime !== 'string'
      || !Number.isFinite(schedule.durationMinutes) || schedule.durationMinutes < 1) return []
    const [hour, minute, second = 0] = schedule.startTime.split(':').map(Number)
    if (!Number.isFinite(hour) || !Number.isFinite(minute) || !Number.isFinite(second)
      || hour < 0 || hour >= 24 || minute < 0 || minute >= 60 || second < 0 || second >= 60) return []
    return scheduleSegmentsForDay([schedule], date).map(segment => ({ ...segment, schedule, task }))
  }).sort((first, second) => first.startMinutes - second.startMinutes || first.schedule.id - second.schedule.id)
  const laneEnds: number[] = []
  return timed.map((block) => {
    const overlaps = timed.some((other) => (
      other.schedule.id !== block.schedule.id
      && block.startMinutes < other.endMinutes && other.startMinutes < block.endMinutes
    ))
    let lane = laneEnds.findIndex((end) => end <= block.startMinutes)
    if (lane < 0) lane = laneEnds.length
    laneEnds[lane] = block.endMinutes
    return { ...block, lane, overlaps }
  })
}

function ScheduleChip({ project, schedule, task, onDragStart, onDragEnd, dragging, busy, onSelect, expanded, activeTaskId, timerDisabled, onStart }: CalendarSchedule & {
  project?: ProjectChoice
  onDragStart?: (event: DragEvent<HTMLElement>) => void
  onDragEnd?: () => void
  dragging?: boolean
  busy?: boolean
  onSelect: (anchor: HTMLElement) => void
  expanded?: boolean
  activeTaskId: number | null
  timerDisabled: boolean
  onStart: () => void
}) {
  return (
    <article className={`calendar-schedule-chip ${dragging ? 'schedule-chip-dragging' : ''}`} data-schedule-block-id={schedule.id} data-schedule-type={schedule.type} data-task-id={task.id} data-date={schedule.date} style={getScheduleBlockStyle(project ? getProjectColor(project) : '#78818B')}
      draggable={onDragStart !== undefined && !busy} aria-busy={busy || undefined} onDragStart={onDragStart} onDragEnd={onDragEnd}
      tabIndex={0} role="button" aria-label={`${task.title}の予定を開く`} aria-haspopup="dialog" aria-expanded={expanded ?? false} aria-controls={expanded ? 'schedule-detail' : undefined}
      onClick={event => { event.stopPropagation(); if (!busy) onSelect(event.currentTarget) }}
      onKeyDown={event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); event.stopPropagation(); if (!busy) onSelect(event.currentTarget) } }}>
      <strong>{task.title}</strong>
      <TaskProjectLine project={project} name={task.projectName} hasTags={!!task.tags?.length} projectClassName="task-project-label calendar-block-project" />
      <TaskTimerButton task={task} activeTaskId={activeTaskId} disabled={timerDisabled || !!busy} onStart={onStart} floating />
    </article>
  )
}

function TaskComparison({ task }: { task: Task }) {
  return <TaskTimeComparison task={task} />
}

function Workspace() {
  const [reportDemo] = useState(() => isReportDemoEnabled(import.meta.env.DEV, window.location.search) ? createReportDemoData() : null)
  const [view, setView] = useState<View>('home')
  const [taskSection, setTaskSection] = useState<TaskSection>('list')
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [inbox, setInbox] = useState<InboxState>({ status: 'loading' })
  const [inboxRefresh, setInboxRefresh] = useState(0)
  const [projects, setProjects] = useState<Project[]>([])
  const [timeEntries, setTimeEntries] = useState<TimeEntry[]>([])
  const [, setDailySummary] = useState<DailySummary | null>(null)
  const [reportDate, setReportDate] = useState(() => reportDemo ? '2026-10-05' : getLocalDate())
  const [reportTab, setReportTab] = useState<'analysis' | 'activity'>('analysis')
  const [reportMode, setReportMode] = useState<ReportMode>('day')
  const [reportRange, setReportRange] = useState<ReportRange | null>(null)
  const [reportFilters, setReportFilters] = useState(emptyReportFilters)
  const reportBeforeRange = useRef({ mode: reportMode, date: reportDate })
  const [reportPickerAnchor, setReportPickerAnchor] = useState<HTMLButtonElement | null>(null)
  const [reportRefresh, setReportRefresh] = useState(0)
  const [reportSchedules, setReportSchedules] = useState<{ key: string; blocks: ScheduleBlock[]; error?: string } | null>(null)
  const [displayedReport, setDisplayedReport] = useState<{
    key: string; mode: ReportMode; date: string; range: ReportRange | null; blocks: ScheduleBlock[];
    entries: TimeEntry[]; tasks: Task[]; projects: Project[]
  } | null>(null)
  const [calendarDate, setCalendarDate] = useState(getLocalDate)
  const [calendarMode, setCalendarMode] = useState<CalendarMode>('week')
  const [homeView, setHomeView] = useState<'calendar' | 'list'>('calendar')
  const [navigationPickerAnchor, setNavigationPickerAnchor] = useState<HTMLButtonElement | null>(null)
  const [dateOnlyExpanded, setDateOnlyExpanded] = useState(true)
  const [calendarZoom, setCalendarZoom] = useState(DEFAULT_CALENDAR_ZOOM)
  const calendarScale = createCalendarScale(calendarZoom)
  const calendarNow = useCalendarClock(view === 'home')
  const calendarClock = calendarLocalTime(calendarNow)
  const [weekDisplay, setWeekDisplay] = useState<'plan' | 'compare'>('compare')
  const [calendarData, setCalendarData] = useState<CalendarData | null>(null)
  const [calendarRequest, setCalendarRequest] = useState<{ key: string; status: 'ready' | 'error' } | null>(null)
  const [calendarEntries, setCalendarEntries] = useState<TimeEntry[]>([])
  const [calendarEntriesStatus, setCalendarEntriesStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const reportEntryRequests = useRef({ enabled: false, pending: new Map<string, Promise<TimeEntry[]>>() })
  useEffect(() => { reportEntryRequests.current.enabled = view === 'reports' }, [view])
  const [calendarRefresh, setCalendarRefresh] = useState(0)
  const [weeklyScheduleRefresh, setWeeklyScheduleRefresh] = useState(0)
  const [form, setForm] = useState<TaskForm>(emptyTask)
  const [editorSchedule, setEditorSchedule] = useState<{ block: (CalendarPlacement & { id: number }) | null; placement: CalendarPlacement } | null>(null)
  const [editorScheduleDraft, setEditorScheduleDraft] = useState({ date: '', startTime: '' })
  const [editorAnchor, setEditorAnchor] = useState<HTMLElement | null>(null)
  const createdEditorTask = useRef<number | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [projectName, setProjectName] = useState('')
  const [projectColor, setProjectColor] = useState<string | null | undefined>(undefined)
  const [editingProjectId, setEditingProjectId] = useState<number | null>(null)
  const [projectFilter, setProjectFilter] = useState('all')
  const [taskComposerOpen, setTaskComposerOpen] = useState(false)
  const [taskFormError, setTaskFormError] = useState('')
  const [taskActionError, setTaskActionError] = useState<{ id: number; message: string } | null>(null)
  const [projectComposerOpen, setProjectComposerOpen] = useState(false)
  const [actualDialog, setActualDialog] = useState<ActualSelection | null>(null)
  const [actualAnchor, setActualAnchor] = useState<HTMLElement | null>(null)
  const [actualPreview, setActualPreview] = useState<{ date: string; start: number; end: number } | null>(null)
  const actualPointer = useRef<{ pointerId: number; date: string; anchor: number; startY: number; moved: boolean; range: string } | null>(null)
  const suppressActualClick = useRef(false)
  const actualBlockPointer = useRef<{ pointerId: number; x: number; y: number; moved: boolean } | null>(null)
  const actualBlockClickUntil = useRef(0)
  const [projectFormError, setProjectFormError] = useState('')
  const [projectActionError, setProjectActionError] = useState<{ id: number; message: string } | null>(null)
  const deletingProjects = useRef(new Set<number>())
  const [deletingProjectIds, setDeletingProjectIds] = useState<number[]>([])
  const [timerDetailsOpen, setTimerDetailsOpen] = useState(false)
  const [timerTaskChoice, setTimerTaskChoice] = useState('')
  const [lastTimedTaskId, setLastTimedTaskId] = useState<number | null>(null)
  const [timerTaskTitle, setTimerTaskTitle] = useState('')
  const [timerTagIds, setTimerTagIds] = useState<number[]>([])
  const tagStore = useTagStore(change => {
    const updateTags = (task: Task) => ({ ...task, tags: 'deletedId' in change ? (task.tags ?? []).filter(tag => tag.id !== change.deletedId) : (task.tags ?? []).map(tag => tag.id === change.tag.id ? change.tag : tag) })
    taskGeneration.current += 1
    setTasks(current => current.map(updateTags))
    setInbox(current => current.status === 'ready' ? { ...current, tasks: current.tasks.map(updateTags) } : current)
    if ('deletedId' in change) {
      setForm(current => ({ ...current, tagIds: current.tagIds.filter(id => id !== change.deletedId) }))
      setTimerTagIds(current => current.filter(id => id !== change.deletedId))
    }
  })
  const [timerProjectId, setTimerProjectId] = useState<number | null>(null)
  const [quickTimerBusy, setQuickTimerBusy] = useState(false)
  const quickTimerPending = useRef(false)
  const [inboxDropOver, setInboxDropOver] = useState(false)
  const dragSource = useRef<CalendarDragSource | null>(null)
  const placingTasks = useRef(new Set<number>())
  const placedTasks = useRef(new Set<number>())
  const changingBlocks = useRef(new Set<number>())
  const changedBlocks = useRef(new Map<number, BlockExpectation>())
  const deletedBlocks = useRef(new Set<number>())
  const resizingBlock = useRef<BlockResize | null>(null)
  const [resizePreview, setResizePreview] = useState<{ blockId: number; durationMinutes: number; range: string } | null>(null)
  const [changingBlockIds, setChangingBlockIds] = useState<number[]>([])
  const [draggingBlockId, setDraggingBlockId] = useState<number | null>(null)
  const [draggingTaskId, setDraggingTaskId] = useState<number | null>(null)
  const [dropDate, setDropDate] = useState<string | null>(null)
  const [timedDropPreview, setTimedDropPreview] = useState<{ date: string; minutes: number; startTime: string } | null>(null)
  const [placingTaskIds, setPlacingTaskIds] = useState<number[]>([])
  const [placementError, setPlacementError] = useState('')
  const [error, setError] = useState('')
  const historyGeneration = useRef(0)
  const calendarEntriesGeneration = useRef(0)
  const taskGeneration = useRef(0)
  const projectGeneration = useRef(0)
  const dailySummaryGeneration = useRef(0)
  const [calendarDialog, setCalendarDialog] = useState<CalendarDialogSelection | null>(null)
  const [calendarAnchor, setCalendarAnchor] = useState<HTMLElement | null>(null)
  const [creationPreview, setCreationPreview] = useState<{ date: string; start: number; end: number } | null>(null)
  const creationPointer = useRef<{
    pointerId: number; date: string; anchor: number; startY: number; moved: boolean; range: string
  } | null>(null)
  const suppressCreateClick = useRef(false)
  const suppressBlockClick = useRef(false)

  // Navigation requests a new view; the last successful view stays visible until
  // its replacement (plans and metrics together) has finished loading.
  const displayedCalendarMode = calendarData?.mode ?? calendarMode
  const displayedCalendarDate = calendarData?.date ?? calendarDate
  const weekDates = getReportDates('week', displayedCalendarDate)
  const weekStartDate = weekDates[0]
  const weekEndDate = weekDates[6]
  const weekRange = `${weekStartDate}/${weekEndDate}`
  const scheduleDates = displayedCalendarMode === 'day' ? [displayedCalendarDate]
    : displayedCalendarMode === 'month' ? getMonthGridDates(displayedCalendarDate) : weekDates
  const scheduleStartDate = scheduleDates[0]
  const scheduleEndDate = scheduleDates[scheduleDates.length - 1]
  const scheduleRange = `${scheduleStartDate}/${scheduleEndDate}`
  const weeklySchedule = { range: scheduleRange, status: calendarData ? 'ready' as const : 'loading' as const, blocks: calendarData?.blocks ?? [] }
  const requestedScheduleDates = calendarMode === 'day' ? [calendarDate]
    : calendarMode === 'month' ? getMonthGridDates(calendarDate) : getReportDates('week', calendarDate)
  const requestedStartDate = requestedScheduleDates[0]
  const requestedEndDate = requestedScheduleDates[requestedScheduleDates.length - 1]
  const calendarRequestKey = `${calendarMode}/${calendarDate}/${weeklyScheduleRefresh}/${calendarRefresh}`
  const calendarLoadStatus = calendarRequest?.key === calendarRequestKey ? calendarRequest.status : 'loading'

  const refreshWeeklySchedule = () => {
    setWeeklyScheduleRefresh((current) => current + 1)
  }

  const refreshInbox = () => {
    setInbox({ status: 'loading' })
    setInboxRefresh((current) => current + 1)
  }

  const endCalendarDrag = () => {
    if (dragSource.current) {
      suppressBlockClick.current = true
      window.setTimeout(() => { suppressBlockClick.current = false }, 300)
    }
    dragSource.current = null
    setDraggingTaskId(null)
    setDraggingBlockId(null)
    setDropDate(null)
    setTimedDropPreview(null)
    setInboxDropOver(false)
  }

  const startInboxDrag = (event: DragEvent<HTMLLIElement>, taskId: number) => {
    if (resizingBlock.current || creationPointer.current || placingTasks.current.has(taskId)) {
      event.preventDefault()
      return
    }
    event.dataTransfer.setData(INBOX_TASK_DRAG_TYPE, String(taskId))
    event.dataTransfer.effectAllowed = 'copy'
    dragSource.current = { type: 'TASK', id: taskId }
    setDraggingTaskId(taskId)
    setDraggingBlockId(null)
  }

  const canDropInboxTask = (event: DragEvent<HTMLElement>) => (
    dragSource.current?.type === 'TASK'
    && !placingTasks.current.has(dragSource.current.id)
    && event.dataTransfer.types.includes(INBOX_TASK_DRAG_TYPE)
  )

  const startBlockDrag = (event: DragEvent<HTMLElement>, block: ScheduleBlock) => {
    event.stopPropagation()
    if (resizingBlock.current || creationPointer.current || changingBlocks.current.has(block.id)) {
      event.preventDefault()
      return
    }
    event.dataTransfer.setData(SCHEDULE_BLOCK_DRAG_TYPE, String(block.id))
    setCalendarDialog(null); setActualDialog(null)
    event.dataTransfer.effectAllowed = 'move'
    dragSource.current = { type: 'SCHEDULE_BLOCK', id: block.id }
    suppressBlockClick.current = true
    setDraggingBlockId(block.id)
    setDraggingTaskId(null)
  }

  const getDraggedBlock = (event: DragEvent<HTMLElement>) => {
    const source = dragSource.current
    if (source?.type !== 'SCHEDULE_BLOCK'
      || changingBlocks.current.has(source.id) || !event.dataTransfer.types.includes(SCHEDULE_BLOCK_DRAG_TYPE)
      || weeklySchedule.status !== 'ready' || weeklySchedule.range !== scheduleRange) return undefined
    return weeklySchedule.blocks.find((block) => block.id === source.id)
  }

  const canDropTimedSource = (event: DragEvent<HTMLDivElement>) => canDropInboxTask(event) || getDraggedBlock(event) !== undefined
  const canDropUnsetSource = canDropTimedSource

  const getTimedDropPosition = (event: DragEvent<HTMLDivElement>) => {
    const column = event.currentTarget
    const bounds = column.getBoundingClientRect()
    if (event.clientX < bounds.left || event.clientX >= bounds.right
      || event.clientY < bounds.top || event.clientY >= bounds.bottom || bounds.height === 0) return null
    // The column rect accounts for scrolling; the shared scale maps its Y to time.
    const relativeMinutes = calendarScale.pixelsToMinutes(event.clientY - bounds.top)
    const minutes = snapCalendarMinute(relativeMinutes)
    const startTime = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
    return { minutes, startTime }
  }

  const dropInboxTask = async (event: DragEvent<HTMLElement>, date: string, placement: { type: 'TIME_UNSET' | 'ALL_DAY' } | { type: 'TIMED'; startTime: string } = { type: 'TIME_UNSET' }) => {
    if (!canDropInboxTask(event)) return
    event.preventDefault()
    event.stopPropagation()
    const taskId = Number(event.dataTransfer.getData(INBOX_TASK_DRAG_TYPE))
    if (dragSource.current?.type !== 'TASK' || taskId !== dragSource.current.id || !scheduleDates.includes(date)
      || inbox.status !== 'ready' || !inbox.tasks.some((task) => task.id === taskId && !task.completed)) return

    // Lock synchronously, before any await or React render can allow another drop.
    placingTasks.current.add(taskId)
    setPlacingTaskIds([...placingTasks.current])
    endCalendarDrag()
    setPlacementError('')
    try {
      const response = await fetch(`${API}/schedule-blocks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, date, ...placement, ...(placement.type === 'TIMED' ? { durationMinutes: 60 } : { startTime: null, durationMinutes: null }) }),
      })
      if (!response.ok) throw new Error(await getDeleteErrorMessage(response, '予定を保存できませんでした。もう一度配置してください。'))
      // Keep the lock until a fresh Inbox response confirms removal, including retry after a refetch error.
      placedTasks.current.add(taskId)
      refreshInbox()
      refreshScheduleReports()
      setWeeklyScheduleRefresh((current) => current + 1)
    } catch (requestError) {
      placingTasks.current.delete(taskId)
      setPlacingTaskIds([...placingTasks.current])
      setPlacementError(requestError instanceof Error ? requestError.message : '予定の配置に失敗しました')
    }
  }

  const patchBlock = async (blockId: number, changes: BlockChanges, expected: BlockExpectation) => {
    if (changingBlocks.current.has(blockId)) return false
    // Block IDs use a separate synchronous lock from Inbox Task IDs.
    changingBlocks.current.add(blockId)
    setChangingBlockIds([...changingBlocks.current])
    endCalendarDrag()
    setPlacementError('')
    try {
      const response = await fetch(`${API}/schedule-blocks/${blockId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(changes),
      })
      if (!response.ok) throw new Error(await getDeleteErrorMessage(response, '予定を変更できませんでした。もう一度操作してください。'))
      // Keep the lock through refetch/retry until the saved values are confirmed.
      changedBlocks.current.set(blockId, expected)
      refreshScheduleReports()
      setWeeklyScheduleRefresh((current) => current + 1)
      return true
    } catch (requestError) {
      changingBlocks.current.delete(blockId)
      setChangingBlockIds([...changingBlocks.current])
      setPlacementError(requestError instanceof Error ? requestError.message : '予定の変更に失敗しました')
      return false
    }
  }

  const releaseBlock = async (blockId: number, editorBlock?: {id: number; taskId: number}) => {
    if (changingBlocks.current.has(blockId) || resizingBlock.current?.block.id === blockId
      || (editorBlock ? editorBlock.id !== blockId || editorBlock.taskId !== editingId : weeklySchedule.status !== 'ready' || weeklySchedule.range !== scheduleRange
      || !weeklySchedule.blocks.some((block) => block.id === blockId))) return false
    changingBlocks.current.add(blockId)
    setChangingBlockIds([...changingBlocks.current])
    if (dragSource.current?.type === 'SCHEDULE_BLOCK' && dragSource.current.id === blockId) endCalendarDrag()
    setPlacementError('')
    try {
      const response = await fetch(`${API}/schedule-blocks/${blockId}`, { method: 'DELETE' })
      if (!response.ok) throw new Error('予定を解除できませんでした。もう一度操作してください。')
      // Keep the block visible until DELETE succeeds, and its lock until refetch confirms absence.
      deletedBlocks.current.add(blockId)
      setCalendarData(current => current ? { ...current, blocks: current.blocks.filter(block => block.id !== blockId) } : current)
      refreshInbox()
      refreshScheduleReports()
      setWeeklyScheduleRefresh((current) => current + 1)
      return true
    } catch (requestError) {
      changingBlocks.current.delete(blockId)
      setChangingBlockIds([...changingBlocks.current])
      setPlacementError(requestError instanceof Error ? requestError.message : '予定の解除に失敗しました')
      return false
    }
  }

  const dropBlock = async (event: DragEvent<HTMLElement>, date: string, placement: { type: 'TIME_UNSET' | 'ALL_DAY' } | { type: 'TIMED'; startTime: string }) => {
    const block = getDraggedBlock(event)
    if (!block) return
    event.preventDefault()
    event.stopPropagation()
    const blockId = Number(event.dataTransfer.getData(SCHEDULE_BLOCK_DRAG_TYPE))
    if (dragSource.current?.type !== 'SCHEDULE_BLOCK' || blockId !== dragSource.current.id || !scheduleDates.includes(date)
      || weeklySchedule.status !== 'ready' || weeklySchedule.range !== scheduleRange
      || block.id !== blockId) return

    // A Month cell supplies a date only: preserve ID, type, and all time fields.
    if (displayedCalendarMode === 'month') {
      if (block.date === date) { endCalendarDrag(); return }
      await patchBlock(blockId, { date }, { date, type: block.type, startTime: block.startTime, durationMinutes: block.durationMinutes })
      return
    }
    if (block.date === date && block.type === placement.type
      && (block.type !== 'TIMED' || (placement.type === 'TIMED' && block.startTime === `${placement.startTime}:00`))) {
      endCalendarDrag()
      return
    }
    const changes = block.type === placement.type
      ? { date, ...(placement.type === 'TIMED' ? { startTime: placement.startTime } : {}) }
      : { date, ...placement, ...(placement.type === 'TIMED' ? { durationMinutes: 60 } : { startTime: null, durationMinutes: null }) }

    await patchBlock(blockId, changes, { date, ...placement, startTime: placement.type === 'TIMED' ? `${placement.startTime}:00` : undefined })
  }

  const openCalendarCreate = (date: string, type: CalendarPlacement['type'], start = 540, duration = 30) => {
    if (calendarDialog || actualDialog || view !== 'home') return
    setCalendarAnchor(null)
    setCalendarDialog({ kind: 'create', placement: {
      date, type, startTime: type === 'TIMED' ? formatAxisTime(start) : null,
      durationMinutes: type === 'TIMED' ? duration : null,
    } })
  }

  const openSchedule = (schedule: ScheduleBlock, task: Task, anchor: HTMLElement) => {
    if (calendarDialog || actualDialog || changingBlocks.current.has(schedule.id) || dragSource.current || resizingBlock.current || suppressBlockClick.current) return
    setCalendarAnchor(anchor)
    setCalendarDialog({ kind: 'block', block: schedule, task })
  }

  const beginCalendarSelection = (event: PointerEvent<HTMLDivElement>, date: string) => {
    if (event.target !== event.currentTarget || event.button !== 0 || !event.isPrimary || event.pointerType === 'touch'
      || creationPointer.current || dragSource.current || resizingBlock.current || calendarDialog || actualDialog) return
    const bounds = event.currentTarget.getBoundingClientRect()
    if (bounds.height <= 0) return
    suppressCreateClick.current = false
    creationPointer.current = { pointerId: event.pointerId, date,
      anchor: snapCalendarMinute(calendarScale.pixelsToMinutes(event.clientY - bounds.top)), startY: event.clientY,
      moved: false, range: scheduleRange }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const calendarSelectionRange = (event: PointerEvent<HTMLDivElement>) => {
    const session = creationPointer.current
    if (!session || session.pointerId !== event.pointerId || session.range !== scheduleRange) return null
    const bounds = event.currentTarget.getBoundingClientRect()
    if (bounds.height <= 0) return null
    const current = snapCalendarMinute(calendarScale.pixelsToMinutes(event.clientY - bounds.top), 1440)
    const start = Math.min(session.anchor, current)
    return { date: session.date, start, end: Math.max(start + 15, session.anchor, current) }
  }

  const updateCalendarSelection = (event: PointerEvent<HTMLDivElement>) => {
    const session = creationPointer.current
    if (!session || session.pointerId !== event.pointerId) return
    if (!session.moved && Math.abs(event.clientY - session.startY) < 4) return
    session.moved = true
    const preview = calendarSelectionRange(event)
    if (preview) { event.preventDefault(); setCreationPreview(preview) }
  }

  const cancelCalendarSelection = () => {
    if (creationPointer.current) suppressCreateClick.current = true
    creationPointer.current = null
    setCreationPreview(null)
  }
  const finishCalendarSelection = (event: PointerEvent<HTMLDivElement>) => {
    const session = creationPointer.current
    if (!session || session.pointerId !== event.pointerId) return
    const range = calendarSelectionRange(event)
    cancelCalendarSelection()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (session.range !== scheduleRange) return
    suppressCreateClick.current = true
    window.setTimeout(() => { suppressCreateClick.current = false }, 0)
    openCalendarCreate(session.date, 'TIMED', session.moved && range ? range.start : session.anchor,
      session.moved && range ? range.end - range.start : 30)
  }

  const clickCalendarTime = (event: ReactMouseEvent<HTMLDivElement>, date: string) => {
    if (event.target !== event.currentTarget || calendarDialog || actualDialog || dragSource.current || resizingBlock.current) return
    if (suppressCreateClick.current) { suppressCreateClick.current = false; return }
    const bounds = event.currentTarget.getBoundingClientRect()
    if (bounds.height <= 0) return
    const start = event.detail === 0 ? 540 : snapCalendarMinute(calendarScale.pixelsToMinutes(event.clientY - bounds.top))
    openCalendarCreate(date, 'TIMED', start)
  }

  const openActualCreate = (date: string, start: number, end = start + 30) => {
    if (actualDialog || calendarDialog || view !== 'home' || dragSource.current || resizingBlock.current) return
    setActualAnchor(null)
    setActualDialog({ kind: 'create', ...actualDefaults(date, start, end) })
  }
  const openActualEntry = (entry: TimeEntry, anchor: HTMLElement) => {
    if (!actualDialog && !calendarDialog && !dragSource.current && !resizingBlock.current) {
      setActualAnchor(anchor); setActualDialog({ kind: 'entry', entry })
    }
  }
  const beginActualBlockPointer = (event: PointerEvent<HTMLElement>) => {
    event.stopPropagation()
    if (event.button !== 0 || !event.isPrimary) return
    actualBlockPointer.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const updateActualBlockPointer = (event: PointerEvent<HTMLElement>) => {
    const pointer = actualBlockPointer.current
    if (pointer?.pointerId === event.pointerId && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) >= 4) pointer.moved = true
  }
  const finishActualBlockPointer = (event: PointerEvent<HTMLElement>) => {
    const pointer = actualBlockPointer.current
    if (pointer?.pointerId !== event.pointerId) return
    if (pointer.moved || event.type === 'pointercancel') actualBlockClickUntil.current = performance.now() + 300
    actualBlockPointer.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  const cancelActualSelection = () => {
    if (actualPointer.current) suppressActualClick.current = true
    actualPointer.current = null; setActualPreview(null)
  }
  const beginActualSelection = (event: PointerEvent<HTMLDivElement>, date: string) => {
    if (event.target !== event.currentTarget || event.button !== 0 || !event.isPrimary || event.pointerType === 'touch'
      || actualDialog || calendarDialog || actualPointer.current || creationPointer.current || dragSource.current || resizingBlock.current) return
    const bounds = event.currentTarget.getBoundingClientRect()
    if (!bounds.height) return
    suppressActualClick.current = false
    actualPointer.current = { pointerId: event.pointerId, date, anchor: snapCalendarMinute(calendarScale.pixelsToMinutes(event.clientY - bounds.top)),
      startY: event.clientY, moved: false, range: scheduleRange }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const actualSelectionRange = (event: PointerEvent<HTMLDivElement>) => {
    const session = actualPointer.current
    if (!session || session.pointerId !== event.pointerId || session.range !== scheduleRange) return null
    const bounds = event.currentTarget.getBoundingClientRect()
    if (!bounds.height) return null
    const current = snapCalendarMinute(calendarScale.pixelsToMinutes(event.clientY - bounds.top), 1440)
    const start = Math.min(session.anchor, current)
    return { date: session.date, start, end: Math.max(start + 15, session.anchor, current) }
  }
  const updateActualSelection = (event: PointerEvent<HTMLDivElement>) => {
    const session = actualPointer.current
    if (!session || session.pointerId !== event.pointerId || (!session.moved && Math.abs(event.clientY - session.startY) < 4)) return
    session.moved = true
    const range = actualSelectionRange(event)
    if (range) { event.preventDefault(); setActualPreview(range) }
  }
  const finishActualSelection = (event: PointerEvent<HTMLDivElement>) => {
    const session = actualPointer.current
    if (!session || session.pointerId !== event.pointerId) return
    const range = actualSelectionRange(event)
    cancelActualSelection()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (session.range !== scheduleRange) return
    suppressActualClick.current = true
    window.setTimeout(() => { suppressActualClick.current = false }, 0)
    openActualCreate(session.date, session.moved && range ? range.start : session.anchor, session.moved && range ? range.end : session.anchor + 30)
  }
  const clickActualTime = (event: ReactMouseEvent<HTMLDivElement>, date: string) => {
    if (event.target !== event.currentTarget) return
    if (suppressActualClick.current) { suppressActualClick.current = false; return }
    const bounds = event.currentTarget.getBoundingClientRect()
    if (bounds.height > 0) openActualCreate(date, event.detail === 0 ? 540 : snapCalendarMinute(calendarScale.pixelsToMinutes(event.clientY - bounds.top)))
  }

  const cancelResize = (event?: PointerEvent<HTMLButtonElement>) => {
    if (event && resizingBlock.current?.pointerId !== event.pointerId) return
    resizingBlock.current = null
    setResizePreview(null)
  }

  const startResize = (event: PointerEvent<HTMLButtonElement>, block: Extract<ScheduleBlock, { type: 'TIMED' }>) => {
    event.preventDefault()
    event.stopPropagation()
    if (event.button !== 0 || !event.isPrimary || displayedCalendarMode !== 'week' || resizingBlock.current
      || dragSource.current || creationPointer.current || changingBlocks.current.has(block.id)
      || weeklySchedule.status !== 'ready' || weeklySchedule.range !== weekRange) return
    const column = event.currentTarget.closest<HTMLElement>('.calendar-day-column')
    if (!column) return
    const bounds = column.getBoundingClientRect()
    if (bounds.height === 0) return
    // Use the same full-day column geometry as the timed Drop calculation.
    resizingBlock.current = { block, pointerId: event.pointerId, startY: event.clientY, column,
      columnTop: bounds.top, scale: calendarScale, durationMinutes: block.durationMinutes,
      moved: false, range: weekRange }
    event.currentTarget.setPointerCapture(event.pointerId)
    endCalendarDrag()
    setResizePreview({ blockId: block.id, durationMinutes: block.durationMinutes, range: weekRange })
  }

  const updateResize = (event: PointerEvent<HTMLButtonElement>) => {
    const session = resizingBlock.current
    if (!session || session.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    if (displayedCalendarMode !== 'week' || session.range !== weekRange) { cancelResize(); return }
    const pixels = event.clientY - session.startY + session.columnTop - session.column.getBoundingClientRect().top
    if (pixels === 0 && !session.moved) return
    session.moved = true
    session.durationMinutes = Math.max(15, Math.round((session.block.durationMinutes + session.scale.pixelsToMinutes(pixels)) / 15) * 15)
    setResizePreview({ blockId: session.block.id, durationMinutes: session.durationMinutes, range: session.range })
  }

  const finishResize = (event: PointerEvent<HTMLButtonElement>) => {
    if (resizingBlock.current?.pointerId !== event.pointerId) return
    updateResize(event)
    const session = resizingBlock.current
    if (session?.moved) {
      suppressBlockClick.current = true
      window.setTimeout(() => { suppressBlockClick.current = false }, 300)
    }
    cancelResize()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (!session || !session.moved || session.durationMinutes === session.block.durationMinutes) return
    const block = session.block
    void patchBlock(block.id, { durationMinutes: session.durationMinutes }, {
      date: block.date, type: 'TIMED', startTime: block.startTime, durationMinutes: session.durationMinutes,
    })
  }

  useEffect(() => {
    const cancel = () => { resizingBlock.current = null; setResizePreview(null); cancelCalendarSelection(); cancelActualSelection() }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel() }
    cancel()
    window.addEventListener('blur', cancel)
    window.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('blur', cancel)
      window.removeEventListener('keydown', escape)
      cancel()
    }
  }, [view, calendarMode, scheduleRange, calendarZoom])

  const fetchTasks = async (updateInbox = true) => {
    const version = ++taskGeneration.current
    if (updateInbox) refreshInbox()
    try {
      const response = await fetch(`${API}/tasks`)
      if (!response.ok) throw new Error('タスク一覧を取得できませんでした')
      const data = await response.json() as Task[]
      if (version !== taskGeneration.current) return
      startTransition(() => {
        setTasks(data)
        setTimerTaskChoice((current) => String(data.find((task) => String(task.id) === current && !task.completed && task.status !== 'COMPLETED')?.id
          ?? ''))
      })
      void fetchCalendarEntries(data)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '通信に失敗しました')
    }
  }

  const fetchProjects = async () => {
    const version = ++projectGeneration.current
    try {
      const response = await fetch(`${API}/projects`)
      if (!response.ok) throw new Error('プロジェクト一覧を取得できませんでした')
      const data = await response.json() as Project[]
      if (version !== projectGeneration.current) return
      startTransition(() => setProjects(data))
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '通信に失敗しました')
    }
  }

  const fetchDailySummary = async () => {
    const version = ++dailySummaryGeneration.current
    try {
      const response = await fetch(dailySummaryUrl(getLocalDate()))
      if (!response.ok) throw new Error('今日の集計を取得できませんでした')
      const data = await response.json() as DailySummary
      if (version === dailySummaryGeneration.current) startTransition(() => setDailySummary(data))
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '通信に失敗しました')
    }
  }

  const readTaskEntries = useCallback((taskId: number) => {
    const key = `${taskGeneration.current}/${taskId}`
    // Reports' Timer synchronization reads both the selected history and all
    // histories. Share only concurrent reads within this refresh, never cache data.
    const requests = reportEntryRequests.current
    const pending = requests.enabled ? requests.pending.get(key) : undefined
    if (pending) return pending
    const request = fetch(`${API}/tasks/${taskId}/time-entries`).then(response => {
      if (!response.ok) throw new Error('計測履歴を取得できませんでした')
      return response.json() as Promise<TimeEntry[]>
    }).finally(() => { if (requests.pending.get(key) === request) requests.pending.delete(key) })
    if (requests.enabled) requests.pending.set(key, request)
    return request
  }, [])

  const fetchTimeEntries = useCallback(async (taskId: number) => {
    const version = ++historyGeneration.current
    try {
      const data = await readTaskEntries(taskId)
      if (version === historyGeneration.current) setTimeEntries(data)
    } catch (requestError) {
      if (version === historyGeneration.current) setError(requestError instanceof Error ? requestError.message : '計測履歴を取得できませんでした')
    }
  }, [readTaskEntries])

  const fetchCalendarEntries = useCallback(async (taskData: Task[]) => {
    const version = ++calendarEntriesGeneration.current
    setCalendarEntriesStatus('loading')
    try {
      const entryGroups = await Promise.all(taskData.map(task => readTaskEntries(task.id)))
      if (version === calendarEntriesGeneration.current) {
        setCalendarEntries(entryGroups.flat())
        setCalendarEntriesStatus('ready')
      }
    } catch {
      if (version === calendarEntriesGeneration.current) {
        setCalendarEntriesStatus('error')
      }
    }
  }, [readTaskEntries])

  const reloadTaskData = () => {
    void fetchTasks()
    void fetchProjects()
    void fetchDailySummary()
    setReportRefresh((current) => current + 1)
    setCalendarRefresh((current) => current + 1)
  }

  const refreshManualEntries = () => {
    historyGeneration.current += 1
    calendarEntriesGeneration.current += 1
    setCalendarEntriesStatus('loading')
    reloadTaskData()
    const taskId = timerTaskChoice ? Number(timerTaskChoice) : lastTimedTaskId
    if (taskId !== null) void fetchTimeEntries(taskId)
  }
  const manualEntryRequest = async (url: string, method: 'POST' | 'PATCH' | 'DELETE', input?: ManualEntryInput | TimeEntryUpdateInput, deletedEntryId?: number) => {
    let response: Response
    try {
      response = await fetch(url, { method, ...(input ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) } : {}) })
    } catch { throw new Error('サーバーに接続できませんでした。入力内容を確認して再試行してください。') }
    if (!response.ok) {
      const data = await response.json().catch(() => null) as { detail?: unknown } | null
      throw new Error(timeEntryOverlapMessage(data?.detail) ?? (typeof data?.detail === 'string' ? displayApiMessage(data.detail) : response.status === 422 ? 'Task・開始日時・終了日時を確認してください' : getApiErrorMessage(response.status, '記録を更新できませんでした')))
    }
    if (method === 'DELETE' && deletedEntryId !== undefined) {
      // Invalidate in-flight history reads before removing the confirmed deletion.
      // Keep all other cached Actual blocks visible while the fresh reads finish.
      historyGeneration.current += 1
      calendarEntriesGeneration.current += 1
      setTimeEntries(current => current.filter(entry => entry.id !== deletedEntryId))
      setCalendarEntries(current => current.filter(entry => entry.id !== deletedEntryId))
    }
    if (method === 'PATCH') {
      const updated = await response.json() as TimeEntry
      historyGeneration.current += 1
      calendarEntriesGeneration.current += 1
      setTimeEntries(current => current.map(entry => entry.id === updated.id ? updated : entry))
      setCalendarEntries(current => current.map(entry => entry.id === updated.id ? updated : entry))
    }
    refreshManualEntries()
  }
  const saveManualEntry = (input: ManualEntryInput | TimeEntryUpdateInput, entryId?: number) => manualEntryRequest(
    entryId === undefined ? `${API}/time-entries` : `${API}/time-entries/${entryId}`, entryId === undefined ? 'POST' : 'PATCH',
    entryId === undefined ? input : { startedAt: input.startedAt, endedAt: input.endedAt })
  const deleteManualEntry = (entryId: number) => manualEntryRequest(`${API}/time-entries/${entryId}`, 'DELETE', undefined, entryId)
  const saveInlineEntry = (input: EntryCorrection, entryId: number) => manualEntryRequest(`${API}/time-entries/${entryId}`, 'PATCH', input)

  const updateWorkspaceTask = async (taskId: number, input: TaskChanges) => {
    const response = await fetch(`${API}/tasks/${taskId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
    if (response.status === 409 && input.status === 'COMPLETED') {
      await timer.sync()
      throw new Error('計測中のタスクは一時停止または終了してから完了してください。')
    }
    if (!response.ok) throw new Error(await getDeleteErrorMessage(response, 'タスク情報を変更できませんでした。再試行してください。'))
    const updated = await response.json() as Task
    if ('startDate' in input && !('startDate' in updated)) {
      throw new Error('開始日を保存できませんでした。サーバー更新が必要です。入力内容は保持されています。')
    }
    taskGeneration.current += 1
    setTasks(current => current.map(task => task.id === updated.id ? updated : task))
    setInbox(current => current.status === 'ready' ? { ...current, tasks: current.tasks.map(task => task.id === updated.id ? updated : task) } : current)
    reloadTaskData()
    if (updated.status === 'COMPLETED' && timer.pausedTaskId === taskId) timer.finishPaused()
  }

  const editCalendarPlacement = async (blockId: number, placement: CalendarPlacement) => {
    const expected = { ...placement, startTime: placement.startTime === null ? null : `${placement.startTime}:00` }
    if (!await patchBlock(blockId, placement, expected)) throw new Error('予定を変更できませんでした。同じタスクの予定と重複していないか確認し、再度保存してください。')
    setCalendarDialog(current => current?.kind === 'block' && current.block.id === blockId ? { ...current, block: { ...current.block, ...expected } } : current)
  }

  const refreshScheduleReports = () => {
    void fetchDailySummary()
    setReportRefresh((current) => current + 1)
    setCalendarRefresh((current) => current + 1)
  }

  const createWorkspaceTask = async (input: CalendarTaskInput) => {
    const response = await fetch(`${API}/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    })
    if (!response.ok) throw new Error(getApiErrorMessage(response.status, 'タスクを作成できませんでした。もう一度お試しください。'))
    const task = await response.json() as Task
    taskGeneration.current += 1
    setTasks(current => [...current.filter(item => item.id !== task.id), task])
    setInbox(current => current.status === 'ready'
      ? { status: 'ready', tasks: [...current.tasks.filter(item => item.id !== task.id), task] } : current)
    setInboxRefresh(current => current + 1)
    void fetchTasks(false)
    void fetchProjects()
    refreshScheduleReports()
    return task.id
  }

  const createCalendarBlock = async (taskId: number, placement: CalendarPlacement) => {
    const response = await fetch(`${API}/schedule-blocks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, ...placement }),
    })
    if (!response.ok) throw new Error(await getDeleteErrorMessage(response, 'タスクは作成済みですが、予定を保存できませんでした。予定保存を再試行してください。'))
    refreshInbox()
    refreshWeeklySchedule()
    refreshScheduleReports()
  }

  const createWorkspaceProject = async (name: string, color?: string | null) => {
    if (!name.trim()) throw new Error('プロジェクト名を入力してください')
    const response = await fetch(`${API}/projects`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim(), ...(color === undefined ? {} : { color }) }),
    })
    if (!response.ok) throw new Error(response.status === 409 ? '同じプロジェクト名が登録されています' : getApiErrorMessage(response.status, 'プロジェクトを作成できませんでした。もう一度お試しください。'))
    const project = await response.json() as Project
    projectGeneration.current += 1
    setProjects(current => [...current.filter(item => item.id !== project.id), project])
    void fetchProjects()
    return project
  }

  const saveTask = async () => {
    const fail = (message: string) => { setError(message); setTaskFormError(message); return false }
    let estimate: number | null, deadline: string | null
    try { estimate = parseDurationInput(form.estimatedMinutes); deadline = parseDeadline(form.deadline) }
    catch (failure) { return fail(failure instanceof Error ? failure.message : '見積もりを確認してください') }
    let scheduleDate: string | null
    try { scheduleDate = parseDeadline(editorScheduleDraft.date) } catch (failure) { return fail((failure as Error).message) }
    if (editorScheduleDraft.startTime && !scheduleDate) return fail('時刻を設定するには予定日を入力してください')
    if (editorSchedule?.block && !scheduleDate) return fail('予定日を入力してください。予定の解除はCalendarから行ってください')
    if (editorScheduleDraft.startTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(editorScheduleDraft.startTime)) return fail('時刻を確認してください')
    const scheduleChanged = !!scheduleDate && (scheduleDate !== editorSchedule?.placement.date || editorScheduleDraft.startTime !== (editorSchedule?.placement.startTime?.slice(0, 5) ?? ''))
    const placement: CalendarPlacement | null = scheduleDate ? {
      date: scheduleDate, type: editorScheduleDraft.startTime ? 'TIMED' : editorSchedule?.placement.type === 'ALL_DAY' ? 'ALL_DAY' : 'TIME_UNSET',
      startTime: editorScheduleDraft.startTime || null, durationMinutes: editorScheduleDraft.startTime ? editorSchedule?.placement.durationMinutes ?? 60 : null,
    } : null
    const payload = {
      title: form.title.trim(),
      estimatedMinutes: estimate,
      projectId: form.projectId ? Number(form.projectId) : null,
      priority: form.priority || null,
      deadline,
      tagIds: form.tagIds,
      ...(editingId === null ? {} : { status: form.status }),
    }
    if (!payload.title) {
      return fail('タスク名を入力してください')
    }
    if (payload.estimatedMinutes !== null && (!Number.isSafeInteger(payload.estimatedMinutes) || payload.estimatedMinutes <= 0)) {
      return fail('見積もりは空欄、または1以上の整数で入力してください')
    }
    try {
      const taskId = editingId ?? createdEditorTask.current
      if (placement && scheduleChanged && placement.type === 'TIMED') {
        const blocks = await readCalendarDayBlocks(placement.date)
        const start = Number(placement.startTime!.slice(0, 2)) * 60 + Number(placement.startTime!.slice(3, 5))
        const overlaps = blocks.filter(block => {
          if (block.id === editorSchedule?.block?.id || block.type !== 'TIMED' || !block.startTime || !block.durationMinutes) return false
          const other = Number(block.startTime.slice(0, 2)) * 60 + Number(block.startTime.slice(3, 5))
          return start < other + block.durationMinutes && other < start + placement.durationMinutes!
        })
        if (overlaps.some(block => block.taskId === taskId)) return fail('同じタスクの予定と重複しています。時刻を変更してください。')
        if (overlaps.length && !window.confirm('別のタスクの予定と時間が重複しています。保存しますか？')) return false
      }
      let savedId = taskId
      if (savedId === null) { savedId = await createWorkspaceTask(payload); createdEditorTask.current = savedId }
      else await updateWorkspaceTask(savedId, payload)
      if (editingId === null && (form.status !== 'NOT_STARTED' || taskId !== null)) await updateWorkspaceTask(savedId, { status: form.status })
      if (placement && scheduleChanged) {
        if (editorSchedule?.block) {
          if (!await patchBlock(editorSchedule.block.id, placement, { ...placement, startTime: placement.startTime === null ? null : `${placement.startTime}:00` })) return fail('予定を保存できませんでした。再度保存してください。')
        } else await createCalendarBlock(savedId, placement)
      }
      createdEditorTask.current = null
      setForm(emptyTask)
      setEditingId(null)
      setTaskComposerOpen(false)
      setTaskFormError('')
      setError('')
      return true
    } catch (failure) {
      return fail(failure instanceof TypeError ? 'サーバーに接続できませんでした'
        : failure instanceof Error ? failure.message : 'タスクを保存できませんでした')
    }
  }

  const editTask = (task: Task, block?: CalendarPlacement & { id: number }, anchor?: HTMLElement | null) => {
    const source = block ?? null
    setEditorSchedule(source ? { block: source, placement: source } : null)
    setEditorScheduleDraft({ date: source ? deadlineText(source.date) : '', startTime: source?.startTime?.slice(0, 5) ?? '' })
    setEditorAnchor(anchor ?? null)
    createdEditorTask.current = null
    setTaskFormError('')
    setEditingId(task.id)
    setTaskComposerOpen(true)
    setForm({
      title: task.title,
      estimatedMinutes: formatDurationInput(task.estimatedMinutes),
      projectId: task.projectId === null ? '' : String(task.projectId),
      priority: task.priority ?? '',
      deadline: deadlineText(task.deadline ?? null),
      tagIds: (task.tags ?? []).map(tag => tag.id),
      status: task.status,
    })
    setCalendarDialog(null); setActualDialog(null)
  }

  const createTask = (projectId: number | null = null) => {
    setEditorSchedule(null); setEditorScheduleDraft({ date: '', startTime: '' }); setEditorAnchor(null); createdEditorTask.current = null
    setTaskFormError('')
    setEditingId(null)
    setForm({ ...emptyTask, projectId: projectId === null ? '' : String(projectId) })
    setTaskComposerOpen(true)
  }

  const openProjectForm = (project?: Project) => {
    setEditingProjectId(project?.id ?? null)
    setProjectName(project?.name ?? '')
    setProjectColor(undefined)
    setProjectFormError('')
    setProjectComposerOpen(true)
  }

  const renameWorkspaceProject = async (id: number, name: string, color?: string | null) => {
    const response = await fetch(`${API}/projects/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim(), ...(color === undefined ? {} : { color }) }),
    })
    if (!response.ok) throw new Error(response.status === 409 ? '同じプロジェクト名が登録されています' : getApiErrorMessage(response.status, 'プロジェクトを保存できませんでした'))
    const project = await response.json() as Project
    projectGeneration.current += 1
    setProjects(current => current.map(item => item.id === project.id ? project : item))
    setProjectActionError(null)
    setError('')
    void fetchProjects()
    void fetchTasks()
  }

  const saveProject = async () => {
    const fail = (message: string) => { setError(message); setProjectFormError(message); return false }
    if (!projectName.trim()) {
      return fail('プロジェクト名を入力してください')
    }
    try {
      if (editingProjectId === null) await createWorkspaceProject(projectName, projectColor ?? undefined)
      else await renameWorkspaceProject(editingProjectId, projectName, projectColor)
      setProjectName('')
      setEditingProjectId(null)
      setProjectComposerOpen(false)
      setProjectFormError('')
      setProjectActionError(null)
      setError('')
      if (editingProjectId === null) void fetchTasks()
      return true
    } catch (failure) {
      return fail(failure instanceof TypeError ? 'サーバーに接続できませんでした' : failure instanceof Error ? failure.message : 'プロジェクトを保存できませんでした')
    }
  }

  const deleteProject = async (project: Project) => {
    if (deletingProjects.current.has(project.id)) return
    if (!window.confirm(`「${project.name}」を削除しますか？タスクは未所属で残ります。`)) return
    deletingProjects.current.add(project.id)
    setDeletingProjectIds([...deletingProjects.current])
    const fail = (message: string) => { setError(message); setProjectActionError({ id: project.id, message }) }
    try {
      const response = await fetch(`${API}/projects/${project.id}`, { method: 'DELETE' })
      if (!response.ok) {
        fail(await getDeleteErrorMessage(response, 'プロジェクトを削除できませんでした'))
        return
      }
      setError('')
      setProjectActionError(null)
      projectGeneration.current += 1
      setProjects(current => current.filter(item => item.id !== project.id))
      if (editingProjectId === project.id) {
        setEditingProjectId(null)
        setProjectName('')
      }
      if (selectedProjectId === project.id) {
        setSelectedProjectId(null)
        setTaskSection('projects')
      }
      void fetchProjects()
      void fetchTasks()
    } catch {
      fail('サーバーに接続できませんでした')
    } finally {
      deletingProjects.current.delete(project.id)
      setDeletingProjectIds([...deletingProjects.current])
    }
  }

  const timer = useTimer(API, (entry, active) => {
    historyGeneration.current += 1
    calendarEntriesGeneration.current += 1
    setCalendarEntriesStatus('loading')
    if (active) { setTimerTaskChoice(String(active.taskId)); setLastTimedTaskId(active.taskId) }
    if (entry) {
      setLastTimedTaskId(entry.taskId)
      setTimerTaskChoice('')
      setTimerTaskTitle('')
      setTimerTagIds([])
      setTimeEntries((current) => [...current.filter((item) => item.id !== entry.id), entry])
      setCalendarEntries((current) => [...current.filter((item) => item.id !== entry.id), entry])
    }
    reloadTaskData()
    const taskId = entry?.taskId ?? active?.taskId ?? Number(timerTaskChoice)
    if (taskId) void fetchTimeEntries(taskId)
  })
  const reportNow = useCalendarClock(view === 'reports' && (timer.active !== null || calendarEntries.some(entry => entry.endedAt === null)))
  const runningTaskId = timer.active?.taskId ?? null
  const pausedTaskId = timer.pausedTaskId
  // Reset Quick Start's input without hiding the last measured Task's history.
  const historyTaskId = runningTaskId ?? pausedTaskId ?? (timerTaskChoice ? Number(timerTaskChoice) : lastTimedTaskId)
  const timerDisabled = timer.busy || !timer.ready || quickTimerBusy
  const startTimer = timer.start
  const stopTimer = timer.stop
  const finishPausedTimer = timer.finishPaused
  const syncTimer = timer.sync

  const startGlobalTimer = async (taskId: number | null) => {
    if (quickTimerPending.current || timerDisabled || timer.active) return
    if (taskId !== null) { await startTimer(taskId); return }
    // Lock before creating the Task, so repeated clicks cannot create duplicates.
    quickTimerPending.current = true
    setQuickTimerBusy(true)
    setError('')
    try {
      const createdId = await createWorkspaceTask({ title: timerTaskTitle.trim() || PLACEHOLDER_TASK_TITLE, projectId: timerProjectId, estimatedMinutes: null, tagIds: timerTagIds })
      setTimerTaskChoice(String(createdId))
      setTimerTaskTitle('')
      if (!await startTimer(createdId)) setError('タスクは作成済みですが計測を開始できませんでした。計測状態を確認して再試行してください。')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '計測を開始できませんでした')
    } finally {
      quickTimerPending.current = false
      setQuickTimerBusy(false)
    }
  }

  const startTaskTimer = async (taskId: number) => {
    setTaskActionError(null)
    const started = await startTimer(taskId)
    if (!started) setTaskActionError({ id: taskId, message: '計測を開始できませんでした。別のタスクの計測や完了状態を確認してください。' })
    return started
  }

  const deleteTask = async (task: Task, onError?: (message: string) => void) => {
    if (!window.confirm('このタスクを削除しますか？')) return false
    const fail = (message: string) => { setError(message); setTaskActionError({ id: task.id, message }); onError?.(message); return false }
    try {
      const response = await fetch(`${API}/tasks/${task.id}`, { method: 'DELETE' })
      if (!response.ok) {
        return fail(await getDeleteErrorMessage(response, 'タスクを削除できませんでした'))
      }
      setError('')
      setTaskActionError(null)
      if (timerTaskChoice === String(task.id)) {
        setTimerTaskChoice('')
        historyGeneration.current += 1
        setTimeEntries([])
      }
      reloadTaskData()
      if (timer.pausedTaskId === task.id) timer.finishPaused()
      // A deletable Task has no entries, so deleting it cannot end the DB Active.
      return true
    } catch {
      return fail('サーバーに接続できませんでした')
    }
  }

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => { if (!cancelled) void syncTimer() })
    return () => { cancelled = true }
  }, [view, taskSection, selectedProjectId, syncTimer])

  useEffect(() => {
    if (view !== 'reports' || reportDemo) return
    const controller = new AbortController()
    const dates = reportPeriodDates(reportMode, reportDate, reportRange)
    const key = reportPeriodKey(reportMode, reportDate, reportRefresh, reportRange)
    // Start-date filtering would omit overnight sources before the Report period.
    const params = new URLSearchParams({ endDate: dates[dates.length - 1] })
    void fetch(`${API}/schedule-blocks?${params}`, { signal: controller.signal })
      .then(response => {
        if (!response.ok) throw new Error('レポートの予定を取得できませんでした')
        return response.json() as Promise<ScheduleBlock[]>
      })
      .then(blocks => { if (!controller.signal.aborted) setReportSchedules({ key, blocks }) })
      .catch(() => { if (!controller.signal.aborted) setReportSchedules({ key, blocks: [], error: 'レポートの予定を取得できませんでした' }) })
    return () => controller.abort()
  }, [view, reportMode, reportDate, reportRefresh, reportRange, reportDemo])

  useEffect(() => {
    const controller = new AbortController()
    fetch(`${API}/tasks?inbox=true`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('未配置タスクを取得できませんでした')
        return response.json() as Promise<Task[]>
      })
      .then((data) => {
        if (!controller.signal.aborted) {
          for (const taskId of placedTasks.current) {
            if (!data.some((task) => task.id === taskId)) {
              placedTasks.current.delete(taskId)
              placingTasks.current.delete(taskId)
            }
          }
          setPlacingTaskIds([...placingTasks.current])
          setInbox({ status: 'ready', tasks: data })
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setInbox({ status: 'error', message: '未配置タスクを取得できませんでした' })
      })
    return () => controller.abort()
  }, [inboxRefresh])

  useEffect(() => {
    let cancelled = false
    const taskVersion = ++taskGeneration.current
    const projectVersion = ++projectGeneration.current
    const summaryVersion = ++dailySummaryGeneration.current
    const loadInitialData = async () => {
      try {
        const [taskResponse, projectResponse, summaryResponse] = await Promise.all([
          fetch(`${API}/tasks`),
          fetch(`${API}/projects`),
          fetch(dailySummaryUrl(getLocalDate())),
        ])
        if (![taskResponse, projectResponse, summaryResponse].every((response) => response.ok)) {
          throw new Error('初期データを取得できませんでした')
        }
        const [loadedTasks, loadedProjects, summary] = await Promise.all([
          taskResponse.json() as Promise<Task[]>,
          projectResponse.json() as Promise<Project[]>,
          summaryResponse.json() as Promise<DailySummary>,
        ])
        if (cancelled) return
        startTransition(() => {
          if (taskVersion === taskGeneration.current) setTasks(loadedTasks)
          if (projectVersion === projectGeneration.current) setProjects(loadedProjects)
          if (summaryVersion === dailySummaryGeneration.current) setDailySummary(summary)
        })
        if (taskVersion === taskGeneration.current) void fetchCalendarEntries(loadedTasks)
      } catch (requestError) {
        if (!cancelled) setError(requestError instanceof Error ? requestError.message : '初期データを取得できませんでした')
      }
    }
    void loadInitialData()
    return () => { cancelled = true }
  }, [fetchCalendarEntries])

  useEffect(() => {
    const controller = new AbortController()
    const range = `${requestedStartDate}/${requestedEndDate}`
    const params = new URLSearchParams({ startDate: requestedStartDate, endDate: requestedEndDate })
    // The API filters by source start date, not interval overlap. Include earlier
    // sources so Day/Week can show continuations, including multi-day schedules.
    if (calendarMode !== 'month') params.delete('startDate')
    const dates = calendarMode === 'day' ? [calendarDate]
      : getReportDates(calendarMode === 'week' ? 'week' : 'month', calendarDate)
    const load = async () => {
      const [blocks, summaries] = await Promise.all([
        fetch(`${API}/schedule-blocks?${params.toString()}`, { signal: controller.signal }).then(response => {
          if (!response.ok) throw new Error('予定を取得できませんでした')
          return response.json() as Promise<ScheduleBlock[]>
        }),
        Promise.all(dates.map(async targetDate => {
          const response = await fetch(dailySummaryUrl(targetDate), { signal: controller.signal })
          if (!response.ok) throw new Error(`${targetDate}の集計を取得できませんでした`)
          return response.json() as Promise<DailySummary>
        })),
      ])
      return { blocks, summaries }
    }
    void load()
      .then(({ blocks, summaries }) => {
        if (!controller.signal.aborted) {
          for (const blockId of deletedBlocks.current) {
            if (!blocks.some((block) => block.id === blockId)) {
              deletedBlocks.current.delete(blockId)
              changingBlocks.current.delete(blockId)
            }
          }
          for (const [blockId, expected] of changedBlocks.current) {
            const block = blocks.find((item) => item.id === blockId)
            if (!block || (block.date === expected.date && block.type === expected.type
              && (block.type !== 'TIMED' || (block.startTime === expected.startTime
                && (expected.durationMinutes === undefined || block.durationMinutes === expected.durationMinutes))))) {
              changedBlocks.current.delete(blockId)
              changingBlocks.current.delete(blockId)
            }
          }
          setChangingBlockIds([...changingBlocks.current])
          startTransition(() => {
            setCalendarData({ mode: calendarMode, date: calendarDate, range, blocks: blocks.filter(block => !deletedBlocks.current.has(block.id)
              && (block.date >= requestedStartDate || scheduleSegmentsForDay([block], requestedStartDate).length > 0)), summaries })
            setCalendarRequest({ key: calendarRequestKey, status: 'ready' })
          })
        }
      })
      .catch(() => {
        // A failure marks this request only; it never discards the visible data.
        if (!controller.signal.aborted) setCalendarRequest({ key: calendarRequestKey, status: 'error' })
      })
    return () => controller.abort()
  }, [requestedStartDate, requestedEndDate, calendarDate, calendarMode, calendarRequestKey])

  const elapsedReportMinute = Math.floor(getElapsedSeconds(timer.active?.startedAt ?? null, calendarNow) / 60)
  useEffect(() => {
    if (view !== 'home' || runningTaskId === null) return
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) {
        setCalendarRefresh(current => current + 1)
        void fetchDailySummary()
      }
    })
    return () => { cancelled = true }
  }, [view, runningTaskId, elapsedReportMinute])

  useEffect(() => {
    if (historyTaskId === null) return undefined
    let cancelled = false
    queueMicrotask(() => { if (!cancelled) void fetchTimeEntries(historyTaskId) })
    return () => { cancelled = true; historyGeneration.current += 1 }
  }, [historyTaskId, fetchTimeEntries])

  const today = calendarClock.date
  const calendarDates = displayedCalendarMode === 'day'
    ? [displayedCalendarDate]
    : getReportDates(displayedCalendarMode === 'week' ? 'week' : 'month', displayedCalendarDate)
  const monthCalendarDates = getMonthGridDates(displayedCalendarDate)
  const monthLabel = new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: 'long' }).format(new Date(`${displayedCalendarDate}T12:00:00`))
  const calendarLabel = displayedCalendarMode === 'month'
    ? monthLabel
    : displayedCalendarMode === 'day'
      ? formatCalendarDate(displayedCalendarDate)
      : `W${getISOWeekNumber(displayedCalendarDate)}  ${formatShortDate(calendarDates[0])} - ${formatShortDate(calendarDates[calendarDates.length - 1])}`
  const calendarSummaries = calendarData?.summaries ?? []
  const showCalendarActual = displayedCalendarMode === 'day' || weekDisplay === 'compare'
  const weekBlocks = calendarData?.blocks ?? []
  const unsetDropAvailable = draggingTaskId !== null || weekBlocks.some((block) => block.id === draggingBlockId)
  const tasksById = new Map(tasks.map((task) => [task.id, task]))
  const weekSchedules = weekBlocks.flatMap((schedule) => {
    const task = tasksById.get(schedule.taskId)
    return task ? [{ schedule, task }] : []
  })
  // Inbox membership comes from the API; keep the existing completed-task display filter.
  const unplannedTasks = inbox.status === 'ready' ? inbox.tasks.filter((task) => !task.completed) : []
  const inboxCount = inbox.status === 'ready' ? `${unplannedTasks.length}件` : inbox.status === 'loading' ? '読込中' : '取得失敗'
  const runningTask = tasks.find((task) => task.id === runningTaskId)
    ?? (runningTaskId === null ? undefined : { id: runningTaskId, title: `タスク #${runningTaskId}`, projectName: null })
  const selectedTimerTask = tasks.find((task) => task.id === Number(timerTaskChoice))
  const visibleTimeEntries = historyTaskId !== null
    ? timeEntries.filter((entry) => entry.taskId === historyTaskId)
    : []
  const getActualSegmentsForDay = (targetDate: string, now: number) => {
    if (displayedCalendarMode === 'week' && weekDisplay !== 'compare') return []
    return entrySegmentsForLocalDay(calendarEntries, targetDate, now).flatMap(segment => {
      const task = tasksById.get(segment.entry.taskId)
      return task ? [{ ...segment, task }] : []
    })
  }
  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null
  const reportKey = reportPeriodKey(reportMode, reportDate, reportRefresh, reportRange)
  const reportBlocks = reportDemo?.blocks ?? reportSchedules?.blocks
  const reportEntries = reportDemo?.entries ?? calendarEntries
  const reportTasks = reportDemo?.tasks ?? tasks
  const reportProjects = reportDemo?.projects ?? projects
  // Commit the complete period and its inputs together. Conditional render-time
  // adjustment avoids painting an intermediate period with the previous data.
  if (view === 'reports' && reportBlocks && (reportDemo || (reportSchedules?.key === reportKey && !reportSchedules.error && calendarEntriesStatus === 'ready'))
    && (displayedReport?.key !== reportKey || displayedReport.blocks !== reportBlocks
      || displayedReport.entries !== reportEntries || displayedReport.tasks !== reportTasks || displayedReport.projects !== reportProjects)) {
    setDisplayedReport({ key: reportKey, mode: reportMode, date: reportDate, range: reportRange, blocks: reportBlocks,
      entries: reportEntries, tasks: reportTasks, projects: reportProjects })
  }
  const displayedReportMode = displayedReport?.mode ?? reportMode
  const displayedReportDate = displayedReport?.date ?? reportDate
  const displayedReportRange = displayedReport ? displayedReport.range : reportRange
  const displayedReportSelectionMode = displayedReportRange ? 'range' : displayedReportMode
  const reportDates = reportPeriodDates(displayedReportMode, displayedReportDate, displayedReportRange)
  const reportReady = displayedReport !== null
  const filteredReport = filterReportDataset(displayedReport?.tasks ?? [], displayedReport?.blocks ?? [], displayedReport?.entries ?? [], reportFilters)
  const reportData = buildReportMetrics(filteredReport.tasks, displayedReport?.projects ?? projects,
    filteredReport.blocks, filteredReport.entries, reportDates, reportNow)
  const reportRangeLabel = displayedReportRange ? `${formatShortDate(reportDates[0])} - ${formatShortDate(reportDates[reportDates.length - 1])}`
    : displayedReportMode === 'day' ? `${displayedReportDate.replaceAll('-', '/')}(${formatCalendarWeekday(displayedReportDate)})` : displayedReportMode === 'week'
    ? `${formatShortDate(reportDates[0])} - ${formatShortDate(reportDates[reportDates.length - 1])}`
    : `${Number(displayedReportDate.slice(0, 4))}年${Number(displayedReportDate.slice(5, 7))}月`
  const reportAxis = reportChartScale(Math.max(0, ...reportData.daily.flatMap(day => [day.plannedMinutes, day.actualMinutes])))
  const reportSingleDayChart = displayedReportSelectionMode === 'day'
  const reportHours = reportHourlyBuckets(reportData.daily[0]?.planIntervals ?? [], reportData.daily[0]?.actualIntervals ?? [])
  const reportActivity = reportActivityRows(filteredReport.entries, reportDates, reportNow)
  const shiftReportPeriod = (offset: number) => {
    if (reportRange) {
      const length = reportPeriodDates(reportMode, reportDate, reportRange).length
      setReportRange({ start: shiftDate(reportRange.start, offset * length), end: shiftDate(reportRange.end, offset * length) })
      setReportDate(current => shiftDate(current, offset * length))
      return
    }
    if (reportMode === 'day') {
      setReportDate((current) => shiftDate(current, offset))
      return
    }
    if (reportMode === 'week') {
      setReportDate((current) => shiftDate(current, offset * 7))
      return
    }
    const [year, month] = reportDate.split('-').map(Number)
    setReportDate(formatDate(new Date(year, month - 1 + offset, 1, 12)))
  }
  const selectReportMode = (mode: ReportMode | 'range') => {
    setReportPickerAnchor(null)
    if (mode === 'range') {
      if (reportRange) return
      reportBeforeRange.current = { mode: reportMode, date: reportDate }
      const dates = reportPeriodDates(reportMode, reportDate, null)
      setReportRange({ start: dates[0], end: dates[dates.length - 1] })
    } else {
      setReportRange(null)
      setReportMode(mode)
    }
  }
  const clearReportRange = () => {
    setReportPickerAnchor(null)
    setReportRange(null)
    setReportMode(reportBeforeRange.current.mode)
    setReportDate(reportBeforeRange.current.date)
  }
  const shiftCalendarPeriod = (offset: number) => {
    if (calendarMode === 'day') {
      setCalendarDate((current) => shiftDate(current, offset))
    } else if (calendarMode === 'week') {
      setCalendarDate((current) => shiftDate(current, offset * 7))
    } else {
      setCalendarDate(current => {
        const [year, month] = current.split('-').map(Number)
        return formatDate(new Date(year, month - 1 + offset, 1, 12))
      })
    }
  }
  const renderCalendarMetrics = (date: string, compact = false) => {
    const summary = calendarSummaries.find(day => day.date === date)
    const unavailable = summary ? null : calendarLoadStatus === 'error' ? '取得失敗' : '読込中'
    const planned = plannedMinutesForDay(weekBlocks, date)
    return <dl className={`home-metrics ${compact ? 'compact' : ''}`} data-metric-date={date} aria-label={`${date}の予定と記録`}>
      {[
        { label: '計画済み', short: '計画済み', minutes: planned },
        { label: '記録', short: '記録', minutes: summary?.dailyActualMinutes },
      ].map(metric => <div key={metric.label}><dt title={metric.label}>{compact ? metric.short : metric.label}</dt>
        <dd>{unavailable ?? formatDuration(metric.minutes ?? 0)}</dd></div>)}
    </dl>
  }
  const renderCalendarZoom = () => displayedCalendarMode !== 'month' && <div className="calendar-zoom-control" role="group" aria-label="時間軸ズーム" data-zoom-level={calendarZoom}>
      <button type="button" className="secondary-button" aria-label="時間軸を縮小" disabled={calendarZoom === 1} onClick={() => setCalendarZoom(level => Math.max(1, level - 1))}><UiIcon name="minus" /></button>
      <output className="visually-hidden" aria-label="時間軸のズーム段階">{calendarZoom} / 5</output>
      <button type="button" className="secondary-button" aria-label="時間軸を拡大" disabled={calendarZoom === 5} onClick={() => setCalendarZoom(level => Math.min(5, level + 1))}><UiIcon name="plus" /></button>
    </div>
  const renderCalendarUpdate = () => <>
    <span className={`calendar-update-status ${calendarLoadStatus === 'loading' ? '' : 'is-idle'}`}
      role={calendarLoadStatus === 'loading' ? 'status' : undefined} aria-hidden={calendarLoadStatus !== 'loading'}>更新中…</span>
    {showCalendarActual && displayedCalendarMode !== 'month' && calendarEntriesStatus === 'loading'
      && <span className="calendar-update-status" role="status">記録を更新中…</span>}
  </>
  const renderCalendarStatus = () => <div className="calendar-schedule-status" aria-live="polite">
    {renderCalendarUpdate()}
    {calendarLoadStatus === 'error' && <p className="error" role="alert">カレンダーを更新できませんでした。
      {calendarData && '前回取得した期間・内容を表示しています。'} <button type="button" onClick={refreshWeeklySchedule}>再取得</button></p>}
    {showCalendarActual && displayedCalendarMode !== 'month' && calendarEntriesStatus === 'error'
      && <p className="error" role="alert">記録を取得できませんでした。予定は引き続き操作できます。 <button type="button" onClick={() => void fetchCalendarEntries(tasks)}>記録を再取得</button></p>}
  </div>
  const projectsPage = view === 'tasks' && taskSection !== 'list'
  const workspacePage = view === 'tasks' ? taskSection === 'list' ? 'tasks' : taskSection : view
  const projectColorById = (id: number | null) => id === null ? '#78818B' : getProjectColor(projects.find(project => project.id === id) ?? { id })
  const pageHeading = view !== 'tasks' && <div className={`page-heading-copy ${view === 'home' ? 'home-heading' : 'workspace-page-heading'}`}>{view === 'home' && <p className="eyebrow">HOME</p>}
    <h1>{view === 'home' ? displayedCalendarMode === 'week' ? '今週の予定' : displayedCalendarMode === 'month' ? monthLabel : formatCalendarDate(displayedCalendarDate) : 'レポート'}</h1>
    {view === 'home' && <p className="today-date">{formatCalendarDate(today)} ・ 今日</p>}
  </div>
  return (
    <TimerUiContext.Provider value={{ pending: timer.pendingOperation, onStop: () => void stopTimer(false) }}><TagContext.Provider value={tagStore}><AppShell page={workspacePage}>
      <nav className="icon-rail" aria-label="メインメニュー">
        <div className="brandmark" aria-hidden="true">T</div>
        <button type="button" className={view === 'home' ? 'active' : ''} aria-label="ホーム" title="ホーム" onClick={() => setView('home')}><NavRailIcon name="calendar" /><span className="nav-rail-label">ホーム</span></button>
        <button type="button" className={view === 'tasks' && taskSection === 'list' ? 'active' : ''} aria-label="タスク" title="タスク" onClick={() => { setView('tasks'); setTaskSection('list') }}><NavRailIcon name="task" /><span className="nav-rail-label">タスク一覧</span></button>
        <button type="button" className={projectsPage ? 'active' : ''} aria-label="プロジェクト" title="プロジェクト" onClick={() => { setView('tasks'); setTaskSection('projects') }}><NavRailIcon name="projects" /><span className="nav-rail-label">プロジェクト</span></button>
        <button type="button" className={view === 'reports' ? 'active' : ''} aria-label="レポート" title="レポート" onClick={() => setView('reports')}><NavRailIcon name="reports" /><span className="nav-rail-label">レポート</span></button>
        <span className="rail-spacer" />
      </nav>
      <WorkspaceSidebar page={workspacePage}
        onNavigate={page => { if (page === 'home') setView('home'); else { setView('tasks'); setTaskSection('projects') } }}>
        {view === 'home' && <>
                <section className={`home-sidebar-section unplanned-panel ${draggingBlockId !== null ? 'inbox-release-available' : ''} ${inboxDropOver ? 'inbox-release-over' : ''}`}
                  aria-label="未配置タスク。予定をここにドロップすると、その予定だけを解除します"
                  onDragOver={event => { if (!getDraggedBlock(event)) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; setInboxDropOver(true); setDropDate(null); setTimedDropPreview(null) }}
                  onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setInboxDropOver(false) }}
                  onDrop={event => { const block = getDraggedBlock(event); if (!block || Number(event.dataTransfer.getData(SCHEDULE_BLOCK_DRAG_TYPE)) !== block.id) return; event.preventDefault(); event.stopPropagation(); void releaseBlock(block.id) }}>
                  <div className="section-heading"><h2>未配置のタスク <span className="home-section-count">{inboxCount}</span></h2><button type="button" className="secondary-button home-add-trigger" aria-label="未配置タスクを作成" onClick={() => createTask()}>＋</button></div>
                  {draggingBlockId !== null && <p className="inbox-release-hint" role="status">ここにドロップして、この予定を解除<br /><small>最後の予定を解除すると未配置へ戻ります</small></p>}
                  {placementError && <p className="error" role="alert">{placementError}</p>}
                  {inbox.status === 'loading' ? <p className="empty-state" role="status">未配置タスクを読み込んでいます</p>
                    : inbox.status === 'error' ? <p className="error" role="alert">{inbox.message} <button type="button" onClick={refreshInbox}>再取得</button></p>
                    : unplannedTasks.length === 0 ? <p className="empty-state">配置できるタスクはありません</p> : <ul className="unplanned-list">{unplannedTasks.map((task) => (
                    <InboxTaskCard key={task.id} project={projects.find(p => p.id === (tasks.find(item => item.id === task.id) ?? task).projectId)} task={tasks.find(item => item.id === task.id) ?? task} draggable={!placingTaskIds.includes(task.id)} dragging={draggingTaskId === task.id} placing={placingTaskIds.includes(task.id)}
                      activeTaskId={runningTaskId} timerDisabled={timerDisabled} error={taskActionError?.id === task.id ? taskActionError.message : undefined}
                      onOpenEditor={() => { if (!calendarDialog && !actualDialog) editTask(tasks.find(item => item.id === task.id) ?? task) }} onStart={() => void startTaskTimer(task.id)}
                      onDragStart={event => startInboxDrag(event, task.id)} onDragEnd={endCalendarDrag} />
                  ))}</ul>}
                </section>

        </>}
      </WorkspaceSidebar>
      <main className="app-main">
      <header className={`page-header app-header ${view === 'home' ? 'home-header' : ''}`}>
        {pageHeading}
        <GlobalTimer active={timer.active} pausedTaskId={pausedTaskId} pausedSeconds={timer.pausedElapsedSeconds} offsetSeconds={timer.elapsedOffsetSeconds} tasks={tasks}
          tagIds={timerTagIds} onTags={async tagIds => {
            const taskId = runningTaskId ?? pausedTaskId ?? (timerTaskChoice ? Number(timerTaskChoice) : null)
            if (taskId === null) setTimerTagIds(tagIds)
            else await updateWorkspaceTask(taskId, { tagIds })
          }} onCreateProject={createWorkspaceProject} projects={projects} projectId={timerProjectId} onProject={async projectId => {
            const taskId = runningTaskId ?? pausedTaskId ?? (timerTaskChoice ? Number(timerTaskChoice) : null)
            if (taskId === null) setTimerProjectId(projectId)
            else await updateWorkspaceTask(taskId, { projectId })
          }} onRename={(taskId, title) => updateWorkspaceTask(taskId, { title })} onQueryChange={setTimerTaskTitle}
          choice={timerTaskChoice} disabled={timerDisabled} creatingTask={quickTimerBusy} onChoice={setTimerTaskChoice}
          onStart={taskId => void startGlobalTimer(taskId)}
          onStop={() => timer.active ? void stopTimer(false) : finishPausedTimer()} onDetails={() => setTimerDetailsOpen(true)} />


      </header>

      <div className="desktop-page-heading">{pageHeading}</div>

      {timer.error && <p className="error global-error" role="alert">{timer.error} <button type="button" disabled={timer.busy} onClick={() => void timer.sync()}>再同期</button></p>}
      {error && <p className="error global-error" role="alert">{error}</p>}

      {view === 'home' && <div className="home-workspace">

        <section className="calendar-page">
          <header className="home-calendar-header" aria-label="Calendar controls">
        <div className="calendar-toolbar home-calendar-controls">
          <div className="calendar-navigation-controls">
            <div className="calendar-period-controls">
              <div className="calendar-period-navigation" data-mode={displayedCalendarMode}>
              <button type="button" aria-label="前の期間" onClick={() => shiftCalendarPeriod(-1)}><UiIcon name="chevronLeft" /></button>
              <button type="button" className="calendar-period-trigger" aria-label="カレンダーピッカーを開く" aria-haspopup="dialog" aria-expanded={!!navigationPickerAnchor} aria-controls={navigationPickerAnchor ? 'calendar-navigation-picker' : undefined} onClick={event => { const anchor = event.currentTarget; setNavigationPickerAnchor(current => current ? null : anchor) }}><strong className="calendar-period-label">{displayedCalendarMode === 'week' ? <><span>W{getISOWeekNumber(displayedCalendarDate)}</span>{' '}<span>{formatShortDate(calendarDates[0])} - {formatShortDate(calendarDates[calendarDates.length - 1])}</span></> : calendarLabel}</strong></button>
              <button type="button" aria-label="次の期間" onClick={() => shiftCalendarPeriod(1)}><UiIcon name="chevronRight" /></button>
              </div>
            <div className="calendar-mode-switch" role="group" aria-label="カレンダー表示">
              {(['day', 'week', 'month'] as const).map((mode) => (
                <button key={mode} type="button" className={calendarMode === mode ? 'active' : ''} aria-pressed={calendarMode === mode} onClick={() => {
                  if (mode !== calendarMode) setCalendarMode(mode)
                  else if (mode === 'week') refreshWeeklySchedule()
                }}>{mode === 'day' ? '日' : mode === 'week' ? '週' : '月'}</button>
              ))}
            </div>
              <button type="button" className="today-button" onClick={() => { setCalendarDate(calendarClock.date) }}>今日</button>
            </div>
          </div>


          {displayedCalendarMode === 'week' && <div className="home-calendar-display-controls"><div className="calendar-mode-switch calendar-comparison-switch" role="group" aria-label="週カレンダーの表示内容">
              <button type="button" className={weekDisplay === 'plan' ? 'active' : ''} aria-pressed={weekDisplay === 'plan'} onClick={() => setWeekDisplay('plan')}>計画済みのみ</button>
              <button type="button" className={weekDisplay === 'compare' ? 'active' : ''} aria-pressed={weekDisplay === 'compare'} onClick={() => setWeekDisplay('compare')}>計画済み＋記録</button>
            </div>
          </div>}
            <div className="calendar-mode-switch home-view-switch" role="group" aria-label="Home表示方法">
              <button type="button" aria-pressed={homeView === 'calendar'} className={homeView === 'calendar' ? 'active' : ''} onClick={() => setHomeView('calendar')}>カレンダー</button>
              <button type="button" aria-pressed={homeView === 'list'} className={homeView === 'list' ? 'active' : ''} onClick={() => setHomeView('list')}>リスト</button>
            </div>
          </div>
          {homeView === 'calendar' && displayedCalendarMode === 'week' && <div className="calendar-loading-status" aria-live="polite">{renderCalendarUpdate()}</div>}
          </header>
          {navigationPickerAnchor && <CalendarNavigationPicker mode={displayedCalendarMode} selectedDate={displayedCalendarDate} today={calendarClock.date} anchor={navigationPickerAnchor}
            onSelect={setCalendarDate} onClose={() => setNavigationPickerAnchor(null)} />}

          {homeView === 'list' ? <LiveClock active={calendarEntries.some(entry => entry.endedAt === null)}>{now => <HomeEntryList
            entries={calendarEntries} dates={displayedCalendarMode === 'day' ? [displayedCalendarDate] : getReportDates(displayedCalendarMode, displayedCalendarDate)}
            tasks={tasks} projects={projects} now={now} status={calendarEntriesStatus} onSave={saveInlineEntry} onDelete={deleteManualEntry} onUpdateTags={(id, tagIds) => updateWorkspaceTask(id, {tagIds})} onCreateProject={createWorkspaceProject} activeTaskId={runningTaskId} timerDisabled={timerDisabled} onStart={id => void startTaskTimer(id)} onStop={() => void stopTimer(false)} />}</LiveClock> : displayedCalendarMode === 'month' ? (
            <section className="month-calendar-panel panel" aria-label={`${monthLabel}カレンダー`}>
              {renderCalendarStatus()}
              <div className="month-weekdays">{monthCalendarDates.slice(0, 7).map((date) => <span key={date}>{formatCalendarWeekday(date)}</span>)}</div>
              <div className="month-grid">
                {monthCalendarDates.map((date) => {
                  const inMonth = date.slice(0, 7) === displayedCalendarDate.slice(0, 7)
                  const daySchedules = weekSchedules.filter(({ schedule }) => schedule.date === date)
                  return (
                    <div role="button" tabIndex={0} key={date} data-date={date} className={`month-day ${inMonth ? '' : 'other-month'} ${date === today ? 'today' : ''} ${dropDate === date ? 'inbox-drop-over' : ''}`}
                      onKeyDown={event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); event.currentTarget.click() } }}
                      onDragOver={event => { if (!canDropInboxTask(event) && !getDraggedBlock(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = getDraggedBlock(event) ? 'move' : 'copy'; setDropDate(date) }}
                      onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropDate(null) }}
                      onDrop={event => { const block = getDraggedBlock(event); if (block) void dropBlock(event, date, block.type === 'TIMED' ? { type: 'TIMED', startTime: block.startTime.slice(0, 5) } : { type: block.type }); else void dropInboxTask(event, date) }}
                      onClick={event => { if (dragSource.current || (suppressBlockClick.current && event.detail > 0)) return; setCalendarDate(date); openCalendarCreate(date, 'TIME_UNSET') }}>
                      <span className="month-day-number">{Number(date.slice(8, 10))}</span>
                      {daySchedules.slice(0, 3).map(({ schedule, task }) => <span className="month-task-chip" key={schedule.id} data-schedule-block-id={schedule.id} data-task-id={task.id} data-schedule-type={schedule.type} data-date={schedule.date} style={getScheduleBlockStyle(projectColorById(task.projectId))}
                        draggable={!changingBlockIds.includes(schedule.id)} aria-busy={changingBlockIds.includes(schedule.id) || undefined} onDragStart={event => startBlockDrag(event, schedule)} onDragEnd={endCalendarDrag}
                        tabIndex={0} role="button" aria-label={`${task.title}の予定を開く`} aria-haspopup="dialog" aria-expanded={calendarDialog?.kind === 'block' && calendarDialog.block.id === schedule.id} aria-controls={calendarDialog?.kind === 'block' && calendarDialog.block.id === schedule.id ? 'schedule-detail' : undefined}
                        onClick={event => { event.stopPropagation(); openSchedule(schedule, task, event.currentTarget) }}
                        onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); openSchedule(schedule, task, event.currentTarget) } }}><strong>{task.title}</strong><TaskProjectLine project={projects.find(p => p.id === task.projectId) ?? (task.projectId === null ? undefined : { id: task.projectId })} name={task.projectName} hasTags={!!task.tags?.length} projectClassName="calendar-block-project" />{schedule.type === 'TIMED' && <span className="calendar-block-footer"><small className="schedule-block-duration">{formatDuration(schedule.durationMinutes)}</small></span>}<TaskTimerButton task={task} activeTaskId={runningTaskId} disabled={timerDisabled || changingBlockIds.includes(schedule.id)} onStart={() => void startTaskTimer(task.id)} floating /></span>)}
                      {daySchedules.length > 3 && <span className="month-overflow">+{daySchedules.length - 3}件</span>}
                    </div>
                  )
                })}
              </div>
            </section>
          ) : (
            <div className="home-calendar-layout">
              <section className={`week-calendar-panel panel ${displayedCalendarMode === 'day' ? 'single-day' : ''}`} aria-label={displayedCalendarMode === 'week' ? '週カレンダー' : '日カレンダー'}
                data-zoom-level={calendarZoom} style={{ '--calendar-hour-height': `${calendarScale.pixelsPerHour}px`, '--calendar-half-hour-height': `${calendarScale.minutesToPixels(30)}px`,
                  '--calendar-days': calendarDates.length, '--calendar-day-height': `${calendarScale.dayHeight}px`, '--calendar-view-height': `${createCalendarScale(DEFAULT_CALENDAR_ZOOM).dayHeight}px` } as CSSProperties}>
                {renderCalendarStatus()}
                <div className="calendar-grid-scroll"><div className="calendar-grid-content"><div className="calendar-week-header">
                  <div className="calendar-date-gutter">
                    {renderCalendarZoom()}
                    <span className="calendar-date-separator" role="separator" aria-orientation="vertical" />
                  </div>
                  {calendarDates.map((date) => <button type="button" key={date} className={date === today ? 'today' : ''} onClick={() => setCalendarDate(date)}><span>{formatCalendarWeekday(date)}</span><strong>{Number(date.slice(8, 10))}</strong></button>)}
                </div>
                <div className={`calendar-week-metrics ${displayedCalendarMode === 'day' ? 'home-day-metrics' : ''}`} aria-label="日別の計画済みと記録">
                  <span aria-hidden="true" />
                  {calendarDates.map(date => <div key={date} className={date === today ? 'today' : ''}>{renderCalendarMetrics(date, true)}</div>)}
                </div>
                <div className="calendar-combined-row calendar-time-unset-row calendar-all-day-row" data-expanded={dateOnlyExpanded}>
                  <div className="calendar-row-gutter"><button type="button" className="calendar-row-toggle" aria-expanded={dateOnlyExpanded}
                    aria-label={dateOnlyExpanded ? '日付のみの予定を折りたたむ' : '日付のみの予定を展開'}
                    onClick={() => setDateOnlyExpanded(value => !value)}><UiIcon name={dateOnlyExpanded ? 'chevronDown' : 'chevronRight'} /></button></div>{calendarDates.map(date => {
                  const items = weekSchedules.filter(({ schedule }) => schedule.date === date && schedule.type !== 'TIMED')
                  return <div key={date} data-drop-date={date} data-all-day-drop-date={date} tabIndex={0} role="group"
                    aria-label={`${date}の予定。Enterで予定を作成`}
                    className={`calendar-schedule-cell ${date === today ? 'today' : ''} ${unsetDropAvailable ? 'inbox-drop-available' : ''} ${dropDate === date ? 'inbox-drop-over' : ''}`}
                    onClick={event => { if (event.target === event.currentTarget || event.target instanceof Element && event.target.closest('.calendar-date-count')) openCalendarCreate(date, 'TIME_UNSET') }}
                    onKeyDown={event => { if (event.target === event.currentTarget && event.key === 'Enter') { event.preventDefault(); openCalendarCreate(date, 'TIME_UNSET') } }}
                    onDragOver={event => { if (!canDropUnsetSource(event)) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = dragSource.current?.type === 'SCHEDULE_BLOCK' ? 'move' : 'copy'; setDropDate(date); setTimedDropPreview(null) }}
                    onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropDate(null) }}
                    onDrop={event => { if (!canDropUnsetSource(event)) return; const source = getDraggedBlock(event); if (source) void dropBlock(event, date, { type: source.type === 'ALL_DAY' ? 'ALL_DAY' : 'TIME_UNSET' }); else void dropInboxTask(event, date) }}>
                    <dl className="calendar-date-count" data-count-date={date} aria-label={`${date}の日付のみの予定件数`}>
                      <dt className="visually-hidden">件数</dt>
                      <dd>{weekBlocks.filter(block => block.date === date && block.type !== 'TIMED').length}件</dd>
                    </dl>
                    {dateOnlyExpanded && items.map(item => <ScheduleChip key={item.schedule.id} {...item} project={projects.find(p => p.id === item.task.projectId)}
                      dragging={draggingBlockId === item.schedule.id} busy={changingBlockIds.includes(item.schedule.id)}
                      onSelect={anchor => openSchedule(item.schedule, item.task, anchor)}
                      expanded={calendarDialog?.kind === 'block' && calendarDialog.block.id === item.schedule.id}
                      activeTaskId={runningTaskId} timerDisabled={timerDisabled} onStart={() => void startTaskTimer(item.task.id)}
                      onDragStart={event => startBlockDrag(event, item.schedule)} onDragEnd={endCalendarDrag} />)}
                  </div>
                })}</div>
                <div className={`calendar-week-header calendar-lane-header ${displayedCalendarMode === 'week' ? 'week-lane-header' : ''} ${showCalendarActual ? '' : 'plan-only'}`}>
                  <span aria-hidden="true" />
                  {calendarDates.map(date => <div key={date}><span>計画済み</span>{showCalendarActual && <span>記録</span>}</div>)}
                </div>
                <div className="calendar-time-grid">
                  <div className="calendar-time-labels">{Array.from({ length: 24 }, (_, hour) => <span key={hour}>{String(hour).padStart(2, '0')}:00</span>)}</div>
                  <div className={`calendar-day-columns ${displayedCalendarMode === 'day' ? 'single-day' : ''}`}>
                    {calendarDates.map((date) => {
                      const weekPlanBlocks = makeScheduleTimelineBlocks(weekSchedules.map(item => resizePreview?.range === weekRange && resizePreview.blockId === item.schedule.id && item.schedule.type === 'TIMED'
                        ? { ...item, schedule: { ...item.schedule, durationMinutes: resizePreview.durationMinutes } } : item), date)
                      const planLanes = Math.max(1, ...weekPlanBlocks.map((block) => block.lane + 1))
                      return (
                        <div className={`calendar-day-column ${date === today ? 'today' : ''}`} key={date} data-calendar-date={date}>
                          <div className="calendar-plan-lane" aria-label={`${date}の予定。空白ClickまたはEnterで予定を作成`} style={{ width: showCalendarActual ? '50%' : '100%' }} data-timed-drop-date={date} tabIndex={0} role="group"
                          onPointerDown={event => beginCalendarSelection(event, date)} onPointerMove={updateCalendarSelection} onPointerUp={finishCalendarSelection}
                          onPointerCancel={cancelCalendarSelection} onLostPointerCapture={cancelCalendarSelection}
                          onClick={event => clickCalendarTime(event, date)}
                          onKeyDown={event => { if (event.target === event.currentTarget && event.key === 'Enter') { event.preventDefault(); openCalendarCreate(date, 'TIMED') } }}
                          onDragOver={(event) => {
                            if (!canDropTimedSource(event)) return
                            const position = getTimedDropPosition(event)
                            if (!position) { setTimedDropPreview(null); return }
                            event.preventDefault()
                            event.stopPropagation()
                            event.dataTransfer.dropEffect = dragSource.current?.type === 'SCHEDULE_BLOCK' ? 'move' : 'copy'
                            setDropDate(null)
                            setTimedDropPreview((current) => current?.date === date && current.minutes === position.minutes ? current : { date, ...position })
                          }}
                          onDragLeave={(event) => {
                            if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
                              setTimedDropPreview((current) => current?.date === date ? null : current)
                            }
                          }}
                          onDrop={(event) => {
                            if (!canDropTimedSource(event)) return
                            const position = getTimedDropPosition(event)
                            if (!position) return
                            if (dragSource.current?.type === 'SCHEDULE_BLOCK') void dropBlock(event, date, { type: 'TIMED', startTime: position.startTime })
                            else void dropInboxTask(event, date, { type: 'TIMED', startTime: position.startTime })
                          }}>
                          {timedDropPreview?.date === date && <div className="calendar-timed-drop-preview" style={{ top: `${calendarScale.minutesToPixels(timedDropPreview.minutes)}px` }}><span>{timedDropPreview.startTime}</span></div>}
                          {creationPreview?.date === date && <div className="calendar-create-preview" role="status" style={{ top: `${calendarScale.minutesToPixels(creationPreview.start)}px`, height: `${calendarScale.minutesToPixels(creationPreview.end - creationPreview.start)}px` }}>
                            <span className="calendar-create-preview-label">{formatAxisTime(creationPreview.start)} – {formatAxisTime(creationPreview.end)}</span></div>}
                          {weekPlanBlocks.map(({ schedule: displaySchedule, task, startMinutes, endMinutes, lane, overlaps }) => {
                            const schedule = weekSchedules.find(item => item.schedule.id === displaySchedule.id)!.schedule as Extract<ScheduleBlock, { type: 'TIMED' }>
                            const resizing = resizePreview?.range === weekRange && resizePreview.blockId === schedule.id
                            const duration = endMinutes - startMinutes
                            const busy = changingBlockIds.includes(schedule.id)
                            return (
                              <article key={`schedule-${schedule.id}`} className={`calendar-event planned weekly-schedule-event ${calendarScale.minutesToPixels(duration) < 40 ? 'calendar-event-compact' : ''} ${draggingBlockId === schedule.id ? 'schedule-block-dragging' : ''} ${resizing ? 'schedule-block-resizing' : ''} ${overlaps ? 'has-schedule-overlap' : ''}`} data-schedule-block-id={schedule.id} data-schedule-type={schedule.type} data-task-id={task.id} data-date={date} title={`${task.title} · ${formatAxisTime(startMinutes)}–${formatAxisTime(endMinutes)} · ${formatDuration(duration)}${overlaps ? ' · この予定の長さが重複しています' : ''}`} style={{ top: `${calendarScale.minutesToPixels(startMinutes)}px`, height: `${calendarScale.minutesToPixels(duration)}px`, left: `${lane * (100 / planLanes)}%`, width: `${100 / planLanes}%`, ...getScheduleBlockStyle(projectColorById(task.projectId)) }}
                                draggable={!busy && !resizing} aria-busy={busy} onDragStart={(event) => startBlockDrag(event, schedule)} onDragEnd={endCalendarDrag}
                                data-density={calendarScale.minutesToPixels(duration) >= 72 ? 'full' : calendarScale.minutesToPixels(duration) >= 44 ? 'medium' : 'short'}
                                tabIndex={0} role="button" aria-label={`${task.title}の予定を開く`} aria-haspopup="dialog" aria-expanded={calendarDialog?.kind === 'block' && calendarDialog.block.id === schedule.id} aria-controls={calendarDialog?.kind === 'block' && calendarDialog.block.id === schedule.id ? 'schedule-detail' : undefined}
                                onClick={event => { event.stopPropagation(); if (!resizing) openSchedule(schedule, task, event.currentTarget) }}
                                onKeyDown={event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); event.stopPropagation(); openSchedule(schedule, task, event.currentTarget) } }}>
                                <strong>{task.title}</strong>
                                <TaskProjectLine project={projects.find(p => p.id === task.projectId) ?? (task.projectId === null ? undefined : { id: task.projectId })} name={task.projectName} hasTags={!!task.tags?.length} projectClassName="schedule-block-project calendar-block-project" />
                                <span className="calendar-block-footer"><small className="schedule-block-duration">{formatDuration(duration)}</small></span>
                                {overlaps && <span className="schedule-overlap-warning" aria-label="この予定の長さが重複しています">⚠ 重複</span>}
                                {resizing && <span className="schedule-resize-preview" role="status">{formatEndTime(schedule.startTime, duration)} · {formatDuration(duration)}</span>}
                                <TaskTimerButton task={task} activeTaskId={runningTaskId} disabled={timerDisabled || busy || resizing} onStart={() => void startTaskTimer(task.id)} floating />
                                {displayedCalendarMode === 'week' && scheduleSegmentsForDay([displaySchedule], shiftDate(date, 1)).length === 0 && <button type="button" className="schedule-resize-handle" aria-label={`${task.title}のこの予定の長さを変更`} title="下端をドラッグしてこの予定の長さを変更（15分単位）" disabled={busy} draggable={false}
                                  onDragStart={(event) => { event.preventDefault(); event.stopPropagation() }}
                                  onPointerDown={(event) => startResize(event, schedule)} onPointerMove={updateResize} onPointerUp={finishResize}
                                  onPointerCancel={cancelResize} onLostPointerCapture={cancelResize} onClick={event => event.stopPropagation()} />}
                              </article>
                            )
                          })}
                          </div>
                          {showCalendarActual && <LiveClock active={calendarEntries.some(entry => entry.endedAt === null)}>{now => <div className="calendar-actual-lane" data-actual-date={date} aria-label={`${date}の記録。空白ClickまたはEnterで記録を追加`} role="group" tabIndex={0}
                            onPointerDown={event => beginActualSelection(event, date)} onPointerMove={updateActualSelection} onPointerUp={finishActualSelection}
                            onPointerCancel={cancelActualSelection} onLostPointerCapture={cancelActualSelection} onClick={event => clickActualTime(event, date)}
                            onKeyDown={event => { if (event.target === event.currentTarget && event.key === 'Enter') { event.preventDefault(); openActualCreate(date, 540) } }}>
                            {actualPreview?.date === date && <div className="calendar-create-preview actual-create-preview" role="status" style={{ top: `${calendarScale.minutesToPixels(actualPreview.start)}px`, height: `${calendarScale.minutesToPixels(actualPreview.end - actualPreview.start)}px` }}>
                              <span className="calendar-create-preview-label">記録 {formatAxisTime(actualPreview.start)} – {formatAxisTime(actualPreview.end)}</span></div>}
                            {getActualSegmentsForDay(date, now).map(segment => {
                              const snapshotName = segment.entry.projectIdSnapshot === null ? '未所属'
                                : projects.find(project => project.id === segment.entry.projectIdSnapshot)?.name ?? `プロジェクト #${segment.entry.projectIdSnapshot}`
                              const range = `${formatAxisTime(segment.startMinutes)}–${formatAxisTime(segment.endMinutes)}`
                              const active = segment.entry.endedAt === null
                              return <article key={`actual-${segment.entry.id}-${date}`} className={`calendar-event actual ${Math.max(20, calendarScale.minutesToPixels(segment.endMinutes - segment.startMinutes)) < 40 ? 'calendar-event-compact' : ''} ${active ? 'active-entry' : ''}`} draggable={false}
                                data-density={calendarScale.minutesToPixels(segment.endMinutes - segment.startMinutes) >= 72 ? 'full' : calendarScale.minutesToPixels(segment.endMinutes - segment.startMinutes) >= 44 ? 'medium' : 'short'}
                                data-time-entry-id={segment.entry.id} data-task-id={segment.entry.taskId} data-date={date}
                                title={`${segment.task.title} · ${range} · ${snapshotName} · ${active ? '計測中' : '記録'}`}
                                style={{ top: `${calendarScale.minutesToPixels(segment.startMinutes)}px`, height: `${Math.max(20, calendarScale.minutesToPixels(segment.endMinutes - segment.startMinutes))}px`, ...getScheduleBlockStyle(projectColorById(segment.entry.projectIdSnapshot)) }}
                                tabIndex={0} role="button" aria-label={`${segment.task.title}の記録を開く`} aria-haspopup="dialog" aria-expanded={actualDialog?.kind === 'entry' && actualDialog.entry.id === segment.entry.id} aria-controls={actualDialog?.kind === 'entry' && actualDialog.entry.id === segment.entry.id ? 'actual-detail' : undefined}
                                onPointerDown={beginActualBlockPointer} onPointerMove={updateActualBlockPointer} onPointerUp={finishActualBlockPointer} onPointerCancel={finishActualBlockPointer}
                                onDragStart={event => { event.preventDefault(); event.stopPropagation(); actualBlockClickUntil.current = performance.now() + 300 }}
                                onClick={event => { event.stopPropagation(); if (event.detail === 0 || performance.now() >= actualBlockClickUntil.current) openActualEntry(segment.entry, event.currentTarget) }}
                                onKeyDown={event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); event.stopPropagation(); openActualEntry(segment.entry, event.currentTarget) } }}>
                                <strong>{segment.task.title}</strong><TaskProjectLine project={projects.find(p => p.id === segment.entry.projectIdSnapshot) ?? (segment.entry.projectIdSnapshot === null ? undefined : { id: segment.entry.projectIdSnapshot })} name={segment.entry.projectIdSnapshot !== null ? snapshotName : null} hasTags={!!segment.task.tags?.length} projectClassName="actual-block-project calendar-block-project" />
                                <span className="calendar-block-footer"><small className="actual-block-duration">{formatDuration(Math.floor(segment.endMinutes - segment.startMinutes))}{active && ' · 計測中'}</small></span>
                                <TaskTimerButton task={segment.task} activeTaskId={runningTaskId} disabled={timerDisabled} onStart={() => void startTaskTimer(segment.task.id)} floating restart={!active} />
                              </article>
                            })}
                          </div>}</LiveClock>}
                          {date === calendarClock.date && <div className="calendar-current-time" data-current-date={date} data-current-minute={calendarClock.minutes} aria-hidden="true"
                            style={{ top: `${calendarScale.minutesToPixels(calendarClock.minutes)}px` }} />}
                        </div>
                      )
                    })}
                  </div>
                </div>
                </div></div>
              </section>

            </div>
          )}
        </section>
      </div>}

      {view === 'tasks' && taskSection === 'list' && <TaskList tasks={tasks} projects={projects}
        refresh={weeklyScheduleRefresh + calendarRefresh} projectFilter={projectFilter} onProjectFilter={setProjectFilter}
        onCreate={() => createTask()} renderTask={task => <TaskRow key={task.id} task={task}
          error={taskActionError?.id === task.id ? taskActionError.message : undefined} runningTaskId={runningTaskId}
          timerDisabled={timerDisabled} projects={projects} onUpdate={updateWorkspaceTask} onCreateProject={createWorkspaceProject} onEdit={editTask}
          onDelete={target => void deleteTask(target)} onStart={taskId => void startTaskTimer(taskId)} onStop={() => void stopTimer(false)} />} />}

      {view === 'tasks' && taskSection === 'projects' && <ProjectList projects={projects} onCreate={() => openProjectForm()}
        onOpen={id => { setSelectedProjectId(id); setTaskSection('projectDetail') }} onEdit={openProjectForm}
        onDelete={project => void deleteProject(project)} deletingIds={deletingProjectIds} actionError={projectActionError} />}

      {view === 'tasks' && taskSection === 'projectDetail' && selectedProject && <ProjectDetail key={selectedProject.id}
        project={selectedProject} projects={projects} tasks={tasks} refresh={weeklyScheduleRefresh + calendarRefresh}
        onCreate={() => createTask(selectedProject.id)} onBack={() => setTaskSection('projects')} onEdit={openProjectForm}
        onDelete={project => void deleteProject(project)} deletingIds={deletingProjectIds} actionError={projectActionError}
        onRename={renameWorkspaceProject} entries={calendarEntries} entriesStatus={calendarEntriesStatus} onRetryEntries={() => void fetchCalendarEntries(tasks)}
        onSaveEntry={saveInlineEntry} onDeleteEntry={deleteManualEntry} onUpdateTags={(id, tagIds) => updateWorkspaceTask(id, {tagIds})} onCreateProject={createWorkspaceProject} activeTaskId={runningTaskId} timerDisabled={timerDisabled} onStart={id => void startTaskTimer(id)} onStop={() => void stopTimer(false)} now={timer.now}
        renderTask={task => <TaskRow key={task.id} task={task} hideProject presentation="regular"
          error={taskActionError?.id === task.id ? taskActionError.message : undefined} runningTaskId={runningTaskId}
          timerDisabled={timerDisabled} projects={projects} onUpdate={updateWorkspaceTask} onCreateProject={createWorkspaceProject} onEdit={editTask}
          onDelete={target => void deleteTask(target)} onStart={taskId => void startTaskTimer(taskId)} onStop={() => void stopTimer(false)} />} />}

      {view === 'reports' && <div className="reports-v2" aria-busy={displayedReport?.key !== reportKey || (!reportDemo && calendarEntriesStatus === 'loading')}>
        {reportDemo && <small className="unset-value" data-report-demo>DEMO</small>}
        <section className="panel report-toolbar">
          <div className="report-mode" role="group" aria-label="レポート期間">{(['day', 'week', 'month', 'range'] as const).map(mode => <button key={mode} type="button" className={displayedReportSelectionMode === mode ? 'active' : ''} aria-pressed={displayedReportSelectionMode === mode} onClick={() => selectReportMode(mode)}>{mode === 'day' ? '日' : mode === 'week' ? '週' : mode === 'month' ? '月' : '期間'}</button>)}</div>
          <div className="report-period-controls">
            <div className="report-period-navigation">
              <button type="button" className="period-arrow" aria-label="前の期間" onClick={() => shiftReportPeriod(-1)}>‹</button>
              <button type="button" className="report-period-label" aria-label="表示期間を選択" aria-haspopup="dialog" aria-expanded={reportPickerAnchor !== null} onClick={event => setReportPickerAnchor(event.currentTarget)}><strong>{reportRangeLabel}</strong></button>
              <button type="button" className="period-arrow" aria-label="次の期間" onClick={() => shiftReportPeriod(1)}>›</button>
            </div>
            {displayedReportRange ? <button type="button" className="secondary-button" onClick={clearReportRange}>範囲指定を解除</button>
              : <button type="button" className="secondary-button" onClick={() => setReportDate(getLocalDate())}>{displayedReportMode === 'month' ? '今月' : displayedReportMode === 'week' ? '今週' : '今日'}</button>}
          </div>
        <ReportsFilters projects={displayedReport?.projects ?? reportProjects} tags={reportDemo?.tags ?? tagStore.tags} filters={reportFilters} onChange={setReportFilters} />
        </section>
        <div className="project-tabs report-tabs" role="tablist" aria-label="レポート内容">{(['analysis', 'activity'] as const).map(tab => <button key={tab} type="button" role="tab" id={`report-tab-${tab}`} aria-controls="report-tab-content" aria-selected={reportTab === tab} onClick={() => setReportTab(tab)}>{tab === 'analysis' ? '分析' : '活動ログ'}</button>)}</div>
        {!reportDemo && ((reportSchedules?.key === reportKey && reportSchedules.error) || calendarEntriesStatus === 'error')
          ? <p className="error" role="alert">{reportSchedules?.error ?? '記録を取得できませんでした'} <button type="button" onClick={() => { setReportRefresh(value => value + 1); void fetchCalendarEntries(tasks) }}>再取得</button></p> : null}
        <div id="report-tab-content" role="tabpanel" aria-labelledby={`report-tab-${reportTab}`}>
        {!reportReady ? <p className="empty-state" role="status">対象期間の集計を読み込んでいます</p> : <>
          {reportTab === 'analysis' && <>
          <section className="summary-grid report-summary" aria-label="期間集計">
            <div className="summary-item report-summary-plan"><span>計画済み</span><strong>{formatDuration(reportData.plannedMinutes)}</strong><small>カレンダーで確保した時間（重複を除く）</small></div>
            <div className="summary-item report-summary-actual"><span><UiIcon name="clock" />記録</span><strong>{formatDuration(reportData.actualMinutes)}</strong><small>計測した実績時間（計測中を含む）</small></div>
            <div className={`summary-item report-summary-difference difference-${reportDifference(reportData.plannedMinutes, reportData.actualMinutes).tone}`}><span>計画差</span><strong>{reportDifference(reportData.plannedMinutes, reportData.actualMinutes).displayText}</strong><small>計画と記録の差</small></div>
          </section>
          <section className="panel period-chart-panel">
            <div className="section-heading"><h2>{reportSingleDayChart ? '時間帯別' : '日別'}の計画済みと記録</h2><div className="chart-legend"><span><i className="legend-swatch estimated" />計画済み</span><span><i className="legend-swatch actual" />記録</span></div></div>
            {reportData.daily.every(day => day.planIntervals.length === 0 && day.actualIntervals.length === 0) ? <p className="empty-state">対象期間の記録はありません</p>
              : reportSingleDayChart ? <ReportHourChart buckets={reportHours} /> : <div className="report-chart-scroll"><div className={`report-daily-chart ${displayedReportSelectionMode === 'month' ? 'monthly' : 'weekly'}`} style={{ minWidth: `${64 + reportData.daily.length * (displayedReportSelectionMode === 'month' ? 32 : 88)}px` }}>
                <div className="report-y-axis" aria-label="時間軸">{reportAxis.ticks.map(tick => <span key={tick} style={{ bottom: `${tick / reportAxis.maximum * 100}%` }}>{formatDuration(tick)}</span>)}</div>
                <div className="period-chart" role="group" aria-label="日別集計">
                  <div className="report-chart-grid" aria-hidden="true">{reportAxis.ticks.map(tick => <span key={tick} style={{ bottom: `${tick / reportAxis.maximum * 100}%` }} />)}</div>
                  {reportData.daily.map((day, index) => {
                    const dateLabel = `${formatShortDate(day.date)}(${formatCalendarWeekday(day.date)})`
                    const monthLabelVisible = index === 0 || index === reportData.daily.length - 1 || Number(day.date.slice(8)) % 5 === 0
                    const tooltip = `${dateLabel}\n計画済み ${formatDuration(day.plannedMinutes)}\n記録 ${formatDuration(day.actualMinutes)}\n差 ${reportDifference(day.plannedMinutes, day.actualMinutes).displayText}`
                    return <div className="period-chart-column" key={day.date} data-chart-date={day.date} aria-label={tooltip}>
                      <ReportBarTooltip title={tooltip} planned={day.plannedMinutes / reportAxis.maximum * 100} actual={day.actualMinutes / reportAxis.maximum * 100} />
                      <span className="period-chart-label">{displayedReportSelectionMode === 'month' ? monthLabelVisible ? Number(day.date.slice(8)) : '' : dateLabel}</span>
                    </div>
                  })}
                </div>
              </div></div>}

          </section>
          {displayedReportSelectionMode === 'week' && <div className="report-week-breakdown"><section className="panel weekly-breakdown-panel"><h2>日別の内訳</h2><div className="weekly-breakdown-scroll"><table className="weekly-breakdown-table" data-report-table="days"><thead><tr><th>日付</th><th>計画済み</th><th>記録</th><th>差</th></tr></thead><tbody>{reportData.daily.map(day => <tr key={day.date} data-report-date={day.date}><th scope="row">{formatCalendarDate(day.date)}</th><td>{formatDuration(day.plannedMinutes)}</td><td>{formatDuration(day.actualMinutes)}</td><td className={`difference-${reportDifference(day.plannedMinutes, day.actualMinutes).tone}`}>{reportDifference(day.plannedMinutes, day.actualMinutes).displayText}</td></tr>)}</tbody></table></div></section><ReportTaskTable title="タスク別Top10" rows={reportData.topTasks} total={reportData.actualMinutes} /></div>}
          {(displayedReportSelectionMode === 'day' || displayedReportSelectionMode === 'range') && <ReportTaskTable title={displayedReportSelectionMode === 'day' ? 'タスク別' : 'タスク別Top10'} rows={displayedReportSelectionMode === 'day' ? reportData.taskRows : reportData.topTasks} total={reportData.actualMinutes} />}
          <ReportProjectBreakdown rows={reportData.projectRows} total={reportData.actualMinutes} projects={displayedReport?.projects ?? projects} />
          {displayedReportSelectionMode === 'month' && <ReportTaskTable title="タスク別Top10" rows={reportData.topTasks} total={reportData.actualMinutes} />}
          </>}
          {reportTab === 'activity' && <ReportActivityLog rows={reportActivity} tasks={displayedReport?.tasks ?? tasks} projects={displayedReport?.projects ?? projects}
            disabled={Boolean(reportDemo)} onCreateProject={createWorkspaceProject} onUpdateTags={async (id, tagIds) => { if (reportDemo) throw new Error("Demo editing disabled"); await updateWorkspaceTask(id,{tagIds}) }} onSave={async (input, id) => { if (reportDemo) throw new Error('Demoの記録は編集できません'); await saveInlineEntry(input,id) }}
            onDelete={async id => { if (reportDemo) throw new Error('Demoの記録は削除できません'); await deleteManualEntry(id) }}
            now={reportNow} activeTaskId={runningTaskId} timerDisabled={timerDisabled || Boolean(reportDemo)} onStart={id => { if (!reportDemo) void startTaskTimer(id) }} onStop={() => { if (!reportDemo) void stopTimer(false) }} />}
        </>}
        </div>
        {reportPickerAnchor && <CalendarNavigationPicker mode={displayedReportMode} selectedDate={displayedReportDate} today={getLocalDate()} anchor={reportPickerAnchor}
          selectByDate
          range={displayedReportRange ?? undefined}
          onSelect={date => { setReportRange(null); setReportDate(date) }}
          onSelectRange={displayedReportRange ? range => { setReportRange(range); setReportDate(range.start) } : undefined} onClose={() => setReportPickerAnchor(null)} />}
      </div>}

      {calendarDialog && <CalendarDialog api={API} refresh={reportRefresh} anchor={calendarAnchor} selection={calendarDialog.kind === 'block' ? { ...calendarDialog, task: tasksById.get(calendarDialog.task.id) ?? calendarDialog.task } : calendarDialog} projects={projects} activeTaskId={runningTaskId}
        scheduleBusy={calendarDialog.kind === 'block' && changingBlockIds.includes(calendarDialog.block.id)}
        timerUnavailable={timerDisabled} onClose={() => setCalendarDialog(null)} onCreateTask={createWorkspaceTask} onCreateBlock={createCalendarBlock}
        onCreateProject={createWorkspaceProject}
        onTaskUpdate={updateWorkspaceTask} onOpenTaskEditor={taskId => { const task = tasksById.get(taskId); if (task) editTask(task, calendarDialog.kind === 'block' ? calendarDialog.block : undefined, calendarAnchor) }}
        onEdit={editCalendarPlacement}
        onRelease={async blockId => { if (!await releaseBlock(blockId)) throw new Error('予定を解除できませんでした。再度お試しください。') }}
        onStart={async taskId => {
          if (runningTaskId === taskId) return
          if (runningTaskId !== null) throw new Error('別のタスクを計測中です。HeaderのTimerで終了してから開始してください。')
          if (!await startTimer(taskId)) throw new Error('計測を開始できませんでした。完了状態や別のタスクの計測を確認してください。')
        }}
        readBlocks={readCalendarDayBlocks} />}
      {taskComposerOpen && <TaskEditorPanel estimateSaveMode={view === 'home' ? 'draft' : 'immediate'} timeInputMode={view === 'home' ? 'text' : 'native'} compactTimeHistory={view === 'home'} scheduleDraft={editorScheduleDraft} onScheduleChange={setEditorScheduleDraft} focusAnchor={editorAnchor}
        onDelete={async () => { const target = tasks.find(task => task.id === editingId); if (!target) return false; if (!await deleteTask(target, setTaskFormError)) return false; setTaskComposerOpen(false); setEditingId(null); return true }} editing={editingId !== null} taskTimes={tasks.find(task => task.id === editingId)} api={API} taskId={editingId} refresh={reportRefresh} timerDisabled={timerDisabled}
        running={editingId !== null && runningTaskId === editingId} completed={tasks.find(task => task.id === editingId)?.completed ?? false}
        onStart={() => editingId === null ? Promise.resolve(false) : startTaskTimer(editingId)} value={form} projects={projects} selectedTags={tasks.find(task => task.id === editingId)?.tags} error={taskFormError}
        onEstimateUpdate={editingId === null ? undefined : minutes => updateWorkspaceTask(editingId, {estimatedMinutes: minutes})}
        timeEditing={editingId === null ? undefined : {
          renderEntry: entry => <TimeEntryLogRow key={entry.id} entry={entry} tasks={tasks} projects={projects} now={Date.now()} lockTask showTimer={false} compact={view === 'home'}
            onSave={saveInlineEntry} onDelete={deleteManualEntry} onUpdateTags={async (id, tagIds) => { await updateWorkspaceTask(id, {tagIds}); setForm(current => ({...current, tagIds})) }} onCreateProject={createWorkspaceProject}
            activeTaskId={runningTaskId} timerDisabled={timerDisabled} onStart={id => void startTaskTimer(id)} onStop={() => void stopTimer(false)} />,
          renderBlock: block => { const task = tasks.find(task => task.id === editingId); return task ? <CalendarDialog key={block.id} inlineSchedule compactInline={view === 'home'} api={API} refresh={reportRefresh}
            selection={{kind: 'block', block, task}} anchor={null} projects={projects} activeTaskId={runningTaskId} timerUnavailable={timerDisabled} scheduleBusy={changingBlockIds.includes(block.id)}
            onCreateProject={createWorkspaceProject} onCreateTask={createWorkspaceTask} onCreateBlock={createCalendarBlock} onTaskUpdate={updateWorkspaceTask} onEdit={editCalendarPlacement}
            onRelease={async id => { if (!await releaseBlock(id, block)) throw new Error('予定を解除できませんでした。再度お試しください。') }}
            onStart={async () => {}} readBlocks={readCalendarDayBlocks} onOpenTaskEditor={() => {}} onClose={() => {}} /> : null },
        }}
        onChange={setForm} onSave={saveTask} onCreateProject={createWorkspaceProject}
        onClose={() => { createdEditorTask.current = null; setTaskComposerOpen(false); setEditingId(null); setForm(emptyTask); setTaskFormError('') }} />}

      {projectComposerOpen && <ProjectComposer editing={editingProjectId !== null} name={projectName} error={projectFormError}
        color={projectColor === undefined ? projects.find(project => project.id === editingProjectId)?.color ?? null : projectColor}
        entityId={editingProjectId ?? undefined} onColorChange={setProjectColor}
        onChange={setProjectName} onSave={saveProject}
        onClose={() => { setProjectComposerOpen(false); setEditingProjectId(null); setProjectName(''); setProjectFormError('') }} />}

      {actualDialog && <LiveClock active={actualDialog.kind === 'entry' && actualDialog.entry.endedAt === null}>{now => <TimeEntryDialog anchor={actualAnchor} projects={projects} now={now}
        timerAvailable={!timerDisabled && actualDialog.kind === 'entry' && runningTaskId === actualDialog.entry.taskId && Date.parse(timer.active?.startedAt ?? '') === Date.parse(actualDialog.entry.startedAt)}
        onPause={async () => { if (!await stopTimer(true)) throw new Error('一時停止できませんでした。計測状態を確認して再試行してください。') }}
        onStop={async () => { if (!await stopTimer(false)) throw new Error('終了できませんでした。計測状態を確認して再試行してください。') }}
        selection={actualDialog.kind === 'entry' ? { kind: 'entry', entry: calendarEntries.find(entry => entry.id === actualDialog.entry.id) ?? actualDialog.entry } : actualDialog}
        tasks={tasks} onSave={saveManualEntry} onDelete={deleteManualEntry} onClose={() => setActualDialog(null)} />}</LiveClock>}

      {timerDetailsOpen && <div className="modal-backdrop timer-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setTimerDetailsOpen(false) }}>
        <section className="timer-modal" role="dialog" aria-modal="true" aria-labelledby="timerModalTitle">
          <header className="composer-head"><div><p className="eyebrow">{runningTask ? '計測中' : pausedTaskId !== null ? '一時停止中' : '作業タイマー'}</p><h2 id="timerModalTitle">作業タイマー</h2></div><button type="button" className="icon-close" aria-label="閉じる" onClick={() => setTimerDetailsOpen(false)}>×</button></header>
          <section className="timer-focus-card">
            {runningTask || pausedTaskId !== null ? <>
              <small>{(runningTask ?? tasks.find((task) => task.id === pausedTaskId))?.projectName ?? '未所属'}</small>
              <h3>{(runningTask ?? tasks.find((task) => task.id === pausedTaskId))?.title}</h3>
              <div className="timer-readout"><TimerElapsed active={timer.active} pausedSeconds={timer.pausedElapsedSeconds} offsetSeconds={timer.elapsedOffsetSeconds} /></div>
              <div className="timer-controls">
                {runningTask ? <><button type="button" className="timer-text-action" data-timer-state={timer.pendingOperation ? 'pending' : 'active'} aria-busy={!!timer.pendingOperation} disabled={timerDisabled} onClick={() => void stopTimer(true)}>{timer.pendingOperation && <TimerActionIcon pending />}一時停止</button><button type="button" className="timer-stop timer-text-action" data-timer-state={timer.pendingOperation ? 'pending' : 'active'} aria-busy={!!timer.pendingOperation} disabled={timerDisabled} onClick={() => void stopTimer(false)}>{timer.pendingOperation && <TimerActionIcon pending />}終了して保存</button></> : <><button type="button" className="timer-text-action" data-timer-state={timer.pendingOperation ? 'pending' : 'default'} aria-busy={!!timer.pendingOperation} disabled={timerDisabled} onClick={() => { if (pausedTaskId !== null) void startTimer(pausedTaskId) }}>{timer.pendingOperation && <TimerActionIcon pending />}再開</button><button type="button" className="secondary-button timer-text-action" onClick={finishPausedTimer}>終了</button></>}
              </div>
            </> : <>
              <label>計測するタスク<select value={timerTaskChoice} onChange={(event) => setTimerTaskChoice(event.target.value)}><option value="">タスクを選択</option>{tasks.filter((task) => !task.completed && task.status !== 'COMPLETED').map((task) => <option key={task.id} value={task.id}>{task.title} · {task.projectName ?? '未所属'}</option>)}</select></label>
              {selectedTimerTask && <><h3>{selectedTimerTask.title}</h3><TaskComparison task={selectedTimerTask} /></>}
              <button type="button" className="primary-action timer-text-action" data-timer-state={timer.pendingOperation ? 'pending' : 'default'} aria-busy={!!timer.pendingOperation} disabled={timerDisabled || !timerTaskChoice} onClick={() => void startTimer(Number(timerTaskChoice))}>{timer.pendingOperation && <TimerActionIcon pending />}計測開始</button>
            </>}
          </section>
          <section className="timer-history-panel"><div className="section-heading"><h2>計測履歴</h2><span>{visibleTimeEntries.length}件</span></div>{visibleTimeEntries.length === 0 ? <p className="empty-state">保存された計測履歴はありません</p> : <ul className="history-list">{visibleTimeEntries.map((entry) => <li key={entry.id}><span>{formatEntryDate(entry.startedAt)}</span><span>終了 {formatEntryDate(entry.endedAt, true)}</span><strong>{formatEntryDuration(entry)}</strong></li>)}</ul>}</section>
        </section>
      </div>}
      </main>
      <nav className="mobile-nav" aria-label="メインメニュー">
        <button type="button" className={view === 'home' ? 'active' : ''} onClick={() => setView('home')}><UiIcon name="calendar" />ホーム</button>
        <button type="button" className={view === 'tasks' && taskSection === 'list' ? 'active' : ''} onClick={() => { setView('tasks'); setTaskSection('list') }}><UiIcon name="task" />タスク</button>
        <button type="button" className={view === 'tasks' && taskSection !== 'list' ? 'active' : ''} onClick={() => { setView('tasks'); setTaskSection('projects') }}><ProjectIcon />プロジェクト</button>
        <button type="button" className={view === 'reports' ? 'active' : ''} onClick={() => setView('reports')}><UiIcon name="reports" />レポート</button>
      </nav>
    </AppShell></TagContext.Provider></TimerUiContext.Provider>
  )
}

export default Workspace
