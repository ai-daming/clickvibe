import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { commitWorkflowFixture, autoRunWorkflowFixture } from './workflow-fixture.ts'
import { loadWorkflow, commitWorkflowMetadata, workflowRevision } from '../src/infra/state.ts'
import {
  clearAutoRunControllerFailure,
  clearAutoRunTimers,
  handleAutoRunControllerFailure as handleBoundControllerFailure,
  maintainPausedAutoRun,
} from '../src/workflow/auto-run-recovery.ts'
import { nextControllerFailure, controllerFailureEvidence } from '../src/workflow/auto-run-recovery-policy.ts'
import { ShellCommandError } from '../src/infra/shell-failure.ts'
const ctx = { jobs: { list: () => [], get: () => assert.fail('no task') } }

test('shell identity, not call-site stack or dynamic output, counts consecutive failures', () => {
  const first = new ShellCommandError('worktree-observe', 'timeout', 'SIGTERM', null)
  const other = new ShellCommandError('worktree-observe', 'timeout', 'SIGTERM', null)
  const a = nextControllerFailure(null, controllerFailureEvidence(first), 0, 0.5)
  const b = nextControllerFailure(a, controllerFailureEvidence(other), 1, 0.5)
  assert.equal(b.consecutive, 2)
})

test('second fuse stays halted after timers reset, observation success, and metadata attempts', async () => {
  const home = await mkdtemp(join(tmpdir(), 'clickvibe-recovery-budget-'))
  const saved = process.env.HOME
  process.env.HOME = home
  const workflow = autoRunWorkflowFixture(home, '170')
  workflow.autoRun!.recoveryBudget = { schema: 1, runId: 'run-170', cooldownUsed: false, halted: false }
  try {
    await commitWorkflowFixture(workflow, null)
    const fail = () =>
      handleAutoRunControllerFailure(
        ctx as never,
        workflow.key,
        new ShellCommandError('worktree-observe', 'timeout', 'SIGTERM', null),
        'prepare',
        () => {},
      )
    for (let i = 0; i < 3; i++) await fail()
    let current = (await loadWorkflow(workflow.key))!
    assert.equal(current.autoRun!.status, 'paused')
    current.autoRun!.controllerRecovery!.retryAt = new Date(0).toISOString()
    await commitWorkflowFixture(current, workflowRevision(current))
    assert.equal(await maintainPausedAutoRun(ctx as never, workflow.key, () => {}), 'reattached')
    current = (await loadWorkflow(workflow.key))!
    assert.equal(current.autoRun!.recoveryBudget!.cooldownUsed, true)
    for (let i = 0; i < 3; i++) await fail()
    current = (await loadWorkflow(workflow.key))!
    assert.equal(current.autoRun!.recoveryBudget!.halted, true)
    clearAutoRunTimers(workflow.key)
    await clearAutoRunControllerFailure(workflow.key)
    assert.equal(await maintainPausedAutoRun(ctx as never, workflow.key, () => {}), 'handled')
    current = (await loadWorkflow(workflow.key))!
    const reset = structuredClone(current.autoRun!)
    reset.recoveryBudget!.halted = false
    reset.recoveryBudget!.cooldownUsed = false
    await assert.rejects(
      commitWorkflowMetadata(current, workflowRevision(current), { autoRun: reset }),
      /recovery.*budget|protected/i,
    )
    assert.equal((await loadWorkflow(workflow.key))!.autoRun!.recoveryBudget!.halted, true)
  } finally {
    clearAutoRunTimers(workflow.key)
    if (saved === undefined) delete process.env.HOME
    else process.env.HOME = saved
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('a late failure from a replaced automatic run cannot charge the new run', async () => {
  const home = await mkdtemp(join(tmpdir(), 'clickvibe-stale-run-'))
  const saved = process.env.HOME
  process.env.HOME = home
  const workflow = autoRunWorkflowFixture(home, '179')
  workflow.autoRun!.recoveryBudget!.runId = 'new-run'
  try {
    await commitWorkflowFixture(workflow, null)
    await handleAutoRunControllerFailure(
      ctx as never,
      workflow.key,
      new Error('old run failure'),
      'reconcile',
      () => {},
      'old-run',
    )
    assert.equal((await loadWorkflow(workflow.key))!.autoRun!.controllerRecovery, undefined)
  } finally {
    clearAutoRunTimers(workflow.key)
    if (saved === undefined) delete process.env.HOME
    else process.env.HOME = saved
    await rm(home, { recursive: true, force: true })
  }
})

async function handleAutoRunControllerFailure(ctx, key, error, source, wake, runId?: string | null) {
  const expected = runId === undefined ? ((await loadWorkflow(key))?.autoRun?.recoveryBudget?.runId ?? null) : runId
  return handleBoundControllerFailure(ctx, key, error, source, wake, expected)
}

test('a persisted fuse awaiting its pause is completed before another action is admitted', async () => {
  const { enforcePendingControllerFuse } = await import('../src/workflow/auto-run-pending.ts')
  const home = await mkdtemp(join(tmpdir(), 'clickvibe-pending-fuse-'))
  const saved = process.env.HOME
  process.env.HOME = home
  const workflow = autoRunWorkflowFixture(home, '177')
  workflow.autoRun!.recoveryBudget!.cooldownUsed = true
  workflow.autoRun!.controllerRecovery = {
    kind: 'fused',
    attempt: 3,
    consecutive: 3,
    fingerprint: 'same-error',
    retryAt: new Date().toISOString(),
    lastFailureAt: new Date().toISOString(),
  }
  try {
    await commitWorkflowFixture(workflow, null)
    assert.equal(await enforcePendingControllerFuse(ctx as never, workflow, () => {}), true)
    const current = (await loadWorkflow(workflow.key))!
    assert.equal(current.autoRun!.status, 'paused')
    assert.equal(current.autoRun!.recoveryBudget!.halted, true)
    assert.equal(current.autoRun!.controllerRecovery!.consecutive, 3)
  } finally {
    clearAutoRunTimers(workflow.key)
    if (saved === undefined) delete process.env.HOME
    else process.env.HOME = saved
    await rm(home, { recursive: true, force: true })
  }
})

test('paused, halted, malformed and replaced grants cannot authorize an automatic action', async () => {
  const { assertAutomaticRunAdmission } = await import('../src/infra/recovery-budget.ts')
  const current = autoRunWorkflowFixture('/fixture', '176')
  const id = current.autoRun!.recoveryBudget!.runId
  const now = Date.now()
  assert.doesNotThrow(() => assertAutomaticRunAdmission(current, id, now))
  assert.doesNotThrow(() => assertAutomaticRunAdmission(current, undefined, now))
  assert.throws(() => assertAutomaticRunAdmission(null, id, now), /automatic run/)
  assert.throws(() => assertAutomaticRunAdmission(current, 42, now), /automatic run/)
  const paused = structuredClone(current)
  paused.autoRun!.status = 'paused'
  assert.throws(() => assertAutomaticRunAdmission(paused, id, now), /automatic run/)
  const halted = structuredClone(current)
  halted.autoRun!.recoveryBudget!.halted = true
  assert.throws(() => assertAutomaticRunAdmission(halted, id, now), /automatic run/)
  const invalid = structuredClone(current)
  invalid.autoRun!.deadline = 'unknown'
  assert.throws(() => assertAutomaticRunAdmission(invalid, id, now), /automatic run/)
})
