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

const taggedRepository = `r.*, (
  SELECT json_group_array(json_object('id', t.id, 'name', t.name, 'color', t.color, 'created_at', t.created_at))
  FROM repository_tags rt JOIN tags t ON t.id = rt.tag_id AND t.user_id = rt.user_id
  WHERE rt.repository_id = r.id AND rt.user_id = ?
) AS tag_json`

function withTags({ tag_json, ...repository }: Record<string, unknown>) {
  return { ...repository, tags: JSON.parse(String(tag_json)) }
}

export async function setRepositoryTag(env: Env, current: Session, repoId: number, tagId: number, assigned: boolean) {
  const eligibility = `SELECT r.id ${accessible} AND r.id = ? AND EXISTS (SELECT 1 FROM tags WHERE user_id = ? AND id = ?)`
  const values = [current.id, cutoff(), repoId, current.id, tagId]
  const mutation = assigned
    ? env.DB.prepare(`INSERT OR IGNORE INTO repository_tags (user_id, repository_id, tag_id) SELECT ?, r.id, ? ${accessible}
        AND r.id = ? AND EXISTS (SELECT 1 FROM tags WHERE user_id = ? AND id = ?)`).bind(current.id, tagId, ...values)
    : env.DB.prepare(`DELETE FROM repository_tags WHERE user_id = ? AND repository_id = ? AND tag_id = ?
        AND EXISTS (${eligibility})`).bind(current.id, repoId, tagId, ...values)
  const [eligible] = await env.DB.batch([env.DB.prepare(eligibility).bind(...values), mutation])
  if (!eligible.results.length) throw new ApiError(404, 'TAG_ASSIGNMENT_NOT_FOUND', 'Repository or tag not found.')
  return { assigned }
}

export const snapshotExpired = (lastSync: string | null) => Boolean(lastSync && lastSync <= cutoff())

const syncLeaseGuard = 'EXISTS (SELECT 1 FROM users WHERE id = ? AND sync_lock = ?)'

function installationStatement(env: Env, installation: Installation, lease?: { userId: number; lock: string }) {
  return env.DB.prepare(`
    INSERT INTO installations SELECT ?, ?, ?, ?, ? ${lease ? `WHERE ${syncLeaseGuard}` : ''}
    ON CONFLICT (id) DO UPDATE SET account_id = excluded.account_id, account_name = excluded.account_name,
      account_type = excluded.account_type, repository_selection = excluded.repository_selection
  `).bind(installation.id, installation.account.id, installation.account.login, installation.account.type,
    installation.repository_selection, ...(lease ? [lease.userId, lease.lock] : []))
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

  const startedAt = Date.now()
  const runId = crypto.randomUUID()
  const unique = new Set<number>()
  const failed: number[] = []
  let discovered = 0
  let processed = 0
  let succeeded = 0
  let firstFailure: ApiError | undefined
  let stopReason: ApiError | undefined
  let stage = 'account_credentials'
  let outcome = 'failed'
  const errorKind = (error: unknown) => error instanceof ApiError ? error.code : 'INTERNAL'
  console.info('Repository sync started', { runId })

  try {
    const deadline = startedAt + 105_000
    const token = await userToken(env, current.id)
    stage = 'installation_discovery'
    const authorized = await installations(token, deadline)
    discovered = authorized.length
    stage = 'installation_sync'
    const timestamp = new Date().toISOString()
    // Only a complete user-authorized listing confirms that an omitted installation is revoked.
    const batch: D1PreparedStatement[] = [
      env.DB.prepare(`DELETE FROM user_installations WHERE user_id = ? AND ${syncLeaseGuard}
        AND installation_id NOT IN (SELECT value FROM json_each(?))`)
        .bind(current.id, current.id, lock, JSON.stringify(authorized.map(item => item.id))),
    ]
    for (const installation of authorized) {
      const id = installation.id
      if (stopReason) {
        failed.push(id)
        continue
      }
      const installationStarted = Date.now()
      let operation = 'user_repository_list'
      let repos: GitHubRepository[]
      let allowed: Set<number> | undefined
      processed++
      try {
        allowed = await userRepositoryIds(id, token, deadline)
        repos = []
        if (allowed.size) {
          operation = 'installation_token'
          const appToken = await installationToken(env, id)
          operation = 'installation_repository_list'
          const installationRepos = await appRepositories(appToken, deadline)
          for (const repo of installationRepos) {
            if (allowed.has(repo.id)) repos.push(repo)
          }
        }
      } catch (error) {
        let failure = error instanceof ApiError ? error
          : new ApiError(503, 'GITHUB_UNAVAILABLE', 'GitHub returned an unreadable repository response.')
        if (operation === 'installation_repository_list' && failure.code === 'GITHUB_REAUTH') {
          failure = new ApiError(503, 'GITHUB_INSTALLATION_TOKEN', 'GitHub rejected the installation token. Try syncing again.')
        }
        if (allowed) {
          // A completed user repository listing confirms which old grants were removed.
          batch.push(env.DB.prepare(`DELETE FROM user_repository_access
            WHERE user_id = ? AND installation_id = ? AND ${syncLeaseGuard}
              AND repository_id NOT IN (SELECT value FROM json_each(?))`)
            .bind(current.id, id, current.id, lock, JSON.stringify([...allowed])))
        }
        failed.push(id)
        firstFailure ??= failure
        if (failure.retryAfter || failure.code === 'SYNC_TIMEOUT') stopReason = failure
        console.warn('Repository installation sync failed', {
          runId, installationId: id, operation, code: failure.code, retryAfter: failure.retryAfter,
          durationMs: Date.now() - installationStarted,
        })
        continue
      }

      succeeded++
      console.info('Repository installation fetched', {
        runId, installationId: id, repositories: repos.length, durationMs: Date.now() - installationStarted,
      })
      batch.push(
        env.DB.prepare(`DELETE FROM user_installations WHERE user_id = ? AND installation_id = ? AND ${syncLeaseGuard}`)
          .bind(current.id, id, current.id, lock),
        installationStatement(env, installation, { userId: current.id, lock }),
        env.DB.prepare(`INSERT INTO user_installations SELECT ?, ? WHERE ${syncLeaseGuard}`).bind(current.id, id, current.id, lock),
      )
      for (let i = 0; i < repos.length; i += 50) {
        const chunk = repos.slice(i, i + 50)
        const ids = JSON.stringify(chunk.map(repo => repo.id))
        chunk.forEach(repo => unique.add(repo.id))
        batch.push(
          env.DB.prepare(`
            INSERT INTO repositories (${repositoryColumns.join(', ')})
            SELECT ${repositoryColumns.map((_, index) => `json_extract(value, '$[${index}]')`).join(', ')}
            FROM json_each(?) WHERE ${syncLeaseGuard}
            ON CONFLICT (id) DO UPDATE SET ${repositoryColumns.slice(1).map(column => `${column} = excluded.${column}`).join(', ')}
            WHERE excluded.synced_at >= repositories.synced_at
          `).bind(JSON.stringify(chunk.map(repo => repositoryData(repo, timestamp))), current.id, lock),
          env.DB.prepare(`INSERT OR IGNORE INTO installation_repositories SELECT ?, value FROM json_each(?) WHERE ${syncLeaseGuard}`)
            .bind(id, ids, current.id, lock),
          env.DB.prepare(`INSERT INTO user_repository_access SELECT ?, ?, value FROM json_each(?) WHERE ${syncLeaseGuard}`)
            .bind(current.id, id, ids, current.id, lock),
        )
      }
    }
    stage = 'snapshot_write'
    const completed = new Date().toISOString()
    const retryAfter = stopReason?.retryAfter
    // The schema has one expiry clock per user. Never renew a retained, unverified grant.
    batch.push(env.DB.prepare(`
      UPDATE users SET
        last_sync = CASE WHEN ? = 0 OR (? > 0 AND NOT EXISTS (
          SELECT 1 FROM user_repository_access a WHERE a.user_id = users.id
            AND a.installation_id IN (SELECT value FROM json_each(?))
        )) THEN ? ELSE last_sync END,
        sync_retry_at = ?
      WHERE id = ? AND sync_lock = ?
      RETURNING last_sync
    `).bind(failed.length, succeeded, JSON.stringify(failed), completed, retryAfter ? seconds() + retryAfter : null, current.id, lock))
    const result = await env.DB.batch<{ last_sync: string | null }>(batch)
    const saved = result.at(-1)?.results[0]
    if (!saved) throw new ApiError(409, 'SYNC_REPLACED', 'The synchronization was replaced. Try again.')
    if (!succeeded && firstFailure) throw stopReason ?? firstFailure
    outcome = failed.length ? 'partial' : 'complete'
    return {
      status: outcome, lastSync: saved.last_sync, total: unique.size,
      installations: { succeeded, failed: failed.length },
      ...(retryAfter ? { retryAfter } : {}),
    }
  } catch (error) {
    if (error instanceof ApiError && stage !== 'snapshot_write' && error.retryAfter) {
      await env.DB.prepare('UPDATE users SET sync_retry_at = ? WHERE id = ? AND sync_lock = ?')
        .bind(seconds() + error.retryAfter, current.id, lock).run()
    }
    if (error instanceof ApiError && error.code === 'GITHUB_REAUTH' &&
        (stage === 'account_credentials' || stage === 'installation_discovery')) {
      await env.DB.prepare(`DELETE FROM user_installations WHERE user_id = ?
        AND EXISTS (SELECT 1 FROM users WHERE id = ? AND sync_lock = ?)`).bind(current.id, current.id, lock).run()
    }
    console.warn('Repository sync error', { runId, stage, code: errorKind(error) })
    throw error
  } finally {
    console.info('Repository sync finished', {
      runId, outcome, installations: discovered, processed, succeeded, failed: failed.length,
      repositories: unique.size, durationMs: Date.now() - startedAt,
    })
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
  const tagMode = choice(params, 'tagMode', ['any', 'all']) ?? 'any'
  const selected = params.getAll('tag')
  if (selected.length > 100 || selected.some(id => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))) {
    throw new ApiError(400, 'INVALID_QUERY', 'Invalid tag selection.')
  }
  const tagIds = [...new Set(selected.map(Number))]
  if (tagIds.length) {
    const matches = `SELECT 1 FROM repository_tags WHERE user_id = ? AND repository_id = r.id
      AND tag_id IN (SELECT value FROM json_each(?))`
    filters.push(tagMode === 'all' ? `(SELECT COUNT(*) FROM (${matches})) = ?` : `EXISTS (${matches})`)
    values.push(current.id, JSON.stringify(tagIds))
    if (tagMode === 'all') values.push(tagIds.length)
  }
  const from = filters.length ? `${accessible} AND ${filters.join(' AND ')}` : accessible
  const [count, results] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS total ${from}`).bind(...values),
    env.DB.prepare(`SELECT ${taggedRepository} ${from} ORDER BY ${ordering[sort]}, r.id LIMIT ? OFFSET ?`).bind(current.id, ...values, pageSize, (page - 1) * pageSize),
  ])
  return { repositories: (results.results as Record<string, unknown>[]).map(withTags), total: Number((count as D1Result<{ total: number }>).results[0].total), page, pageSize }
}

export async function repositoryDetail(env: Env, current: Session, id: number) {
  const row = await env.DB.prepare(`SELECT ${taggedRepository} ${accessible} AND r.id = ?`).bind(current.id, current.id, cutoff(), id).first<Record<string, unknown>>()
  if (!row) throw new ApiError(404, 'REPOSITORY_NOT_FOUND', 'Repository not found.')
  return withTags(row)
}

export async function overview(env: Env, current: Session) {
  const values = [current.id, cutoff()]
  const [stats, recent, languages] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(r.visibility = 'public'), 0) AS public,
      COALESCE(SUM(r.visibility = 'private'), 0) AS private, COALESCE(SUM(r.archived), 0) AS archived,
      COALESCE(SUM(r.stars), 0) AS stars, COALESCE(SUM(r.forks), 0) AS forks ${accessible}`).bind(...values),
    env.DB.prepare(`SELECT ${taggedRepository} ${accessible} ORDER BY r.updated_at DESC, r.id LIMIT 5`).bind(current.id, ...values),
    env.DB.prepare(`SELECT DISTINCT r.language ${accessible} AND r.language IS NOT NULL ORDER BY r.language COLLATE NOCASE`).bind(...values),
  ])
  return {
    stats: stats.results[0], recent: (recent.results as Record<string, unknown>[]).map(withTags), languages: (languages as D1Result<{ language: string }>).results.map(row => row.language),
    lastSync: current.last_sync, accessExpired: snapshotExpired(current.last_sync),
  }
}
