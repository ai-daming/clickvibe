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
import { shellQuote } from './develop-core.ts'
import { runCommand } from './runtime.ts'
import { type IssueContractSnapshot } from './state.ts'
import type { DeliveryStats } from './contracts.ts'

export interface GitCompare {
  behind: number
  ahead: number
}

export interface WorkflowGitFacts {
  head: string | null
  branch: string | null
  hasUncommittedChanges: boolean
  mainHead: string | null
  main: GitCompare | null
  originMainHead: string | null
  originMain: GitCompare | null
  upstreamHead: string | null
  upstream: GitCompare | null
  branchExists: boolean
  hasCommits: boolean
  defaultBranch: string
  mergeConflict: boolean
}

const WORKFLOW_GIT_SECTION = 'CLICKVIBE_WORKFLOW_GIT_'

function parseCompare(value: string | undefined): GitCompare | null {
  if (!value) return null
  const [behind, ahead] = value.trim().split(/\s+/).map(Number)
  return Number.isFinite(behind) && Number.isFinite(ahead) ? { behind, ahead } : null
}

/** Parse the bounded, line-oriented snapshot emitted by readWorkflowGitFacts. */
export function parseWorkflowGitFacts(output: string): WorkflowGitFacts {
  const sections = new Map<string, string[]>()
  let current = ''
  for (const line of output.split('\n')) {
    if (line.startsWith(WORKFLOW_GIT_SECTION)) {
      current = line.slice(WORKFLOW_GIT_SECTION.length)
      sections.set(current, [])
    } else if (current) {
      sections.get(current)?.push(line)
    }
  }

  const status = sections.get('STATUS') ?? []
  const branchLine = status.find((line) => line.startsWith('# branch.head '))
  const branchValue = branchLine?.slice('# branch.head '.length).trim() ?? ''
  const branch = branchValue === '' || branchValue === '(detached)' ? null : branchValue
  const refs = new Map<string, { head: string; compare: GitCompare | null; defaultCompare: string | undefined }>()
  for (const line of sections.get('REFS') ?? []) {
    const [ref, head, _symref, compare, defaultCompare] = line.split('\t')
    if (ref && head) refs.set(ref, { head, compare: parseCompare(compare), defaultCompare })
  }
  const main = refs.get('refs/heads/main')
  const originMain = refs.get('refs/remotes/origin/main')
  const upstream = branch ? refs.get(`refs/remotes/origin/${branch}`) : undefined
  const originHeadLine = (sections.get('REFS') ?? []).find((line) => line.startsWith('refs/remotes/origin/HEAD\t'))
  const defaultBranch = originHeadLine?.split('\t')[2]?.replace(/^origin\//, '') || 'main'
  const expectedBranch = sections.get('EXPECTED_BRANCH')?.find(Boolean)?.trim() ?? ''
  const expected = refs.get(`refs/heads/${expectedBranch}`) ?? refs.get(`refs/remotes/origin/${expectedBranch}`)
  const expectedDefaultCompare = parseCompare(expected?.defaultCompare)

  return {
    head: sections.get('HEAD')?.find(Boolean)?.trim() || null,
    branch,
    hasUncommittedChanges: status.some((line) => line !== '' && !line.startsWith('# ')),
    mainHead: main?.head ?? null,
    main: main?.compare ?? null,
    originMainHead: originMain?.head ?? null,
    originMain: originMain?.compare ?? null,
    upstreamHead: upstream?.head ?? null,
    upstream: upstream?.compare ?? null,
    branchExists: expected !== undefined,
    hasCommits: (expectedDefaultCompare?.behind ?? 0) > 0,
    defaultBranch,
    mergeConflict: Boolean(sections.get('MERGE_HEAD')?.find(Boolean)?.trim()),
  }
}

/** Read every live worktree fact through one host-managed subprocess. */
export async function readWorkflowGitFacts(
  ctx: Context,
  workdir: string,
  expectedBranch: string,
): Promise<WorkflowGitFacts> {
  const expectedLocalRef = `refs/heads/${expectedBranch}`
  const expectedRemoteRef = `refs/remotes/origin/${expectedBranch}`
  const command = [
    'status_output=$(git status --porcelain=v2 --branch 2>/dev/null || true)',
    "branch=''",
    'while IFS= read -r line; do',
    '  case "$line" in',
    `    '# branch.head '*) branch=\${line#\\# branch.head } ;;`,
    '  esac',
    'done <<CLICKVIBE_STATUS_INPUT',
    '$status_output',
    'CLICKVIBE_STATUS_INPUT',
    `printf '%s\\n' '${WORKFLOW_GIT_SECTION}STATUS' "$status_output"`,
    `printf '%s\\n' '${WORKFLOW_GIT_SECTION}HEAD'`,
    'git rev-parse --short HEAD 2>/dev/null || true',
    `printf '%s\\n' '${WORKFLOW_GIT_SECTION}EXPECTED_BRANCH' ${shellQuote(expectedBranch)}`,
    `printf '%s\\n' '${WORKFLOW_GIT_SECTION}REFS'`,
    `set -- 'refs/heads/main' 'refs/remotes/origin/main' 'refs/remotes/origin/HEAD' ${shellQuote(expectedLocalRef)} ${shellQuote(expectedRemoteRef)}`,
    'case "$branch" in \'\'|\'(detached)\') ;; *) set -- "$@" "refs/heads/$branch" "refs/remotes/origin/$branch" ;; esac',
    "default_ref=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || printf '%s' 'origin/main')",
    'git for-each-ref --format="%(refname)%09%(objectname:short)%09%(symref:short)%09%(ahead-behind:HEAD)%09%(ahead-behind:$default_ref)" "$@" 2>/dev/null || true',
    `printf '%s\\n' '${WORKFLOW_GIT_SECTION}MERGE_HEAD'`,
    'git rev-parse --verify --short MERGE_HEAD 2>/dev/null || true',
    `printf '%s\\n' '${WORKFLOW_GIT_SECTION}END'`,
  ].join('\n')
  const output = await runCommand(ctx, command, {
    workdir,
    timeoutMs: 10000,
    sandboxPolicy: { mode: 'read-only', workspaceRoot: workdir },
  })
  return parseWorkflowGitFacts(output)
}

/** Freeze commit and per-file numstat facts for fork-point..head. */
export async function readDeliveryStats(
  ctx: Context,
  workdir: string,
  baseBranch: string,
  head: string,
): Promise<DeliveryStats | undefined> {
  try {
    const policy = { mode: 'read-only' as const, workspaceRoot: workdir }
    const execute = async (command: string): Promise<string | null> => {
      const spec = ctx.shell.resolve({ command, workdir, timeoutMs: 10_000, sandboxPolicy: policy })
      const result = await ctx.shell.run(spec)
      return result.exitCode === 0 ? result.stdout.text : null
    }
    const base = (await execute(`git merge-base ${shellQuote(`origin/${baseBranch}`)} ${shellQuote(head)}`))?.trim()
    if (!base) return undefined
    const range = `${base}..${head}`
    const [logOutput, numstatOutput] = await Promise.all([
      execute(`git log --format='%h%x1f%s' ${shellQuote(range)}`),
      execute(`git diff --numstat --no-renames ${shellQuote(range)}`),
    ])
    if (logOutput === null || numstatOutput === null) return undefined
    const commits = logOutput
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf('\u001f')
        return separator < 0
          ? { hash: line.trim(), subject: '' }
          : { hash: line.slice(0, separator), subject: line.slice(separator + 1) }
      })
    const diffstat = numstatOutput
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [added, removed, ...pathParts] = line.split('\t')
        return {
          path: pathParts.join('\t'),
          insertions: added === '-' ? null : Number(added),
          deletions: removed === '-' ? null : Number(removed),
        }
      })
    return {
      commits,
      filesChanged: diffstat.length,
      insertions: diffstat.reduce((total, file) => total + (file.insertions ?? 0), 0),
      deletions: diffstat.reduce((total, file) => total + (file.deletions ?? 0), 0),
      diffstat,
    }
  } catch {
    return undefined
  }
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
  workflowCachePresent?: boolean
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
