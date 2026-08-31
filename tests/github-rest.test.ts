import assert from 'node:assert/strict'
import { createGithubGatewayOwner } from '../src/github/gateway-owner.ts'
import test from 'node:test'

import { fetchGithubPrFact } from '../src/github/facts.ts'
import { GithubRateLimitError, GithubRestReader, deriveReviewDecision, githubRest } from '../src/github/rest.ts'

function shellWith(responses: Array<{ exitCode: number; stdout: string; stderr?: string }>) {
  const commands: string[] = []
  return {
    commands,
    shell: {
      resolve(spec: unknown) {
        return spec
      },
      async run(spec: { command: string }) {
        commands.push(spec.command)
        const response = responses.shift()
        if (!response) throw new Error(`unexpected command: ${spec.command}`)
        return {
          exitCode: response.exitCode,
          stdout: { text: response.stdout },
          stderr: { text: response.stderr ?? '' },
        }
      },
    },
  }
}

function included(body: unknown, headers: Record<string, string> = {}): string {
  return [
    'HTTP/2.0 200 OK',
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    '',
    JSON.stringify(body),
  ].join('\n')
}

test('REST reader only invokes gh api and reuses a resource while its known version is unchanged', async () => {
  const fake = shellWith([{ exitCode: 0, stdout: included({ updated_at: 'v1', title: 'first' }, { etag: '"one"' }) }])
  const reader = new GithubRestReader(fake as never)

  const first = await reader.cachedResource('o/r/issues/1', 'v1', async () =>
    reader.json<{ title: string }>('repos/o/r/issues/1'),
  )
  const second = await reader.cachedResource('o/r/issues/1', 'v1', async () =>
    reader.json<{ title: string }>('repos/o/r/issues/1'),
  )

  assert.equal(first.title, 'first')
  assert.equal(second, first)
  assert.equal(fake.commands.length, 1)
  assert.match(fake.commands[0], /^gh api /)
})

test('a known resource version never bypasses TTL expiry', async () => {
  const reader = new GithubRestReader({} as never)
  let loads = 0
  const first = await reader.cachedResource(
    'o/r/pulls/1',
    'v1',
    async () => ({ updated_at: 'v1', base: 'release/a', load: ++loads }),
    { ttlMs: 1, versionOf: (value) => value.updated_at },
  )
  await new Promise((resolve) => setTimeout(resolve, 5))
  const second = await reader.cachedResource(
    'o/r/pulls/1',
    'v1',
    async () => ({ updated_at: 'v2', base: 'release/b', load: ++loads }),
    { ttlMs: 1, versionOf: (value) => value.updated_at },
  )

  assert.equal(first.base, 'release/a')
  assert.equal(second.base, 'release/b')
  assert.equal(loads, 2)
})

test('critical PR fact reads force a fresh base identity', async () => {
  const fake = shellWith([
    {
      exitCode: 0,
      stdout: included({
        number: 1,
        state: 'open',
        updated_at: 'v1',
        head: { ref: 'feature', sha: 'fff1111' },
        base: { ref: 'release/a', sha: 'aaa1111' },
      }),
    },
    {
      exitCode: 0,
      stdout: included({
        number: 1,
        state: 'open',
        updated_at: 'v2',
        head: { ref: 'feature', sha: 'fff1111' },
        base: { ref: 'release/b', sha: 'bbb2222' },
      }),
    },
  ])

  const first = await fetchGithubPrFact(fake as never, 'o/r', 'feature', '1', false, true)
  const second = await fetchGithubPrFact(fake as never, 'o/r', 'feature', '1', false, true)

  assert.equal(first.pr?.baseRefName, 'release/a')
  assert.equal(second.pr?.baseRefName, 'release/b')
  assert.equal(second.pr?.baseRefOid, 'bbb2222')
  assert.equal(fake.commands.length, 2)
})

test('a forced resource read never joins or gets overwritten by an older ordinary read', async () => {
  const reader = new GithubRestReader({} as never)
  let releaseOrdinary: (() => void) | undefined
  let ordinaryStarted: (() => void) | undefined
  const started = new Promise<void>((resolve) => {
    ordinaryStarted = resolve
  })
  const held = new Promise<void>((resolve) => {
    releaseOrdinary = resolve
  })
  let loads = 0

  const ordinary = reader.cachedResource(
    'o/r/pulls/2',
    null,
    async () => {
      loads += 1
      ordinaryStarted?.()
      await held
      return { updated_at: 'v1', base: 'release/a' }
    },
    { versionOf: (value) => value.updated_at },
  )
  await started
  const forcedRead = reader.cachedResource(
    'o/r/pulls/2',
    null,
    async () => {
      loads += 1
      return { updated_at: 'v2', base: 'release/b' }
    },
    { force: true, versionOf: (value) => value.updated_at },
  )
  await new Promise((resolve) => setImmediate(resolve))
  releaseOrdinary?.()
  await ordinary
  const forced = await forcedRead
  const cached = await reader.cachedResource(
    'o/r/pulls/2',
    'v2',
    async () => {
      throw new Error('newer forced value must remain cached')
    },
    { versionOf: (value) => value.updated_at },
  )

  assert.equal(loads, 2)
  assert.equal(forced.base, 'release/b')
  assert.equal(cached.base, 'release/b')
})

test('an ordinary resource read started during a force refresh shares the authoritative refresh', async () => {
  const reader = new GithubRestReader({} as never)
  let releaseForce: (() => void) | undefined
  let forceStarted: (() => void) | undefined
  const started = new Promise<void>((resolve) => {
    forceStarted = resolve
  })
  const held = new Promise<void>((resolve) => {
    releaseForce = resolve
  })
  let ordinaryLoads = 0
  const forced = reader.cachedResource(
    'o/r/pulls/3',
    null,
    async () => {
      forceStarted?.()
      await held
      return { updated_at: 'v2', base: 'release/b' }
    },
    { force: true, versionOf: (value) => value.updated_at },
  )
  await started
  const ordinary = reader.cachedResource(
    'o/r/pulls/3',
    null,
    async () => {
      ordinaryLoads += 1
      return { updated_at: 'v1', base: 'release/a' }
    },
    { versionOf: (value) => value.updated_at },
  )
  releaseForce?.()

  assert.equal((await forced).base, 'release/b')
  assert.equal((await ordinary).base, 'release/b')
  assert.equal(ordinaryLoads, 0)
})

test('overlapping forced resource reads each reload and only the later call may populate the cache', async () => {
  const reader = new GithubRestReader({} as never)
  let releaseFirst: (() => void) | undefined
  let firstStarted: (() => void) | undefined
  const started = new Promise<void>((resolve) => {
    firstStarted = resolve
  })
  const held = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  let loads = 0
  const first = reader.cachedResource(
    'o/r/pulls/4',
    null,
    async () => {
      loads += 1
      firstStarted?.()
      await held
      return { updated_at: 'v1', base: 'release/a' }
    },
    { force: true, versionOf: (value) => value.updated_at },
  )
  await started
  const second = reader.cachedResource(
    'o/r/pulls/4',
    null,
    async () => {
      loads += 1
      return { updated_at: 'v2', base: 'release/b' }
    },
    { force: true, versionOf: (value) => value.updated_at },
  )
  await new Promise((resolve) => setImmediate(resolve))
  const overlappingLoads = loads
  releaseFirst?.()

  assert.equal((await first).base, 'release/a')
  assert.equal((await second).base, 'release/b')
  assert.equal(overlappingLoads, 2)
  const cached = await reader.cachedResource(
    'o/r/pulls/4',
    'v2',
    async () => {
      throw new Error('the later force result must remain cached')
    },
    { versionOf: (value) => value.updated_at },
  )
  assert.equal(cached.base, 'release/b')
})

test('REST reader opens a circuit after rate limiting and reports the reset time without another request', async () => {
  const resetAt = 1_800_000_000
  const fake = shellWith([
    {
      exitCode: 1,
      stdout: [
        'HTTP/2.0 403 Forbidden',
        'x-ratelimit-remaining: 0',
        `x-ratelimit-reset: ${resetAt}`,
        '',
        JSON.stringify({ message: 'API rate limit exceeded' }),
      ].join('\n'),
    },
  ])
  const reader = new GithubRestReader(fake as never)

  await assert.rejects(() => reader.json('repos/o/r/issues/1'), GithubRateLimitError)
  await assert.rejects(
    () => reader.json('repos/o/r/issues/2'),
    (error: unknown) => {
      assert.ok(error instanceof GithubRateLimitError)
      assert.equal(error.resetAt, resetAt * 1000)
      assert.match(error.message, /^GitHub 额度已用完,约 \d{2}:\d{2} 恢复$/)
      return true
    },
  )
  assert.equal(fake.commands.length, 1)
})

test('an open secondary-rate circuit preserves retry-after classification on queued reads', async () => {
  const fake = shellWith([
    {
      exitCode: 1,
      stdout: [
        'HTTP/2.0 403 Forbidden',
        'retry-after: 60',
        'x-ratelimit-remaining: 5000',
        '',
        JSON.stringify({ message: 'You have exceeded a secondary rate limit' }),
      ].join('\n'),
    },
  ])
  const reader = new GithubRestReader(fake as never)
  await assert.rejects(() => reader.json('repos/o/r/issues/1'), GithubRateLimitError)
  await assert.rejects(
    () => reader.json('repos/o/r/issues/2'),
    (error: unknown) => error instanceof GithubRateLimitError && error.kind === 'secondary',
  )
  assert.equal(fake.commands.length, 1)
})

test('host REST requests are serialized across resources and respect a minimum start interval', async () => {
  let releaseFirst: (() => void) | null = null
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  let runs = 0
  const fake = {
    shell: {
      resolve(spec: unknown) {
        return spec
      },
      async run() {
        runs += 1
        if (runs === 1) await firstBlocked
        return { exitCode: 0, stdout: { text: included({ ok: true }) }, stderr: { text: '' } }
      },
    },
  }
  const owner = createGithubGatewayOwner()
  const reader = new GithubRestReader(fake as never, { minimumIntervalMs: 20, owner })
  const first = reader.json('repos/o/r/issues/1')
  const second = reader.json('repos/o/r/issues/2')
  try {
    for (let attempt = 0; attempt < 100 && runs === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(runs, 1, 'the second resource must wait for the first request to settle')
  } finally {
    releaseFirst?.()
  }
  await Promise.all([first, second])
  assert.equal(runs, 2)
  // Under the admission scheduler the pacing guarantee applies at the
  // dispatch DECISION (the lifecycle dispatched `at`); the shell run sits a
  // microtask hop downstream and can read under the interval on slow CI.
  const decisions = owner
    .lifecycleEvents()
    .filter((event) => event.kind === 'dispatched')
    .map((event) => (event.kind === 'dispatched' ? event.at : 0))
  assert.equal(decisions.length, 2)
  assert.ok(decisions[1] - decisions[0] >= 20, `dispatch decisions only ${decisions[1] - decisions[0]}ms apart`)
})

test('review decision uses each reviewer latest decisive review', () => {
  assert.equal(
    deriveReviewDecision([
      { id: 1, user: { login: 'alice' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-08-22T01:00:00Z' },
      { id: 2, user: { login: 'alice' }, state: 'APPROVED', submitted_at: '2026-08-22T02:00:00Z' },
      { id: 3, user: { login: 'bob' }, state: 'COMMENTED', submitted_at: '2026-08-22T03:00:00Z' },
    ]),
    'APPROVED',
  )
  assert.equal(
    deriveReviewDecision([
      { id: 4, user: { login: 'alice' }, state: 'APPROVED', submitted_at: '2026-08-22T01:00:00Z' },
      { id: 5, user: { login: 'bob' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-08-22T02:00:00Z' },
    ]),
    'CHANGES_REQUESTED',
  )
  assert.equal(deriveReviewDecision([]), null)
})

test('REST mutation sends JSON on stdin instead of interpolating issue content into the shell command', async () => {
  let resolved: { command: string; stdin?: string } | null = null
  const ctx = {
    shell: {
      resolve(spec: { command: string; stdin?: string }) {
        resolved = spec
        return spec
      },
      async run() {
        return { exitCode: 0, stdout: { text: included({ updated_at: 'now' }) }, stderr: { text: '' } }
      },
    },
  }
  const result = await githubRest(ctx).mutate<{ updated_at: string }>('repos/o/r/issues/9', 'PATCH', {
    body: '$(do-not-expand)',
  })
  assert.equal(result.updated_at, 'now')
  assert.match(resolved?.command ?? '', /--method PATCH --input -/)
  assert.doesNotMatch(resolved?.command ?? '', /do-not-expand/)
  assert.equal(resolved?.stdin, JSON.stringify({ body: '$(do-not-expand)' }))
})

test('r5/F3: a 2xx non-array page settles ok=false — shape validation precedes the upstream settlement', async () => {
  const owner = createGithubGatewayOwner()
  const ctx = {
    shell: {
      resolve: (spec: unknown) => spec,
      run: async () => ({
        exitCode: 0,
        stdout: { text: 'HTTP/1.1 200\n\n{"message":"not-a-list"}' },
        stderr: { text: '' },
      }),
    },
  } as never
  const reader = new GithubRestReader(ctx, { owner, minimumIntervalMs: 0 })
  await assert.rejects(() => reader.paginate('repos/o/r/issues/1/comments'), /分页返回格式无效/)
  const settled = owner
    .lifecycleEvents()
    .filter((event) => event.kind === 'upstream-settled')
    .at(-1)
  assert.equal(
    settled?.kind === 'upstream-settled' ? settled.ok : null,
    false,
    'a bad-shape page is a failed settlement',
  )
})

test('r5/F2: pagination runs inside the declared cost bound and fails closed past it', async () => {
  const owner = createGithubGatewayOwner()
  const commands: string[] = []
  const fullPage = Array.from({ length: 100 }, (_, index) => ({ id: index + 1 }))
  const ctx = {
    shell: {
      resolve: (spec: unknown) => spec,
      run: async (spec: { command: string }) => {
        commands.push(spec.command)
        return { exitCode: 0, stdout: { text: included(fullPage) }, stderr: { text: '' } }
      },
    },
  } as never
  const reader = new GithubRestReader(ctx, { owner, minimumIntervalMs: 0 })
  await owner.runWithAdmission({ priority: 'normal', deadlineMs: 300_000, maxPages: 3 }, async () => {
    await assert.rejects(
      () => reader.paginate('repos/o/r/issues/1/comments'),
      /成本上界/,
      'page 4 is beyond the declared bound and must fail the logical request',
    )
  })
  assert.equal(commands.length, 3, 'exactly maxPages pages dispatched before the bound failed the request')
})
