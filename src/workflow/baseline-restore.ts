import type { Context } from '@deepseek-ai/cordis'
import { frozenBaseHash, frozenRemoteBase } from '../agent/baseline.ts'
import { restoreMissingOriginBranch } from '../infra/baseline-restore-git.ts'
import { expandHome, loadConfig, parseUrl } from '../infra/runtime.ts'
import { issueKey, loadWorkflow } from '../infra/state.ts'

export interface BaselineRestorePreview {
  baseBranch: string
  baseHash: string
}

export async function baselineRestorePreview(url: string): Promise<BaselineRestorePreview> {
  const parsed = parseUrl(url)
  if (!parsed || parsed.kind !== 'issue') throw new Error('恢复基线目标必须是 GitHub Issue URL')
  const repoKey = `${parsed.owner}/${parsed.repo}`
  const workflow = await loadWorkflow(issueKey(repoKey, parsed.number))
  if (!workflow) throw new Error('未找到可恢复基线的 workflow')
  if (workflow.prNumber) throw new Error('已有 PR,无需恢复建 PR 基线')
  const remote = frozenRemoteBase(workflow.baseRef)
  const hash = frozenBaseHash(workflow.baseRef)
  if (!remote || !hash) throw new Error('workflow 缺少可恢复的冻结基线')
  return { baseBranch: remote.replace(/^origin\//, ''), baseHash: hash }
}

export async function restoreBaseBranch(
  ctx: Context,
  payload: unknown,
): Promise<{ ok: true; baseBranch: string; baseHash: string } | { ok: false; error: string }> {
  try {
    const url = String((payload as { url?: unknown } | undefined)?.url ?? '').trim()
    const parsed = parseUrl(url)
    if (!parsed || parsed.kind !== 'issue') throw new Error('恢复基线目标必须是 GitHub Issue URL')
    const repoKey = `${parsed.owner}/${parsed.repo}`
    const config = await loadConfig()
    const configured = config.repos[repoKey]
    if (!configured) throw new Error(`未配置项目 ${repoKey}`)
    const target = await baselineRestorePreview(url)
    await restoreMissingOriginBranch(ctx, expandHome(configured), target.baseBranch, target.baseHash)
    return { ok: true, ...target }
  } catch (error) {
    return { ok: false, error: String(error instanceof Error ? error.message : error) }
  }
}
