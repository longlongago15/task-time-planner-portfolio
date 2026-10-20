export function apiBase(configured: string | undefined, development: boolean): string {
  return (configured ?? (development ? 'http://localhost:8000' : '')).trim().replace(/\/+$/, '')
}

export const API = apiBase(import.meta.env?.VITE_API_BASE_URL, import.meta.env?.DEV ?? false)
