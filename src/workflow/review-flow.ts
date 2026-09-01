/**
 * clickvibe host half — routes:
 * Routes cover state, development, review, resume, sync, task logs and streams.
 * Text commands reuse these same action handlers.
 *
 * Workflow per issue (persisted under ~/.clickvibe/state/):
 *   developing → review-ready → reviewing → passed
 *                      ↑                  │
 *                      └── rework ────────┘
 */

import { existsSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { remoteFetch } from '../infra/remote-git.ts'
import { notifyLocalGitMutation } from '../infra/local-git-snapshot.ts'
import { type AgentKind } from '../agent/agent-stream.ts'
import {
  buildReviewPrompt,
  fetchPrHeadBranch,
  resolvePromptSnapshot,
  resolveReviewBaseTarget,
} from '../agent/prompts.ts'
import {
  attachAgentProcess,
  createLiveTask,
  finishTask,
  pushTaskLine,
  reserveHostTask,
} from '../agent/task-supervisor.ts'
import { approvePassedReview } from '../github/review-approval.ts'
import { buildFreshAgentCommand, buildResumeAgentCommand, parseAgent } from '../infra/develop-core.ts'
import { decodeLiveLogLine } from '../infra/live-output.ts'
import { readDeliveryStats } from '../infra/git.ts'
import { clearReviewResultFile, loadReviewResult, REVIEW_RESULT_RELATIVE_PATH } from '../infra/review-result.ts'
import { type LiveTask, parseUrl, readWorktreeHead, reviewTaskGate, runCommand, taskId } from '../infra/runtime.ts'
import {
  clearStaleSessionId,
  type IssueWorkflow,
  issueBodyHash,
  issueKey,
  loadAllWorkflows,
  loadWorkflow,
  readLogTail,
  recordSessionId,
  resolveSessionForAgent,
  type WorkflowEvent,
} from '../infra/state.ts'
import {
  observeWorkflowTask,
  taskLaunchDecision,
  type TaskOwnershipContext,
  workflowTaskExpectation,
} from '../infra/task-ownership.ts'
import { buildReviewComment } from './delivery-comment.ts'
import { deriveEventRound } from './delivery-audit.ts'
import { deriveFreshSessionAvailability, selectSessionLaunch } from './fresh-session.ts'
import { publishDeliveryComment } from './delivery-publish.ts'
import { type ReviewIssueContract } from './merge-gates.ts'
import { resolveReviewStartWorkflow } from './review-start.ts'
import { workflowBaseBranch } from './state-view.ts'
import { establishTaskClaim } from './task-claim.ts'
import { mutateLiveTaskWorkflow } from './task-lease.ts'
import { notifyAutoRunCompletion } from './auto-run-signal.ts'

/** Start a review task on the dev branch with codex/claude. */
export async function startReview(
  ctx: Context,
  payload: unknown,
): Promise<{ ok: true; taskId: string } | { ok: false; error: string; controllerError?: true }> {
  const body = (payload ?? {}) as { url?: unknown; agent?: unknown; context?: unknown; freshSession?: unknown }
  const url = String(body.url ?? '').trim()
  const extraContext = typeof body.context === 'string' ? body.context.trim() : ''
  const freshSession = body.freshSession === true
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

  const resolvedStart = await resolveReviewStartWorkflow(ctx, parsed, workflow)
  if (!resolvedStart.ok) return resolvedStart
  workflow = resolvedStart.workflow
  const ownershipGate = taskLaunchDecision(observeWorkflowTask(ctx as unknown as TaskOwnershipContext, workflow))
  if (!ownershipGate.allowed) {
    return ownershipGate.running
      ? { ok: true, taskId: ownershipGate.task.taskId }
      : { ok: false, error: ownershipGate.error, controllerError: true }
  }
  const claimExpectation = workflowTaskExpectation(workflow)
  if (!existsSync(workflow.worktree)) {
    return { ok: false, error: `worktree 不存在: ${workflow.worktree}` }
  }
  const workflowKey = workflow.key
  const availability = deriveFreshSessionAvailability(
    workflow.events,
    workflow.devSessionId !== null && workflow.devSessionAgent === workflow.devAgent,
    workflow.reviewSessionId !== null && workflow.reviewSessionAgent === workflow.reviewAgent,
  )
  if (freshSession && !availability.review) {
    return { ok: false, error: '当前轮次未超过阈值,或没有可放弃的 review 会话' }
  }
  const ownedReviewSession = freshSession
    ? { sessionId: null, invalid: false }
    : resolveSessionForAgent(structuredClone(workflow), 'review', agent)
  const resetSession =
    freshSession || ownedReviewSession.invalid || (!workflow.reviewSessionId && workflow.reviewSessionAgent !== null)
  const launch = selectSessionLaunch(freshSession, ownedReviewSession)
  const sessionId = launch.sessionId
  // workflow 校验后、冻结契约/HEAD 等任何 await 之前同步占位。重复请求会立即
  // 复用 taskId,不会重复支付 GitHub 刷新超时,也不会交错清理结论文件并双开 review。
  let reservation: { task: LiveTask; created: boolean }
  try {
    reservation = reviewTaskGate.reserve(workflowKey, () => {
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
  const reviewIssue: ReviewIssueContract = {
    title: resolvedSnapshot.snapshot.title,
    body: resolvedSnapshot.snapshot.body,
    state: resolvedSnapshot.snapshot.state,
    contract: {
      bodyHash: issueBodyHash(resolvedSnapshot.snapshot.body),
      updatedAt: resolvedSnapshot.snapshot.updatedAt,
    },
  }
  try {
    await remoteFetch(ctx, {
      repoKey: workflow.repoKey,
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
  notifyLocalGitMutation({ repoKey: workflow.repoKey, worktreePath: workflow.worktree }, 'remote-fetch', 'startReview')
  if (reviewIssue.state !== 'OPEN') {
    finishTask(live, 'failed', 1)
    return { ok: false, error: '只有 OPEN Issue 可以启动 review' }
  }
  const reviewedHead = await readWorktreeHead(ctx, workflow.worktree)
  if (!reviewedHead) {
    finishTask(live, 'failed', 1)
    return { ok: false, error: '无法冻结被审 HEAD,请检查 worktree 后重试' }
  }
  let reviewBase: Awaited<ReturnType<typeof resolveReviewBaseTarget>>
  try {
    reviewBase = await resolveReviewBaseTarget(ctx, workflow)
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error)
    pushTaskLine(live, `[clickvibe] 无法冻结 Review 基线: ${message}`)
    finishTask(live, 'failed', 1)
    return { ok: false, error: `无法冻结 Review 基线: ${message}` }
  }

  if (ownedReviewSession.invalid) {
    pushTaskLine(live, '[clickvibe] review sessionId 归属缺失或与当前 agent 不一致,已清除并启动全新会话')
  }

  // Finish all fallible, read-only prompt preparation before reserving durable
  // ownership. Only the controller that commits the task claim may clear the
  // shared result file or launch the Agent.
  const agentCommand = sessionId ? buildResumeAgentCommand(agent, sessionId) : buildFreshAgentCommand(agent)
  let prompt: string
  try {
    prompt = await buildReviewPrompt(
      ctx,
      workflow,
      resolvedSnapshot,
      reviewedHead,
      sessionId,
      extraContext,
      reviewBase,
      freshSession,
    )
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error)
    pushTaskLine(live, `[clickvibe] 无法构建 Review 提示词: ${message}`)
    finishTask(live, 'failed', 1)
    return { ok: false, error: `无法构建 Review 提示词: ${message}` }
  }

  let hostReservation: ReturnType<typeof reserveHostTask>
  try {
    hostReservation = reserveHostTask(ctx, live)
  } catch (error) {
    finishTask(live, 'failed', 1)
    return {
      ok: false,
      error: `宿主任务占位失败:${String(error instanceof Error ? error.message : error)}`,
      controllerError: true,
    }
  }
  if (!hostReservation.created) {
    finishTask(live, 'stopped', null)
    return { ok: true, taskId: hostReservation.taskId }
  }
  const claim = await establishTaskClaim(
    workflow,
    live,
    {
      kind: 'review',
      taskId: live.taskId,
      hostJobId: hostReservation.hostJobId,
      agent,
      resetSession,
      ...(parsed.kind === 'pr' && !workflow.prNumber ? { prNumber: parsed.number } : {}),
    },
    claimExpectation,
  )
  if (!claim.ok) {
    return {
      ok: false,
      error: `建立 Review 任务所有权失败:${claim.error}`,
      controllerError: true,
    }
  }
  if (!claim.claimed) return { ok: true, taskId: claim.taskId }

  // A prior run's file must never become the next run's verdict. This side
  // effect is after the cross-process claim, so a losing controller cannot
  // erase the winner's result.
  try {
    await clearReviewResultFile(workflow.worktree)
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error)
    pushTaskLine(live, `[clickvibe] 无法清除旧 review 结论文件: ${message}`)
    const current = await loadWorkflow(workflow.key)
    let recoveryError = ''
    try {
      if (current) {
        await mutateLiveTaskWorkflow(live, current, (latest) => {
          latest.stage = 'review-ready'
        })
      }
    } catch (recoveryFailure) {
      recoveryError = `;恢复状态持久化失败:${String(
        recoveryFailure instanceof Error ? recoveryFailure.message : recoveryFailure,
      )}`
    }
    finishTask(live, 'failed', 1)
    return { ok: false, error: `无法清除旧 review 结论文件: ${message}${recoveryError}` }
  }

  pushTaskLine(
    live,
    freshSession
      ? `[clickvibe] 新开 ${agent} review 会话,按 base...HEAD 全量审查…`
      : `[clickvibe] 启动 ${agent} review${sessionId ? `(续会话 ${sessionId})` : ''}…`,
  )
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
          await mutateLiveTaskWorkflow(live, interrupted, (latest) => {
            recordSessionId(latest, 'review', newSessionId, agent)
            latest.stage = 'review-ready'
          })
        }
        notifyAutoRunCompletion(ctx, workflow.key, live.status === 'running' ? 'failed' : live.status)
        return
      }
      const lines = (await readLogTail(workflowKey, 'review', 200)).map((line) => decodeLiveLogLine(line).text)
      const resolved = await loadReviewResult(workflow.worktree, lines)
      if (!resolved.result) {
        pushTaskLine(live, `[clickvibe] review 结论解析异常:${resolved.parseError ?? '原因未知'},需要重新 Review`)
        const invalid = await loadWorkflow(workflow.key)
        if (invalid) {
          await mutateLiveTaskWorkflow(live, invalid, (latest) => {
            recordSessionId(latest, 'review', newSessionId, agent)
            latest.reviewResult = null
            latest.stage = 'review-ready'
          })
        }
        notifyAutoRunCompletion(ctx, workflow.key, 'failed')
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
        const stats = await readDeliveryStats(
          ctx,
          reloaded.worktree,
          workflowBaseBranch(reloaded.baseRef),
          reviewedHead,
        )
        const round = deriveEventRound(reloaded.events)
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
          ...(reviewBase.sha ? { reviewBase: { ref: reviewBase.ref, sha: reviewBase.sha } } : {}),
          note: `${agent} review${passed ? ' 通过' : ` 发现 ${issues.length} 个问题`}`,
          // 用户附加说明只进本地事件时间线,不进 GitHub 评论(issue #54)。
          ...(extraContext !== '' ? { userContext: extraContext } : {}),
        }
        const verdictSaved = await mutateLiveTaskWorkflow(live, reloaded, (latest) => {
          latest.reviewResult = { passed, issues }
          latest.stage = passed ? 'passed' : 'review-ready'
          recordSessionId(latest, 'review', newSessionId, agent)
          latest.events = [...(latest.events ?? []), event]
        })
        if (verdictSaved.status === 'ownership-lost') {
          notifyAutoRunCompletion(ctx, workflow.key, 'done')
          return
        }
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
        const published = await publishDeliveryComment(ctx, reloaded, event, body, live)
        if (!published) {
          notifyAutoRunCompletion(ctx, workflow.key, 'done')
          return
        }
        if (event.publication?.status === 'posted' && event.publication.url && reloaded.reviewResult) {
          const commentUrl = event.publication.url
          await mutateLiveTaskWorkflow(live, reloaded, (latest) => {
            if (latest.reviewResult) latest.reviewResult.commentUrl = commentUrl
          })
        }
        // Attempt marker (slice B): the review event is already persisted
        // before this point — re-approving after an uncertain outcome is
        // guarded by the exact-body readback predicate, and an unconfirmed
        // approval stays best-effort (non-blocking) exactly as before.
        const approval = await approvePassedReview(
          ctx,
          {
            repoKey: reloaded.repoKey,
            prNumber: reloaded.prNumber,
            passed,
          },
          async () => {
            // The event publication record doubles as the durable marker: mark
            // the approval attempt in the persisted review event before dispatch.
            await mutateLiveTaskWorkflow(live, reloaded, (latest) => {
              const reviewEvent = [...(latest.events ?? [])]
                .reverse()
                .find((candidate) => candidate.kind === 'review' && candidate.taskId === event.taskId)
              if (reviewEvent && !reviewEvent.approvalAttempt) reviewEvent.approvalAttempt = { status: 'pending' }
            })
          },
        )
        // Resolve the attempt marker into the workflow's durable answer for
        // the approval write (ADR-0010 §9): pending → confirmed/failed/unknown.
        await mutateLiveTaskWorkflow(live, reloaded, (latest) => {
          const reviewEvent = [...(latest.events ?? [])]
            .reverse()
            .find((candidate) => candidate.kind === 'review' && candidate.taskId === event.taskId)
          if (reviewEvent?.approvalAttempt) {
            reviewEvent.approvalAttempt = {
              status: approval === 'approved' ? 'confirmed' : approval === 'failed' ? 'failed' : 'unknown',
            }
          }
        })
        if (approval === 'approved') {
          pushTaskLine(live, '[clickvibe] 已提交 GitHub 原生 Approve (LGTM)')
        } else if (approval === 'failed') {
          pushTaskLine(live, '[clickvibe] GitHub 原生 Approve 失败(继续,不影响 Review 结论与评论)')
        } else if (approval === 'unknown') {
          pushTaskLine(live, '[clickvibe] GitHub 原生 Approve 结果未确认(继续,不影响 Review 结论与评论)')
        }
      }
      notifyAutoRunCompletion(ctx, workflow.key, 'done')
    },
    sessionId
      ? {
          staleSessionId: sessionId,
          prepare: async () => {
            const reloaded = await loadWorkflow(workflow.key)
            if (!reloaded) throw new Error('Review workflow 不存在,不再启动会话回退')
            const saved = await mutateLiveTaskWorkflow(live, reloaded, (latest) => {
              clearStaleSessionId(latest, 'review', sessionId)
            })
            if (saved.status === 'ownership-lost') throw new Error('旧 Review 任务已被新代替换,不再启动会话回退')
            const fallbackPrompt = await buildReviewPrompt(
              ctx,
              workflow,
              resolvedSnapshot,
              reviewedHead,
              null,
              extraContext,
              reviewBase,
            )
            return {
              command: buildFreshAgentCommand(agent),
              prompt: fallbackPrompt,
            }
          },
        }
      : undefined,
  )

  return { ok: true, taskId: live.taskId }
}
