import assert from 'node:assert/strict'
import test from 'node:test'
import { buildEnrichmentIndex, snapshotPrKey, type RepositoryPrRest } from '../src/github/facts.ts'
import { enrichWorkflowStates, type IssueWorkflow } from '../src/index.ts'

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
