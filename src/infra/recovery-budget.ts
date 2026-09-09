/** Protected automatic-run control: ordinary metadata cannot mint or replenish an allowance. */
import { isDeepStrictEqual } from 'node:util'
import type { AutoRunState, ContractAuthorizationBinding } from './contracts.ts'
import type { IssueWorkflow, WorkflowEvent } from './state.ts'
export interface RecoveryBudget {
  schema: 1
  runId: string
  cooldownUsed: boolean
  halted: boolean
}
export function isRecoveryBudget(value: unknown): value is RecoveryBudget {
  if (!value || typeof value !== 'object') return false
  const b = value as RecoveryBudget
  return (
    b.schema === 1 &&
    typeof b.runId === 'string' &&
    b.runId.length > 0 &&
    typeof b.cooldownUsed === 'boolean' &&
    typeof b.halted === 'boolean'
  )
}
export function assertMetadataBudgetUnchanged(current: IssueWorkflow | null, patch: { autoRun?: AutoRunState }): void {
  if ('autoRun' in patch && !isDeepStrictEqual(current?.autoRun?.recoveryBudget, patch.autoRun?.recoveryBudget))
    throw new Error('recovery budget is protected from metadata writes')
}
export interface RecoveryControlChange {
  expectedRunId: string | null
  next: AutoRunState
  event?: WorkflowEvent
  authorization?: ContractAuthorizationBinding
}
export function applyRecoveryControl(current: IssueWorkflow, change: RecoveryControlChange): IssueWorkflow {
  const previous = current.autoRun?.recoveryBudget
  const next = change.next.recoveryBudget
  if ((previous?.runId ?? null) !== change.expectedRunId || !isRecoveryBudget(next))
    throw new Error('recovery budget ownership lost')
  if (change.authorization) {
    if (
      !isDeepStrictEqual(change.authorization, change.next.contract) ||
      next.runId === previous?.runId ||
      next.cooldownUsed ||
      next.halted
    )
      throw new Error('invalid new-run recovery authorization')
  } else {
    if (
      !isRecoveryBudget(previous) ||
      previous.runId !== next.runId ||
      (previous.cooldownUsed && !next.cooldownUsed) ||
      (previous.halted && (!next.halted || change.next.status === 'running'))
    )
      throw new Error('recovery budget cannot be reset without new authorization')
  }
  return {
    ...current,
    autoRun: structuredClone(change.next),
    events: change.event ? [...current.events, change.event] : current.events,
  }
}

/** A captured run id is permission for that run only; manual actions do not carry it. */
export function automaticRunId(payload: { autoRunId?: unknown }): string | undefined {
  if (payload.autoRunId === undefined) return undefined
  if (typeof payload.autoRunId !== 'string' || !payload.autoRunId) throw new Error('invalid automatic run id')
  return payload.autoRunId
}
export function assertAutomaticRunAdmission(workflow: IssueWorkflow | null, runId: unknown, now: number): void {
  if (runId === undefined) return
  const run = workflow?.autoRun
  if (
    typeof runId !== 'string' ||
    !run ||
    !isRecoveryBudget(run.recoveryBudget) ||
    run.recoveryBudget.runId !== runId ||
    run.recoveryBudget.halted ||
    run.status !== 'running' ||
    !Number.isFinite(Date.parse(run.deadline)) ||
    now >= Date.parse(run.deadline)
  )
    throw new Error('automatic run no longer admits this action')
}
