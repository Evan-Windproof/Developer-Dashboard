import { deleteTag, listTags, saveTag } from './tags.ts'
import { ApiError, appOrigin, cookie, json, readCookie, redirect, requireSameOrigin, type Env } from './core.ts'
import { consumeState, createState, loginCallback, loginStart, logout, session } from './auth.ts'
import { associateInstallation, listInstallations, overview, repositoryDetail, repositoryList, setRepositoryTag, synchronize } from './repositories.ts'
import { publicRepositoryList } from './public.ts'

const routes = new Map([
  ['/api/health', 'GET'],
  ['/api/public/repositories', 'GET'],
  ['/api/auth/github/start', 'GET'],
  ['/api/auth/github/callback', 'GET'],
  ['/api/auth/logout', 'POST'],
  ['/api/me', 'GET'],
  ['/api/github/installations', 'GET'],
  ['/api/github/installations/install-url', 'GET'],
  ['/api/github/installation/callback', 'GET'],
  ['/api/overview', 'GET'],
  ['/api/repositories', 'GET'],
  ['/api/repositories/sync', 'POST'],
])

function security(response: Response, cacheControl = 'no-store') {
  response.headers.set('Cache-Control', cacheControl)
  response.headers.set('X-Content-Type-Options', 'nosniff')
  response.headers.set('X-Frame-Options', 'DENY')
  response.headers.set('Referrer-Policy', 'no-referrer')
  response.headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'")
  return response
}

export async function handleApi(request: Request, env: Env) {
  const url = new URL(request.url)
  const path = url.pathname
  const detail = /^\/api\/repositories\/([1-9]\d*)$/.exec(path)
  const tag = /^\/api\/tags\/([1-9]\d*)$/.exec(path)
  const assignment = /^\/api\/repositories\/([1-9]\d*)\/tags\/([1-9]\d*)$/.exec(path)
  const methods = routes.get(path) ?? (detail ? 'GET' : path === '/api/tags' ? 'GET, POST'
    : tag ? 'PATCH, DELETE' : assignment ? 'PUT, DELETE' : undefined)
  const method = request.method
  const tagBody = (path === '/api/tags' && method === 'POST') || (tag && method === 'PATCH')
  const loginReturn = path === '/api/auth/github/callback'
  const installReturn = path === '/api/github/installation/callback'
  try {
    if (!methods) throw new ApiError(404, 'NOT_FOUND', 'Endpoint not found.')
    if (!methods.split(', ').includes(method)) {
      const response = Response.json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' } }, { status: 405 })
      response.headers.set('Allow', methods)
      return security(response)
    }
    if (method !== 'GET') {
      requireSameOrigin(request, env)
      if (!tagBody && request.body) {
        const reader = request.body.getReader()
        const { done } = await reader.read()
        if (!done) {
          void reader.cancel().catch(() => undefined)
          throw new ApiError(400, 'UNEXPECTED_BODY', 'This endpoint does not accept a request body.')
        }
      }
    }
    if (path === '/api/health') {
      await env.DB.prepare('SELECT 1 FROM users LIMIT 1').all()
      return security(json({ status: 'ok' }))
    }
    if (path === '/api/auth/github/start') return security(await loginStart(request, env))
    if (loginReturn) return security(await loginCallback(request, env, url))
    if (path === '/api/public/repositories') return security(json(await publicRepositoryList()), 'public, max-age=60, s-maxage=300')
    const current = await session(request, env)
    if (path === '/api/auth/logout') {
      await logout(env, current)
      const response = json({ signedOut: true })
      response.headers.append('Set-Cookie', cookie(env, 'dashboard_session', '', 0))
      return security(response)
    }
    if (path === '/api/me') {
      const { github_id, login, avatar_url, display_name } = current
      return security(json({ github_id, login, avatar_url, display_name }))
    }
    if (path === '/api/github/installations') return security(json(await listInstallations(env, current)))
    if (path === '/api/github/installations/install-url') {
      if (request.headers.get('X-Dashboard-Request') !== '1') throw new ApiError(403, 'INVALID_ORIGIN', 'Open the dashboard to install the app.')
      if (!/^[a-z0-9-]+$/.test(env.GITHUB_APP_SLUG)) throw new Error('Invalid GitHub App slug')
      const state = await createState(env, 'install', current.session_hash)
      const response = json({ url: `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new?state=${state}` })
      response.headers.append('Set-Cookie', cookie(env, 'dashboard_install', state, 600))
      return security(response)
    }
    if (installReturn) {
      if (url.origin !== appOrigin(env)) throw new ApiError(400, 'INVALID_ORIGIN', 'Use the configured dashboard URL.')
      await consumeState(env, 'install', url.searchParams.get('state'), readCookie(request, env, 'dashboard_install'), current.session_hash)
      const clear = [cookie(env, 'dashboard_install', '', 0)]
      if (url.searchParams.get('setup_action') === 'request') return security(redirect('/?github=requested', clear))
      const id = Number(url.searchParams.get('installation_id'))
      if (!Number.isSafeInteger(id) || id < 1 || !/^[1-9]\d*$/.test(url.searchParams.get('installation_id') ?? '')) {
        throw new ApiError(400, 'INVALID_INSTALLATION', 'GitHub did not provide a valid installation.')
      }
      await associateInstallation(env, current, id)
      return security(redirect('/?github=installed', clear))
    }
    if (path === '/api/tags') return security(method === 'GET'
      ? json(await listTags(env, current.id)) : json(await saveTag(request, env, current.id), 201))
    if (tag && Number.isSafeInteger(Number(tag[1]))) return security(json(method === 'PATCH'
      ? await saveTag(request, env, current.id, Number(tag[1])) : await deleteTag(env, current.id, Number(tag[1]))))
    if (assignment && assignment.slice(1).every(id => Number.isSafeInteger(Number(id)))) {
      return security(json(await setRepositoryTag(env, current, Number(assignment[1]), Number(assignment[2]), method === 'PUT')))
    }
    if (path === '/api/overview') return security(json(await overview(env, current)))
    if (path === '/api/repositories') return security(json(await repositoryList(env, current, url.searchParams)))
    if (path === '/api/repositories/sync') return security(json(await synchronize(env, current)))
    if (detail && Number.isSafeInteger(Number(detail[1]))) return security(json(await repositoryDetail(env, current, Number(detail[1]))))
    throw new ApiError(404, 'REPOSITORY_NOT_FOUND', 'Repository not found.')
  } catch (error) {
    const safe = error instanceof ApiError ? error : new ApiError(500, 'INTERNAL', 'The dashboard could not complete the request.')
    if (error instanceof Error && !(error instanceof ApiError)) console.error('Dashboard request failure', path, error.name)
    if ((loginReturn || installReturn) && request.method === 'GET') {
      const parameter = loginReturn ? 'login-error' : 'install-error'
      return security(redirect(`/?${parameter}=${encodeURIComponent(safe.code)}`,
        [cookie(env, loginReturn ? 'dashboard_login' : 'dashboard_install', '', 0)]))
    }
    const response = Response.json({ error: { code: safe.code, message: safe.message } }, { status: safe.status })
    if (safe.retryAfter) response.headers.set('Retry-After', String(safe.retryAfter))
    return security(response)
  }
}
