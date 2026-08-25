import assert from 'node:assert/strict'
import test from 'node:test'
import type { AutoRunState, WorkflowEvent } from '../src/infra/state.ts'
import {
  AUTO_RUN_MAX_RETRY_MS,
  AUTO_RUN_WATCHDOG_LIMIT,
  AUTO_RUN_WATCHDOG_NOTE,
  decideAutoRunWatchdog,
  nextControllerFailure,
} from '../src/workflow/auto-run-recovery-policy.ts'

function autoRun(overrides: Partial<AutoRunState> = {}): AutoRunState {
  return {
    status: 'paused',
    autoMerge: false,
    devAgent: 'codex',
    reviewAgent: 'codex',
    maxRounds: 20,
    budgetHours: 24,
    startedAt: '2026-08-25T00:00:00.000Z',
    deadline: '2026-08-26T00:00:00.000Z',
    step: 1,
    rounds: 0,
    unresolved: [],
    lastObservedAt: '2026-08-25T00:00:00.000Z',
    pausedReason: 'controller-error',
    ...overrides,
  }
}

test('alternating transient stacks retry without a count limit for thirty simulated minutes', () => {
  const startedAt = Date.parse('2026-08-25T00:00:00.000Z')
  const deadline = startedAt + 60 * 60_000
  let now = startedAt
  let failure: ReturnType<typeof nextControllerFailure> | null = null
  let attempts = 0
  while (now < startedAt + 30 * 60_000) {
    const stack =
      attempts % 2 === 0 ? 'Error: network A\n at reconcile (a.ts:1:1)' : 'Error: git B\n at sync (b.ts:2:2)'
    failure = nextControllerFailure(failure, { name: 'Error', message: stack.split('\n')[0], stack }, now, 0.5)
    assert.equal(failure.fused, false, `alternating stack unexpectedly fused at attempt ${attempts + 1}`)
    assert.ok(failure.delayMs <= AUTO_RUN_MAX_RETRY_MS)
    assert.ok(failure.retryAt <= deadline)
    now = failure.retryAt
    attempts += 1
  }
  assert.ok(attempts > 10, 'the simulation must exceed any small fixed retry count')
  assert.equal(failure?.attempt, attempts)
})

test('the third consecutive identical stack trips the deterministic fuse with separate fingerprints', () => {
  const stackA = 'Error: invariant broke\n at reconcile (auto-run.ts:10:2)'
  const stackB = 'Error: another fault\n at reconcile (auto-run.ts:11:2)'
  const first = nextControllerFailure(null, { name: 'Error', message: 'invariant broke', stack: stackA }, 0, 0)
  const second = nextControllerFailure(first, { name: 'Error', message: 'invariant broke', stack: stackA }, 5_000, 0)
  const different = nextControllerFailure(second, { name: 'Error', message: 'another fault', stack: stackB }, 10_000, 0)
  const restarted = nextControllerFailure(
    different,
    { name: 'Error', message: 'invariant broke', stack: stackA },
    15_000,
    0,
  )
  const twice = nextControllerFailure(
    restarted,
    { name: 'Error', message: 'invariant broke', stack: stackA },
    20_000,
    0,
  )
  const fused = nextControllerFailure(twice, { name: 'Error', message: 'invariant broke', stack: stackA }, 25_000, 0)

  assert.equal(first.consecutive, 1)
  assert.equal(second.consecutive, 2)
  assert.notEqual(different.fingerprint, first.fingerprint)
  assert.equal(different.consecutive, 1)
  assert.equal(restarted.consecutive, 1, 'a different stack must break the consecutive streak')
  assert.equal(fused.consecutive, 3)
  assert.equal(fused.fused, true)
  assert.equal(fused.stack, stackA)
})

test('watchdog only reattaches controller-error and never crosses budget or ownership gates', () => {
  const now = Date.parse('2026-08-25T01:00:00.000Z')
  const ready = autoRun({
    controllerRecovery: {
      kind: 'fused',
      attempt: 3,
      consecutive: 3,
      fingerprint: 'same-stack',
      retryAt: new Date(now - 1).toISOString(),
      lastFailureAt: new Date(now - 300_000).toISOString(),
    },
  })
  assert.deepEqual(decideAutoRunWatchdog(ready, [], 'none', now), { kind: 'reattach' })
  assert.deepEqual(decideAutoRunWatchdog(ready, [], 'running', now), { kind: 'reattach' })
  assert.equal(decideAutoRunWatchdog(ready, [], 'unknown', now).kind, 'wait')
  assert.deepEqual(decideAutoRunWatchdog(ready, [], 'interrupted', now), { kind: 'session-interrupted' })
  assert.deepEqual(decideAutoRunWatchdog(autoRun({ pausedReason: 'session-interrupted' }), [], 'none', now), {
    kind: 'none',
  })
  assert.deepEqual(decideAutoRunWatchdog(ready, [], 'none', Date.parse(ready.deadline)), { kind: 'budget-exhausted' })
})

test('watchdog hourly limit delays instead of permanently abandoning the run', () => {
  const now = Date.parse('2026-08-25T01:00:00.000Z')
  const events: WorkflowEvent[] = Array.from({ length: AUTO_RUN_WATCHDOG_LIMIT }, (_, index) => ({
    kind: 'auto-run',
    at: new Date(now - 30 * 60_000 + index).toISOString(),
    note: AUTO_RUN_WATCHDOG_NOTE,
  }))
  const decision = decideAutoRunWatchdog(autoRun(), events, 'none', now)
  assert.equal(decision.kind, 'wait')
  if (decision.kind !== 'wait') return
  assert.equal(decision.reason, 'hourly-limit')
  assert.equal(decision.retryAt, Date.parse(events[0].at) + 60 * 60_000)
})
