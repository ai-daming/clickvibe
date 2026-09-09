import { assertAutomaticRunAdmission } from './recovery-budget.ts'
/** Existing Git actions participate in the same durable command domain as preparation. */
import { withWorkflowLock } from './workflow-lock.ts'
import {
  withBaselineRestoreWorkflowLocksCommand,
  type BaselineRestoreWorkflowTransaction,
} from './workflow-persistence.ts'
import { appendEvent, commitWorkflowMetadata, loadWorkflow, type IssueWorkflow, type WorkflowEvent } from './state.ts'
import { parseIssueKey } from './state-layout.ts'
import { assertPreparationSettled } from './preparation-record.ts'
import type { RemoteGitWriteAttempt } from './remote-git-coordinator.ts'
export type WorkflowActionTransaction = BaselineRestoreWorkflowTransaction
export async function withWorkflowAction<T>(
  key: string,
  run: (tx: WorkflowActionTransaction) => Promise<T>,
  autoRunId?: unknown,
): Promise<T | { ok: false; error: string }> {
  const parsed = parseIssueKey(key)
  if (!parsed) return { ok: false, error: 'invalid workflow key' }
  const identity = {
    key,
    repoKey: `${parsed.owner}/${parsed.repo}`,
    url: `https://github.com/${parsed.owner}/${parsed.repo}/issues/${parsed.issue}`,
  }
  try {
    return await withWorkflowLock(key, () =>
      withBaselineRestoreWorkflowLocksCommand([identity], async (tx) => {
        const current = await loadWorkflow(key)
        assertAutomaticRunAdmission(current, autoRunId, Date.now())
        if (current) assertPreparationSettled(current)
        return run(tx)
      }),
    )
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
export function actionPersistence(tx: WorkflowActionTransaction) {
  const metadata: typeof commitWorkflowMetadata = (identity, _revision, patch) => tx.commitMetadata(identity, patch)
  const event: typeof appendEvent = async (workflow, entry, _revision) => {
    const events = [...(workflow.events ?? []), entry]
    Object.assign(
      workflow,
      await metadata(workflow, null, {
        worktree: workflow.worktree,
        branch: workflow.branch,
        prNumber: workflow.prNumber,
        issueState: workflow.issueState,
        baseRef: workflow.baseRef,
        delivery: workflow.delivery,
        autoRun: workflow.autoRun,
        events,
        remoteGitAttempts: workflow.remoteGitAttempts,
      }),
    )
  }
  const attempt = async (
    workflow: IssueWorkflow,
    kind: 'sync' | 'pr-push' | 'baseline-restore',
    value: RemoteGitWriteAttempt,
  ) => {
    const current = await loadWorkflow(workflow.key)
    if (!current) throw new Error('workflow disappeared')
    Object.assign(
      workflow,
      await metadata(current, null, { remoteGitAttempts: { ...current.remoteGitAttempts, [kind]: value } }),
    )
    return workflow
  }
  return { commitWorkflowMetadata: metadata, appendEvent: event, persistRemoteGitAttempt: attempt }
}
