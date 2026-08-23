import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AUTO_RUN_PAUSE_LABEL,
  autoRunBanner,
  autoRunDefaults,
  synchronizeAutoRunDraft,
  unresolvedFindingCount,
} from '../src/client/auto-run.ts'
import type { Workflow } from '../src/client/domain.ts'

test('shared auto-run entry derives all five settings with last-used agent defaults', () => {
  const workflow = {
    devAgent: 'claude',
    reviewAgent: 'codex',
  } as Workflow
  assert.deepEqual(autoRunDefaults(workflow), {
    autoMerge: false,
    devAgent: 'claude',
    reviewAgent: 'codex',
    maxRounds: 20,
    budgetHours: 24,
  })
})

test('paused auto-run exposes the reason and aggregated unresolved finding count', () => {
  const workflow = {
    autoRun: {
      status: 'paused',
      autoMerge: false,
      devAgent: 'codex',
      reviewAgent: 'claude',
      maxRounds: 2,
      budgetHours: 24,
      startedAt: '2026-08-23T00:00:00Z',
      deadline: '2026-08-24T00:00:00Z',
      rounds: 2,
      unresolved: [{ round: 2, issues: ['仍有竞态'] }],
      lastObservedAt: '2026-08-23T02:00:00Z',
      pausedReason: 'rounds-exhausted',
    },
  } as Workflow
  assert.equal(AUTO_RUN_PAUSE_LABEL[workflow.autoRun!.pausedReason!], '轮次耗尽')
  assert.equal(unresolvedFindingCount(workflow), 1)
  assert.equal(AUTO_RUN_PAUSE_LABEL['cleanup-failed'], '合并后清理失败')
})

test('auto-run banner: list rows show no pause banner while detail shows the truth', () => {
  // 列表行(compact):暂停横幅不展示——真实状态由交付阶段徽章表达,控制器暂停不冒充流程状态。
  const row = { autoRun: { status: 'paused', pausedReason: 'session-interrupted', unresolved: [] } } as Workflow
  assert.equal(autoRunBanner(row.autoRun!, row, { compact: true }), null)

  // 详情视图:展示原因;宿主仍持有运行任务时如实说明"任务继续运行中"。
  const detail = { autoRun: { status: 'paused', pausedReason: 'session-interrupted', unresolved: [] } } as Workflow
  assert.equal(autoRunBanner(detail.autoRun!, detail, { compact: false }), '已暂停:会话中断')

  const runningTask = {
    autoRun: { status: 'paused', pausedReason: 'session-interrupted', unresolved: [] },
    runStartedAt: 1787508523191,
  } as Workflow
  assert.equal(autoRunBanner(runningTask.autoRun!, runningTask, { compact: false }), '已暂停:会话中断 · 任务继续运行中')

  // 完成态与运行态各有准确文案;无 autoRun 一律无横幅。
  const done = { autoRun: { status: 'completed', pausedReason: null, unresolved: [] } } as Workflow
  assert.equal(autoRunBanner(done.autoRun!, done, { compact: false }), '已到待合并')
  const running = { autoRun: { status: 'running', pausedReason: null, unresolved: [] }, runStartedAt: 1 } as Workflow
  assert.equal(autoRunBanner(running.autoRun!, running, { compact: false }), null)
  assert.equal(autoRunBanner(undefined, null, { compact: false }), null)
})

test('untouched form draft follows asynchronous workflow defaults without overwriting edits', () => {
  const initial = autoRunDefaults(null)
  const workflow = { devAgent: 'claude', reviewAgent: 'codex' } as Workflow
  assert.deepEqual(synchronizeAutoRunDraft(initial, workflow, false), autoRunDefaults(workflow))
  assert.equal(synchronizeAutoRunDraft(initial, workflow, true), initial)
})
