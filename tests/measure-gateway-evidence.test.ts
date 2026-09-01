import assert from 'node:assert/strict'
import { test } from 'node:test'
import { roundMetrics, thresholdChecks } from '../scripts/measure-gateway-evidence.mjs'

const base = { logicalRequests: 0, cacheHits: 0, singleflightJoins: 0, executions: 0, failures: 0 }

function roundEvents(reads: number, resource: string | null = 'core') {
  const events: Array<Record<string, unknown>> = []
  for (let index = 0; index < reads; index += 1) {
    const requestId = `gh-${index + 1}`
    events.push({ kind: 'declared', requestId })
    events.push({ kind: 'dispatched', requestId, waitedMs: 0 })
    events.push({ kind: 'upstream-settled', requestId, ok: true, rate: resource ? { resource } : null })
    events.push({ kind: 'terminal', requestId, outcome: 'succeeded' })
  }
  return events
}

test('panel threshold rows bind upstream counts and the identity', () => {
  const first = thresholdChecks('panel-first', { ...base, upstreamRequests: 2, logicalRequests: 2, executions: 2 }, 2)
  assert.ok(first.every((row) => row.pass))
  const over = thresholdChecks('panel-first', { ...base, upstreamRequests: 3 }, 3)
  assert.ok(over[0].pass === false, 'no-linked-PR first observation is capped at 2 upstream')
  const hot = thresholdChecks('panel-hot', { ...base, upstreamRequests: 0 }, 0)
  assert.ok(hot.every((row) => row.pass))
  const hotBreach = thresholdChecks('panel-hot', { ...base, upstreamRequests: 1 }, 1)
  assert.ok(hotBreach.every((row) => row.pass === false))
})

test('identity row fails when the partition does not hold', () => {
  const broken = thresholdChecks('review-dense', { ...base, logicalRequests: 5, executions: 4 }, 4)
  assert.equal(broken[1].pass, false)
})

test('multi rows fail on real upstream breaches (negative oracle)', () => {
  const cold = thresholdChecks('multi-cold', { ...base, upstreamRequests: 6 }, 6)
  assert.equal(cold[0].pass, false, 'six cold upstream pages must fail the ≤2 row')
  const hot = thresholdChecks('multi-hot', { ...base, upstreamRequests: 1 }, 1)
  assert.ok(
    hot.every((row) => row.pass === false),
    'one hot upstream must fail both hot rows',
  )
})

test('rate rows demand EXACTLY five single executions (negative oracle)', () => {
  const good = thresholdChecks(
    'rate',
    { ...base, logicalRequests: 5, executions: 5, upstreamRequests: 5 },
    5,
    roundEvents(5),
  )
  assert.ok(
    good.every((row) => row.pass),
    JSON.stringify(good),
  )
  const duplicate = thresholdChecks(
    'rate',
    { ...base, logicalRequests: 7, executions: 7, upstreamRequests: 7 },
    7,
    roundEvents(7),
  )
  assert.equal(duplicate[0].pass, false, 'seven executions (a retried/duplicated read) must fail')
  const short = thresholdChecks('rate', { ...base, executions: 3 }, 3, roundEvents(3))
  assert.equal(short[0].pass, false, 'fewer than five executions must fail the rate row')
  const failed = thresholdChecks(
    'rate',
    { ...base, logicalRequests: 5, executions: 4, upstreamRequests: 5, failures: 1 },
    5,
    roundEvents(5),
  )
  assert.equal(failed[0].pass, false, 'a failed read must fail the rate row')
  const interrupted = thresholdChecks(
    'rate',
    { ...base, logicalRequests: 5, executions: 4, upstreamRequests: 5, interrupted: 1 },
    5,
    roundEvents(5),
  )
  assert.equal(interrupted[0].pass, false, 'an interrupted read must fail the rate row')
})

test('rate rows require a real resource observation on every settled response (negative oracle)', () => {
  const missing = thresholdChecks(
    'rate',
    { ...base, logicalRequests: 5, executions: 5, upstreamRequests: 5 },
    5,
    roundEvents(5, null),
  )
  assert.equal(missing[2].pass, false, 'settled responses without a resource must fail, even with gh children > 0')
  const partial = thresholdChecks('rate', { ...base, logicalRequests: 5, executions: 5, upstreamRequests: 5 }, 5, [
    ...roundEvents(4),
    { kind: 'upstream-settled', requestId: 'gh-5', ok: true, rate: null },
    { kind: 'terminal', requestId: 'gh-5', outcome: 'succeeded' },
  ])
  assert.equal(partial[2].pass, false, 'one headerless response among five must fail the resource row')
  const empty = thresholdChecks('rate', { ...base }, 1, [])
  assert.equal(empty[2].pass, false, 'zero settled responses must fail, not vacuously pass')
})

test('round metrics count only requests declared inside the round (cross-window)', async () => {
  const events = [
    // gh-1 belongs to the PREVIOUS round: declared and terminalized across
    // the mark — its execution must not leak into this round's window.
    { kind: 'declared', requestId: 'gh-1' },
    { kind: 'upstream-settled', requestId: 'gh-1', ok: true, rate: { resource: 'core' } },
    { kind: 'terminal', requestId: 'gh-1', outcome: 'succeeded' },
    // gh-2 is this round's only complete request.
    { kind: 'declared', requestId: 'gh-2' },
    { kind: 'upstream-settled', requestId: 'gh-2', ok: true, rate: { resource: 'core' } },
    { kind: 'terminal', requestId: 'gh-2', outcome: 'succeeded' },
    // gh-3 was declared in this round but never settled or terminalized —
    // the derivation buckets it as interrupted (its outcome is genuinely
    // unknown at window close), never as an execution.
    { kind: 'declared', requestId: 'gh-3' },
  ]
  const { derived } = await roundMetrics(events as never, 3)
  assert.equal(derived.logicalRequests, 2, 'only gh-2 and gh-3 were declared in-round')
  assert.equal(derived.executions, 1, 'only the settled+terminalized in-round request executed')
  assert.equal(derived.interrupted, 1, 'the never-settled request lands in the interrupted bucket, not executions')
})
