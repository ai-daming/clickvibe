import type { LiveTask } from '../infra/runtime.ts'
import { mutateWorkflowTaskCommand, type WorkflowTaskCommitResult } from '../infra/workflow-persistence.ts'
import type { IssueWorkflow } from '../infra/state.ts'

type TaskMutationResult = Exclude<WorkflowTaskCommitResult, { status: 'revision-conflict' }>

/**
 * Submit one callback command with the lease frozen on this LiveTask. The
 * workflow-wide command domain serializes it with claims, stops and ordinary
 * writes; a persisted reload never refreshes the capability.
 */
export function mutateLiveTaskWorkflow(
  live: LiveTask,
  workflow: IssueWorkflow,
  mutate: (current: IssueWorkflow) => void,
): Promise<TaskMutationResult> {
  const lease = live.workflowLease
  if (!lease) return Promise.reject(new Error(`task ${live.taskId} has no workflow lease`))
  return mutateWorkflowTaskCommand(workflow, lease, mutate).then((result) => {
    if (result.status === 'committed') live.workflowLease = result.lease
    return result
  })
}
