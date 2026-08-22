import assert from 'node:assert/strict'
import test from 'node:test'
import {
  deriveNextAction,
  deriveWorkflowStatus,
  githubCompareUrl,
  workflowBaseBranch,
  workflowStatusLabel,
  type WorkflowFacts,
} from '../src/state-view.ts'

function facts(overrides: Partial<WorkflowFacts> = {}): WorkflowFacts {
  return {
    issueOpen: true,
    prMerged: false,
    prNumber: null,
    stage: 'idle',
    devInterrupted: false,
    taskRunning: false,
    head: 'a1b2c3d',
    reviewedHash: null,
    reviewPassed: null,
    issueContractStatus: 'current',
    issueContractUnknownReason: null,
    hasNewCommits: false,
    needsSync: false,
    ...overrides,
  }
}

test('closed issue has no next action', () => {
  const next = deriveNextAction(facts({ issueOpen: false }))
  assert.equal(next.kind, 'none')
})

test('merged PR is terminal', () => {
  const next = deriveNextAction(facts({ prMerged: true, stage: 'passed', prNumber: '9' }))
  assert.equal(next.kind, 'none')
})

test('closed unmerged PR offers the explicit recovery action', () => {
  const next = deriveNextAction(facts({ prNumber: '9', prState: 'CLOSED', prStatusKnown: true }))
  assert.equal(next.kind, 'develop')
  assert.equal(next.label, '查看原因 / 重新开发')
})

test('compare URL uses the frozen non-main workflow base', () => {
  assert.equal(workflowBaseBranch('origin/trunk @ abc123', 'main'), 'trunk')
  assert.equal(
    githubCompareUrl('o/r', 'feature/7', 'origin/trunk @ abc123', 'main'),
    'https://github.com/o/r/compare/trunk...feature%2F7?expand=1',
  )
})

test('a linked PR with an unavailable live state fails closed', () => {
  const next = deriveNextAction(facts({
    prNumber: '9', prStatusKnown: false, stage: 'passed', reviewPassed: true, reviewedHash: 'a1b2c3d',
  }))
  assert.equal(next.kind, 'none')
  assert.equal(next.label, '刷新 PR 状态')
})

test('a running task has no next action until it settles', () => {
  const next = deriveNextAction(facts({ stage: 'developing', taskRunning: true }))
  assert.equal(next.kind, 'none')
  const reviewing = deriveNextAction(facts({ stage: 'reviewing', taskRunning: true }))
  assert.equal(reviewing.kind, 'none')
})

test('a running development task stays developing even when a PR and old verdict exist', () => {
  const runningRework = facts({
    stage: 'developing', taskRunning: true, prNumber: '9', reviewPassed: false,
    reviewedHash: 'a1b2c3d', head: 'e5f6g7', hasCommits: true,
  })
  assert.equal(deriveWorkflowStatus(runningRework), 'developing')

  const runningDevWithPr = facts({
    stage: 'developing', taskRunning: true, prNumber: '9', reviewPassed: null, hasCommits: true,
  })
  assert.equal(deriveWorkflowStatus(runningDevWithPr), 'developing')
})

test('a running review task stays reviewing even when a PR exists', () => {
  assert.equal(deriveWorkflowStatus(facts({
    stage: 'reviewing', taskRunning: true, prNumber: '9', hasCommits: true,
  })), 'reviewing')
})

test('a current passed verdict passes while a known changed head requires review', () => {
  assert.equal(deriveWorkflowStatus(facts({
    stage: 'review-ready', prNumber: '9', reviewPassed: true,
    reviewedHash: 'a1b2c3d', head: 'a1b2c3d',
  })), 'passed')
  assert.equal(deriveWorkflowStatus(facts({
    stage: 'review-ready', prNumber: '9', reviewPassed: true,
    reviewedHash: 'a1b2c3d', head: 'e5f6g7', issueContractStatus: 'changed',
  })), 'review-ready')
  assert.equal(deriveWorkflowStatus(facts({
    stage: 'review-ready', prNumber: null, reviewPassed: false,
    reviewedHash: 'a1b2c3d', head: 'e5f6g7', hasCommits: true,
  })), 'review-ready')
})

test('an unavailable worktree preserves a passed verdict without evidence of new commits', () => {
  assert.equal(deriveWorkflowStatus(facts({
    stage: 'review-ready', prNumber: '9', reviewPassed: true,
    reviewedHash: 'a1b2c3d', head: null, hasNewCommits: false,
  })), 'passed')
})

test('a stale review verdict is labelled as awaiting re-review', () => {
  assert.equal(workflowStatusLabel('review-ready', false, false), '待重新 Review')
  assert.equal(workflowStatusLabel('review-ready', true, false), '待重新 Review')
  assert.equal(workflowStatusLabel('review-ready', false, true), 'Review 未通过')
})

test('interrupted development resumes the agent session', () => {
  const next = deriveNextAction(facts({ stage: 'developing', devInterrupted: true }))
  assert.equal(next.kind, 'resume')
})

test('development without a live task after host restart resumes the session', () => {
  // 持久化的 stage 仍是 developing,但 liveTasks 已随 Host 重启清空
  const next = deriveNextAction(facts({ stage: 'developing', devInterrupted: false }))
  assert.equal(next.kind, 'resume')
  assert.match(next.hint, /失联/)
})

test('aborted review re-reviews instead of blocking', () => {
  const next = deriveNextAction(facts({ stage: 'reviewing', devInterrupted: false }))
  assert.equal(next.kind, 'review')
})

test('idle issue starts development', () => {
  const next = deriveNextAction(facts({ stage: 'idle' }))
  assert.equal(next.kind, 'develop')
})

test('a branch with content but without its worktree is recoverable without workflow cache', () => {
  const next = deriveNextAction(facts({ branchExists: true, worktreeExists: false, hasCommits: true, head: null }))
  assert.equal(next.kind, 'develop')
  assert.equal(next.label, '恢复 worktree 继续开发')
})

test('an empty branch without a worktree still starts development', () => {
  const next = deriveNextAction(facts({ branchExists: true, worktreeExists: false, hasCommits: false, head: null }))
  assert.equal(next.kind, 'develop')
  assert.equal(next.label, '开始开发')
})

test('uncommitted work without a resumable session starts a fresh development session', () => {
  const next = deriveNextAction(facts({
    stage: 'idle', branchExists: true, worktreeExists: true,
    hasUncommittedChanges: true, hasResumeSession: false,
  }))
  assert.equal(next.kind, 'develop')
  assert.equal(next.label, '重新开发')
})

test('commits without a PR offer PR creation', () => {
  const next = deriveNextAction(facts({
    stage: 'idle', branchExists: true, worktreeExists: true, hasCommits: true,
  }))
  assert.equal(next.kind, 'create-pr')
})

test('review-ready without a verdict reviews', () => {
  const next = deriveNextAction(facts({ stage: 'review-ready', reviewPassed: null }))
  assert.equal(next.kind, 'review')
})

test('review-ready with a failed verdict reworks with the issues', () => {
  const next = deriveNextAction(facts({
    stage: 'review-ready', reviewPassed: false, reviewedHash: 'a1b2c3d', head: 'a1b2c3d',
  }))
  assert.equal(next.kind, 'rework')
})

test('a failed verdict still reworks when the head has moved (agent re-reads the code)', () => {
  const next = deriveNextAction(facts({
    stage: 'review-ready', reviewPassed: false, reviewedHash: 'a1b2c3d', head: 'e5f6g7',
  }))
  assert.equal(next.kind, 'rework')
})

test('a passed verdict on the current head merges the PR', () => {
  const next = deriveNextAction(facts({
    stage: 'review-ready', reviewPassed: true, reviewedHash: 'a1b2c3d', head: 'a1b2c3d', prNumber: '9',
  }))
  assert.equal(next.kind, 'merge')
})

test('a passed verdict without a linked PR has no merge action', () => {
  const next = deriveNextAction(facts({
    stage: 'review-ready', reviewPassed: true, reviewedHash: 'a1b2c3d', head: 'a1b2c3d', prNumber: null,
  }))
  assert.equal(next.kind, 'none')
  assert.match(next.hint, /未关联 PR/)
})

test('a passed verdict bound to an old head must be re-reviewed', () => {
  const next = deriveNextAction(facts({
    stage: 'review-ready', reviewPassed: true, reviewedHash: 'a1b2c3d', head: 'e5f6g7', prNumber: '9',
  }))
  assert.equal(next.kind, 'review')
})

test('a passed verdict bound to an old issue contract must be re-reviewed', () => {
  const next = deriveNextAction(facts({
    stage: 'review-ready', reviewPassed: true, reviewedHash: 'a1b2c3d', head: 'a1b2c3d',
    issueContractStatus: 'changed', prNumber: '9',
  }))
  assert.equal(next.kind, 'review')
  assert.equal(next.label, '重新 Review')
  assert.match(next.hint, /验收已变更/)
})

test('a temporarily unavailable current contract blocks merge without claiming it changed', () => {
  const next = deriveNextAction(facts({
    stage: 'passed', reviewPassed: true, reviewedHash: 'a1b2c3d', head: 'a1b2c3d',
    issueContractStatus: 'unknown', issueContractUnknownReason: 'current-contract-unavailable', prNumber: '9',
  }))
  assert.equal(next.kind, 'none')
  assert.equal(next.label, '刷新验收状态')
  assert.match(next.hint, /暂时无法读取/)
  assert.doesNotMatch(next.hint, /已变更/)
  assert.equal(deriveWorkflowStatus(facts({
    stage: 'passed', reviewPassed: true, reviewedHash: 'a1b2c3d', head: 'a1b2c3d',
    issueContractStatus: 'unknown', issueContractUnknownReason: 'current-contract-unavailable', prNumber: '9',
  })), 'review-ready')
})

test('a GitHub-only approval without a review snapshot explicitly requires ClickVibe review', () => {
  const next = deriveNextAction(facts({
    stage: 'review-ready', reviewPassed: true, reviewedHash: 'a1b2c3d', head: 'a1b2c3d',
    issueContractStatus: 'unknown', issueContractUnknownReason: 'missing-review-snapshot', prNumber: '9',
  }))
  assert.equal(next.kind, 'review')
  assert.match(next.hint, /缺少验收契约快照/)
})

test('passed stage with a PR merges', () => {
  const next = deriveNextAction(facts({
    stage: 'passed', reviewPassed: true, prNumber: '9', head: 'a1b2c3d', reviewedHash: 'a1b2c3d',
  }))
  assert.equal(next.kind, 'merge')
})

test('a stale worktree syncs before review or merge', () => {
  const reviewCase = deriveNextAction(facts({
    stage: 'review-ready', reviewPassed: null, needsSync: true,
  }))
  assert.equal(reviewCase.kind, 'sync')
  const passedCase = deriveNextAction(facts({
    stage: 'review-ready', reviewPassed: true, reviewedHash: 'a1b2c3d', head: 'a1b2c3d', needsSync: true, prNumber: '9',
  }))
  assert.equal(passedCase.kind, 'sync')
})

test('a failed review verdict reworks even when the worktree is stale (issue #26)', () => {
  // 门禁降级:同步冲突不再挡住返工——agent 先合并 origin/main 解决冲突,再修意见
  const reworkCase = deriveNextAction(facts({
    stage: 'review-ready', reviewPassed: false, reviewedHash: 'a1b2c3d', head: 'a1b2c3d', needsSync: true,
  }))
  assert.equal(reworkCase.kind, 'rework')
  assert.match(reworkCase.hint, /合并 origin\/main/)
})

test('a conflicted merge resumes instead of syncing across review stages (issue #26, PR #33)', () => {
  // MERGE_HEAD 存在时 sync 只会再次失败:待 review / 复审中断(reviewing)阶段
  // 也必须放行恢复,由 agent 先解决冲突,否则唯一按钮永远停在 sync(死锁)。
  const awaitingReview = deriveNextAction(facts({
    stage: 'review-ready', reviewPassed: null, needsSync: true, mergeConflict: true,
  }))
  assert.equal(awaitingReview.kind, 'resume')
  assert.match(awaitingReview.hint, /未完成的合并冲突/)
  const reReviewing = deriveNextAction(facts({
    stage: 'reviewing', needsSync: true, mergeConflict: true,
  }))
  assert.equal(reReviewing.kind, 'resume')
  // 无冲突时这些阶段仍先同步(快进/干净合并可以成功)
  const cleanSync = deriveNextAction(facts({
    stage: 'review-ready', reviewPassed: null, needsSync: true, mergeConflict: false,
  }))
  assert.equal(cleanSync.kind, 'sync')
})

test('an interrupted rework resumes even when the worktree is stale (issue #26)', () => {
  // 返工启动后 stage 已变为 developing;返工 agent 失败/停止/超时/Host 重启时
  // stage 保持 developing,门禁必须同样放行恢复,否则唯一动作退回 sync 再次
  // 冲突,死锁在第一次返工中断后复现。
  const failedCase = deriveNextAction(facts({
    stage: 'developing', reviewPassed: false, reviewedHash: 'a1b2c3d', head: 'a1b2c3d',
    needsSync: true, devInterrupted: true,
  }))
  assert.equal(failedCase.kind, 'resume')
  assert.match(failedCase.hint, /合并 origin\/main/)
  // Host 重启(devInterrupted 未标记)同样恢复
  const lostCase = deriveNextAction(facts({
    stage: 'developing', needsSync: true, devInterrupted: false,
  }))
  assert.equal(lostCase.kind, 'resume')
})

test('a missing worktree on a started workflow has no safe action', () => {
  const next = deriveNextAction(facts({ stage: 'review-ready', head: null }))
  assert.equal(next.kind, 'none')
  assert.match(next.hint, /worktree 缺失/)
})
