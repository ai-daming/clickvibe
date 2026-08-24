import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createLiveTask, finishTask, waitForTaskPersistence } from '../src/agent/task-supervisor.ts'
import { type LiveTask, liveTasks } from '../src/infra/runtime.ts'
import { type IssueWorkflow, loadWorkflow, saveWorkflow } from '../src/infra/state.ts'
import { workflowTaskExpectation } from '../src/infra/task-ownership.ts'
import { establishTaskClaim } from '../src/workflow/task-claim.ts'
import { mutateLiveTaskWorkflow } from '../src/workflow/task-lease.ts'
import { stopTask } from '../src/workflow/task-api.ts'

function reviewReady(worktree: string): IssueWorkflow {
  return {
    key: 'owner/repo/issue-8300',
    url: 'https://github.com/owner/repo/issues/8300',
    repoKey: 'owner/repo',
    worktree,
    branch: 'issue-8300',
    stage: 'review-ready',
    devAgent: 'codex',
    devTaskId: 'dev-8100-completed',
    devHostJobId: 'job-dev-8100-completed',
    devSessionId: 'dev-session-completed',
    devSessionAgent: 'codex',
    devInterrupted: false,
    reviewAgent: 'codex',
    reviewTaskId: 'review-8200-previous',
    reviewHostJobId: 'job-review-8200-previous',
    reviewSessionId: null,
    reviewSessionAgent: null,
    reviewResult: null,
    prNumber: '114',
    issueState: 'OPEN',
    baseRef: 'origin/main @ abc',
    updatedAt: 0,
    events: [],
  }
}

test('stop revokes the claimed LiveTask lease even when late review code reloads workflow state', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-live-task-lease-stop-'))
  const previousHome = process.env.HOME
  process.env.HOME = tempHome
  const initial = reviewReady(tempHome)
  let live: LiveTask | null = null
  try {
    await saveWorkflow(initial, null)
    const expectation = workflowTaskExpectation(initial)
    live = createLiveTask('review-8300-running', initial, 'review', 'codex', null)
    assert.deepEqual(
      await establishTaskClaim(
        initial,
        live,
        {
          kind: 'review',
          taskId: live.taskId,
          agent: 'codex',
          hostJobId: 'job-review-8300-running',
          resetSession: true,
        },
        expectation,
      ),
      { ok: true, claimed: true, taskId: live.taskId },
    )
    assert.deepEqual(live.workflowLease, {
      kind: 'review',
      taskId: live.taskId,
      taskStateRevision: 1,
    })
    assert.equal(Object.isFrozen(live.workflowLease), true)

    // Controller handoff: the old callback retains `live`, while the current
    // controller sees only persisted ownership and a host-terminal job.
    liveTasks.delete(live.taskId)
    const terminalJob = {
      id: 'job-review-8300-running',
      kind: 'clickvibe',
      label: `clickvibe:${initial.key}:review:${live.taskId}`,
      status: 'failed' as const,
      startedAt: Date.now(),
    }
    assert.deepEqual(
      await stopTask({ jobs: { list: () => [terminalJob], get: () => terminalJob } } as never, {
        taskId: live.taskId,
        confirmedStopped: true,
      }),
      { ok: true, taskId: live.taskId, stopped: false },
    )

    // Production callbacks reload first. The reload must not refresh the old
    // LiveTask capability before verdict/session/publication mutations.
    const reloaded = (await loadWorkflow(initial.key))!
    assert.equal(reloaded.stage, 'review-ready')
    const lateVerdict = await mutateLiveTaskWorkflow(live, reloaded, (current) => {
      current.stage = 'passed'
      current.reviewResult = { passed: true, issues: [] }
      current.reviewSessionId = 'session-from-stopped-agent'
      current.reviewSessionAgent = 'codex'
      current.devInterrupted = true
    })
    assert.equal(lateVerdict.status, 'ownership-lost')

    const persisted = (await loadWorkflow(initial.key))!
    assert.equal(persisted.stage, 'review-ready')
    assert.equal(persisted.reviewResult, null)
    assert.equal(persisted.reviewSessionId, null)
    assert.equal(persisted.devInterrupted, false)
  } finally {
    if (live) {
      liveTasks.delete(live.taskId)
      finishTask(live, 'stopped', null)
      if (live.cleanup) clearTimeout(live.cleanup)
      await waitForTaskPersistence(live)
    }
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})
