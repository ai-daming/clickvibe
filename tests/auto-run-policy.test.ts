import assert from 'node:assert/strict'
import test from 'node:test'
import {
  aggregateAutoRunReviews,
  autoRunFailureReason,
  autoRunRetryDelay,
  decideAutoRun,
  validateAutoRunConfig,
} from '../src/workflow/auto-run-policy.ts'
import type { AutoRunState, WorkflowEvent } from '../src/infra/state.ts'

function running(overrides: Partial<AutoRunState> = {}): AutoRunState {
  return {
    status: 'running',
    autoMerge: false,
    devAgent: 'codex',
    reviewAgent: 'claude',
    maxRounds: 20,
    budgetHours: 24,
    startedAt: '2026-08-23T00:00:00.000Z',
    deadline: '2026-08-24T00:00:00.000Z',
    rounds: 0,
    unresolved: [],
    lastObservedAt: null,
    pausedReason: null,
    ...overrides,
  }
}

test('auto-run configuration accepts only bounded positive values and exact agents', () => {
  assert.deepEqual(validateAutoRunConfig({}), {
    autoMerge: false,
    devAgent: 'codex',
    reviewAgent: 'codex',
    maxRounds: 20,
    budgetHours: 24,
  })
  assert.deepEqual(validateAutoRunConfig({ devAgent: 'claude', reviewAgent: 'codex', maxRounds: 3, budgetHours: 2 }), {
    autoMerge: false,
    devAgent: 'claude',
    reviewAgent: 'codex',
    maxRounds: 3,
    budgetHours: 2,
  })
  assert.throws(() => validateAutoRunConfig({ maxRounds: 0 }), /轮次上限/)
  assert.throws(() => validateAutoRunConfig({ budgetHours: Number.POSITIVE_INFINITY }), /总预算/)
  assert.throws(() => validateAutoRunConfig({ reviewAgent: 'dryrun' }), /Review agent/)
})

test('missing or inactive auto-run state always falls back to manual mode', () => {
  const nextAction = { kind: 'review' as const, label: 'Review', hint: '' }
  assert.deepEqual(decideAutoRun({ autoRun: undefined, nextAction, now: 0, reviewEvents: [] }), { kind: 'manual' })
  assert.deepEqual(decideAutoRun({ autoRun: running({ status: 'paused' }), nextAction, now: 0, reviewEvents: [] }), {
    kind: 'manual',
  })
})

test('controller triggers only actions derived by the authoritative state view', () => {
  const expected = ['develop', 'create-pr', 'review', 'rework', 'sync'] as const
  for (const kind of expected) {
    assert.deepEqual(
      decideAutoRun({
        autoRun: running(),
        nextAction: { kind, label: kind, hint: '' },
        now: Date.parse('2026-08-23T01:00:00Z'),
        reviewEvents: [],
      }),
      { kind: 'trigger', action: kind, rounds: 0, unresolved: [] },
    )
  }
  assert.deepEqual(
    decideAutoRun({
      autoRun: running(),
      nextAction: { kind: 'resume', label: '恢复', hint: '' },
      now: Date.parse('2026-08-23T01:00:00Z'),
      reviewEvents: [],
    }),
    { kind: 'pause', reason: 'session-interrupted', rounds: 0, unresolved: [] },
  )
})

test('default stops at merge while opt-in continues through gated merge and cleanup', () => {
  const merge = { kind: 'merge' as const, label: '合并 PR', hint: '' }
  const input = { nextAction: merge, now: Date.parse('2026-08-23T01:00:00Z'), reviewEvents: [] }
  assert.deepEqual(decideAutoRun({ ...input, autoRun: running() }), {
    kind: 'complete',
    rounds: 0,
    unresolved: [],
  })
  assert.deepEqual(decideAutoRun({ ...input, autoRun: running({ autoMerge: true }) }), {
    kind: 'trigger',
    action: 'merge',
    rounds: 0,
    unresolved: [],
  })
  assert.equal(
    decideAutoRun({
      ...input,
      autoRun: running({ autoMerge: true }),
      nextAction: { kind: 'cleanup', label: '清理', hint: '' },
    }).kind,
    'trigger',
  )
})

test('review rounds count landed conclusions since this start and retain failed findings', () => {
  const reviewEvents: WorkflowEvent[] = [
    { kind: 'review', at: '2026-08-22T23:00:00Z', verdict: { passed: false, issues: ['old'] } },
    { kind: 'review', at: '2026-08-23T01:00:00Z', round: 8, verdict: { passed: false, issues: ['竞态', '缺测试'] } },
    { kind: 'review', at: '2026-08-23T02:00:00Z', round: 9, verdict: { passed: false, issues: ['竞态'] } },
  ]
  assert.deepEqual(aggregateAutoRunReviews(running(), reviewEvents), {
    rounds: 2,
    unresolved: [
      { round: 1, issues: ['竞态', '缺测试'] },
      { round: 2, issues: ['竞态'] },
    ],
  })
  assert.deepEqual(
    decideAutoRun({
      autoRun: running({ maxRounds: 2 }),
      nextAction: { kind: 'rework', label: '返工', hint: '' },
      now: Date.parse('2026-08-23T03:00:00Z'),
      reviewEvents,
    }),
    {
      kind: 'pause',
      reason: 'rounds-exhausted',
      rounds: 2,
      unresolved: [
        { round: 1, issues: ['竞态', '缺测试'] },
        { round: 2, issues: ['竞态'] },
      ],
    },
  )
})

test('deadline and task outcomes converge to explicit pause reasons', () => {
  const nextAction = { kind: 'review' as const, label: 'Review', hint: '' }
  assert.equal(
    decideAutoRun({ autoRun: running(), nextAction, now: Date.parse('2026-08-24T00:00:00Z'), reviewEvents: [] }).reason,
    'budget-exhausted',
  )
  assert.equal(
    decideAutoRun({
      autoRun: running(),
      nextAction,
      now: 0,
      reviewEvents: [],
      taskOutcome: 'timed_out',
    }).reason,
    'task-timeout',
  )
  assert.equal(
    decideAutoRun({ autoRun: running(), nextAction, now: 0, reviewEvents: [], taskOutcome: 'failed' }).reason,
    'session-interrupted',
  )
})

test('temporary observation gaps retry within the wall-clock budget', () => {
  const deadline = Date.parse('2026-08-24T00:00:00Z')
  assert.equal(autoRunRetryDelay(deadline - 60_000, deadline), 5_000)
  assert.equal(autoRunRetryDelay(deadline - 2_000, deadline), 2_000)
  assert.equal(autoRunRetryDelay(deadline, deadline), null)
})

test('cleanup failures remain distinct from merge gate rejection', () => {
  assert.equal(autoRunFailureReason('cleanup', { ok: false, merged: true, cleanupPending: true }), 'cleanup-failed')
  assert.equal(autoRunFailureReason('merge', { ok: false, gateFailures: [{}] }), 'merge-gate-rejected')
})
