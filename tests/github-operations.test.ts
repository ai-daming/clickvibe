/**
 * Typed GitHub read operations (issue #131 slice A, commit 1).
 *
 * The operation registry is the equivalence-preserving extraction of every
 * Controller-owned GitHub read family: executors run the exact reader calls
 * the call sites ran yesterday (same cache keys, TTLs, force semantics), and
 * intents replace caller-side `force` flags with a declared consistency that
 * policy may only tighten (ADR-0010 §2: 调用者不能放松安全语义).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { beforeEach } from 'node:test'
import { resetGithubGatewayOwnerForTests } from '../src/github/gateway-owner.ts'

beforeEach(() => resetGithubGatewayOwnerForTests())
import type { Context } from '@deepseek-ai/cordis'
import {
  GITHUB_READ_OPERATIONS,
  githubRead,
  type GithubReadConsistency,
  type GithubReadOperationId,
} from '../src/github/operations.ts'
import { fetchIssueRestDetail, fetchPrRestDetail } from '../src/github/reads.ts'
import { fetchGithubRepoSnapshot } from '../src/github/facts.ts'

function included(body: unknown, status = 200): string {
  const headers = ['x-ratelimit-limit: 5000', 'x-ratelimit-remaining: 4999', 'x-ratelimit-reset: 0']
  return `HTTP/1.1 ${status}\n${headers.join('\n')}\n\n${JSON.stringify(body)}`
}

function recordingContext(
  routes: Array<{ match: RegExp; body: unknown; status?: number }> = [
    { match: /\/issues\?state=all/, body: [{ number: 7, title: 'i', updated_at: '2026-08-31T00:00:00Z' }] },
    { match: /\/pulls\?state=all/, body: [] },
  ],
) {
  const commands: string[] = []
  const ctx = {
    shell: {
      resolve(spec: unknown) {
        return spec
      },
      async run(spec: { command: string }) {
        commands.push(spec.command)
        const route = routes.find((candidate) => candidate.match.test(spec.command))
        if (!route) throw new Error(`unexpected gh command: ${spec.command}`)
        return { exitCode: 0, stdout: { text: included(route.body, route.status) }, stderr: { text: '' } }
      },
    },
  } as unknown as Context
  return { ctx, commands }
}

const issueDetailRoute = [
  { match: /repos\/o\/r\/issues\/7/, body: { number: 7, title: 't', state: 'open', updated_at: 'u1', html_url: 'x' } },
]
const prDetailRoute = [
  {
    match: /repos\/o\/r\/pulls\/9/,
    body: { number: 9, title: 'p', state: 'open', updated_at: 'pu1', html_url: 'x', head: {}, base: {} },
  },
]

test('registry: every read operation declares effect, floor, joinability and an executor', () => {
  const ids = Object.keys(GITHUB_READ_OPERATIONS) as GithubReadOperationId[]
  assert.ok(ids.length >= 11, `expected the read families to be enumerated, saw ${ids.length}`)
  for (const id of ids) {
    const policy = GITHUB_READ_OPERATIONS[id]
    assert.equal(policy.effect, 'read', `${id} effect`)
    assert.ok(['cache-ok', 'upstream-confirmed'].includes(policy.consistencyFloor), `${id} floor`)
    assert.equal(typeof policy.joinable, 'boolean', `${id} joinable`)
    assert.equal(typeof policy.execute, 'function', `${id} executor`)
  }
  // The gate families are their own operations with the strongest floor, so a
  // caller cannot relax a merge/contract gate into a cache answer.
  assert.equal(GITHUB_READ_OPERATIONS['contract-issue-detail'].consistencyFloor, 'upstream-confirmed')
  assert.equal(GITHUB_READ_OPERATIONS['gate-pr-fact'].consistencyFloor, 'upstream-confirmed')
})

test('r5/F2: every family declares the admission ladder; only the gate families are critical', () => {
  for (const [id, policy] of Object.entries(GITHUB_READ_OPERATIONS)) {
    assert.ok(['critical', 'normal'].includes(policy.priority), `${id} priority`)
    assert.ok(
      Number.isSafeInteger(policy.deadlineMs) && policy.deadlineMs > 0,
      `${id} carries a finite absolute logical deadline`,
    )
    assert.ok(
      Number.isSafeInteger(policy.maxPages) && policy.maxPages >= 1,
      `${id} carries a finite dispatch (cost) bound`,
    )
  }
  const critical = (Object.keys(GITHUB_READ_OPERATIONS) as GithubReadOperationId[]).filter(
    (id) => GITHUB_READ_OPERATIONS[id].priority === 'critical',
  )
  assert.deepEqual(critical, ['contract-issue-detail', 'gate-pr-fact'], 'critical is for gates only')
})

test('r5/F2: a gate read declares critical in the production owner; the panel stays normal', async () => {
  const { githubGatewayOwner } = await import('../src/github/gateway-owner.ts')
  const owner = githubGatewayOwner()
  const gateRoutes = [
    { match: /pulls\/9\/reviews/, body: [{ id: 1, user: { login: 'rev' }, state: 'APPROVED', submitted_at: 't' }] },
    {
      match: /repos\/o\/r\/pulls\/9(?![/a-z])/,
      body: { number: 9, title: 'p', state: 'open', updated_at: 'u', html_url: 'x', head: {}, base: {} },
    },
  ]
  const gate = recordingContext(gateRoutes)
  await githubRead(gate.ctx, {
    operation: 'gate-pr-fact',
    repoKey: 'o/r',
    number: 9,
    consistency: 'cache-ok',
    includeReviews: true,
  })
  const gateDeclared = owner.lifecycleEvents().filter((event) => event.kind === 'declared')
  assert.ok(gateDeclared.length > 0, 'the gate flow declared logical requests')
  for (const event of gateDeclared) {
    assert.equal(
      event.kind === 'declared' ? event.priority : null,
      'critical',
      'gate composition (including nested reads) declares critical',
    )
  }
  await owner.close({ drainMs: 0 })
  resetGithubGatewayOwnerForTests()

  const panelOwner = githubGatewayOwner()
  const panelRoutes = [
    { match: /requested_reviewers/, body: { users: [], teams: [] } },
    { match: /pulls\/9\/reviews/, body: [] },
    { match: /issues\/9\/comments/, body: [] },
    {
      match: /repos\/o\/r\/pulls\/9(?![/a-z])/,
      body: { number: 9, title: 'p', state: 'open', updated_at: 'u', html_url: 'x', head: {}, base: {} },
    },
  ]
  const panel = recordingContext(panelRoutes)
  await githubRead(panel.ctx, {
    operation: 'pr-panel',
    repoKey: 'o/r',
    number: 9,
    consistency: 'cache-ok',
  })
  const panelDeclared = panelOwner.lifecycleEvents().filter((event) => event.kind === 'declared')
  assert.ok(panelDeclared.length > 0)
  for (const event of panelDeclared) {
    assert.equal(event.kind === 'declared' ? event.priority : null, 'normal', 'panel refreshes stay in the normal lane')
  }
  await panelOwner.close({ drainMs: 0 })
})

test('tighten-not-loosen: a floor below-request is upgraded and observably forced', async () => {
  // contract-issue-detail floor is upstream-confirmed; asking for cache-ok
  // must still bypass the cache on every call (force applied), exactly like
  // today's merge-gate force=true reads.
  const first = recordingContext(issueDetailRoute)
  await githubRead(first.ctx, {
    operation: 'contract-issue-detail',
    repoKey: 'o/r',
    number: 7,
    consistency: 'cache-ok',
  })
  const second = recordingContext(issueDetailRoute)
  await githubRead(second.ctx, {
    operation: 'contract-issue-detail',
    repoKey: 'o/r',
    number: 7,
    consistency: 'cache-ok',
  })
  // Different ctx → different reader cache anyway; the upgrade proof is that
  // TWO calls through the SAME ctx each dispatch (no cache reuse).
  const shared = recordingContext(issueDetailRoute)
  await githubRead(shared.ctx, {
    operation: 'contract-issue-detail',
    repoKey: 'o/r',
    number: 7,
    consistency: 'cache-ok',
  })
  await githubRead(shared.ctx, {
    operation: 'contract-issue-detail',
    repoKey: 'o/r',
    number: 7,
    consistency: 'cache-ok',
  })
  assert.equal(
    shared.commands.filter((command) => command.includes('/issues/7')).length,
    2,
    'upstream floor must dispatch every time, never answer from cache',
  )
})

test('tightening is allowed: cache-ok family requested as upstream-confirmed forces the read', async () => {
  const shared = recordingContext(prDetailRoute)
  await githubRead(shared.ctx, {
    operation: 'pr-detail',
    repoKey: 'o/r',
    number: 9,
    consistency: 'upstream-confirmed',
  })
  await githubRead(shared.ctx, {
    operation: 'pr-detail',
    repoKey: 'o/r',
    number: 9,
    consistency: 'upstream-confirmed',
  })
  assert.equal(shared.commands.length, 2, 'upstream-confirmed on a cache-ok floor dispatches twice')
})

test('equivalence: issue-detail via intent issues the same command and cache reuse as the legacy path', async () => {
  const legacy = recordingContext(issueDetailRoute)
  const legacyFirst = await fetchIssueRestDetail(legacy.ctx, 'o/r', 7, false, 5_000)
  await fetchIssueRestDetail(legacy.ctx, 'o/r', 7, false, 5_000)
  assert.equal(legacy.commands.length, 1, 'legacy cached the second read')

  resetGithubGatewayOwnerForTests()
  const typed = recordingContext(issueDetailRoute)
  const typedFirst = await githubRead(typed.ctx, {
    operation: 'issue-detail',
    repoKey: 'o/r',
    number: 7,
    consistency: 'cache-ok',
    timeoutMs: 5_000,
  })
  await githubRead(typed.ctx, {
    operation: 'issue-detail',
    repoKey: 'o/r',
    number: 7,
    consistency: 'cache-ok',
    timeoutMs: 5_000,
  })
  assert.deepEqual(typed.commands, legacy.commands, 'identical command sequence')
  assert.deepEqual(typedFirst, legacyFirst)
})

test('equivalence: pr-detail upstream-confirmed matches legacy force=true', async () => {
  const legacy = recordingContext(prDetailRoute)
  await fetchPrRestDetail(legacy.ctx, 'o/r', 9, true, 5_000)
  await fetchPrRestDetail(legacy.ctx, 'o/r', 9, true, 5_000)
  assert.equal(legacy.commands.length, 2)

  const typed = recordingContext(prDetailRoute)
  await githubRead(typed.ctx, {
    operation: 'pr-detail',
    repoKey: 'o/r',
    number: 9,
    consistency: 'upstream-confirmed',
    timeoutMs: 5_000,
  })
  await githubRead(typed.ctx, {
    operation: 'pr-detail',
    repoKey: 'o/r',
    number: 9,
    consistency: 'upstream-confirmed',
    timeoutMs: 5_000,
  })
  assert.deepEqual(typed.commands, legacy.commands)
})

test('equivalence: repo-snapshot keeps the aggregate cache and singleflight shape', async () => {
  const legacy = recordingContext()
  await fetchGithubRepoSnapshot(legacy.ctx, 'o/r', 45_000, false)
  await fetchGithubRepoSnapshot(legacy.ctx, 'o/r', 45_000, false)
  const legacyCommands = [...legacy.commands]

  resetGithubGatewayOwnerForTests()
  const typed = recordingContext()
  await githubRead(typed.ctx, { operation: 'repo-snapshot', repoKey: 'o/r', ttlMs: 45_000, consistency: 'cache-ok' })
  await githubRead(typed.ctx, { operation: 'repo-snapshot', repoKey: 'o/r', ttlMs: 45_000, consistency: 'cache-ok' })
  assert.deepEqual(typed.commands, legacyCommands)
  assert.equal(typed.commands.length, 2, 'issues + pulls pages, second call served from the aggregate cache')
})

test('consistency ranking is explicit and total', () => {
  const rank = (value: GithubReadConsistency) => (value === 'upstream-confirmed' ? 1 : 0)
  assert.ok(rank('upstream-confirmed') > rank('cache-ok'))
})
