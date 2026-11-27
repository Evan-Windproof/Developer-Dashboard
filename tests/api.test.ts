import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { handleApi } from '../server/api.ts'
import { hash, seconds, type Env } from '../server/core.ts'

const origin = 'https://dashboard.example'
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const mf = new Miniflare(convertV4MiniflareOptions({
  modules: true,
  script: 'export default { fetch() { return new Response("ready") } }',
  d1Databases: ['DB'],
}))
const originalFetch = globalThis.fetch
let db: D1Database
let env: Env
const accessA = 'mocked-test-user-a'
const accessB = 'mocked-test-user-b'
const refreshToken = 'mocked-test-refresh-token'
const installToken = 'mocked-test-installation-token'
const installation = { id: 101, account: { id: 98, login: 'shared-org', type: 'Organization' }, repository_selection: 'selected' }
const otherInstallation = { ...installation, id: 103 }
function repo(id: number, name: string, overrides: Record<string, unknown> = {}) {
  return {
    id, owner: { login: 'shared-org' }, name, full_name: `shared-org/${name}`, description: 'Utilities',
    html_url: `https://github.com/shared-org/${name}`, visibility: 'private', private: true, language: 'TypeScript',
    stargazers_count: 2, forks_count: 4, open_issues_count: 1, default_branch: 'main',
    created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-02T00:00:00Z', pushed_at: '2024-01-02T00:00:00Z',
    archived: false, fork: false, ...overrides,
  }
}
const first = repo(501, 'alpha', { description: 'Build_kit' })
const second = repo(502, 'beta', { private: false, visibility: 'public', archived: true, fork: true, language: 'Go', stargazers_count: 9 })
const third = repo(503, 'gamma', { description: null })
let authCookieA: string
let authCookieB: string
let calls: string[] = []
let userARepos = [first, second]
let githubFailure: 'none' | 'network' | 'rate' | 'denied' = 'none'
let expireUserToken = false
let appRepoPages = [[first], [second, third]]
let holdDiscovery: (() => Promise<void>) | undefined


function fakeResponse(data: unknown, status = 200, next = false) {
  return Response.json(data, { status, headers: next ? { Link: '<https://api.github.com/?page=2>; rel="next"' } : {} })
}

before(async () => {
  db = await mf.getD1Database('DB') as unknown as D1Database
  const migration = await readFile(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8')
  // Use D1's transactional batch so SQLite runs the production migration and constraints.
  await db.batch(migration.split(';').map(statement => statement.trim()).filter(Boolean).map(statement => db.prepare(statement)))
  env = {
    DB: db, APP_BASE_URL: origin, GITHUB_APP_SLUG: 'example-dashboard',
    GITHUB_APP_ID: '1', GITHUB_CLIENT_ID: 'mock-client-id', GITHUB_CLIENT_SECRET: 'mock-client-secret',
    GITHUB_PRIVATE_KEY: keys.privateKey.export({ format: 'pem', type: 'pkcs1' }).toString(),
    SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 17).toString('base64'),
  }
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (!['github.com', 'api.github.com'].includes(url.hostname)) return originalFetch(input, init)
    const auth = new Headers(init?.headers).get('Authorization')
    calls.push(url.pathname + url.search)
    if (url.pathname === '/login/oauth/access_token') {
      const params = new URLSearchParams(String(init?.body))
      assert.equal(params.get('client_secret'), env.GITHUB_CLIENT_SECRET)
      if (params.get('grant_type') === 'refresh_token') {
        assert.equal(params.get('refresh_token'), refreshToken)
        return fakeResponse({ access_token: accessA, expires_in: 24_000, refresh_token: 'rotated-test-token' })
      }
      assert.equal(params.get('redirect_uri'), origin + '/api/auth/github/callback')
      assert.match(params.get('code_verifier') ?? '', /^[\w-]{43}$/)
      return fakeResponse(params.get('code') === 'a'
        ? { access_token: accessA, expires_in: expireUserToken ? 1 : 24_000, refresh_token: refreshToken }
        : { access_token: accessB })
    }
    const alice = auth === `Bearer ${accessA}`
    if (url.pathname === '/user') return fakeResponse({ id: alice ? 77 : 88, login: alice ? 'alice' : 'bob', avatar_url: null, name: null })
    if (url.pathname === '/user/installations') {
      if (holdDiscovery) await holdDiscovery()
      if (githubFailure === 'network') throw new Error('offline')
      if (githubFailure === 'rate') return Response.json({}, { status: 429, headers: { 'Retry-After': '120' } })
      if (githubFailure === 'denied') return fakeResponse({}, 401)
      return fakeResponse({ installations: [installation] })
    }
    if (url.pathname === '/user/installations/101/repositories') {
      return fakeResponse({ repositories: alice ? userARepos : [third] })
    }
    if (url.pathname === '/app/installations/101/access_tokens') {
      assert.equal(init?.method, 'POST')
      assert.deepEqual(JSON.parse(String(init?.body)), { permissions: { metadata: 'read' } })
      const [header, payload, signature] = auth!.slice(7).split('.')
      assert.equal(JSON.parse(Buffer.from(payload, 'base64url').toString()).iss, '1')
      assert.equal(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), createPublicKey(keys.privateKey), Buffer.from(signature, 'base64url')), true)
      return fakeResponse({ token: installToken }, 201)
    }
    if (url.pathname === '/installation/repositories') {
      assert.equal(auth, `Bearer ${installToken}`)
      const page = Number(url.searchParams.get('page'))
      return fakeResponse({ repositories: appRepoPages[page - 1] }, 200, page < appRepoPages.length)
    }
    throw new Error(`Unexpected request ${url.pathname}`)
  }
})

after(async () => {
  globalThis.fetch = originalFetch
  await mf.dispose()
})

function request(path: string, options: { cookie?: string; method?: string; origin?: string; dashboard?: boolean; body?: string } = {}) {
  const headers = new Headers()
  if (options.cookie) headers.set('Cookie', options.cookie)
  if (options.origin) headers.set('Origin', options.origin)
  if (options.dashboard) headers.set('X-Dashboard-Request', '1')
  return handleApi(new Request(origin + path, { headers, method: options.method, body: options.body }), env)
}

async function body<T = unknown>(response: Response) {
  return await response.json() as T
}

const findCookie = (response: Response, name: string) =>
  response.headers.getSetCookie().find(value => value.startsWith(`__Host-${name}=`))!.split(';')[0]

async function loginStart() {
  const response = await request('/api/auth/github/start')
  assert.equal(response.status, 302)
  assert.match(response.headers.get('Set-Cookie')!, /HttpOnly; SameSite=Lax; Secure/)
  const url = new URL(response.headers.get('Location')!)
  const state = url.searchParams.get('state')!
  const cookie = findCookie(response, 'dashboard_login')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('code_challenge'), await hash(cookie.split('.')[1]))
  return { state, cookie }
}

const loginReturn = (input: { state: string; cookie: string }, code = 'a') =>
  request(`/api/auth/github/callback?code=${code}&state=${input.state}`, { cookie: input.cookie })

async function installReturn(cookie: string, id: number) {
  const response = await request('/api/github/installations/install-url', { cookie, dashboard: true })
  const payload = await body<{ data: { url: string } }>(response)
  const state = new URL(payload.data.url).searchParams.get('state')
  const stateCookie = findCookie(response, 'dashboard_install')
  return request(`/api/github/installation/callback?installation_id=${id}&setup_action=install&state=${state}`,
    { cookie: `${cookie}; ${stateCookie}` })
}

async function resetSync() {
  await db.prepare('UPDATE users SET sync_started = NULL, sync_retry_at = NULL').run()
}
const sync = (cookie: string) => request('/api/repositories/sync', { method: 'POST', cookie, origin })
type Results = { data: { repositories: { id: number }[]; total: number } }
const get = (path: string, cookie = authCookieA) => request(path, { cookie })

test('migration applies, health responds, and D1 rejects invalid relationships', async () => {
  const health = await request('/api/health')
  assert.equal(health.status, 200)
  assert.equal(health.headers.get('Cache-Control'), 'no-store')
  await assert.rejects(db.prepare('INSERT INTO user_installations VALUES (42, 101)').run(), /FOREIGN KEY/)
})

test('protected endpoints require a session and mutations require a same-origin request', async () => {
  for (const path of ['/api/me', '/api/overview', '/api/repositories', '/api/repositories/501', '/api/github/installations']) {
    assert.equal((await request(path)).status, 401)
  }
  assert.equal((await request('/api/repositories/sync', { method: 'POST', origin })).status, 401)
  assert.equal((await request('/api/auth/logout', { method: 'POST', origin: 'https://example.net' })).status, 403)
  assert.equal((await request('/api/repositories/sync', { method: 'POST', origin, body: '{}' })).status, 400)
  const method = await request('/api/repositories/sync')
  assert.equal(method.status, 405)
  assert.equal(method.headers.get('Allow'), 'POST')
  assert.equal(method.headers.get('Access-Control-Allow-Origin'), null)
})

test('OAuth state is browser-bound, invalid or expired states are rejected, and valid states are single-use', async () => {
  const firstFlow = await loginStart()
  assert.match((await loginReturn({ ...firstFlow, cookie: 'invalid' })).headers.get('Location')!, /INVALID_STATE/)
  const expired = await loginStart()
  await db.prepare('UPDATE oauth_states SET expires_at = ? WHERE hash = ?').bind(seconds() - 1, await hash(expired.state)).run()
  assert.match((await loginReturn(expired)).headers.get('Location')!, /INVALID_STATE/)
  expireUserToken = true
  const success = await loginReturn(firstFlow)
  expireUserToken = false
  assert.equal(success.headers.get('Location'), '/')
  authCookieA = findCookie(success, 'dashboard_session')
  assert.match((await loginReturn(firstFlow)).headers.get('Location')!, /INVALID_STATE/)
  authCookieB = findCookie(await loginReturn(await loginStart(), 'b'), 'dashboard_session')
})

test('identity is isolated and tokens are encrypted and absent from client responses', async () => {
  const identity = await (await get('/api/me')).text()
  assert.equal(JSON.parse(identity).data.login, 'alice')
  assert.equal(JSON.parse(await (await get('/api/me', authCookieB)).text()).data.login, 'bob')
  const stored = await db.prepare('SELECT encrypted FROM github_credentials').all<{ encrypted: string }>()
  for (const token of [accessA, accessB, installToken, refreshToken, env.GITHUB_CLIENT_SECRET]) {
    assert.ok(!identity.includes(token))
    assert.ok(stored.results.every(row => !row.encrypted.includes(token)))
  }
  const sessions = await db.prepare('SELECT id_hash FROM sessions').all<{ id_hash: string }>()
  assert.ok(sessions.results.some(row => row.id_hash !== authCookieA.split('=')[1]))
})

test('installation callback requires GitHub verification and rotates expired GitHub credentials', async () => {
  assert.match((await installReturn(authCookieA, otherInstallation.id)).headers.get('Location')!, /INSTALLATION_FORBIDDEN/)
  assert.deepEqual(await body(await get('/api/github/installations')), { data: [] })
  assert.match((await installReturn(authCookieA, installation.id)).headers.get('Location')!, /github=installed/)
  assert.equal(calls.filter(path => path === '/login/oauth/access_token').length, 3)
  const response = await get('/api/github/installations')
  assert.match(await response.text(), /shared-org/)
  assert.deepEqual(await body(await get('/api/github/installations', authCookieB)), { data: [] })
})

test('sync pages GitHub results and grants overlapping installations only their per-user repository access', async () => {
  calls = []
  const firstSync = await sync(authCookieA)
  assert.equal(firstSync.status, 200, await firstSync.clone().text())
  assert.match(await firstSync.text(), /"total":2/)
  assert.equal((await sync(authCookieB)).status, 200)
  assert.ok(calls.includes('/installation/repositories?per_page=100&page=2'))
  assert.equal((await get('/api/repositories/503')).status, 404)
  assert.equal((await get('/api/repositories/501', authCookieB)).status, 404)
  assert.equal((await get('/api/repositories/503', authCookieB)).status, 200)
  assert.equal((await get('/api/repositories/501')).status, 200)
  const list = await body<Results>(await get('/api/repositories'))
  assert.deepEqual(list.data.repositories.map(row => row.id), [501, 502])
  const overview = await body<{ data: { stats: Record<string, number>; lastSync: string } }>(await get('/api/overview'))
  assert.deepEqual(overview.data.stats, { total: 2, private: 1, public: 1, archived: 1, stars: 11, forks: 8 })
  assert.ok(overview.data.lastSync)
  await assert.rejects(db.prepare('INSERT INTO user_repository_access VALUES (1, 101, 5000)').run(), /FOREIGN KEY/)
})

test('repository list searches descriptions, escapes wildcards, combines filters, sorts and paginates', async () => {
  const cases = [
    ['?q=build_kit', [501]], ['?q=shared-org%2Fbeta', [502]], ['?q=%25', []],
    ['?visibility=public&archived=true&fork=true&language=go', [502]],
    ['?visibility=private&archived=false&fork=false&language=TypeScript', [501]],
    ['?sort=stars&pageSize=1&page=1', [502]], ['?sort=stars&pageSize=1&page=2', [501]],
    ['?sort=name', [501, 502]], ['?sort=created', [501, 502]], ['?sort=forks', [501, 502]],
  ] as const
  for (const [query, ids] of cases) {
    const response = await get('/api/repositories' + query)
    assert.equal(response.status, 200, await response.clone().text())
    const result = await body<Results>(response)
    assert.deepEqual(result.data.repositories.map(row => row.id), ids, query)
  }
  assert.equal((await get('/api/repositories?sort=credits')).status, 400)
  assert.equal((await get('/api/repositories?pageSize=101')).status, 400)
})

test('temporary failures preserve a successful snapshot, rate limits back off, and reruns remove revoked repos per user', async () => {
  await resetSync()
  githubFailure = 'network'
  assert.equal((await sync(authCookieA)).status, 503)
  assert.equal((await get('/api/repositories/501')).status, 200)
  await resetSync()
  githubFailure = 'rate'
  const limited = await sync(authCookieA)
  assert.equal(limited.status, 429)
  assert.equal(limited.headers.get('Retry-After'), '120')
  const count = calls.length
  const backoff = await sync(authCookieA)
  assert.equal(backoff.status, 429)
  assert.equal(calls.length, count)
  await resetSync()
  githubFailure = 'none'
  userARepos = [second]
  assert.equal((await sync(authCookieA)).status, 200)
  assert.equal((await get('/api/repositories/501')).status, 404)
  assert.equal((await get('/api/repositories/503', authCookieB)).status, 200)
})

test('stale snapshots and confirmed revocations stop serving repository data', async () => {
  await db.prepare("UPDATE users SET last_sync = '2020-01-01T00:00:00.000Z' WHERE login = 'alice'").run()
  assert.equal((await get('/api/repositories/502')).status, 404)
  assert.equal((await body<Results>(await get('/api/repositories'))).data.total, 0)
  await resetSync()
  githubFailure = 'none'
  assert.equal((await sync(authCookieA)).status, 200)
  assert.equal((await get('/api/repositories/502')).status, 200)
  await resetSync()
  githubFailure = 'denied'
  assert.equal((await sync(authCookieA)).status, 401)
  assert.equal((await get('/api/repositories/502')).status, 404)
  assert.equal((await get('/api/repositories/503', authCookieB)).status, 200)
  githubFailure = 'none'
})

test('a 250-repository sync builds a coherent snapshot and rejects a concurrent sync', { timeout: 5000 }, async () => {
  await resetSync()
  const repos = Array.from({ length: 250 }, (_, index) => repo(1000 + index, `project-${index}`))
  userARepos = repos
  appRepoPages = [repos.slice(0, 100), repos.slice(100, 200), repos.slice(200)]
  const started = Promise.withResolvers<void>()
  const continueSync = Promise.withResolvers<void>()
  holdDiscovery = () => {
    started.resolve()
    return continueSync.promise
  }
  const firstSync = sync(authCookieA)
  try {
    await started.promise
    assert.equal((await sync(authCookieA)).status, 409)
  } finally {
    continueSync.resolve()
    holdDiscovery = undefined
  }
  const result = await firstSync
  assert.equal(result.status, 200, await result.clone().text())
  const page = await body<Results>(await get('/api/repositories?page=3&pageSize=100'))
  assert.equal(page.data.total, 250)
  assert.equal(page.data.repositories.length, 50)
  assert.equal((await get('/api/repositories/503', authCookieB)).status, 200)
})

test('logout removes the session and expired sessions fail server validation', async () => {
  const logout = await request('/api/auth/logout', { method: 'POST', cookie: authCookieA, origin })
  assert.equal(logout.status, 200)
  assert.match(logout.headers.get('Set-Cookie')!, /Max-Age=0/)
  assert.equal((await get('/api/me')).status, 401)
  await db.prepare('UPDATE sessions SET expires_at = ?').bind(seconds() - 1).run()
  assert.equal((await get('/api/me', authCookieB)).status, 401)
})
