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
  lines.push('b=$(git branch --show-current 2>/dev/null)')
  section('WT_BRANCH', '$?', '"$b"')
  lines.push('s=$(git status --porcelain 2>/dev/null)')
  section('WT_STATUS', '$?', '"$s"')

  lines.push(`m=$(git rev-parse --short ${shellQuote('main')} 2>/dev/null)`)
  section('WT_MAIN', '$?', '"$m"')
  lines.push(`mc=$(git rev-list --left-right --count ${shellQuote('main')}...${shellQuote('HEAD')} 2>/dev/null)`)
  section('WT_MAIN_COUNT', '$?', '"$mc"')

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

export function parseWorktreeSample(output: string): WorktreeSample {
  const sections = decodeSections(output)

  const head = optionalRef(sections.get('WT_HEAD'))
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
      const mainCompare = compare(sections.get('WT_MAIN_COUNT'))
      if (mainCompare) {
        behindMain = mainCompare.behind
        aheadOfMain = mainCompare.ahead
      }
    }
    originMainHead = optionalRef(sections.get('WT_BASE'))
    // The shell resolves the applicable compare (origin base when present,
    // frozen hash otherwise, nothing when both absent) and a failed/empty
    // compare parses to null here, which keeps the legacy zero counts.
    const baseCount = compare(sections.get('WT_BASE_COUNT'))
    if (baseCount) {
      behindBase = baseCount.behind
      aheadOfBase = baseCount.ahead
    }
    if (branch) {
      upstreamHead = optionalRef(sections.get('WT_UPSTREAM'))
      if (upstreamHead) {
        const upstreamCompare = compare(sections.get('WT_UP_COUNT'))
        if (upstreamCompare) {
          behindUpstream = upstreamCompare.behind
          aheadOfUpstream = upstreamCompare.ahead
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
  return { gitFacts, branchFacts }
}

export async function sampleWorktreeFacts(ctx: Context, input: WorktreeSampleInput): Promise<WorktreeSample> {
  const output = await runCommand(ctx, buildWorktreeSampleCommand(input), {
    workdir: input.worktree,
    timeoutMs: 10000,
    sandboxPolicy: { mode: 'read-only', workspaceRoot: input.worktree },
  })
  return parseWorktreeSample(output)
}
