import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { buildWorktreeSampleCommand, parseWorktreeSample, sampleWorktreeFacts } from '../src/infra/local-git-sampler.ts'

function section(key: string, rc: number, value: string | null): string {
  const encoded = value === null ? '' : Buffer.from(value, 'utf8').toString('base64')
  return `${key}\t${rc}\t${encoded}`
}

function fullSampleOutput(): string {
  return [
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
    hasCommits: true,
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
    section('WT_HEAD', 0, 'abc1234'),
    section('WT_BRANCH', 0, 'feature'),
    section('WT_STATUS', 1, 'fatal: unable to read tree'),
    section('WT_MAIN', 1, ''),
    section('WT_MAIN_COUNT', 1, ''),
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
    [['git status --porcelain', 1]],
  )
  assert.match(sample.requiredFailures[0].error, /fatal:/)
})

test('canary failure marks the whole worktree plane unobservable', () => {
  const output = [
    section('WT_GITDIR', 128, 'fatal: not a git repository: /wt/broken'),
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
  assert.deepEqual(sample.branchFacts, { branchExists: true, hasCommits: false, defaultBranch: undefined })
})

test('command builder pins the compound sample shape', () => {
  const command = buildWorktreeSampleCommand({
    worktree: '/wt/issue-122',
    branch: 'clickvibe-issue-122',
    baseBranch: 'main',
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
  assert.match(command, /git rev-list --left-right --count "\$base"\.\.\.'HEAD' 2>\/dev\/null/)
  assert.match(command, /base='origin\/main'/)
  assert.match(command, /if \[ 0 -eq 1 \]; then/, 'base resolution must fall through to the baseRef branch')
  assert.match(command, /\[ -n 'abc1' \]/)
  assert.match(command, /u="origin\/\$b"/)
  // Branch facts are read from the configured checkout via git -C.
  assert.match(command, /git -C '\/repo\/main' show-ref --verify --quiet 'refs\/heads\/clickvibe-issue-122'/)
  assert.match(command, /git -C '\/repo\/main' symbolic-ref --quiet --short refs\/remotes\/origin\/HEAD/)
  assert.match(command, /rev-list --count "\$cb\.\.\$br"/)
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
