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
import { deriveReviewDecision } from './rest.ts'
import { consistencyFromForce, githubRead } from './operations.ts'

export interface GithubPrFact {
  number: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  mergedAt: string | null
  headRefName: string
  url: string
  reviewDecision: string | null
  headRefOid?: string
  baseRefName?: string
  baseRefOid?: string
}

export interface GithubUserRest {
  login?: string
}

export interface GithubLabelRest {
  name?: string
  color?: string
}

export interface GithubMilestoneRest {
  title?: string
  number?: number
}

export interface GithubCommentRest {
  user?: GithubUserRest | null
  body?: string | null
  created_at?: string
  updated_at?: string
}

export interface GithubReviewRest {
  id?: number
  user?: GithubUserRest | null
  body?: string | null
  state?: string
  submitted_at?: string | null
}

export interface GithubIssueDetailRest {
  number: number
  title: string
  state: string
  state_reason?: string | null
  user?: GithubUserRest | null
  created_at?: string
  updated_at?: string
  closed_at?: string | null
  body?: string | null
  html_url: string
  labels?: GithubLabelRest[]
  assignees?: GithubUserRest[]
  milestone?: GithubMilestoneRest | null
}

export interface GithubPrDetailRest extends GithubIssueDetailRest {
  merged_at?: string | null
  additions?: number
  deletions?: number
  changed_files?: number
  commits?: number
  draft?: boolean
  mergeable?: boolean | null
  mergeable_state?: string
  base?: { ref?: string; sha?: string }
  head?: { ref?: string; sha?: string }
}

export function mapComments(
  comments: GithubCommentRest[],
): Array<{ author: { login: string }; createdAt: string; updatedAt: string; body: string }> {
  return comments.map((comment) => ({
    author: { login: String(comment.user?.login ?? 'unknown') },
    createdAt: String(comment.created_at ?? ''),
    updatedAt: String(comment.updated_at ?? ''),
    body: String(comment.body ?? ''),
  }))
}

export function mapIssueDetail(issue: GithubIssueDetailRest, comments: GithubCommentRest[]): Record<string, unknown> {
  return {
    number: issue.number,
    title: issue.title,
    state: String(issue.state).toUpperCase(),
    stateReason: issue.state_reason ?? null,
    author: { login: String(issue.user?.login ?? 'unknown') },
    createdAt: issue.created_at ?? '',
    updatedAt: issue.updated_at ?? '',
    closedAt: issue.closed_at ?? null,
    body: issue.body ?? '',
    url: issue.html_url,
    labels: (issue.labels ?? []).map((label) => ({ name: String(label.name ?? ''), color: label.color })),
    assignees: (issue.assignees ?? []).map((user) => ({ login: String(user.login ?? '') })),
    milestone: issue.milestone ? { title: String(issue.milestone.title ?? ''), number: issue.milestone.number } : null,
    comments: mapComments(comments),
    reactionGroups: [],
    isPinned: false,
  }
}

export function mapPrDetail(
  pr: GithubPrDetailRest,
  comments: GithubCommentRest[],
  reviews: GithubReviewRest[],
  requested: { users?: GithubUserRest[]; teams?: Array<{ name?: string; slug?: string }> },
): Record<string, unknown> {
  return {
    ...mapIssueDetail(pr, comments),
    state: pr.merged_at ? 'MERGED' : String(pr.state).toUpperCase(),
    mergedAt: pr.merged_at ?? null,
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    changedFiles: pr.changed_files ?? 0,
    commits: Array.from({ length: Math.max(0, pr.commits ?? 0) }, () => ({})),
    isDraft: pr.draft ?? false,
    mergeable:
      pr.mergeable === null || pr.mergeable === undefined ? 'UNKNOWN' : pr.mergeable ? 'MERGEABLE' : 'CONFLICTING',
    mergeStateStatus: String(pr.mergeable_state ?? 'unknown').toUpperCase(),
    baseRefName: String(pr.base?.ref ?? ''),
    headRefName: String(pr.head?.ref ?? ''),
    reviews: reviews.map((review) => ({
      author: { login: String(review.user?.login ?? 'unknown') },
      body: String(review.body ?? ''),
      state: String(review.state ?? '').toUpperCase(),
      submittedAt: review.submitted_at ?? null,
    })),
    reviewRequests: [
      ...(requested.users ?? []).map((user) => ({ login: String(user.login ?? '') })),
      ...(requested.teams ?? []).map((team) => ({ name: String(team.name ?? team.slug ?? '') })),
    ],
    reviewDecision: deriveReviewDecision(reviews),
  }
}

export async function fetchPrRestDetail(
  ctx: Context,
  repoKey: string,
  number: string | number,
  force = false,
  timeoutMs?: number,
): Promise<GithubPrDetailRest> {
  return githubRead(ctx, {
    operation: 'pr-detail',
    repoKey,
    number,
    consistency: consistencyFromForce(force),
    timeoutMs,
  })
}

export async function fetchPrRestReviews(
  ctx: Context,
  repoKey: string,
  number: string | number,
  timeoutMs?: number,
): Promise<GithubReviewRest[]> {
  return githubRead(ctx, {
    operation: 'pr-reviews',
    repoKey,
    number,
    consistency: 'cache-ok',
    timeoutMs,
  })
}

export async function fetchIssueRestDetail(
  ctx: Context,
  repoKey: string,
  number: string | number,
  force = false,
  timeoutMs?: number,
): Promise<GithubIssueDetailRest> {
  return githubRead(ctx, {
    operation: 'issue-detail',
    repoKey,
    number,
    consistency: consistencyFromForce(force),
    timeoutMs,
  })
}
