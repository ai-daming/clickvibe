import type { WorkflowStorageIdentity } from './state-layout.ts'
/** Worktree preparation is owned by the workflow command domain, not by directory existence. */
import type { IssueWorkflow } from './state.ts'
export interface WorktreePreparation {
  schema: 1
  attemptId: string
  runtimeInstanceId: string
  taskStateRevision: number
  worktree: string
  branch: string
  commonDir: string
  baseRef: string
  baseOid: string
  expectedHead: string
  status: 'prepared' | 'dispatched' | 'settled' | 'verified' | 'blocked'
}
export type PreparationSeed = WorkflowStorageIdentity &
  Pick<IssueWorkflow, 'worktree' | 'branch'> & { taskStateRevision?: number }
export type PreparationPatch = Partial<Pick<IssueWorkflow, 'worktree' | 'branch' | 'baseRef'>> & {
  preparation?: WorktreePreparation
}
export interface PreparationTransaction {
  current(): IssueWorkflow | null
  commit(patch: PreparationPatch): Promise<IssueWorkflow>
  block(record: WorktreePreparation, reason: PreparationBlockReason): Promise<IssueWorkflow>
}
export type PreparationBlockReason =
  | 'git-mismatch'
  | 'dirty-worktree'
  | 'relative-hooks'
  | 'active-hook'
  | 'worktree-conflict'
export class PreparationConflict extends Error {
  readonly reason: PreparationBlockReason
  constructor(reason: PreparationBlockReason) {
    super(
      `${reason === 'worktree-conflict' ? 'worktree 冲突' : 'worktree preparation blocked'}: ${reason}; 保留现场，需人工结算`,
    )
    this.reason = reason
  }
}
export function validPreparation(value: unknown): value is WorktreePreparation {
  if (!value || typeof value !== 'object') return false
  const p = value as WorktreePreparation
  return (
    p.schema === 1 &&
    Number.isSafeInteger(p.taskStateRevision) &&
    p.taskStateRevision >= 0 &&
    ['prepared', 'dispatched', 'settled', 'verified', 'blocked'].includes(p.status) &&
    [p.attemptId, p.runtimeInstanceId, p.worktree, p.branch, p.commonDir, p.baseRef].every(
      (v) => typeof v === 'string' && v.length > 0,
    ) &&
    /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(p.baseOid) &&
    /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(p.expectedHead)
  )
}
export function assertPreparationSettled(workflow: IssueWorkflow): void {
  if (
    workflow.preparation &&
    (!validPreparation(workflow.preparation) ||
      workflow.preparation.status !== 'verified' ||
      workflow.preparation.taskStateRevision !== (workflow.taskStateRevision ?? 0))
  )
    throw new Error('worktree preparation unresolved; preserve the worktree and inspect before retrying')
}
export function applyPreparationPatch(
  current: IssueWorkflow | null,
  seed: IssueWorkflow,
  patch: PreparationPatch,
): IssueWorkflow {
  for (const key of Object.keys(patch))
    if (!['worktree', 'branch', 'baseRef', 'preparation'].includes(key)) throw new Error('invalid preparation patch')
  const existing = current ?? seed
  if (
    patch.preparation &&
    (!validPreparation(patch.preparation) || patch.preparation.taskStateRevision !== (existing.taskStateRevision ?? 0))
  )
    throw new Error('invalid preparation ownership')
  return { ...existing, ...patch }
}
