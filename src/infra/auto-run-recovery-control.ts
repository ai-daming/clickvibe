/** Durable allowance consumption/halting, shared by watchdog and failure handling. */
import { commitRecoveryControlCommand, workflowRevision } from './workflow-persistence.ts'
import type { IssueWorkflow, WorkflowEvent } from './state.ts'
export async function consumeRecoveryCooldown(workflow: IssueWorkflow, note: string): Promise<void> {
  const next = structuredClone(workflow.autoRun!)
  if (!next.recoveryBudget || next.recoveryBudget.cooldownUsed || next.recoveryBudget.halted)
    throw new Error('recovery allowance unavailable')
  next.recoveryBudget.cooldownUsed = true
  next.status = 'running'
  next.pausedReason = null
  next.lastObservedAt = new Date().toISOString()
  delete next.controllerRecovery
  const event: WorkflowEvent = { kind: 'auto-run', at: next.lastObservedAt, round: next.rounds, step: next.step, note }
  Object.assign(
    workflow,
    await commitRecoveryControlCommand(workflow, workflowRevision(workflow), {
      expectedRunId: next.recoveryBudget.runId,
      next,
      event,
    }),
  )
}
export async function haltRepeatedFailure(workflow: IssueWorkflow, note: string): Promise<boolean> {
  if (!workflow.autoRun?.recoveryBudget?.cooldownUsed) return false
  const next = structuredClone(workflow.autoRun)
  next.recoveryBudget!.halted = true
  next.status = 'paused'
  next.pausedReason = 'controller-error'
  next.lastObservedAt = new Date().toISOString()
  Object.assign(
    workflow,
    await commitRecoveryControlCommand(workflow, workflowRevision(workflow), {
      expectedRunId: next.recoveryBudget!.runId,
      next,
      event: {
        kind: 'auto-run',
        at: next.lastObservedAt,
        note: `${note}; 自动恢复额度已耗尽，需人工重新授权`,
        round: next.rounds,
        step: next.step,
      },
    }),
  )
  return true
}

/** Finish an already-observed fuse without replaying the failed action or incrementing its count. */
export async function persistControllerFuse(
  workflow: IssueWorkflow,
  recovery: import('./contracts.ts').AutoRunControllerRecovery,
): Promise<void> {
  const next = structuredClone(workflow.autoRun!)
  if (!next.recoveryBudget) throw new Error('recovery allowance unavailable')
  next.controllerRecovery = recovery
  next.status = 'paused'
  next.pausedReason = 'controller-error'
  if (next.recoveryBudget.cooldownUsed) next.recoveryBudget.halted = true
  Object.assign(
    workflow,
    await commitRecoveryControlCommand(workflow, workflowRevision(workflow), {
      expectedRunId: next.recoveryBudget.runId,
      next,
      event: {
        kind: 'auto-run',
        at: new Date().toISOString(),
        note: `同类错误连续 ${recovery.consecutive} 次；fingerprint=${recovery.fingerprint}；${next.recoveryBudget.halted ? '恢复额度耗尽，等待人工重新授权' : '冷却后允许恢复一次'}`,
        round: next.rounds,
        step: next.step,
      },
    }),
  )
}
