/**
 * clickvibe host half — routes:
 * - `/clickvibe/api/fetch`          — fetch GitHub issue/PR data via gh
 * - `/clickvibe/api/command`        — text-command entry (issue #13): conversation
 *                                      triggers reuse the same action handlers below
 * - `/clickvibe/api/state`          — restore panel context (all workflows)
 * - `/clickvibe/api/develop`        — start dev: worktree+branch+agent
 * - `/clickvibe/api/develop/poll`   — incremental dev log/status (JSON)
 * - `/clickvibe/api/history`        — complete disk-backed task history
 * - `/clickvibe/api/stream`         — SSE live status stream for a task
 * - `/clickvibe/api/review`         — review the dev branch with codex/claude
 * - `/clickvibe/api/resume`         — resume an interrupted dev session
 * - `/clickvibe/api/sync`           — sync the worktree with the remote base (issue #5)
 *
 * Workflow per issue (persisted under ~/.clickvibe/state/):
 *   developing → review-ready → reviewing → passed
 *                      ↑                  │
 *                      └── rework ────────┘
 */

import { existsSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { type DeriveOptions, hasMergeConflict, readBranch, readRefShort, readRevCount } from '../infra/git.ts'
import { liveTasks, readWorktreeHead, runCommand } from '../infra/runtime.ts'
import {
  type IssueContractSnapshot,
  type IssueWorkflow,
} from '../infra/state.ts'
import {
  deriveNextAction,
  deriveWorkflowStatus,
  type IssueContractStatus,
  type IssueContractUnknownReason,
  type NextAction,
  type WorkflowFacts,
  workflowBaseBranch,
} from './state-view.ts'

/** Worktree facts derived from git, GitHub and durable workflow events. */
export interface WorkflowDerived {
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
  status: 'idle' | 'developing' | 'review-ready' | 'reviewing' | 'passed'
  baseBranch: string
}

/**
 * Derive the authoritative state of a workflow from git facts + event history
 * (issue #5). Runs on every /state request so the panel never needs a
 * restart/refresh to see current status; the stored `stage`/`reviewResult`
 * stay as-is, and `derived` carries the three-way comparison (worktree /
 * main / remote), the review-verdict HEAD binding and the single next action.
 */
/** Derive the authoritative state of a workflow from git facts + event history.
 *  Exported for integration tests; /state calls it on every request. */
export async function deriveWorkflowState(
  ctx: Context,
  workflow: IssueWorkflow,
  options: DeriveOptions = {},
): Promise<IssueWorkflow & { derived: WorkflowDerived }> {
  const workflowPrNumber = workflow.prNumber == null ? null : String(workflow.prNumber)
  const worktree = workflow.worktree
  const exists = existsSync(worktree)
  const events = workflow.events ?? []
  let lastDevHash: string | null = null
  let lastReviewHash: string | null = null
  let lastReviewContract: IssueContractSnapshot | null = null
  for (const ev of events) {
    if (ev.kind === 'dev' || ev.kind === 'rework') lastDevHash = ev.hash ?? lastDevHash
    if (ev.kind === 'review') {
      lastReviewHash = ev.hash ?? lastReviewHash
      lastReviewContract = ev.issueContract ?? null
    }
  }

  const head = exists ? await readWorktreeHead(ctx, worktree) : null
  const branch = exists ? await readBranch(ctx, worktree) : null
  const hasUncommittedChanges = exists
    ? await runCommand(ctx, 'git status --porcelain', {
        workdir: worktree,
        timeoutMs: 10000,
        sandboxPolicy: { mode: 'read-only', workspaceRoot: worktree },
      })
        .then((output) => output !== '')
        .catch(() => false)
    : false

  let mainHead: string | null = null
  let aheadOfMain = 0
  let behindMain = 0
  let originMainHead: string | null = null
  let aheadOfBase = 0
  let behindBase = 0
  let upstreamHead: string | null = null
  let aheadOfUpstream: number | null = null
  let behindUpstream: number | null = null

  if (exists && head !== null) {
    mainHead = await readRefShort(ctx, worktree, 'main')
    if (mainHead) {
      const compare = await readRevCount(ctx, worktree, 'main', 'HEAD')
      if (compare) {
        behindMain = compare.behind
        aheadOfMain = compare.ahead
      }
    }
    originMainHead = await readRefShort(ctx, worktree, 'origin/main')
    if (originMainHead) {
      const compare = await readRevCount(ctx, worktree, 'origin/main', 'HEAD')
      if (compare) {
        behindBase = compare.behind
        aheadOfBase = compare.ahead
      }
    }
    if (branch) {
      upstreamHead = await readRefShort(ctx, worktree, `origin/${branch}`)
      if (upstreamHead) {
        const compare = await readRevCount(ctx, worktree, `origin/${branch}`, 'HEAD')
        if (compare) {
          behindUpstream = compare.behind
          aheadOfUpstream = compare.ahead
        }
      }
    }
  }

  // 有新提交 = worktree HEAD 不在已记录的任何 dev/rework 事件哈希里
  const hasNewCommits = head !== null && lastDevHash !== null && head !== lastDevHash
  // worktree 落后远端基线(origin/main 或远端同名分支)→ 需要同步
  const needsSync = behindBase > 0 || (behindUpstream ?? 0) > 0
  // 未完成的冲突合并(MERGE_HEAD 存在):sync 只会再次失败,必须由 agent 收拾(issue #26)
  const mergeConflict = exists && (await hasMergeConflict(ctx, worktree))
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
    reviewPassed !== null && head !== null && reviewedHash !== null && head === reviewedHash && issueContractCurrent

  const devLive = workflow.devTaskId ? liveTasks.get(workflow.devTaskId) : undefined
  const reviewLive = workflow.reviewTaskId ? liveTasks.get(workflow.reviewTaskId) : undefined
  const taskRunning = (devLive !== undefined && !devLive.closed) || (reviewLive !== undefined && !reviewLive.closed)

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
  }
  const nextAction = deriveNextAction(facts)
  const baseBranch = workflowBaseBranch(workflow.baseRef, options.defaultBranch ?? 'main')
  const status = deriveWorkflowStatus(facts)

  return {
    ...workflow,
    prNumber: options.pr?.number ?? workflowPrNumber,
    derived: {
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
      nextAction,
      status,
      baseBranch,
    },
  }
}
