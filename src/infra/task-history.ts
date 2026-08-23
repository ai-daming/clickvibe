export interface TaskHistoryWorkflow {
  stage: 'idle' | 'developing' | 'review-ready' | 'reviewing' | 'passed'
  devTaskId: string | null
  reviewTaskId: string | null
  hasReviewResult: boolean
}

function taskStartedAt(taskId: string | null): number {
  const matched = taskId?.match(/^[a-z]+-(\d+)-/)
  return matched ? Number(matched[1]) : 0
}

/** Select the task whose durable log belongs in the panel. */
export function selectHistoryTask(workflow: TaskHistoryWorkflow): {
  taskId: string | null
  expectRunning: boolean
} {
  // A rework deliberately keeps the failed review verdict until development
  // succeeds. Stage therefore outranks that stale verdict while the dev task
  // is running, otherwise refresh would reconnect the old review stream.
  if (workflow.stage === 'developing') {
    return { taskId: workflow.devTaskId, expectRunning: true }
  }
  if (workflow.stage === 'reviewing') {
    return { taskId: workflow.reviewTaskId, expectRunning: true }
  }

  const showReview =
    workflow.stage === 'passed' ||
    workflow.hasReviewResult ||
    taskStartedAt(workflow.reviewTaskId) > taskStartedAt(workflow.devTaskId)
  return {
    taskId: showReview ? workflow.reviewTaskId : workflow.devTaskId,
    expectRunning: false,
  }
}
