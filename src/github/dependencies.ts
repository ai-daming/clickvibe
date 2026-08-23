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
import { parseDependencies } from '../infra/develop-core.ts'
import { fetchTtlMs, loadConfig } from '../infra/runtime.ts'
import { fetchGithubRepoSnapshot } from './facts.ts'
import { type GithubUserRest } from './reads.ts'
import { githubErrorMessage, githubRest, isGithubRateLimitError } from './rest.ts'

/** One resolved dependency entry (number + title + state). */
export interface IssueDependency {
  number: number
  title: string
  state: string
}

/**
 * Resolve an issue's dependency graph (issue-contract convention):
 * - blockedBy: issues this issue depends on, parsed from its `## 依赖` body section;
 * - blocking: issues that declare a dependency on this issue.
 * Scans the repo's issues once via gh (local, fast).
 */
export async function fetchDependencies(
  ctx: Context,
  target: { owner: string; repo: string; number: string },
  item: { body?: unknown },
  forceRefresh = false,
): Promise<
  | { ok: true; dependencies: { blockedBy: IssueDependency[]; blocking: IssueDependency[] } }
  | { ok: false; error: string }
> {
  let issues: { number: number; title: string; state: string; body: string }[] = []
  try {
    const config = await loadConfig()
    const repoKey = `${target.owner}/${target.repo}`
    const snapshot = await fetchGithubRepoSnapshot(ctx, repoKey, fetchTtlMs(config), forceRefresh)
    issues = snapshot.issues
      .filter((issue) => issue.pull_request === undefined)
      .map((issue) => ({
        number: issue.number,
        title: issue.title,
        state: String(issue.state).toUpperCase(),
        body: issue.body ?? '',
      }))
  } catch (error) {
    return {
      ok: false,
      error: isGithubRateLimitError(error) ? error.message : `GitHub 依赖刷新失败: ${githubErrorMessage(error)}`,
    }
  }

  const current = Number(target.number)
  const byNumber = new Map(issues.filter((i) => Number.isInteger(i.number)).map((i) => [i.number, i]))

  const blockedBy: IssueDependency[] = []
  for (const number of parseDependencies(String(item.body ?? ''))) {
    const found = byNumber.get(number)
    blockedBy.push(
      found
        ? { number: found.number, title: found.title, state: found.state }
        : { number, title: '', state: 'unknown' },
    )
  }
  const blocking: IssueDependency[] = []
  for (const issue of issues) {
    if (issue.number === current) continue
    if (parseDependencies(issue.body).includes(current)) {
      blocking.push({ number: issue.number, title: issue.title, state: issue.state })
    }
  }
  blockedBy.sort((a, b) => a.number - b.number)
  blocking.sort((a, b) => a.number - b.number)
  return { ok: true, dependencies: { blockedBy, blocking } }
}

/** Fetch the issue timeline and keep only the events worth showing. */
export async function fetchTimeline(ctx: Context, owner: string, repo: string, number: string): Promise<unknown[]> {
  try {
    const events = await githubRest(ctx).paginate<{
      event?: string
      created_at?: string
      actor?: GithubUserRest | null
      commit_id?: string | null
      source?: {
        issue?: {
          number?: number
          title?: string
          html_url?: string
          state?: string
          pull_request?: { merged_at?: string | null } | null
        }
      } | null
    }>(`repos/${owner}/${repo}/issues/${number}/timeline`, 'application/vnd.github+json', 15_000)
    const visible = new Set(['cross-referenced', 'referenced', 'connected', 'closed', 'reopened'])
    return events
      .filter((event) => visible.has(String(event.event ?? '')))
      .map((event) => {
        const source = event.source?.issue
        return {
          event: event.event,
          created_at: event.created_at,
          actor: String(event.actor?.login ?? ''),
          commit_id: event.commit_id ?? null,
          source: source
            ? {
                number: source.number,
                title: source.title,
                html_url: source.html_url,
                state: source.state,
                is_pr: source.pull_request != null,
                pr_merged: source.pull_request?.merged_at != null,
              }
            : null,
        }
      })
  } catch (error) {
    if (isGithubRateLimitError(error)) throw error
    return []
  }
}
