/**
 * Pure derivation of one workflow's panel state from already-sampled facts
 * (issue #122). Same inputs always produce the same output: no shell, fs,
 * network, clock or process handles here. `deriveWorkflowState` samples local
 * git and task ownership, then delegates; the Local Git Snapshot feeds the
 * same WorktreeGitFacts without re-running git.
 */

import type { DeriveOptions } from '../infra/git.ts'
import type { TaskOwnership } from '../infra/task-ownership.ts'
import { type IssueContractSnapshot, type IssueWorkflow } from '../infra/state.ts'
import { type WorktreeGitFacts } from '../infra/contracts.ts'
import { latestDevelopmentHash } from './delivery-audit.ts'
import { deriveFreshSessionAvailability, type FreshSessionAvailability } from './fresh-session.ts'
import {
  deriveNextAction,
  deriveReviewStartDecision,
  deriveWorkflowStatus,
  type IssueContractStatus,
  type IssueContractUnknownReason,
  type NextAction,
  type ReviewStartDecision,
  type WorkflowFacts,
  type WorkflowStatus,
  workflowBaseBranch,
} from './state-view.ts'

/** Worktree facts derived from git, GitHub and durable workflow events. */
export interface WorkflowDerived {
  taskRef: { kind: 'dev' | 'review'; taskId: string } | null
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
  mergeConflict: boolean
  branchExists: boolean
  worktreeExists: boolean
  worktreeValid: boolean
  hasUncommittedChanges: boolean
  hasCommits: boolean
  lastDevHash: string | null
  lastReviewHash: string | null
  reviewedHash: string | null
  reviewedIssueBodyHash: string | null
  currentIssueBodyHash: string | null
  reviewedIssueUpdatedAt: string | null
  currentIssueUpdatedAt: string | null
  issueContractCurrent: boolean
  issueContractStatus: IssueContractStatus
  issueContractUnknownReason: IssueContractUnknownReason
  hasNewCommits: boolean
  verdictCurrent: boolean
  nextAction: NextAction
  reviewStart: ReviewStartDecision
  status: WorkflowStatus
  baseBranch: string
  /** False when the frozen origin/<base> ref no longer exists after fetch. */
  baseRefAvailable: boolean
  freshSession: FreshSessionAvailability
}

export type { WorktreeGitFacts } from '../infra/contracts.ts'

/**
 * Derive the authoritative state of a workflow from git facts + event history
 * (issue #5). Pure: consumes a WorktreeGitFacts observation and a task
 * ownership verdict instead of touching git or the live-task registry.
 */
export function deriveWorkflowStateFromFacts(
  workflow: IssueWorkflow,
  gitFacts: WorktreeGitFacts,
  ownership: TaskOwnership,
  options: DeriveOptions = {},
): IssueWorkflow & { runStartedAt: number | null; derived: WorkflowDerived } {
  const {
    exists,
    head,
    branch,
    hasUncommittedChanges,
    mainHead,
    aheadOfMain,
    behindMain,
    originMainHead,
    aheadOfBase,
    behindBase,
    upstreamHead,
    aheadOfUpstream,
    behindUpstream,
    mergeConflict,
  } = gitFacts
  const workflowPrNumber = workflow.prNumber == null ? null : String(workflow.prNumber)
  const baseBranch = workflowBaseBranch(workflow.baseRef, options.defaultBranch ?? 'main')
  const events = workflow.events ?? []
  const lastDevHash = latestDevelopmentHash(events) ?? null
  let lastReviewHash: string | null = null
  let lastReviewContract: IssueContractSnapshot | null = null
  let lastReviewBase: { ref: string; sha: string } | null = null
  for (const ev of events) {
    if (ev.kind === 'review') {
      lastReviewHash = ev.hash ?? lastReviewHash
      lastReviewContract = ev.issueContract ?? null
      lastReviewBase = ev.reviewBase ?? null
    }
  }

  // 有新提交 = worktree HEAD 不等于最近一次 dev/rework/resume 交付哈希
  const hasNewCommits = head !== null && lastDevHash !== null && head !== lastDevHash
  // worktree 落后其冻结的远端基线或远端同名分支 → 需要同步。
  const needsSync = behindBase > 0 || (behindUpstream ?? 0) > 0
  const githubReviewPassed =
    options.pr?.reviewDecision === 'APPROVED' ? true : options.pr?.reviewDecision === 'CHANGES_REQUESTED' ? false : null
  const reviewPassed = workflow.reviewResult?.passed ?? githubReviewPassed
  const reviewedHash = lastReviewHash ?? (githubReviewPassed !== null ? head : null)
  const currentIssueContract = options.issueContract ?? null
  // updatedAt 是审计证据；正文 hash 才是契约身份，避免评论/标签更新误杀结论。
  const issueContractStatus: IssueContractStatus =
    lastReviewContract === null
      ? 'unknown'
      : currentIssueContract === null
        ? 'unknown'
        : lastReviewContract.bodyHash === currentIssueContract.bodyHash
          ? 'current'
          : 'changed'
  const issueContractUnknownReason: IssueContractUnknownReason =
    issueContractStatus !== 'unknown'
      ? null
      : lastReviewContract === null
        ? 'missing-review-snapshot'
        : 'current-contract-unavailable'
  const issueContractCurrent = issueContractStatus === 'current'
  // 结论同时绑定当前 HEAD 与验收契约；旧事件缺契约快照时 fail closed。
  const verdictCurrent =
    reviewPassed !== null &&
    head !== null &&
    reviewedHash !== null &&
    head === reviewedHash &&
    issueContractCurrent &&
    (!options.pr?.baseRefName ||
      !options.pr?.baseRefOid ||
      (lastReviewBase?.ref === options.pr.baseRefName && lastReviewBase.sha === options.pr.baseRefOid))

  const taskRunning = ownership.state === 'running'
  const taskKind = ownership.state === 'running' ? ownership.kind : null
  const taskInterrupted =
    ownership.state === 'interrupted' || (workflow.stage === 'developing' && workflow.devInterrupted)
  const taskUnknown = !taskInterrupted && ownership.state === 'unknown'

  const branchExists = options.branchExists ?? branch !== null
  const worktreeValid = !exists || branch === workflow.branch
  const hasCommits = options.hasCommits ?? aheadOfBase > 0
  const facts: WorkflowFacts = {
    issueOpen: (workflow.issueState ?? 'OPEN') !== 'CLOSED',
    prMerged:
      workflow.delivery !== undefined ||
      options.pr?.state === 'MERGED' ||
      (options.pr?.mergedAt !== null && options.pr?.mergedAt !== undefined),
    cleanupPending: workflow.delivery !== undefined && workflow.delivery.status !== 'archived',
    prState: options.pr?.state ?? null,
    prStatusKnown: options.prStatusKnown,
    prNumber: options.pr?.number ?? workflowPrNumber,
    stage: workflow.stage,
    devInterrupted: workflow.devInterrupted,
    taskRunning,
    taskKind,
    taskUnknown,
    taskInterrupted,
    head,
    reviewedHash,
    reviewPassed,
    issueContractStatus,
    issueContractUnknownReason,
    hasNewCommits,
    needsSync,
    mergeConflict,
    branchExists,
    worktreeExists: exists,
    worktreeValid,
    hasUncommittedChanges,
    hasCommits,
    hasResumeSession: workflow.devSessionId !== null,
    baseBranch,
    baseRefAvailable: originMainHead !== null,
    workflowCachePresent: options.workflowCachePresent,
    // The live PR head is the newest GitHub delivery fact. During completion
    // persistence it can legitimately advance before the local event cache.
    deliveryHash: options.pr?.headRefOid ?? lastDevHash,
  }
  const reviewStart = deriveReviewStartDecision(facts)
  const nextAction = deriveNextAction(facts)
  const status = deriveWorkflowStatus(facts)
  const freshSession = deriveFreshSessionAvailability(
    events,
    workflow.devSessionId !== null && workflow.devSessionAgent === workflow.devAgent,
    workflow.reviewSessionId !== null && workflow.reviewSessionAgent === workflow.reviewAgent,
  )

  return {
    ...workflow,
    prNumber: options.pr?.number ?? workflowPrNumber,
    runStartedAt: ownership.state === 'running' ? ownership.startedAt : null,
    derived: {
      taskRef: ownership.state === 'none' ? null : { kind: ownership.kind, taskId: ownership.taskId },
      head,
      branch,
      mainHead,
      originMainHead,
      upstreamHead,
      aheadOfMain,
      behindMain,
      aheadOfBase,
      behindBase,
      aheadOfUpstream,
      behindUpstream,
      needsSync,
      mergeConflict,
      branchExists,
      worktreeExists: exists,
      worktreeValid,
      hasUncommittedChanges,
      hasCommits,
      lastDevHash,
      lastReviewHash,
      reviewedHash,
      reviewedIssueBodyHash: lastReviewContract?.bodyHash ?? null,
      currentIssueBodyHash: currentIssueContract?.bodyHash ?? null,
      reviewedIssueUpdatedAt: lastReviewContract?.updatedAt ?? null,
      currentIssueUpdatedAt: currentIssueContract?.updatedAt ?? null,
      issueContractCurrent,
      issueContractStatus,
      issueContractUnknownReason,
      hasNewCommits,
      verdictCurrent,
      reviewStart,
      nextAction,
      status,
      baseBranch,
      baseRefAvailable: originMainHead !== null,
      freshSession,
    },
  }
}
