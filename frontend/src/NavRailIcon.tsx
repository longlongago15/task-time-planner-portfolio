/** Filled, rounded silhouettes match the rail reference without changing inline UI icons. */
export function NavRailIcon({ name }: { name: 'calendar' | 'task' | 'projects' | 'reports' }) {
  return <svg className="nav-rail-icon" data-icon={name} width="22" height="22" viewBox="0 0 24 24"
    fill="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {name === 'calendar' && <><rect x="3" y="5" width="18" height="16" rx="2" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M3 10h18" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M8 3v4M16 3v4" fill="none" stroke="currentColor" strokeWidth="2" /></>}
    {name === 'task' && <><rect x="3" y="3" width="18" height="18" rx="4" /><path d="m7.5 12 3 3 6-6" fill="none" stroke="var(--surface-emphasis)" strokeWidth="2.25" /></>}
    {name === 'projects' && <path d="M3 5a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />}
    {name === 'reports' && <><rect x="3" y="12" width="4" height="9" rx="2" /><rect x="10" y="3" width="4" height="18" rx="2" /><rect x="17" y="8" width="4" height="13" rx="2" /></>}
  </svg>
}
