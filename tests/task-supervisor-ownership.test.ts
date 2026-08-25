import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import {
  attachAgentProcess,
  createLiveTask,
  finishTask,
  reserveHostTask,
  waitForTaskPersistence,
} from '../src/agent/task-supervisor.ts'
import { type LiveTask, liveTasks } from '../src/infra/runtime.ts'
import type { IssueWorkflow } from '../src/infra/state.ts'
import { observeTaskOwnership } from '../src/infra/task-ownership.ts'

function workflow(worktree: string, taskId: string): IssueWorkflow {
  return {
    key: 'owner/repo/issue-111',
    url: 'https://github.com/owner/repo/issues/111',
    repoKey: 'owner/repo',
    worktree,
    branch: 'clickvibe-issue-111',
    stage: 'reviewing',
    devAgent: null,
    devTaskId: null,
    devSessionId: null,
    devSessionAgent: null,
    devInterrupted: false,
    reviewAgent: 'codex',
    reviewTaskId: taskId,
    reviewSessionId: null,
    reviewSessionAgent: null,
    reviewResult: null,
    prNumber: '114',
    issueState: 'OPEN',
    baseRef: 'origin/main @ 82e55b2',
    updatedAt: Date.now(),
    events: [],
  }
}

function processHarness(settleOnKill = false) {
  let settle!: () => void
  const done = new Promise<void>((resolve) => {
    settle = resolve
  })
  let killed = false
  const handle = {
    status: 'running',
    exitCode: null as number | null,
    done,
    readOutput: () => ({ delta: '', lossy: false }),
    kill: () => {
      killed = true
      if (settleOnKill) settle()
      return true
    },
  }
  return { handle, settle, killed: () => killed }
}

test('real host registry retains ownership across plugin fiber reload and cancels on host disposal', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-owner-'))
  const previousHome = process.env.HOME
  process.env.HOME = tempHome
  const host = new Context()
  const persistedTasks: LiveTask[] = []
  try {
    await host.plugin(LocalJobRegistry)
    host.jobs.attachController('clickvibe-test')

    let producerCtx!: Context
    const producerFiber = host.plugin({
      inject: ['jobs'],
      apply(ctx: Context) {
        producerCtx = ctx
      },
    })
    await producerFiber

    const firstWorkflow = workflow(tempHome, 'review-1000-first')
    const firstTask = createLiveTask(firstWorkflow.reviewTaskId!, firstWorkflow, 'review', 'codex', null)
    persistedTasks.push(firstTask)
    const firstProcess = processHarness()
    firstWorkflow.reviewHostJobId = attachAgentProcess(
      {
        jobs: producerCtx.jobs,
        shell: {
          resolve: (request: unknown) => request,
          start: () => firstProcess.handle,
        },
      } as never,
      firstTask,
      'codex exec',
      tempHome,
      'review',
      () => {},
    )

    const competingWorkflow = workflow(tempHome, 'review-1001-competing')
    const competingTask = createLiveTask(competingWorkflow.reviewTaskId!, competingWorkflow, 'review', 'codex', null)
    persistedTasks.push(competingTask)
    assert.deepEqual(reserveHostTask(producerCtx, competingTask), {
      created: false,
      taskId: firstWorkflow.reviewTaskId,
    })
    finishTask(competingTask, 'stopped', null)

    liveTasks.delete(firstTask.taskId)
    await producerFiber.dispose()

    let observerCtx!: Context
    const observerFiber = host.plugin({
      inject: ['jobs'],
      apply(ctx: Context) {
        observerCtx = ctx
      },
    })
    await observerFiber
    firstWorkflow.stage = 'passed'
    const ownership = observeTaskOwnership({ jobs: observerCtx.jobs }, firstWorkflow, () => false)
    assert.equal(ownership.state, 'running')
    assert.equal(ownership.source, 'host-registry')

    assert.equal(host.jobs.kill(firstWorkflow.reviewHostJobId as never), 'requested')
    firstWorkflow.stage = 'review-ready'
    assert.equal(observeTaskOwnership({ jobs: observerCtx.jobs }, firstWorkflow, () => false).state, 'running')
    firstProcess.settle()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const disposalWorkflow = workflow(tempHome, 'review-1002-disposal')
    const disposalTask = createLiveTask(disposalWorkflow.reviewTaskId!, disposalWorkflow, 'review', 'codex', null)
    persistedTasks.push(disposalTask)
    const disposalProcess = processHarness(true)
    disposalWorkflow.reviewHostJobId = attachAgentProcess(
      {
        jobs: observerCtx.jobs,
        shell: {
          resolve: (request: unknown) => request,
          start: () => disposalProcess.handle,
        },
      } as never,
      disposalTask,
      'codex exec',
      tempHome,
      'review',
      () => {},
    )
    liveTasks.delete(disposalTask.taskId)
    await host.fiber.dispose()
    assert.equal(disposalProcess.killed(), true)
  } finally {
    if (!host.fiber.isDisposed) await host.fiber.dispose()
    await Promise.all(persistedTasks.map(waitForTaskPersistence))
    liveTasks.delete('review-1000-first')
    liveTasks.delete('review-1001-competing')
    liveTasks.delete('review-1002-disposal')
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})
