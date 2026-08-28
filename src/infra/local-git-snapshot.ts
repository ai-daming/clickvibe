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
import { sampleWorktreeFacts, type WorktreeSample, type WorktreeSampleInput } from './local-git-sampler.ts'
import { type ClickVibeConfig, expandHome } from './runtime.ts'
import {
  registerSnapshotRegistry,
  unregisterSnapshotRegistry,
  type LocalGitMutationScope,
} from './local-git-invalidate.ts'

export { notifyLocalGitMutation, type LocalGitMutationScope } from './local-git-invalidate.ts'

/** What consumers need from the snapshot plane (issue #122). */
export interface LocalGitSnapshotReader {
  worktreeSample(ctx: Context, repoKey: string, input: WorktreeSampleInput): Promise<WorktreeSample>
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
}

export function worktreeScopeKey(repoKey: string, worktreePath: string): string {
  return `worktree:${repoKey}:${worktreePath}`
}

const MAX_INVALIDATION_RECORDS = 200

export class LocalGitSnapshotRegistry {
  readonly invalidations: LocalGitInvalidation[] = []
  counters: LocalGitCounters = {
    logicalRequests: 0,
    cacheHits: 0,
    singleflightJoins: 0,
    executions: 0,
    failures: 0,
  }

  private scopes = new Map<
    string,
    {
      repoKey: string
      generation: number
      sample: WorktreeSample | null
      observedAt: number
      sourceRevision: string | null
    }
  >()
  private inflight = new Map<string, Promise<WorktreeSample>>()
  private readonly sampler: (ctx: Context, repoKey: string, input: WorktreeSampleInput) => Promise<WorktreeSample>

  /** Injectable for tests; production uses the real compound sampler. */
  constructor(
    sampler: (ctx: Context, repoKey: string, input: WorktreeSampleInput) => Promise<WorktreeSample> = (
      ctx,
      _repoKey,
      input,
    ) => sampleWorktreeFacts(ctx, input),
  ) {
    this.sampler = sampler
    registerSnapshotRegistry(this)
  }

  /** Release this registry from mutation broadcasts (test isolation helper). */
  dispose(): void {
    unregisterSnapshotRegistry(this)
  }

  async worktreeSample(ctx: Context, repoKey: string, input: WorktreeSampleInput): Promise<WorktreeSample> {
    this.counters.logicalRequests++
    const key = worktreeScopeKey(repoKey, input.worktree)
    let entry = this.scopes.get(key)
    if (!entry) {
      entry = { repoKey, generation: 0, sample: null, observedAt: 0, sourceRevision: null }
      this.scopes.set(key, entry)
    }
    if (entry.sample) {
      this.counters.cacheHits++
      return entry.sample
    }
    const running = this.inflight.get(key)
    if (running) {
      this.counters.singleflightJoins++
      return running
    }
    const requestedGeneration = entry.generation
    const sample = (async () => {
      try {
        const result = await this.sampler(ctx, repoKey, input)
        // Counted on success only, so the frozen identity
        // logical = hit + join + execution + failure partitions requests.
        this.counters.executions++
        if (entry.generation === requestedGeneration) {
          entry.sample = result
          entry.observedAt = Date.now()
          entry.sourceRevision = result.gitFacts.head
        }
        return result
      } catch (error) {
        this.counters.failures++
        throw error
      } finally {
        this.inflight.delete(key)
      }
    })()
    this.inflight.set(key, sample)
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
    }
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
