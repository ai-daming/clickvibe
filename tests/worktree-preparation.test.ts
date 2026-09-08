import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { autoRunWorkflowFixture, commitWorkflowFixture } from './workflow-fixture.ts'
import {
  withWorkflowPreparationCommand,
  claimWorkflowTaskCommand,
  stopWorkflowTaskCommand,
} from '../src/infra/workflow-persistence.ts'
import { commitWorkflowMetadata, loadWorkflow, workflowRevision } from '../src/infra/state.ts'

function barrier() {
  let release!: () => void
  const promise = new Promise<void>((r) => {
    release = r
  })
  return { promise, release }
}

test('preparation transaction serializes same-workflow metadata while another workflow progresses', async () => {
  const home = await mkdtemp(join(tmpdir(), 'clickvibe-preparation-'))
  const previous = process.env.HOME
  process.env.HOME = home
  const a = autoRunWorkflowFixture(home, '171')
  const b = autoRunWorkflowFixture(home, '172')
  const entered = barrier()
  const finish = barrier()
  try {
    await commitWorkflowFixture(a, null)
    await commitWorkflowFixture(b, null)
    let waitingDone = false
    const preparing = withWorkflowPreparationCommand(a, async (transaction) => {
      entered.release()
      await finish.promise
      await transaction.commit({ baseRef: 'origin/main @ prepared' })
    })
    await entered.promise
    const waiter = commitWorkflowMetadata(a, workflowRevision(a), { baseRef: 'stale' }).then(
      () => {
        waitingDone = true
      },
      () => {
        waitingDone = true
      },
    )
    await commitWorkflowMetadata(b, workflowRevision(b), { baseRef: 'origin/main @ independent' })
    assert.equal(waitingDone, false)
    finish.release()
    await preparing
    await waiter
    assert.equal((await loadWorkflow(a.key))!.baseRef, 'origin/main @ prepared')
  } finally {
    finish.release()
    if (previous === undefined) delete process.env.HOME
    else process.env.HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('unsettled preparation blocks task claim and ordinary metadata cannot erase it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'clickvibe-preparation-claim-'))
  const previous = process.env.HOME
  process.env.HOME = home
  const w = autoRunWorkflowFixture(home, '173')
  w.preparation = {
    schema: 1,
    attemptId: 'attempt',
    runtimeInstanceId: 'old-runtime',
    taskStateRevision: 0,
    worktree: w.worktree,
    branch: w.branch,
    commonDir: home,
    baseRef: 'origin/main',
    baseOid: 'a'.repeat(40),
    expectedHead: 'a'.repeat(40),
    status: 'dispatched',
  }
  try {
    await commitWorkflowFixture(w, null)
    await assert.rejects(
      claimWorkflowTaskCommand(
        w,
        { kind: 'dev', taskId: 'dev-1-a', agent: 'codex', hostJobId: 'host-1' },
        workflowRevision(w),
        { task: null, taskStateRevision: 0 },
      ),
      /preparation/,
    )
    await assert.rejects(
      commitWorkflowMetadata(w, workflowRevision(w), { preparation: undefined } as never),
      /preparation|metadata/,
    )
  } finally {
    if (previous === undefined) delete process.env.HOME
    else process.env.HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('stop before task creation revokes the preparation generation', async () => {
  const { stopWorkflowPreparationCommand } = await import('../src/infra/workflow-persistence.ts')
  const home = await mkdtemp(join(tmpdir(), 'clickvibe-preparation-stop-'))
  const previous = process.env.HOME
  process.env.HOME = home
  const w = autoRunWorkflowFixture(home, '174')
  w.preparation = {
    schema: 1,
    attemptId: 'attempt',
    runtimeInstanceId: 'runtime',
    taskStateRevision: 0,
    worktree: home,
    branch: w.branch,
    commonDir: home,
    baseRef: 'origin/main',
    baseOid: 'a'.repeat(40),
    expectedHead: 'a'.repeat(40),
    status: 'verified',
  }
  try {
    await commitWorkflowFixture(w, null)
    const stopped = await stopWorkflowPreparationCommand(w)
    assert.equal(stopped.taskStateRevision, 1)
    const claim = await claimWorkflowTaskCommand(
      w,
      { kind: 'dev', taskId: 'dev-1-a', agent: 'codex', hostJobId: 'host-1' },
      workflowRevision(w),
      { task: null, taskStateRevision: 0 },
    )
    assert.equal(claim.status, 'ownership-lost')
  } finally {
    if (previous === undefined) delete process.env.HOME
    else process.env.HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('automatic task claims reject a replaced or expired run inside the durable lock', async () => {
  const home = await mkdtemp(join(tmpdir(), 'clickvibe-automatic-claim-'))
  const saved = process.env.HOME
  process.env.HOME = home
  const workflow = autoRunWorkflowFixture(home, '178')
  try {
    await commitWorkflowFixture(workflow, null)
    const claim = {
      kind: 'dev' as const,
      taskId: 'dev-178-new',
      agent: 'codex' as const,
      hostJobId: 'job-new',
      autoRunId: 'old-run',
    }
    await assert.rejects(
      claimWorkflowTaskCommand(workflow, claim, workflowRevision(workflow), { task: null, taskStateRevision: 0 }),
      /automatic run/,
    )
    workflow.autoRun!.deadline = new Date(0).toISOString()
    await commitWorkflowFixture(workflow, workflowRevision(workflow))
    claim.autoRunId = workflow.autoRun!.recoveryBudget!.runId
    await assert.rejects(
      claimWorkflowTaskCommand(workflow, claim, workflowRevision(workflow), { task: null, taskStateRevision: 0 }),
      /automatic run/,
    )
    assert.equal((await loadWorkflow(workflow.key))!.devTaskId, null)
    workflow.autoRun!.deadline = new Date(Date.now() + 60_000).toISOString()
    await commitWorkflowFixture(workflow, workflowRevision(workflow))
    const admitted = await claimWorkflowTaskCommand(workflow, claim, workflowRevision(workflow), {
      task: null,
      taskStateRevision: 0,
    })
    assert.equal(admitted.status, 'committed')
    assert.equal((await loadWorkflow(workflow.key))!.devTaskId, claim.taskId)
  } finally {
    if (saved === undefined) delete process.env.HOME
    else process.env.HOME = saved
    await rm(home, { recursive: true, force: true })
  }
})
