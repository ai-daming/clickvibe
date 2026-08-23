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
import { type AgentKind } from '../agent/agent-stream.ts'
import { updateBaseTip } from '../agent/baseline.ts'
import {
  buildReviewPrompt,
  fetchPrHeadBranch,
  resolvePromptSnapshot,
  resolveReviewBaseTarget,
} from '../agent/prompts.ts'
import { attachAgentProcess, createLiveTask, finishTask, pushTaskLine } from '../agent/task-supervisor.ts'
import { detectLinkedPr } from '../github/pr.ts'
import { githubRest } from '../github/rest.ts'
import { approvePassedReview } from '../github/review-approval.ts'
import { buildFreshAgentCommand, buildResumeAgentCommand, parseAgent, shellQuote } from '../infra/develop-core.ts'
import { decodeLiveLogLine } from '../infra/live-output.ts'
import { readDeliveryStats, readIntegratedRemoteTip } from '../infra/git.ts'
import { clearReviewResultFile, loadReviewResult, REVIEW_RESULT_RELATIVE_PATH } from '../infra/review-result.ts'
import { type LiveTask, parseUrl, readWorktreeHead, reviewTaskGate, runCommand, taskId } from '../infra/runtime.ts'
import {
  appendEvent,
  appendLog,
  clearStaleSessionId,
  type IssueWorkflow,
  issueBodyHash,
  issueKey,
  loadAllWorkflows,
  loadWorkflow,
  readLogTail,
  recordSessionId,
  resolveSessionForAgent,
  saveWorkflow,
  saveWorkflowStrict,
  type WorkflowEvent,
} from '../infra/state.ts'
import { withWorkflowLock } from '../infra/workflow-lock.ts'
import { mutateWorkflowStrict } from '../infra/workflow-mutation.ts'
import { buildDevComment, buildReviewComment } from './delivery-comment.ts'
import { deriveEventRound } from './delivery-audit.ts'
import { extractGithubCommentId, extractGithubCommentUrl } from './delivery-publication.ts'
import { type ReviewIssueContract } from './merge-gates.ts'
import { workflowBaseBranch } from './state-view.ts'

/** Start a review task on the dev branch with codex/claude. */
export async function startReview(
  ctx: Context,
  payload: unknown,
): Promise<{ ok: true; taskId: string } | { ok: false; error: string }> {
  const body = (payload ?? {}) as { url?: unknown; agent?: unknown; context?: unknown }
  const url = String(body.url ?? '').trim()
  const extraContext = typeof body.context === 'string' ? body.context.trim() : ''
  const parsedAgent = parseAgent(body.agent)
  if (parsedAgent === 'dryrun') return { ok: false, error: 'review 不支持 dryrun' }
  const agent: AgentKind = parsedAgent
  const parsed = parseUrl(url)
  if (!parsed) {
    return { ok: false, error: '请输入形如 https://github.com/owner/repo/issues/123 或 /pull/123 的链接' }
  }

  // 定位 workflow:issue URL → 直接按 key;PR URL → 按 prNumber 或 head 分支反查
  let workflow: IssueWorkflow | null = null
  if (parsed.kind === 'issue') {
    const key = issueKey(`${parsed.owner}/${parsed.repo}`, parsed.number)
    workflow = await loadWorkflow(key)
  } else {
    // PR:先按已记录的 prNumber 找,再按 head 分支找(可能尚未记录)
    const all = await loadAllWorkflows()
    const repoKey = `${parsed.owner}/${parsed.repo}`
    workflow = all.find((w) => w.repoKey === repoKey && w.prNumber === parsed.number) ?? null
    if (!workflow) {
      const prInfo = await fetchPrHeadBranch(ctx, parsed.owner, parsed.repo, parsed.number)
      if (prInfo) {
        workflow = all.find((w) => w.repoKey === repoKey && w.branch === prInfo) ?? null
      }
    }
  }

  if (!workflow || workflow.stage === 'idle' || workflow.stage === 'developing') {
    return { ok: false, error: '该 issue 尚未完成开发,无法 review' }
  }
  if (!existsSync(workflow.worktree)) {
    return { ok: false, error: `worktree 不存在: ${workflow.worktree}` }
  }
  let activeWorkflow: IssueWorkflow = workflow
  const workflowKey = activeWorkflow.key
  const ownedReviewSession = resolveSessionForAgent(activeWorkflow, 'review', agent)
  let sessionId = ownedReviewSession.sessionId
  // workflow 校验后、冻结契约/HEAD 等任何 await 之前同步占位。重复请求会立即
  // 复用 taskId,不会重复支付 GitHub 刷新超时,也不会交错清理结论文件并双开 review。
  let reservation: { task: LiveTask; created: boolean }
  try {
    reservation = reviewTaskGate.reserve(workflowKey, () => {
      const id = taskId('review')
      return createLiveTask(id, activeWorkflow, 'review', agent, sessionId)
    })
  } catch (error) {
    return { ok: false, error: String(error instanceof Error ? error.message : error) }
  }
  if (!reservation.created) return { ok: true, taskId: reservation.task.taskId }
  const live = reservation.task
  const resolvedSnapshot = await resolvePromptSnapshot(ctx, activeWorkflow)
  if ('error' in resolvedSnapshot) {
    finishTask(live, 'failed', 1)
    return { ok: false, error: resolvedSnapshot.error }
  }
  // Prompt 与 review 事件必须绑定同一份快照，避免两次 GitHub 读取之间的契约漂移。
  const reviewIssue: ReviewIssueContract = {
    title: resolvedSnapshot.snapshot.title,
    body: resolvedSnapshot.snapshot.body,
    state: resolvedSnapshot.snapshot.state,
    contract: {
      bodyHash: issueBodyHash(resolvedSnapshot.snapshot.body),
      updatedAt: resolvedSnapshot.snapshot.updatedAt,
    },
  }
  if (reviewIssue.state !== 'OPEN') {
    finishTask(live, 'failed', 1)
    return { ok: false, error: '只有 OPEN Issue 可以启动 review' }
  }
  let prepared:
    | {
        workflow: IssueWorkflow
        reviewedHead: string
        sessionId: string | null
        reviewBase: Awaited<ReturnType<typeof resolveReviewBaseTarget>>
      }
    | undefined
  try {
    prepared = await withWorkflowLock(workflowKey, async () => {
      const current = await loadWorkflow(workflowKey)
      if (!current) throw new Error('workflow 已不存在')
      // Review preflight and sync share one lock: the frozen HEAD/base pair can
      // never be sampled across a concurrent worktree merge.
      try {
        await runCommand(ctx, 'git fetch origin --prune', {
          workdir: current.worktree,
          timeoutMs: 60_000,
          sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: current.worktree },
        })
        pushTaskLine(live, '[clickvibe] review 前已同步远端(origin)')
      } catch (error) {
        pushTaskLine(
          live,
          `[clickvibe] review 前 git fetch 失败(继续): ${String(error instanceof Error ? error.message : error)}`,
        )
      }
      const reviewedHead = (await readWorktreeHead(ctx, current.worktree)) ?? ''
      if (!reviewedHead) throw new Error('无法冻结被审 HEAD,请检查 worktree 后重试')
      const owned = resolveSessionForAgent(current, 'review', agent)
      if (owned.invalid) {
        pushTaskLine(live, '[clickvibe] review sessionId 归属缺失或与当前 agent 不一致,已清除并启动全新会话')
      }
      if (parsed.kind === 'pr' && !current.prNumber) current.prNumber = parsed.number
      const reviewBase = await resolveReviewBaseTarget(ctx, current)
      try {
        await clearReviewResultFile(current.worktree)
      } catch (error) {
        throw new Error(`无法清除旧 review 结论文件: ${String(error instanceof Error ? error.message : error)}`)
      }
      current.reviewAgent = agent
      current.reviewTaskId = live.taskId
      current.stage = 'reviewing'
      await saveWorkflowStrict(current)
      return { workflow: current, reviewedHead, sessionId: owned.sessionId, reviewBase }
    })
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error)
    pushTaskLine(live, `[clickvibe] review 启动前置失败: ${message}`)
    finishTask(live, 'failed', 1)
    return { ok: false, error: message }
  }
  if (!prepared) {
    finishTask(live, 'failed', 1)
    return { ok: false, error: '无法冻结 review 基线' }
  }
  activeWorkflow = prepared.workflow
  const reviewedHead = prepared.reviewedHead
  const frozenReviewBase = prepared.reviewBase
  const exactSessionId = prepared.sessionId

  // 仅续接归属匹配的精确会话;旧状态无 owner 或跨 agent 时直接全新 review。
  const agentCommand = exactSessionId ? buildResumeAgentCommand(agent, exactSessionId) : buildFreshAgentCommand(agent)
  const prompt = await buildReviewPrompt(
    ctx,
    activeWorkflow,
    resolvedSnapshot,
    reviewedHead,
    exactSessionId,
    extraContext,
    frozenReviewBase,
  )

  pushTaskLine(live, `[clickvibe] 启动 ${agent} review${exactSessionId ? `(续会话 ${exactSessionId})` : ''}…`)
  attachAgentProcess(
    ctx,
    live,
    agentCommand,
    activeWorkflow.worktree,
    prompt,
    async (exitCode, newSessionId) => {
      const durationMs = Math.max(0, Date.now() - live.startedAt)
      pushTaskLine(live, `[clickvibe] review 结束,退出码 ${exitCode}`)
      if (live.status !== 'done' || exitCode !== 0) {
        await mutateWorkflowStrict(workflowKey, (interrupted) => {
          recordSessionId(interrupted, 'review', newSessionId, agent)
          interrupted.stage = 'review-ready'
        }).catch(() => undefined)
        return
      }
      const lines = (await readLogTail(workflowKey, 'review', 200)).map((line) => decodeLiveLogLine(line).text)
      const resolved = await loadReviewResult(activeWorkflow.worktree, lines)
      if (!resolved.result) {
        pushTaskLine(live, `[clickvibe] review 结论解析异常:${resolved.parseError ?? '原因未知'},需要重新 Review`)
        await mutateWorkflowStrict(workflowKey, (invalid) => {
          recordSessionId(invalid, 'review', newSessionId, agent)
          invalid.reviewResult = null
          invalid.stage = 'review-ready'
        }).catch(() => undefined)
        return
      }
      if (resolved.source === 'file') {
        pushTaskLine(live, `[clickvibe] review 结论来源: ${REVIEW_RESULT_RELATIVE_PATH}`)
      } else {
        pushTaskLine(
          live,
          `[clickvibe] review 结论文件不可用(${resolved.fileError ?? '原因未知'}),回退 ${resolved.source === 'stdout-json' ? 'stdout JSON' : 'stdout 表情行'}判定`,
        )
      }
      const { passed, issues } = resolved.result
      await withWorkflowLock(workflowKey, async () => {
        const reloaded = await loadWorkflow(workflowKey)
        if (!reloaded) return
        const round = deriveEventRound(reloaded.events)
        const stats = await readDeliveryStats(
          ctx,
          reloaded.worktree,
          workflowBaseBranch(reloaded.baseRef),
          reviewedHead,
        )
        reloaded.reviewResult = { passed, issues }
        reloaded.stage = passed ? 'passed' : 'review-ready' // 有问题 → 可回开发(rework)
        // 记录 review 会话 id(供下次 review 续会话)
        recordSessionId(reloaded, 'review', newSessionId, agent)
        const event: WorkflowEvent = {
          kind: 'review',
          at: new Date().toISOString(),
          durationMs,
          hash: reviewedHead,
          round,
          agent,
          ...(stats ? { stats } : {}),
          taskId: live.taskId,
          verdict: { passed, issues },
          issueContract: reviewIssue.contract,
          ...(frozenReviewBase.sha ? { reviewBase: { ref: frozenReviewBase.ref, sha: frozenReviewBase.sha } } : {}),
          note: `${agent} review${passed ? ' 通过' : ` 发现 ${issues.length} 个问题`}`,
          // 用户附加说明只进本地事件时间线,不进 GitHub 评论(issue #54)。
          ...(extraContext !== '' ? { userContext: extraContext } : {}),
        }
        await appendEvent(reloaded, event)
        const issueNumber = parseUrl(reloaded.url)?.number ?? 'unknown'
        const body = buildReviewComment({
          commit: reviewedHead ?? 'unknown',
          issueNumber,
          passed,
          issues,
          agent,
          round,
          stats,
          at: event.at,
        })
        await publishDeliveryComment(ctx, reloaded, event, body)
        if (event.publication?.status === 'posted' && event.publication.url && reloaded.reviewResult) {
          reloaded.reviewResult.commentUrl = event.publication.url
          await saveWorkflow(reloaded)
        }
        const approval = await approvePassedReview(
          {
            repoKey: reloaded.repoKey,
            prNumber: reloaded.prNumber,
            passed,
          },
          (command) => runCommand(ctx, command, { timeoutMs: 30000 }),
        )
        if (approval === 'approved') {
          pushTaskLine(live, '[clickvibe] 已提交 GitHub 原生 Approve (LGTM)')
        } else if (approval === 'failed') {
          pushTaskLine(live, '[clickvibe] GitHub 原生 Approve 失败(继续,不影响 Review 结论与评论)')
        }
      })
    },
    exactSessionId
      ? {
          staleSessionId: exactSessionId,
          prepare: async () => {
            await mutateWorkflowStrict(workflowKey, (reloaded) => {
              clearStaleSessionId(reloaded, 'review', exactSessionId)
            }).catch(() => undefined)
            return {
              command: buildFreshAgentCommand(agent),
              prompt: await buildReviewPrompt(
                ctx,
                activeWorkflow,
                resolvedSnapshot,
                reviewedHead,
                null,
                extraContext,
                frozenReviewBase,
              ),
            }
          },
        }
      : undefined,
  )

  return { ok: true, taskId: live.taskId }
}

/** Record one dev/rework delivery and publish its matching GitHub node. */
export async function recordDevDelivery(
  ctx: Context,
  workflow: IssueWorkflow,
  agent: 'codex' | 'claude',
  head: string | null,
  fixedIssues: string[],
  kind: 'dev' | 'rework' | 'resume',
  userContext = '',
  taskIdValue?: string,
  durationMs?: number,
): Promise<void> {
  if (head && workflow.baseRef) {
    const remoteBase = `origin/${workflowBaseBranch(workflow.baseRef)}`
    const integratedTip = await readIntegratedRemoteTip(ctx, workflow.worktree, remoteBase, head)
    if (integratedTip) workflow.baseRef = updateBaseTip(workflow.baseRef, remoteBase, integratedTip)
  }
  if (!workflow.prNumber) {
    const pr = await detectLinkedPr(ctx, workflow.repoKey, workflow.branch)
    if (pr) workflow.prNumber = pr
  }
  const round = deriveEventRound(workflow.events)
  const stats = head
    ? await readDeliveryStats(ctx, workflow.worktree, workflowBaseBranch(workflow.baseRef), head)
    : undefined
  const event: WorkflowEvent = {
    kind,
    at: new Date().toISOString(),
    ...(Number.isFinite(durationMs) ? { durationMs: Math.max(0, durationMs ?? 0) } : {}),
    hash: head ?? undefined,
    round,
    agent,
    ...(stats ? { stats } : {}),
    ...(taskIdValue ? { taskId: taskIdValue } : {}),
    fixed: fixedIssues.length,
    note: `${agent} 完成开发${kind === 'rework' ? '(按 review 意见返工)' : ''}`,
    // 用户附加说明只进本地事件时间线,不进 GitHub 评论(issue #54)。
    ...(userContext !== '' ? { userContext } : {}),
  }
  await appendEvent(workflow, event)
  const issueNumber = parseUrl(workflow.url)?.number ?? 'unknown'
  const body = buildDevComment({
    commit: head ?? 'unknown',
    issueNumber,
    fixedIssues,
    agent,
    round,
    stats,
    at: event.at,
  })
  await publishDeliveryComment(ctx, workflow, event, body)
  if (fixedIssues.length > 0 && kind !== 'dev') await markPreviousReviewFixed(ctx, workflow, round, agent)
}

async function markPreviousReviewFixed(
  ctx: Context,
  workflow: IssueWorkflow,
  fixedRound: number,
  fallbackAgent: 'codex' | 'claude',
): Promise<void> {
  const reviewEvent = [...workflow.events]
    .reverse()
    .find((candidate) => candidate.kind === 'review' && candidate.verdict?.passed === false)
  if (!reviewEvent?.verdict) return
  const commentUrl = reviewEvent.publication?.url ?? workflow.reviewResult?.commentUrl
  const commentId = commentUrl ? extractGithubCommentId(commentUrl) : undefined
  if (!commentId) return
  const issueNumber = parseUrl(workflow.url)?.number ?? 'unknown'
  const body = buildReviewComment({
    commit: reviewEvent.hash ?? 'unknown',
    issueNumber,
    passed: false,
    issues: reviewEvent.verdict.issues,
    agent: reviewEvent.agent ?? workflow.reviewAgent ?? fallbackAgent,
    round: reviewEvent.round ?? Math.max(1, fixedRound - 1),
    fixedRound,
    stats: reviewEvent.stats,
    at: reviewEvent.at,
  })
  try {
    await runCommand(
      ctx,
      `gh api ${shellQuote(`repos/${workflow.repoKey}/issues/comments/${commentId}`)} --method PATCH --input -`,
      { stdin: JSON.stringify({ body }), timeoutMs: 30000 },
    )
    await appendLog(workflow.key, 'dev', `[clickvibe] 已标注上一轮 Review 评论:第 ${fixedRound} 轮已修复`)
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).slice(0, 500)
    await appendLog(workflow.key, 'dev', `[clickvibe] Review 评论修复标注失败(不影响交付): ${message}`)
  }
}

/** Publish a public delivery node without pretending a failed write succeeded. */
export async function publishDeliveryComment(
  ctx: Context,
  workflow: IssueWorkflow,
  event: WorkflowEvent,
  body: string,
): Promise<void> {
  const target = workflow.prNumber ? 'pr' : 'issue'
  const targetUrl = workflow.prNumber
    ? `https://github.com/${workflow.repoKey}/pull/${workflow.prNumber}`
    : workflow.url
  const command = `gh issue comment ${shellQuote(targetUrl)} --body-file -`
  try {
    const output = await runCommand(ctx, command, { stdin: body, timeoutMs: 30000 })
    const commentUrl = extractGithubCommentUrl(output)
    event.publication = {
      target,
      status: 'posted',
      ...(commentUrl ? { url: commentUrl } : {}),
    }
    const number = workflow.prNumber ?? parseUrl(workflow.url)?.number
    if (number) githubRest(ctx).invalidate(`${workflow.repoKey}/${target === 'pr' ? 'pulls' : 'issues'}/${number}`)
    githubRest(ctx).invalidate(`repo:${workflow.repoKey}`)
    await appendLog(
      workflow.key,
      event.kind === 'review' ? 'review' : 'dev',
      `[clickvibe] 已发布 GitHub ${target === 'pr' ? 'PR' : 'Issue'} 评论${event.publication.url ? `: ${event.publication.url}` : ''}`,
    )
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).slice(0, 500)
    event.publication = { target, status: 'failed', error: message }
    await appendLog(
      workflow.key,
      event.kind === 'review' ? 'review' : 'dev',
      `[clickvibe] GitHub 评论发布失败: ${message}`,
    )
  }
  await saveWorkflow(workflow)
}
