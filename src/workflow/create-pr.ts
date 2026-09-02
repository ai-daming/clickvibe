import type { Context } from '@deepseek-ai/cordis'
import { ensurePullRequest } from '../github/pr.ts'
import { githubWriteOutcomeError, githubWriteRecoverOperation } from '../github/writes.ts'
import { parseUrl } from '../infra/runtime.ts'
import { appendLog, issueKey, loadWorkflow, commitWorkflowMetadata, workflowRevision } from '../infra/state.ts'
import { workflowBaseBranch } from './state-view.ts'

export async function createPullRequest(
  ctx: Context,
  payload: unknown,
): Promise<{ ok: true; prNumber: string; created: boolean } | { ok: false; error: string }> {
  const url = String((payload as { url?: unknown } | undefined)?.url ?? '').trim()
  const parsed = parseUrl(url)
  if (!parsed || parsed.kind !== 'issue') return { ok: false, error: '创建 PR 的目标必须是 GitHub Issue URL' }
  const workflow = await loadWorkflow(issueKey(`${parsed.owner}/${parsed.repo}`, parsed.number))
  if (!workflow) return { ok: false, error: '未找到该 issue 的 workflow' }
  if (workflow.issueState === 'CLOSED') return { ok: false, error: 'Issue 已关闭,拒绝创建 PR' }
  const createInput = {
    repoKey: workflow.repoKey,
    worktree: workflow.worktree,
    branch: workflow.branch,
    base: workflowBaseBranch(workflow.baseRef),
    issueNumber: parsed.number,
    title: workflow.issueSnapshot?.title || `Deliver issue #${parsed.number}`,
  }
  try {
    // Slice B restart recovery: a surviving pending marker means an earlier
    // attempt may have dispatched — readback ONLY, never a second create.
    if (workflow.prCreate?.status === 'pending') {
      const recovered = await githubWriteRecoverOperation(ctx, {
        operation: 'pr-create',
        input: {
          repoKey: createInput.repoKey,
          branch: createInput.branch,
          base: createInput.base,
          title: createInput.title,
          body: `Closes #${createInput.issueNumber}`,
        },
      })
      if (recovered.outcome !== 'confirmed') {
        return {
          ok: false,
          error: `上次 PR 创建结果未确认(${githubWriteOutcomeError(recovered)}),请稍后重试`,
        }
      }
      // Confirmed: the PR exists — fall through and adopt it via the reuse path.
    }
    const result = await ensurePullRequest(ctx, createInput, {
      persistMarker: async () => {
        // The workflow file is the create-pr action's durable state: the
        // marker must be on disk before the POST dispatches.
        Object.assign(
          workflow,
          await commitWorkflowMetadata(workflow, workflowRevision(workflow), {
            prCreate: { status: 'pending', at: new Date().toISOString() },
          }),
        )
      },
    })
    workflow.prNumber = result.number
    Object.assign(
      workflow,
      await commitWorkflowMetadata(workflow, workflowRevision(workflow), {
        prNumber: workflow.prNumber,
        prCreate: undefined,
      }),
    )
    await appendLog(workflow.key, 'dev', `[clickvibe] ${result.created ? '已创建' : '已复用'} PR #${result.number}`)
    return { ok: true, prNumber: result.number, created: result.created }
  } catch (error) {
    return { ok: false, error: String(error instanceof Error ? error.message : error) }
  }
}
