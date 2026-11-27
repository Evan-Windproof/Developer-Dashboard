import { api, type Overview } from './api.ts'

export type RepositoryAccess = {
  snapshot?: Overview
  lastSync?: string | null
}

type AccessUpdate =
  | { type: 'overview'; snapshot: Overview }
  | { type: 'sync'; lastSync: string | null }
  | { type: 'invalidate' | 'reset' }
  | { type: 'expire'; lastSync: string }

export function updateRepositoryAccess(state: RepositoryAccess, action: AccessUpdate): RepositoryAccess {
  switch (action.type) {
    case 'overview':
      return { snapshot: action.snapshot, lastSync: action.snapshot.lastSync ?? state.lastSync ?? null }
    case 'sync':
      return { ...state, lastSync: action.lastSync ?? state.lastSync }
    case 'invalidate':
      return { lastSync: state.lastSync }
    case 'expire':
      return state.snapshot?.lastSync === action.lastSync
        ? { ...state, snapshot: { ...state.snapshot, accessExpired: true, recent: [] } }
        : state
    case 'reset':
      return {}
  }
}

export type SyncResult = {
  status: 'complete' | 'partial'
  lastSync: string | null
  total: number
  installations: { succeeded: number; failed: number }
  retryAfter?: number
}

export const refreshLabels = { overview: 'Overview', installations: 'GitHub installations', tags: 'Tags' }
export type RefreshTarget = keyof typeof refreshLabels
export const refreshTargets: RefreshTarget[] = ['overview', 'installations', 'tags']

export async function refreshDashboard(
  targets: RefreshTarget[],
  operations: Record<RefreshTarget, () => Promise<void>>,
  onOutcome: (target: RefreshTarget, result: PromiseSettledResult<void>) => void,
) {
  await Promise.all(targets.map(async target => {
    let result: PromiseSettledResult<void>
    try {
      await operations[target]()
      result = { status: 'fulfilled', value: undefined }
    } catch (reason) {
      result = { status: 'rejected', reason }
    }
    onOutcome(target, result)
  }))
}

export async function syncAndRefresh(onSynced: (result: SyncResult) => void, refresh: () => Promise<void>) {
  const result = await api<SyncResult>('/api/repositories/sync', { method: 'POST' })
  onSynced(result)
  await refresh()
}
