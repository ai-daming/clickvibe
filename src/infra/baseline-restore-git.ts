import type { Context } from '@deepseek-ai/cordis'
import { shellQuote } from './develop-core.ts'
import { runCommand } from './runtime.ts'

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
