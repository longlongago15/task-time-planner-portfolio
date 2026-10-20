import { dismissPopupOnEscape, focusPopupControl, listenOutsidePopup, usePopupFocusReturn } from './popupInteraction'
import { positionPopup } from './popupPosition'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { UiIcon } from './UiIcon'
import { useTags } from './TagStore'
import type { Tag } from './TagStore'
import { ColorPicker } from './ColorPicker'
import { TagChip } from './TagChip'

export function TagChips({ tags, maxVisible }: { tags: Tag[]; colored?: boolean; maxVisible?: number }) {
  const root = useRef<HTMLSpanElement>(null)
  const [limit, setLimit] = useState(2)
  useLayoutEffect(() => {
    const node = root.current
    if (!node) return
    // Table tags have a fixed two-chip summary. Measuring the content-sized
    // trigger here would feed a reduced count back into an ever smaller width.
    if (node.closest('.task-list-unified-table .task-table-tags')) {
      setLimit(maxVisible ?? 2)
      return
    }
    const canvas = document.createElement('canvas'), context = canvas.getContext('2d')
    const fit = () => {
      const width = node.getBoundingClientRect().width
      if (!context) return
      context.font = `400 12px ${getComputedStyle(node).fontFamily}`
      const padding = node.closest('.task-table-tags') ? 10 : 18
      const chipWidth = (name: string) => Math.min(88, context.measureText(name).width + padding)
      let count = Math.min(2, tags.length)
      while (count > 0) {
        const overflow = tags.length > count ? chipWidth(`+${tags.length - count}件`) + 4 : 0
        const required = tags.slice(0, count).reduce((total, tag) => total + chipWidth(tag.name), 0) + Math.max(0, count - 1) * 4 + overflow
        if (required <= width) break
        count -= 1
      }
      setLimit(count)
    }
    fit()
    const observer = new ResizeObserver(fit); observer.observe(node)
    return () => observer.disconnect()
  }, [tags, maxVisible])
  const visible = Math.min(limit, tags.length), remaining = tags.length - visible
  return <span ref={root} className="tag-chips" title={tags.map(tag => tag.name).join(' / ')}>{tags.length ? <>
    {tags.slice(0, visible).map(tag => <TagChip tag={tag} key={tag.id} />)}
    {remaining > 0 && <span className="tag-chip tag-overflow">+{remaining}件</span>}
  </> : <span className="tag-empty" />}</span>
}

export function TagPicker({ tagIds, onChange, disabled = false, iconOnly = false, showSelection = false, showAllSelected = false, emptyLabel = '', label = 'タグを選択', selectedTags = [], onInteractionChange, onCancel, variant }: {
  tagIds: number[]; onChange: (ids: number[]) => void | Promise<void>; disabled?: boolean; iconOnly?: boolean; label?: string; variant?: 'table' | 'editor'
  selectedTags?: Tag[]; showSelection?: boolean; showAllSelected?: boolean; emptyLabel?: string; onInteractionChange?: (open: boolean) => void; onCancel?: () => void
}) {
  const store = useTags()
  const [open, setOpen] = useState(false), [search, setSearch] = useState('')
  const [mode, setMode] = useState<'select' | 'create' | 'manage'>('select')
  const [name, setName] = useState(''), [renameId, setRenameId] = useState<number | null>(null)
  const [color, setColor] = useState<string | null | undefined>(undefined)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [position, setPosition] = useState({ left: 8, top: 8 })
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null)
  const pending = useRef(false), searchInput = useRef<HTMLInputElement>(null), nameInput = useRef<HTMLInputElement>(null)
  const { capture: captureFocus, restore: focusBack } = usePopupFocusReturn(root)
  const id = useId()
  const chosen = tagIds.map(id => store.tags.find(tag => tag.id === id) ?? selectedTags.find(tag => tag.id === id)).filter((tag): tag is Tag => !!tag)
  useEffect(() => { onInteractionChange?.(open); return () => onInteractionChange?.(false) }, [open, onInteractionChange])
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect(), box = popup.current?.getBoundingClientRect()
      if (!anchor || !box) return
      setPosition(positionPopup(anchor, box, { width: document.documentElement.clientWidth, height: innerHeight }, { gap: 8 }))
    }
    place()
    const observer = new ResizeObserver(place)
    if (popup.current) observer.observe(popup.current)
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open])
  useEffect(() => {
    if (!open) return
    captureFocus(trigger.current)
    focusPopupControl(searchInput.current)
    // composedPath in the common predicate preserves clicks whose original
    // Create/Cancel button is replaced before the event reaches document.
    const disposeOutside = listenOutsidePopup(() => [root.current, popup.current], () => { if (!pending.current) setOpen(false) }, ['pointerdown', 'click'])
    const escape = (event: KeyboardEvent) => {
      dismissPopupOnEscape(event, () => {
        if (!pending.current) { setOpen(false); focusBack(); onCancel?.() }
      })
    }
    document.addEventListener('keydown', escape, true)
    return () => { disposeOutside(); document.removeEventListener('keydown', escape, true) }
  }, [open, onCancel, captureFocus, focusBack])
  useEffect(() => { if (mode === 'create' || renameId !== null) nameInput.current?.focus() }, [mode, renameId])
  useEffect(() => {
    if (open && !busy && (document.activeElement === document.body || document.activeElement === root.current?.closest('dialog'))) {
      (searchInput.current ?? popup.current?.querySelector<HTMLButtonElement>('button'))?.focus({ preventScroll: true })
    }
  }, [open, busy])
  const perform = async (action: () => void | Promise<unknown>) => {
    if (pending.current) return
    pending.current = true; setBusy(true); setError('')
    try { await action() }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'タグを変更できませんでした') }
    finally { pending.current = false; setBusy(false) }
  }
  const create = () => perform(async () => {
    const tag = await store.create(name, color ?? undefined)
    // Task assignment is a separate API operation; its failure must not undo the created Tag.
    setMode('select'); setName(''); setColor(undefined); setSearch('')
    await onChange([...new Set([...tagIds, tag.id])])
  })
  return <div ref={root} className={`tag-picker ${iconOnly ? 'tag-picker-icon' : ''}`}>
    <button ref={trigger} type="button" className={iconOnly ? 'timer-context-icon tag-picker-trigger' : 'tag-picker-trigger'}
      aria-label={label} aria-expanded={open} aria-haspopup="dialog" aria-controls={open ? id : undefined}
      title={iconOnly ? `${label}${chosen.length ? `：${chosen.map(tag => tag.name).join(' / ')}` : ''}` : undefined}
      disabled={disabled || busy} onClick={() => { setOpen(value => !value); setSearch(''); setMode('select'); setRenameId(null); setError('') }}>
      {iconOnly ? <><UiIcon name="tag" />{chosen.length > 0 ? (showSelection ? <><span className="timer-selection-label"><TagChip tag={chosen[0]} /></span>{chosen.length > 1 && <span className="timer-selection-extra">+{chosen.length - 1}</span>}</> : <span className="tag-count">{chosen.length}</span>) : showSelection && <span className="timer-selection-label timer-selection-empty">タグなし</span>}</> : <>{!chosen.length && emptyLabel ? <span className="tag-chips tag-empty">{emptyLabel}</span> : showAllSelected ? <span className="tag-chips">{chosen.map(tag => <TagChip key={tag.id} tag={tag} />)}</span> : <TagChips tags={chosen} maxVisible={variant ? 1 : undefined} />}<UiIcon name="chevronDown" /></>}
    </button>
    {open && <div ref={popup} id={id} style={position} className={`tag-picker-popup ${variant ? 'shared-picker-popup' : ''}`} role="dialog" aria-label={mode === 'manage' ? 'タグを管理' : label} aria-busy={busy || undefined}>
      {mode === 'manage' ? <>
        <div className="tag-picker-heading"><strong>タグを管理</strong><button type="button" disabled={busy} onClick={() => { setMode('select'); setRenameId(null); setError('') }}>戻る</button></div>
        <div className="tag-picker-options">{store.tags.map(tag => <div key={tag.id} className={`tag-management-row ${renameId === tag.id ? 'tag-management-edit' : ''}`}>
          {renameId === tag.id ? <><input ref={nameInput} aria-label="新しいタグ名" value={name} maxLength={255} disabled={busy} onChange={event => setName(event.target.value)} />
            <ColorPicker kind="tag" name={name} entityId={tag.id} value={color === undefined ? tag.color ?? null : color} onChange={setColor} disabled={busy} />
            <div className="tag-management-actions"><button type="button" className="primary-action" disabled={busy} onClick={() => void perform(async () => { await store.rename(tag.id, name, color); setRenameId(null) })}>保存</button>
            <button type="button" className="secondary-button" disabled={busy} onClick={() => setRenameId(null)}>キャンセル</button></div></>
            : <><TagChip tag={tag} /><button type="button" disabled={busy} aria-label={`${tag.name}の名前を変更`} onClick={() => { setRenameId(tag.id); setName(tag.name); setColor(undefined); setError('') }}>名前を変更</button>
              <button type="button" className="danger" disabled={busy} aria-label={`${tag.name}を削除`} onClick={() => { if (window.confirm('このタグを削除しますか？')) void perform(async () => { await store.remove(tag.id); if (tagIds.includes(tag.id)) await onChange(tagIds.filter(id => id !== tag.id)) }) }}>削除</button></>}
        </div>)}</div>
      </> : <>
        <input ref={searchInput} type="search" aria-label="タグを検索" placeholder="タグを検索..." value={search} onChange={event => setSearch(event.target.value)} />
        {chosen.length > 0 && <TagChips tags={chosen} colored />}
        <div className="tag-picker-options">{store.tags.filter(tag => tag.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(tag =>
          <label className={variant ? 'shared-picker-option' : undefined} key={tag.id}><input type="checkbox" disabled={disabled || busy} checked={tagIds.includes(tag.id)}
            onChange={() => void perform(() => onChange(tagIds.includes(tag.id) ? tagIds.filter(id => id !== tag.id) : [...tagIds, tag.id]))} /><TagChip tag={tag} /></label>)}
          {store.status === 'ready' && !store.tags.some(tag => tag.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())) && <p>該当するタグがありません</p>}
        </div>
        <button type="button" disabled={disabled || busy || !tagIds.length} onClick={() => void perform(() => onChange([]))}>タグをすべて解除</button>
        <div className="tag-picker-divider" />
        {mode === 'create' ? <div className="tag-create-form"><strong>新しいタグ</strong><label>タグ名<input ref={nameInput} value={name} maxLength={255} disabled={busy}
          onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); void create() } }} /></label>
          <ColorPicker kind="tag" name={name} value={color ?? null} onChange={setColor} disabled={busy} />
          <div className="tag-create-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => { setMode('select'); setColor(undefined); setError('') }}>キャンセル</button><button type="button" className="primary-action" disabled={disabled || busy} onClick={() => void create()}>作成</button></div></div>
          : <button type="button" className="tag-picker-create" disabled={disabled || busy} onClick={() => { setMode('create'); setName(''); setColor(undefined); setError('') }}>＋ 新しいタグを作成</button>}
        <button type="button" className="tag-picker-manage" disabled={busy} onClick={() => { setMode('manage'); setError('') }}>タグを管理</button>
      </>}
      {store.status === 'loading' && !store.tags.length && <p role="status">タグを読み込んでいます</p>}
      {store.status === 'error' && <p className="error" role="alert">タグを取得できませんでした。<button type="button" onClick={() => void store.reload()}>再取得</button></p>}
      {error && <p className="error" role="alert">{error}</p>}
    </div>}
  </div>
}
