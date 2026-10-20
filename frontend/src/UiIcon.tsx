import type { CSSProperties } from 'react'
import { colorLuminance, getProjectColor } from './identificationColors'

type IconName = 'check' | 'circle' | 'folder' | 'chevronRight' | 'chevronDown' | 'chevronLeft' | 'play' | 'plus' | 'minus' | 'calendar' | 'task' | 'reports' | 'search' | 'close' | 'arrowUp' | 'arrowDown' | 'more' | 'stop' | 'tag' | 'clock' | 'flag' | 'statusRadial' | 'tagFilled'
const paths: Record<IconName, string> = {
  statusRadial: 'M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2',
  tagFilled: 'M3 3h9l10 10-9 9L3 12V3Z M8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z',
  check: 'm5 12 4 4L19 6',
  flag: 'M5 21V3m0 1c5-3 9 3 14 0v9c-5 3-9-3-14 0',
  circle: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
  folder: 'M20 20H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2Z',
  chevronRight: 'm9 6 6 6-6 6',
  chevronDown: 'm6 9 6 6 6-6',
  chevronLeft: 'm15 6-6 6 6 6',
  play: 'm8 5 11 7-11 7Z',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  calendar: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14H3V6a2 2 0 0 1 2-2Z',
  task: 'm3 6 2 2 4-4M12 6h9m-18 9 2 2 4-4M12 15h9M12 21h9',
  reports: 'M4 3v18h17M8 17v-5M13 17V8M18 17V4',
  search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
  close: 'm6 6 12 12M6 18 18 6',
  arrowUp: 'M12 20V4m-7 7 7-7 7 7',
  arrowDown: 'M12 4v16m-7-7 7 7 7-7',
  more: 'M12 5h.01M12 12h.01M12 19h.01',
  stop: 'M5 5h14v14H5Z',
  tag: 'M20 13 11 22 2 13V2h11l9 9a1.4 1.4 0 0 1 0 2Z M8.5 7a1.5 1.5 0 1 0-3 0 1.5 1.5 0 1 0 3 0Z',
  clock: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0M12 6v6l4 2',
}

export function UiIcon({ name, style, projectColor }: { name: IconName; style?: CSSProperties; projectColor?: string }) {
  return <svg className="ui-icon" data-icon={name} width="18" height="18" viewBox="0 0 24 24"
    fill={name === 'tag' || name === 'tagFilled' ? 'currentColor' : 'none'} fillRule={name === 'tag' || name === 'tagFilled' ? 'evenodd' : undefined} stroke={name === 'tag' || name === 'tagFilled' ? 'none' : 'currentColor'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true" focusable="false" data-project-color={projectColor} style={style}><path d={paths[name]} /></svg>
}

export function ProjectIcon({ project, style, tone = 'colored' }: { project?: { id: number; color?: string | null } | null; style?: CSSProperties; tone?: 'colored' | 'neutral' }) {
  const color = tone === 'neutral' ? 'var(--text-secondary)' : project ? getProjectColor(project) : '#78818B'
  return <UiIcon name="folder" projectColor={color} style={{ color, fill: 'currentColor', strokeWidth: 0, filter: tone !== 'neutral' && colorLuminance(color) > 0.8 ? 'drop-shadow(0 0 1px var(--text-secondary))' : undefined, ...style }} />
}
