import { handleApi } from '../../server/api.ts'
import type { Env } from '../../server/core.ts'

export const onRequest: PagesFunction<Env> = ({ request, env }) => handleApi(request, env)
