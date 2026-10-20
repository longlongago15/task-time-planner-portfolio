import { API } from './api'
import { createContext, useContext, useEffect, useRef, useState } from 'react'

export type Tag = { id: number; name: string; color?: string | null }

type TagChange = { tag: Tag } | { deletedId: number }

export function useTagStore(onChange: (change: TagChange) => void) {
  const [tags, setTags] = useState<Tag[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const callback = useRef(onChange)
  useEffect(() => { callback.current = onChange }, [onChange])
  const generation = useRef(0)
  const sort = (values: Tag[]) => [...values].sort((a, b) => a.name.localeCompare(b.name, 'ja') || a.id - b.id)
  const reload = async () => {
    const version = ++generation.current
    setStatus('loading')
    try {
      const response = await fetch(`${API}/tags`)
      if (!response.ok) throw new Error()
      const values: Tag[] = await response.json()
      if (!Array.isArray(values) || values.some(tag => !Number.isInteger(tag.id) || typeof tag.name !== 'string')) throw new Error()
      if (version === generation.current) { setTags(sort(values)); setStatus('ready') }
    } catch { if (version === generation.current) setStatus('error') }
  }
  useEffect(() => { void reload(); return () => { generation.current += 1 } }, [])
  const request = async (method: string, id?: number, name?: string, color?: string | null): Promise<Tag> => {
    const trimmed = name?.trim()
    if (name !== undefined && (!trimmed || trimmed.length > 255)) throw new Error('タグ名は1〜255文字で入力してください')
    let response: Response
    try { response = await fetch(`${API}/tags${id === undefined ? '' : `/${id}`}`, { method,
      ...(trimmed === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: trimmed, ...(color === undefined ? {} : { color }) }) }) }) }
    catch { throw new Error('タグを保存できませんでした。接続を確認して再試行してください') }
    if (!response.ok) throw new Error(response.status === 409 ? '同じタグ名が登録されています' : response.status === 404 ? 'タグが見つかりません。再取得してください' : 'タグを保存できませんでした。再試行してください')
    const tag = await response.json() as Tag
    generation.current += 1
    if (method === 'DELETE') {
      setTags(current => current.filter(value => value.id !== id))
      callback.current({ deletedId: id! })
    } else {
      setTags(current => sort([...current.filter(value => value.id !== tag.id), tag]))
      callback.current({ tag })
    }
    // Refresh the shared catalog after a mutation without blocking its confirmed result.
    void reload()
    return tag
  }
  return { tags, status, reload, create: (name: string, color?: string | null) => request('POST', undefined, name, color),
    rename: (id: number, name: string, color?: string | null) => request('PATCH', id, name, color), remove: (id: number) => request('DELETE', id) }
}

export const TagContext = createContext<ReturnType<typeof useTagStore> | null>(null)
export function useTags() {
  const store = useContext(TagContext)
  if (!store) throw new Error('Tag controls require TagContext')
  return store
}
