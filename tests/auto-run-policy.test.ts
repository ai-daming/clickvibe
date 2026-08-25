import assert from 'node:assert/strict'
import test from 'node:test'
import {
  aggregateAutoRunReviews,
  autoRunFailureReason,
  autoRunRetryDelay,
  decideAutoRun,
  isOrphanedAutoRun,
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
    step: 0,
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
      { kind: 'trigger', action: kind, step: 1, rounds: 0, unresolved: [] },
    )
  }
  // resume 自动执行(2026-08-25 #90 现场):并行开发必然产生大量合并冲突,#26 把
  // 解冲突路由到 resume,agent 有完整 git 权限自行解决。安全性来自恢复网(git
  // 历史 + review 绑定新 HEAD + 门禁 + 人工合并),不来自预防性拒跑;会话失配由
  // resumeDevelop 内部的精确会话回退与 ownership 门禁兜底。旧策略在此处
  // paused('session-interrupted') 是无证据的标签谎言,使每次重挂即死循环。
  assert.deepEqual(
    decideAutoRun({
      autoRun: running(),
      nextAction: { kind: 'resume', label: '恢复', hint: '' },
      now: Date.parse('2026-08-23T01:00:00Z'),
      reviewEvents: [],
    }),
    { kind: 'trigger', action: 'rework', step: 1, rounds: 0, unresolved: [] },
  )
})

test('orphan detection never pauses a fresh or task-owned auto-run (issue #111 止血)', () => {
  // 起步窗口:刚启动、还没推进过任何动作 → 绝不判孤儿,等 reconcile 建任务。
  assert.equal(
    isOrphanedAutoRun({ autoRun: { status: 'running', step: 0 }, devTaskId: null, reviewTaskId: null }, () => false),
    false,
  )
  // 推进过(step>0)但 dev/review 任一任务活着 → 不判孤儿(任务在跑,不暂停)。
  assert.equal(
    isOrphanedAutoRun(
      { autoRun: { status: 'running', step: 2 }, devTaskId: 'dev-1', reviewTaskId: null },
      (id) => id === 'dev-1',
    ),
    false,
  )
  assert.equal(
    isOrphanedAutoRun(
      { autoRun: { status: 'running', step: 1 }, devTaskId: null, reviewTaskId: 'rev-1' },
      (id) => id === 'rev-1',
    ),
    false,
  )
  // 推进过、但 dev/review 两个 taskId 都查不到 live 任务 → 真正的孤儿,才暂停。
  assert.equal(
    isOrphanedAutoRun(
      { autoRun: { status: 'running', step: 1 }, devTaskId: 'dev-1', reviewTaskId: 'rev-1' },
      () => false,
    ),
    true,
  )
  // 非 running 或没有 autoRun → 一律不判孤儿。
  assert.equal(
    isOrphanedAutoRun({ autoRun: { status: 'paused', step: 3 }, devTaskId: null, reviewTaskId: null }, () => false),
    false,
  )
  assert.equal(
    isOrphanedAutoRun({ devTaskId: null, reviewTaskId: null }, () => false),
    false,
  )
})

test('auto-run step counts every triggered action since this start, not rounds', () => {
  // 开发被重试 3 次(step 1..3),再推 review(step 4)同属第 1 轮:步是推进,轮是闭环。
  assert.deepEqual(
    decideAutoRun({
      autoRun: running({ step: 3 }),
      nextAction: { kind: 'review', label: 'Review', hint: '' },
      now: Date.parse('2026-08-23T01:00:00Z'),
      reviewEvents: [],
    }),
    { kind: 'trigger', action: 'review', step: 4, rounds: 0, unresolved: [] },
  )
  // 旧状态没有 step 字段时按 0 起算。
  const legacy = running({ step: 0 })
  delete (legacy as { step?: number }).step
  assert.deepEqual(
    decideAutoRun({
      autoRun: legacy,
      nextAction: { kind: 'develop', label: '开发', hint: '' },
      now: Date.parse('2026-08-23T01:00:00Z'),
      reviewEvents: [],
    }),
    { kind: 'trigger', action: 'develop', step: 1, rounds: 0, unresolved: [] },
  )
  // wait / pause 不是推进动作,step 不增加(decision 不带 step)。
  const wait = decideAutoRun({
    autoRun: running({ step: 2 }),
    nextAction: { kind: 'none', label: '无', hint: '' },
    now: Date.parse('2026-08-23T01:00:00Z'),
    reviewEvents: [],
  })
  assert.equal(wait.kind, 'wait')
  assert.equal('step' in wait, false)
  const exhausted = decideAutoRun({
    autoRun: running({ step: 2, maxRounds: 1 }),
    nextAction: { kind: 'rework', label: '返工', hint: '' },
    now: Date.parse('2026-08-23T01:00:00Z'),
    reviewEvents: [{ kind: 'review', at: '2026-08-23T01:00:00Z', verdict: { passed: false, issues: ['竞态'] } }],
  })
  assert.equal(exhausted.kind, 'pause')
  assert.equal('step' in exhausted, false)
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
    step: 1,
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
  assert.equal(
    decideAutoRun({
      autoRun: running(),
      nextAction,
      now: Date.parse('2026-08-24T00:00:00Z'),
      reviewEvents: [],
      taskOutcome: 'failed',
    }).reason,
    'budget-exhausted',
  )
})

test('a closed issue terminates auto-run after the budget gate without inventing more work', () => {
  const decision = decideAutoRun({
    autoRun: running(),
    nextAction: { kind: 'none', label: '已关闭', hint: '' },
    now: Date.parse('2026-08-23T01:00:00Z'),
    reviewEvents: [],
    issueOpen: false,
  })
  assert.deepEqual(decision, { kind: 'complete', reason: 'issue-closed', rounds: 0, unresolved: [] })
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
  assert.equal(autoRunFailureReason('review', { ok: false, controllerError: true }), 'controller-error')
  assert.equal(autoRunFailureReason('create-pr', { ok: false, error: 'GitHub network failed' }), 'controller-error')
  assert.equal(autoRunFailureReason('sync', { ok: false, error: 'git authentication failed' }), 'controller-error')
})
