/**
 * Gateway evidence (issue #131 slice A, review closure round 2): the frozen
 * #133 evidence classes that already have production consumers — failures
 * (both levels, including pre-parse and transport failures), per-response
 * rate-limit samples (same-bucket responses never overwrite), and
 * invalidations (generation, reason/trigger, subsequent observation vs
 * unknown) — plus persisted-diagnostics readback proof. Numeric access
 * counters are deferred to the slice that consumes them (threshold
 * assertions, scheduling).
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { GithubRestReader } from '../src/github/rest.ts'

interface ShellResult {
  exitCode: number | null
  stdout: { text: string; truncated?: boolean; spillPath?: string }
  stderr?: { text?: string }
}

function included(status = 200, body = 'null', headers: Record<string, string> = {}): string {
  const headerLines = Object.entries(headers)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')
  return `HTTP/1.1 ${status} OK\n${headerLines}\n\n${body}`
}

function rateHeaders(remaining: string): Record<string, string> {
  return {
    'x-ratelimit-resource': 'core',
    'x-ratelimit-limit': '5000',
    'x-ratelimit-remaining': remaining,
    'x-ratelimit-reset': '1893456000',
  }
}

function okShell(result: ShellResult) {
  const commands: string[] = []
  return {
    commands,
    ctx: {
      shell: {
        resolve: (spec: unknown) => spec,
        run: async (spec: { command: string }) => {
          commands.push(spec.command)
          return result
        },
      },
    },
  }
}

test('same-bucket responses append samples instead of overwriting', async () => {
  const responses = [
    { exitCode: 0, stdout: { text: included(200, '1', rateHeaders('4999')) } },
    { exitCode: 0, stdout: { text: included(200, '2', rateHeaders('4998')) } },
  ]
  let index = 0
  const ctx = {
    shell: {
      resolve: (spec: unknown) => spec,
      run: async () => {
        const next = responses[Math.min(index, responses.length - 1)]
        index++
        return next
      },
    },
  }
  const reader = new GithubRestReader(ctx as never)
  await reader.json('repos/o/r/first')
  await reader.json('repos/o/r/second')
  // Every response is recoverable from the append-only series (review gap 1).
  assert.deepEqual(
    reader.evidence.rateLimitSamples.map((sample) => sample.used),
    [1, 2],
  )
  // The bucket view keeps the latest observation for the trip diagnostic.
  assert.equal(reader.evidence.rateLimitBuckets.core?.used, 2)
  assert.equal(reader.evidence.rateLimitBuckets.core?.remaining, 4998)
})

test('non-HTTP CLI failure keeps the upstream level with the raw operation', async () => {
  const { ctx } = okShell({ exitCode: 1, stdout: { text: 'gh: some CLI failure' } })
  const reader = new GithubRestReader(ctx as never)
  await assert.rejects(
    reader.cachedResource('detail:o/r/1', null, () => reader.json('repos/o/r/issues/1')),
    /CLI failure/,
  )
  const upstream = reader.evidence.failureRecords.find((record) => record.level === 'upstream')
  assert.equal(upstream?.operation, 'GET repos/o/r/issues/1', 'the child that failed is named before any parse')
  const access = reader.evidence.failureRecords.find((record) => record.level === 'access')
  assert.equal(access?.scope, 'detail:o/r/1')
})

test('shell rejection keeps the upstream level (transport dispatched, transport failed)', async () => {
  const ctx = {
    shell: {
      resolve: (spec: unknown) => spec,
      run: async () => {
        throw new Error('shell exploded')
      },
    },
  }
  const reader = new GithubRestReader(ctx as never)
  await assert.rejects(reader.json('repos/o/r'), /shell exploded/)
  assert.equal(reader.evidence.failureRecords[0].level, 'upstream')
  assert.equal(reader.evidence.failureRecords[0].operation, 'GET repos/o/r')
})

test('parseable HTTP failures keep both levels', async () => {
  const { ctx } = okShell({ exitCode: 0, stdout: { text: included(500, '{"message":"boom"}', rateHeaders('4998')) } })
  const reader = new GithubRestReader(ctx as never)
  await assert.rejects(reader.json('repos/o/r/pulls'), /GitHub REST 500: boom/)
  assert.deepEqual(
    reader.evidence.failureRecords.map((record) => record.level),
    ['upstream', 'access'],
  )
  assert.equal(reader.evidence.failureRecords[0].operation, 'GET repos/o/r/pulls')
})

test('invalidations carry generation, reason/trigger and complete on subsequent observation', async () => {
  const { ctx } = okShell({ exitCode: 0, stdout: { text: included(200, '"v"', rateHeaders('4998')) } })
  const reader = new GithubRestReader(ctx as never)
  reader.invalidate('repo:o/r', 'comment-published', 'publishDeliveryComment')
  reader.invalidate('repo:o/r', 'pr-merged', 'mergeAndCleanup')
  reader.invalidate('repo:o/r/pulls/9', 'pr-merged', 'mergeAndCleanup')
  // Same-prefix repeats advance the generation; sibling prefixes keep their own.
  assert.deepEqual(
    reader.evidence.invalidationRecords.map((record) => [
      record.generation,
      record.prefix,
      record.reason,
      record.status,
    ]),
    [
      [1, 'repo:o/r', 'comment-published', 'pending'],
      [2, 'repo:o/r', 'pr-merged', 'pending'],
      [1, 'repo:o/r/pulls/9', 'pr-merged', 'pending'],
    ],
  )

  // A subsequent cached load under a matching prefix completes every pending
  // record it satisfies; an unrelated prefix stays unknown.
  const aggregate = await reader.cachedAggregate('repo:o/r', 30_000, false, () => Promise.resolve(['i']))
  assert.equal(aggregate[0], 'i')
  assert.deepEqual(
    reader.evidence.invalidationRecords.map((record) => [record.prefix, record.status, record.observedKey]),
    [
      ['repo:o/r', 'observed', 'repo:o/r'],
      ['repo:o/r', 'observed', 'repo:o/r'],
      ['repo:o/r/pulls/9', 'pending', null],
    ],
  )

  // Repopulating the deeper key completes the remaining record.
  await reader.cachedResource('repo:o/r/pulls/9', null, () => Promise.resolve(9))
  assert.equal(reader.evidence.invalidationRecords[2].status, 'observed')
  assert.equal(reader.evidence.invalidationRecords[2].observedKey, 'repo:o/r/pulls/9')
})

test('failures and invalidations persist into the diagnostics channel (readback proof)', async () => {
  const previousHome = process.env.HOME
  const home = mkdtempSync(join(tmpdir(), 'clickvibe-gateway-diag-'))
  process.env.HOME = home
  try {
    const { ctx } = okShell({ exitCode: 0, stdout: { text: included(500, '{"message":"boom"}', rateHeaders('4998')) } })
    const reader = new GithubRestReader(ctx as never)
    await assert.rejects(reader.json('repos/o/r'), /boom/)
    reader.invalidate('repo:o/r', 'comment-published', 'publishDeliveryComment')
    const globalDiag = join(home, '.clickvibe', 'state', 'diagnostics.jsonl')
    // The best-effort writer is async; drain briefly.
    for (let spin = 0; spin < 100; spin++) {
      try {
        const lines = readFileSync(globalDiag, 'utf8')
        if (lines.includes('github-access-failure') && lines.includes('github-rest-invalidation')) {
          assert.match(lines, /"level":"upstream"/)
          assert.match(lines, /"reason":"comment-published"/)
          return
        }
      } catch {
        /* not yet flushed */
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.fail('diagnostics readback did not observe the gateway evidence lines')
  } finally {
    process.env.HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('rate exhaustion trips the circuit carrying the bucket snapshot', async () => {
  const exhausted = included(429, '{"message":"API rate limit exceeded"}', {
    'x-ratelimit-resource': 'core',
    'x-ratelimit-limit': '5000',
    'x-ratelimit-remaining': '0',
    'x-ratelimit-reset': '1893456000',
  })
  const { ctx } = okShell({ exitCode: 0, stdout: { text: exhausted } })
  const reader = new GithubRestReader(ctx as never)
  await assert.rejects(reader.json('repos/o/r'), /额度已用完/)
  assert.equal(reader.evidence.rateLimitBuckets.core?.remaining, 0)
  assert.equal(reader.evidence.rateLimitBuckets.core?.used, 5000)
  await assert.rejects(
    reader.cachedResource('k', null, () => Promise.resolve('x')),
    /额度已用完/,
  )
})
