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
import { isGithubRateLimitError } from './rest.ts'
import { consistencyFromForce, githubRead } from './operations.ts'
import { githubRest } from './rest.ts'

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
  force = false,
): Promise<GithubPrLookup> {
  try {
    const pr = await githubRead<GithubPrFact | null>(ctx, {
      operation: force ? 'gate-pr-fact' : 'pr-fact',
      repoKey,
      ...(prNumber === null || prNumber === undefined ? { branch } : { number: prNumber }),
      includeReviews,
      consistency: consistencyFromForce(force),
    })
    return { known: true, pr }
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
  head?: {
    ref?: string
    /** owner:ref label — survives head-repo deletion when repo becomes null. */
    label?: string
    repo?: { full_name?: string; name?: string; owner?: { login?: string } } | null
  }
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
  return githubRead(ctx, {
    operation: 'repo-snapshot',
    repoKey,
    ttlMs,
    consistency: consistencyFromForce(force),
  })
}

/** The branch-lookup identity for the shared enrichment snapshot: the same
 *  owner:ref the exact per-item query uses (pulls?head=owner:branch). A fork
 *  PR whose head branch merely shares the ref name is a DIFFERENT key (review
 *  r10/F1) — the aggregate must not weaken the identity the old path had. */
export function snapshotPrKey(repoKey: string, branch: string): string {
  return `${repoKey.split('/')[0]}:${branch}`
}

function headOwnerOf(pull: RepositoryPrRest): string | null {
  const head = pull.head
  if (!head?.ref) return null
  return head.repo?.owner?.login ?? head.repo?.full_name?.split('/')[0] ?? head.label?.split(':')[0] ?? null
}

/** The aggregate page size — both the URL parameter and the completeness
 *  proof: a SHORT page (< size) means the server had no more rows, so the
 *  page IS the repo's full PR list; a full-length page proves nothing (review
 *  r11: a first-page miss must never convert "not seen" into "no PR"). */
const ENRICHMENT_PAGE_SIZE = 100

/** Index a repo snapshot for enrichment lookups (pure): issues by number, PRs
 *  by head owner:ref. Same-owner historical duplicates keep the FIRST row —
 *  the lists are created-desc, matching the exact query's per_page=1. */
export function buildEnrichmentIndex(snapshot: RepositoryGithubSnapshot): EnrichmentSnapshot {
  const issueByNumber = new Map<number, RepositoryIssueRest>()
  for (const issue of snapshot.issues ?? []) issueByNumber.set(issue.number, issue)
  const pulls = Array.isArray(snapshot.pulls) ? snapshot.pulls : []
  const prByHeadBranch = new Map<string, RepositoryPrRest>()
  for (const pull of pulls) {
    const owner = headOwnerOf(pull)
    if (owner === null) continue
    const key = `${owner}:${pull.head?.ref}`
    if (!prByHeadBranch.has(key)) prByHeadBranch.set(key, pull)
  }
  // Completeness is a property of the page itself: only a provably complete
  // list may turn a branch miss into proven absence downstream. A missing or
  // non-array pulls list is NOT completeness — fail open to the exact query.
  return {
    issueByNumber,
    prByHeadBranch,
    pullsComplete: Array.isArray(snapshot.pulls) && pulls.length < ENRICHMENT_PAGE_SIZE,
  }
}

/** Per-repo enrichment inputs resolved from ONE shared snapshot per TTL
 *  window (issue #131 review r9: five same-repo items must cost ≤2 aggregate
 *  pages cold and 0 hot — per-item fan-out priced 15 logical requests and
 *  blew the 5s deadlines under pacing). */
export interface EnrichmentSnapshot {
  /** Issue list item by issue number (body included → contract hash). */
  issueByNumber: Map<number, RepositoryIssueRest>
  /** PR by head owner:ref from the state=all pulls list (one page typical). */
  prByHeadBranch: Map<string, RepositoryPrRest>
  /** The pulls page held the repo's ENTIRE PR list (short page ⇒ no
   *  continuation exists) — only then is a branch miss a proven absence. */
  pullsComplete: boolean
}

export async function fetchEnrichmentSnapshot(
  ctx: Context,
  repoKey: string,
  ttlMs: number,
  force = false,
): Promise<EnrichmentSnapshot> {
  const rest = githubRest(ctx)
  // ONE bounded page per list, any state (review r10/F3): the frozen multi
  // population mixes open and closed work items, and a page walk would price
  // continuation pages on repos with long histories. The aggregate is a
  // recent-page cache, not a guarantee of completeness — misses fall back to
  // the exact per-item reads.
  const load = async () => {
    const [issues, pulls] = await Promise.all([
      rest.json<RepositoryIssueRest[]>(
        `repos/${repoKey}/issues?state=all&sort=created&direction=desc&per_page=${ENRICHMENT_PAGE_SIZE}&page=1`,
      ),
      rest.json<RepositoryPrRest[]>(
        `repos/${repoKey}/pulls?state=all&sort=created&direction=desc&per_page=${ENRICHMENT_PAGE_SIZE}&page=1`,
      ),
    ])
    return { issues, pulls } satisfies RepositoryGithubSnapshot
  }
  const snapshot = await rest.cachedAggregate(`enrichment:${repoKey}`, ttlMs, force, load)
  return buildEnrichmentIndex(snapshot)
}

/** Adapt a snapshot PR row into the fact shape derive consumes (no review
 *  decision — callers wanting the live verdict use the number-keyed read). */
export function snapshotPrFact(
  pull: RepositoryPrRest & { head?: { sha?: string }; base?: { ref?: string; sha?: string } },
): GithubPrFact {
  const state = String(pull.state).toUpperCase()
  return {
    number: String(pull.number),
    state: state === 'MERGED' || pull.merged_at ? 'MERGED' : state === 'CLOSED' ? 'CLOSED' : 'OPEN',
    mergedAt: pull.merged_at ?? null,
    headRefName: pull.head?.ref ?? '',
    url: pull.html_url,
    reviewDecision: null,
    headRefOid: pull.head?.sha,
    baseRefName: pull.base?.ref,
    baseRefOid: pull.base?.sha,
  }
}
