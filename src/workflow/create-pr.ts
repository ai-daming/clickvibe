import type { Context } from '@deepseek-ai/cordis'
import { ensurePullRequest } from '../github/pr.ts'
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
  try {
    const result = await ensurePullRequest(ctx, {
      repoKey: workflow.repoKey,
      worktree: workflow.worktree,
      branch: workflow.branch,
      base: workflowBaseBranch(workflow.baseRef),
      issueNumber: parsed.number,
      title: workflow.issueSnapshot?.title || `Deliver issue #${parsed.number}`,
    })
    workflow.prNumber = result.number
    Object.assign(
      workflow,
      await commitWorkflowMetadata(workflow, workflowRevision(workflow), { prNumber: workflow.prNumber }),
    )
    await appendLog(workflow.key, 'dev', `[clickvibe] ${result.created ? '已创建' : '已复用'} PR #${result.number}`)
    return { ok: true, prNumber: result.number, created: result.created }
  } catch (error) {
    return { ok: false, error: String(error instanceof Error ? error.message : error) }
  }
}
