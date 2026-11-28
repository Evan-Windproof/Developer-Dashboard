import { DurableObject } from 'cloudflare:workers'
import { handleApi } from './api.ts'
import type { Env } from './core.ts'

import { createPublicRepositoryReader, repositorySnapshotResponse } from './public.ts'

export class PublicRepositoryCache extends DurableObject<Env> {
  private readonly read = createPublicRepositoryReader(this.ctx.storage)

  fetch() {
    return repositorySnapshotResponse(this.read, this.env, this.ctx)
  }
}

export default {
  fetch(request, env) {
    return handleApi(request, env)
  },
} satisfies ExportedHandler<Env>
