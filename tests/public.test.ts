import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { handleApi } from '../server/api.ts'
import { type Env } from '../server/core.ts'
import { createPublicRepositoryReader, repositorySnapshotResponse } from '../server/public.ts'

const origin = 'https://dashboard.example'
const env = {
  APP_BASE_URL: origin,
  PUBLIC_REPOSITORY_CACHE: {
    getByName(name: string) {
      assert.equal(name, 'evan-windproof')
      return cache
    },
  },
} as unknown as Env
const read = createPublicRepositoryReader()
const cache = { fetch: () => repositorySnapshotResponse(read, env) }
const request = (path: string, method = 'GET') => handleApi(new Request(origin + path, { method }), env)
const row = {
  id: 1, name: 'public', full_name: 'Evan-Windproof/public', owner: { login: 'Evan-Windproof' },
  private: false, visibility: 'public', description: 'Public', language: 'C', stargazers_count: 3,
  forks_count: 1, open_issues_count: 0, archived: true, fork: true, permissions: { admin: true },
}
const failure = (status: number, message: string, headers?: HeadersInit) => Response.json({ message }, { status, headers })

test('public endpoint without a session paginates and exposes only allowlisted public owner metadata', async t => {
  const mockFetch = t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input))
    assert.equal(url.origin + url.pathname, 'https://api.github.com/users/Evan-Windproof/repos')
    assert.equal(new Headers(init?.headers).has('Authorization'), false)
    if (url.searchParams.get('page') === '1') return Response.json([
      row, { ...row, id: 2, private: true }, { ...row, id: 3, visibility: 'internal' },
      { ...row, id: 4, owner: { login: 'Someone-else' } },
    ], { headers: { Link: '<https://api.github.com/?page=2>; rel="next"' } })
    return Response.json([{ ...row, id: 5, name: 'another', full_name: 'Evan-Windproof/another' }])
  })
  const response = await request('/api/public/repositories')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Cache-Control'), 'public, max-age=0, must-revalidate')
  const { data } = await response.json() as { data: { total: number; repositories: Record<string, unknown>[] } }
  assert.equal(data.total, 2)
  assert.deepEqual(data.repositories.map(repo => repo.id), [1, 5])
  const repo = data.repositories[0]
  assert.deepEqual([repo.visibility, repo.stars, repo.forks, repo.archived, repo.fork], ['public', 3, 1, 1, 1])
  assert.deepEqual(repo.tags, [])
  assert.equal('permissions' in repo, false)
  assert.equal(mockFetch.mock.callCount(), 2)
})

test('private APIs still require sessions and public endpoint rejects writes', async () => {
  for (const path of ['/api/me', '/api/overview', '/api/repositories']) {
    const response = await request(path)
    assert.equal(response.status, 401)
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
  }
  const response = await request('/api/public/repositories', 'POST')
  assert.equal(response.status, 405)
  assert.equal(response.headers.get('Allow'), 'GET')
})

test('empty GitHub lists are valid and concurrent cold requests share one refresh', async t => {
  const read = createPublicRepositoryReader()
  const ready = Promise.withResolvers<Response>()
  const mockFetch = t.mock.method(globalThis, 'fetch', () => ready.promise)
  const pending = [read(env), read(env), read(env)]
  ready.resolve(Response.json([]))
  for (const result of await Promise.all(pending)) {
    assert.deepEqual(result.repositories, [])
    assert.equal(result.total, 0)
  }
  await read(env)
  assert.equal(mockFetch.mock.callCount(), 1)
})

test('a persisted snapshot survives coordinator eviction and refreshes at the configured TTL', async t => {
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  let cached: unknown
  const storage = {
    async get<T>() { return structuredClone(cached) as T | undefined },
    async put(_key: string, value: unknown) { cached = structuredClone(value) },
  }
  let next = [row]
  const mockFetch = t.mock.method(globalThis, 'fetch', async () => Response.json(next))
  const config = { ...env, PUBLIC_REPOSITORY_CACHE_TTL_SECONDS: '2' }
  const original = createPublicRepositoryReader(storage)
  assert.equal((await original(config)).total, 1)
  const another = createPublicRepositoryReader(storage)
  assert.equal((await another(config)).total, 1)
  assert.equal(mockFetch.mock.callCount(), 1)

  now += 3100
  next = []
  const pending: Promise<unknown>[] = []
  const ctx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise) } }
  const stale = await Promise.all([another(config, ctx), another(config, ctx)])
  assert.equal(stale[0].total, 1)
  assert.equal(stale[1].total, 1)
  await Promise.all(pending)
  assert.equal((await another(config)).total, 0)
  // One request loaded the original list and one refreshed it.
  assert.equal(mockFetch.mock.callCount(), 2)
})

test('403 rate limits and 5xx responses preserve the last good snapshot and respect backoff', async t => {
  const log = t.mock.method(console, 'warn', () => {})
  for (const status of [403, 503]) {
    const mockDate = t.mock.method(Date, 'now', Date.now)
    const read = createPublicRepositoryReader()
    let upstream = Response.json([row])
    const mockFetch = t.mock.method(globalThis, 'fetch', async () => upstream.clone())
    const initial = await read(env)
    mockDate.mock.mockImplementation(() => Date.parse(initial.fetchedAt) + 601_000)
    upstream = failure(status, 'API rate limit exceeded for diagnostic-test-value',
      status === 403 ? { 'x-ratelimit-remaining': '0', 'retry-after': '120' } : {})
    const pending = Promise.withResolvers<Promise<unknown>>()
    assert.deepEqual(await read(env, { waitUntil: promise => pending.resolve(promise) }), initial)
    await pending.promise
    assert.deepEqual(await read(env), initial)
    assert.equal(mockFetch.mock.callCount(), 2)
    assert.ok(!JSON.stringify(log.mock.calls.map(call => call.arguments)).includes('diagnostic-test-value'))
    mockFetch.mock.restore()
    mockDate.mock.restore()
  }
})

test('cold GitHub errors distinguish quota, permissions, auth, service failure, and malformed responses', async t => {
  t.mock.method(console, 'warn', () => {})
  for (const [upstream, code, status, retryAfter] of [
    [failure(403, 'API rate limit exceeded', { 'x-ratelimit-remaining': '0', 'retry-after': '60' }), 'PUBLIC_GITHUB_RATE_LIMIT', 429, 60],
    [failure(429, 'Too Many Requests', { 'retry-after': '90' }), 'PUBLIC_GITHUB_RATE_LIMIT', 429, 90],
    [failure(403, 'Resource not accessible by integration'), 'PUBLIC_GITHUB_ACCESS', 503, 30],
    [failure(401, 'Bad credentials'), 'PUBLIC_GITHUB_AUTH', 503, 30],
    [failure(502, 'Bad Gateway'), 'PUBLIC_GITHUB_UNAVAILABLE', 503, 30],
    [Response.json([{}]), 'PUBLIC_GITHUB_RESPONSE', 502, 30],
  ] as const) {
    const mock = t.mock.method(globalThis, 'fetch', async () => upstream)
    const read = createPublicRepositoryReader()
    await assert.rejects(read(env), { code, status, retryAfter })
    await assert.rejects(read(env), { code })
    assert.equal(mock.mock.callCount(), 1)
    mock.mock.restore()
  }
})

test('public fetch reuses a Metadata-only token for the owner’s verified App installation', async t => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const config = { ...env, GITHUB_APP_ID: '1', GITHUB_PRIVATE_KEY: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString() }
  const paths: string[] = []
  const mockFetch = t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input))
    paths.push(url.pathname)
    const authorization = new Headers(init?.headers).get('Authorization')
    if (url.pathname === '/users/Evan-Windproof/installation') {
      assert.match(authorization ?? '', /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/)
      return Response.json({ id: 17 })
    }
    if (url.pathname === '/app/installations/17/access_tokens') {
      assert.deepEqual(JSON.parse(String(init?.body)), { permissions: { metadata: 'read' } })
      return Response.json({ token: 'installation-test-only' })
    }
    assert.equal(authorization, 'Bearer installation-test-only')
    return Response.json([row, { ...row, id: 6, private: true }])
  })
  const result = await createPublicRepositoryReader()(config)
  assert.equal(result.total, 1)
  assert.ok(!JSON.stringify(result).includes('installation-test-only'))
  assert.deepEqual(paths, ['/users/Evan-Windproof/installation', '/app/installations/17/access_tokens', '/users/Evan-Windproof/repos'])
  assert.equal(mockFetch.mock.callCount(), 3)
})

test('uses the unauthenticated public endpoint when the owner has no App installation', async t => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const config = { ...env, GITHUB_APP_ID: '1', GITHUB_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }
  const mockFetch = t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname === '/users/Evan-Windproof/installation') return failure(404, 'Not Found')
    assert.equal(url.pathname, '/users/Evan-Windproof/repos')
    assert.equal(new Headers(init?.headers).has('Authorization'), false)
    return Response.json([row])
  })
  assert.equal((await createPublicRepositoryReader()(config)).total, 1)
  assert.equal(mockFetch.mock.callCount(), 2)
})
