import assert from 'node:assert/strict'
import test from 'node:test'
import { selectHistoryTask } from '../src/infra/task-history.ts'

test('a developing rework always restores the dev stream despite the failed review verdict', () => {
  assert.deepEqual(selectHistoryTask({
    stage: 'developing',
    devTaskId: 'dev-200-new',
    reviewTaskId: 'review-100-old',
    hasReviewResult: true,
  }), {
    taskId: 'dev-200-new',
    expectRunning: true,
  })
})

test('reviewing restores review while settled workflows show their latest relevant task', () => {
  assert.deepEqual(selectHistoryTask({
    stage: 'reviewing', devTaskId: 'dev-100-old', reviewTaskId: 'review-200-new', hasReviewResult: false,
  }), { taskId: 'review-200-new', expectRunning: true })
  assert.deepEqual(selectHistoryTask({
    stage: 'review-ready', devTaskId: 'dev-300-new', reviewTaskId: 'review-200-old', hasReviewResult: false,
  }), { taskId: 'dev-300-new', expectRunning: false })
  assert.deepEqual(selectHistoryTask({
    stage: 'review-ready', devTaskId: 'dev-100-old', reviewTaskId: 'review-200-new', hasReviewResult: true,
  }), { taskId: 'review-200-new', expectRunning: false })
})
