import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveNextAction, type WorkflowFacts } from '../src/workflow/state-view.ts'

test('a missing frozen baseline must be explicitly restored before creating a PR', () => {
  const next = deriveNextAction({
    issueOpen: true,
    prMerged: false,
    prNumber: null,
    stage: 'review-ready',
    devInterrupted: false,
    taskRunning: false,
    head: 'feature-head',
    reviewedHash: null,
    reviewPassed: null,
    issueContractStatus: 'current',
    issueContractUnknownReason: null,
    hasNewCommits: false,
    needsSync: false,
    hasCommits: true,
    baseRefAvailable: false,
    baseBranch: 'release/deleted',
  } as WorkflowFacts)
  assert.deepEqual(next, {
    kind: 'restore-base',
    label: '恢复基线并创建 PR',
    hint: '远端基线 origin/release/deleted 已删除;确认后按最后已知 tip 恢复同名分支,再创建 PR',
  })
})
