/** New recovery/preparation commands share the existing persistence engine and its lock. */
import type { IssueWorkflow } from './state.ts'
import type { WorkflowStorageIdentity } from './state-layout.ts'
import { applyRecoveryControl, type RecoveryControlChange } from './recovery-budget.ts'
import { applyWorkflowMetadataPatch } from './workflow-metadata.ts'
import { applyPreparationPatch, type PreparationSeed, type PreparationTransaction } from './preparation-record.ts'

type Within = <T>(
  identity: WorkflowStorageIdentity,
  operation: (
    current: IssueWorkflow | null,
    commit: (next: IssueWorkflow, revoke?: boolean) => Promise<IssueWorkflow>,
  ) => Promise<T>,
) => Promise<T>
export function createWorkflowRecoveryCommands(within: Within, conflict: (revision: number | null) => Error) {
  return {
    stopWorkflowPreparationCommand(seed: PreparationSeed): Promise<IssueWorkflow> {
      return within(seed, async (current, commit) => {
        if ((current?.taskStateRevision ?? 0) !== (seed.taskStateRevision ?? 0))
          throw new Error('preparation stop ownership lost')
        const next = structuredClone(
          current ?? applyWorkflowMetadataPatch(seed, null, { worktree: seed.worktree, branch: seed.branch }),
        )
        next.devInterrupted = true
        if (next.autoRun) {
          next.autoRun.status = 'paused'
          next.autoRun.pausedReason = 'session-interrupted'
        }
        if (!current) next.taskStateRevision = 1
        return commit(next, true)
      })
    },
    commitRecoveryControlCommand(
      identity: WorkflowStorageIdentity,
      expectedRevision: number | null,
      change: RecoveryControlChange,
    ): Promise<IssueWorkflow> {
      return within(identity, async (current, commit) => {
        if (!current || current.revision !== expectedRevision) throw conflict(current?.revision ?? null)
        return commit(applyRecoveryControl(current, change))
      })
    },
    withWorkflowPreparationCommand<T>(
      seed: PreparationSeed,
      run: (tx: PreparationTransaction) => Promise<T>,
    ): Promise<T> {
      return within(seed, async (current, commit) => {
        let active = true,
          writing = false
        const initial = applyWorkflowMetadataPatch(seed, null, {
          worktree: seed.worktree,
          branch: seed.branch,
          baseRef: null,
        })
        try {
          return await run({
            current: () => (current ? structuredClone(current) : null),
            block: async (record, reason) => {
              if (!active || writing) throw new Error('preparation transaction expired or busy')
              if (
                !['git-mismatch', 'dirty-worktree', 'relative-hooks', 'active-hook', 'worktree-conflict'].includes(
                  reason,
                )
              )
                throw new Error('invalid preparation block reason')
              writing = true
              try {
                const next = applyPreparationPatch(current, initial, { preparation: { ...record, status: 'blocked' } })
                next.events = [
                  ...next.events,
                  {
                    kind: 'note',
                    at: new Date().toISOString(),
                    note: `worktree preparation ${record.attemptId} blocked: ${reason}; 保留现场，需人工结算`,
                  },
                ]
                current = await commit(next)
                return structuredClone(current)
              } finally {
                writing = false
              }
            },
            commit: async (patch) => {
              if (!active || writing) throw new Error('preparation transaction expired or busy')
              writing = true
              try {
                current = await commit(applyPreparationPatch(current, initial, patch))
                return structuredClone(current)
              } finally {
                writing = false
              }
            },
          })
        } finally {
          active = false
        }
      })
    },
  }
}
