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
import { type ClickVibeConfig, loadConfig } from '../infra/runtime.ts'
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

export async function enrichWorkflowStates(
  ctx: Context,
  workflows: IssueWorkflow[],
  configOverride?: ClickVibeConfig,
): Promise<Array<IssueWorkflow & { derived: WorkflowDerived }>> {
  const config = configOverride ?? (await loadConfig())
  return Promise.all(
    workflows.map(async (workflow) => {
      const [prLookup, branchFacts, currentIssue, liveIssueState] = await Promise.all([
        fetchGithubPrFact(ctx, workflow.repoKey, workflow.branch, workflow.prNumber),
        readConfiguredBranchFacts(
          ctx,
          config,
          workflow,
          workflow.baseRef ? workflowBaseBranch(workflow.baseRef) : undefined,
        ),
        fetchIssueContract(ctx, workflow.url).catch(() => null),
        fetchGithubIssueState(ctx, workflow.url),
      ])
      return deriveWorkflowState(
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
          ...branchFacts,
        },
      )
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
    const comments = await rest.paginate<IssueCommentRest>(`repos/${repoKey}/issues/${issue.number}/comments`)
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
