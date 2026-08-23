
/**
 * clickvibe host half — routes:
 * - `/clickvibe/api/fetch`          — fetch GitHub issue/PR data via gh
 * - `/clickvibe/api/command`        — text-command entry (issue #13): conversation
 *                                      triggers reuse the same action handlers below
 * - `/clickvibe/api/state`          — restore panel context (all workflows)
 * - `/clickvibe/api/develop`        — start dev: worktree+branch+agent
 * - `/clickvibe/api/develop/poll`   — incremental dev log/status (JSON)
 * - `/clickvibe/api/history`        — complete disk-backed task history
 * - `/clickvibe/api/stream`         — SSE live status stream for a task
 * - `/clickvibe/api/review`         — review the dev branch with codex/claude
 * - `/clickvibe/api/resume`         — resume an interrupted dev session
 * - `/clickvibe/api/sync`           — sync the worktree with the remote base (issue #5)
 *
 * Workflow per issue (persisted under ~/.clickvibe/state/):
 *   developing → review-ready → reviewing → passed
 *                      ↑                  │
 *                      └── rework ────────┘
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  shellQuote,
} from './develop-core.ts'
import { runCommand } from './runtime.ts'
import {
  type IssueContractSnapshot,
} from './state.ts'

interface GitCompare {
  behind: number
  ahead: number
}

interface PrFactForDerivation {
  number: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  mergedAt: string | null
  headRefName: string
  url: string
  reviewDecision: string | null
  headRefOid?: string
  baseRefName?: string
}

export interface DeriveOptions {
  pr?: PrFactForDerivation | null
  prStatusKnown?: boolean
  branchExists?: boolean
  hasCommits?: boolean
  defaultBranch?: string
  issueContract?: IssueContractSnapshot | null
}

/** Short hash of one ref inside the worktree's repo (null when unresolvable). */
export async function readRefShort(ctx: Context, workdir: string, ref: string): Promise<string | null> {
  try {
    const spec = ctx.shell.resolve({
      command: `git rev-parse --short ${shellQuote(ref)}`,
      workdir,
      timeoutMs: 10000,
      sandboxPolicy: { mode: 'read-only', workspaceRoot: workdir },
    })
    const result = await ctx.shell.run(spec)
    if (result.exitCode !== 0) return null
    const out = result.stdout.text.trim()
    return out === '' ? null : out
  } catch {
    return null
  }
}

/** Current branch of the worktree (null when detached or missing). */
export async function readBranch(ctx: Context, workdir: string): Promise<string | null> {
  try {
    const spec = ctx.shell.resolve({
      command: 'git branch --show-current',
      workdir,
      timeoutMs: 10000,
      sandboxPolicy: { mode: 'read-only', workspaceRoot: workdir },
    })
    const result = await ctx.shell.run(spec)
    if (result.exitCode !== 0) return null
    const out = result.stdout.text.trim()
    return out === '' ? null : out
  } catch {
    return null
  }
}

/** Ahead/behind of `right` relative to `left` (commits in left but not in right = behind). */
export async function readRevCount(
  ctx: Context,
  workdir: string,
  left: string,
  right: string,
): Promise<GitCompare | null> {
  try {
    const spec = ctx.shell.resolve({
      command: `git rev-list --left-right --count ${shellQuote(left)}...${shellQuote(right)}`,
      workdir,
      timeoutMs: 10000,
      sandboxPolicy: { mode: 'read-only', workspaceRoot: workdir },
    })
    const result = await ctx.shell.run(spec)
    if (result.exitCode !== 0) return null
    const [behind, ahead] = result.stdout.text.trim().split(/\s+/).map(Number)
    if (!Number.isFinite(behind) || !Number.isFinite(ahead)) return null
    return { behind, ahead }
  } catch {
    return null
  }
}

/** True when the worktree sits in an unresolved conflicted merge (MERGE_HEAD exists). */
export async function hasMergeConflict(ctx: Context, workdir: string): Promise<boolean> {
  return (await readRefShort(ctx, workdir, 'MERGE_HEAD')) !== null
}

/** List unresolved conflict files (git diff --name-only --diff-filter=U).
 *  Empty when none or unreadable — callers treat it as best-effort detail. */
export async function listConflictFiles(ctx: Context, workdir: string): Promise<string[]> {
  try {
    const output = await runCommand(ctx, 'git diff --name-only --diff-filter=U', {
      workdir,
      timeoutMs: 10000,
      sandboxPolicy: { mode: 'read-only', workspaceRoot: workdir },
    })
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

/** Format a conflict-file list as a readable suffix (";冲突文件:a、b"), '' when none. */
export function conflictFileSuffix(files: string[]): string {
  return files.length > 0 ? `;冲突文件:${files.join('、')}` : ''
}

/** Preface instruction for resume/rework agents when the worktree is not on the
 *  latest base: merge origin/<base> (and resolve any conflict) before continuing
 *  (issue #26). Empty when the worktree is already up to date. */
export async function buildMergePreface(ctx: Context, worktree: string, baseBranch: string): Promise<string> {
  if (await hasMergeConflict(ctx, worktree)) {
    const files = await listConflictFiles(ctx, worktree)
    return `注意:worktree 里有一次未完成的合并(origin/${baseBranch})冲突${conflictFileSuffix(files)}。请先用 git status 查看冲突文件,解决全部冲突并完成 git commit,然后再继续后续任务。`
  }
  const compare = await readRevCount(ctx, worktree, `origin/${baseBranch}`, 'HEAD')
  if (compare && compare.behind > 0) {
    return `注意:本地分支落后 origin/${baseBranch}。请先执行 git merge --no-edit origin/${baseBranch}(如有冲突,解决后完成提交),然后再继续后续任务。`
  }
  return ''
}
