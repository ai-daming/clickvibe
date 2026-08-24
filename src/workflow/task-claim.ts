import { finishTask } from '../agent/task-supervisor.ts'
import type { LiveTask } from '../infra/runtime.ts'
import {
  claimWorkflowTask,
  type IssueWorkflow,
  loadWorkflow,
  WorkflowConflictError,
  type WorkflowTaskClaim,
  workflowRevision,
} from '../infra/state.ts'

export type TaskClaimResult =
  | { ok: true; claimed: true; taskId: string }
  | { ok: true; claimed: false; taskId: string }
  | { ok: false; error: string }

/** Commit one complete generation or settle this controller's losing reservation. */
export async function establishTaskClaim(
  workflow: IssueWorkflow,
  live: LiveTask,
  claim: WorkflowTaskClaim,
): Promise<TaskClaimResult> {
  try {
    await claimWorkflowTask(workflow, claim, workflowRevision(workflow))
    return { ok: true, claimed: true, taskId: claim.taskId }
  } catch (error) {
    finishTask(live, 'stopped', null)
    if (error instanceof WorkflowConflictError) {
      const current = await loadWorkflow(workflow.key)
      const currentTaskId = claim.kind === 'dev' ? current?.devTaskId : current?.reviewTaskId
      const currentStage = claim.kind === 'dev' ? 'developing' : 'reviewing'
      if (current?.stage === currentStage && currentTaskId) {
        return { ok: true, claimed: false, taskId: currentTaskId }
      }
    }
    return { ok: false, error: String(error instanceof Error ? error.message : error) }
  }
}
