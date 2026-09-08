/** A failed fuse checkpoint must be repaired before the controller admits another action. */
import type { Context } from '@deepseek-ai/cordis'
import type { IssueWorkflow } from '../infra/state.ts'
import type { AutoRunControllerRecovery } from '../infra/contracts.ts'
import { persistControllerFuse } from '../infra/auto-run-recovery-control.ts'
import { clearAutoRunSchedule, scheduleAutoRunWakeAt, type AutoRunWake } from '../infra/auto-run-scheduler.ts'
import { logTaskDiagnostic } from '../infra/task-diagnostics.ts'
import { pendingControllerFailure } from './auto-run-recovery.ts'
import { AUTO_RUN_BASE_RETRY_MS, AUTO_RUN_WATCHDOG_COOLDOWN_MS } from './auto-run-recovery-policy.ts'

export async function enforcePendingControllerFuse(
  ctx: Context,
  workflow: IssueWorkflow,
  wake: AutoRunWake,
): Promise<boolean> {
  if (!workflow.autoRun?.recoveryBudget || workflow.autoRun.controllerRecovery?.kind === 'rate-limit') return false
  const pending = pendingControllerFailure(workflow.key)
  let recovery: AutoRunControllerRecovery | undefined =
    workflow.autoRun.controllerRecovery?.kind === 'fused' ? workflow.autoRun.controllerRecovery : undefined
  if (pending?.fused) {
    const failedAt = pending.retryAt - pending.delayMs
    recovery = {
      kind: 'fused',
      attempt: pending.attempt,
      consecutive: pending.consecutive,
      fingerprint: pending.fingerprint,
      retryAt: new Date(failedAt + AUTO_RUN_WATCHDOG_COOLDOWN_MS).toISOString(),
      lastFailureAt: new Date(failedAt).toISOString(),
    }
  }
  if (!recovery) return false
  try {
    await persistControllerFuse(workflow, recovery)
    if (workflow.autoRun.recoveryBudget.halted) clearAutoRunSchedule(workflow.key)
    else
      scheduleAutoRunWakeAt(
        ctx,
        workflow.key,
        Math.min(Date.parse(recovery.retryAt), Date.parse(workflow.autoRun.deadline)),
        wake,
      )
  } catch (error) {
    logTaskDiagnostic('auto-run-pending-fuse', {
      workflowKey: workflow.key,
      runId: workflow.autoRun.recoveryBudget.runId,
      error: error instanceof Error ? error.message : String(error),
    })
    if (Date.now() < Date.parse(workflow.autoRun.deadline))
      scheduleAutoRunWakeAt(ctx, workflow.key, Date.now() + AUTO_RUN_BASE_RETRY_MS, wake)
    else clearAutoRunSchedule(workflow.key)
  }
  return true
}
