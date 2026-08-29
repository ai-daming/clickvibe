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
import { basename, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { fetchGithubPrFact, fetchGithubRepoSnapshot, type RepositoryIssueItem } from '../github/facts.ts'
import { type GithubPrFact } from '../github/reads.ts'
import { githubErrorMessage, githubRest, isGithubRateLimitError } from '../github/rest.ts'
import { parseDependencies, shellQuote } from '../infra/develop-core.ts'
import { type RepositoryFreshness } from '../infra/repo-freshness.ts'
import {
  type ClickVibeConfig,
  dependencyRefreshClock,
  ensureConfiguredRepoFresh,
  expandHome,
  fetchTtlMs,
  loadConfig,
  parseUrl,
  runCommand,
} from '../infra/runtime.ts'
import type { LocalGitSnapshotReader } from '../infra/local-git-snapshot.ts'
import { logTaskDiagnostic } from '../infra/task-diagnostics.ts'
import { type IssueWorkflow, issueBodyHash, issueKey, loadAllWorkflows } from '../infra/state.ts'
import { deriveAutoDevelopment } from './auto-development.ts'
import { deriveWorkflowState } from './derive.ts'
import { checkIssueContract } from './issue-contract.ts'
import { firstDevelopmentFor, maintainCompletedDependencyLedger } from './repository-state.ts'
import { readConfiguredRepositoryAdvance, type RepositoryAdvanceSignal } from './repository-sync.ts'

export async function fetchRepositoryIssues(
  ctx: Context,
  payload: unknown,
  overrides: {
    config?: ClickVibeConfig
    workflows?: IssueWorkflow[]
    observation?: LocalGitSnapshotReader
  } = {},
): Promise<
  | {
      ok: true
      repoKey: string
      issues: unknown[]
      freshness: RepositoryFreshness | null
      repoAdvance: RepositoryAdvanceSignal | null
    }
  | { ok: false; error: string }
> {
  const repoKey = String((payload as { repoKey?: unknown } | undefined)?.repoKey ?? '').trim()
  const config = overrides.config ?? (await loadConfig())
  const configuredPath = config.repos[repoKey]
  if (!configuredPath) return { ok: false, error: `未配置项目 ${repoKey}` }
  const forceRefresh = (payload as { forceRefresh?: unknown } | undefined)?.forceRefresh === true
  const freshness = await ensureConfiguredRepoFresh(ctx, config, repoKey, forceRefresh)

  try {
    const rest = githubRest(ctx)
    const [githubSnapshot, allWorkflows, repoAdvance] = await Promise.all([
      fetchGithubRepoSnapshot(ctx, repoKey, fetchTtlMs(config), forceRefresh),
      overrides.workflows ? Promise.resolve(overrides.workflows) : loadAllWorkflows(),
      readConfiguredRepositoryAdvance(ctx, config, repoKey, freshness?.lastSuccessAt ?? null),
    ])
    const allIssues = githubSnapshot.issues
      .filter((issue) => issue.pull_request === undefined)
      .map<RepositoryIssueItem>((issue) => ({
        number: issue.number,
        title: issue.title,
        state: issue.state.toUpperCase(),
        body: issue.body ?? '',
        url: issue.html_url,
        updatedAt: issue.updated_at,
        labels: issue.labels,
        milestone: issue.milestone,
        contract: checkIssueContract(issue.body ?? ''),
      }))
    const prs = githubSnapshot.pulls.map<GithubPrFact>((pr) => ({
      number: String(pr.number),
      state: pr.merged_at ? 'MERGED' : pr.state.toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN',
      mergedAt: pr.merged_at,
      headRefName: String(pr.head?.ref ?? ''),
      url: pr.html_url,
      reviewDecision: null,
    }))
    for (const issue of allIssues) rest.rememberVersion(`${repoKey}/issues/${issue.number}`, issue.updatedAt)
    for (const pr of githubSnapshot.pulls) rest.rememberVersion(`${repoKey}/pulls/${pr.number}`, pr.updated_at)

    const issueByNumber = new Map(allIssues.map((issue) => [issue.number, issue]))
    const workflowByNumber = new Map(
      allWorkflows
        .filter((workflow) => workflow.repoKey === repoKey)
        .map((workflow) => [Number(parseUrl(workflow.url)?.number), workflow]),
    )
    const prByBranch = new Map<string, GithubPrFact>()
    for (const raw of prs) {
      if (!raw.headRefName || prByBranch.has(raw.headRefName)) continue
      prByBranch.set(raw.headRefName, { ...raw, number: String(raw.number) })
    }
    const prByNumber = new Map<string, GithubPrFact>()
    for (const raw of prs) {
      if (!prByNumber.has(String(raw.number)))
        prByNumber.set(String(raw.number), { ...raw, number: String(raw.number) })
    }

    const repoPath = expandHome(configuredPath)
    const project = basename(repoPath)
    let refs = new Set<string>()
    let defaultBranch = 'main'
    let counts: Map<string, number> | null = null
    if (existsSync(repoPath) && overrides.observation) {
      // Issue #122 Q3: enumeration runs on the snapshot plane — one compound
      // subprocess per repo per generation, no error-swallowed per-branch reads.
      const sample = () =>
        overrides
          .observation!.enumerationSample(ctx, repoKey, { repoPath })
          .then((result) => ({ ok: true as const, result }))
          .catch((error: unknown) => ({ ok: false as const, error }))
      let attempt = await sample()
      if (!attempt.ok) attempt = await sample()
      if (!attempt.ok) {
        const message = attempt.error instanceof Error ? attempt.error.message : String(attempt.error)
        logTaskDiagnostic('local-git-enumeration-sample-failed', { repoKey, repoPath, error: message })
        throw new Error(`本地 Git 枚举不可用(已重试一次): ${message}`)
      }
      refs = new Set(attempt.result.sample.refs)
      defaultBranch = attempt.result.sample.defaultBranch || defaultBranch
      counts = attempt.result.sample.counts
    } else if (existsSync(repoPath)) {
      const policy = { mode: 'read-only' as const, workspaceRoot: repoPath }
      const [refOutput, defaultRef] = await Promise.all([
        runCommand(ctx, "git for-each-ref --format='%(refname:short)' refs/heads refs/remotes/origin", {
          workdir: repoPath,
          timeoutMs: 5000,
          sandboxPolicy: policy,
        }),
        runCommand(ctx, 'git symbolic-ref --quiet --short refs/remotes/origin/HEAD', {
          workdir: repoPath,
          timeoutMs: 3000,
          sandboxPolicy: policy,
        }).catch(() => ''),
      ])
      refs = new Set(refOutput.split('\n').filter(Boolean))
      defaultBranch = defaultRef.replace(/^origin\//, '') || defaultBranch
    }

    const activeIssues = allIssues.filter((issue) => {
      if (String(issue.state).toUpperCase() === 'OPEN') return true
      const workflow = workflowByNumber.get(issue.number)
      return workflow?.delivery !== undefined && workflow.delivery.status !== 'archived'
    })
    const issues = await Promise.all(
      activeIssues.map(async (rawIssue) => {
        const originalDependencies = parseDependencies(rawIssue.body)
        const originalDependencyStates = originalDependencies.map((number) =>
          String(issueByNumber.get(number)?.state ?? 'UNKNOWN').toUpperCase(),
        )
        const unlockable =
          originalDependencies.length > 0 && originalDependencyStates.every((state) => state === 'CLOSED')
        const ledger = unlockable
          ? await maintainCompletedDependencyLedger(ctx, repoKey, rawIssue, originalDependencies)
          : { issue: rawIssue, updated: false }
        const issue = ledger.issue
        const existing = workflowByNumber.get(issue.number)
        const branch = existing?.branch ?? `${project}-issue-${issue.number}`
        const worktree = existing?.worktree ?? join(config.worktreeRoot, project, branch)
        const branchExists = refs.has(branch) || refs.has(`origin/${branch}`)
        // 列表页优先消费快照事实:pulls?state=all 已含全部(含已合并/已关闭)PR,
        // 冷启动不再为每个 workflow 打 pulls/{n}(+reviews) 网络请求,首屏秒开;
        // 只有快照缺失该编号(分支重命名/新 PR 未入快照)才按编号回源刷新,
        // 沿用"编号刷新 + 刷新失败关门"的既有语义(tests/routes.test.ts)。
        // 已有持久化 reviewResult 时跳过 reviews 详情,verdict 以本地为准。
        const snapshotPr = existing?.prNumber ? prByNumber.get(String(existing.prNumber)) : null
        let pr: GithubPrFact | null
        let prStatusKnown: boolean
        if (snapshotPr) {
          pr = snapshotPr
          prStatusKnown = true
        } else if (existing?.prNumber) {
          const lookup = await fetchGithubPrFact(
            ctx,
            repoKey,
            branch,
            existing.prNumber,
            existing.reviewResult === null,
          )
          pr = lookup.pr
          prStatusKnown = lookup.known && lookup.pr !== null
        } else {
          pr = prByBranch.get(branch) ?? null
          prStatusKnown = true
        }
        let hasCommits = false
        if (counts !== null) {
          // Snapshot plane: the enumeration already counted every local head
          // against the same default base; a missing entry is expected absence.
          hasCommits = branchExists && (counts.get(branch) ?? 0) > 0
        } else if (branchExists && existsSync(repoPath)) {
          hasCommits = await runCommand(
            ctx,
            `git rev-list --count ${shellQuote(`origin/${defaultBranch}`)}..${shellQuote(branch)}`,
            {
              workdir: repoPath,
              timeoutMs: 10000,
              sandboxPolicy: { mode: 'read-only', workspaceRoot: repoPath },
            },
          ).then((count) => {
            const value = Number(count)
            if (!Number.isSafeInteger(value) || value < 0) {
              throw new Error(`本地 Git 提交计数非法(${branch}): ${count}`)
            }
            return value > 0
          })
        }
        const workflow: IssueWorkflow = existing ?? {
          key: issueKey(repoKey, String(issue.number)),
          url: issue.url,
          repoKey,
          worktree,
          branch,
          stage: pr ? 'review-ready' : 'idle',
          devAgent: null,
          devTaskId: null,
          devSessionId: null,
          devSessionAgent: null,
          devInterrupted: false,
          reviewAgent: null,
          reviewTaskId: null,
          reviewSessionId: null,
          reviewSessionAgent: null,
          reviewResult: null,
          prNumber: pr?.number ?? null,
          issueState: 'OPEN',
          baseRef: null,
          updatedAt: 0,
          events: [],
        }
        workflow.worktree = worktree
        workflow.branch = branch
        workflow.issueState = String(issue.state).toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN'
        const derived = await deriveWorkflowState(ctx, workflow, {
          pr,
          prStatusKnown,
          branchExists,
          hasCommits,
          defaultBranch,
          issueContract: {
            bodyHash: issueBodyHash(issue.body),
            updatedAt: issue.updatedAt ?? '',
          },
          workflowCachePresent: existing !== undefined,
        })
        const blockedBy = parseDependencies(issue.body).map((number) => {
          const dependency = issueByNumber.get(number)
          return { number, title: dependency?.title ?? '', state: String(dependency?.state ?? 'UNKNOWN').toUpperCase() }
        })
        const contract = checkIssueContract(issue.body ?? '')
        const autoDevelopment = deriveAutoDevelopment({
          issueState: issue.state,
          dependencyStates: blockedBy.map((dependency) => dependency.state),
          contract,
          firstDevelopment: firstDevelopmentFor(existing, derived),
        })
        return {
          ...issue,
          blockedBy,
          workflow: derived,
          contract,
          autoDevelopment,
          dependencyLedger: {
            updated: ledger.updated,
            ...(ledger.error ? { error: ledger.error } : {}),
          },
        }
      }),
    )
    dependencyRefreshClock.mark(repoKey)
    return { ok: true, repoKey, issues, freshness, repoAdvance }
  } catch (error) {
    return {
      ok: false,
      error: isGithubRateLimitError(error) ? error.message : `项目 issue 抓取失败: ${githubErrorMessage(error)}`,
    }
  }
}

/** Validate the URL and run gh, returning the { ok, ... } envelope. */
