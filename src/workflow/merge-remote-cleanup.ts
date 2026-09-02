/** Remote branch cleanup settlement for ADR-0011 Slice C. */

import type { Context } from '@deepseek-ai/cordis'
import { recoverRemotePush, remoteDeleteBranchIfPresent } from '../infra/remote-git.ts'
import { type IssueWorkflow, loadWorkflow } from '../infra/state.ts'

interface CleanupOptions {
  repoPath: string
  sandboxPolicy: { mode: 'danger-full-access'; workspaceRoot: string }
  persist(): Promise<void>
}

export async function cleanupRemoteBranch(
  ctx: Context,
  workflow: IssueWorkflow,
  options: CleanupOptions,
): Promise<void> {
  const delivery = () => {
    if (!workflow.delivery) throw new Error('delivery 状态丢失,拒绝清理')
    return workflow.delivery
  }
  const persistAttempt = async (
    attempt: NonNullable<ReturnType<typeof delivery>['cleanup']['remoteBranchAttempt']>,
  ) => {
    delivery().cleanup.remoteBranchAttempt = attempt
    await options.persist()
  }
  const existing = delivery().cleanup.remoteBranchAttempt
  if (existing?.status === 'confirmed') {
    delivery().cleanup.remoteBranch = true
    await options.persist()
    return
  }
  if (existing?.status === 'prepared') {
    await recoverRemotePush(ctx, {
      repoKey: workflow.repoKey,
      repositoryId: existing.scope.repositoryId,
      remote: existing.scope.remote,
      workdir: options.repoPath,
      sandboxPolicy: options.sandboxPolicy,
      attempt: existing,
      settleAttempt: persistAttempt,
    })
    delivery().cleanup.remoteBranch = true
    await options.persist()
    return
  }

  await remoteDeleteBranchIfPresent(ctx, {
    repoKey: workflow.repoKey,
    workdir: options.repoPath,
    sandboxPolicy: options.sandboxPolicy,
    prepare: async () => {
      const current = await loadWorkflow(workflow.key)
      const currentDelivery = current?.delivery
      if (!current || !currentDelivery || currentDelivery.status === 'archived') {
        throw new Error('merge delivery 已失效,拒绝删除远端分支')
      }
      if (current.branch !== workflow.branch || currentDelivery.prHead !== delivery().prHead) {
        throw new Error('merge cleanup 凭证已变化,拒绝删除远端分支')
      }
      if (currentDelivery.cleanup.remoteBranch) throw new Error('远端分支清理步骤已由其他执行者完成')
      return {
        destinationRef: `refs/heads/${current.branch}`,
        expectedRemoteOid: currentDelivery.prHead,
      }
    },
    persistAttempt,
    settleAttempt: persistAttempt,
  })
  delivery().cleanup.remoteBranch = true
  await options.persist()
}
