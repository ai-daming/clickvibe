/** Git I/O facts and mutations for a configured repository checkout. */
import type { Context } from '@deepseek-ai/cordis'
import { shellQuote } from './develop-core.ts'
import { type GitCompare, readBranch, readRevCount } from './git.ts'
import { runCommand } from './runtime.ts'

export interface RepositoryGitFacts {
  defaultBranch: string
  checkoutBranch: string | null
  main: GitCompare | null
  checkout: GitCompare | null
}

export interface RepositorySyncGitFacts extends RepositoryGitFacts {
  dirty: boolean | null
}

export async function readRepositoryGitFacts(ctx: Context, repoPath: string): Promise<RepositoryGitFacts> {
  const defaultRef = await runCommand(ctx, 'git symbolic-ref --quiet --short refs/remotes/origin/HEAD', {
    workdir: repoPath,
    timeoutMs: 3_000,
    sandboxPolicy: { mode: 'read-only', workspaceRoot: repoPath },
  }).catch(() => '')
  const defaultBranch = defaultRef.replace(/^origin\//, '') || 'main'
  const checkoutBranch = await readBranch(ctx, repoPath)
  const remoteRef = `origin/${defaultBranch}`
  const [main, checkout] = await Promise.all([
    readRevCount(ctx, repoPath, remoteRef, 'main'),
    checkoutBranch === null ? Promise.resolve(null) : readRevCount(ctx, repoPath, remoteRef, 'HEAD'),
  ])
  return { defaultBranch, checkoutBranch, main, checkout }
}

export async function readRepositorySyncGitFacts(ctx: Context, repoPath: string): Promise<RepositorySyncGitFacts> {
  const [facts, porcelain] = await Promise.all([
    readRepositoryGitFacts(ctx, repoPath),
    runCommand(ctx, 'git status --porcelain', {
      workdir: repoPath,
      timeoutMs: 10_000,
      sandboxPolicy: { mode: 'read-only', workspaceRoot: repoPath },
    }).catch(() => null),
  ])
  return { ...facts, dirty: porcelain === null ? null : porcelain !== '' }
}

export async function mergeRepositoryCheckout(
  ctx: Context,
  repoPath: string,
  remoteRef: string,
  fastForwardOnly: boolean,
): Promise<void> {
  await runCommand(ctx, `git merge ${fastForwardOnly ? '--ff-only' : '--no-edit'} ${shellQuote(remoteRef)}`, {
    workdir: repoPath,
    timeoutMs: 60_000,
    sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: repoPath },
  })
}

export async function forwardLocalMain(ctx: Context, repoPath: string, remoteRef: string): Promise<void> {
  await runCommand(ctx, `git branch -f main ${shellQuote(remoteRef)}`, {
    workdir: repoPath,
    timeoutMs: 10_000,
    sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: repoPath },
  })
}
