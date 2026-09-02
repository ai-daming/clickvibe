/** Caller-owned persistence/recovery for Remote Git write attempts. */

import type { Context } from '@deepseek-ai/cordis'
import { recoverRemotePush } from '../infra/remote-git.ts'
import type { RemoteGitWriteAttempt } from '../infra/remote-git-coordinator.ts'
import { commitWorkflowMetadata, type IssueWorkflow, loadWorkflow, workflowRevision } from '../infra/state.ts'

export type RemoteGitAttemptKind = 'sync' | 'pr-push' | 'baseline-restore'

export type PersistRemoteGitAttempt = (
  workflow: IssueWorkflow,
  kind: RemoteGitAttemptKind,
  attempt: RemoteGitWriteAttempt,
) => Promise<IssueWorkflow>

export async function persistRemoteGitAttempt(
  workflow: IssueWorkflow,
  kind: RemoteGitAttemptKind,
  attempt: RemoteGitWriteAttempt,
): Promise<IssueWorkflow> {
  const current = await loadWorkflow(workflow.key)
  if (!current) throw new Error(`Remote Git attempt 落盘失败: workflow ${workflow.key} 不存在`)
  const updated = await commitWorkflowMetadata(current, workflowRevision(current), {
    remoteGitAttempts: { ...current.remoteGitAttempts, [kind]: attempt },
  })
  Object.assign(workflow, updated)
  return updated
}

export async function recoverWorkflowRemotePush(
  ctx: Context,
  workflow: IssueWorkflow,
  kind: RemoteGitAttemptKind,
  workdir: string,
  sandboxPolicy: { mode: 'danger-full-access'; workspaceRoot: string },
  persist: PersistRemoteGitAttempt = persistRemoteGitAttempt,
): Promise<RemoteGitWriteAttempt | null> {
  const attempt = workflow.remoteGitAttempts?.[kind]
  // `prepared` is an interrupted attempt and must be settled by readback only.
  // `unknown` is already terminal: reaching this function again means a new
  // independently authorized action may fully revalidate and create a new attempt.
  if (!attempt || attempt.status !== 'prepared') return null
  await recoverRemotePush(ctx, {
    repoKey: workflow.repoKey,
    repositoryId: attempt.scope.repositoryId,
    remote: attempt.scope.remote,
    workdir,
    sandboxPolicy,
    attempt,
    settleAttempt: async (settled) => {
      await persist(workflow, kind, settled)
    },
  })
  return workflow.remoteGitAttempts?.[kind] ?? null
}
