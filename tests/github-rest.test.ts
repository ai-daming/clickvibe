import assert from 'node:assert/strict'
import test from 'node:test'

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
  const starts: number[] = []
  let releaseFirst: (() => void) | null = null
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const fake = {
    shell: {
      resolve(spec: unknown) {
        return spec
      },
      async run() {
        starts.push(Date.now())
        if (starts.length === 1) await firstBlocked
        return { exitCode: 0, stdout: { text: included({ ok: true }) }, stderr: { text: '' } }
      },
    },
  }
  const reader = new GithubRestReader(fake as never, { minimumIntervalMs: 20 })
  const first = reader.json('repos/o/r/issues/1')
  const second = reader.json('repos/o/r/issues/2')
  try {
    for (let attempt = 0; attempt < 100 && starts.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(starts.length, 1, 'the second resource must wait for the first request to settle')
  } finally {
    releaseFirst?.()
  }
  await Promise.all([first, second])
  assert.equal(starts.length, 2)
  assert.ok(starts[1] - starts[0] >= 20, `requests started only ${starts[1] - starts[0]}ms apart`)
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
