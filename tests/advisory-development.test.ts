import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import test from 'node:test'
import { resetGithubGatewayOwnerForTests } from '../src/github/gateway-owner.ts'
import type { IssueWorkflow } from '../src/infra/state.ts'
import { authorizeAgent } from '../src/workflow/merge.ts'
import { collectMergeGateFailures, fetchIssueContract } from '../src/workflow/merge-gates.ts'
import { readCurrentIssueContract } from '../src/workflow/work-item-contract-repository.ts'
import { recoveryHome } from './helpers/recovery-home.ts'

const url = 'https://github.com/o/r/issues/177'
const item = {
  url,
  number: 177,
  title: 'Develop an incomplete description',
  state: 'OPEN',
  body: '## 目标\n做用户选择的工作',
  updatedAt: '2026-09-13T00:00:00Z',
  comments: [],
}
const autoRun = { devAgent: 'codex', reviewAgent: 'codex', maxRounds: 20, budgetHours: 24, autoMerge: false }
let home: string
let previousHome: string | undefined

test.before(async () => {
  const fixture = await recoveryHome([])
  home = fixture.home
  previousHome = process.env.HOME
  process.env.HOME = home
})
test.after(async () => {
  resetGithubGatewayOwnerForTests()
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  await rm(home, { recursive: true, force: true })
})
test.beforeEach(() => resetGithubGatewayOwnerForTests())

function context(unavailable = false) {
  return {
    effect: () => () => {},
    shell: {
      resolve: (spec: unknown) => spec,
      async run(spec: { command: string }) {
        assert.ok(spec.command.startsWith('gh api '), spec.command)
        assert.ok(!spec.command.includes('--method'), 'these reads must never mutate GitHub')
        if (unavailable) throw new Error('GitHub observation unavailable')
        let body: unknown = []
        if (/\/issues\/177(?:\s|['"]|$)/.test(spec.command)) {
          body = { ...item, html_url: url, state: 'open', updated_at: item.updatedAt }
        }
        return {
          exitCode: 0,
          stdout: { text: `HTTP/2.0 200 OK\n\n${JSON.stringify(body)}` },
          stderr: { text: '' },
        }
      },
    },
  }
}

test('explicit auto authorization accepts missing descriptions without an evaluation receipt', async () => {
  const result = await authorizeAgent(context() as never, { action: 'auto', url, autoRun, expectedSnapshot: item })
  assert.equal(result.ok, true, JSON.stringify(result))
  const saved = await readCurrentIssueContract(url)
  assert.equal(saved.state, 'known')
  if (saved.state !== 'known') return
  assert.deepEqual(saved.snapshot.constraints, { state: 'unknown', reason: 'missing' })
  assert.deepEqual(saved.snapshot.acceptanceCriteria, { state: 'unknown', reason: 'missing' })
  assert.equal(saved.prompt.body, item.body)
})

test('a changed incomplete description still invalidates the preview', async () => {
  const result = await authorizeAgent(context() as never, {
    action: 'auto',
    url,
    autoRun,
    expectedSnapshot: { ...item, body: '## 目标\n另一项工作' },
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /契约在预览后已变化/)
})

test('review can read incomplete descriptions without permitting their automatic merge', async () => {
  const ctx = context()
  const read = await fetchIssueContract(ctx as never, url, true)
  assert.equal(read.body, item.body)
  const workflow = {
    url,
    repoKey: 'o/r',
    worktree: '/unused',
    baseRef: 'origin/main @ abc1234',
    reviewResult: { passed: true, issues: [] },
    events: [
      {
        kind: 'review',
        at: 'now',
        hash: 'def9999',
        verdict: { passed: true, issues: [] },
        issueContract: read.contract,
        reviewBase: { ref: 'main', sha: 'abc1234' },
      },
    ],
  } as unknown as IssueWorkflow
  const failures = await collectMergeGateFailures(ctx as never, workflow, 'def9999')
  assert.ok(
    failures.some((failure) => failure.key === 'contract-unreadable' && /不完整/.test(failure.message)),
    JSON.stringify(failures),
  )
})

test('unavailable GitHub data is still a real execution failure', async () => {
  const result = await authorizeAgent(context(true) as never, { action: 'auto', url, autoRun, expectedSnapshot: item })
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /当前契约不可用|GitHub observation unavailable/)
})
