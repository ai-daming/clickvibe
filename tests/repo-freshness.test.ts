import assert from 'node:assert/strict'
import test from 'node:test'
import { createRemoteGitCoordinator } from '../src/infra/remote-git-coordinator.ts'
import { RepositoryRefreshClock, aggregateRepositoryFreshness } from '../src/infra/repo-freshness.ts'

const scope = (repoKey: string) => ({ repoKey, remote: 'origin' })

test('repository freshness skips duplicate fetches inside the TTL and refreshes after expiry', async () => {
  let now = 1_000
  let calls = 0
  const gate = createRemoteGitCoordinator({ now: () => now })
  const refresh = async () => {
    calls++
  }

  const first = await gate.ensureFresh({ scope: scope('/repo'), ttlMs: 45_000, refresh })
  now += 44_999
  const cached = await gate.ensureFresh({ scope: scope('/repo'), ttlMs: 45_000, refresh })
  now += 1
  const expired = await gate.ensureFresh({ scope: scope('/repo'), ttlMs: 45_000, refresh })

  assert.equal(calls, 2)
  assert.equal(first.refreshed, true)
  assert.equal(cached.refreshed, false)
  assert.equal(expired.refreshed, true)
})

test('repository freshness coalesces concurrent readers and force bypasses the TTL', async () => {
  let calls = 0
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const gate = createRemoteGitCoordinator({ now: () => 1_000 })
  const refresh = async () => {
    calls++
    await blocked
  }

  const stateRead = gate.ensureFresh({ scope: scope('/repo'), ttlMs: 45_000, refresh })
  const listRead = gate.ensureFresh({ scope: scope('/repo'), ttlMs: 45_000, refresh })
  release()
  await Promise.all([stateRead, listRead])
  await gate.ensureFresh({
    scope: scope('/repo'),
    ttlMs: 45_000,
    refresh: async () => {
      calls++
    },
    force: true,
  })

  assert.equal(calls, 2)
})

test('repository freshness degrades failed fetches to a throttled stale snapshot', async () => {
  let now = 1_000
  let calls = 0
  const gate = createRemoteGitCoordinator({ now: () => now })
  const failed = async () => {
    calls++
    throw new Error('offline')
  }

  const first = await gate.ensureFresh({ scope: scope('/repo'), ttlMs: 45_000, refresh: failed })
  now += 5_000
  const cached = await gate.ensureFresh({ scope: scope('/repo'), ttlMs: 45_000, refresh: failed })

  assert.equal(calls, 1)
  assert.equal(first.stale, true)
  assert.match(first.error ?? '', /offline/)
  assert.equal(cached.stale, true)
  assert.equal(cached.refreshed, false)
})

test('bounded freshness wait returns stale while one coalesced fetch continues', async () => {
  let calls = 0
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const gate = createRemoteGitCoordinator()

  const first = await gate.ensureFresh({
    scope: scope('/slow-repo'),
    ttlMs: 45_000,
    refresh: async () => {
      calls++
      await blocked
    },
    waitMs: 5,
  })
  const second = await gate.ensureFresh({
    scope: scope('/slow-repo'),
    ttlMs: 45_000,
    refresh: async () => {
      calls++
    },
    waitMs: 5,
  })

  assert.equal(calls, 1)
  assert.equal(first.stale, true)
  assert.equal(first.refreshing, true)
  assert.equal(second.stale, true)
  release()
  const completed = await gate.ensureFresh({
    scope: scope('/slow-repo'),
    ttlMs: 45_000,
    refresh: async () => {
      calls++
    },
  })
  assert.equal(completed.stale, false)
  assert.equal(completed.refreshing, false)
})

test('GitHub dependency clock advances for remote-only repositories without a local path', () => {
  let now = 1_000
  const clock = new RepositoryRefreshClock(() => now)
  assert.equal(clock.take('remote/only', 45_000), true)
  now += 44_999
  assert.equal(clock.take('remote/only', 45_000), false)
  now += 1
  assert.equal(clock.take('remote/only', 45_000), true)
})

test('multi-repository aggregation preserves partial success timestamps', () => {
  const aggregated = aggregateRepositoryFreshness([
    { stale: false, refreshed: true, refreshing: false, lastAttemptAt: 20, lastSuccessAt: 18 },
    { stale: true, refreshed: true, refreshing: false, lastAttemptAt: 22, lastSuccessAt: null, error: 'offline' },
  ])
  assert.deepEqual(aggregated, {
    stale: true,
    refreshed: true,
    refreshing: false,
    lastAttemptAt: 22,
    lastSuccessAt: 18,
    repositoryCount: 2,
    successfulRepositoryCount: 1,
    partial: true,
    error: 'offline',
  })
})
