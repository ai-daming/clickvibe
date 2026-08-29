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
  const first = (await registry.observeWorktree(CTX, 'ai-daming/clickvibe', INPUT)).envelope
  const second = (await registry.observeWorktree(CTX, 'ai-daming/clickvibe', INPUT)).envelope
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
  const first = registry.observeWorktree(CTX, 'ai-daming/clickvibe', INPUT).then((outcome) => outcome.envelope)
  const second = registry.observeWorktree(CTX, 'ai-daming/clickvibe', INPUT).then((outcome) => outcome.envelope)
  resolveSample(makeSample('abc1234'))
  assert.equal(await first, await second)
  assert.equal(registry.counters.singleflightJoins, 1)
  assert.equal(registry.counters.executions, 1)
  assert.equal(registry.counters.logicalRequests, 2)
})

test('invalidation bumps the generation and the next consumer resamples', async () => {
  const { registry, executions } = countingRegistry()
  const first = (await registry.observeWorktree(CTX, 'ai-daming/clickvibe', INPUT)).envelope
  assert.equal(first.sample.gitFacts.head, 'head-ai-daming/clickvibe:/wt/issue-122-g1')

  registry.invalidate({ repoKey: 'ai-daming/clickvibe', worktreePath: INPUT.worktree }, 'worktree-sync', 'syncWorktree')
  assert.equal(registry.invalidations.length, 1)
  assert.equal(registry.invalidations[0].scope, worktreeScopeKey('ai-daming/clickvibe', INPUT.worktree))
  assert.equal(registry.invalidations[0].reason, 'worktree-sync')

  const second = (await registry.observeWorktree(CTX, 'ai-daming/clickvibe', INPUT)).envelope
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

  const inflight = registry.observeWorktree(CTX, 'ai-daming/clickvibe', INPUT).then((outcome) => outcome.envelope)
  registry.invalidate({ repoKey: 'ai-daming/clickvibe', worktreePath: INPUT.worktree }, 'agent-task-end', 'task-close')
  resolveSample(makeSample('head-stale'))
  const stale = await inflight
  assert.equal(stale.sample.gitFacts.head, 'head-stale', 'the requesting consumer still gets its sample')

  const fresh = (await registry.observeWorktree(CTX, 'ai-daming/clickvibe', INPUT)).envelope
  assert.equal(fresh.sample.gitFacts.head, 'head-g2')
  assert.equal(registry.counters.executions, 2, 'the stale sample must not satisfy the next generation')
})

test('repo-wide invalidation clears every worktree scope of that repo only', async () => {
  const otherInput = { ...INPUT, worktree: '/wt/issue-7' }
  const { registry, executions } = countingRegistry()
  const first = (await registry.observeWorktree(CTX, 'ai-daming/clickvibe', INPUT)).envelope
  const other = (await registry.observeWorktree(CTX, 'ai-daming/clickvibe', otherInput)).envelope
  const foreign = (await registry.observeWorktree(CTX, 'other/repo', INPUT)).envelope
  assert.deepEqual(executions, [
    'ai-daming/clickvibe:/wt/issue-122',
    'ai-daming/clickvibe:/wt/issue-7',
    'other/repo:/wt/issue-122',
  ])

  registry.invalidate({ repoKey: 'ai-daming/clickvibe' }, 'remote-fetch', 'ensureConfiguredRepoFresh')
  assert.equal(registry.invalidations[0].scope, 'repo:ai-daming/clickvibe')

  const resampled = (await registry.observeWorktree(CTX, 'ai-daming/clickvibe', INPUT)).envelope
  const resampledOther = (await registry.observeWorktree(CTX, 'ai-daming/clickvibe', otherInput)).envelope
  const cachedForeign = (await registry.observeWorktree(CTX, 'other/repo', INPUT)).envelope
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
  const firstA = await a.registry.observeWorktree(CTX, 'ai-daming/clickvibe', INPUT)
  const firstB = await b.registry.observeWorktree(CTX, 'ai-daming/clickvibe', INPUT)
  void firstA
  void firstB

  notifyLocalGitMutation({ repoKey: 'ai-daming/clickvibe', worktreePath: INPUT.worktree }, 'merge', 'mergeWorktree')

  assert.equal(a.registry.invalidations.length, 1)
  assert.equal(b.registry.invalidations.length, 1)

  const secondA = (await a.registry.observeWorktree(CTX, 'ai-daming/clickvibe', INPUT)).envelope
  assert.equal(secondA.sample.gitFacts.head, 'head-ai-daming/clickvibe:/wt/issue-122-g2')
  assert.equal(a.registry.counters.executions, 2)
})

test('counters satisfy the frozen identity logical = hit + join + execution + failure', async () => {
  const failing = new LocalGitSnapshotRegistry(async () => {
    throw new Error('boom')
  })
  // The observation primitive never rejects: the outcome carries both raw
  // attempts (Runtime Observer round 7).
  const outcome = await failing.observeWorktree(CTX, 'r', INPUT)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.attempts.length, 2)
  assert.equal(outcome.attempts[0].message, 'boom')
  assert.equal(outcome.attempts[1].name, 'Error')
  assert.equal(failing.counters.failures, 2)
  assert.equal(
    failing.counters.logicalRequests,
    failing.counters.cacheHits +
      failing.counters.singleflightJoins +
      failing.counters.executions +
      failing.counters.failures,
  )

  const { registry } = countingRegistry()
  await registry.observeWorktree(CTX, 'r', INPUT)
  await registry.observeWorktree(CTX, 'r', INPUT)
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

  const oldCaller = registry.observeWorktree(CTX, 'ai-daming/clickvibe', INPUT).then((outcome) => outcome.envelope)
  registry.invalidate({ repoKey: 'ai-daming/clickvibe', worktreePath: INPUT.worktree }, 'worktree-sync', 'syncWorktree')
  const newCaller = registry.observeWorktree(CTX, 'ai-daming/clickvibe', INPUT).then((outcome) => outcome.envelope)
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
  const oldCaller = registry
    .observeRepository(CTX, 'ai-daming/clickvibe', { repoPath })
    .then((outcome) => outcome.envelope)
  registry.invalidate({ repoKey: 'ai-daming/clickvibe' }, 'remote-fetch', 'ensureConfiguredRepoFresh')
  const newCaller = registry
    .observeRepository(CTX, 'ai-daming/clickvibe', { repoPath })
    .then((outcome) => outcome.envelope)
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
  const first = (await registry.observeWorktree(CTX, 'ai-daming/clickvibe', INPUT)).envelope
  assert.equal(first.scope, worktreeScopeKey('ai-daming/clickvibe', INPUT.worktree))
  assert.equal(first.generation, 0)
  assert.ok(first.observedAt > 0, 'observedAt must be set on publish')
  assert.equal(first.sourceRevision, 'head-ai-daming/clickvibe:/wt/issue-122-g1')

  const cached = (await registry.observeWorktree(CTX, 'ai-daming/clickvibe', INPUT)).envelope
  assert.equal(cached, first, 'cache hits return the same immutable envelope')
  assert.equal(cached.observedAt, first.observedAt, 'observedAt is publish-time stable')

  registry.invalidate({ repoKey: 'ai-daming/clickvibe', worktreePath: INPUT.worktree }, 'worktree-sync', 'syncWorktree')
  const second = (await registry.observeWorktree(CTX, 'ai-daming/clickvibe', INPUT)).envelope
  assert.equal(second.generation, 1)
  assert.ok(second.observedAt >= first.observedAt)
  assert.notEqual(second, first)
})

test('counters.invalidations counts every invalidate call', async () => {
  const { registry } = countingRegistry()
  await registry.observeWorktree(CTX, 'ai-daming/clickvibe', INPUT)
  assert.equal(registry.counters.invalidations, 0)
  registry.invalidate({ repoKey: 'ai-daming/clickvibe', worktreePath: INPUT.worktree }, 'worktree-sync', 'syncWorktree')
  registry.invalidate({ repoKey: 'ai-daming/clickvibe' }, 'remote-fetch', 'ensureConfiguredRepoFresh')
  assert.equal(registry.counters.invalidations, 2)
})

test('healthy rows carry no observation field; provenance lives in the envelope', async () => {
  // Occam pass: the snapshot envelope already carries scope/generation/
  // observedAt/sourceRevision (issue AC); rows only surface an observation
  // when the scene is unknown.
  const { registry } = countingRegistry()
  const repoDir = mkdtempSync(join(tmpdir(), 'clickvibe-obs-razor-'))
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
      stage: 'idle',
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
      issueState: 'OPEN',
      baseRef: 'main',
      updatedAt: Date.now(),
      events: [],
    }
    const ctx = { shell: { resolve: (spec: unknown) => spec, run: async () => assert.fail('no shell expected') } }
    const [row] = await enrichWorkflowStates(
      ctx as never,
      [workflow],
      { repos: { 'ai-daming/clickvibe': repoDir }, worktreeRoot: repoDir },
      registry,
    )
    assert.ok(row.derived, 'healthy rows still derive')
    assert.equal('observation' in row && row.observation !== undefined, false, 'no healthy-row observation mirror')
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
  }
})

test('reverse completion: gen0 finishing after gen1 published keeps its own envelope metadata', async () => {
  // Review round 2: gen0 starts → invalidate → gen1 samples, publishes →
  // gen0 completes last. gen0's envelope must describe gen0's own sample.
  let releaseOld!: (sample: WorktreeSample) => void
  const oldGate = new Promise<WorktreeSample>((resolve) => {
    releaseOld = resolve
  })
  let calls = 0
  const registry = new LocalGitSnapshotRegistry(async () => {
    calls += 1
    return calls === 1 ? oldGate : Promise.resolve(makeSample('head-old'))
  })
  const gen0 = registry.observeWorktree(CTX, 'ai-daming/clickvibe', INPUT).then((outcome) => outcome.envelope)
  registry.invalidate({ repoKey: 'ai-daming/clickvibe', worktreePath: INPUT.worktree }, 'worktree-sync', 'syncWorktree')

  const gen1 = (await registry.observeWorktree(CTX, 'ai-daming/clickvibe', INPUT)).envelope
  assert.equal(gen1.generation, 1)
  releaseOld(makeSample('head-old'))

  const late = await gen0
  assert.equal(late.generation, 0, 'gen0 keeps its own generation')
  assert.equal(late.sample.gitFacts.head, 'head-old')
  assert.equal(late.sourceRevision, 'head-old', 'gen0 metadata must not leak gen1 values')
  assert.ok(Number.isFinite(late.observedAt))

  // Cached gen1 hit must equal the published gen1 envelope exactly.
  const cached = (await registry.observeWorktree(CTX, 'ai-daming/clickvibe', INPUT)).envelope
  assert.equal(cached, gen1)
})

test('reverse completion with distinct samplers keeps envelopes field-isolated', async () => {
  let releaseOld!: (sample: WorktreeSample) => void
  const oldGate = new Promise<WorktreeSample>((resolve) => {
    releaseOld = resolve
  })
  let calls = 0
  const registry = new LocalGitSnapshotRegistry(async () => {
    calls += 1
    return calls === 1 ? oldGate : Promise.resolve(makeSample('head-new'))
  })
  const gen0 = registry.observeWorktree(CTX, 'ai-daming/clickvibe', INPUT).then((outcome) => outcome.envelope)
  registry.invalidate({ repoKey: 'ai-daming/clickvibe', worktreePath: INPUT.worktree }, 'agent-task-end', 'finishTask')
  const gen1 = (await registry.observeWorktree(CTX, 'ai-daming/clickvibe', INPUT)).envelope
  releaseOld(makeSample('head-old'))
  const late = await gen0

  assert.equal(gen1.generation, 1)
  assert.equal(gen1.sample.gitFacts.head, 'head-new')
  assert.equal(gen1.sourceRevision, 'head-new')
  assert.equal(late.generation, 0)
  assert.equal(late.sample.gitFacts.head, 'head-old')
  assert.equal(late.sourceRevision, 'head-old', 'no cross-generation metadata mixing')
})

test('repo reverse completion keeps envelope field-isolated and reports checkout HEAD', async () => {
  let releaseOld!: (sample: RepositorySample) => void
  const oldGate = new Promise<RepositorySample>((resolve) => {
    releaseOld = resolve
  })
  let calls = 0
  const registry = new LocalGitSnapshotRegistry(
    async () => {
      throw new Error('worktree sampler unused')
    },
    async () => {
      calls += 1
      return calls === 1 ? oldGate : Promise.resolve(repoSample('head-new'))
    },
  )
  const gen0 = registry
    .observeRepository(CTX, 'ai-daming/clickvibe', { repoPath: '/repo/main' })
    .then((outcome) => outcome.envelope)
  registry.invalidate({ repoKey: 'ai-daming/clickvibe' }, 'remote-fetch', 'ensureConfiguredRepoFresh')
  const gen1 = (await registry.observeRepository(CTX, 'ai-daming/clickvibe', { repoPath: '/repo/main' })).envelope
  releaseOld(repoSample('head-old'))
  const late = await gen0

  assert.equal(gen1.generation, 1)
  assert.equal(gen1.sourceRevision, 'head-new', 'repo envelope must carry checkout HEAD')
  assert.equal(late.generation, 0)
  assert.equal(late.sourceRevision, 'head-old')
})

test('published envelopes and samples are deeply immutable', async () => {
  const { registry } = countingRegistry()
  const first = (await registry.observeWorktree(CTX, 'ai-daming/clickvibe', INPUT)).envelope
  assert.throws(() => {
    first.sample.gitFacts.head = 'tampered'
  }, /Cannot assign to read only|not extensible|readonly/i)
  assert.throws(() => {
    ;(first as { generation: number }).generation = 99
  }, /Cannot assign to read only|not extensible|readonly/i)
  const cached = (await registry.observeWorktree(CTX, 'ai-daming/clickvibe', INPUT)).envelope
  assert.equal(cached.sample.gitFacts.head, first.sample.gitFacts.head)
})

function repoSample(head: string): RepositorySample {
  return {
    defaultBranch: 'main',
    checkoutBranch: 'main',
    main: { ahead: 0, behind: 0 },
    checkout: { ahead: 0, behind: 0 },
    head,
  }
}
