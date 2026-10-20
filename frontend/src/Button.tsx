import type { ButtonHTMLAttributes } from 'react'

export function Button({ variant, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' }) {
  return <button {...props} className={`${variant ? `ui-button ui-button-${variant}` : ''} ${className}`} />
}
