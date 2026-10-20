export type PopupAnchor = { left: number; right: number; top: number; bottom: number }
export type PopupSize = { width: number; height: number }
export type PopupViewport = { width: number; height: number }
export type PopupPosition = { left: number; top: number }
type PlacementOptions = {
  align?: 'start' | 'end'
  vertical?: 'flip' | 'clamp'
  gap?: number
  margin?: number
}

// Viewport coordinates for fixed overlays. Callers retain their own lifecycle.
export function positionPopup(anchor: PopupAnchor, popup: PopupSize, viewport: PopupViewport, {
  align = 'start', vertical = 'flip', gap = 4, margin = 8,
}: PlacementOptions = {}): PopupPosition {
  const clamp = (value: number, maximum: number) => Math.max(margin, Math.min(value, Math.max(margin, maximum)))
  const left = clamp(align === 'end' ? anchor.right - popup.width : anchor.left, viewport.width - popup.width - margin)
  const below = anchor.bottom + gap
  // Preserve the existing Project/Tag flip threshold; clamp the gap at the edge.
  const preferredTop = vertical === 'flip' && anchor.bottom + popup.height + margin > viewport.height
    ? anchor.top - popup.height - gap
    : below
  return { left, top: clamp(preferredTop, viewport.height - popup.height - margin) }
}
