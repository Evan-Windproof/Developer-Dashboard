export interface Env {
  OAUTH_DIAGNOSTICS?: string
  DB: D1Database
  APP_BASE_URL: string
  GITHUB_APP_SLUG: string
  GITHUB_CLIENT_ID: string
  GITHUB_CLIENT_SECRET: string
  GITHUB_APP_ID: string
  GITHUB_PRIVATE_KEY: string
  SESSION_ENCRYPTION_KEY: string
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly retryAfter?: number

  constructor(status: number, code: string, message: string, retryAfter?: number) {
    super(message)
    this.status = status
    this.code = code
    this.retryAfter = retryAfter
  }
}

export const seconds = () => Math.floor(Date.now() / 1000)
export const encoder = new TextEncoder()
export const randomSecret = () => base64url(crypto.getRandomValues(new Uint8Array(32)))
export const hash = async (value: string) => base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))))
export const bytes = (value: string) => Uint8Array.from(atob(value), char => char.charCodeAt(0))
export const base64url = (value: Uint8Array) =>
  btoa(String.fromCharCode(...value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
const decodeUrl = (value: string) => bytes(value.replaceAll('-', '+').replaceAll('_', '/'))

async function encryptionKey(env: Env) {
  try {
    const key = bytes(env.SESSION_ENCRYPTION_KEY)
    if (key.length !== 32) throw new Error('Invalid encryption key length')
    return await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt', 'decrypt'])
  } catch {
    console.warn('GitHub credential diagnostic', { stage: 'credential_encryption_key', reason: 'invalid_key' })
    throw new ApiError(503, 'SESSION_ENCRYPTION_CONFIG', 'Set SESSION_ENCRYPTION_KEY to a Base64-encoded 32-byte key.')
  }
}

export async function encrypt(env: Env, userId: number, value: unknown) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(String(userId)) },
    await encryptionKey(env), encoder.encode(JSON.stringify(value)),
  )
  return `${base64url(iv)}.${base64url(new Uint8Array(ciphertext))}`
}

export async function decrypt<T>(env: Env, userId: number, value: string): Promise<T> {
  const key = await encryptionKey(env)
  try {
    const match = /^([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22,})$/.exec(value)
    if (!match) throw new Error('Invalid encrypted credential envelope')
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: decodeUrl(match[1]), additionalData: encoder.encode(String(userId)) },
      key, decodeUrl(match[2]),
    )
    return JSON.parse(new TextDecoder().decode(plaintext)) as T
  } catch {
    console.warn('GitHub credential diagnostic', { stage: 'credential_decryption', reason: 'unreadable_credential' })
    throw new ApiError(401, 'GITHUB_CREDENTIALS_UNREADABLE', 'Stored GitHub credentials could not be read. Reconnect your GitHub account.')
  }
}

export function appOrigin(env: Env) {
  const url = new URL(env.APP_BASE_URL)
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('APP_BASE_URL requires HTTPS outside loopback')
  }
  return url.origin
}

export function cookieName(env: Env, name: string) {
  return appOrigin(env).startsWith('https:') ? `__Host-${name}` : name
}

export function readCookie(request: Request, env: Env, name: string) {
  const prefix = `${cookieName(env, name)}=`
  return request.headers.get('Cookie')?.split(';').map(value => value.trim())
    .find(value => value.startsWith(prefix))?.slice(prefix.length)
}

export function cookie(env: Env, name: string, value: string, maxAge: number) {
  const secure = appOrigin(env).startsWith('https:') ? '; Secure' : ''
  return `${cookieName(env, name)}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`
}

export function json(data: unknown, status = 200) {
  return Response.json({ data }, { status })
}

export function redirect(location: string, cookies: string[] = []) {
  const headers = new Headers({ Location: location })
  cookies.forEach(value => headers.append('Set-Cookie', value))
  return new Response(null, { status: 302, headers })
}

export function requireSameOrigin(request: Request, env: Env) {
  if (request.headers.get('Origin') !== appOrigin(env)) {
    throw new ApiError(403, 'INVALID_ORIGIN', 'Open the dashboard to perform this action.')
  }
}
