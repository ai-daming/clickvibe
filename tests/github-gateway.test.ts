/**
 * Gateway access metrics (issue #131 slice A, ledger Q5): the frozen #133
 * units measured at the existing REST reader — every logical request must
 * land in exactly one of hit / singleflight-join / execution / failure, and
 * upstream children, rate-limit snapshots, invalidations and queue waits are
 * recorded alongside. Pure observation: no behavior changes in this slice.
 */
import assert from 'node:assert/strict'
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

const RATE_HEADERS = {
  'x-ratelimit-resource': 'core',
  'x-ratelimit-limit': '5000',
  'x-ratelimit-remaining': '4998',
  'x-ratelimit-reset': '1893456000',
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

test('frozen identity: logical = hit + join + execution + failure across the cache lifecycle', async () => {
  const { ctx } = okShell({ exitCode: 0, stdout: { text: included(200, '{"n":1}', RATE_HEADERS) } })
  const reader = new GithubRestReader(ctx as never)
  const value = await reader.cachedResource('k', null, async () =>
    JSON.stringify(await reader.json<{ n: number }>('repos/o/r')),
  )
  assert.equal(value, '{"n":1}')
  const cached = await reader.cachedResource('k', null, () => Promise.resolve('never'))
  assert.equal(cached, '{"n":1}')
  const { logicalRequests, cacheHits, singleflightJoins, executions, failures } = reader.counters
  assert.equal(logicalRequests, 2)
  assert.equal(cacheHits, 1)
  assert.equal(executions, 1)
  assert.equal(singleflightJoins, 0)
  assert.equal(failures, 0)
  assert.equal(logicalRequests, cacheHits + singleflightJoins + executions + failures)
  assert.equal(reader.counters.upstreamRequests, 1, 'only the first access touched the wire')
})

test('concurrent identical access singleflights: one execution, one join, one upstream', async () => {
  const { ctx } = okShell({ exitCode: 0, stdout: { text: included(200, '[]', RATE_HEADERS) } })
  const reader = new GithubRestReader(ctx as never)
  const loader = async () => JSON.stringify(await reader.json<unknown[]>('repos/o/r'))
  const first = reader.cachedResource('k', null, loader)
  const second = reader.cachedResource('k', null, loader)
  await Promise.all([first, second])
  assert.equal(reader.counters.singleflightJoins, 1)
  assert.equal(reader.counters.executions, 1)
  assert.equal(reader.counters.logicalRequests, 2)
  assert.equal(reader.counters.upstreamRequests, 1)
  assert.equal(
    reader.counters.logicalRequests,
    reader.counters.cacheHits +
      reader.counters.singleflightJoins +
      reader.counters.executions +
      reader.counters.failures,
  )
})

test('loader-composed pagination counts one logical intent and every upstream child', async () => {
  const full = included(200, JSON.stringify(Array.from({ length: 100 }, (_, i) => `a${i}`)), RATE_HEADERS)
  const tail = included(200, '["tail"]', RATE_HEADERS)
  const commands: string[] = []
  let index = 0
  const results = [full, tail]
  const ctx = {
    shell: {
      resolve: (spec: unknown) => spec,
      run: async (spec: { command: string }) => {
        commands.push(spec.command)
        const next = results[Math.min(index, results.length - 1)]
        index++
        return { exitCode: 0, stdout: { text: next } }
      },
    },
  }
  const reader = new GithubRestReader(ctx as never)
  const values = await reader.cachedAggregate('repo:o/r', 30_000, false, () =>
    reader.paginate<string>('repos/o/r/issues'),
  )
  assert.equal(values.length, 101)
  assert.equal(reader.counters.logicalRequests, 1, 'the aggregate is the access intent')
  assert.equal(reader.counters.upstreamRequests, 2, 'each page is one upstream child')
  assert.equal(reader.counters.executions, 1)
})

test('rate-limit headers become a budget snapshot; exhaustion trips the circuit and counts failures', async () => {
  const exhausted = included(429, '{"message":"API rate limit exceeded"}', {
    'x-ratelimit-resource': 'core',
    'x-ratelimit-limit': '5000',
    'x-ratelimit-remaining': '0',
    'x-ratelimit-reset': '1893456000',
  })
  const { ctx } = okShell({ exitCode: 0, stdout: { text: exhausted } })
  const reader = new GithubRestReader(ctx as never)
  await assert.rejects(reader.json('repos/o/r'), /额度已用完/)
  assert.equal(reader.counters.failures, 1)
  assert.equal(reader.counters.rateLimit?.resource, 'core')
  assert.equal(reader.counters.rateLimit?.remaining, 0)
  assert.equal(reader.counters.rateLimit?.reset, 1_893_456_000_000)
  // The circuit is open: the next access intent fails closed and still lands
  // in exactly one bucket.
  await assert.rejects(
    reader.cachedResource('k2', null, () => Promise.resolve('x')),
    /额度已用完/,
  )
  assert.equal(reader.counters.logicalRequests, 2)
  assert.equal(reader.counters.failures, 2)
})

test('failures keep the operation and raw message as evidence', async () => {
  const { ctx } = okShell({ exitCode: 0, stdout: { text: included(500, '{"message":"boom"}', RATE_HEADERS) } })
  const reader = new GithubRestReader(ctx as never)
  await assert.rejects(reader.json('repos/o/r/pulls'), /GitHub REST 500: boom/)
  assert.equal(reader.counters.failureRecords.length, 1)
  assert.equal(reader.counters.failureRecords[0].operation, 'GET repos/o/r/pulls')
  assert.match(reader.counters.failureRecords[0].message, /boom/)
})

test('invalidations are counted with their scope prefix', () => {
  const reader = new GithubRestReader({} as never)
  reader.invalidate('repo:o/r')
  reader.invalidate('repo:o/r')
  assert.equal(reader.counters.invalidations, 2)
  assert.deepEqual(reader.counters.invalidationRecords, ['repo:o/r', 'repo:o/r'])
})

test('lane queue waits are measured from access entry to dispatch', async () => {
  const clock = { now: 1000 }
  let releaseFirst!: () => void
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const commands: string[] = []
  let call = 0
  const ctx = {
    shell: {
      resolve: (spec: unknown) => spec,
      run: async (spec: { command: string }) => {
        commands.push(spec.command)
        call += 1
        if (call === 1) {
          await firstGate
          return { exitCode: 0, stdout: { text: included(200, '1', RATE_HEADERS) } }
        }
        return { exitCode: 0, stdout: { text: included(200, '2', RATE_HEADERS) } }
      },
    },
  }
  const reader = new GithubRestReader(ctx as never, { now: () => clock.now, minimumIntervalMs: 0 })
  const first = reader.json<number>('repos/o/r/first')
  const second = reader.json<number>('repos/o/r/second')
  // The request lane is process-global; residue from earlier tests can pace
  // the first request behind their interval. Wait until it has actually
  // dispatched (and recorded its zero wait under the unmoved clock) — it
  // then blocks inside the shell — before the clock moves.
  for (let spin = 0; spin < 100 && reader.counters.upstreamRequests < 1; spin++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(reader.counters.upstreamRequests, 1, 'the first request must dispatch before the clock moves')
  assert.equal(reader.counters.waitCount, 0)
  clock.now = 1500
  releaseFirst()
  assert.deepEqual(await Promise.all([first, second]), [1, 2])
  assert.equal(reader.counters.upstreamRequests, 2)
  assert.equal(reader.counters.waitCount, 1, 'only the second request queued behind the first')
  assert.equal(reader.counters.waitMsTotal, 500)
})
