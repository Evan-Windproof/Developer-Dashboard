import assert from 'node:assert/strict'
import test from 'node:test'
import { refreshDashboard, refreshTargets, syncAndRefresh, updateRepositoryAccess, type RepositoryAccess } from '../src/dashboard-sync.ts'

test('a successful sync stays visible when one refresh fails and only that read is retried', async t => {
  const result = { status: 'complete', total: 31, installations: { succeeded: 2, failed: 0 } }
  const fetch = t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof globalThis.fetch>[0]) => Response.json({ data: result }))
  const outcome: string[] = []
  const failure = new Error('Tags unavailable')
  let tagsAvailable = false
  const operations = {
    overview: async () => { outcome.push('overview loaded') },
    installations: async () => { outcome.push('installations loaded') },
    tags: async () => {
      if (!tagsAvailable) throw failure
      outcome.push('tags loaded')
    },
  }
  const report: Parameters<typeof refreshDashboard>[2] = (target, refreshResult) => {
    if (refreshResult.status === 'rejected') {
      assert.equal(refreshResult.reason, failure)
      outcome.push(`${target} refresh failed`)
    }
  }
  await syncAndRefresh(value => {
    assert.deepEqual(value, result)
    outcome.push('sync completed')
  }, () => refreshDashboard(refreshTargets, operations, report))
  assert.deepEqual(outcome, ['sync completed', 'overview loaded', 'installations loaded', 'tags refresh failed'])
  tagsAvailable = true
  await refreshDashboard(['tags'], operations, report)
  assert.equal(outcome.at(-1), 'tags loaded')
  assert.deepEqual(fetch.mock.calls[0].arguments[0], '/api/repositories/sync')
  assert.equal(fetch.mock.callCount(), 1)
})

test('failed sync and Overview refresh preserve last known sync history while clearing repository rows', async t => {
  const lastSync = '2026-01-01T00:00:00.000Z'
  const overview = {
    stats: { total: 1, public: 0, private: 1, archived: 0, stars: 0, forks: 0 },
    recent: [], languages: [], accessExpired: false, lastSync,
  }
  let access: RepositoryAccess = updateRepositoryAccess({}, { type: 'overview', snapshot: overview })
  const failures: string[] = []
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ error: { code: 'GITHUB_UNAVAILABLE', message: 'Sync temporarily unavailable.' } }, { status: 503 }))

  try {
    await syncAndRefresh(() => assert.fail('A failed sync was reported as successful'), async () => {})
  } catch (error) {
    assert.match(String(error), /Sync temporarily unavailable/)
    failures.push('sync')
    access = updateRepositoryAccess(access, { type: 'invalidate' })
    await refreshDashboard(['overview'], {
      overview: async () => { throw new Error('Overview temporarily unavailable') },
      installations: async () => {},
      tags: async () => {},
    }, (target, result) => { if (result.status === 'rejected') failures.push(target) })
  }

  assert.deepEqual(failures, ['sync', 'overview'])
  assert.equal(access.snapshot, undefined)
  assert.equal(access.lastSync, lastSync)

  const partialFreshness = '2026-01-01T00:10:00.000Z'
  access = updateRepositoryAccess(access, { type: 'sync', lastSync: partialFreshness })
  access = updateRepositoryAccess(access, { type: 'invalidate' })
  assert.deepEqual(access, { lastSync: partialFreshness })
  assert.deepEqual(updateRepositoryAccess(access, { type: 'reset' }), {})
})
