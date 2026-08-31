import assert from 'node:assert/strict'
import { test } from 'node:test'
import { thresholdChecks } from '../scripts/measure-gateway-evidence.mjs'

const base = { logicalRequests: 0, cacheHits: 0, singleflightJoins: 0, executions: 0, failures: 0 }

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
