/** Stage-start resolution of the repository-owned current contract and prompt evidence. */
import type { Context } from '@deepseek-ai/cordis'
import type { ResolvedPromptSnapshot } from '../agent/prompts.ts'
import { githubRead } from '../github/operations.ts'
import type { GithubCommentRest } from '../github/reads.ts'
import { isGithubRateLimitError } from '../github/rest.ts'
import { commitWorkflowMetadata, type IssueWorkflow, WorkflowConflictError, workflowRevision } from '../infra/state.ts'
import { contractHasKnownCanonicalFields, observeCurrentIssueContract } from './work-item-contract-repository.ts'

async function fetchPrPromptComments(
  ctx: Context,
  workflow: IssueWorkflow,
): Promise<{ author: string; body: string }[] | null> {
  if (!workflow.prNumber) return []
  try {
    const comments = (await githubRead(ctx, {
      operation: 'pr-comments',
      repoKey: workflow.repoKey,
      number: workflow.prNumber,
      consistency: 'cache-ok',
    })) as GithubCommentRest[]
    return comments.map((comment) => ({
      author: String(comment.user?.login ?? 'unknown'),
      body: String(comment.body ?? ''),
    }))
  } catch (error) {
    if (isGithubRateLimitError(error)) throw error
    return null
  }
}

async function persistPromptWorkflow(workflow: IssueWorkflow): Promise<string | null> {
  try {
    Object.assign(
      workflow,
      await commitWorkflowMetadata(workflow, workflowRevision(workflow), {
        issueState: workflow.issueState,
      }),
    )
    return null
  } catch (error) {
    return error instanceof WorkflowConflictError
      ? 'Workflow 已由另一控制器推进,本次启动已取消;请刷新后重试'
      : `需求快照持久化失败:${String(error instanceof Error ? error.message : error)}`
  }
}

/** Refresh at stage start; privileged prompts never fall back to a legacy workflow snapshot. */
export async function resolvePromptSnapshot(
  ctx: Context,
  workflow: IssueWorkflow,
): Promise<ResolvedPromptSnapshot | { error: string }> {
  const current = await observeCurrentIssueContract(ctx, workflow.url, { force: true })
  if (current.state !== 'known') return { error: `无法确认当前 Work Item 契约: ${current.reason}` }
  if (!contractHasKnownCanonicalFields(current.snapshot))
    return { error: '当前 Work Item 契约含 unknown 字段,禁止启动阶段' }
  const snapshot = structuredClone(current.prompt)
  const prComments = await fetchPrPromptComments(ctx, workflow)
  if (prComments) snapshot.comments.push(...prComments)
  if (snapshot.state === 'OPEN' || snapshot.state === 'CLOSED') workflow.issueState = snapshot.state
  const persistenceError = await persistPromptWorkflow(workflow)
  if (persistenceError) return { error: persistenceError }
  return { snapshot, contract: current.snapshot, freshness: 'current' }
}
