import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import {
  buildRepositorySampleCommand,
  buildWorktreeSampleCommand,
  parseRepositorySample,
  parseWorktreeSample,
  REPOSITORY_SECTION_CONTRACT,
  sampleWorktreeFacts,
  WORKTREE_SECTION_CONTRACT,
} from '../src/infra/local-git-sampler.ts'

function section(key: string, rc: number, value: string | null): string {
  const encoded = value === null ? '' : Buffer.from(value, 'utf8').toString('base64')
  return `${key}\t${rc}\t${encoded}`
}

function fullSampleOutput(): string {
  return [
    section('WT_GITDIR', 0, '/wt/.git'),
    section('EB_NAMED', 0, 'origin/main'),
    section('EB_COMPARE', 0, 'origin/main'),
    section('EB_SOURCE', 0, 'named-ref'),
    section('EB_AVAILABLE', 0, '1'),
    section('WT_BASE_REF', 0, 'origin/main'),
    section('WT_HEAD', 0, 'abc1234'),
    section('WT_BRANCH', 0, 'clickvibe-issue-122'),
    section('WT_STATUS', 0, ' M src/a.ts\n?? src/b.ts'),
    section('WT_MAIN', 0, 'aaa0000'),
    section('WT_MAIN_COUNT', 0, '0 1'),
    section('WT_BASE', 0, 'bbb0000'),
    section('WT_BASE_COUNT', 0, '0 2'),
    section('WT_UPSTREAM', 0, 'abc1234'),
    section('WT_UP_COUNT', 0, '0 0'),
    section('WT_MERGE_HEAD', 1, ''),
    section('BR_REF', 0, 'clickvibe-issue-122'),
    section('BR_DEFAULT', 0, 'origin/main'),
    section('BR_COMMIT_COUNT', 0, '3'),
  ].join('\n')
}

test('parses a fully-populated sample into git facts and branch facts', () => {
  const sample = parseWorktreeSample(fullSampleOutput())
  assert.deepEqual(sample.gitFacts, {
    exists: true,
    head: 'abc1234',
    branch: 'clickvibe-issue-122',
    hasUncommittedChanges: true,
    mainHead: 'aaa0000',
    aheadOfMain: 1,
    behindMain: 0,
    originMainHead: 'bbb0000',
    aheadOfBase: 2,
    behindBase: 0,
    upstreamHead: 'abc1234',
    aheadOfUpstream: 0,
    behindUpstream: 0,
    mergeConflict: false,
  })
  assert.deepEqual(sample.branchFacts, {
    branchExists: true,
    // Single answer source (review round 4): the worktree compare already
    // answered aheadOfBase, so the branch count does not override it.
    defaultBranch: 'main',
  })
})

test('unresolvable HEAD suppresses every dependent ref fact', () => {
  const output = [
    section('WT_HEAD', 128, ''),
    section('WT_BRANCH', 0, 'feature'),
    section('WT_STATUS', 0, ''),
    section('WT_MAIN', 0, 'aaa0000'),
    section('WT_MAIN_COUNT', 0, '5 7'),
    section('WT_BASE', 0, 'bbb0000'),
    section('WT_BASE_COUNT', 0, '1 1'),
    section('WT_UPSTREAM', 0, 'ccc0000'),
    section('WT_UP_COUNT', 0, '2 2'),
    section('WT_MERGE_HEAD', 1, ''),
  ].join('\n')
  const sample = parseWorktreeSample(output)
  assert.equal(sample.gitFacts.head, null)
  assert.equal(sample.gitFacts.mainHead, null)
  assert.equal(sample.gitFacts.originMainHead, null)
  assert.equal(sample.gitFacts.upstreamHead, null)
  assert.equal(sample.gitFacts.aheadOfMain, 0)
  assert.equal(sample.gitFacts.behindMain, 0)
  assert.equal(sample.gitFacts.aheadOfBase, 0)
  assert.equal(sample.gitFacts.behindBase, 0)
  assert.equal(sample.gitFacts.aheadOfUpstream, null)
  assert.equal(sample.gitFacts.behindUpstream, null)
  assert.equal(sample.gitFacts.hasUncommittedChanges, false)
})

test('missing local branch suppresses upstream facts only', () => {
  const output = [
    section('WT_HEAD', 0, 'abc1234'),
    section('WT_BRANCH', 0, ''),
    section('WT_STATUS', 0, ''),
    section('WT_MAIN', 0, 'aaa0000'),
    section('WT_MAIN_COUNT', 0, '0 0'),
    section('WT_BASE', 0, 'bbb0000'),
    section('WT_BASE_COUNT', 0, '0 0'),
    section('WT_UPSTREAM', 127, ''),
    section('WT_UP_COUNT', 127, ''),
    section('WT_MERGE_HEAD', 1, ''),
  ].join('\n')
  const sample = parseWorktreeSample(output)
  assert.equal(sample.gitFacts.branch, null)
  assert.equal(sample.gitFacts.mainHead, 'aaa0000')
  assert.equal(sample.gitFacts.originMainHead, 'bbb0000')
  assert.equal(sample.gitFacts.upstreamHead, null)
  assert.equal(sample.gitFacts.aheadOfUpstream, null)
  assert.equal(sample.gitFacts.behindUpstream, null)
})

test('a failed required read (git status) is flagged, never rendered as clean', () => {
  const output = [
    section('WT_GITDIR', 0, '/wt/.git'),
    section('EB_NAMED', 0, 'origin/main'),
    section('EB_COMPARE', 0, 'origin/main'),
    section('EB_SOURCE', 0, 'named-ref'),
    section('EB_AVAILABLE', 0, '1'),
    section('WT_BASE_REF', 0, 'origin/main'),
    section('WT_HEAD', 0, 'abc1234'),
    section('WT_BRANCH', 0, 'feature'),
    section('WT_STATUS', 1, 'fatal: unable to read tree'),
    section('WT_MAIN', 1, ''),
    section('WT_MAIN_COUNT', 1, ''),
    section('WT_BASE_REF', 0, 'origin/main'),
    section('WT_BASE', 0, 'bbb0000'),
    section('WT_BASE_COUNT', 1, ''),
    section('WT_UPSTREAM', 0, 'abc1234'),
    section('WT_UP_COUNT', 0, '1 0'),
    section('WT_MERGE_HEAD', 0, 'deadbee'),
  ].join('\n')
  const sample = parseWorktreeSample(output)
  assert.equal(sample.gitFacts.mergeConflict, true, 'expected-absence rules still apply to refs')
  assert.equal(sample.gitFacts.mainHead, null)
  assert.equal(sample.gitFacts.behindBase, 0)
  assert.equal(sample.gitFacts.aheadOfUpstream, 0)
  assert.equal(sample.gitFacts.behindUpstream, 1)
  assert.deepEqual(
    sample.requiredFailures.map((failure) => [failure.operation, failure.rc]),
    [
      ['git status --porcelain', 1],
      ['git rev-list --left-right --count origin/main...HEAD', 1],
    ],
  )
  assert.match(sample.requiredFailures[0].error, /fatal:/)
})

test('canary failure marks the whole worktree plane unobservable', () => {
  const output = [
    section('WT_GITDIR', 128, 'fatal: not a git repository: /wt/broken'),
    section('EB_NAMED', 0, 'origin/main'),
    section('EB_COMPARE', 0, 'origin/main'),
    section('EB_SOURCE', 0, 'named-ref'),
    section('EB_AVAILABLE', 0, '1'),
    section('WT_BASE_REF', 0, 'origin/main'),
    section('WT_HEAD', 128, ''),
    section('WT_BRANCH', 128, 'fatal: not a git repository'),
    section('WT_STATUS', 128, 'fatal: not a git repository'),
    section('WT_MAIN', 128, ''),
    section('WT_MAIN_COUNT', 128, ''),
    section('WT_BASE', 128, ''),
    section('WT_BASE_COUNT', 128, ''),
    section('WT_UPSTREAM', 127, ''),
    section('WT_UP_COUNT', 127, ''),
    section('WT_MERGE_HEAD', 1, ''),
  ].join('\n')
  const sample = parseWorktreeSample(output)
  assert.deepEqual(
    sample.requiredFailures.map((failure) => failure.operation),
    ['git rev-parse --git-dir', 'git status --porcelain', 'git branch --show-current'],
  )
  assert.equal(sample.gitFacts.head, null)
})

test('sampleWorktreeFacts rejects with the raw operation/rc/error when a required read fails', async () => {
  const output = [
    section('WT_GITDIR', 0, '/wt/issue-122/.git'),
    section('EB_NAMED', 0, 'origin/main'),
    section('EB_COMPARE', 0, 'origin/main'),
    section('EB_SOURCE', 0, 'named-ref'),
    section('EB_AVAILABLE', 0, '1'),
    section('WT_BASE_REF', 0, 'origin/main'),
    section('WT_HEAD', 0, 'abc1234'),
    section('WT_BRANCH', 0, 'clickvibe-issue-122'),
    section('WT_STATUS', 1, 'fatal: unable to read tree'),
    section('WT_MAIN', 1, ''),
    section('WT_MAIN_COUNT', 1, ''),
    section('WT_BASE', 1, ''),
    section('WT_BASE_COUNT', 1, ''),
    section('WT_UPSTREAM', 127, ''),
    section('WT_UP_COUNT', 127, ''),
    section('WT_MERGE_HEAD', 1, ''),
  ].join('\n')
  const ctx = {
    shell: {
      resolve: (spec: { command: string }) => spec,
      run: async () => ({ exitCode: 0, stdout: { text: output }, stderr: { text: '' } }),
    },
  } as unknown as Context
  await assert.rejects(
    sampleWorktreeFacts(ctx, {
      worktree: '/wt/issue-122',
      branch: 'clickvibe-issue-122',
      baseBranch: 'main',
      baseBranchNeedsDefault: false,
      frozenBase: null,
      repoPath: null,
    }),
    (error: Error) => {
      assert.match(error.message, /本地 Git 必需读取失败/)
      assert.match(error.message, /git status --porcelain rc=1/)
      assert.match(error.message, /unable to read tree/)
      return true
    },
  )
})

test('unparseable or missing base count keeps zero counts', () => {
  const base = [
    section('WT_HEAD', 0, 'abc1234'),
    section('WT_BRANCH', 0, 'feature'),
    section('WT_STATUS', 0, ''),
    section('WT_MAIN', 1, ''),
    section('WT_MAIN_COUNT', 1, ''),
    section('WT_BASE', 1, ''),
    section('WT_MERGE_HEAD', 1, ''),
  ]
  const garbage = parseWorktreeSample([...base, section('WT_BASE_COUNT', 0, 'not numbers')].join('\n'))
  assert.equal(garbage.gitFacts.behindBase, 0)
  assert.equal(garbage.gitFacts.aheadOfBase, 0)
  assert.ok(garbage.requiredFailures.length > 0, 'an attempted-but-unparseable base count must be flagged')

  const absent = parseWorktreeSample([...base, section('WT_BASE_COUNT', 0, '')].join('\n'))
  assert.equal(absent.gitFacts.behindBase, 0)
  assert.equal(absent.gitFacts.aheadOfBase, 0)
})

test('empty or absent branch-fact sections keep the empty branch facts envelope', () => {
  const emptySections = [
    section('WT_HEAD', 0, 'abc1234'),
    section('WT_BRANCH', 0, 'feature'),
    section('WT_STATUS', 0, ''),
    section('WT_MAIN', 1, ''),
    section('WT_MAIN_COUNT', 1, ''),
    section('WT_BASE', 1, ''),
    section('WT_BASE_COUNT', 1, ''),
    section('WT_UPSTREAM', 127, ''),
    section('WT_UP_COUNT', 127, ''),
    section('WT_MERGE_HEAD', 1, ''),
    section('BR_REF', 1, ''),
    section('BR_DEFAULT', 0, ''),
    section('BR_COMMIT_COUNT', 127, ''),
  ].join('\n')
  const sample = parseWorktreeSample(emptySections)
  assert.deepEqual(sample.branchFacts, { branchExists: false, defaultBranch: undefined })

  const noSections = [
    section('WT_HEAD', 0, 'abc1234'),
    section('WT_BRANCH', 0, 'feature'),
    section('WT_STATUS', 0, ''),
    section('WT_MAIN', 1, ''),
    section('WT_MAIN_COUNT', 1, ''),
    section('WT_BASE', 1, ''),
    section('WT_BASE_COUNT', 1, ''),
    section('WT_UPSTREAM', 127, ''),
    section('WT_UP_COUNT', 127, ''),
    section('WT_MERGE_HEAD', 1, ''),
  ].join('\n')
  assert.deepEqual(parseWorktreeSample(noSections).branchFacts, {})
})

test('local branch probe failure keeps branchExists false while default branch still resolves', () => {
  const output = [
    section('WT_GITDIR', 0, '/wt/.git'),
    section('EB_NAMED', 0, 'origin/main'),
    section('EB_COMPARE', 0, 'origin/main'),
    section('EB_SOURCE', 0, 'named-ref'),
    section('EB_AVAILABLE', 0, '1'),
    section('WT_BASE_REF', 0, 'origin/main'),
    section('WT_HEAD', 0, 'abc1234'),
    section('WT_BRANCH', 0, 'feature'),
    section('WT_STATUS', 0, ''),
    section('WT_MAIN', 1, ''),
    section('WT_MAIN_COUNT', 1, ''),
    section('WT_BASE', 1, ''),
    section('WT_BASE_COUNT', 1, ''),
    section('WT_UPSTREAM', 127, ''),
    section('WT_UP_COUNT', 127, ''),
    section('WT_MERGE_HEAD', 1, ''),
    section('BR_REF', 0, 'origin/feature'),
    section('BR_DEFAULT', 1, ''),
    section('BR_COMMIT_COUNT', 0, '0'),
  ].join('\n')
  const sample = parseWorktreeSample(output)
  // The worktree base compare failed (WT_BASE_COUNT rc=1), so the branch
  // count remains the answering source: hasCommits:false is legitimate here.
  assert.deepEqual(sample.branchFacts, { branchExists: true, hasCommits: false, defaultBranch: undefined })
})

test('command builder pins the compound sample shape', () => {
  const command = buildWorktreeSampleCommand({
    worktree: '/wt/issue-122',
    branch: 'clickvibe-issue-122',
    baseBranch: 'main',
    baseBranchNeedsDefault: false,
    frozenBase: 'abc1',
    repoPath: '/repo/main',
  })
  // Worktree facts are gathered with the worktree as the command workdir.
  assert.match(command, /h=\$\(git rev-parse --short HEAD 2>\/dev\/null\)/)
  assert.match(command, /git rev-parse --git-dir 2>&1/)
  assert.match(command, /git branch --show-current 2>&1/, 'required read captures stderr')
  assert.match(command, /git status --porcelain 2>&1/, 'required read captures stderr')
  assert.match(command, /printf 'WT_GITDIR\\t%d\\t%s\\n'/)
  assert.match(command, /git rev-parse --short 'main' 2>\/dev\/null/)
  assert.match(command, /git rev-list --left-right --count "\$ebc"\.\.\.'HEAD' 2>&1/, 'compare stderr is captured')
  assert.match(command, /printf 'EB_COMPARE\\t%d\\t%s\\n' 0/, 'the single effective base is published')
  assert.match(command, /elif \[ -n "\$frozen" \]; then/, 'frozen SHA is part of the single resolution')
  assert.match(command, /eb='origin\/main'; ebsrc=named-ref/)
  assert.match(command, /if \[ 0 -eq 1 \]; then/, 'base resolution must fall through to the baseRef branch')
  assert.match(command, /frozen='abc1'/)
  assert.match(command, /u="origin\/\$b"/)
  // Branch facts are read from the configured checkout via git -C.
  assert.match(command, /git -C '\/repo\/main' show-ref --verify --quiet 'refs\/heads\/clickvibe-issue-122'/)
  assert.match(command, /git -C '\/repo\/main' symbolic-ref --quiet --short refs\/remotes\/origin\/HEAD/)
  assert.match(command, /rev-list --count "\$ebc\.\.\$br"/, 'branch count shares the effective base')
  // Sections are tab-delimited with base64 payloads.
  assert.match(command, /printf 'WT_HEAD\\t%d\\t%s\\n'/)
})

test('command builder omits branch-fact sections when the repo checkout is unavailable', () => {
  const command = buildWorktreeSampleCommand({
    worktree: '/wt/issue-122',
    branch: 'clickvibe-issue-122',
    baseBranch: 'main',
    frozenBase: null,
    repoPath: null,
  })
  assert.doesNotMatch(command, /BR_REF|BR_DEFAULT|BR_COMMIT_COUNT/)
  assert.doesNotMatch(command, /git -C/)
  // With no frozen fallback and no origin base, the base-count section must
  // still exist but never invoke rev-list against an empty ref.
  assert.match(command, /WT_BASE_COUNT/)
  assert.match(command, /bc=''/)
})

test('a failed main compare (rc=128) is a required failure, never published as 0/0', () => {
  const output = [
    section('WT_GITDIR', 0, '/wt/.git'),
    section('EB_NAMED', 0, 'origin/main'),
    section('EB_COMPARE', 0, 'origin/main'),
    section('EB_SOURCE', 0, 'named-ref'),
    section('EB_AVAILABLE', 0, '1'),
    section('WT_BASE_REF', 0, 'origin/main'),
    section('WT_HEAD', 0, 'abc1234'),
    section('WT_BRANCH', 0, 'feature'),
    section('WT_STATUS', 0, ''),
    section('WT_MAIN', 0, 'aaa0000'),
    section('WT_MAIN_COUNT', 128, 'fatal: bad object aaa0000'),
    section('WT_BASE', 0, 'bbb0000'),
    section('WT_BASE_COUNT', 0, '0 0'),
    section('WT_UPSTREAM', 127, ''),
    section('WT_UP_COUNT', 127, ''),
    section('WT_MERGE_HEAD', 1, ''),
  ].join('\n')
  const sample = parseWorktreeSample(output)
  assert.deepEqual(
    sample.requiredFailures.map((failure) => failure.operation),
    ['git rev-list --left-right --count main...HEAD'],
  )
  assert.match(sample.requiredFailures[0].error, /fatal: bad object/)
})

test('a failed base or upstream compare is a required failure when its ref resolved', () => {
  const output = [
    section('WT_GITDIR', 0, '/wt/.git'),
    section('EB_NAMED', 0, 'origin/base'),
    section('EB_COMPARE', 0, 'origin/base'),
    section('EB_SOURCE', 0, 'named-ref'),
    section('EB_AVAILABLE', 0, '1'),
    section('WT_BASE_REF', 0, 'origin/base'),
    section('WT_HEAD', 0, 'abc1234'),
    section('WT_BRANCH', 0, 'feature'),
    section('WT_STATUS', 0, ''),
    section('WT_MAIN', 1, ''),
    section('WT_MAIN_COUNT', 1, ''),
    section('WT_BASE', 0, 'bbb0000'),
    section('WT_BASE_COUNT', 128, 'fatal: unable to read bbb0000'),
    section('WT_UPSTREAM', 0, 'ccc0000'),
    section('WT_UP_COUNT', 128, 'fatal: object file corrupt'),
    section('WT_MERGE_HEAD', 1, ''),
  ].join('\n')
  const sample = parseWorktreeSample(output)
  assert.deepEqual(
    sample.requiredFailures.map((failure) => failure.operation),
    ['git rev-list --left-right --count origin/base...HEAD', 'git rev-list --left-right --count origin/feature...HEAD'],
  )
})

test('a missing always-present section is a required failure', () => {
  const output = [
    section('WT_GITDIR', 0, '/wt/.git'),
    section('EB_NAMED', 0, 'origin/main'),
    section('EB_COMPARE', 0, 'origin/main'),
    section('EB_SOURCE', 0, 'named-ref'),
    section('EB_AVAILABLE', 0, '1'),
    section('WT_BASE_REF', 0, 'origin/main'),
    section('WT_HEAD', 0, 'abc1234'),
    section('WT_BRANCH', 0, 'feature'),
    // WT_STATUS missing entirely
    section('WT_MAIN', 1, ''),
    section('WT_MAIN_COUNT', 1, ''),
    section('WT_BASE', 1, ''),
    section('WT_BASE_COUNT', 0, ''),
    section('WT_UPSTREAM', 127, ''),
    section('WT_UP_COUNT', 127, ''),
    section('WT_MERGE_HEAD', 1, ''),
  ].join('\n')
  const sample = parseWorktreeSample(output)
  assert.ok(
    sample.requiredFailures.some((failure) => failure.operation === 'git status --porcelain'),
    'a missing required section must be reported',
  )
})

test('an unparseable main count with a resolved main ref is a required failure', () => {
  const output = [
    section('WT_GITDIR', 0, '/wt/.git'),
    section('EB_NAMED', 0, 'origin/main'),
    section('EB_COMPARE', 0, 'origin/main'),
    section('EB_SOURCE', 0, 'named-ref'),
    section('EB_AVAILABLE', 0, '1'),
    section('WT_BASE_REF', 0, 'origin/main'),
    section('WT_HEAD', 0, 'abc1234'),
    section('WT_BRANCH', 0, 'feature'),
    section('WT_STATUS', 0, ''),
    section('WT_MAIN', 0, 'aaa0000'),
    section('WT_MAIN_COUNT', 0, 'not numbers'),
    section('EB_NAMED', 0, 'origin/main'),
    section('EB_COMPARE', 0, ''),
    section('EB_SOURCE', 0, 'none'),
    section('EB_AVAILABLE', 0, '0'),
    section('WT_BASE', 1, ''),
    section('WT_BASE_COUNT', 0, ''),
    section('WT_UPSTREAM', 127, ''),
    section('WT_UP_COUNT', 127, ''),
    section('WT_MERGE_HEAD', 1, ''),
  ].join('\n')
  const sample = parseWorktreeSample(output)
  assert.deepEqual(
    sample.requiredFailures.map((failure) => failure.operation),
    ['git rev-list --left-right --count main...HEAD'],
  )
})

test('repo sampler flags failed compares and missing sections instead of publishing null', () => {
  const output = [
    section('REPO_DEFAULT', 0, 'origin/main'),
    section('REPO_BRANCH', 0, 'main'),
    section('REPO_HEAD', 0, 'abc1234'),
    section('REPO_MAIN_COUNT', 128, 'fatal: bad object'),
    section('REPO_HEAD_COUNT', 0, '0 0'),
  ].join('\n')
  const sample = parseRepositorySample(output)
  assert.deepEqual(
    sample.requiredFailures.map((failure) => failure.operation),
    ['git rev-list --left-right --count <base>...main'],
  )
  assert.match(sample.requiredFailures[0].error, /fatal: bad object/)

  const missing = [
    section('REPO_DEFAULT', 0, 'origin/main'),
    section('REPO_BRANCH', 0, 'main'),
    // REPO_HEAD and REPO_MAIN_COUNT missing
    section('REPO_HEAD_COUNT', 0, '0 0'),
  ].join('\n')
  const missingSample = parseRepositorySample(missing)
  assert.ok(missingSample.requiredFailures.length > 0, 'missing sections must be reported')
})

test('every builder section is explicitly classified in the section contract (static enumeration)', () => {
  const emittedSections = (command: string) =>
    new Set([...command.matchAll(/'(WT_[A-Z_]+|BR_[A-Z_]+|REPO_[A-Z_]+|EB_[A-Z_]+)\\t/g)].map((match) => match[1]))

  const worktreeFull = buildWorktreeSampleCommand({
    worktree: '/wt/issue-122',
    branch: 'clickvibe-issue-122',
    baseBranch: 'main',
    baseBranchNeedsDefault: false,
    frozenBase: 'abc1',
    repoPath: '/repo/main',
  })
  const worktreeBare = buildWorktreeSampleCommand({
    worktree: '/wt/issue-122',
    branch: 'clickvibe-issue-122',
    baseBranch: 'main',
    baseBranchNeedsDefault: false,
    frozenBase: null,
    repoPath: null,
  })
  const repoCommand = buildRepositorySampleCommand({ repoPath: '/repo/main' })

  const worktreeSections = new Set([...emittedSections(worktreeFull), ...emittedSections(worktreeBare)])
  const contractSections = new Set(WORKTREE_SECTION_CONTRACT.map((entry) => entry.section))
  assert.deepEqual(
    [...worktreeSections].filter((section) => !contractSections.has(section)).sort(),
    [],
    'builder emits sections missing from WORKTREE_SECTION_CONTRACT',
  )
  assert.deepEqual(
    [...contractSections].filter((section) => !worktreeSections.has(section)).sort(),
    [],
    'contract classifies sections the builder never emits',
  )

  const repoSections = emittedSections(repoCommand)
  const repoContract = new Set(REPOSITORY_SECTION_CONTRACT.map((entry) => entry.section))
  assert.deepEqual(
    [...repoSections].filter((section) => !repoContract.has(section)).sort(),
    [],
    'repo builder emits sections missing from REPOSITORY_SECTION_CONTRACT',
  )
  assert.deepEqual(
    [...repoContract].filter((section) => !repoSections.has(section)).sort(),
    [],
    'repo contract classifies sections the builder never emits',
  )

  // Every contract entry must name its producer, absence meaning and consumer.
  for (const entry of [...WORKTREE_SECTION_CONTRACT, ...REPOSITORY_SECTION_CONTRACT]) {
    assert.ok(entry.producer.length > 0, `${entry.section} producer`)
    assert.ok(entry.expectedAbsence.length > 0, `${entry.section} expectedAbsence`)
    assert.ok(entry.consumer.length > 0, `${entry.section} consumer`)
    assert.ok(['always', 'conditional', 'never'].includes(entry.required))
  }
})

test('a failed branch count is a required failure carrying the effective base ref', () => {
  const output = [
    section('WT_GITDIR', 0, '/wt/.git'),
    section('EB_NAMED', 0, 'origin/main'),
    section('EB_COMPARE', 0, 'origin/main'),
    section('EB_SOURCE', 0, 'named-ref'),
    section('EB_AVAILABLE', 0, '1'),
    section('WT_BASE_REF', 0, 'origin/main'),
    section('WT_HEAD', 0, 'abc1234'),
    section('WT_BRANCH', 0, 'clickvibe-issue-122'),
    section('WT_STATUS', 0, ''),
    section('WT_MAIN', 1, ''),
    section('WT_MAIN_COUNT', 1, ''),
    section('WT_BASE_REF', 0, 'origin/main'),
    section('WT_BASE', 1, ''),
    section('WT_BASE_COUNT', 0, '0 1'),
    section('WT_UPSTREAM', 127, ''),
    section('WT_UP_COUNT', 127, ''),
    section('WT_MERGE_HEAD', 1, ''),
    section('BR_DEFAULT', 0, 'origin/main'),
    section('BR_REF', 0, 'clickvibe-issue-122'),
    section('BR_BASE_REF', 0, 'origin/main'),
    section('BR_COMMIT_COUNT', 128, "fatal: bad revision 'origin/main..clickvibe-issue-122'"),
  ].join('\n')
  const sample = parseWorktreeSample(output)
  assert.equal(sample.gitFacts.aheadOfBase, 1, 'the frozen worktree compare still resolved')
  assert.equal(sample.branchFacts.branchExists, true)
  assert.equal(sample.branchFacts.hasCommits, undefined, 'a failed count must not claim hasCommits at all')
  assert.deepEqual(
    sample.requiredFailures.map((failure) => failure.operation),
    ['git rev-list --count origin/main..clickvibe-issue-122'],
  )
  assert.match(sample.requiredFailures[0].error, /fatal: bad revision/)
})

test('contract-driven negatives: every section reacts to missing/rc/garbage as classified', () => {
  // Canonical healthy sample: worktree fully observable, base resolved via a
  // named ref, upstream present, branch facts present.
  const canonical: Array<[string, number, string]> = [
    ['WT_GITDIR', 0, '/wt/.git'],
    ['EB_NAMED', 0, 'origin/main'],
    ['EB_COMPARE', 0, 'origin/main'],
    ['EB_SOURCE', 0, 'named-ref'],
    ['EB_AVAILABLE', 0, '1'],
    ['WT_BASE_REF', 0, 'origin/main'],
    ['WT_HEAD', 0, 'abc1234'],
    ['WT_BRANCH', 0, 'feature'],
    ['WT_STATUS', 0, ''],
    ['WT_MAIN', 0, 'aaa0000'],
    ['WT_MAIN_COUNT', 0, '0 1'],
    ['WT_BASE', 0, 'bbb0000'],
    ['WT_BASE_COUNT', 0, '0 2'],
    ['WT_UPSTREAM', 0, 'abc1234'],
    ['WT_UP_COUNT', 0, '0 0'],
    ['WT_MERGE_HEAD', 1, ''],
    ['BR_DEFAULT', 0, 'origin/main'],
    ['BR_REF', 0, 'feature'],
    ['BR_BASE_REF', 0, 'origin/main'],
    ['BR_COMMIT_COUNT', 0, '2'],
  ]
  const build = (rows: Array<[string, number, string]>) =>
    rows.map(([key, rc, value]) => section(key, rc, value)).join('\n')
  const baseline = parseWorktreeSample(build(canonical))
  assert.deepEqual(baseline.requiredFailures, [], 'canonical sample must be failure-free')

  const operationFor = (entry: (typeof WORKTREE_SECTION_CONTRACT)[number]): string =>
    entry.section.startsWith('EB_') || entry.section === 'WT_BASE_REF' || entry.section === 'BR_BASE_REF'
      ? `effective-base ${entry.section}`
      : entry.producer
          .replace(/(?:^|\s)-C\s+\S+/g, '')
          .trim()
          .split(/\s+/)
          .slice(0, 4)
          .join(' ')

  for (const entry of WORKTREE_SECTION_CONTRACT) {
    const index = canonical.findIndex(([key]) => key === entry.section)
    if (index < 0) continue // conditional sections absent from this canonical sample

    const variants: Array<{ name: string; make: () => string; expect: 'fail' | 'ok' | 'skip' }> = [
      {
        name: 'missing',
        make: () => build(canonical.filter((_, i) => i !== index)),
        expect: entry.negative.missing,
      },
      {
        name: 'rc-failure',
        make: () => {
          const rows = canonical.map((row, i) =>
            i === index ? ([row[0], 128, `fatal: ${row[0]} broke`] as [string, number, string]) : row,
          )
          return build(rows)
        },
        expect: entry.negative.rcNonZero,
      },
      {
        name: 'garbage-value',
        make: () => {
          const rows = canonical.map((row, i) =>
            i === index ? ([row[0], 0, 'garbage value'] as [string, number, string]) : row,
          )
          return build(rows)
        },
        expect: entry.negative.garbage,
      },
    ]
    for (const variant of variants) {
      if (variant.expect === 'skip') continue
      const parsed = parseWorktreeSample(variant.make())
      const flagged = parsed.requiredFailures.some(
        (failure) =>
          failure.operation.includes(entry.section) ||
          failure.operation === entry.producer ||
          failure.operation.startsWith(operationFor(entry).split(' ').slice(0, 3).join(' ')),
      )
      assert.equal(
        flagged,
        variant.expect === 'fail',
        `${entry.section} ${variant.name}: expected ${variant.expect}, operations=${JSON.stringify(parsed.requiredFailures.map((f) => f.operation))}`,
      )
    }
  }
})
