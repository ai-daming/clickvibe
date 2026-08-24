import type { LiveTask } from '../infra/runtime.ts'
import { type IssueWorkflow, mutateWorkflowForTask, type WorkflowTaskCommitResult } from '../infra/state.ts'

type TaskMutationResult = Exclude<WorkflowTaskCommitResult, { status: 'revision-conflict' }>

const taskMutationQueues = new WeakMap<LiveTask, Promise<void>>()

/**
 * Serialize one live owner's lifecycle writes and forward only the lease
 * returned by its own successful commit. Persisted workflow reloads never
 * refresh this capability.
 */
export function mutateLiveTaskWorkflow(
  live: LiveTask,
  workflow: IssueWorkflow,
  mutate: (current: IssueWorkflow) => void,
): Promise<TaskMutationResult> {
  const previous = taskMutationQueues.get(live) ?? Promise.resolve()
  const operation = previous
    .catch(() => undefined)
    .then(async () => {
      const lease = live.workflowLease
      if (!lease) throw new Error(`task ${live.taskId} has no workflow lease`)
      const result = await mutateWorkflowForTask(workflow, lease, mutate)
      if (result.status === 'committed') live.workflowLease = result.lease
      return result
    })
  taskMutationQueues.set(
    live,
    operation.then(
      () => undefined,
      () => undefined,
    ),
  )
  return operation
}
