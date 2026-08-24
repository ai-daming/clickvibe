import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import test from 'node:test'
import { createLiveTask, finishTask, waitForTaskPersistence } from '../src/agent/task-supervisor.ts'
import { type LiveTask, liveTasks } from '../src/infra/runtime.ts'
import { type IssueWorkflow, loadWorkflow, commitWorkflow, statePath } from '../src/infra/state.ts'
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

async function waitForLockWaiter(path: string): Promise<void> {
  const directory = dirname(path)
  const prefix = `${basename(path)}.lock.${process.pid}-`
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if ((await readdir(directory)).some((entry) => entry.startsWith(prefix) && entry.endsWith('.candidate'))) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(`workflow command did not wait on ${path}.lock`)
}

async function waitForLockIdle(path: string): Promise<void> {
  const directory = dirname(path)
  const name = `${basename(path)}.lock`
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (!(await readdir(directory)).some((entry) => entry === name || entry.startsWith(`${name}.`))) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(`workflow command did not release ${path}.lock`)
}

test('stop revokes the claimed LiveTask lease even when late review code reloads workflow state', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-live-task-lease-stop-'))
  const previousHome = process.env.HOME
  process.env.HOME = tempHome
  const initial = reviewReady(tempHome)
  let live: LiveTask | null = null
  try {
    await commitWorkflow(initial, null)
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

test('stop is an awaited chain terminator in the workflow command order', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-workflow-command-stop-'))
  const previousHome = process.env.HOME
  process.env.HOME = tempHome
  try {
    for (let round = 0; round < 20; round += 1) {
      const initial = reviewReady(tempHome)
      initial.key = `owner/repo/issue-command-${round}`
      initial.url = `https://github.com/owner/repo/issues/${8400 + round}`
      const taskId = `review-${8400 + round}-running`
      await commitWorkflow(initial, null)
      const live = createLiveTask(taskId, initial, 'review', 'codex', null)
      try {
        assert.equal(
          (
            await establishTaskClaim(
              initial,
              live,
              {
                kind: 'review',
                taskId,
                agent: 'codex',
                hostJobId: `job-${taskId}`,
                resetSession: true,
              },
              workflowTaskExpectation(initial),
            )
          ).ok,
          true,
        )

        const path = statePath(initial)
        const lockPath = `${path}.lock`
        await writeFile(lockPath, JSON.stringify({ pid: process.pid, token: `test-${round}` }), 'utf8')
        const reloaded = (await loadWorkflow(initial.key))!
        const callback = mutateLiveTaskWorkflow(live, reloaded, (current) => {
          current.stage = 'passed'
          current.reviewResult = { passed: true, issues: [] }
          current.reviewSessionId = `late-session-${round}`
          current.reviewSessionAgent = 'codex'
        })
        await waitForLockWaiter(path)

        let stopSettled = false
        const stop = stopTask({} as never, { taskId }).then((result) => {
          stopSettled = true
          return result
        })
        await new Promise((resolve) => setImmediate(resolve))
        const returnedBeforeDurableRevocation = stopSettled
        await unlink(lockPath)

        const callbackResult = await callback
        assert.deepEqual(await stop, { ok: true, taskId, stopped: false })
        await waitForLockIdle(path)
        assert.equal(returnedBeforeDurableRevocation, false, `round ${round}: stop acknowledged before revocation`)
        assert.equal(
          callbackResult.status,
          'committed',
          `round ${round}: command order did not preserve callback before stop`,
        )

        const afterStop = (await loadWorkflow(initial.key))!
        assert.equal(afterStop.stage, 'review-ready', `round ${round}: callback verdict survived stop`)
        assert.equal(afterStop.reviewResult, null, `round ${round}: callback result survived stop`)
        assert.equal(afterStop.reviewSessionId, null, `round ${round}: callback session survived stop`)
        assert.equal(
          (await mutateLiveTaskWorkflow(live, afterStop, (current) => (current.stage = 'passed'))).status,
          'ownership-lost',
          `round ${round}: command after stop retained the old lease`,
        )
      } finally {
        liveTasks.delete(taskId)
        finishTask(live, 'stopped', null)
        if (live.cleanup) clearTimeout(live.cleanup)
        await waitForTaskPersistence(live)
        await unlink(`${statePath(initial)}.lock`).catch(() => undefined)
      }
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})
