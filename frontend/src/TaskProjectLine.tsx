import { ProjectIcon, UiIcon } from './UiIcon'
import { getProjectColor } from './identificationColors'

type Props = {
  project?: { id: number; color?: string | null }
  name?: string | null
  hasTags: boolean
  projectClassName: string
}

export function TaskProjectLine({ project, name, hasTags, projectClassName }: Props) {
  return <span className="task-project-tags">
    {name && <span className={`task-project-value ${projectClassName}`} style={{ color: project ? getProjectColor(project) : '#78818B' }}>
      <ProjectIcon project={project} /><span className="task-project-name">{name}</span>
    </span>}
    {hasTags && <span className="schedule-block-tag-icon" aria-hidden="true"><UiIcon name="tag" /></span>}
  </span>
}
