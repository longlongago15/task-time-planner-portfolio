import assert from 'node:assert/strict'
import test from 'node:test'
import { COLOR_PRESETS, colorLuminance, getProjectColor, getTagColor, getTagChipStyle } from '../src/identificationColors.ts'

test('NULL identification colors are stable across copies, utilities and reload imports', async () => {
  const reloaded = await import('../src/identificationColors.ts?reload=colors')
  const values = new Set()
  for (let id = 1; id <= 30; id++) {
    const project = { id, color: null }
    const value = getProjectColor(project)
    assert.equal(getProjectColor({ ...project }), value)
    assert.equal(getTagColor(project), value)
    assert.equal(reloaded.getProjectColor(project), value)
    assert.equal(reloaded.getTagColor(project), value)
    values.add(value)
  }
  assert.equal(values.size, 9)
  assert.equal(COLOR_PRESETS.length, 15)
  assert.equal(getProjectColor({ id: 1, color: '#abcdef' }), '#ABCDEF')
  assert.equal(getTagColor({ id: 1, color: '#000000' }), '#000000')
})

for (const color of ['#000000', '#FFFFFF', '#FFFF00', '#00FF00', '#FF00FF', '#0000FF', '#808080', ...COLOR_PRESETS.map(p => p.color)]) {
  test(`Tag chip ${color} uses pale tint and exceeds WCAG AA text contrast`, () => {
    const style = getTagChipStyle(color)
    if (color !== '#FFFFFF') assert.notEqual(style.backgroundColor, color)
    assert(colorLuminance(style.backgroundColor) > 0.6)
    const contrast = (colorLuminance(style.backgroundColor) + 0.05) / (colorLuminance(style.color) + 0.05)
    assert(contrast >= 4.5, `Contrast ${contrast}`)
  })
}

test('Vivid and pastel red, blue and green retain distinct chip backgrounds and borders', () => {
  for (const [vivid, pastel] of [['#E53935', '#FFB3B0'], ['#001AFF', '#AFCBFF'], ['#008A42', '#ACE5BF']]) {
    const a = getTagChipStyle(vivid), b = getTagChipStyle(pastel)
    const distance = (x, y) => [1, 3, 5].reduce((sum, offset) => sum + Math.abs(parseInt(x.slice(offset, offset + 2), 16) - parseInt(y.slice(offset, offset + 2), 16)), 0)
    assert(distance(a.backgroundColor, b.backgroundColor) >= 40)
    assert(distance(a.borderColor, b.borderColor) >= 90)
    assert.equal(getProjectColor({ id: 1, color: vivid }), vivid)
  }
})
