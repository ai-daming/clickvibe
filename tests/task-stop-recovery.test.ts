import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { IssueWorkflow } from '../src/infra/state.ts'
import { loadWorkflow, saveWorkflow, startTaskLog } from '../src/infra/state.ts'
import { stopTask } from '../src/workflow/task-api.ts'

test('stop API requires explicit confirmation before releasing an unknown legacy task', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-stop-legacy-'))
  const previousHome = process.env.HOME
  process.env.HOME = tempHome
  const workflow: IssueWorkflow = {
    key: 'owner-repo-111',
    url: 'https://github.com/owner/repo/issues/111',
    repoKey: 'owner/repo',
    worktree: tempHome,
    branch: 'clickvibe-issue-111',
    stage: 'developing',
    devAgent: 'codex',
    devTaskId: 'dev-1-legacy',
    devSessionId: 'legacy-session',
    devSessionAgent: 'codex',
    devInterrupted: false,
    reviewAgent: null,
    reviewTaskId: null,
    reviewSessionId: null,
    reviewSessionAgent: null,
    reviewResult: null,
    prNumber: '114',
    issueState: 'OPEN',
    baseRef: 'origin/main @ 82e55b2',
    updatedAt: Date.now(),
    events: [],
  }
  try {
    await saveWorkflow(workflow)
    const blocked = await stopTask(
      {
        jobs: {
          list: () => [],
          get: () => {
            throw new Error('not used')
          },
        },
      } as never,
      { taskId: workflow.devTaskId },
    )
    assert.deepEqual(blocked, {
      ok: false,
      error: '任务 dev-1-legacy 的宿主归属无法确认,请在宿主任务视图停止后刷新',
    })
    assert.equal((await loadWorkflow(workflow.key))?.devInterrupted, false)

    const result = await stopTask(
      {
        jobs: {
          list: () => [],
          get: () => {
            throw new Error('not used')
          },
        },
      } as never,
      { taskId: workflow.devTaskId, confirmedStopped: true },
    )
    assert.deepEqual(result, { ok: true, taskId: 'dev-1-legacy', stopped: false })
    const recovered = await loadWorkflow(workflow.key)
    assert.equal(recovered?.stage, 'developing')
    assert.equal(recovered?.devInterrupted, true)

    if (!recovered) throw new Error('workflow missing after development recovery')
    recovered.stage = 'reviewing'
    recovered.reviewTaskId = 'review-2-legacy'
    await saveWorkflow(recovered)
    const reviewResult = await stopTask({ jobs: { list: () => [] } } as never, {
      taskId: recovered.reviewTaskId,
      confirmedStopped: true,
    })
    assert.deepEqual(reviewResult, { ok: true, taskId: 'review-2-legacy', stopped: false })
    assert.equal((await loadWorkflow(workflow.key))?.stage, 'review-ready')
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('stop API rejects a stale unknown-task confirmation after review became current', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-stop-current-task-'))
  const previousHome = process.env.HOME
  process.env.HOME = tempHome
  const workflow: IssueWorkflow = {
    key: 'owner-repo-111-current',
    url: 'https://github.com/owner/repo/issues/111',
    repoKey: 'owner/repo',
    worktree: tempHome,
    branch: 'clickvibe-issue-111',
    stage: 'passed',
    devAgent: 'codex',
    devTaskId: 'dev-1000-old',
    devSessionId: 'legacy-session',
    devSessionAgent: 'codex',
    devInterrupted: false,
    reviewAgent: 'codex',
    reviewTaskId: 'review-2000-current',
    reviewSessionId: 'review-session',
    reviewSessionAgent: 'codex',
    reviewResult: { passed: true, issues: [] },
    prNumber: '114',
    issueState: 'OPEN',
    baseRef: 'origin/main @ 82e55b2',
    updatedAt: Date.now(),
    events: [],
  }
  const registryOffline = {
    jobs: {
      list(): never {
        throw new Error('registry offline')
      },
      get(): never {
        throw new Error('registry offline')
      },
    },
  }
  try {
    await saveWorkflow(workflow)
    const stale = await stopTask(registryOffline as never, {
      taskId: workflow.devTaskId,
      confirmedStopped: true,
    })
    assert.deepEqual(stale, {
      ok: false,
      error: '任务请求已过期:当前任务为 review-2000-current,请刷新后重试',
    })
    assert.equal((await loadWorkflow(workflow.key))?.stage, 'passed')
    assert.equal((await loadWorkflow(workflow.key))?.devInterrupted, false)

    const current = await stopTask(registryOffline as never, {
      taskId: workflow.reviewTaskId,
      confirmedStopped: true,
    })
    assert.deepEqual(current, { ok: true, taskId: 'review-2000-current', stopped: false })
    assert.equal((await loadWorkflow(workflow.key))?.stage, 'review-ready')
    assert.equal((await loadWorkflow(workflow.key))?.devInterrupted, false)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('stop API cannot use stale history to kill the current running task of the same kind', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-stop-stale-running-'))
  const previousHome = process.env.HOME
  process.env.HOME = tempHome
  const staleTaskId = 'dev-2000-stale'
  const currentTaskId = 'dev-3000-current'
  const currentHostJobId = 'job-dev-current'
  const workflow: IssueWorkflow = {
    key: 'owner-repo-111-running',
    url: 'https://github.com/owner/repo/issues/111',
    repoKey: 'owner/repo',
    worktree: tempHome,
    branch: 'clickvibe-issue-111',
    stage: 'developing',
    devAgent: 'codex',
    devTaskId: currentTaskId,
    devHostJobId: currentHostJobId,
    devSessionId: 'current-session',
    devSessionAgent: 'codex',
    devInterrupted: false,
    reviewAgent: 'codex',
    reviewTaskId: null,
    reviewSessionId: null,
    reviewSessionAgent: null,
    reviewResult: null,
    prNumber: '114',
    issueState: 'OPEN',
    baseRef: 'origin/main @ 82e55b2',
    updatedAt: Date.now(),
    events: [],
  }
  const killed: string[] = []
  const currentJob = {
    id: currentHostJobId,
    kind: 'clickvibe-agent',
    label: `clickvibe:${workflow.key}:dev:${currentTaskId}`,
    status: 'running' as const,
    startedAt: 3_000,
  }
  const jobs = {
    list: () => [currentJob],
    get: () => currentJob,
    kill(id: string) {
      killed.push(id)
      return 'requested' as const
    },
  }
  try {
    await saveWorkflow(workflow)
    await startTaskLog(workflow, 'dev', staleTaskId)

    const result = await stopTask({ jobs } as never, { taskId: staleTaskId, confirmedStopped: true })

    assert.deepEqual(result, {
      ok: false,
      error: `任务请求已过期:当前任务为 ${currentTaskId},请刷新后重试`,
    })
    assert.deepEqual(killed, [])
    const persisted = await loadWorkflow(workflow.key)
    assert.equal(persisted?.devTaskId, currentTaskId)
    assert.equal(persisted?.devHostJobId, currentHostJobId)
    assert.equal(persisted?.stage, 'developing')
    assert.equal(persisted?.devInterrupted, false)

    const current = await stopTask({ jobs } as never, { taskId: currentTaskId })
    assert.deepEqual(current, { ok: true, taskId: currentTaskId, stopped: true })
    assert.deepEqual(killed, [currentHostJobId])
    assert.equal((await loadWorkflow(workflow.key))?.devInterrupted, true)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})
