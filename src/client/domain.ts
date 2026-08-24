import { type DeliveryPublication, workflowStatusLabel } from './runtime.ts'
import { type Dependencies, type Dependency, type GhIssue, type TimelineEvent } from './views/issue-view.tsx'

export async function apiCall<T>(method: string, body: Record<string, unknown>, timeoutMs?: number): Promise<T> {
  const controller = timeoutMs === undefined ? null : new AbortController()
  const timeout = controller ? window.setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    const response = await fetch(`/clickvibe/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-clickvibe-request': '1' },
      body: JSON.stringify(body),
      ...(controller ? { signal: controller.signal } : {}),
    })
    return response.json() as Promise<T>
  } finally {
    if (timeout !== null) window.clearTimeout(timeout)
  }
}

export interface Workflow {
  key: string
  url: string
  repoKey: string
  worktree: string
  branch: string
  stage: 'idle' | 'developing' | 'review-ready' | 'reviewing' | 'passed'
  devAgent: 'codex' | 'claude' | null
  devTaskId: string | null
  devSessionId: string | null
  devSessionAgent: 'codex' | 'claude' | null
  devInterrupted: boolean
  reviewAgent: 'codex' | 'claude' | null
  reviewTaskId: string | null
  reviewSessionId: string | null
  reviewSessionAgent: 'codex' | 'claude' | null
  reviewResult: { passed: boolean; issues: string[]; commentUrl?: string } | null
  prNumber: string | null
  issueState?: 'OPEN' | 'CLOSED'
  baseRef: string | null
  /** Present only while this host process still owns the active task. */
  runStartedAt: number | null
  delivery?: {
    status: 'merged' | 'cleanup-pending' | 'archived'
    mergedAt: string
    prHead: string
    mergeStrategy: 'merge'
    cleanup: { worktree: boolean; localBranch: boolean; remoteBranch: boolean; issue: boolean }
    lastError?: string
  }
  autoRun?: {
    status: 'running' | 'paused' | 'completed'
    autoMerge: boolean
    devAgent: 'codex' | 'claude'
    reviewAgent: 'codex' | 'claude'
    maxRounds: number
    budgetHours: number
    startedAt: string
    deadline: string
    /** 本次自动跑已触发的自动动作数;旧状态缺失按 0 起算。 */
    step?: number
    rounds: number
    unresolved: { round: number; issues: string[] }[]
    lastObservedAt: string | null
    pausedReason:
      | 'session-interrupted'
      | 'authorization-denied'
      | 'sync-conflict'
      | 'merge-gate-rejected'
      | 'cleanup-failed'
      | 'task-timeout'
      | 'budget-exhausted'
      | 'rounds-exhausted'
      | null
  }
  updatedAt: number
  events?: WorkflowEvent[]
  derived?: {
    head: string | null
    branch: string | null
    mainHead: string | null
    originMainHead: string | null
    upstreamHead: string | null
    aheadOfMain: number
    behindMain: number
    aheadOfBase: number
    behindBase: number
    aheadOfUpstream: number | null
    behindUpstream: number | null
    needsSync: boolean
    mergeConflict?: boolean
    lastDevHash: string | null
    lastReviewHash: string | null
    reviewedHash: string | null
    reviewedIssueBodyHash: string | null
    currentIssueBodyHash: string | null
    reviewedIssueUpdatedAt: string | null
    currentIssueUpdatedAt: string | null
    issueContractCurrent: boolean
    issueContractStatus: 'current' | 'changed' | 'unknown'
    issueContractUnknownReason: 'missing-review-snapshot' | 'current-contract-unavailable' | null
    hasNewCommits: boolean
    verdictCurrent: boolean
    nextAction: NextAction
    status: WorkflowStatus
    baseBranch: string
    freshSession: { round: number; develop: boolean; review: boolean }
  }
}

export type WorkflowStatus = Workflow['stage'] | 'interrupted'

export type NextActionKind =
  | 'develop'
  | 'resume'
  | 'sync'
  | 'create-pr'
  | 'review'
  | 'rework'
  | 'merge'
  | 'cleanup'
  | 'none'

export interface NextAction {
  kind: NextActionKind
  label: string
  hint: string
}

export interface WorkflowEvent {
  kind: 'dev' | 'review' | 'rework' | 'resume' | 'note' | 'merge-override' | 'auto-run'
  at: string
  durationMs?: number
  hash?: string
  round?: number
  /** 仅 auto-run 事件:本次自动跑已推进的步数(自动动作数);缺失表示旧事件。 */
  step?: number
  agent?: 'codex' | 'claude'
  stats?: {
    commits: { hash: string; subject: string }[]
    filesChanged: number
    insertions: number
    deletions: number
    diffstat: { path: string; insertions: number | null; deletions: number | null }[]
  }
  taskId?: string
  verdict?: { passed: boolean; issues: string[] }
  issueContract?: { bodyHash: string; updatedAt: string }
  fixed?: number
  /** 用户附加说明(issue #54):动作触发时填写,只进本地时间线。 */
  userContext?: string
  publication?: DeliveryPublication
  note?: string
  /** 人工放行审计(仅 merge-override 事件)。 */
  skipped?: string[]
  skippedLabels?: string[]
  reason?: string
  operator?: string
}

/** ClickVibe 自身合并门禁失败项(服务端下发,issue #49 人工放行用)。 */
export interface MergeGateFailure {
  key: string
  message: string
}

/** 放行原因长度上限,与服务端 MERGE_OVERRIDE_REASON_MAX 保持一致(仅本地提示用)。 */
export const OVERRIDE_REASON_MAX = 500

export function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

export function stageLabel(stage: WorkflowStatus, workflow: Workflow | null): string {
  return workflowStatusLabel(
    stage,
    workflow?.reviewResult?.passed ?? null,
    workflow?.derived?.verdictCurrent,
    workflow?.derived?.issueContractStatus,
    workflow?.derived?.issueContractUnknownReason,
  )
}

export type FetchIssueResponse =
  | {
      ok: true
      data: { kind: 'issue' | 'pr'; item: unknown; timeline?: TimelineEvent[]; dependencies?: Dependencies }
      dependencyError?: string
    }
  | { ok: false; error: string }

export async function fetchIssue(url: string, timeoutMs?: number, forceRefresh = false): Promise<FetchIssueResponse> {
  const controller = timeoutMs === undefined ? null : new AbortController()
  const timeout = controller ? window.setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    const response = await fetch('/clickvibe/api/fetch', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-clickvibe-request': '1' },
      body: JSON.stringify({ url, forceRefresh }),
      ...(controller ? { signal: controller.signal } : {}),
    })
    return response.json() as Promise<FetchIssueResponse>
  } finally {
    if (timeout !== null) window.clearTimeout(timeout)
  }
}

export interface ProjectOption {
  repoKey: string
  path: string
  available: boolean
  /** false only for a DSH workspace that is not yet in config.yaml repos. */
  configured?: boolean
}

export interface RepositoryIssue extends GhIssue {
  blockedBy: Dependency[]
  workflow: Workflow
  contract?: { ok: boolean; missing: string[] }
  autoDevelopment?: { ready: boolean; status: string; reason: string }
  dependencyLedger?: { updated: boolean; error?: string }
}

export interface RepositoryFreshness {
  stale: boolean
  refreshed: boolean
  refreshing: boolean
  lastAttemptAt: number
  lastSuccessAt: number | null
  repositoryCount?: number
  successfulRepositoryCount?: number
  partial?: boolean
  error?: string
}

export interface RepositoryAdvanceSignal {
  defaultBranch: string
  remoteRef: string
  mainBehind: number | null
  checkoutBranch: string | null
  checkoutBehind: number | null
  fetchedAt: number | null
}

export type WorkflowStateResponse =
  | {
      ok: true
      workflows: Workflow[]
      freshness: RepositoryFreshness | null
      dependenciesRefreshDue: boolean
      repoAdvance: RepositoryAdvanceSignal | null
    }
  | { ok: false; error: string }
