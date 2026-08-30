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
  await assert.rejects(
    reader.cachedResource('k', null, () => Promise.resolve('x')),
    /额度已用完/,
  )
})

test('composed JSON parse failure keeps the upstream level naming the garbage child', async () => {
  // Review round 3: HTTP 200 + valid rate headers + body=not-json must not
  // lose the upstream row — the child that returned the unparseable body is
  // the evidence (#133 failures retain the upstream operation).
  const { ctx } = okShell({ exitCode: 0, stdout: { text: included(200, 'not-json', rateHeaders('4998')) } })
  const reader = new GithubRestReader(ctx as never)
  await assert.rejects(
    reader.cachedResource('detail:o/r/1', null, () => reader.json('repos/o/r/issues/1')),
    /返回了无效 JSON/,
  )
  const upstream = reader.evidence.failureRecords.find((record) => record.level === 'upstream')
  assert.equal(upstream?.operation, 'GET repos/o/r/issues/1')
  assert.match(upstream?.message ?? '', /not-json|无效 JSON/)
  const access = reader.evidence.failureRecords.find((record) => record.level === 'access')
  assert.equal(access?.scope, 'detail:o/r/1')
})

test('secondary rate-limit upstream evidence carries the secondary classification', async () => {
  // Review round 3: a 403 secondary limit must not be persisted as 额度已用完
  // (primary) at the upstream level while the circuit records secondary.
  const secondary = included(403, '{"message":"You have exceeded a secondary rate limit"}', {
    ...rateHeaders('4990'),
    'retry-after': '60',
  })
  const { ctx } = okShell({ exitCode: 0, stdout: { text: secondary } })
  const reader = new GithubRestReader(ctx as never)
  await assert.rejects(reader.json('repos/o/r'), /二级限流/)
  const upstream = reader.evidence.failureRecords.find((record) => record.level === 'upstream')
  assert.match(upstream?.message ?? '', /二级限流/, 'upstream evidence must match the actual kind')
  assert.doesNotMatch(upstream?.message ?? '', /额度已用完/)
})

test('subsequent observation persists to diagnostics and survives readback', async () => {
  const previousHome = process.env.HOME
  const home = mkdtempSync(join(tmpdir(), 'clickvibe-gateway-inv-'))
  process.env.HOME = home
  try {
    const { ctx } = okShell({ exitCode: 0, stdout: { text: included(200, '"v"', rateHeaders('4998')) } })
    const reader = new GithubRestReader(ctx as never)
    reader.invalidate('repo:o/r', 'comment-published', 'publishDeliveryComment')
    await reader.cachedAggregate('repo:o/r', 30_000, false, () => Promise.resolve(['i']))
    assert.equal(reader.evidence.invalidationRecords[0].status, 'observed')
    const globalDiag = join(home, '.clickvibe', 'state', 'diagnostics.jsonl')
    for (let spin = 0; spin < 100; spin++) {
      try {
        const lines = readFileSync(globalDiag, 'utf8')
        if (lines.includes('github-rest-invalidation-observed')) {
          assert.match(lines, /"prefix":"repo:o\/r"/)
          assert.match(lines, /"observedKey":"repo:o\/r"/)
          return
        }
      } catch {
        /* not yet flushed */
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.fail('observed invalidation event never reached diagnostics.jsonl')
  } finally {
    process.env.HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('spill read failure keeps the upstream level (dispatched child, unreadable output)', async () => {
  const { ctx } = okShell({
    exitCode: 0,
    stdout: { text: '', truncated: true, spillPath: '/nonexistent/clickvibe-spill' },
  })
  const reader = new GithubRestReader(ctx as never)
  await assert.rejects(reader.json('repos/o/r/pulls'), /spill|ENOENT|失败/)
  assert.equal(reader.evidence.failureRecords[0].level, 'upstream')
  assert.equal(reader.evidence.failureRecords[0].operation, 'GET repos/o/r/pulls')
})

test('pagination shape failure keeps the upstream operation and the access scope', async () => {
  // Review round 4: HTTP 200 + valid JSON + wrong shape ({"items":[]}) must
  // record the upstream GET with the real page path; a composed aggregate
  // access keeps its scope alongside.
  const wrongShape = included(200, '{"items":[]}', rateHeaders('4998'))
  const { ctx } = okShell({ exitCode: 0, stdout: { text: wrongShape } })
  const reader = new GithubRestReader(ctx as never)
  await assert.rejects(
    reader.cachedAggregate('repo:o/r/aggregated', 30_000, false, () => reader.paginate('repos/o/r/contributors')),
    /分页返回格式无效/,
  )
  const upstream = reader.evidence.failureRecords.find((record) => record.level === 'upstream')
  assert.equal(upstream?.operation, 'GET repos/o/r/contributors?per_page=100&page=1')
  assert.match(upstream?.message ?? '', /items|格式无效|Array/)
  const access = reader.evidence.failureRecords.find((record) => record.level === 'access')
  assert.equal(access?.scope, 'repo:o/r/aggregated')
})

test('direct pagination shape failure records its own access level', async () => {
  const wrongShape = included(200, '{"total": 3}', rateHeaders('4998'))
  const { ctx } = okShell({ exitCode: 0, stdout: { text: wrongShape } })
  const reader = new GithubRestReader(ctx as never)
  await assert.rejects(reader.paginate('repos/o/r/milestones'), /分页返回格式无效/)
  assert.ok(reader.evidence.failureRecords.some((record) => record.level === 'upstream'))
  assert.ok(
    reader.evidence.failureRecords.some(
      (record) => record.level === 'access' && record.operation.includes('milestones'),
    ),
  )
})

test('a headerless 429 trip never carries a prior response bucket', async () => {
  const previousHome = process.env.HOME
  const home = mkdtempSync(join(tmpdir(), 'clickvibe-gateway-trip-'))
  process.env.HOME = home
  try {
    const realCore = included(200, '1', rateHeaders('4999'))
    const bare429 = included(429, '{"message":"too many"}', { 'retry-after': '60' })
    const responses = [
      { exitCode: 0, stdout: { text: realCore } },
      { exitCode: 0, stdout: { text: bare429 } },
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
    await reader.json('repos/o/r')
    await assert.rejects(reader.json('repos/o/r'), /限流/)
    // The persisted trip event must bind to THIS response's observation —
    // resource unknown, no bucket — not the earlier core response's.
    const globalDiag = join(home, '.clickvibe', 'state', 'diagnostics.jsonl')
    for (let spin = 0; spin < 100; spin++) {
      try {
        const lines = readFileSync(globalDiag, 'utf8')
        const tripLine = lines.split('\n').find((line) => line.includes('github-rate-circuit-trip'))
        if (tripLine) {
          assert.match(tripLine, /"resource":null/, 'the trip names the current observation, not a fallback')
          // The current (headerless) sample is persisted with null numerics;
          // the prior core response's quota must not leak onto this trip.
          assert.match(tripLine, /"bucket":\{"resource":null/)
          assert.doesNotMatch(tripLine, /"remaining":4999/)
          return
        }
      } catch {
        /* not yet flushed */
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.fail('circuit trip never reached diagnostics.jsonl')
  } finally {
    process.env.HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('a rate-limited response with numeric headers but no resource keeps its budget evidence on disk', async () => {
  // Review round 6: 429 carrying limit/remaining/reset without
  // x-ratelimit-resource — resource stays unknown, but the present numeric
  // budget fields must survive into the persisted trip event.
  const previousHome = process.env.HOME
  const home = mkdtempSync(join(tmpdir(), 'clickvibe-gateway-trip6-'))
  process.env.HOME = home
  try {
    const noResource429 = included(429, '{"message":"too many"}', {
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': '1893456000',
    })
    const { ctx } = okShell({ exitCode: 0, stdout: { text: noResource429 } })
    const reader = new GithubRestReader(ctx as never)
    await assert.rejects(reader.json('repos/o/r'), /额度已用完|限流/)
    const globalDiag = join(home, '.clickvibe', 'state', 'diagnostics.jsonl')
    for (let spin = 0; spin < 100; spin++) {
      try {
        const lines = readFileSync(globalDiag, 'utf8')
        const tripLine = lines.split('\n').find((line) => line.includes('github-rate-circuit-trip'))
        if (tripLine) {
          assert.match(tripLine, /"resource":null/, 'resource stays unknown')
          assert.match(tripLine, /"bucket":\{/, 'the current sample is persisted, not dropped')
          assert.match(tripLine, /"remaining":0/)
          assert.match(tripLine, /"used":5000/)
          assert.match(tripLine, /"limit":5000/)
          return
        }
      } catch {
        /* not yet flushed */
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.fail('circuit trip never reached diagnostics.jsonl')
  } finally {
    process.env.HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})
