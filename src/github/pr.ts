import type { Context } from '@deepseek-ai/cordis'
import { remotePush } from '../infra/remote-git.ts'
import { notifyLocalGitMutation } from '../infra/local-git-snapshot.ts'
import { shellQuote } from '../infra/develop-core.ts'
import { runCommand } from '../infra/runtime.ts'
import { githubRest } from './rest.ts'

async function readOpenLinkedPr(ctx: Context, repoKey: string, branch: string): Promise<string | null> {
  const owner = repoKey.split('/')[0]
  const prs = await githubRest(ctx).json<Array<{ number?: number }>>(
    `repos/${repoKey}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=1`,
  )
  return prs[0]?.number === undefined ? null : String(prs[0].number)
}

/** Detect the open PR created from one branch. */
export async function detectLinkedPr(ctx: Context, repoKey: string, branch: string): Promise<string | null> {
  try {
    return await readOpenLinkedPr(ctx, repoKey, branch)
  } catch {
    return null
  }
}

/** Push one exact workflow branch and create its PR, reusing an existing open PR. */
export async function ensurePullRequest(
  ctx: Context,
  input: {
    repoKey: string
    worktree: string
    branch: string
    base: string
    issueNumber: string
    title: string
  },
): Promise<{ number: string; created: boolean }> {
  // PR creation is a mutating action: a failed authoritative lookup must stop,
  // not be interpreted as "there is no PR" and create a duplicate.
  const existing = await readOpenLinkedPr(ctx, input.repoKey, input.branch)
  if (existing) return { number: existing, created: false }
  const policy = { mode: 'danger-full-access' as const, workspaceRoot: input.worktree }
  const branch = await runCommand(ctx, 'git branch --show-current', {
    workdir: input.worktree,
    timeoutMs: 10_000,
    sandboxPolicy: { mode: 'read-only', workspaceRoot: input.worktree },
  })
  if (branch !== input.branch) throw new Error('worktree 当前分支与 workflow 不一致,拒绝创建 PR')
  const dirty = await runCommand(ctx, 'git status --porcelain', {
    workdir: input.worktree,
    timeoutMs: 10_000,
    sandboxPolicy: { mode: 'read-only', workspaceRoot: input.worktree },
  })
  if (dirty !== '') throw new Error('worktree 有未提交改动,拒绝创建 PR')
  await remotePush(ctx, {
    repoKey: input.repoKey,
    workdir: input.worktree,
    timeoutMs: 120_000,
    sandboxPolicy: policy,
    refspec: shellQuote(input.branch),
    setUpstream: true,
  })
  notifyLocalGitMutation(
    { repoKey: input.repoKey, worktreePath: input.worktree },
    'pr-create-push',
    'ensurePullRequest',
  )
  const created = await githubRest(ctx).mutate<{ number?: number }>(`repos/${input.repoKey}/pulls`, 'POST', {
    title: input.title,
    head: input.branch,
    base: input.base,
    body: `Closes #${input.issueNumber}`,
  })
  if (!created.number) throw new Error('GitHub 创建 PR 后未返回 PR 编号')
  return { number: String(created.number), created: true }
}
