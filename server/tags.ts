import { ApiError, type Env } from './core.ts'

const notFound = () => new ApiError(404, 'TAG_NOT_FOUND', 'Tag not found.')
const fields = 'id, name, color, created_at'

export async function listTags(env: Env, userId: number) {
  const result = await env.DB.prepare(`SELECT ${fields} FROM tags WHERE user_id = ? ORDER BY name_key, id`).bind(userId).all()
  return result.results
}

export async function saveTag(request: Request, env: Env, userId: number, id?: number) {
  const invalid = () => new ApiError(400, 'INVALID_TAG', 'Enter a tag name of 1–60 characters and a color in #RRGGBB format.')
  const reader = request.body?.getReader()
  if (!reader || !/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') ?? '')) throw invalid()
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > 2048) {
      void reader.cancel().catch(() => undefined)
      throw invalid()
    }
    text += decoder.decode(value, { stream: true })
  }
  let input: { name?: unknown; color?: unknown } | null
  try { input = JSON.parse(text + decoder.decode()) } catch { throw invalid() }
  const name = typeof input?.name === 'string' ? input.name.trim() : ''
  const color = input?.color
  if (!name || name.length > 60 || /[\x00-\x1f\x7f]/.test(name) || typeof color !== 'string' || !/^#[\da-f]{6}$/i.test(color)) throw invalid()
  const values = [name, name.normalize('NFKC').toLowerCase(), color.toUpperCase()]
  let tag
  try {
    tag = id === undefined
      ? await env.DB.prepare(`INSERT INTO tags (user_id, name, name_key, color) VALUES (?, ?, ?, ?) RETURNING ${fields}`).bind(userId, ...values).first()
      : await env.DB.prepare(`UPDATE tags SET name = ?, name_key = ?, color = ? WHERE user_id = ? AND id = ? RETURNING ${fields}`).bind(...values, userId, id).first()
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed: tags.user_id, tags.name_key')) {
      throw new ApiError(409, 'DUPLICATE_TAG', 'You already have a tag with that name.')
    }
    throw error
  }
  if (!tag) throw notFound()
  return tag
}

export async function deleteTag(env: Env, userId: number, id: number) {
  const result = await env.DB.prepare('DELETE FROM tags WHERE user_id = ? AND id = ?').bind(userId, id).run()
  if (!result.meta.changes) throw notFound()
  return { deleted: true }
}
