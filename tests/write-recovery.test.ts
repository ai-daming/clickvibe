/**
 * Write-marker ownership and restart recovery (issue #131 slice B, review
 * F3/F4): a marker that did not durably land must block the GitHub dispatch,
 * and pending/unknown markers settle by readback ONLY on the next claim.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import process from 'node:process'
import type { Context } from '@deepseek-ai/cordis'
import type { LiveTask } from '../src/infra/runtime.ts'
import type { WorkflowTaskLease } from '../src/infra/state.ts'
import { commitWorkflowFixture } from './workflow-fixture.ts'
import { type IssueWorkflow, loadWorkflow } from '../src/infra/state.ts'
import { publishDeliveryComment } from '../src/workflow/delivery-publish.ts'
import { buildDevComment } from '../src/workflow/delivery-comment.ts'
import { recoverUnsettledWrites } from '../src/workflow/write-recovery.ts'
import { REVIEW_APPROVAL_BODY } from '../src/github/review-approval.ts'

const ok = (body: unknown, status = 200) => `HTTP/1.1 ${status}\n\n${JSON.stringify(body)}`

function shellContext(
  handle: (spec: { command: string; stdin?: string }) => Promise<{ exitCode: number; text: string }>,
) {
  const commands: Array<{ command: string; stdin?: string }> = []
  const ctx = {
    shell: {
      resolve: (spec: unknown) => spec,
      run: async (spec: { command: string; stdin?: string }) => {
        commands.push({ command: spec.command, stdin: spec.stdin })
        const result = await handle(spec)
        return { exitCode: result.exitCode, stdout: { text: result.text }, stderr: { text: '' } }
      },
    },
  } as unknown as Context
  return { ctx, commands }
}

function recoveryWorkflow(worktree: string): IssueWorkflow {
  return {
    key: 'o-r-77',
    url: 'https://github.com/o/r/issues/77',
    repoKey: 'o/r',
    worktree,
    branch: 'r-issue-77',
    stage: 'review-ready',
    devAgent: 'codex',
    devTaskId: 'live-1',
    devSessionId: null,
    devSessionAgent: null,
    devInterrupted: false,
    reviewAgent: 'codex',
    reviewTaskId: null,
    reviewSessionId: null,
    reviewSessionAgent: null,
    reviewResult: null,
    prNumber: null,
    issueState: 'OPEN',
    baseRef: 'origin/main @ abc',
    updatedAt: 1,
    taskStateRevision: 0,
    events: [],
  }
}

function liveFor(workflow: IssueWorkflow): LiveTask {
  return {
    taskId: workflow.devTaskId!,
    workflowLease: {
      kind: 'dev',
      taskId: workflow.devTaskId!,
      taskStateRevision: workflow.taskStateRevision ?? 0,
    } as WorkflowTaskLease,
  } as LiveTask
}

test('review F3: a marker that cannot commit dispatches zero GitHub writes', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-marker-barrier-'))
  process.env.HOME = tempHome
  try {
    const worktree = join(tempHome, 'worktree')
    await mkdir(worktree, { recursive: true })
    const workflow = recoveryWorkflow(worktree)
    workflow.events = [
      { kind: 'dev', at: '2026-09-01T00:00:00Z', taskId: 'live-1', hash: 'abc1234', round: 1, agent: 'codex' },
    ]
    await commitWorkflowFixture(workflow, null)
    const live = liveFor(workflow)
    // The workflow lease is taken over by a newer task while this one still
    // runs: the marker mutation must fail BEFORE any GitHub dispatch.
    const takenOver = structuredClone(workflow)
    takenOver.devTaskId = 'new-task'
    takenOver.taskStateRevision = (takenOver.taskStateRevision ?? 0) + 1
    await commitWorkflowFixture(takenOver, takenOver.revision ?? null)

    const { ctx, commands } = shellContext(async () => ({ exitCode: 0, text: ok({}) }))
    const event = workflow.events[0]
    const published = await publishDeliveryComment(ctx, workflow, event, 'delivery body', live)

    assert.equal(published, false)
    assert.equal(event.publication?.status, 'failed')
    assert.match(event.publication?.error ?? '', /marker 未落盘/)
    assert.equal(commands.length, 0, 'a lost lease means zero GitHub dispatch, not a best-effort post')
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('review F4: a pending publication settles posted by readback on the next claim — zero POST', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-recover-posted-'))
  process.env.HOME = tempHome
  try {
    const worktree = join(tempHome, 'worktree')
    await mkdir(worktree, { recursive: true })
    const workflow = recoveryWorkflow(worktree)
    workflow.events = [
      {
        kind: 'review',
        at: '2026-08-31T00:00:00Z',
        taskId: 'old-review',
        hash: 'old1234',
        round: 1,
        agent: 'codex',
        verdict: { passed: false, issues: ['修复竞态'] },
      },
      {
        kind: 'dev',
        at: '2026-09-01T00:00:00Z',
        taskId: 'live-1',
        hash: 'abc1234',
        round: 2,
        agent: 'codex',
        fixed: 1,
        publication: { target: 'issue', status: 'pending' },
      },
    ]
    await commitWorkflowFixture(workflow, null)
    const expectedBody = buildDevComment({
      commit: 'abc1234',
      issueNumber: '77',
      fixedIssues: ['修复竞态'],
      agent: 'codex',
      round: 2,
      at: '2026-09-01T00:00:00Z',
    })
    const { ctx, commands } = shellContext(async (step) => {
      if (step.command.includes('--method')) throw new Error(`recovery must never dispatch: ${step.command}`)
      return { exitCode: 0, text: ok([{ id: 9, body: expectedBody }]) }
    })
    const live = liveFor(workflow)

    await recoverUnsettledWrites(ctx, live, workflow)

    assert.equal(commands.length, 1, 'recovery is readback only')
    assert.match(commands[0].command, /repos\/o\/r\/issues\/77\/comments/)
    const reloaded = await loadWorkflow(workflow.key)
    const recoveredEvent = reloaded?.events.find((event) => event.at === '2026-09-01T00:00:00Z')
    assert.equal(recoveredEvent?.publication?.status, 'posted')
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('review F4: an unprovable publication escalates pending to unknown — still zero POST', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-recover-unknown-'))
  process.env.HOME = tempHome
  try {
    const worktree = join(tempHome, 'worktree')
    await mkdir(worktree, { recursive: true })
    const workflow = recoveryWorkflow(worktree)
    workflow.events = [
      {
        kind: 'review',
        at: '2026-09-01T00:00:00Z',
        taskId: 'old-review',
        hash: 'abc1234',
        round: 1,
        agent: 'codex',
        verdict: { passed: true, issues: [] },
        publication: { target: 'issue', status: 'pending' },
        approvalAttempt: { status: 'pending' },
      },
    ]
    workflow.prNumber = '29'
    await commitWorkflowFixture(workflow, null)
    const { ctx, commands } = shellContext(async (step) => {
      if (step.command.includes('--method')) throw new Error(`recovery must never dispatch: ${step.command}`)
      // Comments readback: the body is absent; reviews readback: no APPROVED.
      if (step.command.includes('/reviews')) return { exitCode: 0, text: ok([{ state: 'COMMENTED', body: 'x' }]) }
      return { exitCode: 0, text: ok([{ id: 1, body: 'someone else' }]) }
    })
    const live = liveFor(workflow)

    await recoverUnsettledWrites(ctx, live, workflow)

    assert.equal(commands.filter((call) => call.command.includes('--method')).length, 0)
    const reloaded = await loadWorkflow(workflow.key)
    const event = reloaded?.events[0]
    assert.equal(event?.publication?.status, 'unknown', 'missing ≠ dead: the marker escalates, never guesses')
    assert.equal(event?.approvalAttempt?.status, 'unknown')
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('review F4: a pending approval settles confirmed when the reviews readback proves it', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-recover-approval-'))
  process.env.HOME = tempHome
  try {
    const worktree = join(tempHome, 'worktree')
    await mkdir(worktree, { recursive: true })
    const workflow = recoveryWorkflow(worktree)
    workflow.prNumber = '29'
    workflow.events = [
      {
        kind: 'review',
        at: '2026-09-01T00:00:00Z',
        taskId: 'old-review',
        hash: 'abc1234',
        round: 1,
        agent: 'codex',
        verdict: { passed: true, issues: [] },
        approvalAttempt: { status: 'pending' },
      },
    ]
    await commitWorkflowFixture(workflow, null)
    const { ctx, commands } = shellContext(async (step) => {
      if (step.command.includes('--method')) throw new Error(`recovery must never dispatch: ${step.command}`)
      assert.match(step.command, /repos\/o\/r\/pulls\/29\/reviews/)
      return { exitCode: 0, text: ok([{ state: 'APPROVED', body: REVIEW_APPROVAL_BODY }]) }
    })
    const live = liveFor(workflow)

    await recoverUnsettledWrites(ctx, live, workflow)

    assert.equal(commands.length, 1, 'readback only')
    const reloaded = await loadWorkflow(workflow.key)
    assert.equal(reloaded?.events[0].approvalAttempt?.status, 'confirmed')
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})
