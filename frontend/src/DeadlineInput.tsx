import { useState } from 'react'
import { deadlineText } from './deadline'
export { DateInput as DeadlineInput } from './DateInput'
import { DateInput as DeadlineInput } from './DateInput'

export function InlineDeadlineInput({ value, disabled, onSave, onCancel }: { value: string | null; disabled: boolean; onSave: (value: string | null) => Promise<void>; onCancel: () => void }) {
  const [draft, setDraft] = useState(() => deadlineText(value))
  return <DeadlineInput value={draft} onChange={setDraft} onCommit={onSave} onCancel={onCancel} disabled={disabled} autoFocus allowClear />
}
