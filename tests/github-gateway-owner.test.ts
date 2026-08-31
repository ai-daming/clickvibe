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

test('every owner declares the single conservative v0.2 credential scope', () => {
  const first = createGithubGatewayOwner()
  const second = createGithubGatewayOwner()
  assert.ok(first.credentialScopeId.length > 0, 'opaque scope identity exists')
  assert.equal(first.credentialScopeId, second.credentialScopeId, 'one scope: gh host auth cannot be split')
  assert.notEqual(first, second, 'distinct owner instances (per-ctx resolution keeps tests isolated)')
})

test('owner lane serializes concurrent requests across resources', async () => {
  const starts: number[] = []
  let releaseFirst: (() => void) | null = null
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const owner = createGithubGatewayOwner()
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
  const owner = createGithubGatewayOwner()
  const starts: number[] = []
  await owner.serializeRequest(30, async () => {
    starts.push(Date.now())
  })
  await owner.serializeRequest(30, async () => {
    starts.push(Date.now())
  })
  assert.ok(starts[1] - starts[0] >= 30, 'minimum start interval respected between sequential requests')
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
