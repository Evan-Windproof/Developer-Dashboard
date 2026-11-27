/// <reference types="vite/client" />
export interface Account {
  github_id: number
  login: string
  avatar_url: string | null
  display_name: string | null
}

export interface Repository {
  id: number
  owner: string
  name: string
  full_name: string
  description: string | null
  url: string
  visibility: 'public' | 'private' | 'internal'
  language: string | null
  stars: number
  forks: number
  open_issues: number
  default_branch: string | null
  created_at: string | null
  updated_at: string | null
  pushed_at: string | null
  archived: number
  fork: number
  synced_at: string
}

export interface Overview {
  stats: Record<'total' | 'public' | 'private' | 'archived' | 'stars' | 'forks', number>
  recent: Repository[]
  languages: string[]
  lastSync: string | null
  accessExpired: boolean
}

export interface RepositoryPage {
  repositories: Repository[]
  total: number
  page: number
  pageSize: number
}

export class RequestError extends Error {
  constructor(public code: string, message: string, public retryAfter?: number) {
    super(message)
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      headers: { 'X-Dashboard-Request': '1' },
    })
  } catch (error) {
    if (init?.signal?.aborted) throw error
    throw new RequestError('NETWORK', 'Unable to reach the dashboard. Check your connection and try again.')
  }
  const payload = await response.json().catch(() => null) as { data?: T; error?: { code?: string; message?: string } } | null
  if (!response.ok || !payload || !('data' in payload)) {
    throw new RequestError(payload?.error?.code ?? 'UNAVAILABLE', payload?.error?.message ?? 'The dashboard is temporarily unavailable.',
      Number(response.headers.get('Retry-After')) || undefined)
  }
  return payload.data as T
}
