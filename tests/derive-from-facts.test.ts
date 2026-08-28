import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { TaskOwnership } from '../src/infra/task-ownership.ts'
import type { IssueWorkflow, WorkflowEvent } from '../src/infra/state.ts'
import { deriveWorkflowState } from '../src/workflow/derive.ts'
import { deriveWorkflowStateFromFacts, type WorktreeGitFacts } from '../src/workflow/derive-from-facts.ts'

function makeWorkflow(overrides: Partial<IssueWorkflow> = {}): IssueWorkflow {
  return {
    key: 'ai-daming/clickvibe#122',
    url: 'https://github.com/ai-daming/clickvibe/issues/122',
    repoKey: 'ai-daming/clickvibe',
    worktree: '/tmp/clickvibe-issue-122',
    branch: 'clickvibe-issue-122',
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
    updatedAt: 0,
    events: [],
    ...overrides,
  }
}

/** One sampled local-git observation set for an existing, clean, in-sync worktree. */
function makeFacts(overrides: Partial<WorktreeGitFacts> = {}): WorktreeGitFacts {
  return {
    exists: true,
    head: 'abc1234',
    branch: 'clickvibe-issue-122',
    hasUncommittedChanges: false,
    mainHead: 'aaa0000',
    aheadOfMain: 1,
    behindMain: 0,
    originMainHead: 'bbb0000',
    aheadOfBase: 2,
    behindBase: 0,
    upstreamHead: 'abc1234',
    aheadOfUpstream: 0,
    behindUpstream: 0,
    mergeConflict: false,
    ...overrides,
  }
}

const NONE_OWNERSHIP: TaskOwnership = { state: 'none', startedAt: null, source: 'not-in-flight' }

function reviewEvent(overrides: Partial<WorkflowEvent> = {}): WorkflowEvent {
  return { kind: 'review', at: '2026-08-29T00:00:00.000Z', ...overrides }
}

test('sampled git facts pass through into derived fields unchanged', () => {
  const workflow = makeWorkflow()
  const result = deriveWorkflowStateFromFacts(workflow, makeFacts(), NONE_OWNERSHIP)

  assert.equal(result.key, workflow.key)
  assert.equal(result.stage, workflow.stage)
  assert.equal(result.runStartedAt, null)
  assert.equal(result.derived.head, 'abc1234')
  assert.equal(result.derived.branch, 'clickvibe-issue-122')
  assert.equal(result.derived.mainHead, 'aaa0000')
  assert.equal(result.derived.originMainHead, 'bbb0000')
  assert.equal(result.derived.upstreamHead, 'abc1234')
  assert.equal(result.derived.aheadOfMain, 1)
  assert.equal(result.derived.aheadOfBase, 2)
  assert.equal(result.derived.mergeConflict, false)
  assert.equal(result.derived.hasUncommittedChanges, false)
  assert.equal(result.derived.worktreeExists, true)
  assert.equal(result.derived.worktreeValid, true)
  assert.equal(result.derived.needsSync, false)
  assert.equal(result.derived.baseRefAvailable, true)
  assert.equal(result.derived.hasCommits, true)
  assert.equal(result.derived.hasNewCommits, false)
})

test('behind the frozen origin base means needsSync', () => {
  const result = deriveWorkflowStateFromFacts(makeWorkflow(), makeFacts({ behindBase: 3 }), NONE_OWNERSHIP)
  assert.equal(result.derived.needsSync, true)
})

test('behind the remote upstream branch means needsSync', () => {
  const result = deriveWorkflowStateFromFacts(makeWorkflow(), makeFacts({ behindUpstream: 2 }), NONE_OWNERSHIP)
  assert.equal(result.derived.needsSync, true)
})

test('missing origin/<base> ref falls back to frozen base counts and marks baseRefAvailable false', () => {
  const result = deriveWorkflowStateFromFacts(
    makeWorkflow(),
    makeFacts({ originMainHead: null, aheadOfBase: 0, behindBase: 4 }),
    NONE_OWNERSHIP,
  )
  assert.equal(result.derived.baseRefAvailable, false)
  assert.equal(result.derived.needsSync, true)
})

test('worktree on a foreign branch is invalid; missing worktree keeps branch decision', () => {
  const foreign = deriveWorkflowStateFromFacts(
    makeWorkflow(),
    makeFacts({ branch: 'some-other-branch' }),
    NONE_OWNERSHIP,
  )
  assert.equal(foreign.derived.worktreeValid, false)

  const missing = deriveWorkflowStateFromFacts(
    makeWorkflow(),
    makeFacts({
      exists: false,
      head: null,
      branch: null,
      hasUncommittedChanges: false,
      mainHead: null,
      aheadOfMain: 0,
      behindMain: 0,
      originMainHead: null,
      aheadOfBase: 0,
      behindBase: 0,
      upstreamHead: null,
      aheadOfUpstream: null,
      behindUpstream: null,
    }),
    NONE_OWNERSHIP,
  )
  assert.equal(missing.derived.worktreeExists, false)
  assert.equal(missing.derived.worktreeValid, true)
  assert.equal(missing.derived.head, null)
  assert.equal(missing.derived.baseRefAvailable, false)
})

test('hasNewCommits compares HEAD against the latest development delivery hash', () => {
  const moved = deriveWorkflowStateFromFacts(
    makeWorkflow({ events: [{ kind: 'dev', at: '2026-08-29T00:00:00.000Z', hash: 'deadbee' }] }),
    makeFacts(),
    NONE_OWNERSHIP,
  )
  assert.equal(moved.derived.hasNewCommits, true)
  assert.equal(moved.derived.lastDevHash, 'deadbee')

  const anchored = deriveWorkflowStateFromFacts(
    makeWorkflow({ events: [{ kind: 'dev', at: '2026-08-29T00:00:00.000Z', hash: 'abc1234' }] }),
    makeFacts(),
    NONE_OWNERSHIP,
  )
  assert.equal(anchored.derived.hasNewCommits, false)
})

test('a missing worktree cannot produce hasNewCommits even with a delivery hash', () => {
  const result = deriveWorkflowStateFromFacts(
    makeWorkflow({ events: [{ kind: 'dev', at: '2026-08-29T00:00:00.000Z', hash: 'deadbee' }] }),
    makeFacts({ exists: false, head: null, branch: null }),
    NONE_OWNERSHIP,
  )
  assert.equal(result.derived.hasNewCommits, false)
})

function verdictFixture(): { workflow: IssueWorkflow; contract: { bodyHash: string; updatedAt: string } } {
  const contract = { bodyHash: 'contract-hash-1', updatedAt: '2026-08-28T00:00:00.000Z' }
  const workflow = makeWorkflow({
    reviewResult: { passed: true, issues: [] },
    events: [reviewEvent({ hash: 'abc1234', issueContract: contract })],
  })
  return { workflow, contract }
}

test('verdict bound to current HEAD and current contract is current', () => {
  const { workflow, contract } = verdictFixture()
  const result = deriveWorkflowStateFromFacts(workflow, makeFacts(), NONE_OWNERSHIP, {
    issueContract: contract,
  })
  assert.equal(result.derived.issueContractStatus, 'current')
  assert.equal(result.derived.issueContractCurrent, true)
  assert.equal(result.derived.issueContractUnknownReason, null)
  assert.equal(result.derived.verdictCurrent, true)
  assert.equal(result.derived.reviewedHash, 'abc1234')
  assert.equal(result.derived.reviewedIssueBodyHash, 'contract-hash-1')
})

test('changed issue contract fail-closes the verdict', () => {
  const { workflow } = verdictFixture()
  const result = deriveWorkflowStateFromFacts(workflow, makeFacts(), NONE_OWNERSHIP, {
    issueContract: { bodyHash: 'contract-hash-2', updatedAt: '2026-08-29T00:00:00.000Z' },
  })
  assert.equal(result.derived.issueContractStatus, 'changed')
  assert.equal(result.derived.verdictCurrent, false)
})

test('review without a frozen contract snapshot is unknown with the missing-snapshot reason', () => {
  const result = deriveWorkflowStateFromFacts(makeWorkflow(), makeFacts(), NONE_OWNERSHIP)
  assert.equal(result.derived.issueContractStatus, 'unknown')
  assert.equal(result.derived.issueContractUnknownReason, 'missing-review-snapshot')
})

test('verdict on a moved HEAD is stale even with a current contract', () => {
  const { workflow, contract } = verdictFixture()
  const result = deriveWorkflowStateFromFacts(
    workflow,
    makeFacts({ head: 'ffffff', upstreamHead: 'ffffff' }),
    NONE_OWNERSHIP,
    { issueContract: contract },
  )
  assert.equal(result.derived.verdictCurrent, false)
})

test('running ownership surfaces runStartedAt and the task ref', () => {
  const ownership: TaskOwnership = {
    state: 'running',
    startedAt: 4200,
    source: 'local-map',
    kind: 'dev',
    taskId: 'task-1',
  }
  const result = deriveWorkflowStateFromFacts(
    makeWorkflow({ stage: 'developing', devTaskId: 'task-1' }),
    makeFacts(),
    ownership,
  )
  assert.equal(result.runStartedAt, 4200)
  assert.deepEqual(result.derived.taskRef, { kind: 'dev', taskId: 'task-1' })
})

test('interrupted ownership yields no runStartedAt', () => {
  const ownership: TaskOwnership = {
    state: 'interrupted',
    startedAt: 4200,
    source: 'host-terminal',
    kind: 'dev',
    taskId: 'task-1',
  }
  const result = deriveWorkflowStateFromFacts(
    makeWorkflow({ stage: 'developing', devTaskId: 'task-1' }),
    makeFacts(),
    ownership,
  )
  assert.equal(result.runStartedAt, null)
  assert.deepEqual(result.derived.taskRef, { kind: 'dev', taskId: 'task-1' })
})

test('missing events history behaves like an empty one', () => {
  const workflow = makeWorkflow()
  delete (workflow as Partial<IssueWorkflow>).events
  const result = deriveWorkflowStateFromFacts(workflow, makeFacts(), NONE_OWNERSHIP)
  assert.equal(result.derived.lastDevHash, null)
  assert.deepEqual(result.derived.freshSession, { round: 1, develop: false, review: false })
})

test('options.pr number overrides the stored workflow pr number in the envelope', () => {
  const result = deriveWorkflowStateFromFacts(makeWorkflow({ prNumber: null }), makeFacts(), NONE_OWNERSHIP, {
    pr: { number: 55, state: 'OPEN' } as NonNullable<Parameters<typeof deriveWorkflowStateFromFacts>[3]>['pr'],
  })
  assert.equal(result.prNumber, 55)
})

test('deriveWorkflowState with a canned shell matches deriveWorkflowStateFromFacts on identical facts', async () => {
  const outputs = new Map<string, { exitCode: number; stdout: string }>([
    ['git rev-parse --short HEAD', { exitCode: 0, stdout: 'abc1234\n' }],
    ['git branch --show-current', { exitCode: 0, stdout: 'clickvibe-issue-122\n' }],
    ['git status --porcelain', { exitCode: 0, stdout: '' }],
    ["git rev-parse --short 'main'", { exitCode: 0, stdout: 'aaa0000\n' }],
    ["git rev-list --left-right --count 'main'...'HEAD'", { exitCode: 0, stdout: '0 1\n' }],
    ["git rev-parse --short 'origin/main'", { exitCode: 0, stdout: 'bbb0000\n' }],
    ["git rev-list --left-right --count 'origin/main'...'HEAD'", { exitCode: 0, stdout: '0 2\n' }],
    ["git rev-parse --short 'origin/clickvibe-issue-122'", { exitCode: 0, stdout: 'abc1234\n' }],
    ["git rev-list --left-right --count 'origin/clickvibe-issue-122'...'HEAD'", { exitCode: 0, stdout: '0 0\n' }],
    ["git rev-parse --short 'MERGE_HEAD'", { exitCode: 1, stdout: '' }],
  ])
  const commands: string[] = []
  const ctx = {
    shell: {
      resolve: (spec: { command: string }) => spec,
      run: async (spec: { command: string }) => {
        commands.push(spec.command)
        const canned = outputs.get(spec.command)
        if (!canned) throw new Error(`unexpected shell command: ${spec.command}`)
        return { exitCode: canned.exitCode, stdout: { text: canned.stdout }, stderr: { text: '' } }
      },
    },
  } as unknown as Context

  // The wrapper probes the real filesystem first; an existing plain directory
  // (no git) exercises the full sampling path against the canned shell.
  const worktree = mkdtempSync(join(tmpdir(), 'clickvibe-derive-facts-'))
  try {
    const viaShell = await deriveWorkflowState(ctx, makeWorkflow({ worktree }))
    const viaFacts = deriveWorkflowStateFromFacts(makeWorkflow({ worktree }), makeFacts(), NONE_OWNERSHIP)

    assert.deepEqual(viaShell, viaFacts)
    assert.deepEqual(commands.sort(), [...outputs.keys()].sort(), 'sampler must issue exactly the canned command set')
  } finally {
    rmSync(worktree, { recursive: true, force: true })
  }
})
