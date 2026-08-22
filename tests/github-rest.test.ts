import assert from 'node:assert/strict'
import test from 'node:test'

import {
  GithubRateLimitError,
  GithubRestReader,
  deriveReviewDecision,
} from '../src/github-rest.ts'

function shellWith(responses: Array<{ exitCode: number; stdout: string; stderr?: string }>) {
  const commands: string[] = []
  return {
    commands,
    shell: {
      resolve(spec: unknown) { return spec },
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
    reader.json<{ title: string }>('repos/o/r/issues/1'))
  const second = await reader.cachedResource('o/r/issues/1', 'v1', async () =>
    reader.json<{ title: string }>('repos/o/r/issues/1'))

  assert.equal(first.title, 'first')
  assert.equal(second, first)
  assert.equal(fake.commands.length, 1)
  assert.match(fake.commands[0], /^gh api /)
})

test('REST reader opens a circuit after rate limiting and reports the reset time without another request', async () => {
  const resetAt = 1_800_000_000
  const fake = shellWith([{
    exitCode: 1,
    stdout: [
      'HTTP/2.0 403 Forbidden',
      'x-ratelimit-remaining: 0',
      `x-ratelimit-reset: ${resetAt}`,
      '',
      JSON.stringify({ message: 'API rate limit exceeded' }),
    ].join('\n'),
  }])
  const reader = new GithubRestReader(fake as never)

  await assert.rejects(() => reader.json('repos/o/r/issues/1'), GithubRateLimitError)
  await assert.rejects(() => reader.json('repos/o/r/issues/2'), (error: unknown) => {
    assert.ok(error instanceof GithubRateLimitError)
    assert.equal(error.resetAt, resetAt * 1000)
    assert.match(error.message, /^GitHub 额度已用完,约 \d{2}:\d{2} 恢复$/)
    return true
  })
  assert.equal(fake.commands.length, 1)
})

test('review decision uses each reviewer latest decisive review', () => {
  assert.equal(deriveReviewDecision([
    { id: 1, user: { login: 'alice' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-08-22T01:00:00Z' },
    { id: 2, user: { login: 'alice' }, state: 'APPROVED', submitted_at: '2026-08-22T02:00:00Z' },
    { id: 3, user: { login: 'bob' }, state: 'COMMENTED', submitted_at: '2026-08-22T03:00:00Z' },
  ]), 'APPROVED')
  assert.equal(deriveReviewDecision([
    { id: 4, user: { login: 'alice' }, state: 'APPROVED', submitted_at: '2026-08-22T01:00:00Z' },
    { id: 5, user: { login: 'bob' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-08-22T02:00:00Z' },
  ]), 'CHANGES_REQUESTED')
  assert.equal(deriveReviewDecision([]), null)
})
