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

import type { Context } from '@deepseek-ai/cordis'
import {
  fetchGithubIssueState,
  fetchGithubPrFact,
  type IssueCommentRest,
  type RepositoryIssueItem,
  type RepositoryIssueRest,
  readConfiguredBranchFacts,
} from '../github/facts.ts'
import { githubErrorMessage, githubRest } from '../github/rest.ts'
import { githubRead } from '../github/operations.ts'
import { existsSync } from 'node:fs'
import { type ClickVibeConfig, loadConfig } from '../infra/runtime.ts'
import { observeTaskOwnership, type TaskOwnershipContext } from '../infra/task-ownership.ts'
import type { WorktreeSample } from '../infra/local-git-sampler.ts'
import { type IssueWorkflow } from '../infra/state.ts'
import {
  buildDependencyUnlockComment,
  DependencyLedgerRetryGate,
  dependencyUnlockMarker,
  hasWorkflowDevelopmentHistory,
  isFirstDevelopment,
  rewriteCompletedDependencySection,
} from './auto-development.ts'
import { deriveWorkflowState, type WorkflowDerived } from './derive.ts'
import { checkIssueContract } from './issue-contract.ts'
import { fetchIssueContract } from './merge-gates.ts'
import { workflowBaseBranch } from './state-view.ts'
import { logTaskDiagnostic } from '../infra/task-diagnostics.ts'
import type { ClickVibeConfigV1 } from '../infra/contracts.ts'
import { frozenBaseHash } from '../agent/baseline.ts'
import {
  type LocalGitSnapshotReader,
  type ObservationAttemptEvidence,
  resolveConfiguredRepoPath,
} from '../infra/local-git-snapshot.ts'

/** Derive the observation outcome for one workflow's worktree (issue #122). */
async function observeWorktreeFor(
  ctx: Context,
  observation: LocalGitSnapshotReader,
  config: ClickVibeConfig,
  workflow: IssueWorkflow,
): Promise<
  | { ok: true; sample: WorktreeSample; observedAt: number }
  | { ok: false; attempts: ObservationAttemptEvidence[]; error: Error }
> {
  // Mirror the legacy existsSync gate: a missing worktree yields the all-null
  // facts without invoking git at all, and branch facts still come from the
  // configured checkout.
  if (!existsSync(workflow.worktree)) {
    const branchFacts = await readConfiguredBranchFacts(
      ctx,
      config,
      workflow,
      workflow.baseRef ? workflowBaseBranch(workflow.baseRef) : undefined,
    )
    return {
      ok: true,
      sample: {
        gitFacts: {
          exists: false,
          head: null,
          branch: null,
          hasUncommittedChanges: false,
          mainHead: null,
          aheadOfMain: 0,
          behindMain: 0,
          originMainHead: null,
          aheadOfBase: 0,
          behindBase: 0,
          upstreamHead: null,
          aheadOfUpstream: null,
          behindUpstream: null,
          mergeConflict: false,
        },
        branchFacts,
      },
      observedAt: Date.now(),
    }
  }
  const outcome = await observation.observeWorktree(ctx, workflow.repoKey, {
    worktree: workflow.worktree,
    branch: workflow.branch,
    baseBranch: workflowBaseBranch(workflow.baseRef),
    baseBranchNeedsDefault: workflowBaseBranch(workflow.baseRef, '') === '',
    frozenBase: frozenBaseHash(workflow.baseRef),
    repoPath: resolveConfiguredRepoPath(config, workflow.repoKey),
  })
  if (!outcome.ok) return outcome
  return {
    ok: true,
    sample: outcome.envelope.sample,
    observedAt: outcome.envelope.observedAt,
  }
}

export async function enrichWorkflowStates(
  ctx: Context,
  workflows: IssueWorkflow[],
  configOverride?: ClickVibeConfig,
  observation?: LocalGitSnapshotReader,
): Promise<
  Array<
    | (IssueWorkflow & {
        runStartedAt: number | null
        derived: WorkflowDerived
      })
    | (IssueWorkflow & {
        runStartedAt: null
        derived: null
        observation: { freshness: 'unknown'; error: string }
      })
  >
> {
  const config = configOverride ?? (await loadConfig())
  return Promise.all(
    workflows.map(async (workflow) => {
      const attempt = observation ? await observeWorktreeFor(ctx, observation, config, workflow) : null
      if (attempt !== null && !attempt.ok) {
        // Legacy parity: GitHub-side failures — notably rate limits — surface
        // even when the local snapshot is unavailable, so callers (auto-run
        // reconcile) keep their rate-limit deferral semantics. Task ownership
        // (ctx.jobs) is part of that observation surface.
        observeTaskOwnership(
          ctx as unknown as TaskOwnershipContext,
          workflow,
          () => false,
          () => null,
        )
        await Promise.all([
          fetchGithubPrFact(ctx, workflow.repoKey, workflow.branch, workflow.prNumber),
          fetchGithubIssueState(ctx, workflow.url),
        ])
        // issue #122 Q2: a failed snapshot must not degrade into legacy
        // per-fact reads that render "clean" from a failure. Fail closed:
        // no derived state, an explicit unknown observation, raw diagnostics.
        const reason = `本地 Git 快照采样失败（已重试一次）: ${attempt.error.message}`
        logTaskDiagnostic('local-git-snapshot-sample-failed', {
          workflowKey: workflow.key,
          repoKey: workflow.repoKey,
          worktree: workflow.worktree,
          attempts: attempt.attempts,
        })
        const row: IssueWorkflow & {
          runStartedAt: null
          derived: null
          observation: { freshness: 'unknown'; error: string }
        } = {
          ...workflow,
          runStartedAt: null,
          derived: null,
          observation: { freshness: 'unknown' as const, error: reason },
        }
        // Keep the original failure reachable (错误不埋葬): auto-run reconcile
        // rethrows it so controller-failure fingerprints stay stable.
        Object.defineProperty(row, 'localGitSampleCause', {
          value: attempt.error,
          enumerable: false,
        })
        return row
      }
      const sample = attempt && attempt.ok ? attempt.sample : null
      const branchFacts = sample
        ? sample.branchFacts
        : await readConfiguredBranchFacts(
            ctx,
            config,
            workflow,
            workflow.baseRef ? workflowBaseBranch(workflow.baseRef) : undefined,
          )
      const [prLookup, currentIssue, liveIssueState] = await Promise.all([
        fetchGithubPrFact(ctx, workflow.repoKey, workflow.branch, workflow.prNumber),
        fetchIssueContract(ctx, workflow.url).catch(() => null),
        fetchGithubIssueState(ctx, workflow.url),
      ])
      const enriched = await deriveWorkflowState(
        ctx,
        {
          ...workflow,
          issueState:
            liveIssueState ??
            (currentIssue?.state === 'OPEN' || currentIssue?.state === 'CLOSED'
              ? currentIssue.state
              : workflow.issueState),
        },
        {
          pr: prLookup.pr,
          prStatusKnown: workflow.prNumber ? prLookup.known && prLookup.pr !== null : prLookup.known,
          issueContract: currentIssue?.contract ?? null,
          gitFacts: sample?.gitFacts,
          ...branchFacts,
        },
      )
      return { ...enriched, observedAt: attempt && attempt.ok ? attempt.observedAt : 0 }
    }),
  )
}

export const dependencyLedgerRetryGate = new DependencyLedgerRetryGate()

export function firstDevelopmentFor(
  persisted: IssueWorkflow | null | undefined,
  current: IssueWorkflow & { derived: WorkflowDerived },
): boolean {
  return isFirstDevelopment({
    workflowHasDevelopmentHistory: hasWorkflowDevelopmentHistory(persisted),
    hasCommits: current.derived.hasCommits,
    hasUncommittedChanges: current.derived.hasUncommittedChanges,
    hasPr: current.prNumber !== null,
    worktreeNeedsRepair: current.derived.worktreeExists && !current.derived.worktreeValid,
  })
}

export async function maintainCompletedDependencyLedger(
  ctx: Context,
  repoKey: string,
  issue: RepositoryIssueItem,
  dependencyNumbers: number[],
): Promise<{ issue: RepositoryIssueItem; updated: boolean; error?: string }> {
  if (dependencyNumbers.length === 0) return { issue, updated: false }
  const retryKey = `${repoKey}#${issue.number}`
  const blocked = dependencyLedgerRetryGate.blocked(retryKey)
  if (blocked) {
    return {
      issue,
      updated: false,
      error: `依赖账本更新冷却至 ${new Date(blocked.retryAt).toISOString()}: ${blocked.error}`,
    }
  }
  const rest = githubRest(ctx)
  const marker = dependencyUnlockMarker(dependencyNumbers)
  try {
    const comments = (await githubRead(ctx, {
      operation: 'issue-comments',
      repoKey,
      number: issue.number,
      consistency: 'cache-ok',
    })) as IssueCommentRest[]
    if (!comments.some((comment) => String(comment.body ?? '').includes(marker))) {
      await rest.mutate(`repos/${repoKey}/issues/${issue.number}/comments`, 'POST', {
        body: buildDependencyUnlockComment({
          issueNumber: issue.number,
          dependencyNumbers,
          at: new Date().toISOString(),
        }),
      })
    }
    const body = rewriteCompletedDependencySection(issue.body, dependencyNumbers)
    if (body === issue.body) {
      dependencyLedgerRetryGate.succeed(retryKey)
      return { issue, updated: false }
    }
    const updated = await rest.mutate<RepositoryIssueRest>(`repos/${repoKey}/issues/${issue.number}`, 'PATCH', { body })
    rest.invalidate(`repo:${repoKey}`)
    rest.invalidate(`${repoKey}/issues/${issue.number}`)
    dependencyLedgerRetryGate.succeed(retryKey)
    return {
      issue: {
        ...issue,
        body,
        updatedAt: updated.updated_at ?? issue.updatedAt,
        contract: checkIssueContract(body),
      },
      updated: true,
    }
  } catch (error) {
    const detail = githubErrorMessage(error).slice(0, 500)
    const failure = dependencyLedgerRetryGate.fail(retryKey, detail)
    return {
      issue,
      updated: false,
      error: `依赖账本更新失败;冷却至 ${new Date(failure.retryAt).toISOString()}: ${detail}`,
    }
  }
}
