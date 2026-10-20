import { dismissPopupOnEscape, focusPopupControl, listenOutsidePopup, movePopupFocus, usePopupFocusReturn } from './popupInteraction'
import { positionPopup } from './popupPosition'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ProjectComposer } from './ProjectComposer'
import { ProjectIcon, UiIcon } from './UiIcon'
import { getProjectColor } from './identificationColors'
import { PickerOption } from './PickerOption'

export type ProjectChoice = { id: number; name: string; color?: string | null }
type Props = {
  onCancel?: () => void
  allowCreate?: boolean
  projects: ProjectChoice[]
  projectId: number | null
  disabled?: boolean
  iconOnly?: boolean
  showSelection?: boolean
  cell?: boolean
  iconTone?: 'colored' | 'neutral'
  colorSelection?: boolean
  coloredOptions?: boolean
  label?: string
  name?: string
  onChange: (id: number | null) => void | Promise<void>
  onCreateProject: (name: string, color?: string | null) => Promise<ProjectChoice>
  onInteractionChange?: (active: boolean) => void
  emptyLabel?: string
  variant?: 'table' | 'editor'
}

export function ProjectPicker({ projects, projectId, disabled = false, iconOnly = false, showSelection = false, cell = false, iconTone = 'colored', colorSelection = false, coloredOptions = false, label = 'プロジェクトを選択', name = 'projectId', onChange, onCreateProject, onInteractionChange, emptyLabel = '未所属', allowCreate = true, onCancel, variant }: Props) {
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [projectName, setProjectName] = useState('')
  const [projectColor, setProjectColor] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [position, setPosition] = useState({ left: 8, top: 8 })
  const container = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const pending = useRef(false)
  const restoreFocus = useRef(false)
  const { capture: captureFocus, restore: focusBack } = usePopupFocusReturn(container)
  const id = useId()
  const selectedProject = projects.find(project => project.id === projectId)
  const selected = selectedProject?.name ?? emptyLabel
  useLayoutEffect(() => {
    if (!busy && !open && restoreFocus.current) { restoreFocus.current = false; focusBack() }
  }, [busy, open, focusBack])
  useLayoutEffect(() => {
    if (!open) return
    captureFocus(trigger.current)
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect(), box = popup.current?.getBoundingClientRect()
      if (!anchor || !box) return
      setPosition(positionPopup(anchor, box, { width: document.documentElement.clientWidth, height: innerHeight }))
    }
    place()
    focusPopupControl(popup.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"],button[aria-checked="true"]'), { preventScroll: false })
    const observer = new ResizeObserver(place)
    if (popup.current) observer.observe(popup.current)
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open, projects.length, error, captureFocus])
  useEffect(() => {
    if (!open) return
    return listenOutsidePopup(() => [container.current, popup.current], () => { if (!pending.current) setOpen(false) }, ['pointerdown', 'click'])
  }, [open])
  const choose = async (value: number | null) => {
    if (pending.current || disabled) return
    pending.current = true; setBusy(true); setError('')
    try { await onChange(value); restoreFocus.current = true; setOpen(false) }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'プロジェクトを変更できませんでした') }
    finally { pending.current = false; setBusy(false) }
  }
  const closeCreation = () => { setCreating(false); setProjectName(''); setProjectColor(null); setError(''); onInteractionChange?.(false); queueMicrotask(() => focusBack()) }
  const create = async () => {
    if (pending.current) return false
    if (!projectName.trim()) { setError('プロジェクト名を入力してください'); return false }
    pending.current = true; setError('')
    try {
      const project = await onCreateProject(projectName.trim(), projectColor ?? undefined)
      // Close the creation dialog before applying a Task edit, which can reorder rows.
      closeCreation()
      try { await onChange(project.id) }
      catch (failure) { setOpen(true); throw failure }
      return true
    } catch (failure) {
      setError(failure instanceof TypeError ? 'サーバーに接続できませんでした' : failure instanceof Error ? failure.message : 'プロジェクトを作成できませんでした')
      return false
    } finally { pending.current = false }
  }
  return <div ref={container} className={`project-picker ${iconOnly ? 'timer-project-picker' : ''}`} onKeyDown={event => {
    if (open && !pending.current && dismissPopupOnEscape(event, () => { setOpen(false); focusBack(); onCancel?.() })) return
    if (open && movePopupFocus(popup.current, event.key, 'button:not(:disabled)')) event.preventDefault()
  }}>
    <input type="hidden" name={name} value={projectId ?? ''} />
    <button ref={trigger} type="button" className={iconOnly ? `secondary-button timer-project-trigger ${projectId === null ? '' : 'assigned'}` : 'project-picker-trigger'}
      aria-label={`${label}：${selected}`} title={selected} aria-haspopup={variant ? 'menu' : 'dialog'} aria-expanded={open} aria-controls={open ? id : undefined}
      disabled={disabled || busy} onClick={() => { setError(''); setOpen(value => !value) }}>
      <ProjectIcon project={selectedProject} tone={iconTone} />{iconOnly && showSelection && <span className={`timer-selection-label ${selectedProject ? '' : 'timer-selection-empty'}`}>{selectedProject ? selected : 'プロジェクトなし'}</span>}{!iconOnly && <><span className={projectId === null ? 'unset-value' : undefined} style={colorSelection && selectedProject ? { color: getProjectColor(selectedProject) } : undefined}>{selected}</span>{!cell && <UiIcon name="chevronDown" />}</>}
    </button>
    {open && <div ref={popup} id={id} role={variant ? 'menu' : 'dialog'} aria-label="プロジェクト" className={`project-picker-popup ${iconOnly ? 'timer-project-popup' : ''} ${variant ? 'shared-picker-popup' : ''}`} style={position}>
      <p>プロジェクト</p>
      {[{ id: null, name: '未所属' }, ...projects].map(project => variant ? <PickerOption key={project.id ?? 'none'} value={String(project.id ?? '')} attributes={{ 'data-project-id': String(project.id ?? '') }} selected={project.id === projectId} disabled={disabled || busy} onClick={() => void choose(project.id)} style={project.id === null ? undefined : { color: getProjectColor(project) }}>
        {project.id !== null && <ProjectIcon project={project} />}{project.name}</PickerOption> : <button type="button" key={project.id ?? 'none'} data-project-id={project.id ?? ''}
        aria-pressed={project.id === projectId} disabled={disabled || busy} onClick={() => void choose(project.id)} style={coloredOptions && project.id !== null ? { color: getProjectColor(project) } : undefined}>{coloredOptions && project.id !== null && <ProjectIcon project={project} />}{project.name}</button>)}
      {allowCreate && <><div className="project-picker-divider" />
      <button type="button" className="project-picker-create" disabled={disabled || busy} onClick={() => {
        setOpen(false); setError(''); setCreating(true); onInteractionChange?.(true)
      }}>＋ 新しいプロジェクトを作成</button></>}
      {error && <p className="error" role="alert">{error}</p>}
    </div>}
    {creating && createPortal(<ProjectComposer editing={false} name={projectName} color={projectColor} onColorChange={setProjectColor} error={error} onChange={setProjectName} onSave={create} onClose={closeCreation} />, document.querySelector('.app-layout') ?? document.body)}
  </div>
}
