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
import { buildReviewPrompt, fetchPrHeadBranch, resolvePromptSnapshot } from '../agent/prompts.ts'
import { attachAgentProcess, createLiveTask, finishTask, pushTaskLine } from '../agent/task-supervisor.ts'
import { detectLinkedPr } from '../github/pr.ts'
import { githubRest } from '../github/rest.ts'
import { approvePassedReview } from '../github/review-approval.ts'
import { buildFreshAgentCommand, buildResumeAgentCommand, parseAgent, shellQuote } from '../infra/develop-core.ts'
import { decodeLiveLogLine } from '../infra/live-output.ts'
import { readDeliveryStats } from '../infra/git.ts'
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
  type WorkflowEvent,
} from '../infra/state.ts'
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
  const ownedReviewSession = resolveSessionForAgent(workflow, 'review', agent)
  const sessionId = ownedReviewSession.sessionId
  // workflow 校验后、冻结契约/HEAD 等任何 await 之前同步占位。重复请求会立即
  // 复用 taskId,不会重复支付 GitHub 刷新超时,也不会交错清理结论文件并双开 review。
  let reservation: { task: LiveTask; created: boolean }
  try {
    reservation = reviewTaskGate.reserve(workflow.key, () => {
      const id = taskId('review')
      return createLiveTask(id, workflow, 'review', agent, sessionId)
    })
  } catch (error) {
    return { ok: false, error: String(error instanceof Error ? error.message : error) }
  }
  if (!reservation.created) return { ok: true, taskId: reservation.task.taskId }
  const live = reservation.task
  const resolvedSnapshot = await resolvePromptSnapshot(ctx, workflow)
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
  // Review must inspect the branch against current remote refs. Keep review
  // available during an outage, but make the degraded input explicit in its log.
  try {
    await runCommand(ctx, 'git fetch origin --prune', {
      workdir: workflow.worktree,
      timeoutMs: 60_000,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: workflow.worktree },
    })
    pushTaskLine(live, '[clickvibe] review 前已同步远端(origin)')
  } catch (error) {
    pushTaskLine(
      live,
      `[clickvibe] review 前 git fetch 失败(继续): ${String(error instanceof Error ? error.message : error)}`,
    )
  }

  if (reviewIssue.state !== 'OPEN') {
    finishTask(live, 'failed', 1)
    return { ok: false, error: '只有 OPEN Issue 可以启动 review' }
  }
  const reviewedHead = await readWorktreeHead(ctx, workflow.worktree)
  if (!reviewedHead) {
    finishTask(live, 'failed', 1)
    return { ok: false, error: '无法冻结被审 HEAD,请检查 worktree 后重试' }
  }

  if (ownedReviewSession.invalid) {
    await saveWorkflow(workflow)
    pushTaskLine(live, '[clickvibe] review sessionId 归属缺失或与当前 agent 不一致,已清除并启动全新会话')
  }

  // 记录关联 PR(若 review 的是 PR 且未记录)
  if (parsed.kind === 'pr' && !workflow.prNumber) {
    workflow.prNumber = parsed.number
    await saveWorkflow(workflow)
  }

  // A prior run's file must never become the next run's verdict.
  try {
    await clearReviewResultFile(workflow.worktree)
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error)
    pushTaskLine(live, `[clickvibe] 无法清除旧 review 结论文件: ${message}`)
    finishTask(live, 'failed', 1)
    return { ok: false, error: `无法清除旧 review 结论文件: ${message}` }
  }

  workflow.reviewAgent = agent
  workflow.reviewTaskId = live.taskId
  workflow.stage = 'reviewing'
  await saveWorkflow(workflow)

  // 仅续接归属匹配的精确会话;旧状态无 owner 或跨 agent 时直接全新 review。
  const agentCommand = sessionId ? buildResumeAgentCommand(agent, sessionId) : buildFreshAgentCommand(agent)
  const prompt = await buildReviewPrompt(ctx, workflow, resolvedSnapshot, reviewedHead, sessionId, extraContext)

  pushTaskLine(live, `[clickvibe] 启动 ${agent} review${sessionId ? `(续会话 ${sessionId})` : ''}…`)
  attachAgentProcess(
    ctx,
    live,
    agentCommand,
    workflow.worktree,
    prompt,
    async (exitCode, newSessionId) => {
      const durationMs = Math.max(0, Date.now() - live.startedAt)
      pushTaskLine(live, `[clickvibe] review 结束,退出码 ${exitCode}`)
      if (live.status !== 'done' || exitCode !== 0) {
        const interrupted = await loadWorkflow(workflow.key)
        if (interrupted) {
          recordSessionId(interrupted, 'review', newSessionId, agent)
          interrupted.stage = 'review-ready'
          await saveWorkflow(interrupted)
        }
        return
      }
      const lines = (await readLogTail(workflow.key, 'review', 200)).map((line) => decodeLiveLogLine(line).text)
      const resolved = await loadReviewResult(workflow.worktree, lines)
      if (!resolved.result) {
        pushTaskLine(live, `[clickvibe] review 结论解析异常:${resolved.parseError ?? '原因未知'},需要重新 Review`)
        const invalid = await loadWorkflow(workflow.key)
        if (invalid) {
          recordSessionId(invalid, 'review', newSessionId, agent)
          invalid.reviewResult = null
          invalid.stage = 'review-ready'
          await saveWorkflow(invalid)
        }
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
      const reloaded = await loadWorkflow(workflow.key)
      if (reloaded) {
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
      }
    },
    sessionId
      ? {
          staleSessionId: sessionId,
          prepare: async () => {
            const reloaded = await loadWorkflow(workflow.key)
            if (reloaded && clearStaleSessionId(reloaded, 'review', sessionId)) await saveWorkflow(reloaded)
            return {
              command: buildFreshAgentCommand(agent),
              prompt: await buildReviewPrompt(ctx, workflow, resolvedSnapshot, reviewedHead, null, extraContext),
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
