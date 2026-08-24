import { finishTask } from '../agent/task-supervisor.ts'
import type { LiveTask } from '../infra/runtime.ts'
import { claimWorkflowTask, type IssueWorkflow, type WorkflowTaskClaim, workflowRevision } from '../infra/state.ts'

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
    let expectedRevision = workflowRevision(workflow)
    while (true) {
      const result = await claimWorkflowTask(workflow, claim, expectedRevision)
      if (result.status === 'committed') return { ok: true, claimed: true, taskId: claim.taskId }
      if (result.status === 'revision-conflict') {
        expectedRevision = result.currentRevision
        continue
      }
      finishTask(live, 'stopped', null)
      return result.currentTask
        ? { ok: true, claimed: false, taskId: result.currentTask.taskId }
        : { ok: false, error: 'workflow task ownership disappeared while claiming' }
    }
  } catch (error) {
    finishTask(live, 'stopped', null)
    return { ok: false, error: String(error instanceof Error ? error.message : error) }
  }
}
