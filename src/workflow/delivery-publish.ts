import type { Context } from '@deepseek-ai/cordis'
import { githubRest } from '../github/rest.ts'
import { shellQuote } from '../infra/develop-core.ts'
import { type LiveTask, parseUrl, runCommand } from '../infra/runtime.ts'
import { appendLog, type IssueWorkflow, type WorkflowEvent } from '../infra/state.ts'
import { extractGithubCommentUrl } from './delivery-publication.ts'
import { mutateLiveTaskWorkflow } from './task-lease.ts'

/** Publish a delivery node only while its originating task still owns workflow writes. */
export async function publishDeliveryComment(
  ctx: Context,
  workflow: IssueWorkflow,
  event: WorkflowEvent,
  body: string,
  live: LiveTask,
): Promise<boolean> {
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
  const publication = event.publication
  const saved = await mutateLiveTaskWorkflow(live, workflow, (latest) => {
    const storedEvent = latest.events.find(
      (candidate) => candidate.kind === event.kind && candidate.taskId === event.taskId && candidate.at === event.at,
    )
    if (storedEvent) storedEvent.publication = publication
  })
  return saved.status === 'committed'
}
