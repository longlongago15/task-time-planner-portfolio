import assert from 'node:assert/strict'
import test from 'node:test'
import { positionPopup } from '../src/popupPosition.ts'

const anchor = { left: 100, right: 180, top: 200, bottom: 232 }
const size = { width: 248, height: 160 }
const viewport = { width: 1024, height: 768 }

test('Fixed Popup starts below the left-aligned Trigger with the existing four-pixel gap', () => {
  assert.deepEqual(positionPopup(anchor, size, viewport), { left: 100, top: 236 })
})
test('Right alignment retains TaskRow Menu geometry', () => {
  assert.deepEqual(positionPopup(anchor, { width: 120, height: 160 }, viewport, { align: 'end' }), { left: 60, top: 236 })
})
test('Both horizontal edges preserve the eight-pixel viewport inset', () => {
  assert.equal(positionPopup({ ...anchor, left: -80 }, size, viewport).left, 8)
  assert.equal(positionPopup({ ...anchor, left: 1000 }, size, viewport).left, 768)
})
test('Flip uses the space above a bottom-edge Trigger', () => {
  assert.deepEqual(positionPopup({ ...anchor, top: 650, bottom: 682 }, size, viewport), { left: 100, top: 486 })
})
test('SingleSelect clamp preserves its policy without changing to a flip', () => {
  assert.deepEqual(positionPopup({ ...anchor, top: 650, bottom: 682 }, size, viewport, { vertical: 'clamp' }), { left: 100, top: 600 })
})
test('Tag retains its eight-pixel Trigger gap above and below', () => {
  assert.equal(positionPopup(anchor, size, viewport, { gap: 8 }).top, 240)
  assert.equal(positionPopup({ ...anchor, top: 650, bottom: 682 }, size, viewport, { gap: 8 }).top, 482)
})
test('Insufficient space above is clamped inside the viewport', () => {
  assert.deepEqual(positionPopup({ ...anchor, top: 120, bottom: 152 }, { width: 248, height: 280 }, { width: 375, height: 320 }), { left: 100, top: 8 })
})
test('A Popup exceeding available size anchors safely; the caller owns scroll sizing', () => {
  assert.deepEqual(positionPopup(anchor, { width: 500, height: 500 }, { width: 375, height: 320 }), { left: 8, top: 8 })
})
test('A bottom placement fits exactly at the inset boundary', () => {
  assert.equal(positionPopup(anchor, size, { ...viewport, height: 404 }).top, 236)
  assert.equal(positionPopup(anchor, size, { ...viewport, height: 403 }).top, 235)
  assert.equal(positionPopup(anchor, size, { ...viewport, height: 400 }).top, 232)
  assert.equal(positionPopup(anchor, size, { ...viewport, height: 399 }).top, 36)
})
test('Custom inset and gap retain independent roles', () => {
  assert.deepEqual(positionPopup({ ...anchor, left: 2 }, size, viewport, { margin: 16, gap: 12 }), { left: 16, top: 244 })
})
test('Changing Popup height recalculates the same anchor without mutating inputs', () => {
  const inputs = structuredClone({ anchor, size, viewport })
  positionPopup(anchor, size, viewport)
  assert.deepEqual({ anchor, size, viewport }, inputs)
  assert.notEqual(positionPopup(anchor, size, { ...viewport, height: 500 }).top, positionPopup(anchor, { ...size, height: 400 }, { ...viewport, height: 500 }).top)
})
test('Viewport and Popup resize remain bounded for both policies and alignments', () => {
  for (const width of [1920, 1024, 768, 601, 600, 375]) for (const height of [1080, 320, 180])
    for (const align of ['start', 'end']) for (const vertical of ['flip', 'clamp'])
      for (const gap of [4, 8]) for (const x of [-40, 8, width / 2, width - 8])
        for (const y of [-40, 8, height / 2, height - 8]) {
          const popup = { width: Math.min(248, width - 16), height: Math.min(160, height - 16) }
          const placed = positionPopup({ left: x, right: x + 80, top: y, bottom: y + 32 }, popup, { width, height }, { align, vertical, gap })
          assert(placed.left >= 8 && placed.top >= 8)
          assert(placed.left + popup.width <= width - 8 && placed.top + popup.height <= height - 8)
        }
})
