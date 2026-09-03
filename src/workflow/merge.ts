/** Privileged merge authorization, gates, cleanup and archival workflow. */

import { existsSync } from 'node:fs'
import { userInfo } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { githubWrite, githubWriteOutcomeError, githubWriteRecoverOperation } from '../github/writes.ts'
import { logTaskDiagnostic } from '../infra/task-diagnostics.ts'
import { notifyLocalGitMutation } from '../infra/local-git-snapshot.ts'
import { parseWorktreeList } from '../agent/worktree.ts'
import { fetchGithubIssueState, fetchGithubPrFact } from '../github/facts.ts'
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
import {
  appendEvent,
  archiveWorkflow,
  type IssueWorkflow,
  issueKey,
  loadWorkflow,
  commitWorkflowMetadata,
  workflowRevision,
  WorkflowConflictError,
} from '../infra/state.ts'
import { collectMergeGateFailures, type MergeGateFailure, mergeGateRejection } from './merge-gates.ts'
import { workflowBaseBranch } from './state-view.ts'
import { baselineRestorePreview } from './baseline-restore.ts'
import { type DevelopBaselinePreview, developBaselinePreview } from './develop-baseline-preview.ts'
import { cleanupRemoteBranch } from './merge-remote-cleanup.ts'
import { withWorkflowLock } from '../infra/workflow-lock.ts'
import {
  contractHasKnownCanonicalFields,
  fingerprintGithubIssueContract,
  observeCurrentIssueContract,
} from './work-item-contract-repository.ts'

export type MergeAuthorizationPreview =
  | {
      ok: true
      prNumber: string
      branch: string
      head: string
      baseRef: string
      baseSha: string
      mergeFlag: '--merge'
      cleanup: string[]
    }
  | {
      ok: false
      gateFailures: MergeGateFailure[]
      prNumber: string
      branch: string
      head: string
      baseRef: string
      baseSha: string
      mergeFlag: '--merge'
      cleanup: string[]
    }

/**
 * 重放规则(#127 现场):清理进度三件套(delivery/issueState/autoRun)以内存最新为准;
 * events 以磁盘为准——merge 是长操作,期间并发写(defer 事件、完成收尾)会推进 revision,
 * 整对象快照不得覆盖它们的 events。
 */
export function replayMergeMetadata(disk: IssueWorkflow, memory: IssueWorkflow): void {
  disk.delivery = memory.delivery
  disk.issueState = memory.issueState
  disk.autoRun = memory.autoRun
}

async function persistMergeMetadata(workflow: IssueWorkflow): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    const current = (await loadWorkflow(workflow.key)) ?? workflow
    replayMergeMetadata(current, workflow)
    try {
      Object.assign(
        workflow,
        await commitWorkflowMetadata(current, workflowRevision(current), {
          delivery: current.delivery,
          issueState: current.issueState,
          autoRun: current.autoRun,
        }),
      )
      return
    } catch (error) {
      // revision 冲突:重载-重放-重试(3 次)。冲突不再逃逸到清理步骤的 catch,
      // 否则会被贴上"删除远端分支失败"之类的错误标签(#127 的归因事故)。
      if (!(error instanceof WorkflowConflictError) || attempt >= 2) throw error
    }
  }
}

export async function mergeAuthorizationPreview(ctx: Context, url: string): Promise<MergeAuthorizationPreview> {
  const parsed = parseUrl(url)
  if (!parsed || parsed.kind !== 'issue') throw new Error('合并目标必须是 GitHub Issue URL')
  const repoKey = `${parsed.owner}/${parsed.repo}`
  const workflow = await loadWorkflow(issueKey(repoKey, parsed.number))
  if (!workflow || !workflow.prNumber) throw new Error('未找到可合并的 workflow 或关联 PR')
  const lookup = await fetchGithubPrFact(ctx, repoKey, workflow.branch, workflow.prNumber, true, true)
  if (!lookup.known || !lookup.pr) throw new Error('无法读取实时 PR 状态,请稍后重试')
  if (lookup.pr.state === 'CLOSED') throw new Error('PR 已关闭且未合并,不能执行合并')
  if (lookup.pr.headRefName !== workflow.branch) throw new Error('实时 PR 分支与 workflow 不一致,拒绝合并')
  if (!lookup.pr.baseRefName || !lookup.pr.baseRefOid) throw new Error('实时 PR base 身份缺失,拒绝生成合并授权')
  const base = {
    prNumber: lookup.pr.number,
    branch: workflow.branch,
    head: lookup.pr.headRefOid ?? workflow.delivery?.prHead ?? '',
    baseRef: lookup.pr.baseRefName,
    baseSha: lookup.pr.baseRefOid,
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
      restoreTarget?: AgentAuthorizationInput['restoreTarget']
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
    let contract: import('../infra/contracts.ts').ContractAuthorizationBinding | null = null
    let baselinePreview: DevelopBaselinePreview | null = null
    let mergePreview: Extract<Awaited<ReturnType<typeof mergeAuthorizationPreview>>, { ok: true }> | null = null
    let restorePreview: Awaited<ReturnType<typeof baselineRestorePreview>> | null = null
    let mergeOverride: AgentAuthorizationInput['override']
    if (input.action === 'develop' || input.action === 'auto') {
      const current = await observeCurrentIssueContract(ctx, input.url, { force: true })
      if (current.state !== 'known') return { ok: false, error: `当前契约不可用: ${current.reason}` }
      if (!contractHasKnownCanonicalFields(current.snapshot)) {
        return { ok: false, error: '当前契约含 unknown 字段,禁止签发开发授权' }
      }
      snapshot = current.prompt
      if (snapshot.state !== 'OPEN') return { ok: false, error: '只有 OPEN Issue 可以启动开发' }
      if (!body.expectedSnapshot || typeof body.expectedSnapshot !== 'object' || Array.isArray(body.expectedSnapshot)) {
        return { ok: false, error: '未提供可验证的契约预览,请刷新面板并重新确认' }
      }
      if (
        fingerprintGithubIssueContract(body.expectedSnapshot as Record<string, unknown>) !==
        current.snapshot.fingerprint
      ) {
        return { ok: false, error: 'Issue 契约在预览后已变化,请刷新面板并重新确认' }
      }
      contract = { workItem: current.snapshot.workItem, fingerprint: current.snapshot.fingerprint }
      if (input.action === 'develop') baselinePreview = await developBaselinePreview(ctx, input.url, input.baseline)
    } else if (input.action === 'restore-base') {
      restorePreview = await baselineRestorePreview(ctx, input.url)
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
          baseRef: preview.baseRef,
          baseSha: preview.baseSha,
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
            baseRef: mergePreview.baseRef,
            baseSha: mergePreview.baseSha,
            mergeFlag: mergePreview.mergeFlag,
          },
          ...(mergeOverride ? { override: mergeOverride } : {}),
        }
      : restorePreview
        ? {
            ...input,
            restoreTarget: { branch: restorePreview.baseBranch, hash: restorePreview.baseHash },
          }
        : input
    const authorization = authorizations.issue(authorizationInput, snapshot, contract)
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
              contractFingerprint: contract?.fingerprint,
              digest: authorization.digest,
              ...(baselinePreview ?? {}),
              ...(input.action === 'auto' ? { autoRun: input.autoRun } : {}),
            }
          : { action: input.action, agent: input.agent, url: input.url, digest: authorization.digest }),
      ...(mergePreview ? { target: authorizationInput.target } : {}),
      ...(restorePreview ? { restoreTarget: authorizationInput.restoreTarget } : {}),
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
    const result = await withWorkflowLock(key, async () => mergeAndCleanupUnlocked(ctx, payload))
    notifyLocalGitMutation({ repoKey }, 'merge', 'mergeAndCleanup')
    return result
  } catch (error) {
    // Merge attempts can fail midway and still change the local scene
    // (conflicted merge, partial cleanup); the snapshot must not survive it.
    notifyLocalGitMutation({ repoKey }, 'merge-failed', 'mergeAndCleanup')
    throw error
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

  let lookup = await fetchGithubPrFact(ctx, repoKey, workflow.branch, workflow.prNumber, true, true)
  if (!lookup.known || !lookup.pr) return { ok: false, error: '无法读取实时 PR 状态,状态未改变' }
  let pr = lookup.pr
  if (pr.state === 'CLOSED') return { ok: false, error: 'PR 已关闭且未合并,状态未改变' }
  if (pr.headRefName !== workflow.branch) return { ok: false, error: '实时 PR 分支与 workflow 不一致,拒绝合并' }
  if (workflow.branch === (pr.baseRefName ?? workflowBaseBranch(workflow.baseRef))) {
    return { ok: false, error: 'workflow 分支等于 PR 基线分支,拒绝清理' }
  }
  if (!pr.headRefOid) return { ok: false, error: '实时 PR HEAD 缺失,拒绝合并' }
  let authorizedTarget: AgentAuthorizationInput['target']
  try {
    authorizedTarget = authorizationInputFromPayload('merge', payload).target
  } catch {
    authorizedTarget = undefined
  }
  if (
    authorizedTarget &&
    (authorizedTarget.baseRef !== pr.baseRefName || !pr.baseRefOid || authorizedTarget.baseSha !== pr.baseRefOid)
  ) {
    return { ok: false, error: '实时 PR base 相对授权预览已变化,请刷新并重新确认' }
  }

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
      await appendEvent(
        workflow,
        {
          kind: 'merge-override',
          at: new Date().toISOString(),
          skipped: [...override.skipped],
          skippedLabels: override.skipped.map(mergeGateLabel),
          reason: override.reason,
          operator: userInfo().username,
        },
        workflowRevision(workflow) ?? 0,
      )
    }
    if (pr.state !== 'MERGED') {
      // Typed write transaction (issue #131 slice B): the Gateway owns the
      // head-CAS merge attempt, the invalidation and the authoritative
      // merged-state readback — a confirmed outcome is the only path forward.
      const merge = await githubWrite(ctx, {
        operation: 'pr-merge',
        input: {
          repoKey,
          number: Number(pr.number),
          headRefOid: pr.headRefOid ?? '',
          issueNumber: Number(parsed.number),
        },
      })
      if (merge.outcome !== 'confirmed') {
        return {
          ok: false,
          error: `PR 合并失败: ${githubWriteOutcomeError(merge)}`,
        }
      }
      lookup = await fetchGithubPrFact(ctx, repoKey, workflow.branch, workflow.prNumber, true, true)
      if (!lookup.known || !lookup.pr || lookup.pr.state !== 'MERGED') {
        return { ok: false, error: 'PR 合并事务已确认,但实时 PR 状态尚未确认 MERGED;未开始清理' }
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
      await persistMergeMetadata(workflow)
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
    await persistMergeMetadata(workflow)
  }
  const failCleanup = async (label: string, error: unknown): Promise<MergeResult> => {
    const detail = String(error instanceof Error ? error.message : error)
    delivery.status = 'cleanup-pending'
    delivery.lastError = `${label}: ${detail}`
    try {
      await persistMergeMetadata(workflow)
    } catch (persistError) {
      return {
        ok: false,
        merged: true,
        cleanupPending: true,
        error: `PR 已合并;${label}失败:${detail};且持久化失败:${String(persistError)}`,
      }
    }
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
      await cleanupRemoteBranch(ctx, workflow, { repoPath, sandboxPolicy: policy, persist: persistStep })
    } catch (error) {
      return failCleanup('删除远端分支', error)
    }
  }

  if (!delivery.cleanup.issue) {
    try {
      const issueState = await fetchGithubIssueState(ctx, url)
      if (issueState === null) throw new Error('无法读取实时 Issue 状态')
      if (issueState === 'OPEN') {
        // The closing comment is a separate non-repeatable write whose durable
        // attempt marker is the cleanup step ledger: 'pending' is persisted
        // before dispatch, 'confirmed' once the readback proves the body. A
        // re-run that finds 'pending' settles by readback ONLY — a non-
        // repeatable comment is never re-dispatched. The comment stays
        // diagnostic and non-blocking for the critical issue-close.
        const closingBody = `由 PR #${pr.number} 以 merge commit 合并交付。`
        if (delivery.cleanup.issueComment !== 'confirmed') {
          const comment =
            delivery.cleanup.issueComment === 'pending'
              ? await githubWriteRecoverOperation(ctx, {
                  operation: 'issue-comment-create',
                  input: { repoKey, number: Number(parsed.number), body: closingBody },
                })
              : await githubWrite(ctx, {
                  operation: 'issue-comment-create',
                  input: { repoKey, number: Number(parsed.number), body: closingBody },
                  persistMarker: async () => {
                    delivery.cleanup.issueComment = 'pending'
                    await persistStep()
                  },
                })
          if (comment.outcome === 'confirmed') {
            delivery.cleanup.issueComment = 'confirmed'
            await persistStep()
          } else {
            logTaskDiagnostic('merge-close-comment-unconfirmed', {
              workflowKey: issueKey(repoKey, parsed.number),
              repoKey,
              issue: Number(parsed.number),
              outcome: comment.outcome,
              error: githubWriteOutcomeError(comment),
            })
          }
        }
        const close = await githubWrite(ctx, {
          operation: 'issue-close',
          input: { repoKey, number: Number(parsed.number) },
        })
        if (close.outcome !== 'confirmed') {
          throw new Error(`Issue 关闭事务未确认(${close.outcome}): ${githubWriteOutcomeError(close)}`)
        }
      }
      workflow.issueState = 'CLOSED'
      delivery.cleanup.issue = true
      await persistStep()
    } catch (error) {
      return failCleanup('关闭 Issue', error)
    }
  }

  const completingAutoRun = workflow.autoRun?.status === 'running' && workflow.autoRun.autoMerge
  const priorObservedAt = workflow.autoRun?.lastObservedAt ?? null
  const completionAt = new Date().toISOString()
  if (completingAutoRun && workflow.autoRun) {
    workflow.autoRun.status = 'completed'
    workflow.autoRun.pausedReason = null
    workflow.autoRun.lastObservedAt = completionAt
    workflow.events.push({
      kind: 'auto-run',
      at: completionAt,
      round: workflow.autoRun.rounds,
      note: '自动跑到底已自动合并并完成清理,交付收敛',
    })
  }
  try {
    delivery.status = 'archived'
    delete delivery.lastError
    await archiveWorkflow(workflow, workflowRevision(workflow) ?? 0)
  } catch (error) {
    if (completingAutoRun && workflow.autoRun) {
      workflow.autoRun.status = 'running'
      workflow.autoRun.lastObservedAt = priorObservedAt
      const eventIndex = workflow.events.findIndex(
        (event) => event.kind === 'auto-run' && event.at === completionAt && event.note?.includes('自动合并'),
      )
      if (eventIndex >= 0) workflow.events.splice(eventIndex, 1)
    }
    return failCleanup('归档 workflow', error)
  }
  return { ok: true, merged: true, archived: true, prNumber: pr.number }
}
