import { useId } from 'react'
import { ProjectIcon } from './UiIcon'
import { COLOR_PRESETS, colorLuminance, getProjectColor, getTagChipStyle, getTagColor } from './identificationColors'
import './colors.css'

export function ColorPicker({ value, entityId = 0, name, kind, disabled = false, onChange }: {
  value: string | null; entityId?: number; name: string; kind: 'project' | 'tag'; disabled?: boolean
  onChange: (color: string | null) => void
}) {
  const id = useId()
  const color = (kind === 'project' ? getProjectColor : getTagColor)({ id: entityId, color: value })
  return <fieldset className="color-picker" disabled={disabled}>
    <legend>色</legend>
    <div className="color-presets" role="group" aria-label="プリセット色">
      {COLOR_PRESETS.map(preset => <button key={preset.color} type="button" className="color-swatch"
        aria-label={`${preset.name} ${preset.color}`} title={`${preset.name} ${preset.color}`} aria-pressed={value?.toUpperCase() === preset.color}
        data-color={preset.color} style={{ backgroundColor: preset.color, color: colorLuminance(preset.color) > 0.179 ? '#000000' : '#FFFFFF' }}
        onClick={() => onChange(preset.color)}>{value?.toUpperCase() === preset.color ? '✓' : ''}</button>)}
    </div>
    <div className="color-picker-actions">
      <label className="custom-color-label" htmlFor={id}><input id={id} type="color" aria-label="カスタム色を選択" value={color}
        onChange={event => onChange(event.target.value.toUpperCase())} />カスタム色を選択</label>
      <button type="button" className="secondary-button color-reset" onClick={() => onChange(null)}>色をリセット</button>
    </div>
    <div className="color-preview" data-color={color} aria-label="色プレビュー" aria-live="polite">
      {kind === 'project' ? <span className="project-color-preview"><ProjectIcon project={{ id: entityId, color: value }} /><span>{name.trim() || 'プロジェクト名'}</span></span>
        : <span className="tag-chip" style={getTagChipStyle(color)}>{name.trim() || 'タグ名'}</span>}
      <small>{value === null ? '自動（既定色）' : color}</small>
    </div>
  </fieldset>
}
