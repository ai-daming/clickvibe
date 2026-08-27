/** Plain-data contracts shared by adapters and upper-layer workflows. */
export type AgentKind = 'codex' | 'claude'

/** Provider-neutral identity of one external work item. */
export interface WorkItemIdentity {
  provider: string
  instance: string
  container: string
  id: string
}

export interface ProjectContainerIdentity {
  provider: string
  instance: string
  id: string
}

/** Machine-local binding between one provider container and one real Git clone. */
export interface ProjectBinding {
  schemaVersion: 1
  bindingId: string
  container: ProjectContainerIdentity
  repository: {
    repositoryId: string
    localPath: string
    primaryRemote: string
  }
}

export interface ClickVibeConfigV1 {
  schemaVersion: 1
  worktreeRoot: string
  fetchTtlSeconds?: number
  diagnosticsMaxBytes?: number
  projectBindings: ProjectBinding[]
}

export interface PromptSnapshot {
  url: string
  title: string
  body: string
  state: string
  updatedAt: string
  comments: { author: string; body: string }[]
}

export interface DeliveryPublication {
  target: 'pr' | 'issue'
  status: 'posted' | 'failed'
  url?: string
  error?: string
}

export interface DeliveryCommit {
  hash: string
  subject: string
}

export interface DeliveryDiffstat {
  path: string
  /** Binary files have no meaningful line count. */
  insertions: number | null
  deletions: number | null
}

/** Immutable git facts for one delivery generation. */
export interface DeliveryStats {
  commits: DeliveryCommit[]
  filesChanged: number
  insertions: number
  deletions: number
  diffstat: DeliveryDiffstat[]
}

export interface IssueContractCheck {
  ok: boolean
  missing: string[]
}

export type AutoRunPausedReason =
  | 'session-interrupted'
  | 'controller-error'
  | 'authorization-denied'
  | 'sync-conflict'
  | 'merge-gate-rejected'
  | 'cleanup-failed'
  | 'task-timeout'
  | 'budget-exhausted'
  | 'rounds-exhausted'

export interface AutoRunUnresolvedRound {
  /** Auto-run-local review number; a restart begins again at one. */
  round: number
  issues: string[]
}

export interface AutoRunControllerRecovery {
  kind: 'transient' | 'rate-limit' | 'fused'
  attempt: number
  consecutive: number
  fingerprint: string
  retryAt: string
  lastFailureAt: string
}

/** Durable enhancement only; absence always means manual workflow mode. */
export interface AutoRunState {
  status: 'running' | 'paused' | 'completed'
  autoMerge: boolean
  devAgent: AgentKind
  reviewAgent: AgentKind
  maxRounds: number
  budgetHours: number
  startedAt: string
  deadline: string
  /** 本次自动跑已触发的自动动作数(每次推进一步:启动开发/恢复/Review/合并等)。旧状态缺失时按 0 起算。 */
  step: number
  /** 本次自动跑已完成的 Review 判定数:轮次上限(maxRounds)基于此计数。 */
  rounds: number
  unresolved: AutoRunUnresolvedRound[]
  lastObservedAt: string | null
  pausedReason: AutoRunPausedReason | null
  /** Durable scheduler checkpoint; git/GitHub facts remain the workflow truth. */
  controllerRecovery?: AutoRunControllerRecovery
}

export function isAutoRunState(value: unknown): value is AutoRunState {
  if (value === undefined) return true
  if (!value || typeof value !== 'object') return false
  const state = value as Partial<AutoRunState>
  const recovery = state.controllerRecovery
  const validRecovery =
    recovery === undefined ||
    (typeof recovery === 'object' &&
      recovery !== null &&
      (recovery.kind === 'transient' || recovery.kind === 'rate-limit' || recovery.kind === 'fused') &&
      Number.isInteger(recovery.attempt) &&
      recovery.attempt > 0 &&
      Number.isInteger(recovery.consecutive) &&
      recovery.consecutive > 0 &&
      typeof recovery.fingerprint === 'string' &&
      typeof recovery.retryAt === 'string' &&
      typeof recovery.lastFailureAt === 'string')
  return (
    (state.status === 'running' || state.status === 'paused' || state.status === 'completed') &&
    (state.devAgent === 'codex' || state.devAgent === 'claude') &&
    (state.reviewAgent === 'codex' || state.reviewAgent === 'claude') &&
    Number.isInteger(state.maxRounds) &&
    Number(state.maxRounds) > 0 &&
    Number.isFinite(state.budgetHours) &&
    Number(state.budgetHours) > 0 &&
    typeof state.startedAt === 'string' &&
    typeof state.deadline === 'string' &&
    Array.isArray(state.unresolved) &&
    validRecovery
  )
}
