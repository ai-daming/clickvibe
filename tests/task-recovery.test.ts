import assert from 'node:assert/strict'
import test from 'node:test'
import { workflowStatusLabel as clientStatusLabel } from '../src/client/runtime.ts'
import { observeTaskOwnership } from '../src/infra/task-ownership.ts'
import {
  deriveNextAction,
  deriveWorkflowStatus,
  workflowStatusLabel as hostStatusLabel,
  type WorkflowFacts,
} from '../src/workflow/state-view.ts'

function inFlight(stage: 'developing' | 'reviewing'): WorkflowFacts {
  return {
    issueOpen: true,
    prMerged: false,
    prNumber: '111',
    prState: 'OPEN',
    prStatusKnown: true,
    stage,
    devInterrupted: stage === 'developing',
    taskRunning: false,
    taskUnknown: true,
    taskInterrupted: false,
    head: '82e55b2',
    reviewedHash: null,
    reviewPassed: null,
    issueContractStatus: 'current',
    issueContractUnknownReason: null,
    hasNewCommits: false,
    needsSync: false,
    hasCommits: true,
  }
}

test('an in-flight task with unknown ownership fails closed', () => {
  const facts = inFlight('developing')
  assert.equal(deriveWorkflowStatus(facts), 'task-unknown')
  assert.deepEqual(deriveNextAction(facts), {
    kind: 'none',
    label: '等待任务确认',
    hint: '当前控制器无法确认旧任务生死,为避免双开已禁止启动新任务',
  })
})

test('an explicitly interrupted review offers a safe re-review action', () => {
  const facts = { ...inFlight('reviewing'), taskUnknown: false, taskInterrupted: true }
  assert.equal(deriveWorkflowStatus(facts), 'interrupted')
  assert.deepEqual(deriveNextAction(facts), {
    kind: 'review',
    label: '重新 Review',
    hint: '确认旧宿主任务已停止后,重新审查当前代码',
  })
})

test('host and client expose the same task-unknown status label', () => {
  assert.equal(hostStatusLabel('task-unknown', null, false), '任务状态未知')
  assert.equal(clientStatusLabel('task-unknown', null, false), '任务状态未知')
})

test('shared host registry keeps a task visible after a plugin instance loses its local map', () => {
  const jobs = {
    get(id: string) {
      assert.equal(id, 'clickvibe-1')
      return {
        id,
        kind: 'clickvibe',
        label: 'clickvibe:owner-repo-111:review:review-task-1',
        status: 'running',
        startedAt: 123,
        reported: false,
      }
    },
  }
  const ownership = observeTaskOwnership(
    { jobs },
    {
      key: 'owner-repo-111',
      stage: 'reviewing',
      devTaskId: null,
      reviewTaskId: 'review-task-1',
      devHostJobId: null,
      reviewHostJobId: 'clickvibe-1',
    },
    () => false,
  )
  assert.deepEqual(ownership, {
    state: 'running',
    startedAt: 123,
    source: 'host-registry',
    kind: 'review',
    taskId: 'review-task-1',
  })
})

test('concurrent refreshes follow one shared host-job lifecycle across controller instances', async () => {
  let status: 'running' | 'completed' = 'running'
  const jobs = {
    get() {
      return {
        id: 'clickvibe-2',
        kind: 'clickvibe',
        label: 'clickvibe:owner-repo-111:dev:dev-task-2',
        status,
        startedAt: 456,
        reported: false,
      }
    },
  }
  const workflow = {
    key: 'owner-repo-111',
    stage: 'developing' as const,
    devTaskId: 'dev-task-2',
    reviewTaskId: null,
    devHostJobId: 'clickvibe-2',
    reviewHostJobId: null,
  }
  const refresh = async () => observeTaskOwnership({ jobs }, workflow, () => false)

  const whileRunning = await Promise.all(Array.from({ length: 12 }, refresh))
  assert.ok(whileRunning.every((ownership) => ownership.state === 'running'))

  status = 'completed'
  const afterSettlement = await Promise.all(Array.from({ length: 12 }, refresh))
  assert.ok(afterSettlement.every((ownership) => ownership.state === 'interrupted'))
})

test('missing ownership evidence remains unknown instead of claiming interruption', () => {
  const ownership = observeTaskOwnership(
    {
      jobs: {
        get() {
          throw new Error('unknown job')
        },
      },
    },
    {
      key: 'owner-repo-111',
      stage: 'developing',
      devTaskId: 'dev-task-1',
      reviewTaskId: null,
      devHostJobId: null,
      reviewHostJobId: null,
    },
    () => false,
  )
  assert.deepEqual(ownership, { state: 'unknown', startedAt: null, source: 'no-proof' })
})

test('a live task remains visible after its workflow stage advances', () => {
  const ownership = observeTaskOwnership(
    {},
    {
      key: 'owner-repo-111',
      stage: 'review-ready',
      devTaskId: 'dev-2000-task',
      reviewTaskId: null,
      devHostJobId: null,
      reviewHostJobId: null,
    },
    (taskId) => taskId === 'dev-2000-task',
    () => 789,
  )
  assert.deepEqual(ownership, {
    state: 'running',
    startedAt: 789,
    source: 'local-map',
    kind: 'dev',
    taskId: 'dev-2000-task',
  })
})

test('a legacy task from before the current host process is interrupted after a real restart', () => {
  const ownership = observeTaskOwnership(
    {
      processStartedAt: 2_000,
      jobs: {
        get() {
          throw new Error('not used')
        },
        list() {
          return []
        },
      },
    },
    {
      key: 'owner-repo-111',
      stage: 'developing',
      devTaskId: 'dev-1000-legacy',
      reviewTaskId: null,
      devHostJobId: null,
      reviewHostJobId: null,
    },
    () => false,
  )
  assert.deepEqual(ownership, { state: 'interrupted', startedAt: null, source: 'host-restarted' })
})
