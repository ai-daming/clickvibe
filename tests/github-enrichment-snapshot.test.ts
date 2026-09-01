import assert from 'node:assert/strict'
import test from 'node:test'
import { buildEnrichmentIndex, snapshotPrKey, type RepositoryPrRest } from '../src/github/facts.ts'
import { resetGithubGatewayOwnerForTests } from '../src/github/gateway-owner.ts'
import { enrichWorkflowStates, type IssueWorkflow } from '../src/index.ts'

/** Integration cases share one process; the owner's aggregate/exact caches
 *  must not leak answers between scenarios (a stale enrichment:o/r page made
 *  a later test "see" the earlier test's PRs). */
function isolateGateway() {
  resetGithubGatewayOwnerForTests()
}

function prRow(overrides: Partial<RepositoryPrRest> & { number: number }): RepositoryPrRest {
  return {
    state: 'open',
    merged_at: null,
    updated_at: '2026-09-01T00:00:00Z',
    html_url: `https://github.com/o/r/pull/${overrides.number}`,
    head: { ref: 'codex/issue-7-x', repo: { full_name: 'o/r', owner: { login: 'o' } } },
    ...overrides,
  } as RepositoryPrRest
}

/** Fake-shell ctx that records every gh command and answers from scripted
 *  pages — the production enrichWorkflowStates boundary (review r10 REPRO-5
 *  shape). */
function recordingShell(pages: {
  issues?: unknown[]
  pulls?: unknown[]
  exactHead?: (branch: string) => unknown[]
  reviews?: unknown[]
}) {
  const commands: string[] = []
  const included = (body: unknown) => `HTTP/2.0 200 OK\n\n${JSON.stringify(body)}`
  const ctx = {
    shell: {
      resolve: (spec: unknown) => spec,
      run: async (spec: { command: string }) => {
        const command = spec.command
        if (!command.startsWith('gh api ')) throw new Error(`unexpected command: ${command}`)
        commands.push(command)
        if (command.includes('/issues?state=all&sort=created&direction=desc&per_page=100&page=1')) {
          return { exitCode: 0, stdout: { text: included(pages.issues ?? []) }, stderr: { text: '' } }
        }
        if (command.includes('/pulls?state=all&sort=created&direction=desc&per_page=100&page=1')) {
          return { exitCode: 0, stdout: { text: included(pages.pulls ?? []) }, stderr: { text: '' } }
        }
        const headMatch = command.match(/\/pulls\?state=all&head=([^&]+)&per_page=1/)
        if (headMatch) {
          const branch = decodeURIComponent(headMatch[1]).split(':')[1]
          return { exitCode: 0, stdout: { text: included(pages.exactHead?.(branch) ?? []) }, stderr: { text: '' } }
        }
        if (/\/pulls\/\d+\/reviews/.test(command)) {
          return { exitCode: 0, stdout: { text: included(pages.reviews ?? []) }, stderr: { text: '' } }
        }
        throw new Error(`unexpected gh command: ${command}`)
      },
    },
  } as never
  return { ctx, commands }
}

const issueRow = {
  number: 7,
  state: 'open',
  title: 'issue 7',
  body: '',
  updated_at: '2026-09-01T00:00:00Z',
  html_url: 'https://github.com/o/r/issues/7',
}

function enrichWorkflow(branch: string, overrides: Partial<IssueWorkflow> = {}) {
  const workflow: IssueWorkflow = {
    key: 'o-r-7',
    url: 'https://github.com/o/r/issues/7',
    repoKey: 'o/r',
    worktree: '',
    branch,
    stage: 'review-ready',
    devAgent: 'codex',
    devTaskId: null,
    devSessionId: null,
    devSessionAgent: null,
    devInterrupted: false,
    reviewAgent: null,
    reviewTaskId: null,
    reviewSessionId: null,
    reviewSessionAgent: null,
    reviewResult: null,
    prNumber: null,
    issueState: 'OPEN',
    baseRef: 'main',
    updatedAt: Date.now(),
    events: [],
    ...overrides,
  }
  return workflow
}

test('r10/F1: the snapshot PR index keys on the head repository owner, not the bare ref', () => {
  const local = prRow({ number: 29 })
  const fork = prRow({
    number: 99,
    head: { ref: 'codex/issue-7-x', repo: { full_name: 'attacker/fork', owner: { login: 'attacker' } } },
  })
  // Same-name fork branch first: the local key must still resolve to #29.
  const index = buildEnrichmentIndex({ issues: [], pulls: [fork, local] })
  assert.equal(index.prByHeadBranch.get(snapshotPrKey('o/r', 'codex/issue-7-x'))?.number, 29)
  assert.equal(index.prByHeadBranch.get(snapshotPrKey('attacker/fork', 'codex/issue-7-x'))?.number, 99)
})

test('r10/F1: multiple historical PRs on the same owner:ref keep the newest row', () => {
  const newest = prRow({ number: 130 })
  const older = prRow({ number: 29 })
  // The aggregate explicitly requests sort=created&direction=desc, so the
  // newest row arrives FIRST — first-wins then matches the exact query's
  // per_page=1 (newest), which is the parity the old path guaranteed.
  const index = buildEnrichmentIndex({ issues: [], pulls: [newest, older] })
  assert.equal(index.prByHeadBranch.get(snapshotPrKey('o/r', 'codex/issue-7-x'))?.number, 130)
})

test('r10/F1: PR rows without head repository identity are not indexed by branch', () => {
  const bare = prRow({ number: 7, head: { ref: 'codex/issue-7-x' } })
  const index = buildEnrichmentIndex({ issues: [], pulls: [bare] })
  assert.equal(index.prByHeadBranch.has(snapshotPrKey('o/r', 'codex/issue-7-x')), false)
})

test('r10/F1+r10/F3 production boundary: enrich picks the same-repo PR over a same-name fork branch', async () => {
  isolateGateway()
  const commands: string[] = []
  const included = (body: unknown) => `HTTP/2.0 200 OK\n\n${JSON.stringify(body)}`
  const ctx = {
    shell: {
      resolve: (spec: unknown) => spec,
      run: async (spec: { command: string }) => {
        const command = spec.command
        if (!command.startsWith('gh api ')) throw new Error(`unexpected command: ${command}`)
        commands.push(command)
        if (command.includes('/issues?state=all&sort=created&direction=desc&per_page=100&page=1')) {
          return {
            exitCode: 0,
            stdout: {
              text: included([
                {
                  number: 7,
                  state: 'open',
                  title: 'issue 7',
                  body: '## 验收标准\n- A',
                  updated_at: '2026-09-01T00:00:00Z',
                  html_url: 'https://github.com/o/r/issues/7',
                },
              ]),
            },
            stderr: { text: '' },
          }
        }
        if (command.includes('/pulls?state=all&sort=created&direction=desc&per_page=100&page=1')) {
          return {
            exitCode: 0,
            stdout: {
              text: included([
                prRow({
                  number: 29,
                  head: { ref: 'codex/issue-7-x', repo: { full_name: 'o/r', owner: { login: 'o' } } },
                }),
                prRow({
                  number: 99,
                  head: { ref: 'codex/issue-7-x', repo: { full_name: 'attacker/fork', owner: { login: 'attacker' } } },
                }),
              ]),
            },
            stderr: { text: '' },
          }
        }
        if (command.includes('/pulls/29/reviews'))
          return { exitCode: 0, stdout: { text: included([]) }, stderr: { text: '' } }
        if (command.includes('/pulls/29')) {
          return {
            exitCode: 0,
            stdout: {
              text: included({
                number: 29,
                state: 'open',
                merged_at: null,
                updated_at: '2026-09-01T00:00:00Z',
                html_url: 'https://github.com/o/r/pull/29',
                head: { ref: 'codex/issue-7-x', sha: 'aaa' },
                base: { ref: 'main', sha: 'bbb' },
              }),
            },
            stderr: { text: '' },
          }
        }
        throw new Error(`unexpected gh command: ${command}`)
      },
    },
  } as never
  const workflow: IssueWorkflow = {
    key: 'o-r-7',
    url: 'https://github.com/o/r/issues/7',
    repoKey: 'o/r',
    worktree: '',
    branch: 'codex/issue-7-x',
    stage: 'review-ready',
    devAgent: 'codex',
    devTaskId: null,
    devSessionId: null,
    devSessionAgent: null,
    devInterrupted: false,
    reviewAgent: null,
    reviewTaskId: null,
    reviewSessionId: null,
    reviewSessionAgent: null,
    reviewResult: null,
    prNumber: null,
    issueState: 'OPEN',
    baseRef: 'main',
    updatedAt: Date.now(),
    events: [],
  }
  const enriched = await enrichWorkflowStates(ctx, [workflow], { repos: {}, worktreeRoot: '/tmp' })
  assert.ok(enriched[0].derived, 'the enriched row derives state')
  assert.equal(
    commands.filter((command) => /\/pulls\/29\b/.test(command) && !command.includes('reviews')).length,
    1,
    'the same-repo PR #29 is the one enriched',
  )
  assert.equal(commands.filter((command) => /\/pulls\/99\b/.test(command)).length, 0, 'the fork PR #99 is never read')
  // r10/F3: the aggregate is ONE recent page per list, any state — no walk,
  // no OPEN-only narrowing that would push closed work items to per-item reads.
  assert.equal(commands.filter((command) => command.includes('page=2')).length, 0, 'no continuation pages')
  assert.equal(
    commands.filter((command) => command.includes('/issues?state=all&sort=created&direction=desc&per_page=100&page=1'))
      .length,
    1,
    'exactly one issues aggregate page',
  )
  assert.equal(
    commands.filter((command) => command.includes('/pulls?state=all&sort=created&direction=desc&per_page=100&page=1'))
      .length,
    1,
    'exactly one pulls aggregate page',
  )
})

test('r11: page completeness is provable only when the page is short', () => {
  const page = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      prRow({
        number: 1000 + index,
        head: { ref: `unrelated-${index}`, repo: { full_name: 'o/r', owner: { login: 'o' } } },
      }),
    )
  assert.equal(buildEnrichmentIndex({ issues: [], pulls: page(99) }).pullsComplete, true)
  assert.equal(buildEnrichmentIndex({ issues: [], pulls: page(100) }).pullsComplete, false)
  // A missing pulls array is NOT completeness — fail open to the exact query.
  assert.equal(buildEnrichmentIndex({ issues: [], pulls: undefined as never }).pullsComplete, false)
})

test('r11/REPRO-5: a first-page miss on an INCOMPLETE page is not absence — the exact query answers', async () => {
  isolateGateway()
  const unrelated = Array.from({ length: 100 }, (_, index) =>
    prRow({
      number: 1000 + index,
      head: { ref: `unrelated-${index}`, repo: { full_name: 'o/r', owner: { login: 'o' } } },
    }),
  )
  const { ctx, commands } = recordingShell({
    issues: [issueRow],
    pulls: unrelated,
    exactHead: (branch) => [
      {
        number: 29,
        state: 'open',
        merged_at: null,
        updated_at: '2026-09-01T00:00:00Z',
        head: { ref: branch },
        html_url: 'https://github.com/o/r/pull/29',
      },
    ],
  })
  const workflow = enrichWorkflow('codex/issue-7-old-pr', { reviewResult: { passed: true, issues: [] } })
  const [row] = await enrichWorkflowStates(ctx, [workflow], { repos: {}, worktreeRoot: '/tmp' })
  const exactCalls = commands.filter((command) => command.includes('head=o%3A') && command.includes('per_page=1'))
  assert.equal(exactCalls.length, 1, 'the exact owner-qualified lookup runs once for the page miss')
  assert.equal(row.prNumber, '29', 'the real PR outside the first page is selected')
  assert.equal(
    commands.filter((command) => /\/pulls\/\d+\/reviews/.test(command)).length,
    0,
    'a verdict-bound fallback reads PR facts only, no reviews',
  )
})

test('r11: a miss on a PROVEN-complete page stays definite absence — zero extra upstream', async () => {
  isolateGateway()
  const unrelated = Array.from({ length: 3 }, (_, index) =>
    prRow({
      number: 1000 + index,
      head: { ref: `unrelated-${index}`, repo: { full_name: 'o/r', owner: { login: 'o' } } },
    }),
  )
  const { ctx, commands } = recordingShell({ issues: [issueRow], pulls: unrelated, exactHead: () => [] })
  const [row] = await enrichWorkflowStates(ctx, [enrichWorkflow('codex/issue-7-x')], {
    repos: {},
    worktreeRoot: '/tmp',
  })
  assert.equal(row.prNumber, null, 'short page ⇒ the miss proves no PR exists')
  assert.equal(
    commands.filter((command) => command.includes('head=')).length,
    0,
    'no exact fallback on a provably complete page — the frozen multi cost holds',
  )
})
