/**
 * Gateway owner (issue #131 slice A, c2 — ADR-0010 §1/§4).
 *
 * One credential scope owns one in-process owner. v0.2 is deliberately
 * conservative: the gh CLI host auth cannot be safely split into distinct
 * credentials, so everything shares a single scope (少复用可以,拆开同一预算
 * 不可以). The owner's first owned mechanism is the request lane absorbed
 * from the host-global symbol: same algorithm, same guarantees, now scoped
 * to the owner that c3 will extend with scheduling and budgets.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { githubGatewayOwner } from '../src/github/gateway-owner.ts'

test('v0.2 keeps exactly one conservative credential scope per process', () => {
  assert.equal(githubGatewayOwner(), githubGatewayOwner(), 'same owner instance for every caller')
  assert.ok(githubGatewayOwner().credentialScopeId.length > 0, 'opaque scope identity exists')
})

test('owner lane serializes concurrent requests across resources', async () => {
  const starts: number[] = []
  let releaseFirst: (() => void) | null = null
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const owner = githubGatewayOwner()
  const run = (tag: string) =>
    owner.serializeRequest(20, async () => {
      starts.push(Date.now())
      if (tag === 'first') await firstBlocked
      return tag
    })
  const first = run('first')
  const second = run('second')
  for (let attempt = 0; attempt < 100 && starts.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(starts.length, 1, 'the second request waits for the first to settle')
  releaseFirst?.()
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second'])
  assert.ok(starts[1] - starts[0] >= 20, `requests started only ${starts[1] - starts[0]}ms apart`)
})

test('owner lane interval is a guarantee, not best-effort (re-checks the clock after wake)', async () => {
  const owner = githubGatewayOwner()
  const starts: number[] = []
  await owner.serializeRequest(30, async () => {
    starts.push(Date.now())
  })
  await owner.serializeRequest(30, async () => {
    starts.push(Date.now())
  })
  assert.ok(starts[1] - starts[0] >= 30, 'minimum start interval respected between sequential requests')
})
