import { forwardRef } from 'react'
import type { ButtonHTMLAttributes } from 'react'
import { UiIcon } from './UiIcon'

export const KebabButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(function KebabButton({ className = '', ...props }, ref) {
  return <button {...props} ref={ref} type="button" className={`kebab-button ${className}`}><UiIcon name="more" /></button>
})

// A native details summary preserves its keyboard behavior and menu positioning.
export function KebabSummary({ label }: { label: string }) {
  return <summary className="kebab-button" aria-label={label}><UiIcon name="more" /></summary>
}
