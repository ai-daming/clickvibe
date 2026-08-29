import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { enrichWorkflowStates } from '../src/workflow/repository-state.ts'
import type { RepositorySample, WorktreeSample, WorktreeSampleInput } from '../src/infra/local-git-sampler.ts'
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
  assert.equal(first, second, 'the snapshot is one immutable observation envelope')
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
  assert.equal(first.sample.gitFacts.head, 'head-ai-daming/clickvibe:/wt/issue-122-g1')

  registry.invalidate({ repoKey: 'ai-daming/clickvibe', worktreePath: INPUT.worktree }, 'worktree-sync', 'syncWorktree')
  assert.equal(registry.invalidations.length, 1)
  assert.equal(registry.invalidations[0].scope, worktreeScopeKey('ai-daming/clickvibe', INPUT.worktree))
  assert.equal(registry.invalidations[0].reason, 'worktree-sync')

  const second = await registry.worktreeSample(CTX, 'ai-daming/clickvibe', INPUT)
  assert.equal(second.sample.gitFacts.head, 'head-ai-daming/clickvibe:/wt/issue-122-g2')
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
  const registry = new LocalGitSnapshotRegistry(async () => {
    executions.push('exec')
    if (executions.length === 1) return gate
    return makeSample('head-g2')
  })

  const inflight = registry.worktreeSample(CTX, 'ai-daming/clickvibe', INPUT)
  registry.invalidate({ repoKey: 'ai-daming/clickvibe', worktreePath: INPUT.worktree }, 'agent-task-end', 'task-close')
  resolveSample(makeSample('head-stale'))
  const stale = await inflight
  assert.equal(stale.sample.gitFacts.head, 'head-stale', 'the requesting consumer still gets its sample')

  const fresh = await registry.worktreeSample(CTX, 'ai-daming/clickvibe', INPUT)
  assert.equal(fresh.sample.gitFacts.head, 'head-g2')
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
  assert.equal(
    resampled.sample.gitFacts.head,
    'head-ai-daming/clickvibe:/wt/issue-122-g2',
    'same-repo scope must resample',
  )
  assert.equal(
    resampledOther.sample.gitFacts.head,
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
  assert.equal(secondA.sample.gitFacts.head, 'head-ai-daming/clickvibe:/wt/issue-122-g2')
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

test('a consumer arriving after invalidation does not join a pre-invalidation in-flight sample', async () => {
  // Reproduces the review interleaving: old sample starts → invalidate → new
  // consumer arrives → old sample resolves. The new consumer must start a
  // fresh sample bound to the new generation, never consume the old promise.
  let releaseOld!: (sample: WorktreeSample) => void
  const oldGate = new Promise<WorktreeSample>((resolve) => {
    releaseOld = resolve
  })
  const executions: number[] = []
  const registry = new LocalGitSnapshotRegistry(async () => {
    executions.push(executions.length)
    if (executions.length === 1) return oldGate
    return makeSample('head-new')
  })

  const oldCaller = registry.worktreeSample(CTX, 'ai-daming/clickvibe', INPUT)
  registry.invalidate({ repoKey: 'ai-daming/clickvibe', worktreePath: INPUT.worktree }, 'worktree-sync', 'syncWorktree')
  const newCaller = registry.worktreeSample(CTX, 'ai-daming/clickvibe', INPUT)
  releaseOld(makeSample('head-old'))

  const oldResult = await oldCaller
  const newResult = await newCaller
  assert.equal(oldResult.sample.gitFacts.head, 'head-old', 'the pre-invalidation caller keeps its result')
  assert.equal(
    newResult.sample.gitFacts.head,
    'head-new',
    'the post-invalidation consumer must not join the old sample',
  )
  assert.equal(registry.counters.executions, 2, 'the new generation must run its own sample')
  assert.equal(registry.counters.singleflightJoins, 0, 'different generations are not a singleflight join')
})

test('repository sample: post-invalidation consumer does not join the stale in-flight sample', async () => {
  let releaseOld!: (sample: RepositorySample) => void
  const oldGate = new Promise<RepositorySample>((resolve) => {
    releaseOld = resolve
  })
  const executions: number[] = []
  const registry = new LocalGitSnapshotRegistry(
    async () => {
      throw new Error('worktree sampler must not be used')
    },
    async () => {
      executions.push(executions.length)
      if (executions.length === 1) return oldGate
      return {
        defaultBranch: 'main',
        checkoutBranch: 'main',
        main: { ahead: 0, behind: 0 },
        checkout: { ahead: 0, behind: 0 },
      }
    },
  )

  const repoPath = '/repo/main'
  const oldCaller = registry.repositorySample(CTX, 'ai-daming/clickvibe', { repoPath })
  registry.invalidate({ repoKey: 'ai-daming/clickvibe' }, 'remote-fetch', 'ensureConfiguredRepoFresh')
  const newCaller = registry.repositorySample(CTX, 'ai-daming/clickvibe', { repoPath })
  releaseOld({ defaultBranch: 'old', checkoutBranch: 'main', main: null, checkout: null })

  const oldResult = await oldCaller
  const newResult = await newCaller
  assert.equal(oldResult.sample.defaultBranch, 'old')
  assert.equal(newResult.sample.defaultBranch, 'main', 'post-invalidation consumer must sample the new generation')
  assert.equal(registry.counters.executions, 2)
  assert.equal(registry.counters.singleflightJoins, 0)
})

test('observation envelopes carry scope, generation, observedAt and source revision', async () => {
  const { registry } = countingRegistry()
  const first = await registry.worktreeSample(CTX, 'ai-daming/clickvibe', INPUT)
  assert.equal(first.scope, worktreeScopeKey('ai-daming/clickvibe', INPUT.worktree))
  assert.equal(first.generation, 0)
  assert.ok(first.observedAt > 0, 'observedAt must be set on publish')
  assert.equal(first.sourceRevision, 'head-ai-daming/clickvibe:/wt/issue-122-g1')

  const cached = await registry.worktreeSample(CTX, 'ai-daming/clickvibe', INPUT)
  assert.equal(cached, first, 'cache hits return the same immutable envelope')
  assert.equal(cached.observedAt, first.observedAt, 'observedAt is publish-time stable')

  registry.invalidate({ repoKey: 'ai-daming/clickvibe', worktreePath: INPUT.worktree }, 'worktree-sync', 'syncWorktree')
  const second = await registry.worktreeSample(CTX, 'ai-daming/clickvibe', INPUT)
  assert.equal(second.generation, 1)
  assert.ok(second.observedAt >= first.observedAt)
  assert.notEqual(second, first)
})

test('counters.invalidations counts every invalidate call', async () => {
  const { registry } = countingRegistry()
  await registry.worktreeSample(CTX, 'ai-daming/clickvibe', INPUT)
  assert.equal(registry.counters.invalidations, 0)
  registry.invalidate({ repoKey: 'ai-daming/clickvibe', worktreePath: INPUT.worktree }, 'worktree-sync', 'syncWorktree')
  registry.invalidate({ repoKey: 'ai-daming/clickvibe' }, 'remote-fetch', 'ensureConfiguredRepoFresh')
  assert.equal(registry.counters.invalidations, 2)
})

test('enriched rows carry a healthy observation with snapshot metadata', async () => {
  const { registry } = countingRegistry()
  const repoDir = mkdtempSync(join(tmpdir(), 'clickvibe-obs-meta-'))
  try {
    execFileSync('git', ['init', '--initial-branch=main', repoDir])
    writeFileSync(join(repoDir, 'a.txt'), 'x')
    execFileSync('git', ['-C', repoDir, 'add', 'a.txt'])
    execFileSync('git', ['-C', repoDir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'base'])

    const workflow = {
      key: 'ai-daming/clickvibe#122',
      url: 'https://github.com/ai-daming/clickvibe/issues/122',
      repoKey: 'ai-daming/clickvibe',
      worktree: repoDir,
      branch: 'main',
      stage: 'idle' as const,
      devAgent: null,
      devTaskId: null,
      devSessionId: null,
      devSessionAgent: null,
      devInterrupted: false,
      reviewAgent: null,
      reviewTaskId: null,
      reviewSessionId: null,
      reviewSessionAgent: null,
      reviewResult: null,
      prNumber: null,
      issueState: 'OPEN' as const,
      baseRef: 'main',
      updatedAt: Date.now(),
      events: [],
    }
    const ctx = { shell: { resolve: (spec: unknown) => spec, run: async () => assert.fail('no shell expected') } }
    const [row] = await enrichWorkflowStates(
      ctx as never,
      [workflow],
      {
        repos: { 'ai-daming/clickvibe': repoDir },
        worktreeRoot: repoDir,
      },
      registry,
    )
    assert.ok(row.observation, 'registry-backed rows must expose observation metadata')
    assert.equal(row.observation.freshness, 'current')
    assert.ok(row.observation.scope.startsWith('worktree:ai-daming/clickvibe:'))
    assert.equal(row.observation.generation, 0)
    assert.ok(row.observation.observedAt > 0)
    // The injected registry's fake sampler defines the revision; the derived
    // row must consume the same snapshot's head.
    assert.ok('derived' in row && row.derived, 'healthy rows must still carry derived state')
    assert.equal(row.observation.sourceRevision, row.derived.head)
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
  }
})
