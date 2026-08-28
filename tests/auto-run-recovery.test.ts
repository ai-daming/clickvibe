import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { GithubRateLimitError } from '../src/github/rest.ts'
import { type IssueWorkflow, issueKey, loadWorkflow, workflowRevision } from '../src/infra/state.ts'
import { AUTO_RUN_WATCHDOG_NOTE } from '../src/workflow/auto-run-recovery-policy.ts'
import {
  autoRunWakePending,
  clearAutoRunTimers,
  handleAutoRunControllerFailure,
  maintainPausedAutoRun,
  pauseAutoRun,
} from '../src/workflow/auto-run-recovery.ts'
import { requestAutoRunReconcile } from '../src/workflow/auto-run.ts'
import { autoRunWorkflowFixture as workflow, commitWorkflowFixture } from './workflow-fixture.ts'

async function pollWorkflow(key: string, ready: (value: IssueWorkflow) => boolean): Promise<IssueWorkflow> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await loadWorkflow(key)
    if (value && ready(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const value = await loadWorkflow(key)
  assert.fail(`workflow did not reach expected state: ${JSON.stringify(value?.autoRun)}`)
}

async function diagnosticRecords(tempHome: string, number: string): Promise<Record<string, unknown>[]> {
  const path = join(tempHome, '.clickvibe', 'state', 'owner', 'repo', `issue-${number}`, 'diagnostics.jsonl')
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const content = await readFile(path, 'utf8').catch(() => '')
    if (content.trim()) return content.trim().split('\n').map(JSON.parse)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return []
}

const idleContext = { jobs: { list: () => [], get: () => assert.fail('no task expected') } }
const noWake = () => {}
let tempHome: string
let previousHome: string | undefined

test.before(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-auto-run-recovery-'))
  previousHome = process.env.HOME
  process.env.HOME = tempHome
})

test.after(async () => {
  for (const number of ['1201', '1202', '1203', '1204', '1205', '1206', '1207', '1208', '1209', '122']) {
    clearAutoRunTimers(issueKey('owner/repo', number))
  }
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  await rm(tempHome, { recursive: true, force: true })
})

function failingReconcileContext(error: Error) {
  return {
    jobs: { list: () => [], get: () => assert.fail('no task expected') },
    shell: {
      resolve: (spec: unknown) => spec,
      async run(): Promise<never> {
        throw error
      },
    },
  }
}

test('one infrastructure failure stays running and records an unlimited retry checkpoint', async () => {
  const current = workflow(tempHome, '1201')
  await commitWorkflowFixture(current, current.revision ?? null)
  await handleAutoRunControllerFailure(
    idleContext as never,
    current.key,
    new Error('forced reconcile failure'),
    'reconcile',
    noWake,
  )

  const observed = await pollWorkflow(current.key, (value) => (value.autoRun?.controllerRecovery?.attempt ?? 0) >= 1)
  assert.equal(observed.autoRun?.status, 'running')
  assert.equal(observed.autoRun?.pausedReason, null)
  assert.equal(observed.autoRun?.controllerRecovery?.kind, 'transient')
  const records = await diagnosticRecords(tempHome, '1201')
  const retry = records.find((record) => record.event === 'auto-run-controller-retry')
  assert.equal(retry?.errorName, 'Error')
  assert.equal(retry?.errorMessage, 'forced reconcile failure')
  assert.match(String(retry?.errorStack), /forced reconcile failure/)
  assert.equal(retry?.attempt, 1)
  assert.equal(retry?.consecutive, 1)
  assert.equal(typeof retry?.fingerprint, 'string')
  assert.equal(typeof retry?.retryAt, 'string')
})

test('the reconcile queue fuses three identical stacks and coalesces watchdog signals', async () => {
  const current = workflow(tempHome, '1202')
  await commitWorkflowFixture(current, current.revision ?? null)
  const ctx = failingReconcileContext(new Error('deterministic reconcile failure'))
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    requestAutoRunReconcile(ctx as never, current.key)
    await pollWorkflow(current.key, (value) =>
      attempt < 3 ? (value.autoRun?.controllerRecovery?.attempt ?? 0) >= attempt : value.autoRun?.status === 'paused',
    )
  }
  const observed = await loadWorkflow(current.key)
  assert.equal(observed?.autoRun?.pausedReason, 'controller-error')
  assert.equal(observed?.autoRun?.controllerRecovery?.kind, 'fused')
  assert.match(observed?.events.at(-1)?.note ?? '', /连续 3 次.*fingerprint/)
  const fuse = (await diagnosticRecords(tempHome, '1202')).find((record) => record.event === 'auto-run-controller-fuse')
  assert.equal(fuse?.consecutive, 3)
  assert.match(String(fuse?.errorStack), /deterministic reconcile failure/)
  assert.equal(typeof fuse?.fingerprint, 'string')
  assert.match(String(fuse?.basis), /same-stack.*3/)

  observed!.autoRun!.lastObservedAt = new Date(Date.now() - 600_000).toISOString()
  observed!.autoRun!.controllerRecovery!.retryAt = new Date(Date.now() - 1).toISOString()
  await commitWorkflowFixture(observed!, workflowRevision(observed!))
  for (let signal = 0; signal < 5; signal += 1) requestAutoRunReconcile(ctx as never, current.key)
  const reattached = await pollWorkflow(
    current.key,
    (value) => value.autoRun?.status === 'running' && value.autoRun.controllerRecovery?.kind === 'transient',
  )
  assert.equal(reattached.events.filter((event) => event.note === AUTO_RUN_WATCHDOG_NOTE).length, 1)
})

test('the queue reattaches controller-error and same-round failure remains transient', async () => {
  const current = workflow(tempHome, '1203')
  current.autoRun = {
    ...current.autoRun!,
    status: 'paused',
    pausedReason: 'controller-error',
    lastObservedAt: new Date(Date.now() - 600_000).toISOString(),
    controllerRecovery: {
      kind: 'fused',
      attempt: 3,
      consecutive: 3,
      fingerprint: 'fused-stack',
      retryAt: new Date(Date.now() - 1).toISOString(),
      lastFailureAt: new Date(Date.now() - 600_000).toISOString(),
    },
  }
  await commitWorkflowFixture(current, current.revision ?? null)
  requestAutoRunReconcile(failingReconcileContext(new Error('failure after watchdog')) as never, current.key)
  const observed = await pollWorkflow(
    current.key,
    (value) => value.autoRun?.status === 'running' && value.autoRun.controllerRecovery?.kind === 'transient',
  )
  assert.equal(observed.autoRun?.pausedReason, null)
  assert.equal(observed.events.filter((event) => event.note === AUTO_RUN_WATCHDOG_NOTE).length, 1)
})

test('the queue and controller pause cannot downgrade a semantic interruption', async () => {
  const current = workflow(tempHome, '1209')
  current.autoRun = { ...current.autoRun!, status: 'paused', pausedReason: 'session-interrupted' }
  await commitWorkflowFixture(current, current.revision ?? null)
  requestAutoRunReconcile(failingReconcileContext(new Error('ignored controller failure')) as never, current.key)
  await pauseAutoRun(current.key, 'controller-error', { error: 'must not replace semantics' })
  await new Promise((resolve) => setTimeout(resolve, 50))
  const observed = await loadWorkflow(current.key)
  assert.equal(observed?.autoRun?.pausedReason, 'session-interrupted')
  assert.ok(!observed?.events.some((event) => event.note === AUTO_RUN_WATCHDOG_NOTE))
})

test('a controller failure cannot pause or interfere with a host-confirmed running task', async () => {
  const current = workflow(tempHome, '1204', {
    stage: 'developing',
    devTaskId: 'dev-running-1204',
    devHostJobId: 'host-running-1204',
  })
  await commitWorkflowFixture(current, current.revision ?? null)
  const ctx = {
    jobs: {
      list: () => [
        {
          id: 'host-running-1204',
          kind: 'clickvibe',
          label: `clickvibe:${current.key}:dev:dev-running-1204`,
          status: 'running',
          startedAt: Date.now(),
        },
      ],
      get: () => assert.fail('list owns the task evidence'),
    },
  }
  const failure = new Error('controller failed while task runs')
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await handleAutoRunControllerFailure(ctx as never, current.key, failure, 'reconcile', noWake)
  }
  assert.ok((await diagnosticRecords(tempHome, '1204')).some((record) => record.event === 'auto-run-controller-retry'))
  const observed = await loadWorkflow(current.key)
  assert.equal(observed?.autoRun?.status, 'running')
  assert.equal(observed?.autoRun?.pausedReason, null)
  assert.ok(!observed?.events.some((event) => event.note?.includes('已暂停')))

  observed!.stage = 'idle'
  observed!.devTaskId = null
  observed!.devHostJobId = null
  await commitWorkflowFixture(observed!, workflowRevision(observed!))
  await handleAutoRunControllerFailure(idleContext as never, current.key, failure, 'reconcile', noWake)
  const afterSettlement = await loadWorkflow(current.key)
  assert.equal(afterSettlement?.autoRun?.controllerRecovery?.consecutive, 1)
})

test('a rate-limit failure defers to reset instead of entering the ordinary fuse', async () => {
  const current = workflow(tempHome, '1205')
  await commitWorkflowFixture(current, current.revision ?? null)
  const failure = new GithubRateLimitError(Date.now() + 60_000, 'secondary')
  await handleAutoRunControllerFailure(idleContext as never, current.key, failure, 'reconcile', noWake)
  const observed = await pollWorkflow(current.key, (value) => value.autoRun?.controllerRecovery?.kind === 'rate-limit')
  assert.equal(observed.autoRun?.status, 'running')
  assert.match(observed.events.at(-1)?.note ?? '', /限流.*自动等待/)
})

test('watchdog and retry never revive a controller-error pause after the original deadline', async () => {
  const current = workflow(tempHome, '1206')
  current.autoRun = {
    ...current.autoRun!,
    status: 'paused',
    pausedReason: 'controller-error',
    deadline: new Date(Date.now() - 1).toISOString(),
    controllerRecovery: {
      kind: 'fused',
      attempt: 3,
      consecutive: 3,
      fingerprint: 'expired',
      retryAt: new Date(Date.now() - 1).toISOString(),
      lastFailureAt: new Date(Date.now() - 10_000).toISOString(),
    },
  }
  await commitWorkflowFixture(current, current.revision ?? null)
  await maintainPausedAutoRun(idleContext as never, current.key, noWake)
  const observed = await pollWorkflow(current.key, (value) => value.autoRun?.pausedReason === 'budget-exhausted')
  assert.ok(!observed.events.some((event) => event.note === AUTO_RUN_WATCHDOG_NOTE))
})

test('budget exhaustion stops a host-confirmed task before persisting the semantic pause', async () => {
  const killed: string[] = []
  const current = workflow(tempHome, '1207', {
    stage: 'developing',
    devTaskId: 'dev-budget-1207',
    devHostJobId: 'host-budget-1207',
  })
  current.autoRun!.deadline = new Date(Date.now() - 1).toISOString()
  await commitWorkflowFixture(current, current.revision ?? null)
  const job = {
    id: 'host-budget-1207',
    kind: 'clickvibe',
    label: `clickvibe:${current.key}:dev:dev-budget-1207`,
    status: 'running' as const,
    startedAt: Date.now(),
  }
  const ctx = {
    jobs: {
      list: () => [job],
      get: () => job,
      kill(id: string) {
        killed.push(id)
        return 'requested'
      },
    },
  }
  await handleAutoRunControllerFailure(ctx as never, current.key, new Error('late tick'), 'reconcile', noWake)
  assert.equal((await loadWorkflow(current.key))?.autoRun?.pausedReason, 'budget-exhausted')
  assert.deepEqual(killed, ['host-budget-1207'])
})

test('temporarily unavailable workflow storage keeps a wake armed instead of abandoning recovery', async () => {
  const key = issueKey('owner/repo', '1208')
  await handleAutoRunControllerFailure(
    idleContext as never,
    key,
    new Error('filesystem unavailable'),
    'reconcile',
    noWake,
  )
  assert.equal(autoRunWakePending(key), true)
  assert.ok((await diagnosticRecords(tempHome, '1208')).some((record) => record.event === 'auto-run-state-unavailable'))
})

test('rapid rate-limit reconciles during one circuit window defer only once', async () => {
  const current = workflow(tempHome, '122', {
    stage: 'developing',
    devTaskId: 'dev-task-122',
    devHostJobId: 'clickvibe-122',
  })
  await commitWorkflowFixture(current, current.revision ?? null)
  const resetAt = Date.now() + 120_000 // 远离触发,只验证去抖
  const ctx = Object.defineProperty({}, 'jobs', {
    get() {
      throw new GithubRateLimitError(resetAt)
    },
  })
  requestAutoRunReconcile(ctx as never, current.key)
  await new Promise((resolve) => setTimeout(resolve, 50))
  requestAutoRunReconcile(ctx as never, current.key)
  await new Promise((resolve) => setTimeout(resolve, 50))
  requestAutoRunReconcile(ctx as never, current.key)
  await new Promise((resolve) => setTimeout(resolve, 300))
  const observed = await loadWorkflow(current.key)
  const defers = (observed?.events ?? []).filter((event) => (event.note ?? '').includes('限流'))
  assert.equal(defers.length, 1, `同一熔断窗口只应记录一次等待,实际 ${defers.length} 次`)
  assert.equal(observed?.autoRun?.status, 'running')
})
