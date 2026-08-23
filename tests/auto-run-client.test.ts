import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AUTO_RUN_PAUSE_LABEL,
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

test('untouched form draft follows asynchronous workflow defaults without overwriting edits', () => {
  const initial = autoRunDefaults(null)
  const workflow = { devAgent: 'claude', reviewAgent: 'codex' } as Workflow
  assert.deepEqual(synchronizeAutoRunDraft(initial, workflow, false), autoRunDefaults(workflow))
  assert.equal(synchronizeAutoRunDraft(initial, workflow, true), initial)
})
