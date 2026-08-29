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
import { frozenBaseHash } from '../agent/baseline.ts'
import type { WorktreeGitFacts } from '../infra/contracts.ts'
import { type DeriveOptions, hasMergeConflict, readBranch, readRefShort, readRevCount } from '../infra/git.ts'
import { liveTasks, readWorktreeHead, runCommand } from '../infra/runtime.ts'
import type { IssueWorkflow } from '../infra/state.ts'
import { observeTaskOwnership, type TaskOwnershipContext } from '../infra/task-ownership.ts'
import { deriveWorkflowStateFromFacts, type WorkflowDerived } from './derive-from-facts.ts'
import { workflowBaseBranch } from './state-view.ts'

export type { WorkflowDerived } from './derive-from-facts.ts'

/**
 * Legacy per-fact sampling of one worktree's local git state. Kept as the
 * equivalence baseline for the compound Local Git Sampler and as the default
 * path when no observation is injected (issue #122). Pure I/O: exactly one
 * git command per fact, the same commands and order as before the snapshot.
 */
export async function sampleWorktreeFactsLegacy(
  ctx: Context,
  worktree: string,
  baseBranch: string,
  frozenBase: string | null,
): Promise<WorktreeGitFacts> {
  const exists = existsSync(worktree)
  const remoteBaseRef = `origin/${baseBranch}`
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
    originMainHead = await readRefShort(ctx, worktree, remoteBaseRef)
    const baseCompareRef = originMainHead ? remoteBaseRef : frozenBase
    if (baseCompareRef) {
      const compare = await readRevCount(ctx, worktree, baseCompareRef, 'HEAD')
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

  const mergeConflict = exists && (await hasMergeConflict(ctx, worktree))

  return {
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
  }
}

/**
 * Derive the authoritative state of a workflow from git facts + event history
 * (issue #5). Exported for integration tests; /state calls it on every request.
 * This is the I/O half (issue #122): sample local git and task ownership, then
 * delegate to the pure deriveWorkflowStateFromFacts. The Local Git Snapshot
 * will feed the same WorktreeGitFacts without re-running these commands within
 * one refresh generation.
 */
export async function deriveWorkflowState(
  ctx: Context,
  workflow: IssueWorkflow,
  options: DeriveOptions = {},
): Promise<IssueWorkflow & { runStartedAt: number | null; derived: WorkflowDerived }> {
  const baseBranch = workflowBaseBranch(workflow.baseRef, options.defaultBranch ?? 'main')
  const gitFacts =
    options.gitFacts ??
    (await sampleWorktreeFactsLegacy(ctx, workflow.worktree, baseBranch, frozenBaseHash(workflow.baseRef)))

  const ownership = observeTaskOwnership(
    ctx as unknown as TaskOwnershipContext,
    workflow,
    (taskId) => {
      const task = liveTasks.get(taskId)
      return task !== undefined && !task.closed
    },
    (taskId) => liveTasks.get(taskId)?.startedAt ?? null,
  )

  return deriveWorkflowStateFromFacts(workflow, gitFacts, ownership, options)
}
