import type { Tag } from './TagStore'
import { getTagChipStyle, getTagColor } from './identificationColors'

export function TagChip({ tag }: { tag: Tag }) {
  return <span className="tag-chip" data-tag-id={tag.id} data-tag-color={getTagColor(tag)} style={getTagChipStyle(getTagColor(tag))}>{tag.name}</span>
}
