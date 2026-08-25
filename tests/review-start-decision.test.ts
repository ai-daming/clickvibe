import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveNextAction, deriveReviewStartDecision, type WorkflowFacts } from '../src/workflow/state-view.ts'

function facts(overrides: Partial<WorkflowFacts> = {}): WorkflowFacts {
  return {
    issueOpen: true,
    prMerged: false,
    prNumber: null,
    stage: 'idle',
    devInterrupted: false,
    taskRunning: false,
    head: 'abc1234',
    reviewedHash: null,
    reviewPassed: null,
    issueContractStatus: 'current',
    issueContractUnknownReason: null,
    hasNewCommits: false,
    needsSync: false,
    workflowCachePresent: true,
    deliveryHash: null,
    ...overrides,
  }
}

test('review start and next action share the same completed hard-fact decision without workflow cache', () => {
  const completed = facts({
    workflowCachePresent: false,
    branchExists: true,
    worktreeExists: true,
    hasCommits: true,
    prNumber: '105',
    prState: 'OPEN',
    deliveryHash: 'abc1234567890',
  })

  assert.deepEqual(deriveReviewStartDecision(completed), { allowed: true, reason: 'completed-facts' })
  assert.equal(deriveNextAction(completed).kind, 'review')
})

test('review start rejects a live task before considering cached or hard completion facts', () => {
  const running = facts({
    stage: 'review-ready',
    taskRunning: true,
    branchExists: true,
    worktreeExists: true,
    hasCommits: true,
    prNumber: '105',
    prState: 'OPEN',
    deliveryHash: 'abc1234',
  })

  assert.deepEqual(deriveReviewStartDecision(running), { allowed: false, reason: 'task-running' })
  assert.equal(deriveNextAction(running).kind, 'none')
})

test('developing with unknown task ownership remains fail closed', () => {
  const developing = facts({
    stage: 'developing',
    branchExists: true,
    worktreeExists: true,
    hasCommits: true,
    prNumber: '105',
    prState: 'OPEN',
    deliveryHash: 'old9999',
    taskUnknown: true,
  })

  assert.deepEqual(deriveReviewStartDecision(developing), {
    allowed: false,
    reason: 'task-unknown',
  })
  assert.equal(deriveNextAction(developing).kind, 'none')
})

test('an interrupted rework resumes even when unchanged delivery facts still match', () => {
  const interrupted = facts({
    stage: 'developing',
    devInterrupted: true,
    taskInterrupted: true,
    branchExists: true,
    worktreeExists: true,
    hasCommits: true,
    prNumber: '105',
    prState: 'OPEN',
    deliveryHash: 'abc1234567890',
  })

  assert.deepEqual(deriveReviewStartDecision(interrupted), {
    allowed: false,
    reason: 'development-in-progress',
  })
  assert.equal(deriveNextAction(interrupted).kind, 'resume')
})

test('a short ambiguous hash or stale worktree cannot satisfy completion facts', () => {
  for (const overrides of [{ deliveryHash: 'abc' }, { deliveryHash: 'abc1234', needsSync: true }]) {
    assert.equal(
      deriveReviewStartDecision(
        facts({
          workflowCachePresent: false,
          branchExists: true,
          worktreeExists: true,
          hasCommits: true,
          prNumber: '105',
          prState: 'OPEN',
          ...overrides,
        }),
      ).allowed,
      false,
    )
  }
})

test('missing cache and missing completion facts have a distinct refusal reason', () => {
  assert.deepEqual(
    deriveReviewStartDecision(
      facts({
        workflowCachePresent: false,
        branchExists: false,
        worktreeExists: false,
        hasCommits: false,
        head: null,
      }),
    ),
    { allowed: false, reason: 'workflow-cache-missing' },
  )
})

test('an existing idle workflow without completion facts reports no completion facts', () => {
  assert.deepEqual(deriveReviewStartDecision(facts()), { allowed: false, reason: 'no-completion-facts' })
})

test('persisted review-ready remains reviewable for backward-compatible workflow recovery', () => {
  const ready = facts({ stage: 'review-ready' })
  assert.deepEqual(deriveReviewStartDecision(ready), { allowed: true, reason: 'workflow-ready' })
  assert.equal(deriveNextAction(ready).kind, 'review')
})
