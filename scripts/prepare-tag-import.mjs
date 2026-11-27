import { readFileSync } from 'node:fs'

const [mode, input] = process.argv.slice(2)
if (!['apply', 'verify'].includes(mode) || !input) {
  console.error('Usage: node scripts/prepare-tag-import.mjs <apply|verify> <Wrangler JSON export>')
  process.exit(1)
}

const [exportResult] = JSON.parse(readFileSync(input, 'utf8').replace(/^\uFEFF/, ''))
if (!exportResult?.success || !Array.isArray(exportResult.results)) throw new Error('Expected a successful Wrangler JSON export')

const tags = new Map()
const assignments = []
const positiveId = value => Number.isSafeInteger(value) && value > 0
for (const row of exportResult.results) {
  const { github_id, name, color, created_at, repository_id, full_name } = row
  if (!positiveId(github_id) || typeof name !== 'string' || name !== name.trim() || !name ||
      name.length > 60 || /[\x00-\x1f\x7f]/.test(name) ||
      typeof color !== 'string' || !/^#[\dA-F]{6}$/.test(color) ||
      typeof created_at !== 'string' || !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(created_at) ||
      (repository_id === null ? full_name !== null :
        !positiveId(repository_id) || typeof full_name !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(full_name))) {
    throw new Error('Invalid metadata row')
  }

  const name_key = name.normalize('NFKC').toLowerCase()
  const tag = { github_id, name, name_key, color, created_at }
  const key = JSON.stringify([github_id, name_key])
  if (tags.has(key) && JSON.stringify(tags.get(key)) !== JSON.stringify(tag)) throw new Error('Conflicting exported tags')
  tags.set(key, tag)
  if (repository_id !== null) assignments.push({ ...tag, repository_id, full_name })
}

const sources = [
  { rows: [...tags.values()], assignment: false },
  { rows: assignments, assignment: true },
]

const sqlString = value => "'" + value.replaceAll("'", "''") + "'"
const field = name => `json_extract(row.value, '$.${name}')`
const owner = `u.github_id = ${field('github_id')}`
const tagIdentity = `t.user_id = u.id AND t.name_key = ${field('name_key')}`
const sameTag = `t.name = ${field('name')} AND t.color = ${field('color')}`
const access = `julianday(u.last_sync) > julianday('now', '-15 minutes')
  AND EXISTS (SELECT 1 FROM user_repository_access a WHERE a.user_id = u.id AND a.repository_id = r.id)`

for (const { rows, assignment } of sources) {
  for (let offset = 0; offset < rows.length; offset += 50) {
    const source = `json_each(${sqlString(JSON.stringify(rows.slice(offset, offset + 50)))}) row`
    if (mode === 'apply' && !assignment) {
      console.log(`INSERT INTO tags (user_id, name, name_key, color, created_at)
SELECT u.id, ${field('name')}, ${field('name_key')}, ${field('color')}, ${field('created_at')}
FROM ${source} JOIN users u ON ${owner}
ON CONFLICT (user_id, name_key) DO NOTHING;`)
    } else if (mode === 'apply') {
      console.log(`INSERT INTO repository_tags (user_id, repository_id, tag_id)
SELECT u.id, r.id, t.id
FROM ${source} JOIN users u ON ${owner} JOIN tags t ON ${tagIdentity}
JOIN repositories r ON r.id = ${field('repository_id')}
WHERE ${sameTag} AND ${access}
ON CONFLICT (user_id, repository_id, tag_id) DO NOTHING;`)
    } else {
      const repositoryColumns = assignment ? `, ${field('full_name')} AS source_repository, r.full_name AS target_repository` : ''
      const repositoryJoins = assignment ? `
LEFT JOIN repositories r ON r.id = ${field('repository_id')}
LEFT JOIN repository_tags rt ON rt.user_id = u.id AND rt.repository_id = r.id AND rt.tag_id = t.id` : ''
      console.log(`SELECT ${field('github_id')} AS github_id, ${field('name')} AS tag${repositoryColumns},
CASE
  WHEN u.id IS NULL THEN 'missing_owner'
  WHEN t.id IS NULL THEN 'missing_tag'
  WHEN NOT (${sameTag}) THEN 'tag_conflict'${assignment ? `
  WHEN r.id IS NULL THEN 'missing_repository'
  WHEN rt.tag_id IS NULL AND NOT COALESCE((${access}), 0) THEN 'sync_required'
  WHEN rt.tag_id IS NULL THEN 'missing_assignment'` : ''}
  ELSE 'present'
END AS status
FROM ${source} LEFT JOIN users u ON ${owner} LEFT JOIN tags t ON ${tagIdentity}${repositoryJoins};`)
    }
  }
}
