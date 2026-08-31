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
import { fetchDependencies, fetchTimeline, type IssueDependency } from '../github/dependencies.ts'
import {
  fetchIssueRestDetail,
  fetchPrRestDetail,
  fetchPrRestReviews,
  type GithubCommentRest,
  type GithubUserRest,
  mapIssueDetail,
  mapPrDetail,
} from '../github/reads.ts'
import { githubErrorMessage, isGithubRateLimitError } from '../github/rest.ts'
import { consistencyFromForce, githubRead } from '../github/operations.ts'
import { type IssuePromptSnapshot } from '../infra/develop-core.ts'
import { dependencyRefreshClock, fetchTtlMs, loadConfig, parseUrl } from '../infra/runtime.ts'
export async function fetchIssue(
  ctx: Context,
  payload: unknown,
): Promise<
  | {
      ok: true
      data: {
        kind: 'issue' | 'pr'
        item: unknown
        timeline?: unknown
        dependencies?: { blockedBy: IssueDependency[]; blocking: IssueDependency[] }
      }
      dependencyError?: string
    }
  | { ok: false; error: string }
> {
  const url = String((payload as { url?: unknown } | undefined)?.url ?? '').trim()
  const parsed = parseUrl(url)
  if (!parsed) {
    return { ok: false, error: '请输入形如 https://github.com/owner/repo/issues/123 或 /pull/123 的链接' }
  }
  const isPR = parsed.kind === 'pr'
  try {
    const repoKey = `${parsed.owner}/${parsed.repo}`
    const resourceKey = `${repoKey}/${isPR ? 'pulls' : 'issues'}/${parsed.number}`
    const panelCacheKey = `${resourceKey}/panel`
    const fetchOptions = payload as { forceRefresh?: unknown; forceDependencyRefresh?: unknown } | undefined
    const forceRefresh = fetchOptions?.forceRefresh === true
    const forceDependencyRefresh =
      fetchOptions?.forceDependencyRefresh === undefined ? forceRefresh : fetchOptions.forceDependencyRefresh === true
    const detail = (await githubRead(ctx, {
      operation: isPR ? 'pr-panel' : 'issue-panel',
      repoKey,
      number: parsed.number,
      consistency: consistencyFromForce(forceRefresh),
    })) as { item: unknown; timeline?: unknown; updatedAt: string }
    const data: {
      kind: 'issue' | 'pr'
      item: unknown
      timeline?: unknown
      dependencies?: { blockedBy: IssueDependency[]; blocking: IssueDependency[] }
    } = {
      kind: parsed.kind,
      item: detail.item,
      ...(detail.timeline ? { timeline: detail.timeline } : {}),
    }
    let dependencyError: string | undefined
    // issue 额外拉 timeline,提取关联事件(linked PR/commit)——GitHub UI 的
    // "linked a pull request" 就来自 cross-referenced 事件
    if (!isPR) {
      // 依赖图:blockedBy 来自本 issue 正文,blocking 扫描 repo 内其它 issue
      const dependencyResult = await fetchDependencies(
        ctx,
        parsed,
        detail.item as { body?: unknown },
        forceDependencyRefresh,
      )
      if (dependencyResult.ok) {
        data.dependencies = dependencyResult.dependencies
        dependencyRefreshClock.mark(`${parsed.owner}/${parsed.repo}`)
      } else {
        dependencyError = dependencyResult.error
      }
    }
    return { ok: true, data, ...(dependencyError ? { dependencyError } : {}) }
  } catch (error) {
    return {
      ok: false,
      error: isGithubRateLimitError(error) ? error.message : `抓取异常: ${githubErrorMessage(error)}`,
    }
  }
}

/**
 * Contract identity for auto-run re-authorization: url/title/state/body only.
 * Comments and updatedAt are audit evidence, not contract — ClickVibe's own
 * agents comment on the issue mid-run (开发前不变量、Dev Meta), and those must
 * not invalidate the authorization. Same principle as review-verdict binding
 * (docs/state-model.md: 正文 hash 才是契约身份).
 */
export function sameIssueContract(
  a: Pick<IssuePromptSnapshot, 'url' | 'title' | 'body' | 'state'>,
  b: Pick<IssuePromptSnapshot, 'url' | 'title' | 'body' | 'state'>,
): boolean {
  return a.url === b.url && a.title === b.title && a.state === b.state && a.body === b.body
}

export function issueSnapshot(item: Record<string, unknown>): IssuePromptSnapshot {
  const url = String(item.url ?? '')
  if (!parseUrl(url)) throw new Error('GitHub 返回了无效 URL')
  const comments = Array.isArray(item.comments)
    ? (item.comments as { author?: { login?: string } | null; body?: unknown }[]).map((comment) => ({
        author: String(comment.author?.login ?? 'unknown'),
        body: String(comment.body ?? ''),
      }))
    : []
  return {
    url,
    title: String(item.title ?? ''),
    body: String(item.body ?? ''),
    state: String(item.state ?? '').toUpperCase(),
    updatedAt: String(item.updatedAt ?? ''),
    comments,
  }
}
