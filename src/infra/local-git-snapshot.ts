/**
 * Local Git Snapshot registry (ADR-0007, issue #122). One immutable sample per
 * (repository, worktree, generation); consumers join an in-flight sample;
 * invalidation bumps the generation so the next consumer resamples. A sample
 * publishes only into the generation that requested it — an invalidation
 * during sampling returns the result to its caller without caching it.
 *
 * Snapshots are process-local memory: a restart is a cold start, and nothing
 * here ever mutates the git worktree it observes. Writes elsewhere report
 * mutations through notifyLocalGitMutation().
 */

import { existsSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import {
  sampleRepositoryEnumeration,
  type RepositoryEnumerationInput,
  type RepositoryEnumerationSample,
  sampleRepositoryFacts,
  type RepositorySample,
  type RepositorySampleInput,
  sampleWorktreeFacts,
  type WorktreeSample,
  type WorktreeSampleInput,
} from './local-git-sampler.ts'
import { type ClickVibeConfig, expandHome } from './runtime.ts'
import {
  registerSnapshotRegistry,
  unregisterSnapshotRegistry,
  type LocalGitMutationScope,
} from './local-git-invalidate.ts'

export { notifyLocalGitMutation, type LocalGitMutationScope } from './local-git-invalidate.ts'

/** What consumers need from the snapshot plane (issue #122). */
export interface LocalGitSnapshotReader {
  worktreeSample(
    ctx: Context,
    repoKey: string,
    input: WorktreeSampleInput,
  ): Promise<ObservationEnvelope<WorktreeSample>>
  repositorySample(
    ctx: Context,
    repoKey: string,
    input: RepositorySampleInput,
  ): Promise<ObservationEnvelope<RepositorySample>>
  enumerationSample(
    ctx: Context,
    repoKey: string,
    input: RepositoryEnumerationInput,
  ): Promise<ObservationEnvelope<RepositoryEnumerationSample>>
}

/** Mirror readConfiguredBranchFacts' front gate: null when unconfigured or missing on disk. */
export function resolveConfiguredRepoPath(config: ClickVibeConfig, repoKey: string): string | null {
  const configuredPath = config.repos[repoKey]
  if (!configuredPath) return null
  const repoPath = expandHome(configuredPath)
  return existsSync(repoPath) ? repoPath : null
}

export interface LocalGitInvalidation {
  scope: string
  reason: string
  trigger: string
  at: number
}

export interface LocalGitCounters {
  logicalRequests: number
  cacheHits: number
  singleflightJoins: number
  executions: number
  failures: number
  invalidations: number
}

/**
 * The consumable observation contract (issue #122 AC): every sample carries
 * its scope, generation, observedAt and source revision. The envelope is one
 * immutable object per published generation.
 */
export interface ObservationEnvelope<T> {
  scope: string
  generation: number
  observedAt: number
  sourceRevision: string | null
  sample: T
}

export function worktreeScopeKey(repoKey: string, worktreePath: string): string {
  return `worktree:${repoKey}:${worktreePath}`
}

const MAX_INVALIDATION_RECORDS = 200

/** Samples are shared immutable observations; nested mutation must not poison cache hits. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const property of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[property])
    }
    Object.freeze(value)
  }
  return value
}

export class LocalGitSnapshotRegistry {
  readonly invalidations: LocalGitInvalidation[] = []
  counters: LocalGitCounters = {
    logicalRequests: 0,
    cacheHits: 0,
    singleflightJoins: 0,
    executions: 0,
    failures: 0,
    invalidations: 0,
  }

  private scopes = new Map<
    string,
    {
      repoKey: string
      generation: number
      sample: WorktreeSample | null
      observedAt: number
      sourceRevision: string | null
      envelope: ObservationEnvelope<WorktreeSample> | null
    }
  >()
  private inflight = new Map<string, { generation: number; promise: Promise<ObservationEnvelope<WorktreeSample>> }>()
  private repoScopes = new Map<
    string,
    {
      repoKey: string
      generation: number
      sample: RepositorySample | null
      observedAt: number
      envelope: ObservationEnvelope<RepositorySample> | null
    }
  >()
  private repoInflight = new Map<
    string,
    { generation: number; promise: Promise<ObservationEnvelope<RepositorySample>> }
  >()
  private enumScopes = new Map<
    string,
    {
      repoKey: string
      generation: number
      sample: RepositoryEnumerationSample | null
      observedAt: number
      envelope: ObservationEnvelope<RepositoryEnumerationSample> | null
    }
  >()
  private enumInflight = new Map<
    string,
    { generation: number; promise: Promise<ObservationEnvelope<RepositoryEnumerationSample>> }
  >()
  private readonly sampler: (ctx: Context, repoKey: string, input: WorktreeSampleInput) => Promise<WorktreeSample>
  private readonly repositorySampler: (
    ctx: Context,
    repoKey: string,
    input: RepositorySampleInput,
  ) => Promise<RepositorySample>
  private readonly enumerationSampler: (
    ctx: Context,
    repoKey: string,
    input: RepositoryEnumerationInput,
  ) => Promise<RepositoryEnumerationSample>

  /** Injectable for tests; production uses the real compound samplers. */
  constructor(
    sampler: (ctx: Context, repoKey: string, input: WorktreeSampleInput) => Promise<WorktreeSample> = (
      ctx,
      _repoKey,
      input,
    ) => sampleWorktreeFacts(ctx, input),
    repositorySampler: (ctx: Context, repoKey: string, input: RepositorySampleInput) => Promise<RepositorySample> = (
      ctx,
      _repoKey,
      input,
    ) => sampleRepositoryFacts(ctx, input),
    enumerationSampler: (
      ctx: Context,
      repoKey: string,
      input: RepositoryEnumerationInput,
    ) => Promise<RepositoryEnumerationSample> = (ctx, _repoKey, input) => sampleRepositoryEnumeration(ctx, input),
  ) {
    this.sampler = sampler
    this.repositorySampler = repositorySampler
    this.enumerationSampler = enumerationSampler
    registerSnapshotRegistry(this)
  }

  /** Release this registry from mutation broadcasts (test isolation helper). */
  dispose(): void {
    unregisterSnapshotRegistry(this)
  }

  async worktreeSample(
    ctx: Context,
    repoKey: string,
    input: WorktreeSampleInput,
  ): Promise<ObservationEnvelope<WorktreeSample>> {
    this.counters.logicalRequests++
    const key = worktreeScopeKey(repoKey, input.worktree)
    let entry = this.scopes.get(key)
    if (!entry) {
      entry = { repoKey, generation: 0, sample: null, observedAt: 0, sourceRevision: null, envelope: null }
      this.scopes.set(key, entry)
    }
    if (entry.sample && entry.envelope) {
      this.counters.cacheHits++
      return entry.envelope
    }
    const running = this.inflight.get(key)
    // Joining is generation-bound (review finding): a consumer that arrives
    // after an invalidation must never consume a sample started for a stale
    // generation, even while that old promise is still in flight.
    if (running && running.generation === entry.generation) {
      this.counters.singleflightJoins++
      return running.promise
    }
    // Each execution builds its own complete envelope from its own sample
    // (review round 2): a late-finishing stale generation never reads shared
    // entry metadata that a newer generation already replaced.
    const requestedGeneration = entry.generation
    const sample = (async () => {
      try {
        const result = await this.sampler(ctx, repoKey, input)
        // Counted on success only, so the frozen identity
        // logical = hit + join + execution + failure partitions requests.
        this.counters.executions++
        const envelope = deepFreeze({
          scope: key,
          generation: requestedGeneration,
          observedAt: Date.now(),
          sourceRevision: result.gitFacts.head,
          sample: result,
        }) as ObservationEnvelope<WorktreeSample>
        if (entry.generation === requestedGeneration) {
          entry.sample = result
          entry.observedAt = envelope.observedAt
          entry.sourceRevision = envelope.sourceRevision
          entry.envelope = envelope
        }
        return envelope
      } catch (error) {
        this.counters.failures++
        throw error
      } finally {
        if (this.inflight.get(key)?.generation === requestedGeneration) this.inflight.delete(key)
      }
    })()
    this.inflight.set(key, { generation: requestedGeneration, promise: sample })
    return sample
  }

  /** Sample the configured repository checkout once per repo+generation. */
  async repositorySample(
    ctx: Context,
    repoKey: string,
    input: RepositorySampleInput,
  ): Promise<ObservationEnvelope<RepositorySample>> {
    this.counters.logicalRequests++
    const key = `repo:${repoKey}:${input.repoPath}`
    let entry = this.repoScopes.get(key)
    if (!entry) {
      entry = { repoKey, generation: 0, sample: null, observedAt: 0, envelope: null }
      this.repoScopes.set(key, entry)
    }
    if (entry.sample && entry.envelope) {
      this.counters.cacheHits++
      return entry.envelope
    }
    const running = this.repoInflight.get(key)
    // Generation-bound join, same rule as worktree samples (review finding).
    if (running && running.generation === entry.generation) {
      this.counters.singleflightJoins++
      return running.promise
    }
    // Per-execution envelope (review round 2) — the repo source revision is
    // the sampled checkout HEAD.
    const requestedGeneration = entry.generation
    const sample = (async () => {
      try {
        const result = await this.repositorySampler(ctx, repoKey, input)
        this.counters.executions++
        const envelope = deepFreeze({
          scope: key,
          generation: requestedGeneration,
          observedAt: Date.now(),
          sourceRevision: result.head,
          sample: result,
        }) as ObservationEnvelope<RepositorySample>
        if (entry.generation === requestedGeneration) {
          entry.sample = result
          entry.observedAt = envelope.observedAt
          entry.envelope = envelope
        }
        return envelope
      } catch (error) {
        this.counters.failures++
        throw error
      } finally {
        if (this.repoInflight.get(key)?.generation === requestedGeneration) this.repoInflight.delete(key)
      }
    })()
    this.repoInflight.set(key, { generation: requestedGeneration, promise: sample })
    return sample
  }

  /** Enumerate the configured checkout once per repo+generation (issue #122 Q3). */
  async enumerationSample(
    ctx: Context,
    repoKey: string,
    input: RepositoryEnumerationInput,
  ): Promise<ObservationEnvelope<RepositoryEnumerationSample>> {
    this.counters.logicalRequests++
    const key = `enum:${repoKey}:${input.repoPath}`
    let entry = this.enumScopes.get(key)
    if (!entry) {
      entry = { repoKey, generation: 0, sample: null, observedAt: 0, envelope: null }
      this.enumScopes.set(key, entry)
    }
    if (entry.sample && entry.envelope) {
      this.counters.cacheHits++
      return entry.envelope
    }
    const running = this.enumInflight.get(key)
    if (running && running.generation === entry.generation) {
      this.counters.singleflightJoins++
      return running.promise
    }
    const requestedGeneration = entry.generation
    const sample = (async () => {
      try {
        const result = await this.enumerationSampler(ctx, repoKey, input)
        this.counters.executions++
        const envelope = deepFreeze({
          scope: key,
          generation: requestedGeneration,
          observedAt: Date.now(),
          sourceRevision: null,
          sample: result,
        }) as ObservationEnvelope<RepositoryEnumerationSample>
        if (entry.generation === requestedGeneration) {
          entry.sample = result
          entry.observedAt = envelope.observedAt
          entry.envelope = envelope
        }
        return envelope
      } catch (error) {
        this.counters.failures++
        throw error
      } finally {
        if (this.enumInflight.get(key)?.generation === requestedGeneration) this.enumInflight.delete(key)
      }
    })()
    this.enumInflight.set(key, { generation: requestedGeneration, promise: sample })
    return sample
  }

  /** Bump matching scope generations; the next consumer after this resamples. */
  invalidate(scope: LocalGitMutationScope, reason: string, trigger: string): void {
    const at = Date.now()
    for (const [key, entry] of this.scopes) {
      if (entry.repoKey !== scope.repoKey) continue
      if (scope.worktreePath && key !== worktreeScopeKey(scope.repoKey, scope.worktreePath)) continue
      entry.generation++
      entry.sample = null
      entry.envelope = null
    }
    for (const entry of this.repoScopes.values()) {
      if (entry.repoKey !== scope.repoKey) continue
      entry.generation++
      entry.sample = null
      entry.envelope = null
    }
    for (const entry of this.enumScopes.values()) {
      if (entry.repoKey !== scope.repoKey) continue
      entry.generation++
      entry.sample = null
      entry.envelope = null
    }
    this.counters.invalidations++
    this.invalidations.push({
      scope: scope.worktreePath ? worktreeScopeKey(scope.repoKey, scope.worktreePath) : `repo:${scope.repoKey}`,
      reason,
      trigger,
      at,
    })
    if (this.invalidations.length > MAX_INVALIDATION_RECORDS) {
      this.invalidations.splice(0, this.invalidations.length - MAX_INVALIDATION_RECORDS)
    }
  }
}

/** Process-lifetime registry used by the routes; tests may create isolated instances. */
export const localGitSnapshots = new LocalGitSnapshotRegistry()
