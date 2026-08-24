import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { attachAgentProcess, createLiveTask, finishTask, reserveHostTask } from '../src/agent/task-supervisor.ts'
import { liveTasks } from '../src/infra/runtime.ts'
import type { IssueWorkflow } from '../src/infra/state.ts'
import { observeTaskOwnership } from '../src/infra/task-ownership.ts'

test('host supervisor owns the real agent lifecycle across a controller-local map loss', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-owner-'))
  const previousHome = process.env.HOME
  process.env.HOME = tempHome
  try {
    let settleProcess!: () => void
    const processDone = new Promise<void>((resolve) => {
      settleProcess = resolve
    })
    const processHandle = {
      status: 'running',
      exitCode: null as number | null,
      done: processDone,
      readOutput: () => ({ delta: '', lossy: false }),
      kill: () => true,
    }
    let snapshot = {
      id: 'clickvibe-1',
      kind: 'clickvibe',
      label: '',
      status: 'running' as 'running' | 'completed' | 'killed' | 'failed',
      startedAt: 789,
      reported: false,
    }
    let hostDone: Promise<unknown> = Promise.resolve()
    const jobs = {
      list() {
        return snapshot.label === '' ? [] : [{ ...snapshot }]
      },
      start(spec: {
        label: string
        run(): { cancel(reason?: string): void; done: Promise<{ status: 'completed' | 'killed' | 'failed' }> }
      }) {
        snapshot = { ...snapshot, label: spec.label }
        const hooks = spec.run()
        hostDone = hooks.done.then((outcome) => {
          snapshot = { ...snapshot, status: outcome.status }
        })
        return snapshot.id
      },
      get() {
        return { ...snapshot }
      },
    }
    const workflow: IssueWorkflow = {
      key: 'owner/repo/issue-111',
      url: 'https://github.com/owner/repo/issues/111',
      repoKey: 'owner/repo',
      worktree: tempHome,
      branch: 'clickvibe-issue-111',
      stage: 'reviewing',
      devAgent: null,
      devTaskId: null,
      devSessionId: null,
      devSessionAgent: null,
      devInterrupted: false,
      reviewAgent: 'codex',
      reviewTaskId: 'review-task-111',
      reviewSessionId: null,
      reviewSessionAgent: null,
      reviewResult: null,
      prNumber: '114',
      issueState: 'OPEN',
      baseRef: 'origin/main @ 82e55b2',
      updatedAt: Date.now(),
      events: [],
    }
    const task = createLiveTask('review-task-111', workflow, 'review', 'codex', null)
    const hostJobId = attachAgentProcess(
      {
        jobs,
        shell: {
          resolve: (request: unknown) => request,
          start: () => processHandle,
        },
      } as never,
      task,
      'codex exec',
      tempHome,
      'review',
      () => {},
    )
    workflow.reviewHostJobId = hostJobId

    const competingWorkflow = { ...workflow, reviewTaskId: 'review-task-222', reviewHostJobId: null }
    const competingTask = createLiveTask('review-task-222', competingWorkflow, 'review', 'codex', null)
    assert.deepEqual(reserveHostTask({ jobs } as never, competingTask), {
      created: false,
      taskId: 'review-task-111',
    })
    finishTask(competingTask, 'stopped', null)

    liveTasks.delete(task.taskId)
    assert.deepEqual(
      observeTaskOwnership({ jobs }, workflow, () => false),
      {
        state: 'running',
        startedAt: 789,
        source: 'host-registry',
      },
    )

    processHandle.exitCode = 0
    settleProcess()
    await hostDone
    assert.equal(observeTaskOwnership({ jobs }, workflow, () => false).state, 'interrupted')
    await new Promise((resolve) => setTimeout(resolve, 20))
  } finally {
    liveTasks.delete('review-task-111')
    liveTasks.delete('review-task-222')
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})
