import { ApiError, json, type Env } from './core.ts'
import { publicOwnerToken } from './github.ts'

type Repo = {
  id: number
  name: string
  full_name: string
  owner: { login: string }
  private: boolean
  visibility?: string
  description: string | null
  language: string | null
  stargazers_count: number
  forks_count: number
  open_issues_count: number
  default_branch: string | null
  created_at: string | null
  updated_at: string | null
  pushed_at: string | null
  archived: boolean
  fork: boolean
}

const owner = 'Evan-Windproof'
const defaultTtlSeconds = 600
const maxStaleSeconds = 24 * 60 * 60
const failureDelaySeconds = 30

function publicMetadata(repo: Repo, fetchedAt: string) {
  return {
    id: repo.id, owner: repo.owner.login, name: repo.name, full_name: repo.full_name,
    description: typeof repo.description === 'string' ? repo.description : null,
    url: `https://github.com/${repo.full_name}`, visibility: 'public',
    language: typeof repo.language === 'string' ? repo.language : null,
    stars: Number(repo.stargazers_count) || 0, forks: Number(repo.forks_count) || 0,
    open_issues: Number(repo.open_issues_count) || 0,
    default_branch: typeof repo.default_branch === 'string' ? repo.default_branch : null,
    created_at: typeof repo.created_at === 'string' ? repo.created_at : null,
    updated_at: typeof repo.updated_at === 'string' ? repo.updated_at : null,
    pushed_at: typeof repo.pushed_at === 'string' ? repo.pushed_at : null,
    archived: Number(Boolean(repo.archived)), fork: Number(Boolean(repo.fork)), synced_at: fetchedAt, tags: [],
  }
}

type Snapshot = { repositories: ReturnType<typeof publicMetadata>[]; fetchedAt: string; total: number }
type Failure = { status: number; code: string; message: string; retryAt: number }
type Cached = { snapshot?: Snapshot; failure?: Failure }

function ttlSeconds(env: Env) {
  const value = Number(env.PUBLIC_REPOSITORY_CACHE_TTL_SECONDS)
  return Number.isInteger(value) && value > 0 && value < maxStaleSeconds ? value : defaultTtlSeconds
}

async function publicGitHubError(response: Response) {
  const remaining = response.headers.get('x-ratelimit-remaining')
  const retry = response.headers.get('retry-after')
  const reset = response.headers.get('x-ratelimit-reset')
  const body = await response.json<{ message?: unknown }>().catch(() => null)
  const message = typeof body?.message === 'string' ? body.message : ''
  const limited = response.status === 429 ||
    (response.status === 403 && (remaining === '0' || retry !== null || /rate limit|abuse detection/i.test(message)))
  console.warn('Public GitHub repository request failed', {
    upstreamStatus: response.status, rateLimited: limited, quotaExhausted: remaining === '0',
  })
  if (limited) {
    const retryDelay = retry && /^\d+$/.test(retry) ? Number(retry)
      : retry ? Math.ceil((Date.parse(retry) - Date.now()) / 1000) : NaN
    const resetDelay = remaining === '0' && reset && /^\d+$/.test(reset)
      ? Math.ceil(Number(reset) - Date.now() / 1000) : NaN
    const delays = [retryDelay, resetDelay].filter(Number.isFinite)
    const retryAfter = delays.length ? Math.max(1, ...delays) : 60
    return new ApiError(429, 'PUBLIC_GITHUB_RATE_LIMIT', 'GitHub public repository data is temporarily rate limited.', retryAfter)
  }
  if (response.status === 401) {
    return new ApiError(503, 'PUBLIC_GITHUB_AUTH', 'GitHub rejected authentication for public repository data.')
  }
  if (response.status === 403) {
    return new ApiError(503, 'PUBLIC_GITHUB_ACCESS', 'GitHub denied access to public repository data.')
  }
  return new ApiError(503, 'PUBLIC_GITHUB_UNAVAILABLE', 'GitHub could not provide public repository data. Try again shortly.')
}

async function fetchSnapshot(env: Env): Promise<Snapshot> {
  const token = await publicOwnerToken(env, owner)
  const headers = {
    Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Evan-Developer-Dashboard',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
  const fetchedAt = new Date(Date.now()).toISOString()
  const repositories = new Map<number, ReturnType<typeof publicMetadata>>()
  for (let page = 1; page <= 100; page++) {
    const url = `https://api.github.com/users/${owner}/repos?type=owner&sort=updated&per_page=100&page=${page}`
    let response: Response
    try {
      response = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(12_000) })
    } catch {
      throw new ApiError(503, 'PUBLIC_GITHUB_UNAVAILABLE', 'Public GitHub data is temporarily unavailable. Try again shortly.')
    }
    if (!response.ok) throw await publicGitHubError(response)

    const payload: unknown = await response.json().catch(() => null)
    if (!Array.isArray(payload)) break
    for (const repo of payload as Repo[]) {
      if (typeof repo?.private !== 'boolean') {
        throw new ApiError(502, 'PUBLIC_GITHUB_RESPONSE', 'GitHub returned unreadable repository visibility.')
      }
      if (repo.private || (repo.visibility !== undefined && repo.visibility !== 'public')) continue
      if (typeof repo.owner?.login !== 'string') {
        throw new ApiError(502, 'PUBLIC_GITHUB_RESPONSE', 'GitHub returned unreadable repository ownership.')
      }
      if (repo.owner.login.toLowerCase() !== owner.toLowerCase()) continue
      if (!Number.isSafeInteger(repo.id) || repo.id < 1 || typeof repo.name !== 'string' ||
          typeof repo.full_name !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo.full_name) ||
          repo.full_name.toLowerCase() !== `${owner}/${repo.name}`.toLowerCase()) {
        throw new ApiError(502, 'PUBLIC_GITHUB_RESPONSE', 'GitHub returned unreadable public repository metadata.')
      }
      repositories.set(repo.id, publicMetadata(repo, fetchedAt))
    }
    if (!/rel="next"/.test(response.headers.get('Link') ?? '')) {
      return { repositories: [...repositories.values()], fetchedAt, total: repositories.size }
    }
  }
  throw new ApiError(502, 'PUBLIC_GITHUB_RESPONSE', 'GitHub returned an incomplete public repository list.')
}

export function createPublicRepositoryReader(storage?: {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: Cached): Promise<void>
}) {
  let cached: Cached = {}
  let initialized: Promise<void> | undefined
  let inFlight: Promise<Snapshot> | undefined

  function failureError(failure: Failure) {
    return new ApiError(failure.status, failure.code, failure.message, Math.max(1, Math.ceil((failure.retryAt - Date.now()) / 1000)))
  }

  async function refresh(env: Env, previous?: Snapshot) {
    try {
      cached = { snapshot: await fetchSnapshot(env) }
    } catch (error) {
      const failure = error instanceof ApiError ? error
        : new ApiError(503, 'PUBLIC_GITHUB_UNAVAILABLE', 'Public GitHub data is temporarily unavailable. Try again shortly.')
      cached = {
        snapshot: previous,
        failure: { status: failure.status, code: failure.code, message: failure.message,
          retryAt: Date.now() + (failure.retryAfter ?? failureDelaySeconds) * 1000 },
      }
    }
    await storage?.put('public-repositories', cached)
    if (cached.snapshot) return cached.snapshot
    throw failureError(cached.failure!)
  }

  return async function read(env: Env, ctx?: Pick<ExecutionContext, 'waitUntil'>): Promise<Snapshot> {
    if (storage) {
      initialized ??= storage.get<Cached>('public-repositories').then(stored => {
        if (stored) cached = stored
      }).catch(error => {
        initialized = undefined
        throw error
      })
      await initialized
    }
    const snapshot = cached.snapshot
    const age = snapshot ? Date.now() - Date.parse(snapshot.fetchedAt) : Infinity
    if (snapshot && age < ttlSeconds(env) * 1000) return snapshot
    const previous = age < maxStaleSeconds * 1000 ? snapshot : undefined
    const failure = cached.failure
    if (failure && failure.retryAt > Date.now()) {
      if (previous) return previous
      throw failureError(failure)
    }
    inFlight ??= refresh(env, previous).finally(() => { inFlight = undefined })
    if (previous) {
      const pending = inFlight.catch(() => undefined)
      ctx?.waitUntil(pending)
      return previous
    }
    return inFlight
  }
}

export async function repositorySnapshotResponse(
  read: ReturnType<typeof createPublicRepositoryReader>, env: Env, ctx?: Pick<ExecutionContext, 'waitUntil'>,
) {
  try {
    return json(await read(env, ctx))
  } catch (error) {
    if (!(error instanceof ApiError)) throw error
    const response = Response.json({ error: { code: error.code, message: error.message } }, { status: error.status })
    if (error.retryAfter) response.headers.set('Retry-After', String(error.retryAfter))
    return response
  }
}

export async function publicRepositoryResponse(env: Env) {
  const cache = env.PUBLIC_REPOSITORY_CACHE.getByName('evan-windproof')
  const response = await cache.fetch('https://repository-cache.internal/')
  return new Response(response.body, response)
}
