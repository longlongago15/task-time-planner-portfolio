import { createContext, useContext, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { ProjectIcon, UiIcon } from './UiIcon'

export type WorkspacePage = 'home' | 'tasks' | 'projects' | 'projectDetail' | 'reports'

const SIDEBAR_STORAGE_KEY = 'workspaceSidebarCollapsed'
type ShellDevice = 'desktop' | 'tablet' | 'mobile'
const subscribeViewport = (notify: () => void) => { window.addEventListener('resize', notify); return () => window.removeEventListener('resize', notify) }
const viewportDevice = (): ShellDevice => window.innerWidth > 980 ? 'desktop' : window.innerWidth > 680 ? 'tablet' : 'mobile'
const SidebarContext = createContext({ collapsed: false, device: 'desktop' as ShellDevice, id: '', toggle: () => {} })
function readSidebarPreference() {
  try { return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === 'true' } catch { return false }
}

function SidebarToggle() {
  const { collapsed, id, toggle } = useContext(SidebarContext)
  return <button type="button" className="sidebar-toggle" data-sidebar-toggle
    aria-label={`ワークスペースサイドバーを${collapsed ? '開く' : '閉じる'}`} title={`サイドバーを${collapsed ? '開く' : '閉じる'}`}
    aria-expanded={!collapsed} aria-controls={id} onClick={toggle}><UiIcon name={collapsed ? 'chevronRight' : 'chevronLeft'} /></button>
}

export function AppShell({ page, children }: { page: WorkspacePage; children: ReactNode }) {
  const [desktopCollapsed, setDesktopCollapsed] = useState(readSidebarPreference)
  const [tabletCollapsed, setTabletCollapsed] = useState(true)
  const device = useSyncExternalStore(subscribeViewport, viewportDevice, () => 'desktop' as ShellDevice)
  const collapsed = device === 'desktop' ? desktopCollapsed : device === 'tablet' ? tabletCollapsed : false
  const id = useId(), root = useRef<HTMLDivElement>(null), focusToggle = useRef(false)
  const toggle = () => {
    if (device === 'mobile') return
    focusToggle.current = true
    if (device === 'tablet') setTabletCollapsed(value => !value)
    else {
      setDesktopCollapsed(!collapsed)
      try { window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(!collapsed)) } catch { /* Layout remains usable without storage access. */ }
    }
  }
  useLayoutEffect(() => {
    if (focusToggle.current) { root.current?.querySelector<HTMLButtonElement>('[data-sidebar-toggle]')?.focus({ preventScroll: true }); focusToggle.current = false }
  }, [collapsed, device])
  return <SidebarContext.Provider value={{ collapsed, device, id, toggle }}><div ref={root} className={`app-layout unified-shell ${collapsed ? 'sidebar-collapsed' : ''} ${page === 'home' ? 'home-layout' : page === 'projects' || page === 'projectDetail' ? 'projects-layout' : ''}`} data-page={page} data-device={device} data-sidebar-collapsed={collapsed}>
    {device !== 'mobile' && <SidebarToggle />}{children}
  </div></SidebarContext.Provider>
}

export function WorkspaceSidebar({ page, onNavigate, children }: {
  page: WorkspacePage; onNavigate: (page: 'home' | 'projects') => void; children?: ReactNode
}) {
  const { collapsed, id } = useContext(SidebarContext)
  return <aside id={id} inert={collapsed} aria-hidden={collapsed || undefined} className={`app-sidebar workspace-sidebar ${page === 'home' ? 'home-sidebar' : ''}`} aria-label={page === 'home' ? 'Homeのタスク・プロジェクト' : 'ワークスペース'}>
    <div className="sidebar-heading"><p className="sidebar-kicker">ワークスペース</p></div>
    <nav className="sidebar-subnav home-workspace-nav" aria-label="Workspace">
      <button type="button" className={page === 'home' ? 'active' : ''} onClick={() => onNavigate('home')}><UiIcon name="calendar" /><span>ホーム画面</span></button>
      <button type="button" className={page === 'projects' ? 'active' : ''} onClick={() => onNavigate('projects')}><ProjectIcon /><span>プロジェクト一覧</span></button>
    </nav>
    {children}
  </aside>
}
