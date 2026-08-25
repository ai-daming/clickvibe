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
} from '../src/workflow/auto-run-recovery.ts'
import { commitWorkflowFixture } from './workflow-fixture.ts'

function workflow(tempHome: string, number: string, overrides: Partial<IssueWorkflow> = {}): IssueWorkflow {
  const key = issueKey('owner/repo', number)
  return {
    key,
    url: `https://github.com/owner/repo/issues/${number}`,
    repoKey: 'owner/repo',
    worktree: tempHome,
    branch: `clickvibe-issue-${number}`,
    stage: 'idle',
    devAgent: null,
    devTaskId: null,
    devHostJobId: null,
    devSessionId: null,
    devSessionAgent: null,
    devInterrupted: false,
    reviewAgent: null,
    reviewTaskId: null,
    reviewHostJobId: null,
    reviewSessionId: null,
    reviewSessionAgent: null,
    reviewResult: null,
    prNumber: null,
    issueState: 'OPEN',
    baseRef: 'origin/main @ b9c6dea',
    autoRun: {
      status: 'running',
      autoMerge: false,
      devAgent: 'codex',
      reviewAgent: 'codex',
      maxRounds: 20,
      budgetHours: 24,
      startedAt: new Date().toISOString(),
      deadline: new Date(Date.now() + 60_000).toISOString(),
      step: 1,
      rounds: 0,
      unresolved: [],
      lastObservedAt: null,
      pausedReason: null,
    },
    updatedAt: Date.now(),
    events: [],
    ...overrides,
  }
}

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

test('one infrastructure failure stays running and records an unlimited retry checkpoint', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-reconcile-retry-'))
  const previousHome = process.env.HOME
  process.env.HOME = tempHome
  try {
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
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('the third identical controller stack fuses with complete durable evidence', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-reconcile-fuse-'))
  const previousHome = process.env.HOME
  process.env.HOME = tempHome
  try {
    const current = workflow(tempHome, '1202')
    await commitWorkflowFixture(current, current.revision ?? null)
    const error = new Error('deterministic reconcile failure')
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await handleAutoRunControllerFailure(idleContext as never, current.key, error, 'reconcile', noWake)
      await pollWorkflow(current.key, (value) =>
        attempt < 3 ? (value.autoRun?.controllerRecovery?.attempt ?? 0) >= attempt : value.autoRun?.status === 'paused',
      )
    }
    const observed = await loadWorkflow(current.key)
    assert.equal(observed?.autoRun?.status, 'paused')
    assert.equal(observed?.autoRun?.pausedReason, 'controller-error')
    assert.equal(observed?.autoRun?.controllerRecovery?.kind, 'fused')
    assert.match(observed?.events.at(-1)?.note ?? '', /连续 3 次.*fingerprint/)
    const records = await diagnosticRecords(tempHome, '1202')
    const fuse = records.find((record) => record.event === 'auto-run-controller-fuse')
    assert.equal(fuse?.consecutive, 3)
    assert.match(String(fuse?.errorStack), /deterministic reconcile failure/)
    assert.equal(typeof fuse?.fingerprint, 'string')
    assert.match(String(fuse?.basis), /same-stack.*3/)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('watchdog reattaches only paused controller-error after cooldown and records the event', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-watchdog-'))
  const previousHome = process.env.HOME
  process.env.HOME = tempHome
  try {
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
    await maintainPausedAutoRun(idleContext as never, current.key, noWake)
    const observed = await pollWorkflow(current.key, (value) =>
      value.events.some((event) => event.note === AUTO_RUN_WATCHDOG_NOTE),
    )
    assert.equal(observed.autoRun?.status, 'running')
    assert.equal(observed.autoRun?.pausedReason, null)
    assert.equal(observed.events.filter((event) => event.note === AUTO_RUN_WATCHDOG_NOTE).length, 1)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('a controller failure cannot pause or interfere with a host-confirmed running task', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-running-task-'))
  const previousHome = process.env.HOME
  process.env.HOME = tempHome
  try {
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
    const records = await diagnosticRecords(tempHome, '1204')
    assert.ok(records.some((record) => record.event === 'auto-run-controller-retry'))
    const observed = await loadWorkflow(current.key)
    assert.equal(observed?.autoRun?.status, 'running')
    assert.equal(observed?.autoRun?.pausedReason, null)
    assert.ok(!observed?.events.some((event) => event.note?.includes('已暂停')))

    // Running/unknown observations are streak barriers: after the task settles,
    // the same stack starts at one instead of carrying a delayed fuse into idle.
    observed!.stage = 'idle'
    observed!.devTaskId = null
    observed!.devHostJobId = null
    await commitWorkflowFixture(observed!, workflowRevision(observed!))
    await handleAutoRunControllerFailure(idleContext as never, current.key, failure, 'reconcile', noWake)
    const afterSettlement = await loadWorkflow(current.key)
    assert.equal(afterSettlement?.autoRun?.status, 'running')
    assert.equal(afterSettlement?.autoRun?.controllerRecovery?.consecutive, 1)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('a rate-limit failure defers to reset instead of entering the ordinary fuse', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-ratelimit-'))
  const previousHome = process.env.HOME
  process.env.HOME = tempHome
  try {
    const current = workflow(tempHome, '1205')
    await commitWorkflowFixture(current, current.revision ?? null)
    const failure = new GithubRateLimitError(Date.now() + 60_000, 'secondary')
    await handleAutoRunControllerFailure(idleContext as never, current.key, failure, 'reconcile', noWake)
    const observed = await pollWorkflow(
      current.key,
      (value) => value.autoRun?.controllerRecovery?.kind === 'rate-limit',
    )
    assert.equal(observed.autoRun?.status, 'running')
    assert.match(observed.events.at(-1)?.note ?? '', /限流.*自动等待/)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('watchdog and retry never revive a controller-error pause after the original deadline', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-watchdog-budget-'))
  const previousHome = process.env.HOME
  process.env.HOME = tempHome
  try {
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
    assert.equal(observed.autoRun?.status, 'paused')
    assert.ok(!observed.events.some((event) => event.note === AUTO_RUN_WATCHDOG_NOTE))
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('budget exhaustion stops a host-confirmed task before persisting the semantic pause', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-budget-stop-'))
  const previousHome = process.env.HOME
  process.env.HOME = tempHome
  const killed: string[] = []
  try {
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
    await handleAutoRunControllerFailure(
      ctx as never,
      current.key,
      new Error('late controller tick'),
      'reconcile',
      noWake,
    )
    const observed = await loadWorkflow(current.key)
    assert.equal(observed?.autoRun?.pausedReason, 'budget-exhausted')
    assert.deepEqual(killed, ['host-budget-1207'])
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('temporarily unavailable workflow storage keeps a wake armed instead of abandoning recovery', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-state-unavailable-'))
  const previousHome = process.env.HOME
  process.env.HOME = tempHome
  const key = issueKey('owner/repo', '1208')
  try {
    await handleAutoRunControllerFailure(
      idleContext as never,
      key,
      new Error('filesystem unavailable'),
      'reconcile',
      noWake,
    )
    assert.equal(autoRunWakePending(key), true)
    const records = await diagnosticRecords(tempHome, '1208')
    assert.ok(records.some((record) => record.event === 'auto-run-state-unavailable'))
  } finally {
    clearAutoRunTimers(key)
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})
