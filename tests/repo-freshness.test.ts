import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RepositoryFreshnessGate,
  RepositoryRefreshClock,
  aggregateRepositoryFreshness,
} from '../src/infra/repo-freshness.ts'

test('repository freshness skips duplicate fetches inside the TTL and refreshes after expiry', async () => {
  let now = 1_000
  let calls = 0
  const gate = new RepositoryFreshnessGate(() => now)
  const refresh = async () => { calls++ }

  const first = await gate.ensure('/repo', 45_000, refresh)
  now += 44_999
  const cached = await gate.ensure('/repo', 45_000, refresh)
  now += 1
  const expired = await gate.ensure('/repo', 45_000, refresh)

  assert.equal(calls, 2)
  assert.equal(first.refreshed, true)
  assert.equal(cached.refreshed, false)
  assert.equal(expired.refreshed, true)
})

test('repository freshness coalesces concurrent readers and force bypasses the TTL', async () => {
  let calls = 0
  let release!: () => void
  const blocked = new Promise<void>((resolve) => { release = resolve })
  const gate = new RepositoryFreshnessGate(() => 1_000)
  const refresh = async () => { calls++; await blocked }

  const stateRead = gate.ensure('/repo', 45_000, refresh)
  const listRead = gate.ensure('/repo', 45_000, refresh)
  release()
  await Promise.all([stateRead, listRead])
  await gate.ensure('/repo', 45_000, async () => { calls++ }, true)

  assert.equal(calls, 2)
})

test('repository freshness degrades failed fetches to a throttled stale snapshot', async () => {
  let now = 1_000
  let calls = 0
  const gate = new RepositoryFreshnessGate(() => now)
  const failed = async () => { calls++; throw new Error('offline') }

  const first = await gate.ensure('/repo', 45_000, failed)
  now += 5_000
  const cached = await gate.ensure('/repo', 45_000, failed)

  assert.equal(calls, 1)
  assert.equal(first.stale, true)
  assert.match(first.error ?? '', /offline/)
  assert.equal(cached.stale, true)
  assert.equal(cached.refreshed, false)
})

test('bounded freshness wait returns stale while one coalesced fetch continues', async () => {
  let calls = 0
  let release!: () => void
  const blocked = new Promise<void>((resolve) => { release = resolve })
  const gate = new RepositoryFreshnessGate()

  const first = await gate.ensureWithin('/slow-repo', 45_000, async () => {
    calls++
    await blocked
  }, 5)
  const second = await gate.ensureWithin('/slow-repo', 45_000, async () => { calls++ }, 5)

  assert.equal(calls, 1)
  assert.equal(first.stale, true)
  assert.equal(first.refreshing, true)
  assert.equal(second.stale, true)
  release()
  const completed = await gate.ensure('/slow-repo', 45_000, async () => { calls++ })
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
