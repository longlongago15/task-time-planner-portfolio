import assert from 'node:assert/strict'
import test from 'node:test'
import { capturePopupFocus, dismissPopupOnEscape, eventInsidePopup, focusPopupControl, listenOutsidePopup, movePopupFocus } from '../src/popupInteraction.ts'

const event = (target, path = []) => ({ target, composedPath: () => path })
const node = () => ({ nodeType: 1 })
function control(doc, extra = {}) {
  const element = { nodeType: 1, isConnected: true, disabled: false, visible: true, dataset: {}, tagName: 'BUTTON',
    ownerDocument: doc, closest: () => null, getAttribute: () => null,
    matches: () => element.disabled, getClientRects: () => element.visible ? [{}] : [],
    focus(options) { element.options = options; doc.activeElement = element }, ...extra }
  return element
}

test('Outside predicate accepts Trigger, Popup, Portal and the original path after DOM replacement', () => {
  const root = { contains: () => false }, popup = { contains: () => false }, removed = node()
  assert(eventInsidePopup(event(removed, [removed, root]), [root, popup]))
  assert(eventInsidePopup(event(removed, [removed, popup]), [root, popup]))
  assert(!eventInsidePopup(event(removed, [removed]), [root, popup]))
})
test('Contains fallback supports ordinary and synthetic events without a composed path', () => {
  const child = node(), root = { contains: target => target === child }
  assert(eventInsidePopup(event(child), [null, root]))
  assert(!eventInsidePopup(event(null), [root]))
  assert(!eventInsidePopup(event({}), [root]))
})
test('Outside listener preserves event types, pending guard and removes every registration', () => {
  const previous = globalThis.document, doc = new EventTarget(), root = { contains: () => false }
  globalThis.document = doc
  try {
    let calls = 0, pending = false
    const dispose = listenOutsidePopup(() => [root], () => { if (!pending) calls++ }, ['pointerdown', 'click'])
    doc.dispatchEvent(new Event('pointerdown')); assert.equal(calls, 1)
    pending = true; doc.dispatchEvent(new Event('click')); assert.equal(calls, 1)
    pending = false; const inside = new Event('click'); inside.composedPath = () => [root]
    doc.dispatchEvent(inside); assert.equal(calls, 1)
    dispose(); doc.dispatchEvent(new Event('click')); doc.dispatchEvent(new Event('pointerdown')); assert.equal(calls, 1)
  } finally { globalThis.document = previous }
})
test('Escape consumes only an unhandled Escape and invokes dismissal once', () => {
  let closed = 0, stopped = 0, prevented = 0
  const e = { key: 'Escape', defaultPrevented: false, preventDefault() { prevented++ }, stopPropagation() { stopped++ } }
  assert(dismissPopupOnEscape(e, () => closed++)); assert.deepEqual([closed, prevented, stopped], [1, 1, 1])
  assert(!dismissPopupOnEscape({ ...e, defaultPrevented: true }, () => closed++))
  assert(!dismissPopupOnEscape({ ...e, key: 'Enter' }, () => closed++)); assert.equal(closed, 1)
})
test('Pending callers can consume Escape without closing a parent or their own Popup', () => {
  let closed = false
  const e = { key: 'Escape', defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, stopPropagation() {} }
  dismissPopupOnEscape(e, () => { const pending = true; if (!pending) closed = true })
  assert(e.defaultPrevented); assert(!closed)
})
test('Focus restoration avoids scrolling, disabled, hidden, inert and disconnected controls', () => {
  const doc = {}, enabled = control(doc)
  assert(focusPopupControl(enabled)); assert.deepEqual(enabled.options, { preventScroll: true })
  for (const options of [{ disabled: true }, { visible: false }, { isConnected: false }, { closest: () => ({}) }]) {
    const blocked = control(doc, options); assert(!focusPopupControl(blocked)); assert.equal(doc.activeElement, enabled)
  }
  assert(!focusPopupControl(null))
})
test('A sorted row returns to its connected Trigger', () => {
  const doc = {}, trigger = control(doc)
  assert(capturePopupFocus(trigger)()); assert.equal(doc.activeElement, trigger)
})
test('A replaced Trigger returns to the same Task and accessible label', () => {
  const doc = {}, replacement = control(doc, { getAttribute: () => 'Status' })
  const row = { dataset: { taskId: '4' }, querySelectorAll: () => [replacement] }
  const table = control(doc, { querySelectorAll: () => [row] })
  const trigger = control(doc, { getAttribute: () => 'Status', closest: selector => selector === '[data-task-id]' ? row : table })
  const restore = capturePopupFocus(trigger); trigger.isConnected = false
  assert(restore()); assert.equal(doc.activeElement, replacement)
})
test('A filtered-out Task returns to the existing focusable Table', () => {
  const doc = {}, table = control(doc, { querySelectorAll: () => [] })
  const trigger = control(doc, { getAttribute: () => 'Status', closest: selector => selector === '[data-task-id]' ? { dataset: { taskId: '4' } } : table })
  const restore = capturePopupFocus(trigger); trigger.isConnected = false
  assert(restore()); assert.equal(doc.activeElement, table)
  table.isConnected = false; assert(!restore())
})
test('Arrow navigation wraps and Home/End preserve the existing option order', () => {
  const doc = {}, options = [control(doc), control(doc), control(doc)], popup = { ownerDocument: doc, querySelectorAll: () => options }
  assert(movePopupFocus(popup, 'ArrowUp', 'button')); assert.equal(doc.activeElement, options[2])
  movePopupFocus(popup, 'ArrowDown', 'button'); assert.equal(doc.activeElement, options[0])
  movePopupFocus(popup, 'End', 'button'); assert.equal(doc.activeElement, options[2])
  movePopupFocus(popup, 'Home', 'button'); assert.equal(doc.activeElement, options[0])
})
test('Keyboard navigation excludes hidden/disabled options and ignores text editing keys', () => {
  const doc = {}, option = control(doc), popup = { ownerDocument: doc, querySelectorAll: () => [control(doc, { disabled: true }), option, control(doc, { visible: false })] }
  assert(movePopupFocus(popup, 'ArrowDown', 'button')); assert.equal(doc.activeElement, option)
  assert(!movePopupFocus(popup, 'Enter', 'button')); assert(!movePopupFocus(null, 'End', 'button'))
  assert(!movePopupFocus({ ...popup, querySelectorAll: () => [] }, 'Home', 'button'))
})

test('Initial focus can retain native option/input scrolling while restoration avoids it', () => {
  const doc = {}, option = control(doc)
  assert(focusPopupControl(option, { preventScroll: false })); assert.deepEqual(option.options, { preventScroll: false })
  assert(focusPopupControl(option)); assert.deepEqual(option.options, { preventScroll: true })
})
