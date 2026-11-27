import { ApiError, cookie, decrypt, encrypt, hash, randomSecret, readCookie, redirect, seconds, appOrigin, type Env } from './core.ts'
import { exchange, githubUser, oauth, type Token } from './github.ts'

const stateAge = 600
const sessionAge = 7 * 24 * 60 * 60
const callbackUrl = (env: Env) => `${appOrigin(env)}/api/auth/github/callback`

export type Session = {
  id: number
  github_id: number
  login: string
  avatar_url: string | null
  display_name: string | null
  last_sync: string | null
  session_hash: string
}

export async function session(request: Request, env: Env): Promise<Session> {
  const value = readCookie(request, env, 'dashboard_session')
  if (value && /^[\w-]{43}$/.test(value)) {
    const row = await env.DB.prepare(`
      SELECT u.id, u.github_id, u.login, u.avatar_url, u.display_name, u.last_sync, s.id_hash AS session_hash
      FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.id_hash = ? AND s.expires_at > ?
    `).bind(await hash(value), seconds()).first<Session>()
    if (row) return row
  }
  throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in with GitHub to continue.')
}

export async function createState(env: Env, purpose: 'login' | 'install', sessionHash: string | null = null) {
  const value = randomSecret()
  await env.DB.batch([
    env.DB.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').bind(seconds()),
    env.DB.prepare('INSERT INTO oauth_states VALUES (?, ?, ?, ?)').bind(await hash(value), purpose, sessionHash, seconds() + stateAge),
  ])
  return value
}

export async function consumeState(
  env: Env, purpose: 'login' | 'install', supplied: string | null, expected?: string, sessionHash: string | null = null,
) {
  if (!supplied || supplied !== expected || !/^[\w-]{43}$/.test(supplied)) {
    throw new ApiError(400, 'INVALID_STATE', 'Authorization could not be verified. Start the flow again.')
  }
  const result = await env.DB.prepare(`
    DELETE FROM oauth_states WHERE hash = ? AND purpose = ? AND session_hash IS ? AND expires_at > ?
  `).bind(await hash(supplied), purpose, sessionHash, seconds()).run()
  if (result.meta.changes !== 1) throw new ApiError(400, 'INVALID_STATE', 'Authorization expired or was already used. Start the flow again.')
}

export async function loginStart(request: Request, env: Env) {
  if (new URL(request.url).origin !== appOrigin(env)) return redirect(`${appOrigin(env)}/api/auth/github/start`)
  const state = await createState(env, 'login')
  const verifier = randomSecret()
  const url = new URL(`${oauth}/authorize`)
  url.search = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID, redirect_uri: callbackUrl(env), state,
    code_challenge: await hash(verifier), code_challenge_method: 'S256',
  }).toString()
  return redirect(url.toString(), [cookie(env, 'dashboard_login', `${state}.${verifier}`, stateAge)])
}

export async function loginCallback(request: Request, env: Env, url: URL) {
  if (url.origin !== appOrigin(env)) throw new ApiError(400, 'INVALID_ORIGIN', 'Use the configured dashboard URL to sign in.')
  const [browserState, verifier] = readCookie(request, env, 'dashboard_login')?.split('.') ?? []
  await consumeState(env, 'login', url.searchParams.get('state'), browserState)
  if (!verifier || !/^[\w-]{43}$/.test(verifier)) {
    throw new ApiError(400, 'INVALID_STATE', 'Authorization could not be verified. Start the flow again.')
  }
  const code = url.searchParams.get('code')
  if (url.searchParams.has('error') || !code || code.length > 1024) {
    throw new ApiError(400, 'LOGIN_DECLINED', 'GitHub authorization was declined or did not return a code.')
  }
  const token = await exchange(env, { code, redirect_uri: callbackUrl(env), code_verifier: verifier })
  const user = await githubUser(token.access)
  const row = await env.DB.prepare(`
    INSERT INTO users (github_id, login, avatar_url, display_name) VALUES (?, ?, ?, ?)
    ON CONFLICT (github_id) DO UPDATE SET login = excluded.login, avatar_url = excluded.avatar_url,
      display_name = excluded.display_name, updated_at = CURRENT_TIMESTAMP
    RETURNING id
  `).bind(user.id, user.login, user.avatar_url, user.name).first<{ id: number }>()
  if (!row) throw new Error('User upsert returned no row')
  const old = readCookie(request, env, 'dashboard_session')
  const value = randomSecret()
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(seconds()),
    ...(old ? [env.DB.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(await hash(old))] : []),
    env.DB.prepare(`
      INSERT INTO github_credentials (user_id, encrypted) VALUES (?, ?)
      ON CONFLICT (user_id) DO UPDATE SET encrypted = excluded.encrypted, refresh_lock_until = NULL
    `).bind(row.id, await encrypt(env, row.id, token)),
    env.DB.prepare('INSERT INTO sessions (id_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .bind(await hash(value), row.id, seconds() + sessionAge),
  ])
  return redirect('/', [cookie(env, 'dashboard_login', '', 0), cookie(env, 'dashboard_session', value, sessionAge)])
}

export async function logout(env: Env, current: Session) {
  await env.DB.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(current.session_hash).run()
}

export async function userToken(env: Env, userId: number) {
  const row = await env.DB.prepare('SELECT encrypted FROM github_credentials WHERE user_id = ?').bind(userId)
    .first<{ encrypted: string }>()
  const reconnect = new ApiError(401, 'GITHUB_REAUTH', 'Reconnect your GitHub account.')
  if (!row) throw reconnect
  const token = await decrypt<Token>(env, userId, row.encrypted)
  const now = seconds()
  if (token.expires === null || token.expires > now + 60) return token.access
  if (!token.refresh || (token.refreshExpires && token.refreshExpires <= now)) throw reconnect
  const lock = await env.DB.prepare(`
    UPDATE github_credentials SET refresh_lock_until = ?
    WHERE user_id = ? AND encrypted = ? AND (refresh_lock_until IS NULL OR refresh_lock_until <= ?)
  `).bind(now + 30, userId, row.encrypted, now).run()
  if (!lock.meta.changes) throw new ApiError(409, 'REFRESH_IN_PROGRESS', 'GitHub credentials are being refreshed. Try again shortly.')
  try {
    const next = await exchange(env, { grant_type: 'refresh_token', refresh_token: token.refresh })
    const updated = await env.DB.prepare(`
      UPDATE github_credentials SET encrypted = ?, refresh_lock_until = NULL
      WHERE user_id = ? AND encrypted = ? AND refresh_lock_until = ?
    `).bind(await encrypt(env, userId, next), userId, row.encrypted, now + 30).run()
    if (!updated.meta.changes) throw new ApiError(409, 'CREDENTIALS_CHANGED', 'Your GitHub connection changed. Try again.')
    return next.access
  } finally {
    await env.DB.prepare('UPDATE github_credentials SET refresh_lock_until = NULL WHERE user_id = ? AND encrypted = ? AND refresh_lock_until = ?')
      .bind(userId, row.encrypted, now + 30).run()
  }
}
