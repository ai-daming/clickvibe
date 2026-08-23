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
import { userInfo } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { parseWorktreeList } from '../agent/worktree.ts'
import { fetchGithubIssueState, fetchGithubPrFact } from '../github/facts.ts'
import { fetchIssue, issueSnapshot } from '../github/issue.ts'
import { githubRest } from '../github/rest.ts'
import {
  type AgentAuthorizationInput,
  type IssuePromptSnapshot,
  mergeGateLabel,
  shellQuote,
} from '../infra/develop-core.ts'
import {
  authorizationInputFromPayload,
  authorizations,
  expandHome,
  loadConfig,
  mergingWorkflows,
  parseUrl,
  runCommand,
} from '../infra/runtime.ts'
import { appendEvent, archiveWorkflow, issueKey, loadWorkflow, saveWorkflowStrict } from '../infra/state.ts'
import { collectMergeGateFailures, type MergeGateFailure, mergeGateRejection } from './merge-gates.ts'
import { workflowBaseBranch } from './state-view.ts'
import { baselineRestorePreview } from './baseline-restore.ts'
import { type DevelopBaselinePreview, developBaselinePreview } from './develop-baseline-preview.ts'

export type MergeAuthorizationPreview =
  | {
      ok: true
      prNumber: string
      branch: string
      head: string
      mergeFlag: '--merge'
      cleanup: string[]
    }
  | {
      ok: false
      gateFailures: MergeGateFailure[]
      prNumber: string
      branch: string
      head: string
      mergeFlag: '--merge'
      cleanup: string[]
    }

export async function mergeAuthorizationPreview(ctx: Context, url: string): Promise<MergeAuthorizationPreview> {
  const parsed = parseUrl(url)
  if (!parsed || parsed.kind !== 'issue') throw new Error('合并目标必须是 GitHub Issue URL')
  const repoKey = `${parsed.owner}/${parsed.repo}`
  const workflow = await loadWorkflow(issueKey(repoKey, parsed.number))
  if (!workflow || !workflow.prNumber) throw new Error('未找到可合并的 workflow 或关联 PR')
  const lookup = await fetchGithubPrFact(ctx, repoKey, workflow.branch, workflow.prNumber)
  if (!lookup.known || !lookup.pr) throw new Error('无法读取实时 PR 状态,请稍后重试')
  if (lookup.pr.state === 'CLOSED') throw new Error('PR 已关闭且未合并,不能执行合并')
  if (lookup.pr.headRefName !== workflow.branch) throw new Error('实时 PR 分支与 workflow 不一致,拒绝合并')
  const base = {
    prNumber: lookup.pr.number,
    branch: workflow.branch,
    head: lookup.pr.headRefOid ?? workflow.delivery?.prHead ?? '',
    mergeFlag: '--merge' as const,
    cleanup: ['worktree', '本地分支', '远端分支', `Issue #${parsed.number}`, 'workflow 归档'],
  }
  if (!workflow.delivery) {
    const gateFailures = await collectMergeGateFailures(
      ctx,
      workflow,
      lookup.pr.headRefOid ?? '',
      lookup.pr.baseRefName && lookup.pr.baseRefOid
        ? { ref: lookup.pr.baseRefName, sha: lookup.pr.baseRefOid }
        : undefined,
    )
    if (gateFailures.length > 0) return { ok: false, gateFailures, ...base }
  }
  return { ok: true, ...base }
}

export async function authorizeAgent(
  ctx: Context,
  payload: unknown,
): Promise<
  | {
      ok: true
      authorizationId: string
      authorizationDigest: string
      expiresAt: number
      preview: unknown
      target?: AgentAuthorizationInput['target']
      override?: AgentAuthorizationInput['override']
    }
  | { ok: false; error: string; gateFailures?: MergeGateFailure[] }
> {
  try {
    const body = (payload ?? {}) as {
      action?: unknown
      expectedSnapshot?: unknown
      override?: unknown
      overrideReason?: unknown
    }
    const action = String(body.action ?? '') as AgentAuthorizationInput['action']
    const input = authorizationInputFromPayload(action, payload)
    let snapshot: IssuePromptSnapshot | null = null
    let baselinePreview: DevelopBaselinePreview | null = null
    let mergePreview: Extract<Awaited<ReturnType<typeof mergeAuthorizationPreview>>, { ok: true }> | null = null
    let restorePreview: Awaited<ReturnType<typeof baselineRestorePreview>> | null = null
    let mergeOverride: AgentAuthorizationInput['override']
    if (input.action === 'develop') {
      const fetched = await fetchIssue(ctx, { url: input.url })
      if (!fetched.ok) return fetched
      snapshot = issueSnapshot(fetched.data.item as Record<string, unknown>)
      if (snapshot.state !== 'OPEN') return { ok: false, error: '只有 OPEN Issue 可以启动开发' }
      if (JSON.stringify(body.expectedSnapshot) !== JSON.stringify(snapshot)) {
        return { ok: false, error: 'Issue 内容已变化或未提供完整预览快照,请刷新面板并重新确认' }
      }
      baselinePreview = await developBaselinePreview(ctx, input.url, input.baseline)
    } else if (input.action === 'restore-base') {
      restorePreview = await baselineRestorePreview(input.url)
    } else if (input.action === 'merge') {
      const preview = await mergeAuthorizationPreview(ctx, input.url)
      if (preview.ok) {
        mergePreview = preview
      } else {
        // 门禁拒绝(issue #49):未请求人工放行 → 原样拒绝并附门禁清单供面板展示入口。
        const reason = String(body.overrideReason ?? '').trim()
        if (body.override !== true || reason === '') {
          return {
            ok: false,
            error: mergeGateRejection(preview.gateFailures),
            gateFailures: preview.gateFailures,
          }
        }
        if (preview.head === '') throw new Error('合并授权目标无效')
        mergeOverride = { skipped: preview.gateFailures.map((failure) => failure.key), reason }
        mergePreview = {
          ok: true,
          prNumber: preview.prNumber,
          branch: preview.branch,
          head: preview.head,
          mergeFlag: preview.mergeFlag,
          cleanup: preview.cleanup,
          // 预览同时给出被跳过门禁项的明细,供客户端逐项二次确认。
          ...(mergeOverride ? { override: { ...mergeOverride, gates: preview.gateFailures } } : {}),
        }
      }
    }
    const authorizationInput: AgentAuthorizationInput = mergePreview
      ? {
          ...input,
          target: {
            prNumber: mergePreview.prNumber,
            branch: mergePreview.branch,
            head: mergePreview.head,
            mergeFlag: mergePreview.mergeFlag,
          },
          ...(mergeOverride ? { override: mergeOverride } : {}),
        }
      : input
    const authorization = authorizations.issue(authorizationInput, snapshot)
    // 预览沿用量剔除 ok 判别字段,保持既有合并预览结构不变。
    const mergePreviewBody = mergePreview ? (({ ok, ...fields }) => fields)(mergePreview) : null
    return {
      ok: true,
      authorizationId: authorization.id,
      authorizationDigest: authorization.digest,
      expiresAt: authorization.expiresAt,
      preview:
        mergePreviewBody ??
        (restorePreview
          ? {
              action: input.action,
              agent: null,
              url: input.url,
              digest: authorization.digest,
              baseline: `origin/${restorePreview.baseBranch}`,
              baselineRef: restorePreview.baseHash,
            }
          : null) ??
        (snapshot
          ? {
              action: input.action,
              agent: input.agent,
              url: snapshot.url,
              title: snapshot.title,
              updatedAt: snapshot.updatedAt,
              commentCount: snapshot.comments.length,
              digest: authorization.digest,
              ...baselinePreview,
            }
          : { action: input.action, agent: input.agent, url: input.url, digest: authorization.digest }),
      ...(mergePreview ? { target: authorizationInput.target } : {}),
      ...(mergeOverride ? { override: mergeOverride } : {}),
    }
  } catch (error) {
    return { ok: false, error: String(error instanceof Error ? error.message : error) }
  }
}

export type MergeResult =
  | { ok: true; merged: true; archived: true; prNumber: string }
  | { ok: false; error: string; merged?: boolean; cleanupPending?: boolean; gateFailures?: MergeGateFailure[] }

export async function mergeAndCleanup(ctx: Context, payload: unknown): Promise<MergeResult> {
  const url = String((payload as { url?: unknown } | undefined)?.url ?? '').trim()
  const parsed = parseUrl(url)
  if (!parsed || parsed.kind !== 'issue') return { ok: false, error: '合并目标必须是 GitHub Issue URL' }
  const repoKey = `${parsed.owner}/${parsed.repo}`
  const key = issueKey(repoKey, parsed.number)
  if (mergingWorkflows.has(key)) return { ok: false, error: '该 PR 正在合并或清理,请等待当前请求完成' }
  mergingWorkflows.add(key)
  try {
    return await mergeAndCleanupUnlocked(ctx, payload)
  } finally {
    mergingWorkflows.delete(key)
  }
}

export async function mergeAndCleanupUnlocked(ctx: Context, payload: unknown): Promise<MergeResult> {
  const url = String((payload as { url?: unknown } | undefined)?.url ?? '').trim()
  const parsed = parseUrl(url)
  if (!parsed || parsed.kind !== 'issue') return { ok: false, error: '合并目标必须是 GitHub Issue URL' }
  const repoKey = `${parsed.owner}/${parsed.repo}`
  const workflow = await loadWorkflow(issueKey(repoKey, parsed.number))
  if (!workflow || !workflow.prNumber) return { ok: false, error: '未找到可合并的 workflow 或关联 PR' }

  const config = await loadConfig()
  const configuredRepo = config.repos[repoKey]
  if (!configuredRepo) return { ok: false, error: `未配置项目 ${repoKey}` }
  const repoPath = resolve(expandHome(configuredRepo))
  const worktree = resolve(workflow.worktree)
  const worktreeRoot = resolve(config.worktreeRoot)
  const relativeWorktree = relative(worktreeRoot, worktree)
  if (relativeWorktree === '' || relativeWorktree.startsWith('..') || isAbsolute(relativeWorktree)) {
    return { ok: false, error: 'workflow worktree 不在已配置 worktreeRoot 内,拒绝清理' }
  }
  if (workflow.branch.trim() === '') return { ok: false, error: 'workflow 分支无效,拒绝清理' }

  let lookup = await fetchGithubPrFact(ctx, repoKey, workflow.branch, workflow.prNumber)
  if (!lookup.known || !lookup.pr) return { ok: false, error: '无法读取实时 PR 状态,状态未改变' }
  let pr = lookup.pr
  if (pr.state === 'CLOSED') return { ok: false, error: 'PR 已关闭且未合并,状态未改变' }
  if (pr.headRefName !== workflow.branch) return { ok: false, error: '实时 PR 分支与 workflow 不一致,拒绝合并' }
  if (workflow.branch === (pr.baseRefName ?? workflowBaseBranch(workflow.baseRef))) {
    return { ok: false, error: 'workflow 分支等于 PR 基线分支,拒绝清理' }
  }
  if (!pr.headRefOid) return { ok: false, error: '实时 PR HEAD 缺失,拒绝合并' }

  if (!workflow.delivery) {
    const gateFailures = await collectMergeGateFailures(
      ctx,
      workflow,
      pr.headRefOid,
      pr.baseRefName && pr.baseRefOid ? { ref: pr.baseRefName, sha: pr.baseRefOid } : undefined,
    )
    if (gateFailures.length > 0) {
      // 门禁拒绝(issue #49):仅当用户已完成人工放行二次确认(授权绑定被跳过
      // 门禁项与原因)且当前失败项被完全覆盖时才放行;否则行为与文案保持不变。
      let override: AgentAuthorizationInput['override'] | null = null
      try {
        override = authorizationInputFromPayload('merge', payload).override ?? null
      } catch {
        override = null
      }
      if (!override) {
        return { ok: false, error: mergeGateRejection(gateFailures), gateFailures }
      }
      const uncovered = gateFailures.filter((failure) => !override.skipped.includes(failure.key))
      if (uncovered.length > 0) {
        return {
          ok: false,
          error: `${mergeGateRejection(uncovered)}(与人工放行确认时的门禁项不一致,请重新确认)`,
          gateFailures,
        }
      }
      // 放行审计先于合并写入时间线:即使随后合并失败,放行动作也可追溯,
      // 且与 review 结论事件分离——放行不冒充 review 通过。
      await appendEvent(workflow, {
        kind: 'merge-override',
        at: new Date().toISOString(),
        skipped: [...override.skipped],
        skippedLabels: override.skipped.map(mergeGateLabel),
        reason: override.reason,
        operator: userInfo().username,
      })
    }
    if (pr.state !== 'MERGED') {
      const command = [
        'gh pr merge',
        shellQuote(pr.number),
        '--repo',
        shellQuote(repoKey),
        '--merge',
        '--match-head-commit',
        shellQuote(pr.headRefOid),
        '--body',
        shellQuote(`Closes #${parsed.number}`),
      ].join(' ')
      try {
        await runCommand(ctx, command, { timeoutMs: 120_000 })
        githubRest(ctx).invalidate(`${repoKey}/pulls/${pr.number}`)
        githubRest(ctx).invalidate(`repo:${repoKey}`)
      } catch (error) {
        return { ok: false, error: `PR 合并失败: ${String(error instanceof Error ? error.message : error)}` }
      }
      lookup = await fetchGithubPrFact(ctx, repoKey, workflow.branch, workflow.prNumber)
      if (!lookup.known || !lookup.pr || lookup.pr.state !== 'MERGED') {
        return { ok: false, error: 'gh pr merge 已返回,但实时 PR 状态尚未确认 MERGED;未开始清理' }
      }
      pr = lookup.pr
    }
    const confirmedHead = pr.headRefOid
    if (!confirmedHead) return { ok: false, error: 'PR 已合并,但无法读取被合并的 HEAD;未开始清理' }
    workflow.delivery = {
      status: 'merged',
      mergedAt: pr.mergedAt ?? new Date().toISOString(),
      prHead: confirmedHead,
      mergeStrategy: 'merge',
      cleanup: { worktree: false, localBranch: false, remoteBranch: false, issue: false },
    }
    try {
      await saveWorkflowStrict(workflow)
    } catch (error) {
      return {
        ok: false,
        merged: true,
        cleanupPending: true,
        error: `PR 已合并,但无法持久化清理状态: ${String(error instanceof Error ? error.message : error)}`,
      }
    }
  } else if (pr.state !== 'MERGED') {
    return { ok: false, error: '本地记录为已合并,但 GitHub 实时状态不一致;拒绝继续清理' }
  }

  const delivery = workflow.delivery
  if (!delivery) return { ok: false, error: 'delivery 状态丢失,拒绝清理' }
  const policy = { mode: 'danger-full-access' as const, workspaceRoot: repoPath }
  const persistStep = async (): Promise<void> => {
    delivery.status = 'cleanup-pending'
    delete delivery.lastError
    await saveWorkflowStrict(workflow)
  }
  const failCleanup = async (label: string, error: unknown): Promise<MergeResult> => {
    const detail = String(error instanceof Error ? error.message : error)
    delivery.status = 'cleanup-pending'
    delivery.lastError = `${label}: ${detail}`
    await saveWorkflowStrict(workflow).catch(() => {})
    return { ok: false, merged: true, cleanupPending: true, error: `PR 已合并;${label}失败,可重试: ${detail}` }
  }

  if (!delivery.cleanup.worktree) {
    try {
      const records = parseWorktreeList(
        await runCommand(ctx, 'git worktree list --porcelain', {
          workdir: repoPath,
          timeoutMs: 15_000,
          sandboxPolicy: policy,
        }),
      )
      const registered = records.some((record) => record.path === worktree)
      if (registered) {
        await runCommand(ctx, `git worktree remove ${shellQuote(worktree)}`, {
          workdir: repoPath,
          timeoutMs: 60_000,
          sandboxPolicy: policy,
        })
      } else if (existsSync(worktree)) {
        throw new Error('路径仍存在但不是已注册 worktree,拒绝删除')
      }
      delivery.cleanup.worktree = true
      await persistStep()
    } catch (error) {
      return failCleanup('移除 worktree', error)
    }
  }

  if (!delivery.cleanup.localBranch) {
    try {
      await runCommand(
        ctx,
        `if git show-ref --verify --quiet ${shellQuote(`refs/heads/${workflow.branch}`)}; then git branch -D -- ${shellQuote(workflow.branch)}; fi`,
        { workdir: repoPath, timeoutMs: 30_000, sandboxPolicy: policy },
      )
      delivery.cleanup.localBranch = true
      await persistStep()
    } catch (error) {
      return failCleanup('删除本地分支', error)
    }
  }

  if (!delivery.cleanup.remoteBranch) {
    try {
      await runCommand(
        ctx,
        `if git ls-remote --exit-code --heads origin ${shellQuote(`refs/heads/${workflow.branch}`)} >/dev/null 2>&1; then git push origin --delete ${shellQuote(workflow.branch)}; fi`,
        { workdir: repoPath, timeoutMs: 60_000, sandboxPolicy: policy },
      )
      delivery.cleanup.remoteBranch = true
      await persistStep()
    } catch (error) {
      return failCleanup('删除远端分支', error)
    }
  }

  if (!delivery.cleanup.issue) {
    try {
      const issueState = await fetchGithubIssueState(ctx, url)
      if (issueState === null) throw new Error('无法读取实时 Issue 状态')
      if (issueState === 'OPEN') {
        await runCommand(
          ctx,
          `gh issue close ${shellQuote(parsed.number)} --repo ${shellQuote(repoKey)} --comment ${shellQuote(`由 PR #${pr.number} 以 merge commit 合并交付。`)}`,
          { timeoutMs: 30_000 },
        )
        githubRest(ctx).invalidate(`${repoKey}/issues/${parsed.number}`)
        githubRest(ctx).invalidate(`repo:${repoKey}`)
      }
      workflow.issueState = 'CLOSED'
      delivery.cleanup.issue = true
      await persistStep()
    } catch (error) {
      return failCleanup('关闭 Issue', error)
    }
  }

  try {
    delivery.status = 'archived'
    delete delivery.lastError
    await archiveWorkflow(workflow)
  } catch (error) {
    return failCleanup('归档 workflow', error)
  }
  return { ok: true, merged: true, archived: true, prNumber: pr.number }
}
