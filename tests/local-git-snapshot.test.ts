import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { WorktreeSample, WorktreeSampleInput } from '../src/infra/local-git-sampler.ts'
import { LocalGitSnapshotRegistry, notifyLocalGitMutation, worktreeScopeKey } from '../src/infra/local-git-snapshot.ts'

const CTX = {} as Context

const INPUT: WorktreeSampleInput = {
  worktree: '/wt/issue-122',
  branch: 'clickvibe-issue-122',
  baseBranch: 'main',
  baseBranchNeedsDefault: false,
  frozenBase: null,
  repoPath: '/repo/main',
}

function makeSample(head: string): WorktreeSample {
  return {
    gitFacts: {
      exists: true,
      head,
      branch: 'clickvibe-issue-122',
      hasUncommittedChanges: false,
      mainHead: 'aaa0000',
      aheadOfMain: 1,
      behindMain: 0,
      originMainHead: 'bbb0000',
      aheadOfBase: 2,
      behindBase: 0,
      upstreamHead: head,
      aheadOfUpstream: 0,
      behindUpstream: 0,
      mergeConflict: false,
    },
    branchFacts: { branchExists: true, hasCommits: true, defaultBranch: 'main' },
  }
}

/** Deterministic sampler: each scope's n-th execution yields a distinct head. */
function countingRegistry() {
  const executions: string[] = []
  const generations = new Map<string, number>()
  const registry = new LocalGitSnapshotRegistry(async (_ctx, repoKey, input) => {
    const scope = `${repoKey}:${input.worktree}`
    const generation = (generations.get(scope) ?? 0) + 1
    generations.set(scope, generation)
    executions.push(scope)
    return makeSample(`head-${scope}-g${generation}`)
  })
  return { registry, executions }
}

test('one sample per generation: second consumer is a cache hit on the same immutable object', async () => {
  const { registry, executions } = countingRegistry()
  const first = await registry.worktreeSample(CTX, 'ai-daming/clickvibe', INPUT)
  const second = await registry.worktreeSample(CTX, 'ai-daming/clickvibe', INPUT)
  assert.equal(first, second, 'the snapshot is one immutable observation')
  assert.deepEqual(executions, ['ai-daming/clickvibe:/wt/issue-122'])
  assert.equal(registry.counters.logicalRequests, 2)
  assert.equal(registry.counters.cacheHits, 1)
  assert.equal(registry.counters.executions, 1)
  assert.equal(registry.counters.singleflightJoins, 0)
})

test('concurrent consumers join one in-flight sample', async () => {
  let resolveSample!: (sample: WorktreeSample) => void
  const gate = new Promise<WorktreeSample>((resolve) => {
    resolveSample = resolve
  })
  const registry = new LocalGitSnapshotRegistry(async () => gate)
  const first = registry.worktreeSample(CTX, 'ai-daming/clickvibe', INPUT)
  const second = registry.worktreeSample(CTX, 'ai-daming/clickvibe', INPUT)
  resolveSample(makeSample('abc1234'))
  assert.equal(await first, await second)
  assert.equal(registry.counters.singleflightJoins, 1)
  assert.equal(registry.counters.executions, 1)
  assert.equal(registry.counters.logicalRequests, 2)
})

test('invalidation bumps the generation and the next consumer resamples', async () => {
  const { registry, executions } = countingRegistry()
  const first = await registry.worktreeSample(CTX, 'ai-daming/clickvibe', INPUT)
  assert.equal(first.gitFacts.head, 'head-ai-daming/clickvibe:/wt/issue-122-g1')

  registry.invalidate({ repoKey: 'ai-daming/clickvibe', worktreePath: INPUT.worktree }, 'worktree-sync', 'syncWorktree')
  assert.equal(registry.invalidations.length, 1)
  assert.equal(registry.invalidations[0].scope, worktreeScopeKey('ai-daming/clickvibe', INPUT.worktree))
  assert.equal(registry.invalidations[0].reason, 'worktree-sync')

  const second = await registry.worktreeSample(CTX, 'ai-daming/clickvibe', INPUT)
  assert.equal(second.gitFacts.head, 'head-ai-daming/clickvibe:/wt/issue-122-g2')
  assert.deepEqual(executions, ['ai-daming/clickvibe:/wt/issue-122', 'ai-daming/clickvibe:/wt/issue-122'])
  assert.equal(registry.counters.executions, 2)
})

test('invalidation during an in-flight sample returns it to the caller but does not cache it', async () => {
  let resolveSample!: (sample: WorktreeSample) => void
  const gate = new Promise<WorktreeSample>((resolve) => {
    resolveSample = resolve
  })
  const { registry: counting } = countingRegistry()
  void counting
  const executions: string[] = []
  const registry = new LocalGitSnapshotRegistry(async (_ctx, _repoKey, input) => {
    executions.push(input.worktree)
    if (executions.length === 1) return gate
    return makeSample('head-g2')
  })

  const inflight = registry.worktreeSample(CTX, 'ai-daming/clickvibe', INPUT)
  registry.invalidate({ repoKey: 'ai-daming/clickvibe', worktreePath: INPUT.worktree }, 'agent-task-end', 'task-close')
  resolveSample(makeSample('head-stale'))
  const stale = await inflight
  assert.equal(stale.gitFacts.head, 'head-stale', 'the requesting consumer still gets its sample')

  const fresh = await registry.worktreeSample(CTX, 'ai-daming/clickvibe', INPUT)
  assert.equal(fresh.gitFacts.head, 'head-g2')
  assert.equal(registry.counters.executions, 2, 'the stale sample must not satisfy the next generation')
})

test('repo-wide invalidation clears every worktree scope of that repo only', async () => {
  const otherInput = { ...INPUT, worktree: '/wt/issue-7' }
  const { registry, executions } = countingRegistry()
  const first = await registry.worktreeSample(CTX, 'ai-daming/clickvibe', INPUT)
  const other = await registry.worktreeSample(CTX, 'ai-daming/clickvibe', otherInput)
  const foreign = await registry.worktreeSample(CTX, 'other/repo', INPUT)
  assert.deepEqual(executions, [
    'ai-daming/clickvibe:/wt/issue-122',
    'ai-daming/clickvibe:/wt/issue-7',
    'other/repo:/wt/issue-122',
  ])

  registry.invalidate({ repoKey: 'ai-daming/clickvibe' }, 'remote-fetch', 'ensureConfiguredRepoFresh')
  assert.equal(registry.invalidations[0].scope, 'repo:ai-daming/clickvibe')

  const resampled = await registry.worktreeSample(CTX, 'ai-daming/clickvibe', INPUT)
  const resampledOther = await registry.worktreeSample(CTX, 'ai-daming/clickvibe', otherInput)
  const cachedForeign = await registry.worktreeSample(CTX, 'other/repo', INPUT)
  assert.equal(resampled.gitFacts.head, 'head-ai-daming/clickvibe:/wt/issue-122-g2', 'same-repo scope must resample')
  assert.equal(
    resampledOther.gitFacts.head,
    'head-ai-daming/clickvibe:/wt/issue-7-g2',
    'sibling worktree of the repo must resample',
  )
  assert.equal(cachedForeign, foreign, 'another repo must keep its sample')
  assert.deepEqual(executions, [
    'ai-daming/clickvibe:/wt/issue-122',
    'ai-daming/clickvibe:/wt/issue-7',
    'other/repo:/wt/issue-122',
    'ai-daming/clickvibe:/wt/issue-122',
    'ai-daming/clickvibe:/wt/issue-7',
  ])
  void first
})

test('notifyLocalGitMutation broadcasts to every live registry', async () => {
  const a = countingRegistry()
  const b = countingRegistry()
  const firstA = await a.registry.worktreeSample(CTX, 'ai-daming/clickvibe', INPUT)
  const firstB = await b.registry.worktreeSample(CTX, 'ai-daming/clickvibe', INPUT)
  void firstA
  void firstB

  notifyLocalGitMutation({ repoKey: 'ai-daming/clickvibe', worktreePath: INPUT.worktree }, 'merge', 'mergeWorktree')

  assert.equal(a.registry.invalidations.length, 1)
  assert.equal(b.registry.invalidations.length, 1)

  const secondA = await a.registry.worktreeSample(CTX, 'ai-daming/clickvibe', INPUT)
  assert.equal(secondA.gitFacts.head, 'head-ai-daming/clickvibe:/wt/issue-122-g2')
  assert.equal(a.registry.counters.executions, 2)
})

test('counters satisfy the frozen identity logical = hit + join + execution + failure', async () => {
  const failing = new LocalGitSnapshotRegistry(async () => {
    throw new Error('boom')
  })
  await failing.worktreeSample(CTX, 'r', INPUT).then(
    () => assert.fail('must fail'),
    () => {},
  )
  assert.equal(failing.counters.failures, 1)
  assert.equal(
    failing.counters.logicalRequests,
    failing.counters.cacheHits +
      failing.counters.singleflightJoins +
      failing.counters.executions +
      failing.counters.failures,
  )

  const { registry } = countingRegistry()
  await registry.worktreeSample(CTX, 'r', INPUT)
  await registry.worktreeSample(CTX, 'r', INPUT)
  const { logicalRequests, cacheHits, singleflightJoins, executions, failures } = registry.counters
  assert.equal(logicalRequests, cacheHits + singleflightJoins + executions + failures)
})
