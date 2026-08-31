/**
 * Gateway lifecycle stream (issue #131 slice A, c4; ADR-0010 §6/§10).
 *
 * One discriminative event stream per logical request is the ONLY metric
 * source: #133's logical/hit/join/execution/failure/rate counts derive from
 * it, and failure/rate terminals map to diagnostics. The #149 lessons are
 * pinned here as tests: loader-internal upstream steps belong to the loading
 * logical request (loaderDepth), missing rate headers stay unknown (never a
 * fabricated core bucket), and the identity logical = hit + join + execution
 * + non-success partitions every request exactly once.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createGithubGatewayOwner } from '../src/github/gateway-owner.ts'
import { deriveGatewayMetrics } from '../src/github/gateway-lifecycle.ts'
import { GithubRestReader } from '../src/github/rest.ts'

function okBody(
  body: unknown,
  headers: string[] = ['x-ratelimit-limit: 5000', 'x-ratelimit-remaining: 4999', 'x-ratelimit-reset: 1780000000'],
): string {
  return `HTTP/1.1 200\n${headers.join('\n')}\n\n${JSON.stringify(body)}`
}

function fakeCtx(run: (command: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>) {
  return {
    shell: {
      resolve: (spec: unknown) => spec,
      run: async (spec: { command: string }) => run(spec.command),
    },
  } as never
}

function okCtx(commands: string[], body: unknown = { v: 1 }, headers?: string[]) {
  return fakeCtx(async (command) => {
    commands.push(command)
    return { exitCode: 0, stdout: { text: okBody(body, headers) }, stderr: { text: '' } }
  })
}

test('cache hit: two calls → two logical requests, one execution, identity holds', async () => {
  const owner = createGithubGatewayOwner()
  const commands: string[] = []
  const ctx = okCtx(commands)
  const reader = new GithubRestReader(ctx, { owner })
  await reader.cachedResource('o/r/x', null, () => reader.json('repos/o/r/x'))
  await reader.cachedResource('o/r/x', null, () => reader.json('repos/o/r/x'))
  const metrics = deriveGatewayMetrics(owner.lifecycleEvents())
  assert.equal(metrics.logicalRequests, 2)
  assert.equal(metrics.cacheHits, 1)
  assert.equal(metrics.singleflightJoins, 0)
  assert.equal(metrics.executions, 1)
  assert.equal(metrics.failures, 0)
  assert.equal(metrics.rateLimited, 0)
  assert.equal(
    metrics.logicalRequests,
    metrics.cacheHits + metrics.singleflightJoins + metrics.executions + metrics.failures + metrics.rateLimited,
  )
  assert.equal(commands.length, 1)
})

test('singleflight join: follower never dispatches — asserted after full lane drain', async () => {
  const owner = createGithubGatewayOwner()
  const commands: string[] = []
  let release: (() => void) | null = null
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const ctx = fakeCtx(async (command) => {
    commands.push(command)
    await gate
    return { exitCode: 0, stdout: { text: okBody({ v: 1 }) }, stderr: { text: '' } }
  })
  // Fast pacing so the drain wait stays short; the assertion waits for the lane
  // to fully dequeue — the r1 lesson: checking before drain produced a green
  // test over a double dispatch.
  const reader = new GithubRestReader(ctx, { owner, minimumIntervalMs: 5 })
  const first = reader.cachedResource('o/r/slow', null, () => reader.json('repos/o/r/slow'))
  const second = reader.cachedResource('o/r/slow', null, () => reader.json('repos/o/r/slow'))
  await new Promise((resolve) => setTimeout(resolve, 20))
  release?.()
  await Promise.all([first, second])
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(commands.length, 1, 'exactly one upstream dispatch, asserted after lane drain')
  const metrics = deriveGatewayMetrics(owner.lifecycleEvents())
  assert.equal(metrics.singleflightJoins, 1)
  assert.equal(metrics.executions, 1)
  assert.equal(metrics.upstreamRequests, 1)
  const terminals = owner.lifecycleEvents().filter((event) => event.kind === 'terminal')
  assert.equal(terminals.length, 2, 'exactly one terminal per logical request')
  assert.equal(
    metrics.logicalRequests,
    metrics.cacheHits + metrics.singleflightJoins + metrics.executions + metrics.failures + metrics.rateLimited,
  )
})

test('r1 regression: HTTP 200 with a garbage body settles as a failed step, not a success', async () => {
  const owner = createGithubGatewayOwner()
  const ctx = fakeCtx(async () => ({
    exitCode: 0,
    stdout: { text: 'HTTP/1.1 200\nx-ratelimit-remaining: 4999\n\nnot-json{{{' },
    stderr: { text: '' },
  }))
  const reader = new GithubRestReader(ctx, { owner })
  await assert.rejects(() => reader.json('repos/o/r/garbage'))
  const settled = owner.lifecycleEvents().find((event) => event.kind === 'upstream-settled')
  assert.equal(settled?.kind === 'upstream-settled' ? settled.ok : null, false, 'parse failure settles ok=false')
  const metrics = deriveGatewayMetrics(owner.lifecycleEvents())
  assert.equal(metrics.failures, 1)
  assert.equal(metrics.executions, 0)
})

test('r1 regression: a late aggregate loader cannot republish across an invalidate', async () => {
  const owner = createGithubGatewayOwner()
  const commands: string[] = []
  let release: (() => void) | null = null
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let version = 0
  const ctx = fakeCtx(async (command) => {
    commands.push(command)
    if (command.includes('/issues?')) await gate // the aggregate's issue page hangs
    return { exitCode: 0, stdout: { text: okBody(version === 0 ? [] : [{ number: 1 }]) }, stderr: { text: '' } }
  })
  const reader = new GithubRestReader(ctx, { owner, minimumIntervalMs: 1 })
  const loadOne = reader.cachedAggregate('repo:o/r', 60_000, false, async () => {
    version = 0
    const issues = await reader.paginate('repos/o/r/issues?state=all')
    return { issues }
  })
  await new Promise((resolve) => setTimeout(resolve, 15))
  owner.invalidate('repo:o/r')
  version = 1
  release?.()
  await loadOne
  const loadTwo = await reader.cachedAggregate('repo:o/r', 60_000, false, async () => {
    const issues = await reader.paginate('repos/o/r/issues?state=all')
    return { issues }
  })
  assert.ok(
    (loadTwo.issues as unknown[]).length > 0,
    'the invalidated generation must not be served from the late loader',
  )
})

test('r1 regression: a gate floor propagates through the nested reviews read', async () => {
  const { githubRead } = await import('../src/github/operations.ts')
  let reviewCalls = 0
  let reviews = [{ user: { login: 'a' }, state: 'APPROVED', submitted_at: '2026-08-30T01:00:00Z' }]
  const prDetail = {
    number: 9,
    title: 'p',
    state: 'open',
    updated_at: 'SAME-VERSION',
    html_url: 'x',
    head: { ref: 'b', sha: 'abc' },
    base: { ref: 'main', sha: 'def' },
  }
  const ctx = fakeCtx(async (command) => {
    if (command.includes('/reviews')) {
      reviewCalls += 1
      return { exitCode: 0, stdout: { text: okBody(reviews) }, stderr: { text: '' } }
    }
    return { exitCode: 0, stdout: { text: okBody(prDetail) }, stderr: { text: '' } }
  })
  const intent = {
    operation: 'gate-pr-fact' as const,
    repoKey: 'o/r',
    number: 9,
    includeReviews: true,
    consistency: 'cache-ok' as const,
  }
  const first = await githubRead(ctx, intent)
  assert.equal(first.reviewDecision, 'APPROVED')
  reviews = [...reviews, { user: { login: 'b' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-08-30T02:00:00Z' }]
  const second = await githubRead(ctx, intent)
  assert.equal(reviewCalls, 2, 'the second gate read must re-fetch reviews despite an unchanged PR version')
  assert.equal(second.reviewDecision, 'CHANGES_REQUESTED')
})

test('loaderDepth: one logical request may settle multiple upstream steps (paginate)', async () => {
  const owner = createGithubGatewayOwner()
  const commands: string[] = []
  const ctx = fakeCtx(async (command) => {
    commands.push(command)
    // two pages of one paginate → two upstream steps
    const page = /page=2/.test(command) ? [] : Array.from({ length: 100 }, (_, index) => ({ id: index + 1 }))
    return { exitCode: 0, stdout: { text: okBody(page) }, stderr: { text: '' } }
  })
  const reader = new GithubRestReader(ctx, { owner })
  const values = await reader.paginate('repos/o/r/items')
  assert.equal(values.length, 100)
  const metrics = deriveGatewayMetrics(owner.lifecycleEvents())
  assert.equal(metrics.logicalRequests, 1, 'paginate is ONE logical request')
  assert.equal(metrics.upstreamRequests, 2, 'each page is its own upstream step')
  assert.equal(metrics.executions, 1)
})

test('failure: loader throw → terminal failed, identity holds, diagnostics record keeps raw error', async () => {
  const owner = createGithubGatewayOwner()
  const ctx = fakeCtx(async () => ({
    exitCode: 0,
    stdout: { text: 'HTTP/1.1 500\n\n{"message":"boom"}' },
    stderr: { text: '' },
  }))
  const reader = new GithubRestReader(ctx, { owner })
  await assert.rejects(() => reader.cachedResource('o/r/bad', null, () => reader.json('repos/o/r/bad')))
  const metrics = deriveGatewayMetrics(owner.lifecycleEvents())
  assert.equal(metrics.logicalRequests, 1)
  assert.equal(metrics.failures, 1)
  assert.equal(metrics.executions, 0, 'a failed execution is non-success, not a success execution')
  const events = owner.lifecycleEvents()
  const terminal = events.find((event) => event.kind === 'terminal')
  assert.equal(terminal?.kind === 'terminal' ? terminal.outcome : null, 'failed')
  assert.ok(terminal?.kind === 'terminal' && terminal.error && /500|boom/.test(terminal.error), 'raw error preserved')
})

test('rate observations: present headers recorded, absent headers stay unknown (never fabricated)', async () => {
  const owner = createGithubGatewayOwner()
  const withHeaders: string[] = []
  const readerWith = new GithubRestReader(okCtx(withHeaders, { v: 1 }), { owner })
  await readerWith.json('repos/o/r/with')
  const withoutHeaders: string[] = []
  const ownerTwo = createGithubGatewayOwner()
  const readerWithout = new GithubRestReader(
    fakeCtx(async (command) => {
      withoutHeaders.push(command)
      return {
        exitCode: 0,
        stdout: { text: `HTTP/1.1 200\n\n${JSON.stringify({ v: 2 })}` },
        stderr: { text: '' },
      }
    }),
    { owner: ownerTwo },
  )
  await readerWithout.json('repos/o/r/without')
  const withObs = owner.lifecycleEvents().find((event) => event.kind === 'upstream-settled' && event.ok)
  assert.ok(withObs?.kind === 'upstream-settled' && withObs.rate, 'observation present for headered response')
  assert.equal(withObs?.kind === 'upstream-settled' && withObs.rate?.remaining, 4999)
  const withoutObs = ownerTwo.lifecycleEvents().find((event) => event.kind === 'upstream-settled' && event.ok)
  assert.ok(
    withoutObs?.kind === 'upstream-settled' && withoutObs.rate === null,
    'headerless response keeps the rate observation unknown — no fabricated bucket',
  )
})

test('close: sealed owner rejects new logical requests', async () => {
  const owner = createGithubGatewayOwner()
  owner.close()
  const commands: string[] = []
  const reader = new GithubRestReader(okCtx(commands), { owner })
  await assert.rejects(
    () => reader.cachedResource('o/r/late', null, () => reader.json('repos/o/r/late')),
    /closed|关闭/,
  )
})

test('panel threshold shape: hot refresh round derives zero upstream GitHub requests', async () => {
  const owner = createGithubGatewayOwner()
  const commands: string[] = []
  const ctx = okCtx(commands, { v: 1 })
  const reader = new GithubRestReader(ctx, { owner })
  const load = () => reader.cachedResource('o/r/panel', null, () => reader.json('repos/o/r/panel'))
  await load()
  await load()
  const metrics = deriveGatewayMetrics(owner.lifecycleEvents())
  assert.equal(metrics.upstreamRequests, 1, 'cold round dispatched once')
  assert.equal(metrics.cacheHits, 1, 'hot round answered from the observation')
})
