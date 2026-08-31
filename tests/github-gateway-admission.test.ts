/**
 * Admission, budget and close fencing (issue #131 review round 2: F2/F7/F3).
 *
 * The operation policy must actually DRIVE admission: priority lanes, one
 * absolute logical deadline for every step (pagination continuations never
 * mint a fresh window) and a per-request dispatch (cost) bound. The rate
 * budget is a per-bucket ledger with atomic reservation at dispatch; late
 * responses after close can neither resolve callers, publish cache state nor
 * write a second terminal.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { beforeEach } from 'node:test'
import { createGithubGatewayOwner, resetGithubGatewayOwnerForTests } from '../src/github/gateway-owner.ts'

beforeEach(() => resetGithubGatewayOwnerForTests())

test('r5/F2: declared priority comes from the admission context, and gates read critical end to end', async () => {
  const owner = createGithubGatewayOwner()
  await owner.runWithAdmission({ priority: 'critical', deadlineMs: 5_000, maxPages: 2 }, async () => {
    const requestId = owner.declareLogicalRequest('direct', 'gate-key')
    await owner.submitStep('o/r', 1_000, 1, async () => 'value')
    const declared = owner.lifecycleEvents().find((event) => event.kind === 'declared' && event.requestId === requestId)
    assert.ok(declared?.kind === 'declared', 'the logical request was declared inside the context')
    assert.equal(declared.priority, 'critical', 'declared carries the policy priority')
  })
})

test('r5/F2: pagination continuations inherit the one absolute logical deadline', async () => {
  const owner = createGithubGatewayOwner()
  let releaseFirst: (() => void) | null = null
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  await owner.runWithAdmission({ priority: 'normal', deadlineMs: 60, maxPages: 5 }, async () => {
    owner.declareLogicalRequest('direct', 'pages')
    const first = owner.submitStep('o/r', 10_000, 1, async () => {
      await firstGate
      return 'page-1'
    })
    await new Promise((resolve) => setTimeout(resolve, 90))
    // The second page may not mint a fresh 10s window: the logical deadline
    // (now long past) must interrupt it while queued.
    await assert.rejects(() => owner.submitStep('o/r', 10_000, 1, async () => 'page-2'), /排队超过 deadline/)
    releaseFirst?.()
    await first
  })
})

test('r5/F2: exceeding the declared cost bound fails the logical request before dispatch', async () => {
  const owner = createGithubGatewayOwner()
  await owner.runWithAdmission({ priority: 'normal', deadlineMs: 30_000, maxPages: 1 }, async () => {
    const requestId = owner.declareLogicalRequest('direct', 'bounded')
    await owner.runWithRequest(requestId, async () => {
      await owner.submitStep('o/r', 1_000, 1, async () => 'page-1')
      assert.throws(() => owner.admitNextPage(), /成本上界/, 'page 2 is beyond the declared bound')
    })
  })
})

test('r5/F7: known remaining reserves atomically — one unit admits exactly one concurrent step', async () => {
  const owner = createGithubGatewayOwner()
  const farReset = Math.floor(Date.now() / 1000) + 3600
  owner.noteUpstreamSettled('gh-seed', true, {
    limit: 5000,
    remaining: 1,
    used: null,
    resource: 'core',
    reset: farReset,
    retryAfterSeconds: null,
    observedAt: Date.now(),
  })
  const started: string[] = []
  let release: (() => void) | null = null
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const submits = ['o/a', 'o/b', 'o/c'].map((repo) =>
    owner
      .submitStep(repo, 5_000, 1, async () => {
        started.push(repo)
        await gate
        return repo
      })
      .catch(() => 'rejected'),
  )
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(started.length, 1, `remaining=1 admits exactly one step (saw ${started.length})`)
  release?.()
  const outcomes = await Promise.all(submits)
  assert.equal(outcomes.filter((value) => value === 'rejected').length, 2, 'the other steps never dispatched')
})

test('r5/F7: primary exhaustion is per bucket — a search step is not blocked by core', async () => {
  const owner = createGithubGatewayOwner()
  const farReset = Math.floor(Date.now() / 1000) + 3600
  owner.noteUpstreamSettled('gh-seed', true, {
    limit: 5000,
    remaining: 0,
    used: null,
    resource: 'core',
    reset: farReset,
    retryAfterSeconds: null,
    observedAt: Date.now(),
  })
  let searchRan = false
  await owner.submitStep(
    'o/r',
    1_000,
    1,
    async () => {
      searchRan = true
      return 'search-ok'
    },
    { bucket: 'search' },
  )
  assert.ok(searchRan, 'a search-bucket step dispatches while core is exhausted')
  const { GithubRateLimitError } = await import('../src/github/rest.ts')
  await assert.rejects(
    () => owner.submitStep('o/r', 1_000, 1, async () => 'core-ok'),
    (error: unknown) => error instanceof GithubRateLimitError,
    'the core step still fails fast with a retryAt',
  )
})

test('r5/F7: unknown buckets probe conservatively — at most two concurrent probes', async () => {
  const owner = createGithubGatewayOwner()
  const started: string[] = []
  let release: (() => void) | null = null
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const submits = ['o/a', 'o/b', 'o/c'].map((repo) =>
    owner.submitStep(repo, 5_000, 1, async () => {
      started.push(repo)
      await gate
      return repo
    }),
  )
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(started.length, 2, `unknown budget probes at most two steps (saw ${started.length})`)
  release?.()
  assert.deepEqual((await Promise.all(submits)).sort(), ['o/a', 'o/b', 'o/c'])
})

test('r5/F7: secondary rate limits pause the whole credential', async () => {
  const { GithubRestReader, isGithubRateLimitError } = await import('../src/github/rest.ts')
  const owner = createGithubGatewayOwner()
  const tripped = {
    shell: {
      resolve: (spec: unknown) => spec,
      run: async () => ({
        exitCode: 0,
        stdout: { text: 'HTTP/1.1 429\nretry-after: 3600\n\n{"message":"secondary"}' },
        stderr: { text: '' },
      }),
    },
  } as never
  const reader = new GithubRestReader(tripped, { owner, minimumIntervalMs: 0 })
  await assert.rejects(
    () => reader.json('repos/o/r/x'),
    (error: unknown) => isGithubRateLimitError(error),
  )
  assert.ok(owner.rateLimitError(), 'the credential-level pause is open')
  await assert.rejects(
    () => reader.json('repos/o/r/y'),
    (error: unknown) => isGithubRateLimitError(error),
    'a later read is paused by the secondary circuit, not retried against GitHub',
  )
})

test('r5/F3: a late response after close never resolves the caller, publishes versions, or re-terminals', async () => {
  const { GithubRestReader } = await import('../src/github/rest.ts')
  const owner = createGithubGatewayOwner()
  let release: (() => void) | null = null
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const ctx = {
    shell: {
      resolve: (spec: unknown) => spec,
      run: async () => {
        await gate
        return {
          exitCode: 0,
          stdout: { text: 'HTTP/1.1 200\n\n{"updated_at":"late"}' },
          stderr: { text: '' },
        }
      },
    },
  } as never
  const reader = new GithubRestReader(ctx, { owner, minimumIntervalMs: 0 })
  const pending = reader.cachedResource('o/r/late', null, () => reader.json('repos/o/r/late'), {
    versionOf: (value: { updated_at?: string }) => value.updated_at,
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
  await owner.close({ drainMs: 0 })
  release?.()
  await assert.rejects(() => pending, /已关闭/, 'the late value must not resolve the caller')
  assert.equal(owner.resourceVersion('o/r/late'), null, 'the late value must not backfill the version store')
  const allTerminals = owner.lifecycleEvents().filter((event) => event.kind === 'terminal')
  assert.equal(allTerminals.length, 1, 'exactly ONE terminal for the request — the late rejection never re-terminals')
  assert.equal(
    allTerminals[0].kind === 'terminal' ? allTerminals[0].outcome : null,
    'interrupted',
    'and the preserved terminal is the close interruption',
  )
})

test('r5/F3: the owner flushes its evidence sink on close, in event order', async () => {
  const { GithubRestReader } = await import('../src/github/rest.ts')
  const written: string[] = []
  let flushed = false
  const owner = createGithubGatewayOwner({
    sink: {
      write: (event) => written.push(event.kind),
      flush: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        flushed = true
      },
    },
  })
  const ctx = {
    shell: {
      resolve: (spec: unknown) => spec,
      run: async () => ({ exitCode: 0, stdout: { text: 'HTTP/1.1 200\n\n{"v":1}' }, stderr: { text: '' } }),
    },
  } as never
  const reader = new GithubRestReader(ctx, { owner, minimumIntervalMs: 0 })
  await reader.cachedResource('o/r/evidence', null, () => reader.json('repos/o/r/evidence'))
  await owner.close({ drainMs: 0 })
  assert.ok(flushed, 'close() awaits the evidence flush')
  assert.equal(written[0], 'declared', 'the sink consumes the lifecycle stream from the first event')
  assert.equal(written.at(-1), 'terminal', 'and sees the terminal before the flush')
})

test('r5/F3: the plugin unload effect closes the process owner', async () => {
  const { apply } = await import('../src/index.ts')
  const { githubGatewayOwner } = await import('../src/github/gateway-owner.ts')
  const disposers: Array<() => unknown> = []
  const fakeCtx = {
    jobs: { attachController() {} },
    skills: {
      register() {
        return () => {}
      },
    },
    webServer: {
      register() {
        return () => {}
      },
    },
    effect: (execute: () => unknown) => {
      const teardown = execute()
      disposers.push(async () => {
        await teardown()
      })
      return () => {}
    },
  } as never
  apply(fakeCtx)
  const before = githubGatewayOwner()
  await disposers[0]()
  await assert.rejects(() => before.submitStep('o/r', 1_000, 1, async () => 'late'), /已关闭/)
  assert.notEqual(githubGatewayOwner(), before, 'a fresh owner owns the next credential generation')
  await githubGatewayOwner().close({ drainMs: 0 })
})
