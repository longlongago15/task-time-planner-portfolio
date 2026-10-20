const DEFAULT_COLOR_PRESETS = [
  { name: '赤', color: '#DC6262' }, { name: 'オレンジ', color: '#D9793A' },
  { name: 'アンバー', color: '#BF922C' }, { name: '緑', color: '#529968' },
  { name: 'ティール', color: '#389B95' }, { name: '青', color: '#568BC7' },
  { name: 'インディゴ', color: '#717AC5' }, { name: '紫', color: '#A079BE' },
  { name: 'ピンク', color: '#CB729A' },
] as const

export const COLOR_PRESETS = [...DEFAULT_COLOR_PRESETS,
  { name: '鮮やかな赤', color: '#E53935' }, { name: 'パステル赤', color: '#FFB3B0' },
  { name: '鮮やかな青', color: '#001AFF' }, { name: 'パステル青', color: '#AFCBFF' },
  { name: '鮮やかな緑', color: '#008A42' }, { name: 'パステル緑', color: '#ACE5BF' },
] as const

type ColoredEntity = { id: number; color?: string | null }
function entityColor(entity: ColoredEntity): string {
  return entity.color && /^#[0-9a-f]{6}$/i.test(entity.color) ? entity.color.toUpperCase()
    : DEFAULT_COLOR_PRESETS[((entity.id % DEFAULT_COLOR_PRESETS.length) + DEFAULT_COLOR_PRESETS.length) % DEFAULT_COLOR_PRESETS.length].color
}
export const getProjectColor = (project: ColoredEntity) => entityColor(project)
export const getTagColor = (tag: ColoredEntity) => entityColor(tag)

function channels(color: string) { return [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16)) }
function mix(color: string, target: number, amount: number) {
  return '#' + channels(color).map(value => Math.round(value * (1 - amount) + target * amount).toString(16).padStart(2, '0')).join('').toUpperCase()
}
export function colorLuminance(color: string) {
  const [r, g, b] = channels(color).map(value => { const v = value / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
export function getTagChipStyle(color: string) {
  // Use the same blend for every base so vivid/pastel differences survive tinting.
  const backgroundColor = mix(color, 255, 0.8)
  let text = color
  for (let amount = 0; (colorLuminance(backgroundColor) + 0.05) / (colorLuminance(text) + 0.05) < 4.5; amount += 0.05) text = mix(color, 0, Math.min(1, amount))
  return { backgroundColor, color: text, borderColor: mix(color, 255, 0.35) }
}

export function getScheduleBlockStyle(color: string) {
  return { borderLeftColor: color, backgroundColor: `color-mix(in srgb, ${color} var(--calendar-project-tint, 14%), var(--calendar-project-surface, #FFFFFF))`, color: 'var(--calendar-project-text, #0F172A)' }
}
