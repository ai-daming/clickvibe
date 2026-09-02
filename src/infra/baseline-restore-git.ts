import type { Context } from '@deepseek-ai/cordis'
import { remoteFetch, remotePush } from './remote-git.ts'
import type { RemoteGitWriteAttempt } from './remote-git-coordinator.ts'
import { shellQuote } from './develop-core.ts'
import { runCommand } from './runtime.ts'
import type { WorkflowStorageIdentity } from './state-layout.ts'
import { withBaselineRestoreWorkflowLocksCommand } from './workflow-persistence.ts'

type BaselineRestoreWorkflowTransaction = Parameters<typeof withBaselineRestoreWorkflowLocksCommand>[1] extends (
  transaction: infer Transaction,
) => Promise<unknown>
  ? Transaction
  : never

/** Serialize restore validation/push with every durable write to the related workflows. */
export function withBaselineWorkflowLocks<T>(
  workflows: WorkflowStorageIdentity[],
  operation: (transaction: BaselineRestoreWorkflowTransaction) => Promise<T>,
): Promise<T> {
  return withBaselineRestoreWorkflowLocksCommand(workflows, operation)
}

/** Select the one known tip that contains every other durable tip; divergence fails closed. */
export async function latestKnownBaseHash(ctx: Context, repoPath: string, hashes: string[]): Promise<string> {
  const candidates = [...new Set(hashes.map((hash) => hash.trim()).filter(Boolean))]
  if (candidates.length === 0) throw new Error('没有可恢复的已知基线提交')
  if (candidates.length === 1) return candidates[0]
  const policy = { mode: 'read-only' as const, workspaceRoot: repoPath }
  for (const candidate of candidates) {
    let containsAll = true
    for (const older of candidates) {
      if (older === candidate) continue
      try {
        await runCommand(
          ctx,
          `git merge-base --is-ancestor ${shellQuote(`${older}^{commit}`)} ${shellQuote(`${candidate}^{commit}`)}`,
          { workdir: repoPath, timeoutMs: 10_000, sandboxPolicy: policy },
        )
      } catch {
        containsAll = false
        break
      }
    }
    if (containsAll) return candidate
  }
  throw new Error('共享基线存在互不包含的已知 tip,拒绝自动恢复')
}

/** Atomically recreate one missing origin branch at an exact existing commit. */
export async function restoreMissingOriginBranch(
  ctx: Context,
  repoKey: string,
  repoPath: string,
  branch: string,
  hash: string,
  hooks: {
    persistAttempt(attempt: RemoteGitWriteAttempt): Promise<void>
    settleAttempt(attempt: RemoteGitWriteAttempt): Promise<void>
  },
): Promise<void> {
  const policy = { mode: 'danger-full-access' as const, workspaceRoot: repoPath }
  await remoteFetch(ctx, { repoKey, workdir: repoPath, timeoutMs: 60_000, sandboxPolicy: policy })
  const frozen = await runCommand(ctx, `git rev-parse --verify ${shellQuote(`${hash}^{commit}`)}`, {
    workdir: repoPath,
    timeoutMs: 10_000,
    sandboxPolicy: policy,
  })
  await remotePush(ctx, {
    repoKey,
    workdir: repoPath,
    timeoutMs: 120_000,
    sandboxPolicy: policy,
    prepare: async () => {
      const destinationRef = `refs/heads/${branch}`
      const observed = await runCommand(ctx, `git ls-remote --heads origin ${shellQuote(destinationRef)}`, {
        workdir: repoPath,
        timeoutMs: 30_000,
        sandboxPolicy: policy,
      })
      const expectedRemoteOid = observed.trim().split(/\s+/)[0] || null
      if (expectedRemoteOid !== null && expectedRemoteOid !== frozen) {
        throw new Error(`远端基线 origin/${branch} 已由其他操作恢复到不同提交,拒绝覆盖`)
      }
      return {
        operationKind: 'force-with-lease' as const,
        destinationRef,
        expectedOid: frozen,
        expectedRemoteOid,
      }
    },
    persistAttempt: hooks.persistAttempt,
    settleAttempt: hooks.settleAttempt,
  })
}
