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
import { shellQuote } from '../infra/develop-core.ts'
import { type ClickVibeConfig, expandHome, parseUrl, runCommand } from '../infra/runtime.ts'
import { type IssueWorkflow } from '../infra/state.ts'
import type { IssueContractCheck } from '../infra/contracts.ts'
import {
  fetchIssueRestDetail,
  fetchPrRestDetail,
  fetchPrRestReviews,
  type GithubPrDetailRest,
  type GithubPrFact,
} from './reads.ts'
import { deriveReviewDecision, githubRest, isGithubRateLimitError } from './rest.ts'

export interface GithubPrLookup {
  known: boolean
  pr: GithubPrFact | null
}

export async function fetchGithubPrFact(
  ctx: Context,
  repoKey: string,
  branch: string,
  prNumber: string | number | null,
  includeReviews = true,
): Promise<GithubPrLookup> {
  const hasPrNumber = prNumber !== null && prNumber !== undefined
  try {
    const rest = githubRest(ctx)
    let raw: GithubPrDetailRest | undefined
    if (hasPrNumber) {
      raw = await fetchPrRestDetail(ctx, repoKey, String(prNumber), false, 5_000)
    } else {
      const owner = repoKey.split('/')[0]
      raw = await rest.cachedResource(
        `${repoKey}/pulls/head/${branch}`,
        null,
        async () =>
          (
            await rest.json<GithubPrDetailRest[]>(
              `repos/${repoKey}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=1`,
              undefined,
              5_000,
            )
          )[0],
      )
    }
    if (!raw) return { known: true, pr: null }
    rest.rememberVersion(`${repoKey}/pulls/${raw.number}`, raw.updated_at)
    // lists 之外的回源刷新默认带 reviews 推导 reviewDecision;已有本地 verdict 时
    // 跳过,省掉一轮 pulls/{n}/reviews 请求(列表路径由调用方按需传入)。
    const reviews = includeReviews ? await fetchPrRestReviews(ctx, repoKey, raw.number, 5_000) : []
    return {
      known: true,
      pr: {
        number: String(raw.number),
        state: raw.merged_at ? 'MERGED' : String(raw.state).toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN',
        mergedAt: raw.merged_at ?? null,
        headRefName: String(raw.head?.ref ?? branch),
        url: String(raw.html_url ?? `https://github.com/${repoKey}/pull/${raw.number}`),
        reviewDecision: deriveReviewDecision(reviews),
        headRefOid: raw.head?.sha ? String(raw.head.sha) : undefined,
        baseRefName: raw.base?.ref ? String(raw.base.ref) : undefined,
        baseRefOid: raw.base?.sha ? String(raw.base.sha) : undefined,
      },
    }
  } catch (error) {
    if (isGithubRateLimitError(error)) throw error
    return { known: false, pr: null }
  }
}

export async function fetchGithubIssueState(ctx: Context, url: string): Promise<'OPEN' | 'CLOSED' | null> {
  try {
    const parsed = parseUrl(url)
    if (!parsed || parsed.kind !== 'issue') return null
    const issue = await fetchIssueRestDetail(ctx, `${parsed.owner}/${parsed.repo}`, parsed.number, false, 5_000)
    return String(issue.state).toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN'
  } catch (error) {
    if (isGithubRateLimitError(error)) throw error
    return null
  }
}

export async function readConfiguredBranchFacts(
  ctx: Context,
  config: ClickVibeConfig,
  workflow: IssueWorkflow,
  baseBranch?: string,
): Promise<{ branchExists?: boolean; hasCommits?: boolean; defaultBranch?: string }> {
  const configuredPath = config.repos[workflow.repoKey]
  if (!configuredPath) return {}
  const repoPath = expandHome(configuredPath)
  if (!existsSync(repoPath)) return {}
  const policy = { mode: 'read-only' as const, workspaceRoot: repoPath }
  const localRef = `refs/heads/${workflow.branch}`
  const remoteRef = `refs/remotes/origin/${workflow.branch}`
  const branchRef = await runCommand(
    ctx,
    `if git show-ref --verify --quiet ${shellQuote(localRef)}; then printf %s ${shellQuote(workflow.branch)}; elif git show-ref --verify --quiet ${shellQuote(remoteRef)}; then printf %s ${shellQuote(`origin/${workflow.branch}`)}; else exit 1; fi`,
    { workdir: repoPath, timeoutMs: 3000, sandboxPolicy: policy },
  ).catch(() => '')
  const defaultRef = await runCommand(ctx, 'git symbolic-ref --quiet --short refs/remotes/origin/HEAD', {
    workdir: repoPath,
    timeoutMs: 3000,
    sandboxPolicy: policy,
  }).catch(() => '')
  if (!branchRef) return { branchExists: false, defaultBranch: defaultRef.replace(/^origin\//, '') || undefined }
  const baseRef = baseBranch ? `origin/${baseBranch}` : defaultRef || 'origin/main'
  const hasCommits = await runCommand(ctx, `git rev-list --count ${shellQuote(baseRef)}..${shellQuote(branchRef)}`, {
    workdir: repoPath,
    timeoutMs: 3000,
    sandboxPolicy: policy,
  })
    .then((count) => Number(count) > 0)
    .catch(() => false)
  return { branchExists: true, hasCommits, defaultBranch: defaultRef.replace(/^origin\//, '') || undefined }
}

/** Enrich every stored workflow concurrently; parallel GitHub reads cost at most one 5s window. */
export interface RepositoryIssueItem {
  number: number
  title: string
  state: string
  body: string
  url: string
  updatedAt?: string
  labels?: { name: string; color?: string }[]
  milestone?: { title: string; number?: number } | null
  contract: IssueContractCheck
}

export interface RepositoryIssueRest {
  number: number
  title: string
  state: string
  body: string | null
  html_url: string
  updated_at?: string
  labels?: { name: string; color?: string }[]
  milestone?: { title: string; number?: number } | null
  pull_request?: unknown
}

export interface RepositoryPrRest {
  number: number
  state: string
  merged_at: string | null
  updated_at?: string
  html_url: string
  head?: { ref?: string }
}

export interface RepositoryGithubSnapshot {
  issues: RepositoryIssueRest[]
  pulls: RepositoryPrRest[]
}

export interface IssueCommentRest {
  body?: string | null
}

export async function fetchGithubRepoSnapshot(
  ctx: Context,
  repoKey: string,
  ttlMs: number,
  force: boolean,
): Promise<RepositoryGithubSnapshot> {
  const rest = githubRest(ctx)
  return rest.cachedAggregate(`repo:${repoKey}`, ttlMs, force, async () => {
    const [issues, pulls] = await Promise.all([
      rest.paginate<RepositoryIssueRest>(`repos/${repoKey}/issues?state=all`),
      rest.paginate<RepositoryPrRest>(`repos/${repoKey}/pulls?state=all`),
    ])
    return { issues, pulls }
  })
}
