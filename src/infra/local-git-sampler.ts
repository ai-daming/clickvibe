/**
 * Local Git plane sampler (ADR-0007, issue #122): one compound, network-free
 * shell gathers every worktree-level git fact a refresh generation needs, so
 * N consumers cost 1 subprocess instead of ~13. The command builder and the
 * parser are pure; the parser mirrors the exact conditional semantics of the
 * legacy per-fact reads (including "unresolvable HEAD suppresses every
 * dependent ref fact" and "branch facts absent when the repo is unconfigured").
 * Sections are `KEY<TAB>rc<TAB>base64(value)` lines; base64 keeps multi-line
 * `status --porcelain` output single-line safe.
 */

import type { Context } from '@deepseek-ai/cordis'
import { type WorktreeGitFacts } from './contracts.ts'
import { shellQuote } from './develop-core.ts'
import { runCommand } from './runtime.ts'

export interface SampledBranchFacts {
  branchExists?: boolean
  hasCommits?: boolean
  defaultBranch?: string
}

export interface WorktreeSample {
  gitFacts: WorktreeGitFacts
  branchFacts: SampledBranchFacts
}

/** One required read that failed operationally (issue #122: no clean degradation). */
export interface RequiredReadFailure {
  operation: string
  rc: number
  error: string
}

export interface WorktreeSampleInput {
  /** Worktree directory: the compound command's workdir. */
  worktree: string
  /** Expected workflow branch, probed in the configured checkout. */
  branch: string
  /** Resolved base branch name used for origin/<base> comparisons. */
  baseBranch: string
  /**
   * True when the workflow baseRef carries no resolvable branch, so derive
   * falls back to the fetched default branch (origin/HEAD) for base compares.
   */
  baseBranchNeedsDefault: boolean
  /** Frozen base hash fallback (frozenBaseHash(baseRef)); null when absent. */
  frozenBase: string | null
  /** Configured repo checkout for branch facts; null when unconfigured/missing. */
  repoPath: string | null
}

export function buildWorktreeSampleCommand(input: WorktreeSampleInput): string {
  const lines: string[] = []
  const section = (key: string, rcExpr: string, valueExpr: string) =>
    lines.push(`printf '${key}\\t%d\\t%s\\n' ${rcExpr} "$(__enc ${valueExpr})"`)

  lines.push('set +e')
  lines.push(`__enc() { printf %s "$1" | base64 | tr -d '\\n'; }`)
  // Validity canary for the worktree plane. A failure here means the whole
  // sample cannot describe the scene (issue #122: fail unknown, never render).
  // Required reads capture stderr so a failure keeps its raw error text.
  lines.push('g=$(git rev-parse --git-dir 2>&1)')
  section('WT_GITDIR', '$?', '"$g"')
  // The default branch (origin/HEAD) is resolved first when the workflow
  // baseRef carries no branch of its own, mirroring derive's
  // workflowBaseBranch(baseRef, defaultBranch) resolution.
  lines.push('d=""')
  if (input.repoPath !== null) {
    const repo = shellQuote(input.repoPath)
    lines.push(`d=$(git -C ${repo} symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)`)
    section('BR_DEFAULT', '$?', '"$d"')
  }
  lines.push('if [ ' + (input.baseBranchNeedsDefault ? '1' : '0') + ' -eq 1 ]; then')
  lines.push('  if [ -n "$d" ]; then base="$d"')
  lines.push(`  else base=${shellQuote('main')}`)
  lines.push('  fi')
  lines.push(`else base=${shellQuote(`origin/${input.baseBranch}`)}`)
  lines.push('fi')

  lines.push('h=$(git rev-parse --short HEAD 2>/dev/null)')
  section('WT_HEAD', '$?', '"$h"')
  lines.push('b=$(git branch --show-current 2>&1)')
  section('WT_BRANCH', '$?', '"$b"')
  lines.push('s=$(git status --porcelain 2>&1)')
  section('WT_STATUS', '$?', '"$s"')

  lines.push(`m=$(git rev-parse --short ${shellQuote('main')} 2>/dev/null)`)
  section('WT_MAIN', '$?', '"$m"')
  lines.push(`mc=$(git rev-list --left-right --count ${shellQuote('main')}...${shellQuote('HEAD')} 2>/dev/null)`)
  section('WT_MAIN_COUNT', '$?', '"$mc"')

  section('WT_BASE_REF', '0', '"$base"')
  lines.push('ob=$(git rev-parse --short "$base" 2>/dev/null)')
  section('WT_BASE', '$?', '"$ob"')
  lines.push('if git rev-parse --short "$base" >/dev/null 2>&1; then')
  lines.push(`  bc=$(git rev-list --left-right --count "$base"...${shellQuote('HEAD')} 2>/dev/null)`)
  lines.push(`elif [ -n ${shellQuote(input.frozenBase ?? '')} ]; then`)
  lines.push(
    `  bc=$(git rev-list --left-right --count ${shellQuote(input.frozenBase ?? '')}...${shellQuote('HEAD')} 2>/dev/null)`,
  )
  lines.push(`else`)
  lines.push(`  bc=''`)
  lines.push(`fi`)
  section('WT_BASE_COUNT', '$?', '"$bc"')

  lines.push('if [ -n "$b" ]; then')
  lines.push('  u="origin/$b"')
  lines.push('  uo=$(git rev-parse --short "$u" 2>/dev/null)')
  section('WT_UPSTREAM', '$?', '"$uo"')
  lines.push('  uc=$(git rev-list --left-right --count "$u...HEAD" 2>/dev/null)')
  section('WT_UP_COUNT', '$?', '"$uc"')
  lines.push('else')
  lines.push(`  printf 'WT_UPSTREAM\\t127\\t\\n'`)
  lines.push(`  printf 'WT_UP_COUNT\\t127\\t\\n'`)
  lines.push('fi')

  lines.push(`mh=$(git rev-parse --short ${shellQuote('MERGE_HEAD')} 2>/dev/null)`)
  section('WT_MERGE_HEAD', '$?', '"$mh"')

  if (input.repoPath !== null) {
    const repo = shellQuote(input.repoPath)
    lines.push(
      `br=$(if git -C ${repo} show-ref --verify --quiet ${shellQuote(`refs/heads/${input.branch}`)}; then printf %s ${shellQuote(input.branch)}; elif git -C ${repo} show-ref --verify --quiet ${shellQuote(`refs/remotes/origin/${input.branch}`)}; then printf %s ${shellQuote(`origin/${input.branch}`)}; else exit 1; fi 2>/dev/null)`,
    )
    section('BR_REF', '$?', '"$br"')
    lines.push('if [ -n "$br" ]; then')
    lines.push(`  if [ -n ${shellQuote(input.baseBranch)} ]; then cb=${shellQuote(`origin/${input.baseBranch}`)}`)
    lines.push('  elif [ -n "$d" ]; then cb="$d"')
    lines.push(`  else cb=${shellQuote('origin/main')}`)
    lines.push('  fi')
    lines.push('  n=$(git -C ' + repo + ' rev-list --count "$cb..$br" 2>/dev/null)')
    section('BR_COMMIT_COUNT', '$?', '"$n"')
    lines.push('else')
    lines.push(`  printf 'BR_COMMIT_COUNT\\t127\\t\\n'`)
    lines.push('fi')
  }

  return lines.join('\n')
}

function decodeSections(output: string): Map<string, { rc: number; value: string }> {
  const sections = new Map<string, { rc: number; value: string }>()
  for (const line of output.split('\n')) {
    const tabIndex = line.indexOf('\t')
    if (tabIndex <= 0) continue
    const key = line.slice(0, tabIndex)
    const rest = line.slice(tabIndex + 1)
    const secondTab = rest.indexOf('\t')
    if (secondTab < 0) continue
    const rc = Number(rest.slice(0, secondTab))
    const encoded = rest.slice(secondTab + 1)
    if (!Number.isInteger(rc)) continue
    let value = ''
    try {
      value = encoded === '' ? '' : Buffer.from(encoded, 'base64').toString('utf8')
    } catch {
      value = ''
    }
    sections.set(key, { rc, value })
  }
  return sections
}

/** Mirror readRefShort: exit 0 with non-empty output resolves, anything else is absent. */
function optionalRef(section: { rc: number; value: string } | undefined): string | null {
  if (!section || section.rc !== 0) return null
  const trimmed = section.value.trim()
  return trimmed === '' ? null : trimmed
}

/** Mirror readRevCount: unparseable output behaves like a failed compare (null). */
function compare(section: { rc: number; value: string } | undefined): { behind: number; ahead: number } | null {
  if (!section || section.rc !== 0) return null
  const [behind, ahead] = section.value.trim().split(/\s+/).map(Number)
  if (!Number.isFinite(behind) || !Number.isFinite(ahead)) return null
  return { behind, ahead }
}

export function parseWorktreeSample(output: string): WorktreeSample & { requiredFailures: RequiredReadFailure[] } {
  const sections = decodeSections(output)

  const requiredFailures: RequiredReadFailure[] = []
  const fail = (operation: string, section: { rc: number; value: string } | undefined, missing: boolean) => {
    requiredFailures.push({
      operation,
      rc: section?.rc ?? -1,
      error: missing ? '(section missing from sample output)' : (section?.value ?? '').trim(),
    })
  }
  // Expected absence (unborn HEAD, missing refs) stays a null fact. Everything
  // the legacy derivation actually consumed must be present and successful,
  // otherwise the sample is operational garbage and must fail unknown
  // (issue #122 failure-mode rule; review round 2).
  const gitdir = sections.get('WT_GITDIR')
  if (!gitdir || gitdir.rc !== 0) fail('git rev-parse --git-dir', gitdir, !gitdir)
  const statusSection = sections.get('WT_STATUS')
  if (!statusSection || statusSection.rc !== 0) fail('git status --porcelain', statusSection, !statusSection)
  const branchSection = sections.get('WT_BRANCH')
  if (!branchSection || branchSection.rc !== 0) fail('git branch --show-current', branchSection, !branchSection)
  const headSection = sections.get('WT_HEAD')
  if (!headSection) fail('git rev-parse --short HEAD', headSection, true)

  const head = optionalRef(headSection)
  const branch = optionalRef(sections.get('WT_BRANCH'))
  const status = sections.get('WT_STATUS')
  const hasUncommittedChanges = status ? (status.rc === 0 ? status.value !== '' : false) : false

  let mainHead: string | null = null
  let aheadOfMain = 0
  let behindMain = 0
  let originMainHead: string | null = null
  let aheadOfBase = 0
  let behindBase = 0
  let upstreamHead: string | null = null
  let aheadOfUpstream: number | null = null
  let behindUpstream: number | null = null

  if (head !== null) {
    mainHead = optionalRef(sections.get('WT_MAIN'))
    if (mainHead) {
      const mainCount = sections.get('WT_MAIN_COUNT')
      const mainCompare = compare(mainCount)
      if (mainCompare) {
        behindMain = mainCompare.behind
        aheadOfMain = mainCompare.ahead
      } else {
        fail('git rev-list --left-right --count main...HEAD', mainCount, !mainCount)
      }
    }
    originMainHead = optionalRef(sections.get('WT_BASE'))
    // The shell resolves the applicable compare (origin base when present,
    // frozen hash otherwise, nothing when both absent). A skipped compare is
    // rc=0 with empty output and no resolvable base; anything else that does
    // not parse is an attempted read that failed (review round 2).
    const baseCountSection = sections.get('WT_BASE_COUNT')
    const baseCount = compare(baseCountSection)
    if (baseCount) {
      behindBase = baseCount.behind
      aheadOfBase = baseCount.ahead
    } else {
      const attempted =
        (baseCountSection !== undefined && baseCountSection.rc !== 0) ||
        (baseCountSection !== undefined && baseCountSection.value.trim() !== '') ||
        originMainHead !== null
      if (attempted) {
        const baseRef = sections.get('WT_BASE_REF')?.value.trim() || '<base>'
        fail(`git rev-list --left-right --count ${baseRef}...HEAD`, baseCountSection, !baseCountSection)
      }
    }
    if (branch) {
      upstreamHead = optionalRef(sections.get('WT_UPSTREAM'))
      if (upstreamHead) {
        const upstreamCount = sections.get('WT_UP_COUNT')
        const upstreamCompare = compare(upstreamCount)
        if (upstreamCompare) {
          behindUpstream = upstreamCompare.behind
          aheadOfUpstream = upstreamCompare.ahead
        } else {
          fail(`git rev-list --left-right --count origin/${branch}...HEAD`, upstreamCount, !upstreamCount)
        }
      }
    }
  }

  const mergeHead = optionalRef(sections.get('WT_MERGE_HEAD'))

  const branchRefSection = sections.get('BR_REF')
  const branchFacts: SampledBranchFacts = {}
  if (branchRefSection) {
    const defaultRef = optionalRef(sections.get('BR_DEFAULT'))
    const defaultBranch = defaultRef ? defaultRef.replace(/^origin\//, '') : ''
    if (branchRefSection.rc !== 0 || branchRefSection.value.trim() === '') {
      branchFacts.branchExists = false
      branchFacts.defaultBranch = defaultBranch || undefined
    } else {
      const count = sections.get('BR_COMMIT_COUNT')
      branchFacts.branchExists = true
      branchFacts.hasCommits = !!count && count.rc === 0 && Number(count.value.trim()) > 0
      branchFacts.defaultBranch = defaultBranch || undefined
    }
  }

  const gitFacts: WorktreeGitFacts = {
    exists: true,
    head,
    branch,
    hasUncommittedChanges,
    mainHead,
    aheadOfMain,
    behindMain,
    originMainHead,
    aheadOfBase,
    behindBase,
    upstreamHead,
    aheadOfUpstream,
    behindUpstream,
    mergeConflict: mergeHead !== null,
  }
  return { gitFacts, branchFacts, requiredFailures }
}

export async function sampleWorktreeFacts(ctx: Context, input: WorktreeSampleInput): Promise<WorktreeSample> {
  const output = await runCommand(ctx, buildWorktreeSampleCommand(input), {
    workdir: input.worktree,
    timeoutMs: 10000,
    sandboxPolicy: { mode: 'read-only', workspaceRoot: input.worktree },
  })
  const parsed = parseWorktreeSample(output)
  if (parsed.requiredFailures.length > 0) {
    // Issue #122: a failed required read is unknown, never clean/false. The
    // raw operation, exit code and error text travel with the error so the
    // retry-once-then-unknown path keeps the original evidence.
    const detail = parsed.requiredFailures
      .map((failure) => `${failure.operation} rc=${failure.rc}: ${failure.error || '(no stderr)'}`)
      .join('; ')
    throw new Error(`本地 Git 必需读取失败: ${detail}`)
  }
  return parsed
}

/** One sampled observation of the configured repository checkout. */
export interface RepositorySample {
  defaultBranch: string
  checkoutBranch: string | null
  /** ahead/behind of local `main` versus origin/<defaultBranch>. */
  main: { ahead: number; behind: number } | null
  /** ahead/behind of the checked-out HEAD versus origin/<defaultBranch>. */
  checkout: { ahead: number; behind: number } | null
  /** Short HEAD of the checkout; the repo envelope's source revision. */
  head: string | null
}

export interface RepositorySampleInput {
  /** Configured repository checkout directory (the command workdir). */
  repoPath: string
}

export function buildRepositorySampleCommand(input: RepositorySampleInput): string {
  void input.repoPath
  const lines: string[] = []
  const section = (key: string, rcExpr: string, valueExpr: string) =>
    lines.push(`printf '${key}\\t%d\\t%s\\n' ${rcExpr} "$(__enc ${valueExpr})"`)
  lines.push('set +e')
  lines.push(`__enc() { printf %s "$1" | base64 | tr -d '\\n'; }`)
  lines.push('d=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)')
  section('REPO_DEFAULT', '$?', '"$d"')
  lines.push(`if [ -n "$d" ]; then base="$d"`)
  lines.push(`else base='origin/main'`)
  lines.push('fi')
  lines.push('b=$(git branch --show-current 2>&1)')
  section('REPO_BRANCH', '$?', '"$b"')
  lines.push('r=$(git rev-parse --short HEAD 2>/dev/null)')
  section('REPO_HEAD', '$?', '"$r"')
  lines.push(`mc=$(git rev-list --left-right --count "$base"...${shellQuote('main')} 2>&1)`)
  section('REPO_MAIN_COUNT', '$?', '"$mc"')
  lines.push('if [ -n "$b" ]; then')
  lines.push(`  cc=$(git rev-list --left-right --count "$base"...'HEAD' 2>&1)`)
  section('REPO_HEAD_COUNT', '$?', '"$cc"')
  lines.push('else')
  lines.push(`  printf 'REPO_HEAD_COUNT\\t127\\t\\n'`)
  lines.push('fi')
  return lines.join('\n')
}

export function parseRepositorySample(output: string): RepositorySample & { requiredFailures: RequiredReadFailure[] } {
  const sections = decodeSections(output)
  const requiredFailures: RequiredReadFailure[] = []
  const fail = (operation: string, section: { rc: number; value: string } | undefined, missing: boolean) => {
    requiredFailures.push({
      operation,
      rc: section?.rc ?? -1,
      error: missing ? '(section missing from sample output)' : (section?.value ?? '').trim(),
    })
  }
  // REPO_DEFAULT is deliberately not required: an unset origin/HEAD is a
  // legitimate repository state and legacy falls back to main (issue #122).
  const branchSection = sections.get('REPO_BRANCH')
  if (!branchSection || branchSection.rc !== 0) fail('git branch --show-current', branchSection, !branchSection)
  const headSection = sections.get('REPO_HEAD')
  if (!headSection) fail('git rev-parse --short HEAD', headSection, true)
  const defaultRef = optionalRef(sections.get('REPO_DEFAULT'))
  const defaultBranch = (defaultRef ?? '').replace(/^origin\//, '') || 'main'
  const checkoutBranch = optionalRef(branchSection)
  const mainCount = sections.get('REPO_MAIN_COUNT')
  const main = compare(mainCount)
  if (!main) fail('git rev-list --left-right --count <base>...main', mainCount, !mainCount)
  const checkoutCount = sections.get('REPO_HEAD_COUNT')
  const checkout = checkoutBranch === null ? null : compare(checkoutCount)
  if (checkoutBranch !== null && checkout === null) {
    fail('git rev-list --left-right --count <base>...HEAD', checkoutCount, !checkoutCount)
  }
  return {
    defaultBranch,
    checkoutBranch,
    main,
    checkout,
    head: optionalRef(headSection),
    requiredFailures,
  }
}

export async function sampleRepositoryFacts(ctx: Context, input: RepositorySampleInput): Promise<RepositorySample> {
  const output = await runCommand(ctx, buildRepositorySampleCommand(input), {
    workdir: input.repoPath,
    timeoutMs: 10000,
    sandboxPolicy: { mode: 'read-only', workspaceRoot: input.repoPath },
  })
  const parsed = parseRepositorySample(output)
  if (parsed.requiredFailures.length > 0) {
    const detail = parsed.requiredFailures
      .map((failure) => `${failure.operation} rc=${failure.rc}: ${failure.error || '(no stderr)'}`)
      .join('; ')
    throw new Error(`本地 Git 仓库必需读取失败: ${detail}`)
  }
  return parsed
}
