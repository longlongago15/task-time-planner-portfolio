import type { CSSProperties, ReactNode } from 'react'

// Shared Option presentation; single/multiple selection keeps its own lifecycle.
export function PickerOption({ children, selected, onClick, disabled, style, value, attributes }: {
  children: ReactNode; selected: boolean; onClick: () => void; disabled?: boolean; style?: CSSProperties; value: string
  attributes?: Record<string, string>
}) {
  return <button type="button" className="shared-picker-option" role="menuitemradio" aria-checked={selected} disabled={disabled} style={style} data-value={value} {...attributes} onClick={onClick}>
    <span className="shared-picker-option-value">{children}</span><span className="shared-picker-check" aria-hidden="true">{selected ? '✓' : ''}</span>
  </button>
}
