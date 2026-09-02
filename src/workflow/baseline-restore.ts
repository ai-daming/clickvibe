import type { Context } from '@deepseek-ai/cordis'
import { frozenBaseHash, frozenRemoteBase } from '../agent/baseline.ts'
import { isValidGitBranchName } from '../infra/authorization-target.ts'
import {
  latestKnownBaseHash,
  restoreMissingOriginBranch,
  withBaselineWorkflowLocks,
} from '../infra/baseline-restore-git.ts'
import { expandHome, loadConfig, parseUrl } from '../infra/runtime.ts'
import { issueKey, loadAllArchivedWorkflows, loadAllWorkflows, loadWorkflow } from '../infra/state.ts'
import type { RemoteGitWriteAttempt } from '../infra/remote-git-coordinator.ts'
import { recoverWorkflowRemotePush, type RemoteGitAttemptKind } from './remote-git-attempt.ts'

export interface BaselineRestorePreview {
  baseBranch: string
  baseHash: string
}

export async function baselineRestorePreview(ctx: Context, url: string): Promise<BaselineRestorePreview> {
  const parsed = parseUrl(url)
  if (!parsed || parsed.kind !== 'issue') throw new Error('恢复基线目标必须是 GitHub Issue URL')
  const repoKey = `${parsed.owner}/${parsed.repo}`
  const workflow = await loadWorkflow(issueKey(repoKey, parsed.number))
  if (!workflow) throw new Error('未找到可恢复基线的 workflow')
  if (workflow.prNumber) throw new Error('已有 PR,无需恢复建 PR 基线')
  const remote = frozenRemoteBase(workflow.baseRef)
  const hash = frozenBaseHash(workflow.baseRef)
  if (!remote || !hash) throw new Error('workflow 缺少可恢复的冻结基线')
  const relatedHashes = [...(await loadAllWorkflows()), ...(await loadAllArchivedWorkflows())]
    .filter((candidate) => candidate.repoKey === repoKey && frozenRemoteBase(candidate.baseRef) === remote)
    .map((candidate) => frozenBaseHash(candidate.baseRef))
    .filter((candidate): candidate is string => candidate !== null)
  const config = await loadConfig()
  const configured = config.repos[repoKey]
  if (!configured) throw new Error(`未配置项目 ${repoKey}`)
  const baseHash = await latestKnownBaseHash(ctx, expandHome(configured), relatedHashes)
  return { baseBranch: remote.replace(/^origin\//, ''), baseHash }
}

export async function restoreBaseBranch(
  ctx: Context,
  payload: unknown,
): Promise<{ ok: true; baseBranch: string; baseHash: string } | { ok: false; error: string }> {
  try {
    const body = (payload ?? {}) as { url?: unknown; restoreTarget?: unknown }
    const url = String(body.url ?? '').trim()
    const parsed = parseUrl(url)
    if (!parsed || parsed.kind !== 'issue') throw new Error('恢复基线目标必须是 GitHub Issue URL')
    const repoKey = `${parsed.owner}/${parsed.repo}`
    const config = await loadConfig()
    const configured = config.repos[repoKey]
    if (!configured) throw new Error(`未配置项目 ${repoKey}`)
    const rawTarget = body.restoreTarget as Record<string, unknown> | undefined
    const authorizedTarget = {
      baseBranch: String(rawTarget?.branch ?? '').trim(),
      baseHash: String(rawTarget?.hash ?? '').trim(),
    }
    if (!isValidGitBranchName(authorizedTarget.baseBranch) || !/^[0-9a-f]{4,64}$/i.test(authorizedTarget.baseHash)) {
      throw new Error('恢复基线缺少精确授权目标')
    }
    const key = issueKey(repoKey, parsed.number)
    const remote = `origin/${authorizedTarget.baseBranch}`
    const sharedWorkflows = [...(await loadAllWorkflows()), ...(await loadAllArchivedWorkflows())].filter(
      (workflow) => workflow.repoKey === repoKey && frozenRemoteBase(workflow.baseRef) === remote,
    )
    const requested = await loadWorkflow(key)
    if (requested && !sharedWorkflows.some((workflow) => workflow.key === key)) sharedWorkflows.push(requested)
    return await withBaselineWorkflowLocks(sharedWorkflows, async (transaction) => {
      // The authorization check and remote restoration are one serialized
      // transaction. A concurrent sync/delivery tip update must finish first
      // (making this authorization stale) or wait until this exact push ends.
      const target = await baselineRestorePreview(ctx, url)
      if (target.baseBranch !== authorizedTarget.baseBranch || target.baseHash !== authorizedTarget.baseHash) {
        throw new Error('恢复基线目标已变化,请刷新预览并重新确认')
      }
      const ownerWorkflow = await loadWorkflow(key)
      if (!ownerWorkflow) throw new Error('恢复基线 workflow 已不存在')
      const persistAttempt = async (
        workflow: typeof ownerWorkflow,
        kind: RemoteGitAttemptKind,
        attempt: RemoteGitWriteAttempt,
      ) => {
        if (kind !== 'baseline-restore') throw new Error(`baseline restore transaction cannot persist ${kind}`)
        const updated = await transaction.commitMetadata(workflow, {
          remoteGitAttempts: { ...workflow.remoteGitAttempts, [kind]: attempt },
        })
        Object.assign(workflow, updated)
        return updated
      }
      const repoPath = expandHome(configured)
      const policy = { mode: 'danger-full-access' as const, workspaceRoot: repoPath }
      const recovered = await recoverWorkflowRemotePush(
        ctx,
        ownerWorkflow,
        'baseline-restore',
        repoPath,
        policy,
        persistAttempt,
      )
      const destinationRef = `refs/heads/${target.baseBranch}`
      const recoveredSameTarget =
        recovered?.status === 'confirmed' &&
        recovered.destinationRef === destinationRef &&
        recovered.expectedOid?.startsWith(target.baseHash)
      if (!recoveredSameTarget) {
        await restoreMissingOriginBranch(ctx, repoKey, repoPath, target.baseBranch, target.baseHash, {
          persistAttempt: async (attempt) => {
            await persistAttempt(ownerWorkflow, 'baseline-restore', attempt)
          },
          settleAttempt: async (attempt) => {
            await persistAttempt(ownerWorkflow, 'baseline-restore', attempt)
          },
        })
      }
      return { ok: true as const, ...target }
    })
  } catch (error) {
    return { ok: false, error: String(error instanceof Error ? error.message : error) }
  }
}
