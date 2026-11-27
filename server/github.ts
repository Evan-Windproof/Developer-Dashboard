import { ApiError, base64url, bytes, encoder, seconds, type Env } from './core.ts'

const api = 'https://api.github.com'
export const oauth = 'https://github.com/login/oauth'
export type GitHubUser = { id: number; login: string; avatar_url: string; name: string | null }
export type Installation = {
  id: number
  account: { id: number; login: string; type: string }
  repository_selection: string
}
export type GitHubRepository = {
  id: number
  owner: { login: string }
  name: string
  full_name: string
  description: string | null
  html_url: string
  private: boolean
  visibility?: 'public' | 'private' | 'internal'
  language?: string | null
  stargazers_count: number
  forks_count: number
  open_issues_count: number
  default_branch?: string
  created_at?: string
  updated_at?: string
  pushed_at?: string
  archived: boolean
  fork: boolean
}

export type Token = { access: string; expires: number | null; refresh?: string; refreshExpires?: number }
type OAuthResponse = {
  access_token?: string
  expires_in?: number
  refresh_token?: string
  refresh_token_expires_in?: number
  error?: string
}

async function call(url: string, init: RequestInit, oauthCall = false) {
  let response: Response
  try {
    response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(12_000) })
  } catch {
    throw new ApiError(503, 'GITHUB_UNAVAILABLE', 'GitHub is temporarily unavailable. Try again shortly.')
  }
  const retry = response.headers.get('retry-after')
  if (response.status === 429 || (response.status === 403 && (retry || response.headers.get('x-ratelimit-remaining') === '0'))) {
    const reset = response.headers.get('x-ratelimit-reset')
    const delay = retry ? Number(retry) : reset ? Number(reset) - seconds() : 60
    throw new ApiError(429, 'GITHUB_RATE_LIMIT', 'GitHub rate limit reached. Try again after the indicated delay.',
      Number.isFinite(delay) ? Math.max(1, Math.ceil(delay)) : 60)
  }
  if (!response.ok) {
    if (oauthCall && response.status === 400) return response
    if (response.status === 401) throw new ApiError(401, 'GITHUB_REAUTH', 'Reconnect your GitHub account.')
    if (response.status === 403 || response.status === 404) {
      // GitHub may send secondary-limit errors without a remaining count or retry header.
      const body = await response.json<{ message?: string }>().catch(() => null)
      if (/rate limit|abuse detection/i.test(body?.message ?? '')) {
        throw new ApiError(429, 'GITHUB_RATE_LIMIT', 'GitHub rate limit reached. Try again shortly.', 60)
      }
      throw new ApiError(403, 'GITHUB_ACCESS', 'GitHub denied access. Check the app installation and permissions.')
    }
    throw new ApiError(503, 'GITHUB_UNAVAILABLE', 'GitHub is temporarily unavailable. Try again shortly.')
  }
  return response
}

export async function exchange(env: Env, payload: Record<string, string>): Promise<Token> {
  const response = await call(`${oauth}/access_token`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, ...payload }),
  }, true)
  const data = await response.json<OAuthResponse>()
  if (!data.access_token || data.error) throw new ApiError(401, 'GITHUB_REAUTH', 'GitHub authorization expired or was declined. Sign in again.')
  return {
    access: data.access_token,
    expires: data.expires_in ? seconds() + data.expires_in : null,
    refresh: data.refresh_token,
    refreshExpires: data.refresh_token_expires_in ? seconds() + data.refresh_token_expires_in : undefined,
  }
}

async function github(path: string, token: string, payload?: object) {
  return call(`${api}${path}`, {
    method: payload ? 'POST' : 'GET',
    body: payload ? JSON.stringify(payload) : undefined,
    headers: {
      ...(payload ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Evan-Developer-Dashboard',
    },
  })
}

export const githubUser = async (token: string) => (await github('/user', token)).json<GitHubUser>()

async function paginate<T>(path: string, token: string, field: 'installations' | 'repositories', deadline: number) {
  const results: T[] = []
  for (let page = 1; ; page++) {
    if (Date.now() >= deadline) throw new ApiError(503, 'SYNC_TIMEOUT', 'GitHub took too long to respond. Try syncing again.')
    const response = await github(`${path}?per_page=100&page=${page}`, token)
    const data = await response.json<Record<typeof field, T[]>>()
    results.push(...data[field])
    if (!/rel="next"/.test(response.headers.get('Link') ?? '')) return results
  }
}

export const installations = (token: string, deadline = Date.now() + 90_000) =>
  paginate<Installation>('/user/installations', token, 'installations', deadline)

export async function userRepositoryIds(id: number, token: string, deadline: number) {
  const repos = await paginate<{ id: number }>(`/user/installations/${id}/repositories`, token, 'repositories', deadline)
  return new Set(repos.map(repo => repo.id))
}

export const appRepositories = (token: string, deadline: number) =>
  paginate<GitHubRepository>('/installation/repositories', token, 'repositories', deadline)

// Web Crypto imports PKCS#8. GitHub-generated PEMs contain PKCS#1 RSA keys.
function der(tag: number, body: Uint8Array) {
  const length = body.length
  const prefix = length < 128 ? [length] : length < 256 ? [0x81, length] : [0x82, length >> 8, length & 255]
  return Uint8Array.of(tag, ...prefix, ...body)
}

async function appJwt(env: Env) {
  const pem = env.GITHUB_PRIVATE_KEY.replaceAll('\\n', '\n')
  const keyBytes = bytes(pem.replace(/-----[^-]+-----|\s/g, ''))
  const pkcs8 = pem.includes('BEGIN RSA PRIVATE KEY')
    ? der(0x30, Uint8Array.of(2, 1, 0, 48, 13, 6, 9, 42, 134, 72, 134, 247, 13, 1, 1, 1, 5, 0, ...der(4, keyBytes)))
    : keyBytes
  const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  const now = seconds()
  const encode = (value: object) => base64url(encoder.encode(JSON.stringify(value)))
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 540, iss: env.GITHUB_APP_ID })}`
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(unsigned))
  return `${unsigned}.${base64url(new Uint8Array(signature))}`
}

export async function installationToken(env: Env, id: number) {
  try {
    const response = await github(`/app/installations/${id}/access_tokens`, await appJwt(env), { permissions: { metadata: 'read' } })
    return (await response.json<{ token: string }>()).token
  } catch (error) {
    if (error instanceof ApiError && error.code === 'GITHUB_REAUTH') {
      throw new ApiError(503, 'GITHUB_APP_CONFIG', 'GitHub rejected the dashboard app credentials.')
    }
    throw error
  }
}
