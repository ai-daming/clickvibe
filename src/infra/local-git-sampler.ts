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
import {
  REPOSITORY_SECTION_CONTRACT,
  type RequiredReadFailure,
  type SectionContract,
  WORKTREE_SECTION_CONTRACT,
} from './local-git-contract.ts'
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
    // Configured-checkout canary (review round 5): a path that exists but is
    // not a Git repository must fail unknown, not fold into "branch missing".
    lines.push(`g2=$(git -C ${repo} rev-parse --git-dir 2>&1)`)
    section('BR_GITDIR', '$?', '"$g2"')
    lines.push(`d=$(git -C ${repo} symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>&1)`)
    section('BR_DEFAULT', '$?', '"$d"')
  }
  // EffectiveBase (review round 4): resolved exactly once and shared by the
  // worktree compare AND the branch count — named ref (or the fetched default
  // when the workflow froze none), falling back to the frozen SHA, else none.
  lines.push('if [ ' + (input.baseBranchNeedsDefault ? '1' : '0') + ' -eq 1 ]; then')
  lines.push('  if [ -n "$d" ]; then eb="$d"; ebsrc=default-ref')
  lines.push(`  else eb=${shellQuote('origin/main')}; ebsrc=main-fallback`)
  lines.push('  fi')
  lines.push(`else eb=${shellQuote(`origin/${input.baseBranch}`)}; ebsrc=named-ref`)
  lines.push('fi')
  section('EB_NAMED', '0', '"$eb"')
  lines.push(`frozen=${shellQuote(input.frozenBase ?? '')}`)
  lines.push('if git rev-parse --short "$eb" >/dev/null 2>&1; then')
  lines.push('  ebc="$eb"; avail=1')
  lines.push('elif [ -n "$frozen" ]; then')
  lines.push('  ebc="$frozen"; ebsrc=frozen; avail=0')
  lines.push('else')
  lines.push("  ebc=''; ebsrc=none; avail=0")
  lines.push('fi')
  section('EB_COMPARE', '0', '"$ebc"')
  section('EB_SOURCE', '0', '"$ebsrc"')
  section('EB_AVAILABLE', '0', '"$avail"')

  lines.push('h=$(git rev-parse --short HEAD 2>/dev/null)')
  section('WT_HEAD', '$?', '"$h"')
  lines.push('b=$(git branch --show-current 2>&1)')
  section('WT_BRANCH', '$?', '"$b"')
  lines.push('s=$(git status --porcelain 2>&1)')
  section('WT_STATUS', '$?', '"$s"')

  lines.push(`m=$(git rev-parse --short ${shellQuote('main')} 2>/dev/null)`)
  section('WT_MAIN', '$?', '"$m"')
  lines.push(`mc=$(git rev-list --left-right --count ${shellQuote('main')}...${shellQuote('HEAD')} 2>&1)`)
  section('WT_MAIN_COUNT', '$?', '"$mc"')

  section('WT_BASE_REF', '0', '"$ebc"')
  // WT_BASE probes the NAMED ref: its absence is the formal baseRefAvailable
  // fact even when the frozen SHA still answers the compare.
  lines.push('ob=$(git rev-parse --short "$eb" 2>/dev/null)')
  section('WT_BASE', '$?', '"$ob"')
  lines.push('if [ -n "$ebc" ]; then')
  lines.push(`  bc=$(git rev-list --left-right --count "$ebc"...${shellQuote('HEAD')} 2>&1)`)
  lines.push(`else`)
  lines.push(`  bc=''`)
  lines.push(`fi`)
  section('WT_BASE_COUNT', '$?', '"$bc"')

  lines.push('if [ -n "$b" ]; then')
  lines.push('  u="origin/$b"')
  lines.push('  uo=$(git rev-parse --short "$u" 2>/dev/null)')
  section('WT_UPSTREAM', '$?', '"$uo"')
  lines.push('  uc=$(git rev-list --left-right --count "$u...HEAD" 2>&1)')
  section('WT_UP_COUNT', '$?', '"$uc"')
  lines.push('else')
  lines.push(`  printf 'WT_UPSTREAM\\t127\\t\\n'`)
  lines.push(`  printf 'WT_UP_COUNT\\t127\\t\\n'`)
  lines.push('fi')

  lines.push(`mh=$(git rev-parse --short ${shellQuote('MERGE_HEAD')} 2>/dev/null)`)
  section('WT_MERGE_HEAD', '$?', '"$mh"')

  if (input.repoPath !== null) {
    const repo = shellQuote(input.repoPath)
    // show-ref rc=1 is expected absence (branch nowhere); rc>1 is an
    // operational failure whose stderr must survive (review round 5).
    lines.push("brerr=''")
    lines.push(
      `sr1=$(git -C ${repo} show-ref --verify --quiet ${shellQuote(`refs/heads/${input.branch}`)} 2>&1); rc1=$?`,
    )
    lines.push(
      `sr2=$(git -C ${repo} show-ref --verify --quiet ${shellQuote(`refs/remotes/origin/${input.branch}`)} 2>&1); rc2=$?`,
    )
    lines.push('br=""')
    lines.push('if [ "$rc1" -eq 0 ]; then br=' + shellQuote(input.branch))
    lines.push('elif [ "$rc2" -eq 0 ]; then br=' + shellQuote(`origin/${input.branch}`))
    lines.push('fi')
    lines.push('if [ "$rc1" -eq 0 ] || [ "$rc2" -eq 0 ]; then brc=0')
    lines.push('elif [ "$rc1" -gt 1 ] || [ "$rc2" -gt 1 ]; then brc=128; brerr="$sr1$sr2"')
    lines.push('else brc=1')
    lines.push('fi')
    section('BR_REF', '$brc', '"$br"')
    section('BR_REF_ERROR', '0', '"$brerr"')
    lines.push('if [ -n "$br" ]; then')
    lines.push('  if [ -n "$ebc" ]; then')
    // The branch count shares the EffectiveBase (review round 4): a deleted
    // remote base with a live frozen SHA stays answerable instead of failing.
    section('BR_BASE_REF', '0', '"$ebc"')
    lines.push('    n=$(git -C ' + repo + ' rev-list --count "$ebc..$br" 2>&1)')
    section('BR_COMMIT_COUNT', '$?', '"$n"')
    lines.push('  else')
    lines.push("    printf 'BR_COMMIT_COUNT\\t127\\t\\n'")
    lines.push('  fi')
    lines.push('else')
    lines.push("  printf 'BR_COMMIT_COUNT\\t127\\t\\n'")
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

/** Mirror readRevCount with strict shape (review round 5): exactly two
 * non-negative safe integers, anything else is an operational failure. */
function compare(section: { rc: number; value: string } | undefined): { behind: number; ahead: number } | null {
  if (!section || section.rc !== 0) return null
  const parts = section.value.trim().split(/\s+/)
  if (parts.length !== 2) return null
  const numbers = parts.map(Number)
  if (!numbers.every((n) => Number.isSafeInteger(n) && n >= 0)) return null
  return { behind: numbers[0], ahead: numbers[1] }
}

/** Commit counts must be a single non-negative safe integer (review round 5). */
function commitCount(section: { rc: number; value: string } | undefined): number | null {
  if (!section || section.rc !== 0) return null
  const raw = section.value.trim()
  if (!/^\d+$/.test(raw)) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : null
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
  for (const label of ['EB_NAMED', 'EB_COMPARE', 'EB_SOURCE', 'EB_AVAILABLE', 'WT_BASE_REF']) {
    if (!sections.has(label)) fail(`effective-base ${label}`, undefined, true)
  }

  const head = optionalRef(headSection)
  const branch = optionalRef(sections.get('WT_BRANCH'))
  const status = sections.get('WT_STATUS')
  const hasUncommittedChanges = status ? (status.rc === 0 ? status.value !== '' : false) : false

  let mainHead: string | null = null
  let aheadOfMain = 0
  let behindMain = 0
  let originMainHead: string | null = null
  let aheadOfBase = 0
  let baseCompareAnswered = false
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
    // EffectiveBase (review round 4): the shell resolved the single compare
    // ref — named/default ref, or the frozen SHA when the named one is gone.
    // A non-empty EB_COMPARE means the compare was required; empty means no
    // base exists at all and the zero counts are expected absence.
    const effectiveBase = sections.get('EB_COMPARE')?.value.trim() ?? ''
    if (effectiveBase !== '') {
      const baseCountSection = sections.get('WT_BASE_COUNT')
      const baseCount = compare(baseCountSection)
      if (baseCount) {
        behindBase = baseCount.behind
        aheadOfBase = baseCount.ahead
        baseCompareAnswered = true
      } else {
        fail(`git rev-list --left-right --count ${effectiveBase}...HEAD`, baseCountSection, !baseCountSection)
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
  if (branchRefSection !== undefined) {
    const repoCanary = sections.get('BR_GITDIR')
    if (!repoCanary || repoCanary.rc !== 0) {
      fail(`git -C <repo> rev-parse --git-dir`, repoCanary, !repoCanary)
    }
    const defaultSection = sections.get('BR_DEFAULT')
    if (defaultSection && defaultSection.rc > 1) {
      fail('git -C <repo> symbolic-ref refs/remotes/origin/HEAD', defaultSection, false)
    }
    if (branchRefSection.rc > 1) {
      const stderr = sections.get('BR_REF_ERROR')?.value.trim() ?? ''
      requiredFailures.push({
        operation: `git -C <repo> show-ref --verify refs/heads/${'<branch>'}`,
        rc: branchRefSection.rc,
        error: stderr || '(no stderr)',
      })
    }
  }
  if (branchRefSection) {
    const defaultRef = optionalRef(sections.get('BR_DEFAULT'))
    const defaultBranch = defaultRef ? defaultRef.replace(/^origin\//, '') : ''
    if (branchRefSection.rc !== 0 || branchRefSection.value.trim() === '') {
      branchFacts.branchExists = false
      branchFacts.defaultBranch = defaultBranch || undefined
    } else {
      const branchRef = branchRefSection.value.trim()
      branchFacts.branchExists = true
      branchFacts.defaultBranch = defaultBranch || undefined
      const effectiveBase = sections.get('EB_COMPARE')?.value.trim() ?? ''
      if (effectiveBase === '') {
        // No base exists at all (named gone, no frozen SHA): the count is
        // skipped as expected absence and hasCommits stays unanswered.
      } else {
        if (!sections.has('BR_BASE_REF')) fail('effective-base BR_BASE_REF', undefined, true)
        const count = sections.get('BR_COMMIT_COUNT')
        const parsedCount = commitCount(count)
        if (parsedCount !== null) {
          // Single hasCommits answer source (review round 4): the worktree
          // compare answers when it ran against the same EffectiveBase; the
          // branch count only answers when the worktree could not.
          if (!(head !== null && baseCompareAnswered)) branchFacts.hasCommits = parsedCount > 0
        } else {
          // Review round 3: a failed branch-count read must not fold into
          // hasCommits:false — it is required whenever a base exists.
          fail(`git rev-list --count ${effectiveBase}..${branchRef}`, count, !count)
        }
      }
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

/** One enumeration of the configured checkout for the issue list (issue #122 Q3). */
export interface RepositoryEnumerationSample {
  /** All ref short names under refs/heads and refs/remotes/origin. */
  refs: string[]
  defaultBranch: string
  /** Whether origin/<defaultBranch> resolves (count base availability). */
  baseAvailable: boolean
  /** rev-list counts origin/<defaultBranch>..<local branch> for local heads. */
  counts: Record<string, number>
  /** Short HEAD of the checkout; the enumeration envelope's source revision. */
  head: string | null
}

export interface RepositoryEnumerationInput {
  repoPath: string
}

export function buildRepositoryEnumerationCommand(input: RepositoryEnumerationInput): string {
  const repo = shellQuote(input.repoPath)
  const lines: string[] = []
  const section = (key: string, rcExpr: string, valueExpr: string) =>
    lines.push(`printf '${key}\\t%d\\t%s\\n' ${rcExpr} "$(__enc ${valueExpr})"`)
  lines.push('set +e')
  lines.push(`__enc() { printf %s "$1" | base64 | tr -d '\\n'; }`)
  lines.push(`g=$(git -C ${repo} rev-parse --git-dir 2>&1)`)
  section('ENUM_GITDIR', '$?', '"$g"')
  lines.push(`h=$(git -C ${repo} rev-parse --short HEAD 2>/dev/null)`)
  section('ENUM_HEAD', '$?', '"$h"')
  lines.push(`d=$(git -C ${repo} symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>&1)`)
  section('ENUM_DEFAULT', '$?', '"$d"')
  lines.push('if [ -n "$d" ]; then db="$d"; else db=' + shellQuote('origin/main') + '; fi')
  lines.push(`r=$(git -C ${repo} for-each-ref --format='%(refname:short)' refs/heads refs/remotes/origin 2>&1)`)
  section('ENUM_REFS', '$?', '"$r"')
  lines.push('if git -C ' + repo + ' rev-parse --short "$db" >/dev/null 2>&1; then avail=1; else avail=0; fi')
  section('ENUM_BASE_AVAILABLE', '0', '"$avail"')
  lines.push('cs=""')
  lines.push('if [ "$avail" -eq 1 ]; then')
  // Counts only for local heads: the legacy right-hand side was the local
  // branch ref, so a branch that only exists on the remote was never counted.
  lines.push(`  for br in $(git -C ${repo} for-each-ref --format='%(refname:short)' refs/heads); do`)
  lines.push(`    c=$(git -C ${repo} rev-list --count "$db..$br" 2>&1); cc=$?`)
  lines.push('    cs="$cs$br\t$cc\t$c\n"')
  lines.push('  done')
  lines.push('fi')
  section('ENUM_COUNTS', '0', '"$cs"')
  return lines.join('\n')
}

export function parseRepositoryEnumeration(
  output: string,
): RepositoryEnumerationSample & { requiredFailures: RequiredReadFailure[] } {
  const sections = decodeSections(output)
  const requiredFailures: RequiredReadFailure[] = []
  const fail = (operation: string, section: { rc: number; value: string } | undefined, missing: boolean) => {
    requiredFailures.push({
      operation,
      rc: section?.rc ?? -1,
      error: missing ? '(section missing from sample output)' : (section?.value ?? '').trim(),
    })
  }
  const gitdir = sections.get('ENUM_GITDIR')
  const headSection = sections.get('ENUM_HEAD')
  if (!headSection) fail('git -C <repo> rev-parse --short HEAD', headSection, true)
  if (!gitdir || gitdir.rc !== 0) fail('git -C <repo> rev-parse --git-dir', gitdir, !gitdir)
  const defaultSection = sections.get('ENUM_DEFAULT')
  if (!defaultSection || defaultSection.rc > 1) {
    fail('git -C <repo> symbolic-ref refs/remotes/origin/HEAD', defaultSection, !defaultSection)
  }
  const refsSection = sections.get('ENUM_REFS')
  if (!refsSection || refsSection.rc !== 0)
    fail('git -C <repo> for-each-ref refs/heads refs/remotes/origin', refsSection, !refsSection)
  const defaultRef = optionalRef(defaultSection)
  const refs = (refsSection?.value ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  const availSection = sections.get('ENUM_BASE_AVAILABLE')
  if (!availSection) fail('effective-base ENUM_BASE_AVAILABLE', availSection, true)
  const baseAvailable = availSection?.value.trim() === '1'
  const counts: Record<string, number> = {}
  const countsSection = sections.get('ENUM_COUNTS')
  const countsRaw = countsSection?.value ?? ''
  if (baseAvailable) {
    // Presence and outer rc of the counts section are required whenever the
    // base is available (review round 6): no silent empty-parse fallback.
    if (!countsSection || countsSection.rc !== 0) {
      fail('git -C <repo> rev-list --count <base>..<branch> (loop)', countsSection, !countsSection)
    }
    for (const line of countsRaw.split('\n')) {
      if (line.trim() === '') continue
      const [branch, rcRaw, count] = line.split('\t')
      const rc = Number(rcRaw)
      if (!branch || !Number.isInteger(rc)) {
        fail('git -C <repo> rev-list --count <base>..<branch>', undefined, true)
        continue
      }
      if (rc !== 0 || !/^\d+$/.test((count ?? '').trim()) || !Number.isSafeInteger(Number(count))) {
        requiredFailures.push({
          operation: `git -C <repo> rev-list --count ${defaultRef ?? 'origin/main'}..${branch}`,
          rc,
          error: (count ?? '').trim() || '(no stderr)',
        })
        continue
      }
      counts[branch] = Number(count)
    }
  }
  const defaultBranch = (defaultRef ?? '').replace(/^origin\//, '') || 'main'
  return {
    refs,
    defaultBranch,
    baseAvailable,
    counts,
    head: optionalRef(headSection),
    requiredFailures,
  }
}

export async function sampleRepositoryEnumeration(
  ctx: Context,
  input: RepositoryEnumerationInput,
): Promise<RepositoryEnumerationSample> {
  const output = await runCommand(ctx, buildRepositoryEnumerationCommand(input), {
    workdir: input.repoPath,
    timeoutMs: 10000,
    sandboxPolicy: { mode: 'read-only', workspaceRoot: input.repoPath },
  })
  const parsed = parseRepositoryEnumeration(output)
  if (parsed.requiredFailures.length > 0) {
    const detail = parsed.requiredFailures
      .map((failure) => `${failure.operation} rc=${failure.rc}: ${failure.error || '(no stderr)'}`)
      .join('; ')
    throw new Error(`本地 Git 枚举必需读取失败: ${detail}`)
  }
  return parsed
}

export {
  REPOSITORY_ENUMERATION_SECTION_CONTRACT,
  REPOSITORY_SECTION_CONTRACT,
  type RequiredReadFailure,
  type SectionContract,
  WORKTREE_SECTION_CONTRACT,
} from './local-git-contract.ts'
