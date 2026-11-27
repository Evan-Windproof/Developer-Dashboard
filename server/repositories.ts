import type { D1Result } from '@cloudflare/workers-types'
import { ApiError, randomSecret, seconds, type Env } from './core.ts'
import { userToken, type Session } from './auth.ts'
import { appRepositories, installations, installationToken, userRepositoryIds, type GitHubRepository, type Installation } from './github.ts'

const accessLifetime = 15 * 60
const accessible = `FROM (
  SELECT DISTINCT a.repository_id FROM user_repository_access a
  JOIN users u ON u.id = a.user_id WHERE a.user_id = ? AND u.last_sync > ?
) authorized JOIN repositories r ON r.id = authorized.repository_id WHERE 1 = 1`
const cutoff = () => new Date(Date.now() - accessLifetime * 1000).toISOString()

export const snapshotExpired = (lastSync: string | null) => Boolean(lastSync && lastSync <= cutoff())

function installationStatement(env: Env, installation: Installation) {
  return env.DB.prepare(`
    INSERT INTO installations VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET account_id = excluded.account_id, account_name = excluded.account_name,
      account_type = excluded.account_type, repository_selection = excluded.repository_selection
  `).bind(installation.id, installation.account.id, installation.account.login, installation.account.type, installation.repository_selection)
}

export async function associateInstallation(env: Env, current: Session, id: number) {
  const authorized = await installations(await userToken(env, current.id))
  const installation = authorized.find(entry => entry.id === id)
  if (!installation) throw new ApiError(403, 'INSTALLATION_FORBIDDEN', 'Your GitHub account cannot access this installation.')
  await env.DB.batch([
    installationStatement(env, installation),
    env.DB.prepare('INSERT OR IGNORE INTO user_installations VALUES (?, ?)').bind(current.id, id),
  ])
}

export async function listInstallations(env: Env, current: Session) {
  const result = await env.DB.prepare(`
    SELECT i.* FROM installations i JOIN user_installations ui ON ui.installation_id = i.id
    WHERE ui.user_id = ? ORDER BY i.account_name, i.id
  `).bind(current.id).all()
  return result.results
}

function repositoryData(repo: GitHubRepository, timestamp: string) {
  return [
    repo.id, repo.owner.login, repo.name, repo.full_name, repo.description, repo.html_url,
    repo.visibility ?? (repo.private ? 'private' : 'public'), repo.language ?? null, repo.stargazers_count,
    repo.forks_count, repo.open_issues_count, repo.default_branch ?? null, repo.created_at ?? null,
    repo.updated_at ?? null, repo.pushed_at ?? null, Number(repo.archived), Number(repo.fork), timestamp,
  ]
}

const repositoryColumns = [
  'id', 'owner', 'name', 'full_name', 'description', 'url', 'visibility', 'language', 'stars',
  'forks', 'open_issues', 'default_branch', 'created_at', 'updated_at', 'pushed_at', 'archived', 'fork', 'synced_at',
]

export async function synchronize(env: Env, current: Session) {
  const now = seconds()
  const lock = randomSecret()
  const acquired = await env.DB.prepare(`
    UPDATE users SET sync_lock = ?, sync_started = ?
    WHERE id = ? AND (sync_started IS NULL OR (sync_started <= ? AND (sync_lock IS NULL OR sync_started <= ?)))
      AND (sync_retry_at IS NULL OR sync_retry_at <= ?)
  `).bind(lock, now, current.id, now - 15, now - 180, now).run()
  if (!acquired.meta.changes) {
    const row = await env.DB.prepare('SELECT sync_lock, sync_retry_at FROM users WHERE id = ?').bind(current.id)
      .first<{ sync_lock: string | null; sync_retry_at: number | null }>()
    if (row?.sync_lock) throw new ApiError(409, 'SYNC_IN_PROGRESS', 'A synchronization is already in progress.')
    throw new ApiError(429, 'SYNC_COOLDOWN', 'Wait before synchronizing again.', Math.max(1, (row?.sync_retry_at ?? now + 15) - now))
  }

  try {
    const deadline = Date.now() + 105_000
    const token = await userToken(env, current.id)
    const authorized = await installations(token, deadline)
    const timestamp = new Date().toISOString()
    const guard = 'EXISTS (SELECT 1 FROM users WHERE id = ? AND sync_lock = ?)'
    const batch: D1PreparedStatement[] = [
      env.DB.prepare(`DELETE FROM user_installations WHERE user_id = ? AND ${guard}`).bind(current.id, current.id, lock),
    ]
    const unique = new Set<number>()
    for (const installation of authorized) {
      const id = installation.id
      const allowed = await userRepositoryIds(id, token, deadline)
      const repos = allowed.size
        ? (await appRepositories(await installationToken(env, id), deadline)).filter(repo => allowed.has(repo.id))
        : []
      batch.push(installationStatement(env, installation))
      batch.push(env.DB.prepare(`INSERT INTO user_installations SELECT ?, ? WHERE ${guard}`).bind(current.id, id, current.id, lock))
      for (let i = 0; i < repos.length; i += 50) {
        const chunk = repos.slice(i, i + 50)
        const ids = JSON.stringify(chunk.map(repo => repo.id))
        chunk.forEach(repo => unique.add(repo.id))
        batch.push(
          env.DB.prepare(`
            INSERT INTO repositories (${repositoryColumns.join(', ')})
            SELECT ${repositoryColumns.map((_, index) => `json_extract(value, '$[${index}]')`).join(', ')}
            FROM json_each(?) WHERE ${guard}
            ON CONFLICT (id) DO UPDATE SET ${repositoryColumns.slice(1).map(column => `${column} = excluded.${column}`).join(', ')}
            WHERE excluded.synced_at >= repositories.synced_at
          `).bind(JSON.stringify(chunk.map(repo => repositoryData(repo, timestamp))), current.id, lock),
          env.DB.prepare(`INSERT OR IGNORE INTO installation_repositories SELECT ?, value FROM json_each(?) WHERE ${guard}`)
            .bind(id, ids, current.id, lock),
          env.DB.prepare(`INSERT INTO user_repository_access SELECT ?, ?, value FROM json_each(?) WHERE ${guard}`)
            .bind(current.id, id, ids, current.id, lock),
        )
      }
    }
    const completed = new Date().toISOString()
    batch.push(env.DB.prepare('UPDATE users SET last_sync = ?, sync_retry_at = NULL WHERE id = ? AND sync_lock = ?')
      .bind(completed, current.id, lock))
    const result = await env.DB.batch(batch)
    if (!result.at(-1)?.meta.changes) throw new ApiError(409, 'SYNC_REPLACED', 'The synchronization was replaced. Try again.')
    return { lastSync: completed, total: unique.size }
  } catch (error) {
    if (error instanceof ApiError && error.retryAfter) {
      await env.DB.prepare('UPDATE users SET sync_retry_at = ? WHERE id = ? AND sync_lock = ?')
        .bind(seconds() + error.retryAfter, current.id, lock).run()
    }
    if (error instanceof ApiError && ['GITHUB_ACCESS', 'GITHUB_REAUTH'].includes(error.code)) {
      await env.DB.prepare(`DELETE FROM user_installations WHERE user_id = ?
        AND EXISTS (SELECT 1 FROM users WHERE id = ? AND sync_lock = ?)`).bind(current.id, current.id, lock).run()
    }
    throw error
  } finally {
    await env.DB.prepare('UPDATE users SET sync_lock = NULL WHERE id = ? AND sync_lock = ?').bind(current.id, lock).run()
  }
}

const ordering = {
  updated: 'r.updated_at DESC',
  created: 'r.created_at DESC',
  name: 'r.full_name COLLATE NOCASE ASC',
  stars: 'r.stars DESC',
  forks: 'r.forks DESC',
}

function choice<T extends string>(params: URLSearchParams, key: string, choices: readonly T[]) {
  const value = params.get(key)
  if (value === null) return undefined
  if ((choices as readonly string[]).includes(value)) return value as T
  throw new ApiError(400, 'INVALID_QUERY', `Invalid ${key} parameter.`)
}

function integer(params: URLSearchParams, key: string, fallback: number, max: number) {
  const value = params.get(key)
  if (value === null) return fallback
  if (/^[1-9]\d*$/.test(value) && Number(value) <= max) return Number(value)
  throw new ApiError(400, 'INVALID_QUERY', `Invalid ${key} parameter.`)
}

export async function repositoryList(env: Env, current: Session, params: URLSearchParams) {
  const q = params.get('q')?.trim() ?? ''
  const language = params.get('language')?.trim()
  if (q.length > 200 || (language && language.length > 80)) {
    throw new ApiError(400, 'INVALID_QUERY', 'Search or language is too long.')
  }
  const visibility = choice(params, 'visibility', ['public', 'private', 'internal'])
  const archived = choice(params, 'archived', ['true', 'false'])
  const fork = choice(params, 'fork', ['true', 'false'])
  const sort = choice(params, 'sort', Object.keys(ordering) as (keyof typeof ordering)[]) ?? 'updated'
  const page = integer(params, 'page', 1, 100_000)
  const pageSize = integer(params, 'pageSize', 20, 100)
  const filters: string[] = []
  const values: (string | number)[] = [current.id, cutoff()]
  if (q) {
    const pattern = '%' + q.replace(/[\\%_]/g, '\\$&') + '%'
    filters.push("(r.name LIKE ? ESCAPE '\\' OR r.full_name LIKE ? ESCAPE '\\' OR r.description LIKE ? ESCAPE '\\')")
    values.push(pattern, pattern, pattern)
  }
  if (visibility) { filters.push('r.visibility = ?'); values.push(visibility) }
  if (archived) { filters.push('r.archived = ?'); values.push(Number(archived === 'true')) }
  if (fork) { filters.push('r.fork = ?'); values.push(Number(fork === 'true')) }
  if (language) { filters.push('r.language = ? COLLATE NOCASE'); values.push(language) }
  const from = filters.length ? `${accessible} AND ${filters.join(' AND ')}` : accessible
  const [count, results] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS total ${from}`).bind(...values),
    env.DB.prepare(`SELECT r.* ${from} ORDER BY ${ordering[sort]}, r.id LIMIT ? OFFSET ?`).bind(...values, pageSize, (page - 1) * pageSize),
  ])
  return { repositories: results.results, total: Number((count as D1Result<{ total: number }>).results[0].total), page, pageSize }
}

export async function repositoryDetail(env: Env, current: Session, id: number) {
  const row = await env.DB.prepare(`SELECT r.* ${accessible} AND r.id = ?`).bind(current.id, cutoff(), id).first()
  if (!row) throw new ApiError(404, 'REPOSITORY_NOT_FOUND', 'Repository not found.')
  return row
}

export async function overview(env: Env, current: Session) {
  const values = [current.id, cutoff()]
  const [stats, recent, languages] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(r.visibility = 'public'), 0) AS public,
      COALESCE(SUM(r.visibility = 'private'), 0) AS private, COALESCE(SUM(r.archived), 0) AS archived,
      COALESCE(SUM(r.stars), 0) AS stars, COALESCE(SUM(r.forks), 0) AS forks ${accessible}`).bind(...values),
    env.DB.prepare(`SELECT r.* ${accessible} ORDER BY r.updated_at DESC, r.id LIMIT 5`).bind(...values),
    env.DB.prepare(`SELECT DISTINCT r.language ${accessible} AND r.language IS NOT NULL ORDER BY r.language COLLATE NOCASE`).bind(...values),
  ])
  return {
    stats: stats.results[0], recent: recent.results, languages: (languages as D1Result<{ language: string }>).results.map(row => row.language),
    lastSync: current.last_sync, accessExpired: snapshotExpired(current.last_sync),
  }
}
