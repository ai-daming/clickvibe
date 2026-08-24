import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LineLog } from '../src/infra/develop-core.ts'
import { LineBuffer } from '../src/infra/line-buffer.ts'
import { liveTasks } from '../src/infra/runtime.ts'
import type { IssueWorkflow } from '../src/infra/state.ts'
import { loadAllArchivedWorkflows, loadWorkflow, saveWorkflow, startTaskLog } from '../src/infra/state.ts'
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

test('stop API binds host-terminal interruption to the current task in both kind directions', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-stop-terminal-identity-'))
  const previousHome = process.env.HOME
  process.env.HOME = tempHome
  const scenarios = [
    {
      name: 'current-review-stale-dev',
      stage: 'reviewing' as const,
      currentKind: 'review' as const,
      currentTaskId: 'review-3000-current',
      staleTaskId: 'dev-2000-stale',
    },
    {
      name: 'current-dev-stale-review',
      stage: 'developing' as const,
      currentKind: 'dev' as const,
      currentTaskId: 'dev-4000-current',
      staleTaskId: 'review-3500-stale',
    },
  ]
  try {
    for (const scenario of scenarios) {
      const currentHostJobId = `job-${scenario.currentTaskId}`
      const workflow: IssueWorkflow = {
        key: `owner-repo-111-${scenario.name}`,
        url: 'https://github.com/owner/repo/issues/111',
        repoKey: 'owner/repo',
        worktree: tempHome,
        branch: 'clickvibe-issue-111',
        stage: scenario.stage,
        devAgent: 'codex',
        devTaskId: scenario.currentKind === 'dev' ? scenario.currentTaskId : scenario.staleTaskId,
        devHostJobId: scenario.currentKind === 'dev' ? currentHostJobId : null,
        devSessionId: 'dev-session',
        devSessionAgent: 'codex',
        devInterrupted: false,
        reviewAgent: 'codex',
        reviewTaskId: scenario.currentKind === 'review' ? scenario.currentTaskId : scenario.staleTaskId,
        reviewHostJobId: scenario.currentKind === 'review' ? currentHostJobId : null,
        reviewSessionId: 'review-session',
        reviewSessionAgent: 'codex',
        reviewResult: null,
        prNumber: '114',
        issueState: 'OPEN',
        baseRef: 'origin/main @ 82e55b2',
        updatedAt: Date.now(),
        events: [],
      }
      const terminalJob = {
        id: currentHostJobId,
        kind: 'clickvibe-agent',
        label: `clickvibe:${workflow.key}:${scenario.currentKind}:${scenario.currentTaskId}`,
        status: 'failed' as const,
        startedAt: 4_000,
      }
      const jobs = { list: () => [terminalJob], get: () => terminalJob }
      await saveWorkflow(workflow)

      const stale = await stopTask({ jobs } as never, {
        taskId: scenario.staleTaskId,
        confirmedStopped: true,
      })
      assert.deepEqual(stale, {
        ok: false,
        error: `任务请求已过期:当前任务为 ${scenario.currentTaskId},请刷新后重试`,
      })
      const unchanged = await loadWorkflow(workflow.key)
      assert.equal(unchanged?.stage, scenario.stage)
      assert.equal(unchanged?.devInterrupted, false)

      const current = await stopTask({ jobs } as never, {
        taskId: scenario.currentTaskId,
        confirmedStopped: true,
      })
      assert.deepEqual(current, { ok: true, taskId: scenario.currentTaskId, stopped: false })
      const recovered = await loadWorkflow(workflow.key)
      assert.equal(recovered?.stage, scenario.currentKind === 'review' ? 'review-ready' : 'developing')
      assert.equal(recovered?.devInterrupted, scenario.currentKind === 'dev')
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('stop API binds an explicit interrupted outcome to the current development task', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-stop-explicit-current-'))
  const previousHome = process.env.HOME
  process.env.HOME = tempHome
  const workflow: IssueWorkflow = {
    key: 'owner-repo-111-explicit-current',
    url: 'https://github.com/owner/repo/issues/111',
    repoKey: 'owner/repo',
    worktree: tempHome,
    branch: 'clickvibe-issue-111',
    stage: 'developing',
    devAgent: 'codex',
    devTaskId: 'dev-5000-current',
    devSessionId: 'dev-session',
    devSessionAgent: 'codex',
    devInterrupted: true,
    reviewAgent: 'codex',
    reviewTaskId: 'review-4000-stale',
    reviewSessionId: 'review-session',
    reviewSessionAgent: 'codex',
    reviewResult: null,
    prNumber: '114',
    issueState: 'OPEN',
    baseRef: 'origin/main @ 82e55b2',
    updatedAt: Date.now(),
    events: [],
  }
  try {
    await saveWorkflow(workflow)
    const stale = await stopTask({} as never, { taskId: workflow.reviewTaskId, confirmedStopped: true })
    assert.deepEqual(stale, {
      ok: false,
      error: '任务请求已过期:当前任务为 dev-5000-current,请刷新后重试',
    })
    assert.equal((await loadWorkflow(workflow.key))?.stage, 'developing')

    const current = await stopTask({} as never, { taskId: workflow.devTaskId, confirmedStopped: true })
    assert.deepEqual(current, { ok: true, taskId: 'dev-5000-current', stopped: false })
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('stopping a stale local task cannot overwrite the current task generation', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-stop-stale-local-'))
  const previousHome = process.env.HOME
  process.env.HOME = tempHome
  const staleTaskId = 'dev-6000-stale'
  const currentTaskId = 'dev-7000-current'
  const workflow: IssueWorkflow = {
    key: 'owner-repo-111-local-current',
    url: 'https://github.com/owner/repo/issues/111',
    repoKey: 'owner/repo',
    worktree: tempHome,
    branch: 'clickvibe-issue-111',
    stage: 'developing',
    devAgent: 'codex',
    devTaskId: currentTaskId,
    devSessionId: 'current-session',
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
  let killed = false
  try {
    await saveWorkflow(workflow)
    liveTasks.set(staleTaskId, {
      taskId: staleTaskId,
      workflowKey: workflow.key,
      workflow: { ...workflow, devTaskId: staleTaskId },
      kind: 'dev',
      agent: 'codex',
      startedAt: 6_000,
      process: {
        kill: () => {
          killed = true
          return true
        },
      } as never,
      log: new LineLog(10),
      rawLog: new LineBuffer(),
      closed: false,
      status: 'running',
      exitCode: null,
      sessionId: null,
    })

    assert.deepEqual(await stopTask({} as never, { taskId: staleTaskId }), {
      ok: true,
      taskId: staleTaskId,
      stopped: true,
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
    assert.equal(killed, true)
    const current = await loadWorkflow(workflow.key)
    assert.equal(current?.devTaskId, currentTaskId)
    assert.equal(current?.stage, 'developing')
    assert.equal(current?.devInterrupted, false)
  } finally {
    liveTasks.delete(staleTaskId)
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('historical task data cannot mutate an archived workflow', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-stop-history-only-'))
  const previousHome = process.env.HOME
  process.env.HOME = tempHome
  const taskId = 'review-8000-history-only'
  const workflow: IssueWorkflow = {
    key: 'owner-repo-111-history-only',
    url: 'https://github.com/owner/repo/issues/111',
    repoKey: 'owner/repo',
    worktree: tempHome,
    branch: 'clickvibe-issue-111',
    stage: 'reviewing',
    devAgent: 'codex',
    devTaskId: 'dev-7000-complete',
    devSessionId: 'history-session',
    devSessionAgent: 'codex',
    devInterrupted: false,
    reviewAgent: 'codex',
    reviewTaskId: taskId,
    reviewHostJobId: 'job-history-only',
    reviewSessionId: 'review-session',
    reviewSessionAgent: 'codex',
    reviewResult: null,
    prNumber: '114',
    issueState: 'OPEN',
    baseRef: 'origin/main @ 82e55b2',
    updatedAt: Date.now(),
    events: [],
    delivery: {
      status: 'archived',
      mergedAt: new Date().toISOString(),
      prHead: 'head',
      mergeStrategy: 'merge',
      cleanup: { worktree: true, localBranch: true, remoteBranch: true, issue: true },
    },
  }
  const killed: string[] = []
  try {
    await saveWorkflow(workflow)
    await startTaskLog(workflow, 'review', taskId)
    const result = await stopTask(
      {
        jobs: {
          list: () => [],
          kill: (id: string) => {
            killed.push(id)
            return 'requested'
          },
        },
      } as never,
      { taskId, confirmedStopped: true },
    )
    assert.deepEqual(result, { ok: true, taskId, stopped: false })
    assert.deepEqual(killed, [])
    assert.equal(await loadWorkflow(workflow.key), null)
    assert.equal((await loadAllArchivedWorkflows()).find((item) => item.key === workflow.key)?.stage, 'reviewing')
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})
