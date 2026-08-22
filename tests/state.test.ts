import assert from 'node:assert/strict'
import test from 'node:test'
import { applyDevRunOutcome, clearStaleSessionId, type IssueWorkflow } from '../src/state.ts'

function workflow(): IssueWorkflow {
  return {
    key: 'o-r-17', url: 'https://github.com/o/r/issues/17', repoKey: 'o/r',
    worktree: '/worktrees/r-issue-17', branch: 'r-issue-17', stage: 'developing',
    devAgent: 'codex', devTaskId: 'dev-1', devSessionId: null, devInterrupted: false,
    reviewAgent: null, reviewTaskId: null, reviewSessionId: null,
    reviewResult: null, prNumber: null, issueState: 'OPEN', baseRef: 'origin/main @ abc',
    updatedAt: 1, events: [],
  }
}

test('timed-out development keeps the captured session id for exact recovery', () => {
  const state = workflow()
  const completed = applyDevRunOutcome(state, 'timed_out', null, 'thread-123')
  assert.equal(completed, false)
  assert.equal(state.devSessionId, 'thread-123')
  assert.equal(state.devInterrupted, true)
  assert.equal(state.stage, 'developing')
  assert.equal(state.worktree, '/worktrees/r-issue-17')
})

test('stopped and failed development also keep the captured session id', () => {
  for (const [status, exitCode] of [['stopped', null], ['failed', 2]] as const) {
    const state = workflow()
    applyDevRunOutcome(state, status, exitCode, 'thread-123')
    assert.equal(state.devSessionId, 'thread-123')
    assert.equal(state.devInterrupted, true)
  }
})

test('successful development becomes review-ready without changing its worktree', () => {
  const state = workflow()
  state.reviewResult = { passed: false, issues: ['old review'] }
  const completed = applyDevRunOutcome(state, 'done', 0, 'thread-123')
  assert.equal(completed, true)
  assert.equal(state.stage, 'review-ready')
  assert.equal(state.devInterrupted, false)
  assert.equal(state.devSessionId, 'thread-123')
  assert.equal(state.reviewResult, null)
  assert.equal(state.worktree, '/worktrees/r-issue-17')
})

test('stale session cleanup covers dev and review without erasing a newer id', () => {
  const state = workflow()
  state.devSessionId = 'dead-dev'
  state.reviewSessionId = 'dead-review'
  assert.equal(clearStaleSessionId(state, 'dev', 'dead-dev'), true)
  assert.equal(state.devSessionId, null)
  assert.equal(clearStaleSessionId(state, 'review', 'dead-review'), true)
  assert.equal(state.reviewSessionId, null)

  state.reviewSessionId = 'new-review'
  assert.equal(clearStaleSessionId(state, 'review', 'dead-review'), false)
  assert.equal(state.reviewSessionId, 'new-review')
})
