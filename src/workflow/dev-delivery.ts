import type { Context } from '@deepseek-ai/cordis'
import { updateBaseTip } from '../agent/baseline.ts'
import { detectLinkedPr } from '../github/pr.ts'
import { shellQuote } from '../infra/develop-core.ts'
import { readDeliveryStats, readIntegratedRemoteTip } from '../infra/git.ts'
import { parseUrl, runCommand } from '../infra/runtime.ts'
import type { LiveTask } from '../infra/runtime.ts'
import { appendLog, type IssueWorkflow, loadWorkflow, type WorkflowEvent } from '../infra/state.ts'
import { deriveEventRound } from './delivery-audit.ts'
import { buildDevComment, buildReviewComment } from './delivery-comment.ts'
import { extractGithubCommentId } from './delivery-publication.ts'
import { publishDeliveryComment } from './delivery-publish.ts'
import { workflowBaseBranch } from './state-view.ts'
import { mutateLiveTaskWorkflow } from './task-lease.ts'

/** Record one dev/rework delivery and publish its matching GitHub node. */
export async function recordDevDelivery(
  ctx: Context,
  workflow: IssueWorkflow,
  agent: 'codex' | 'claude',
  head: string | null,
  fixedIssues: string[],
  kind: 'dev' | 'rework' | 'resume',
  live: LiveTask,
  userContext = '',
  durationMs?: number,
): Promise<void> {
  const current = await loadWorkflow(workflow.key)
  if (!current) return
  const detectedPr = current.prNumber ?? (await detectLinkedPr(ctx, current.repoKey, current.branch))
  const remoteBase = current.baseRef ? `origin/${workflowBaseBranch(current.baseRef)}` : null
  const integratedTip =
    head && remoteBase ? await readIntegratedRemoteTip(ctx, current.worktree, remoteBase, head) : null
  const stats = head
    ? await readDeliveryStats(ctx, current.worktree, workflowBaseBranch(current.baseRef), head)
    : undefined
  const at = new Date().toISOString()
  let event!: WorkflowEvent
  const saved = await mutateLiveTaskWorkflow(live, current, (latest) => {
    event = {
      kind,
      at,
      ...(Number.isFinite(durationMs) ? { durationMs: Math.max(0, durationMs ?? 0) } : {}),
      hash: head ?? undefined,
      round: deriveEventRound(latest.events),
      agent,
      ...(stats ? { stats } : {}),
      taskId: live.taskId,
      fixed: fixedIssues.length,
      note: `${agent} 完成开发${kind === 'rework' ? '(按 review 意见返工)' : ''}`,
      ...(userContext !== '' ? { userContext } : {}),
    }
    if (integratedTip && remoteBase) latest.baseRef = updateBaseTip(latest.baseRef, remoteBase, integratedTip)
    if (!latest.prNumber) latest.prNumber = detectedPr
    latest.events = [...(latest.events ?? []), event]
  })
  if (saved.status === 'ownership-lost') return
  const round = event.round ?? deriveEventRound(current.events)
  const body = buildDevComment({
    commit: head ?? 'unknown',
    issueNumber: parseUrl(current.url)?.number ?? 'unknown',
    fixedIssues,
    agent,
    round,
    stats,
    at: event.at,
  })
  await publishDeliveryComment(ctx, current, event, body, live)
  if (fixedIssues.length > 0 && kind !== 'dev') await markPreviousReviewFixed(ctx, current, round, agent)
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
  const body = buildReviewComment({
    commit: reviewEvent.hash ?? 'unknown',
    issueNumber: parseUrl(workflow.url)?.number ?? 'unknown',
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
