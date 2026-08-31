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
import { createGithubGatewayOwner } from '../src/github/gateway-owner.ts'

test('r2: one process-level owner per credential scope; factories isolate tests', async () => {
  const { githubGatewayOwner, resetGithubGatewayOwnerForTests } = await import('../src/github/gateway-owner.ts')
  resetGithubGatewayOwnerForTests()
  const first = githubGatewayOwner()
  assert.strictEqual(githubGatewayOwner(), first, 'the process registry returns THE owner (ADR-0010 Decision 1)')
  assert.ok(first.credentialScopeId.length > 0, 'opaque scope identity exists')
  const isolated = createGithubGatewayOwner()
  assert.equal(isolated.credentialScopeId, first.credentialScopeId, 'one scope: gh host auth cannot be split')
  assert.notEqual(isolated, first, 'factories remain available for isolated tests')
  await first.close({ drainMs: 50 })
  resetGithubGatewayOwnerForTests()
})

test('r2: a slow step does not block another repository — pacing holds between starts', async () => {
  const owner = createGithubGatewayOwner()
  const starts: Array<{ repo: string; at: number }> = []
  let releaseSlow: (() => void) | null = null
  const slowGate = new Promise<void>((resolve) => {
    releaseSlow = resolve
  })
  const step = (repo: string, slow: boolean) =>
    owner.submitStep(repo, 30_000, 20, async () => {
      starts.push({ repo, at: Date.now() })
      if (slow) await slowGate
      return repo
    })
  const slow = step('o/slow', true)
  const other = step('o/other', false)
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(
    starts.filter((entry) => entry.repo === 'o/other').length,
    1,
    'unrelated repo dispatched despite slow step',
  )
  assert.equal(starts.filter((entry) => entry.repo === 'o/slow').length, 1, 'slow step started too')
  releaseSlow?.()
  assert.deepEqual(await Promise.all([slow, other]), ['o/slow', 'o/other'])
  if (starts.length >= 2) {
    const sorted = [...starts].sort((left, right) => left.at - right.at)
    assert.ok(
      sorted[1].at - sorted[0].at >= 20,
      `dispatch starts respect the pacing interval (saw ${sorted[1].at - sorted[0].at}ms)`,
    )
  }
})

test('r2: known-exhausted budget before deadline fails fast with retryAt', async () => {
  const { GithubRateLimitError } = await import('../src/github/rest.ts')
  const owner = createGithubGatewayOwner()
  // Prime the budget with a settled response showing remaining=0 and a reset
  // far in the future (epoch+3600).
  const farReset = Math.floor(Date.now() / 1000) + 3600
  owner.noteUpstreamSettled('gh-seed', true, {
    limit: 5000,
    remaining: 0,
    reset: farReset,
    retryAfterSeconds: null,
    observedAt: Date.now(),
  })
  await assert.rejects(
    () => owner.submitStep('o/r', 5_000, 1, async () => 'never'),
    (error: unknown) => {
      assert.ok(error instanceof GithubRateLimitError, 'rejection carries a retryAt')
      assert.ok(error.resetAt > Date.now(), 'retryAt points at the bucket reset')
      return true
    },
  )
  const terminal = owner
    .lifecycleEvents()
    .find((event) => event.kind === 'terminal' && event.outcome === 'rate-limited')
  assert.ok(terminal, 'a rate-limited terminal is recorded for the rejected step')
})

test('r2: pacing between sequential starts is a guarantee', async () => {
  const owner = createGithubGatewayOwner()
  const starts: number[] = []
  await owner.submitStep('o/r', 5_000, 30, async () => {
    starts.push(Date.now())
  })
  await owner.submitStep('o/r', 5_000, 30, async () => {
    starts.push(Date.now())
  })
  assert.ok(starts[1] - starts[0] >= 30, `starts only ${starts[1] - starts[0]}ms apart`)
})

test('c3: owners host the cache — two readers on one owner share facts and singleflight', async () => {
  const { GithubRestReader } = await import('../src/github/rest.ts')
  const owner = createGithubGatewayOwner()
  const commands: string[] = []
  const fakeCtx = () =>
    ({
      shell: {
        resolve: (spec: unknown) => spec,
        run: async (spec: { command: string }) => {
          commands.push(spec.command)
          return {
            exitCode: 0,
            stdout: { text: `HTTP/1.1 200\nx-ratelimit-remaining: 4999\n\n{"v":1}` },
            stderr: { text: '' },
          }
        },
      },
    }) as never
  const readerOne = new GithubRestReader(fakeCtx(), { owner })
  const readerTwo = new GithubRestReader(fakeCtx(), { owner })
  const loadOne = await readerOne.cachedResource('o/r/shared', null, () => readerOne.json('repos/o/r/shared'))
  const loadTwo = await readerTwo.cachedResource('o/r/shared', null, () => readerTwo.json('repos/o/r/shared'))
  assert.equal(loadOne, loadTwo, 'the second reader reuses the first observation through the owner')
  assert.equal(commands.length, 1, 'one upstream dispatch for both readers')
})

test('c3: a rate-limit trip on one reader is visible through the shared owner', async () => {
  const { GithubRestReader, isGithubRateLimitError } = await import('../src/github/rest.ts')
  const owner = createGithubGatewayOwner()
  const tripped = fakeShellReturning(
    'HTTP/1.1 403\nx-ratelimit-remaining: 0\nx-ratelimit-reset: 0\n\n{"message":"rate limit"}',
  )
  const readerOne = new GithubRestReader(tripped as never, { owner })
  const readerTwo = new GithubRestReader(tripped as never, { owner })
  await assert.rejects(
    () => readerOne.json('repos/o/r/x'),
    (error: unknown) => isGithubRateLimitError(error),
  )
  assert.ok(readerTwo.rateLimitError(), 'the circuit lives on the owner, shared across readers')
})

test('c3: githubRest resolves one stable owner per ctx', async () => {
  const { githubRest } = await import('../src/github/rest.ts')
  const ctx = {
    shell: {
      resolve: (s: unknown) => s,
      run: async () => ({ exitCode: 0, stdout: { text: 'HTTP/1.1 200\n\n{}' }, stderr: { text: '' } }),
    },
  } as never
  assert.equal(githubRest(ctx), githubRest(ctx), 'one reader per ctx as today')
})

function fakeShellReturning(raw: string): { shell: unknown } {
  return {
    shell: {
      resolve: (spec: unknown) => spec,
      run: async () => ({ exitCode: 0, stdout: { text: raw }, stderr: { text: '' } }),
    },
  }
}
