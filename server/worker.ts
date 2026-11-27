import { handleApi } from './api.ts'
import type { Env } from './core.ts'

export default {
  fetch(request, env) {
    return handleApi(request, env)
  },
} satisfies ExportedHandler<Env>
