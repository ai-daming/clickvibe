import type { Context } from '@deepseek-ai/cordis'
import { githubRest } from '../github/rest.ts'
import { shellQuote } from '../infra/develop-core.ts'
import { parseUrl, runCommand } from '../infra/runtime.ts'
import { appendLog, type IssueWorkflow, type WorkflowEvent } from '../infra/state.ts'
import { loadCurrentTaskWorkflow, saveCurrentTaskWorkflow, type WorkflowTaskRef } from '../infra/task-ownership.ts'
import { extractGithubCommentUrl } from './delivery-publication.ts'

/** Publish a delivery node only while its originating task still owns workflow writes. */
export async function publishDeliveryComment(
  ctx: Context,
  workflow: IssueWorkflow,
  event: WorkflowEvent,
  body: string,
  expectedTask: WorkflowTaskRef,
): Promise<boolean> {
  if (!(await loadCurrentTaskWorkflow(workflow.key, expectedTask.kind, expectedTask.taskId))) return false
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
    if (!(await loadCurrentTaskWorkflow(workflow.key, expectedTask.kind, expectedTask.taskId))) return false
    await appendLog(
      workflow.key,
      event.kind === 'review' ? 'review' : 'dev',
      `[clickvibe] 已发布 GitHub ${target === 'pr' ? 'PR' : 'Issue'} 评论${event.publication.url ? `: ${event.publication.url}` : ''}`,
    )
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).slice(0, 500)
    event.publication = { target, status: 'failed', error: message }
    if (!(await loadCurrentTaskWorkflow(workflow.key, expectedTask.kind, expectedTask.taskId))) return false
    await appendLog(
      workflow.key,
      event.kind === 'review' ? 'review' : 'dev',
      `[clickvibe] GitHub 评论发布失败: ${message}`,
    )
  }
  return saveCurrentTaskWorkflow(workflow, expectedTask.kind, expectedTask.taskId)
}
