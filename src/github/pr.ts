import type { Context } from '@deepseek-ai/cordis'
import { githubRest } from './rest.ts'
import { githubWrite, githubWriteOutcomeError } from './writes.ts'

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
  options: {
    /** Workflow-owned Remote Git transaction, invoked only after the strict
     *  open-PR lookup proves creation is still needed. */
    beforeCreate?: () => Promise<void>
    /** Durable attempt marker hook: the caller persists the pending intent
     *  into its workflow state BEFORE the PR-create dispatch. */
    persistMarker?: () => Promise<void>
  } = {},
): Promise<{ number: string; created: boolean }> {
  // PR creation is a mutating action: a failed authoritative lookup must stop,
  // not be interpreted as "there is no PR" and create a duplicate.
  const existing = await readOpenLinkedPr(ctx, input.repoKey, input.branch)
  if (existing) return { number: existing, created: false }
  await options.beforeCreate?.()
  // Slice B: PR creation is a non-repeatable typed write with a PR-by-head
  // authoritative readback. The attempt marker lands in the caller's
  // workflow state before dispatch; a lost response settles by re-reading
  // the open-PR-by-head list (the readback has proven it exists).
  const outcome = await githubWrite(ctx, {
    operation: 'pr-create',
    input: {
      repoKey: input.repoKey,
      branch: input.branch,
      base: input.base,
      title: input.title,
      body: `Closes #${input.issueNumber}`,
    },
    persistMarker: options.persistMarker,
  })
  if (outcome.outcome !== 'confirmed') {
    throw new Error(`PR 创建未确认: ${githubWriteOutcomeError(outcome)}`)
  }
  const created = outcome.value as { number?: number } | undefined
  const number =
    created?.number !== undefined ? String(created.number) : await readOpenLinkedPr(ctx, input.repoKey, input.branch)
  if (!number) throw new Error('GitHub 创建 PR 后未返回 PR 编号')
  return { number, created: true }
}
