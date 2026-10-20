import { useCallback, useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'

// Interaction primitives only. Each caller owns state, saving and event phase.
export function eventInsidePopup(event: Pick<Event, 'target' | 'composedPath'>, roots: readonly (HTMLElement | null)[]): boolean {
  const path = event.composedPath(), target = event.target as Node | null
  return roots.some(root => root !== null && (path.includes(root) || target !== null && typeof target.nodeType === 'number' && root.contains(target)))
}

export function listenOutsidePopup(roots: () => readonly (HTMLElement | null)[], outside: (event: Event) => void, events: readonly ('pointerdown' | 'click')[] = ['pointerdown']) {
  const listener = (event: Event) => { if (!eventInsidePopup(event, roots())) outside(event) }
  for (const type of events) document.addEventListener(type, listener)
  return () => { for (const type of events) document.removeEventListener(type, listener) }
}

type EscapeEvent = Pick<KeyboardEvent, 'key' | 'defaultPrevented' | 'preventDefault' | 'stopPropagation'>
export function dismissPopupOnEscape(event: EscapeEvent, dismiss: () => void): boolean {
  if (event.key !== 'Escape' || event.defaultPrevented) return false
  event.preventDefault(); event.stopPropagation(); dismiss()
  return true
}

export function focusPopupControl(control: HTMLElement | null | undefined, options: FocusOptions = { preventScroll: true }): boolean {
  if (!control?.isConnected || control.matches(':disabled, [aria-disabled="true"]') || control.closest('[inert]') || !control.getClientRects().length) return false
  control.focus(options)
  return control.ownerDocument.activeElement === control
}

// Rows can move or disappear after a save. Prefer the same control, then its
// replacement in the same Task row, then the existing focusable table/dialog.
export function capturePopupFocus(trigger: HTMLElement | null): () => boolean {
  const scope = trigger?.closest<HTMLElement>('.task-table-scroll, dialog')
  const taskId = trigger?.closest<HTMLElement>('[data-task-id]')?.dataset.taskId
  const label = trigger?.getAttribute('aria-label')
  return () => {
    if (focusPopupControl(trigger)) return true
    if (!trigger || !scope?.isConnected) return false
    const row = taskId ? Array.from(scope.querySelectorAll<HTMLElement>('[data-task-id]')).find(row => row.dataset.taskId === taskId) : scope
    const replacement = label ? Array.from(row?.querySelectorAll<HTMLElement>('[aria-label]') ?? []).find(control => control.tagName === trigger.tagName && control.getAttribute('aria-label') === label) : null
    return focusPopupControl(replacement) || focusPopupControl(scope)
  }
}

export function movePopupFocus(popup: HTMLElement | null, key: string, selector: string): boolean {
  if (!popup || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key)) return false
  const controls = Array.from(popup.querySelectorAll<HTMLElement>(selector)).filter(control => !control.matches(':disabled') && control.getClientRects().length)
  if (!controls.length) return false
  const current = controls.indexOf(popup.ownerDocument.activeElement as HTMLElement)
  const next = key === 'Home' ? 0 : key === 'End' ? controls.length - 1 : current < 0 ? key === 'ArrowDown' ? 0 : controls.length - 1 : (current + (key === 'ArrowDown' ? 1 : -1) + controls.length) % controls.length
  // Arrow navigation retains native scrolling so options inside a short Popup remain visible.
  controls[next].focus()
  return true
}

// A concurrent save may remove a row before or after its promise resolves.
// Restore after the actual commit, rather than guessing with a single frame.
export function usePopupFocusReturn(root: RefObject<HTMLElement | null>) {
  const restore = useRef<(() => boolean) | null>(null)
  useLayoutEffect(() => () => {
    const node = root.current, doc = node?.ownerDocument ?? document, target = restore.current
    const ownedFocus = node?.contains(doc.activeElement) ?? false
    if (target) queueMicrotask(() => {
      if (!root.current && (ownedFocus || doc.activeElement === doc.body)) target()
    })
  }, [root])
  const capture = useCallback((trigger: HTMLElement | null) => { restore.current = capturePopupFocus(trigger) }, [])
  const focusBack = useCallback(() => restore.current?.() ?? false, [])
  return { capture, restore: focusBack }
}
