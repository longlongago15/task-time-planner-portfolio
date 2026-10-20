import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

type Props = { anchor: HTMLElement | null; modal: boolean; className: string; id: string; titleId: string; busy: boolean; onClose: () => void; children: ReactNode; retainDetachedAnchor?: boolean }

// Details float beside their source. Creation/editing retains a native modal.
export function CalendarSurface({ anchor, modal, className, id, titleId, busy, onClose, children, retainDetachedAnchor = false }: Props) {
  const surface = useRef<HTMLDivElement & HTMLDialogElement>(null)
  const close = useRef(onClose), pending = useRef(busy)
  useLayoutEffect(() => { close.current = onClose; pending.current = busy }, [onClose, busy])
  const [position, setPosition] = useState({ left: 8, top: 8 })
  const origin = useRef(anchor ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null))
  const inboxOriginId = useRef(anchor?.closest<HTMLElement>('[data-inbox-task-id]')?.dataset.inboxTaskId)
  const anchorBounds = useRef<DOMRect | null>(null)

  useLayoutEffect(() => {
    const element = surface.current
    if (!element) return
    let frame = 0
    const place = () => {
      if (modal || !anchor) return
      if (!anchor.isConnected && !retainDetachedAnchor) { if (!pending.current) close.current(); return }
      if (anchor.isConnected) anchorBounds.current = anchor.getBoundingClientRect()
      const source = anchorBounds.current
      if (!source) return
      const box = element.getBoundingClientRect()
      const width = document.documentElement.clientWidth, height = window.innerHeight, gap = 10, margin = 8
      const left = source.right + gap + box.width <= width - margin ? source.right + gap
        : source.left - gap - box.width >= margin ? source.left - gap - box.width : source.left
      const next = width <= 560 ? { left: margin, top: Math.max(margin, height - box.height - margin) }
        : { left: Math.max(margin, Math.min(left, width - box.width - margin)), top: Math.max(margin, Math.min(source.top, height - box.height - margin)) }
      setPosition(current => current.left === next.left && current.top === next.top ? current : next)
    }
    const reposition = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(place) }
    const outside = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('.project-composer')) return
      if (!modal && !pending.current && event.target instanceof Node && !event.composedPath().includes(element) && !element.contains(event.target) && !anchor?.contains(event.target)) close.current()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (event.target instanceof Node && !element.contains(event.target)) return
      if (event.target instanceof Element && event.target.closest('.tag-picker')?.querySelector('.tag-picker-popup')) return
      if (event.target instanceof Element && event.target.closest('.project-picker')?.querySelector('.project-picker-popup')) return
      if (event.target instanceof Element && event.target.closest('.task-title-input')?.querySelector('input')) return
      if (event.target instanceof Element && event.target.closest('.task-detail-field-editor')?.querySelector('input')) return
      if (event.target instanceof Element && event.target.closest('.calendar-detail-form')?.querySelector('.calendar-inline-schedule-actions')) return
      if (event.target instanceof Element && event.target.closest('.deadline-input')?.querySelector('[aria-expanded=true]')) return
      event.preventDefault(); event.stopPropagation()
      if (!pending.current) close.current()
    }
    const cancel = (event: Event) => { event.preventDefault(); if (!pending.current) close.current() }
    if (modal) element.showModal()
    else place()
    const firstControl = element.querySelector(modal ? 'form input, form select' : 'button:not(:disabled)') ?? element.querySelector('button:not(:disabled)')
    ;(firstControl as HTMLElement | null)?.focus({ preventScroll: true })
    const observer = new ResizeObserver(reposition)
    observer.observe(element); if (anchor) observer.observe(anchor)
    window.addEventListener('resize', reposition); window.addEventListener('scroll', reposition, true)
    document.addEventListener('pointerdown', outside, true); document.addEventListener('click', outside, true)
    document.addEventListener('keydown', escape, true); element.addEventListener('cancel', cancel)
    return () => {
      cancelAnimationFrame(frame); observer.disconnect()
      window.removeEventListener('resize', reposition); window.removeEventListener('scroll', reposition, true)
      document.removeEventListener('pointerdown', outside, true); document.removeEventListener('click', outside, true)
      document.removeEventListener('keydown', escape, true); element.removeEventListener('cancel', cancel)
      if (modal) element.close()
    }
  }, [anchor, modal, retainDetachedAnchor])
  useLayoutEffect(() => () => {
    const blockId = origin.current?.dataset.scheduleBlockId
    const target = origin.current?.isConnected ? origin.current : blockId ? document.querySelector<HTMLElement>(`[data-schedule-block-id="${blockId}"]`) : inboxOriginId.current ? document.querySelector<HTMLElement>(`[data-inbox-task-id="${inboxOriginId.current}"] .inbox-card-open`) : null
    target?.focus({ preventScroll: true })
  }, [])
  const attributes = { id, className: `${className}${modal ? '' : ' calendar-popover'}`, 'aria-labelledby': titleId, 'aria-busy': busy || undefined, tabIndex: -1 }
  // Keep the existing app theme scope; fixed positioning and the native dialog
  // top layer keep both surfaces out of the Calendar layout.
  return modal ? <dialog {...attributes} ref={surface} aria-modal="true"
    onClick={event => { const box = event.currentTarget.getBoundingClientRect(); if (!busy && event.target === event.currentTarget
      && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) onClose() }}>{children}</dialog>
    : <div {...attributes} ref={surface} role="dialog" aria-modal="false" style={position}>{children}</div>
}
