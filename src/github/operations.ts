/**
 * Typed GitHub read operations (issue #131 slice A, ADR-0010 §2).
 *
 * Every Controller-owned GitHub read family is declared ONCE here with its
 * policy (effect, consistency floor, joinability) and its executor. Executors
 * are the verbatim reader calls the call sites performed at the coding
 * baseline — same cache keys, TTLs, versions and force semantics — so routing
 * the legacy wrappers through this registry is behavior-preserving.
 *
 * Callers declare a consistency; policy only tightens (`upstream-confirmed`
 * wins over `cache-ok`), which maps to the reader's force flag today. The
 * gate families carry the strongest floor so a merge/contract gate can never
 * be relaxed into a cache answer. Priority, deadline and cost admission join
 * in later commits together with the owner scheduler that consumes them
 * (concept budget: no unconsumed fields).
 */

import type { Context } from '@deepseek-ai/cordis'
import { fetchTtlMs, loadConfig } from '../infra/runtime.ts'
import { fetchTimeline } from './dependencies.ts'
import {
  type GithubCommentRest,
  type GithubIssueDetailRest,
  type GithubPrDetailRest,
  type GithubPrFact,
  type GithubReviewRest,
  mapIssueDetail,
  mapPrDetail,
} from './reads.ts'
import { deriveReviewDecision, githubRest } from './rest.ts'

export type GithubReadConsistency = 'cache-ok' | 'upstream-confirmed'

export type GithubReadOperationId =
  | 'pr-detail'
  | 'pr-by-head'
  | 'pr-reviews'
  | 'issue-detail'
  | 'contract-issue-detail'
  | 'pr-fact'
  | 'gate-pr-fact'
  | 'pr-panel'
  | 'issue-panel'
  | 'issue-comments'
  | 'pr-comments'
  | 'pr-requested-reviewers'
  | 'issue-timeline'
  | 'repo-snapshot'

/** One declared read. Fields are per-operation; each executor documents its own. */
export interface GithubReadIntent {
  operation: GithubReadOperationId
  repoKey: string
  consistency: GithubReadConsistency
  /** Issue/PR number for the number-keyed families. */
  number?: string | number
  /** Branch for the by-head PR lookup family. */
  branch?: string
  /** Include reviews when deriving the PR fact's reviewDecision. */
  includeReviews?: boolean
  /** Aggregate TTL for the repository snapshot family. */
  ttlMs?: number
  /** Per-request timeout handed to the reader, as the legacy call sites did. */
  timeoutMs?: number
}

export interface GithubReadPolicy {
  effect: 'read'
  consistencyFloor: GithubReadConsistency
  joinable: boolean
  execute(ctx: Context, intent: GithubReadIntent, force: boolean): Promise<unknown>
}

function consistencyRank(value: GithubReadConsistency): number {
  return value === 'upstream-confirmed' ? 1 : 0
}

/** Declare the consistency for a legacy boolean `force` parameter. */
export function consistencyFromForce(force: boolean): GithubReadConsistency {
  return force ? 'upstream-confirmed' : 'cache-ok'
}

async function loadPrDetail(ctx: Context, intent: GithubReadIntent, force: boolean): Promise<GithubPrDetailRest> {
  const rest = githubRest(ctx)
  const key = `${intent.repoKey}/pulls/${intent.number}`
  return rest.cachedResource(
    key,
    rest.resourceVersion(key),
    () => rest.json<GithubPrDetailRest>(`repos/${intent.repoKey}/pulls/${intent.number}`, undefined, intent.timeoutMs),
    {
      force,
      versionOf: (pr) => pr.updated_at,
    },
  )
}

async function loadIssueDetail(ctx: Context, intent: GithubReadIntent, force: boolean): Promise<GithubIssueDetailRest> {
  const rest = githubRest(ctx)
  const key = `${intent.repoKey}/issues/${intent.number}`
  return rest.cachedResource(
    key,
    rest.resourceVersion(key),
    () =>
      rest.json<GithubIssueDetailRest>(`repos/${intent.repoKey}/issues/${intent.number}`, undefined, intent.timeoutMs),
    {
      force,
      versionOf: (issue) => issue.updated_at,
    },
  )
}

async function loadPrFact(ctx: Context, intent: GithubReadIntent, force: boolean): Promise<GithubPrFact | null> {
  const hasPrNumber = intent.number !== null && intent.number !== undefined
  const rest = githubRest(ctx)
  let raw: GithubPrDetailRest | undefined
  if (hasPrNumber) {
    raw = await loadPrDetail(ctx, intent, force)
  } else {
    const owner = intent.repoKey.split('/')[0]
    raw = await rest.cachedResource(
      `${intent.repoKey}/pulls/head/${intent.branch}`,
      null,
      async () =>
        (
          await rest.json<GithubPrDetailRest[]>(
            `repos/${intent.repoKey}/pulls?state=all&head=${encodeURIComponent(`${owner}:${intent.branch}`)}&per_page=1`,
            undefined,
            5_000,
          )
        )[0],
      { force },
    )
  }
  if (!raw) return null
  rest.rememberVersion(`${intent.repoKey}/pulls/${raw.number}`, raw.updated_at)
  // lists 之外的回源刷新默认带 reviews 推导 reviewDecision;已有本地 verdict 时
  // 跳过,省掉一轮 pulls/{n}/reviews 请求(列表路径由调用方按需传入)。
  const reviews = intent.includeReviews
    ? await githubRead(ctx, {
        operation: 'pr-reviews',
        repoKey: intent.repoKey,
        number: raw.number,
        consistency: 'cache-ok',
        timeoutMs: 5_000,
      })
    : []
  return {
    number: String(raw.number),
    state: raw.merged_at ? 'MERGED' : String(raw.state).toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN',
    mergedAt: raw.merged_at ?? null,
    headRefName: String(raw.head?.ref ?? intent.branch ?? ''),
    url: String(raw.html_url ?? `https://github.com/${intent.repoKey}/pull/${raw.number}`),
    reviewDecision: deriveReviewDecision(reviews as GithubReviewRest[]),
    headRefOid: raw.head?.sha ? String(raw.head.sha) : undefined,
    baseRefName: raw.base?.ref ? String(raw.base.ref) : undefined,
    baseRefOid: raw.base?.sha ? String(raw.base.sha) : undefined,
  }
}

async function loadPanel(ctx: Context, intent: GithubReadIntent, force: boolean, isPR: boolean): Promise<unknown> {
  const rest = githubRest(ctx)
  const resourceKey = `${intent.repoKey}/${isPR ? 'pulls' : 'issues'}/${intent.number}`
  const panelCacheKey = `${resourceKey}/panel`
  const number = String(intent.number)
  return rest.cachedResource(
    panelCacheKey,
    rest.resourceVersion(resourceKey),
    async () => {
      if (isPR) {
        const pr = (await githubRead(ctx, {
          operation: 'pr-detail',
          repoKey: intent.repoKey,
          number,
          consistency: force ? 'upstream-confirmed' : 'cache-ok',
          timeoutMs: 20_000,
        })) as GithubPrDetailRest
        const [comments, reviews, requested] = await Promise.all([
          githubRead(ctx, {
            operation: 'issue-comments',
            repoKey: intent.repoKey,
            number,
            consistency: 'cache-ok',
            timeoutMs: 20_000,
          }),
          githubRead(ctx, {
            operation: 'pr-reviews',
            repoKey: intent.repoKey,
            number,
            consistency: 'cache-ok',
            timeoutMs: 20_000,
          }),
          githubRead(ctx, {
            operation: 'pr-requested-reviewers',
            repoKey: intent.repoKey,
            number,
            consistency: 'cache-ok',
            timeoutMs: 20_000,
          }),
        ])
        return {
          item: mapPrDetail(
            pr,
            comments as GithubCommentRest[],
            reviews as GithubReviewRest[],
            requested as {
              users?: Array<{ login?: string }>
              teams?: Array<{ name?: string; slug?: string }>
            },
          ),
          updatedAt: pr.updated_at ?? '',
        }
      }
      const issue = (await githubRead(ctx, {
        operation: 'issue-detail',
        repoKey: intent.repoKey,
        number,
        consistency: force ? 'upstream-confirmed' : 'cache-ok',
        timeoutMs: 20_000,
      })) as GithubIssueDetailRest
      const [comments, timeline] = await Promise.all([
        githubRead(ctx, {
          operation: 'issue-comments',
          repoKey: intent.repoKey,
          number,
          consistency: 'cache-ok',
          timeoutMs: 20_000,
        }),
        fetchTimeline(ctx, intent.repoKey.split('/')[0], intent.repoKey.split('/')[1], number),
      ])
      return {
        item: mapIssueDetail(issue, comments as GithubCommentRest[]),
        timeline,
        updatedAt: issue.updated_at ?? '',
      }
    },
    {
      force,
      ttlMs: fetchTtlMs(await loadConfig()),
      versionOf: (value: { updatedAt?: string }) => value.updatedAt,
    },
  )
}

export const GITHUB_READ_OPERATIONS: Record<GithubReadOperationId, GithubReadPolicy> = {
  'pr-detail': {
    effect: 'read',
    consistencyFloor: 'cache-ok',
    joinable: true,
    execute: (ctx, intent, force) => loadPrDetail(ctx, intent, force),
  },
  'pr-by-head': {
    effect: 'read',
    consistencyFloor: 'cache-ok',
    joinable: true,
    execute: (ctx, intent, force) => loadPrFact(ctx, { ...intent, number: undefined }, force).then((fact) => fact),
  },
  'pr-reviews': {
    effect: 'read',
    consistencyFloor: 'cache-ok',
    joinable: true,
    execute: (ctx, intent, force) => {
      const rest = githubRest(ctx)
      const resourceKey = `${intent.repoKey}/pulls/${intent.number}`
      return rest.cachedResource(
        `${resourceKey}/reviews`,
        rest.resourceVersion(resourceKey),
        () =>
          rest.paginate<GithubReviewRest>(
            `repos/${intent.repoKey}/pulls/${intent.number}/reviews`,
            undefined,
            intent.timeoutMs,
          ),
        { force },
      )
    },
  },
  'issue-detail': {
    effect: 'read',
    consistencyFloor: 'cache-ok',
    joinable: true,
    execute: (ctx, intent, force) => loadIssueDetail(ctx, intent, force),
  },
  'contract-issue-detail': {
    // Merge/contract gates must observe the live issue body; the floor keeps a
    // caller from relaxing the read into a cached answer (ADR-0010 §4).
    effect: 'read',
    consistencyFloor: 'upstream-confirmed',
    joinable: false,
    execute: (ctx, intent) => loadIssueDetail(ctx, intent, true),
  },
  'pr-fact': {
    effect: 'read',
    consistencyFloor: 'cache-ok',
    joinable: true,
    execute: (ctx, intent, force) => loadPrFact(ctx, intent, force),
  },
  'gate-pr-fact': {
    // Exact-HEAD gate reads share the composition but can never be cached.
    effect: 'read',
    consistencyFloor: 'upstream-confirmed',
    joinable: false,
    execute: (ctx, intent) => loadPrFact(ctx, intent, true),
  },
  'pr-panel': {
    effect: 'read',
    consistencyFloor: 'cache-ok',
    joinable: true,
    execute: (ctx, intent, force) => loadPanel(ctx, intent, force, true),
  },
  'issue-panel': {
    effect: 'read',
    consistencyFloor: 'cache-ok',
    joinable: true,
    execute: (ctx, intent, force) => loadPanel(ctx, intent, force, false),
  },
  'issue-comments': {
    effect: 'read',
    consistencyFloor: 'cache-ok',
    joinable: true,
    execute: (ctx, intent) =>
      githubRest(ctx).paginate<GithubCommentRest>(
        `repos/${intent.repoKey}/issues/${intent.number}/comments`,
        undefined,
        intent.timeoutMs,
      ),
  },
  'pr-comments': {
    effect: 'read',
    consistencyFloor: 'cache-ok',
    joinable: true,
    execute: (ctx, intent, force) => {
      const rest = githubRest(ctx)
      const key = `${intent.repoKey}/pulls/${intent.number}`
      return rest.cachedResource(
        `${key}/comments`,
        rest.resourceVersion(key),
        () =>
          rest.paginate<GithubCommentRest>(
            `repos/${intent.repoKey}/issues/${intent.number}/comments`,
            undefined,
            intent.timeoutMs,
          ),
        { force },
      )
    },
  },
  'pr-requested-reviewers': {
    effect: 'read',
    consistencyFloor: 'cache-ok',
    joinable: true,
    execute: (ctx, intent) =>
      githubRest(ctx).json(
        `repos/${intent.repoKey}/pulls/${intent.number}/requested_reviewers`,
        undefined,
        intent.timeoutMs,
      ),
  },
  'issue-timeline': {
    effect: 'read',
    consistencyFloor: 'cache-ok',
    joinable: true,
    execute: (ctx, intent) =>
      fetchTimeline(ctx, intent.repoKey.split('/')[0], intent.repoKey.split('/')[1], String(intent.number)),
  },
  'repo-snapshot': {
    effect: 'read',
    consistencyFloor: 'cache-ok',
    joinable: true,
    execute: (ctx, intent, force) => {
      const rest = githubRest(ctx)
      return rest.cachedAggregate(`repo:${intent.repoKey}`, intent.ttlMs ?? 30_000, force, async () => {
        const [issues, pulls] = await Promise.all([
          rest.paginate(`repos/${intent.repoKey}/issues?state=all`),
          rest.paginate(`repos/${intent.repoKey}/pulls?state=all`),
        ])
        return { issues, pulls }
      })
    },
  },
}

/** Submit one typed read; policy tightens the requested consistency, never relaxes it. */
export async function githubRead<T = unknown>(ctx: Context, intent: GithubReadIntent): Promise<T> {
  const policy = GITHUB_READ_OPERATIONS[intent.operation]
  if (!policy) throw new Error(`未声明的 GitHub 读取操作: ${intent.operation}`)
  const effective =
    consistencyRank(policy.consistencyFloor) > consistencyRank(intent.consistency)
      ? policy.consistencyFloor
      : intent.consistency
  return policy.execute(ctx, intent, effective === 'upstream-confirmed') as Promise<T>
}
