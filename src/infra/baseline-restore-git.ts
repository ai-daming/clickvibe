import type { Context } from '@deepseek-ai/cordis'
import { shellQuote } from './develop-core.ts'
import { runCommand } from './runtime.ts'
import type { WorkflowStorageIdentity } from './state-layout.ts'
import { withBaselineRestoreWorkflowLocksCommand } from './workflow-persistence.ts'

/** Serialize restore validation/push with every durable write to the related workflows. */
export function withBaselineWorkflowLocks<T>(
  workflows: WorkflowStorageIdentity[],
  operation: () => Promise<T>,
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
  repoPath: string,
  branch: string,
  hash: string,
): Promise<void> {
  const policy = { mode: 'danger-full-access' as const, workspaceRoot: repoPath }
  await runCommand(ctx, 'git fetch origin --prune', { workdir: repoPath, timeoutMs: 60_000, sandboxPolicy: policy })
  const remoteRef = `refs/remotes/origin/${branch}`
  const existing = await runCommand(ctx, `git rev-parse --verify ${shellQuote(remoteRef)}`, {
    workdir: repoPath,
    timeoutMs: 10_000,
    sandboxPolicy: policy,
  }).catch(() => '')
  if (existing) {
    const frozen = await runCommand(ctx, `git rev-parse --verify ${shellQuote(`${hash}^{commit}`)}`, {
      workdir: repoPath,
      timeoutMs: 10_000,
      sandboxPolicy: policy,
    })
    if (existing.trim() === frozen.trim()) return
    throw new Error(`远端基线 origin/${branch} 已由其他操作恢复到不同提交,拒绝覆盖`)
  }
  await runCommand(ctx, `git cat-file -e ${shellQuote(`${hash}^{commit}`)}`, {
    workdir: repoPath,
    timeoutMs: 10_000,
    sandboxPolicy: policy,
  })
  await runCommand(
    ctx,
    `git push --force-with-lease=${shellQuote(`refs/heads/${branch}:`)} origin ${shellQuote(`${hash}:refs/heads/${branch}`)}`,
    { workdir: repoPath, timeoutMs: 60_000, sandboxPolicy: policy },
  )
}
