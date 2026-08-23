/** Plain-data contracts shared by adapters and upper-layer workflows. */
export type AgentKind = 'codex' | 'claude'

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
  rounds: number
  unresolved: AutoRunUnresolvedRound[]
  lastObservedAt: string | null
  pausedReason: AutoRunPausedReason | null
}

export function isAutoRunState(value: unknown): value is AutoRunState {
  if (value === undefined) return true
  if (!value || typeof value !== 'object') return false
  const state = value as Partial<AutoRunState>
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
    Array.isArray(state.unresolved)
  )
}
