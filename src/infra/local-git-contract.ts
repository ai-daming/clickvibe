/** Section contract tables for the Local Git plane (issue #122, fix-discipline). */

/** One required read that failed operationally (issue #122: no clean degradation). */
export interface RequiredReadFailure {
  operation: string
  rc: number
  error: string
}

/**
 * Complete classification of every compound-sample section (fix-discipline:
 * enumerate before fixing, so no required read is discovered one review round
 * at a time). `required` says when a missing/failed/unparseable section is an
 * operational failure that must fail the whole sample unknown:
 * - always: the section must exist and its command must succeed every time
 * - conditional: required exactly under `condition`
 * - never: absence is a legitimate fact (null/false), never a failure
 */
export interface SectionContract {
  section: string
  producer: string
  required: 'always' | 'conditional' | 'never'
  condition: string
  expectedAbsence: string
  consumer: string
  /**
   * Executable negative expectations driving the generated per-section tests:
   * how parseWorktreeSample must classify a missing section, a rc≠0 failure
   * and a garbage value. 'fail' → requiredFailures entry; 'ok' → legitimate
   * fact/absence; 'skip' → identity/label value not machine-checkable.
   */
  negative: { missing: 'fail' | 'ok'; rcNonZero: 'fail' | 'ok' | 'skip'; garbage: 'fail' | 'ok' | 'skip' }
}

export const WORKTREE_SECTION_CONTRACT: SectionContract[] = [
  {
    section: 'WT_GITDIR',
    producer: 'git rev-parse --git-dir',
    required: 'always',
    condition: 'unconditional canary',
    expectedAbsence: 'none — failure means the worktree plane is unobservable',
    consumer: 'requiredFailures gate',
    negative: { missing: 'fail', rcNonZero: 'fail', garbage: 'skip' },
  },
  {
    section: 'WT_HEAD',
    producer: 'git rev-parse --short HEAD',
    required: 'always',
    condition: 'presence; rc≠0 (unborn HEAD) is expected absence, a missing section is not',
    expectedAbsence: 'unborn HEAD → head:null',
    consumer: 'gitFacts.head and every dependent fact',
    negative: { missing: 'fail', rcNonZero: 'ok', garbage: 'skip' },
  },
  {
    section: 'WT_BRANCH',
    producer: 'git branch --show-current',
    required: 'always',
    condition: 'unconditional',
    expectedAbsence: 'empty output (detached) → branch:null',
    consumer: 'gitFacts.branch, worktreeValid, upstream lookup',
    negative: { missing: 'fail', rcNonZero: 'fail', garbage: 'skip' },
  },
  {
    section: 'WT_STATUS',
    producer: 'git status --porcelain',
    required: 'always',
    condition: 'unconditional',
    expectedAbsence: 'empty output → hasUncommittedChanges:false',
    consumer: 'gitFacts.hasUncommittedChanges',
    negative: { missing: 'fail', rcNonZero: 'fail', garbage: 'skip' },
  },
  {
    section: 'WT_MAIN',
    producer: "git rev-parse --short 'main'",
    required: 'never',
    condition: '—',
    expectedAbsence: 'missing local main → mainHead:null',
    consumer: 'gitFacts.mainHead',
    negative: { missing: 'ok', rcNonZero: 'ok', garbage: 'skip' },
  },
  {
    section: 'WT_MAIN_COUNT',
    producer: "git rev-list --left-right --count 'main'...'HEAD'",
    required: 'conditional',
    condition: 'required iff WT_MAIN resolved',
    expectedAbsence: 'WT_MAIN absent → counts stay 0',
    consumer: 'aheadOfMain/behindMain',
    negative: { missing: 'fail', rcNonZero: 'fail', garbage: 'fail' },
  },
  {
    section: 'EB_NAMED',
    producer: 'echo of the named base ref (workflow base or fetched default)',
    required: 'always',
    condition: 'unconditional label source',
    expectedAbsence: 'none',
    consumer: 'diagnostics; the named probe target',
    negative: { missing: 'fail', rcNonZero: 'skip', garbage: 'skip' },
  },
  {
    section: 'EB_COMPARE',
    producer: 'echo of the single EffectiveBase compare ref (named/default, else frozen SHA, else empty)',
    required: 'always',
    condition: 'empty value means no base exists at all (expected absence)',
    expectedAbsence: 'empty value → base compares and branch counts are skipped',
    consumer: 'WT_BASE_COUNT and BR_COMMIT_COUNT share this ref; failure labels',
    negative: { missing: 'fail', rcNonZero: 'skip', garbage: 'skip' },
  },
  {
    section: 'EB_SOURCE',
    producer: 'echo of the EffectiveBase provenance (named-ref/default-ref/main-fallback/frozen/none)',
    required: 'always',
    condition: 'unconditional provenance record',
    expectedAbsence: 'none',
    consumer: 'diagnostics',
    negative: { missing: 'fail', rcNonZero: 'skip', garbage: 'skip' },
  },
  {
    section: 'EB_AVAILABLE',
    producer: 'echo of whether the NAMED base ref resolved (1/0)',
    required: 'always',
    condition: 'unconditional; 0 with a frozen compare still yields baseRefAvailable:false',
    expectedAbsence: 'none',
    consumer: 'advisory; baseRefAvailable itself derives from WT_BASE',
    negative: { missing: 'fail', rcNonZero: 'skip', garbage: 'skip' },
  },
  {
    section: 'WT_BASE_REF',
    producer: 'echo of the effective compare ref ($base)',
    required: 'always',
    condition: 'unconditional label source',
    expectedAbsence: 'none',
    consumer: 'base failure operation label',
    negative: { missing: 'fail', rcNonZero: 'skip', garbage: 'skip' },
  },
  {
    section: 'WT_BASE',
    producer: 'git rev-parse --short "$base"',
    required: 'never',
    condition: '—',
    expectedAbsence: 'deleted remote base → originMainHead:null, baseRefAvailable:false',
    consumer: 'gitFacts.originMainHead, baseRefAvailable',
    negative: { missing: 'ok', rcNonZero: 'ok', garbage: 'skip' },
  },
  {
    section: 'WT_BASE_COUNT',
    producer: 'git rev-list --left-right --count "$base"...HEAD (frozen SHA fallback)',
    required: 'conditional',
    condition: 'required iff the base ref resolved or a frozen fallback was attempted',
    expectedAbsence: 'no base at all → counts stay 0',
    consumer: 'aheadOfBase/behindBase, needsSync',
    negative: { missing: 'fail', rcNonZero: 'fail', garbage: 'fail' },
  },
  {
    section: 'WT_UPSTREAM',
    producer: 'git rev-parse --short "origin/$branch"',
    required: 'never',
    condition: '—',
    expectedAbsence: 'unpushed branch → upstreamHead:null',
    consumer: 'gitFacts.upstreamHead',
    negative: { missing: 'ok', rcNonZero: 'ok', garbage: 'skip' },
  },
  {
    section: 'WT_UP_COUNT',
    producer: 'git rev-list --left-right --count "origin/$branch"...HEAD',
    required: 'conditional',
    condition: 'required iff WT_UPSTREAM resolved',
    expectedAbsence: 'upstream absent → ahead/behindUpstream:null',
    consumer: 'aheadOfUpstream/behindUpstream, needsSync',
    negative: { missing: 'fail', rcNonZero: 'fail', garbage: 'fail' },
  },
  {
    section: 'WT_MERGE_HEAD',
    producer: "git rev-parse --short 'MERGE_HEAD'",
    required: 'never',
    condition: '—',
    expectedAbsence: 'no merge in progress → mergeConflict:false',
    consumer: 'gitFacts.mergeConflict',
    negative: { missing: 'ok', rcNonZero: 'ok', garbage: 'skip' },
  },
  {
    section: 'BR_GITDIR',
    producer: 'git -C <repo> rev-parse --git-dir',
    required: 'always',
    condition: 'emitted whenever a configured checkout exists',
    expectedAbsence: 'none — a non-git configured path must fail unknown (review round 5)',
    consumer: 'requiredFailures gate for all branch facts',
    negative: { missing: 'fail', rcNonZero: 'fail', garbage: 'skip' },
  },
  {
    section: 'BR_REF_ERROR',
    producer: 'captured stderr of the show-ref probes',
    required: 'always',
    condition: 'label source emitted with BR_REF',
    expectedAbsence: 'empty when probes answered',
    consumer: 'BR_REF operational failure evidence',
    negative: { missing: 'ok', rcNonZero: 'skip', garbage: 'skip' },
  },
  {
    section: 'BR_DEFAULT',
    producer: 'git -C <repo> symbolic-ref refs/remotes/origin/HEAD',
    required: 'never',
    condition: 'emitted only with a configured checkout; rc=1 is unset origin/HEAD, rc>1 is operational',
    expectedAbsence: 'unset origin/HEAD (rc=1) → defaultBranch falls back',
    consumer: 'branchFacts.defaultBranch, base resolution',
    negative: { missing: 'ok', rcNonZero: 'fail', garbage: 'skip' },
  },
  {
    section: 'BR_REF',
    producer: 'git -C <repo> show-ref probe of the workflow branch',
    required: 'never',
    condition: 'emitted only with a configured checkout',
    expectedAbsence: 'branch nowhere (rc=1) → branchExists:false; rc>1 is operational',
    consumer: 'branchFacts.branchExists',
    negative: { missing: 'ok', rcNonZero: 'fail', garbage: 'skip' },
  },
  {
    section: 'BR_BASE_REF',
    producer: 'echo of the effective branch-count base ($cb)',
    required: 'conditional',
    condition: 'emitted iff BR_REF resolved; label source',
    expectedAbsence: 'none',
    consumer: 'branch-count failure operation label',
    negative: { missing: 'fail', rcNonZero: 'skip', garbage: 'skip' },
  },
  {
    section: 'BR_COMMIT_COUNT',
    producer: 'git -C <repo> rev-list --count "$cb..$br"',
    required: 'conditional',
    condition: 'required iff BR_REF resolved to a branch',
    expectedAbsence: 'branch missing → no branchFacts.hasCommits claim at all',
    consumer: 'branchFacts.hasCommits (overrides aheadOfBase in derive)',
    negative: { missing: 'fail', rcNonZero: 'fail', garbage: 'fail' },
  },
]

export const REPOSITORY_SECTION_CONTRACT: SectionContract[] = [
  {
    section: 'REPO_DEFAULT',
    producer: 'git symbolic-ref refs/remotes/origin/HEAD',
    required: 'never',
    condition: '—',
    expectedAbsence: 'unset origin/HEAD → defaultBranch main fallback (legacy parity)',
    consumer: 'RepositorySample.defaultBranch',
    negative: { missing: 'ok', rcNonZero: 'ok', garbage: 'skip' },
  },
  {
    section: 'REPO_BRANCH',
    producer: 'git branch --show-current',
    required: 'always',
    condition: 'unconditional',
    expectedAbsence: 'empty output (detached) → checkoutBranch:null',
    consumer: 'RepositorySample.checkoutBranch',
    negative: { missing: 'fail', rcNonZero: 'fail', garbage: 'skip' },
  },
  {
    section: 'REPO_HEAD',
    producer: 'git rev-parse --short HEAD',
    required: 'always',
    condition: 'presence; rc≠0 (unborn) is expected absence, a missing section is not',
    expectedAbsence: 'unborn repository → head:null',
    consumer: 'envelope sourceRevision',
    negative: { missing: 'fail', rcNonZero: 'ok', garbage: 'skip' },
  },
  {
    section: 'REPO_MAIN_COUNT',
    producer: 'git rev-list --left-right --count "$base"...main',
    required: 'always',
    condition: 'unconditional (legacy always attempts it)',
    expectedAbsence: 'none — failure is operational',
    consumer: 'RepositorySample.main',
    negative: { missing: 'fail', rcNonZero: 'fail', garbage: 'fail' },
  },
  {
    section: 'REPO_HEAD_COUNT',
    producer: 'git rev-list --left-right --count "$base"...HEAD',
    required: 'conditional',
    condition: 'required iff REPO_BRANCH resolved',
    expectedAbsence: 'detached checkout → checkout:null',
    consumer: 'RepositorySample.checkout',
    negative: { missing: 'fail', rcNonZero: 'fail', garbage: 'fail' },
  },
]

export const REPOSITORY_ENUMERATION_SECTION_CONTRACT: SectionContract[] = [
  {
    section: 'ENUM_GITDIR',
    producer: 'git -C <repo> rev-parse --git-dir',
    required: 'always',
    condition: 'unconditional canary for the enumeration plane',
    expectedAbsence: 'none — a non-git configured path must fail unknown',
    consumer: 'requiredFailures gate for the enumeration',
    negative: { missing: 'fail', rcNonZero: 'fail', garbage: 'skip' },
  },
  {
    section: 'ENUM_DEFAULT',
    producer: 'git -C <repo> symbolic-ref refs/remotes/origin/HEAD',
    required: 'always',
    condition: 'presence; rc=1 is unset origin/HEAD (legit), rc>1 operational',
    expectedAbsence: 'unset origin/HEAD (rc=1) → origin/main fallback',
    consumer: 'RepositoryEnumerationSample.defaultBranch',
    negative: { missing: 'fail', rcNonZero: 'fail', garbage: 'skip' },
  },
  {
    section: 'ENUM_REFS',
    producer: 'git -C <repo> for-each-ref refs/heads refs/remotes/origin',
    required: 'always',
    condition: 'unconditional; empty output is a legitimate empty repository',
    expectedAbsence: 'empty output → empty refs set',
    consumer: 'RepositoryEnumerationSample.refs, branchExists',
    negative: { missing: 'fail', rcNonZero: 'fail', garbage: 'skip' },
  },
  {
    section: 'ENUM_BASE_AVAILABLE',
    producer: 'git -C <repo> rev-parse --short <default> availability probe',
    required: 'always',
    condition: 'unconditional',
    expectedAbsence: '0 → counts skipped as expected absence (deleted default base)',
    consumer: 'RepositoryEnumerationSample.baseAvailable',
    negative: { missing: 'fail', rcNonZero: 'skip', garbage: 'skip' },
  },
  {
    section: 'ENUM_COUNTS',
    producer: 'git -C <repo> rev-list --count <base>..<branch> loop over local heads',
    required: 'conditional',
    condition: 'required iff ENUM_BASE_AVAILABLE is 1',
    expectedAbsence: 'empty when the default base is gone (counts skipped)',
    consumer: 'RepositoryEnumerationSample.counts, hasCommits',
    negative: { missing: 'fail', rcNonZero: 'fail', garbage: 'fail' },
  },
]
