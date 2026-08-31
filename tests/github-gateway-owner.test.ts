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
  // The pacing guarantee applies at the dispatch DECISION point; measuring
  // inside run() is subject to event-loop delay on loaded CI (the 29ms<30ms
  // lesson at 23d03b9) — the decisions are the scheduler's own timestamps.
  const decisions = owner
    .lifecycleEvents()
    .filter((event) => event.kind === 'dispatched')
    .map((event) => (event.kind === 'dispatched' ? event.at : 0))
  assert.equal(decisions.length, 2)
  assert.ok(
    decisions[1] - decisions[0] >= 20,
    `dispatch decisions respect the pacing interval (saw ${decisions[1] - decisions[0]}ms)`,
  )
})

test('r2: known-exhausted budget before deadline fails fast with retryAt', async () => {
  const { GithubRateLimitError } = await import('../src/github/rest.ts')
  const owner = createGithubGatewayOwner()
  // Prime the budget with a settled response showing remaining=0 and a reset
  // far in the future (epoch+3600).
  const farReset = Math.floor(Date.now() / 1000) + 3600
  owner.noteUpstreamSettled('gh-seed', true, {
    resource: 'core',
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

test('r2: pacing between sequential dispatch decisions is a guarantee', async () => {
  const owner = createGithubGatewayOwner()
  await owner.submitStep('o/r', 5_000, 30, async () => 'first')
  await owner.submitStep('o/r', 5_000, 30, async () => 'second')
  // The guarantee applies at the dispatch DECISION point (the monotonic
  // re-check inside the scheduler); measuring inside run() is subject to
  // microtask delay and can legitimately read < interval on slow runners.
  const decisions = owner
    .lifecycleEvents()
    .filter((event) => event.kind === 'dispatched')
    .map((event) => (event.kind === 'dispatched' ? event.at : 0))
  assert.equal(decisions.length, 2)
  assert.ok(decisions[1] - decisions[0] >= 30, `dispatch decisions only ${decisions[1] - decisions[0]}ms apart`)
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
  // r6/F7: a primary trip pauses the hit bucket on the SHARED owner — the
  // second reader's same-bucket request is fenced without another upstream
  // call (the per-bucket pause lives on the owner, not the reader).
  await assert.rejects(
    () => readerTwo.json('repos/o/r/y'),
    (error: unknown) => isGithubRateLimitError(error),
  )
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

test('r7/F3 regression: a mid-pacing candidate is settled by close() — promise, terminal, no execution', async () => {
  const owner = createGithubGatewayOwner()
  let executed = 0
  // First dispatch sets a long pacing gap; the victim is dequeued and pacing
  // INSIDE that gap when close() fires (review r7 reproduction).
  await owner.submitStep('pacer', 10_000, 500, () => {
    executed += 1
    return 'paced'
  })
  const requestId = owner.declareLogicalRequest('direct', 'pacing-victim')
  const victim = owner.runWithRequest(requestId, () =>
    owner.submitStep('victim-repo', 10_000, 0, () => {
      executed += 1
      return 'must-not-run'
    }),
  )
  // One microtask pass so the victim is DEQUEUED (mid-pacing), not still queued.
  await new Promise((resolve) => setTimeout(resolve, 30))
  await owner.close({ drainMs: 0 })
  await assert.rejects(() => victim, /节流等待中的步骤被中断|排队步骤被中断/)
  const terminals = owner
    .lifecycleEvents()
    .filter((event) => event.kind === 'terminal' && event.requestId === requestId)
  assert.equal(executed, 1, 'only the pacer ran; the mid-pacing victim must never execute')
  assert.equal(terminals.length, 1, `exactly one terminal, produced by the close path: ${JSON.stringify(terminals)}`)
  assert.equal(
    (terminals[0] as { outcome?: string }).outcome,
    'interrupted',
    'the mid-pacing victim terminal is the close interruption',
  )
})

test('r8/F2 regression: staggered same-repo sleepers never pass the 6/3 caps after waking', async () => {
  const owner = createGithubGatewayOwner()
  let active = 0
  let maxActive = 0
  const perRepo = new Map<string, number>()
  const maxPerRepo = new Map<string, number>()
  const track = (repo: string, delta: number) => {
    active += delta
    maxActive = Math.max(maxActive, active)
    const now = (perRepo.get(repo) ?? 0) + delta
    perRepo.set(repo, now)
    maxPerRepo.set(repo, Math.max(maxPerRepo.get(repo) ?? 0, now))
  }
  const submit = (repo: string, pacingMs: number) =>
    owner.submitStep(repo, 30_000, pacingMs, () => {
      track(repo, 1)
      return new Promise((resolve) =>
        setTimeout(() => {
          track(repo, -1)
          resolve(repo)
        }, 10),
      )
    })
  // One dispatch opens a 250ms pacing window; ten SAME-REPO requests arrive
  // staggered inside it — each sleeper must re-pass the caps when it wakes
  // (review r8 reproduction: 10 woke and ran together).
  const first = submit('o/r', 250)
  const sleepers = []
  for (let index = 0; index < 10; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 8))
    sleepers.push(submit('o/r', 0))
  }
  await Promise.all([first, ...sleepers])
  assert.ok(maxActive <= 6, `credential active peak ${maxActive} must stay ≤ 6`)
  assert.ok((maxPerRepo.get('o/r') ?? 0) <= 3, `repo active peak ${maxPerRepo.get('o/r')} must stay ≤ 3`)
  assert.equal(sleepers.length + 1, 11, 'every request completed')
})

test('r8/F2 regression: the cap recheck does not serialize different repositories', async () => {
  const owner = createGithubGatewayOwner()
  let concurrent = 0
  let maxConcurrent = 0
  const submit = (repo: string) =>
    owner.submitStep(repo, 30_000, 0, () => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      return new Promise((resolve) => setTimeout(() => resolve(repo), 40))
    })
  await Promise.all([submit('o/one'), submit('o/two'), submit('o/three'), submit('o/four')])
  assert.ok(maxConcurrent >= 2, `distinct repositories must still run in parallel (peak ${maxConcurrent})`)
})

test('r9/F7 regression: a learned special-resource bucket blocks its own path without touching core', async () => {
  const owner = createGithubGatewayOwner()
  const commands: string[] = []
  const ctx = {
    shell: {
      resolve: (spec: unknown) => spec,
      run: async (spec: { command: string }) => {
        commands.push(spec.command)
        const resource = /code-scanning/.test(spec.command) ? 'code_scanning_upload' : 'core'
        const headers = [
          'x-ratelimit-limit: 100',
          `x-ratelimit-remaining: ${/code-scanning/.test(spec.command) && commands.filter((c) => /code-scanning/.test(c)).length > 1 ? 0 : 50}`,
          `x-ratelimit-resource: ${resource}`,
          `x-ratelimit-reset: ${Math.floor(Date.now() / 1000) + 3600}`,
        ]
        const body = `HTTP/2.0 200 OK\n${headers.join('\n')}\n\n{"v":1}`
        return { exitCode: 0, stdout: { text: body }, stderr: { text: '' } }
      },
    },
  } as never
  const { GithubRestReader, isGithubRateLimitError } = await import('../src/github/rest.ts')
  const reader = new GithubRestReader(ctx, { owner, minimumIntervalMs: 1 })
  await reader.json('repos/o/r/code-scanning/alerts') // learns code_scanning_upload
  // The same path again with remaining:0 → the SECOND response reports 0 →
  // this request fails, the bucket pauses, and a subsequent core read still
  // executes (identity learned; core never polluted).
  const commandsBeforeCore = commands.length
  await reader.json('repos/o/r/code-scanning/alerts').catch((error: unknown) => {
    assert.ok(isGithubRateLimitError(error), 'the exhausted special bucket rate-limits its own path')
  })
  await reader.json('repos/o/r/issues/9')
  assert.ok(commands.length > commandsBeforeCore, 'the healthy core bucket still reaches the executor')
})

test('r9/F7 regression: a successful special-resource call never deducts the core ledger', async () => {
  const owner = createGithubGatewayOwner()
  const commands: string[] = []
  const ctx = {
    shell: {
      resolve: (spec: unknown) => spec,
      run: async (spec: { command: string }) => {
        commands.push(spec.command)
        const special = /code-scanning/.test(spec.command)
        const headers = [
          'x-ratelimit-limit: 100',
          `x-ratelimit-remaining: ${special ? 50 : 1}`,
          `x-ratelimit-resource: ${special ? 'code_scanning_upload' : 'core'}`,
          `x-ratelimit-reset: ${Math.floor(Date.now() / 1000) + 3600}`,
        ]
        return {
          exitCode: 0,
          stdout: { text: `HTTP/2.0 200 OK\n${headers.join('\n')}\n\n{"v":1}` },
          stderr: { text: '' },
        }
      },
    },
  } as never
  const { GithubRestReader } = await import('../src/github/rest.ts')
  const reader = new GithubRestReader(ctx, { owner, minimumIntervalMs: 1 })
  await reader.json('repos/o/r/code-scanning/alerts') // succeeds on the special bucket
  // Core reported remaining:1 and was never charged for the special call —
  // a core read must execute, not be rate-limited.
  await reader.json('repos/o/r/issues/9')
  assert.equal(
    commands.filter((command) => /issues\/9/.test(command)).length,
    1,
    'core executes after the special call',
  )
})

test('r9/idle regression: quiescence after deadline-fail, rate-limited fail, and mid-pacing settle', async () => {
  const owner = createGithubGatewayOwner()
  // (a) a step queued behind full repo slots whose deadline expires fails
  // and idle() resolves.
  const occupiers = [0, 1, 2].map((index) =>
    owner.submitStep('o/r', 30_000, 0, () => new Promise((resolve) => setTimeout(() => resolve(index), 40))),
  )
  await new Promise((resolve) => setTimeout(resolve, 5))
  await assert.rejects(() =>
    owner.runWithAdmission({ priority: 'normal', deadlineMs: 20, maxPages: 1 }, () =>
      owner.submitStep('o/r', 30_000, 0, () => new Promise(() => {})),
    ),
  )
  await Promise.all(occupiers)
  await owner.idle()

  // (b) a known-exhausted bucket rejects fast; idle() resolves.
  const ownerB = createGithubGatewayOwner()
  ownerB.noteUpstreamSettled('gh-seed', true, {
    resource: 'core',
    limit: 10,
    remaining: 0,
    reset: Math.floor(Date.now() / 1000) + 3600,
    retryAfterSeconds: null,
    observedAt: Date.now(),
  })
  await assert.rejects(() => ownerB.submitStep('o/r', 60_000, 0, () => 'never'))
  await ownerB.idle()

  // (c) A settles while B paces: idle() must NOT resolve before B runs.
  const ownerC = createGithubGatewayOwner()
  let startedB = false
  // A's 100ms pacing opens the window; B dequeues and paces inside it while
  // A settles at ~20ms — idle must hold until B actually runs.
  const a = ownerC.submitStep('repo-a', 30_000, 100, () => new Promise((resolve) => setTimeout(() => resolve('a'), 20)))
  await new Promise((resolve) => setTimeout(resolve, 5))
  const b = ownerC.submitStep('repo-b', 30_000, 0, () => {
    startedB = true
    return 'b'
  })
  const idlePromise = ownerC.idle()
  let idleResolved = false
  void idlePromise.then(() => {
    idleResolved = true
  })
  await new Promise((resolve) => setTimeout(resolve, 30)) // A settled (~25ms); B paces until ~105ms
  assert.equal(idleResolved, false, 'idle must hold while B paces even though A settled')
  assert.equal(startedB, false, 'B has not run yet inside the pacing window')
  await Promise.all([a, b])
  await idlePromise
  assert.ok(startedB, 'idle() resolves only after the pacing step actually ran')
})
