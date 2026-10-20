import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { positionPopup } from './popupPosition'
import type { PopupPosition } from './popupPosition'
import { createPortal } from 'react-dom'
import type { CSSProperties } from 'react'

export function ReportBarTooltip({ title, planned, actual }: {title: string; planned: number; actual: number}) {
  const id = useId(), [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<PopupPosition | null>(null)
  useLayoutEffect(() => {
    if (!anchor) return
    let frame = 0
    const update = () => {
      frame = 0
      if (!anchor.isConnected) { setAnchor(null); return }
      const tooltip = tooltipRef.current
      if (!tooltip) return
      const rect = anchor.getBoundingClientRect(), size = tooltip.getBoundingClientRect()
      // Keep the centered, above-bar contract; the shared primitive only clamps bounds.
      const left = rect.left + rect.width / 2 - size.width / 2
      const top = rect.top - size.height - 18
      const next = positionPopup({ left, right: left, top, bottom: top }, size,
        { width: document.documentElement.clientWidth, height: window.innerHeight },
        { vertical: 'clamp', gap: 0 })
      setPosition(previous => previous?.left === next.left && previous.top === next.top ? previous : next)
      // A responsive ancestor can keep moving after the resize event (Shell Grid transition).
      // Follow only finite running ancestor animations, never an idle/infinite polling loop.
      for (let element: HTMLElement | null = anchor; element; element = element.parentElement) {
        if (element.getAnimations().some(animation => animation.playState === 'running'
          && animation.effect?.getComputedTiming().endTime !== Infinity)) { schedule(); break }
      }
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update) }
    update()
    // Capture also observes scroll events from nested scroll containers.
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    const resize = new ResizeObserver(schedule)
    resize.observe(anchor)
    if (tooltipRef.current) resize.observe(tooltipRef.current)
    const removal = new MutationObserver(() => { if (!anchor.isConnected) schedule() })
    removal.observe(document.body, { childList: true, subtree: true })
    return () => {
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
      resize.disconnect()
      removal.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [anchor, title])
  useEffect(() => {
    const other = (event: Event) => { if ((event as CustomEvent<string>).detail !== id) setAnchor(null) }
    document.addEventListener('report-tooltip-open', other)
    return () => document.removeEventListener('report-tooltip-open', other)
  }, [id])
  const show = (element: HTMLElement) => { document.dispatchEvent(new CustomEvent('report-tooltip-open', {detail: id})); if (anchor !== element) setPosition(null); setAnchor(element) }
  return <><div className="period-chart-bars report-tooltip-bars" onPointerLeave={()=>setAnchor(null)} onBlur={event=>{if (!event.currentTarget.contains(event.relatedTarget)) setAnchor(null)}}>
    {(['estimated','actual'] as const).map((kind,index)=><span key={kind} className={`period-chart-bar ${kind}`} tabIndex={0} role="img" aria-label={title} aria-describedby={anchor ? id : undefined}
      style={{height: `${index === 0 ? planned : actual}%`}} onPointerEnter={event=>{if(event.pointerType !== 'touch')show(event.currentTarget)}} onFocus={event=>show(event.currentTarget)}
      onClick={event=>{event.stopPropagation(); show(event.currentTarget)}} onKeyDown={event=>{if(event.key==='Escape')setAnchor(null)}} />)}
  </div>{anchor && createPortal(<div ref={tooltipRef} id={id} role="tooltip" className="report-bar-tooltip" style={{...position, visibility: position ? 'visible' : 'hidden'} as CSSProperties}>
    {title.split('\n').map((line,index)=><span key={index}>{line}</span>)}
  </div>,document.body)}</>
}
