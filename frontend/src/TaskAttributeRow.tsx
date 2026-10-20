import type { ReactNode } from 'react'

export function TaskAttributeRow({ icon, label, children, unset = false, className = '' }: {
  icon: ReactNode; label: string; children: ReactNode; unset?: boolean; className?: string
}) {
  return <div className={`task-attribute-row ${className}`} data-unset={unset}>
    <span className="task-attribute-icon" aria-hidden="true">{icon}</span>
    <span className="task-attribute-label">{label}</span>
    <div className="task-attribute-control">{children}</div>
  </div>
}
