/**
 * Gateway owner (issue #131 slice A; ADR-0010 §1/§4/§7).
 *
 * One credential scope owns one Gateway runtime: the request lane, the
 * observation caches with their generations, in-flight singleflight, forced
 * reads, resource versions and the rate-limit circuit. v0.2 is deliberately
 * conservative about scope identity — the `gh` CLI host auth cannot be safely
 * split into distinct credentials, so every owner declares the same single
 * scope (under-sharing reuse is acceptable, splitting one budget never is).
 *
 * Readers bind to an owner and keep only shell I/O and response parsing:
 * two readers on one owner share observations, singleflight and the circuit
 * (worktrees attribute calls, they never own Gateway state). The algorithms
 * are moved verbatim from the former reader-private state; the lane came
 * from the former host-global symbol. Priority admission, budgets and
 * lifecycle events join in later commits together with their consumers.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { GithubRateLimitError, type GithubRateLimitKind } from './rest.ts'
import {
  GatewayLifecycleRecorder,
  type GatewayLifecycleEvent,
  type GatewayMetrics,
  type GatewayRateObservation,
} from './gateway-lifecycle.ts'
import { deriveGatewayMetrics } from './gateway-lifecycle.ts'

interface OwnerRequestLane {
  tail: Promise<void>
  nextStartAt: number
}

interface CachedValue<T> {
  value: T
  version: string | null
  expiresAt: number
}

export interface CachedResourceOptions<T> {
  ttlMs?: number
  force?: boolean
  versionOf?: (value: T) => string | null | undefined
}

export interface GithubGatewayOwner {
  /** Opaque identity; never contains token material. */
  readonly credentialScopeId: string
  /** Declare one logical request; throws once the owner is closed. */
  declareLogicalRequest(scope: 'resource' | 'aggregate' | 'direct', key: string): string
  /** Ambient logical-request attribution for loader-internal upstream steps. */
  runWithRequest<T>(requestId: string, fn: () => Promise<T>): Promise<T>
  ambientRequestId(): string | null
  /** One dispatched HTTP step of a logical request. */
  noteDispatched(requestId: string): void
  /** Settle one HTTP step with the response's real rate fields (null when absent). */
  noteUpstreamSettled(requestId: string, ok: boolean, rate: GatewayRateObservation | null): void
  /** Terminal for a logical request; outcome from the error shape when thrown. */
  noteTerminal(
    requestId: string,
    outcome: 'succeeded' | 'failed' | 'rate-limited' | 'interrupted',
    error?: unknown,
  ): void
  /** The lifecycle stream — the single metric and evidence source (ADR-0010 §10). */
  lifecycleEvents(): GatewayLifecycleEvent[]
  lifecycleMetrics(): GatewayMetrics
  /** Seal the owner: no new logical requests; recorder stops accepting events. */
  close(): void
  /** Serialize one HTTP step across the credential scope with a minimum start interval. */
  serializeRequest<T>(minimumIntervalMs: number, request: () => Promise<T>): Promise<T>
  rateLimitError(now?: number): GithubRateLimitError | null
  /** Record a rate-limit trip observed on a response (kind from the response shape). */
  noteRateLimitTrip(until: number, kind: GithubRateLimitKind): void
  assertCircuitOpen(): void
  rememberVersion(key: string, version: string | null | undefined): void
  resourceVersion(key: string): string | null
  invalidate(prefix: string): void
  cachedResource<T>(
    key: string,
    version: string | null | undefined,
    loader: () => Promise<T>,
    options?: CachedResourceOptions<T>,
  ): Promise<T>
  cachedAggregate<T>(key: string, ttlMs: number, force: boolean, loader: () => Promise<T>): Promise<T>
}

/** Conservative v0.2 scope: the host's gh auth is one credential. */
const CONSERVATIVE_CREDENTIAL_SCOPE = 'host-gh-auth:v1'

export function createGithubGatewayOwner(): GithubGatewayOwner {
  const lane: OwnerRequestLane = { tail: Promise.resolve(), nextStartAt: 0 }
  const resources = new Map<string, CachedValue<unknown>>()
  const aggregates = new Map<string, CachedValue<unknown>>()
  const inFlight = new Map<string, { promise: Promise<unknown>; requestId: string }>()
  const forcedResources = new Map<string, { promise: Promise<unknown>; requestId: string }>()
  const versions = new Map<string, string>()
  const resourceLoadSequence = new Map<string, number>()
  let circuitUntil = 0
  let circuitKind: GithubRateLimitKind = 'unknown'
  const recorder = new GatewayLifecycleRecorder()
  const requestAls = new AsyncLocalStorage<string>()
  const stepCounts = new Map<string, number>()
  let nextRequestId = 0

  const errorText = (error: unknown): string | null =>
    error instanceof Error ? error.message : error === undefined ? null : String(error)
  const isRateLimit = (error: unknown): boolean => error instanceof GithubRateLimitError

  const settleTerminalOn = (promise: Promise<unknown>, requestId: string): void => {
    void promise.then(
      () => owner.noteTerminal(requestId, 'succeeded'),
      (error: unknown) => owner.noteTerminal(requestId, isRateLimit(error) ? 'rate-limited' : 'failed', error),
    )
  }

  const owner: GithubGatewayOwner = {
    credentialScopeId: CONSERVATIVE_CREDENTIAL_SCOPE,
    serializeRequest<T>(minimumIntervalMs: number, request: () => Promise<T>): Promise<T> {
      const previous = lane.tail
      let release = () => {}
      lane.tail = new Promise<void>((resolve) => {
        release = resolve
      })
      return (async () => {
        await previous
        try {
          // Timers may wake just before their requested deadline. Re-check the
          // monotonic wall-clock condition so the configured start interval is a
          // guarantee rather than a best-effort delay.
          while (Date.now() < lane.nextStartAt) {
            await new Promise((resolve) => setTimeout(resolve, lane.nextStartAt - Date.now()))
          }
          const pending = request()
          lane.nextStartAt = Date.now() + minimumIntervalMs
          return await pending
        } finally {
          release()
        }
      })()
    },
    declareLogicalRequest(scope: 'resource' | 'aggregate' | 'direct', key: string): string {
      if (recorder.sealed) throw new Error('Gateway 已关闭,拒绝新的 GitHub 访问申请')
      nextRequestId += 1
      const requestId = `gh-${nextRequestId}`
      recorder.emit({ kind: 'declared', requestId, scope, key, at: Date.now() })
      return requestId
    },
    runWithRequest<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
      return requestAls.run(requestId, fn)
    },
    ambientRequestId(): string | null {
      return requestAls.getStore() ?? null
    },
    noteDispatched(requestId: string): void {
      const step = (stepCounts.get(requestId) ?? 0) + 1
      stepCounts.set(requestId, step)
      recorder.emit({ kind: 'dispatched', requestId, step, at: Date.now() })
    },
    noteUpstreamSettled(requestId: string, ok: boolean, rate: GatewayRateObservation | null): void {
      const step = stepCounts.get(requestId) ?? 1
      recorder.emit({ kind: 'upstream-settled', requestId, step, ok, rate, at: Date.now() })
    },
    noteTerminal(
      requestId: string,
      outcome: 'succeeded' | 'failed' | 'rate-limited' | 'interrupted',
      error?: unknown,
    ): void {
      recorder.emit({ kind: 'terminal', requestId, outcome, error: errorText(error), at: Date.now() })
    },
    lifecycleEvents(): GatewayLifecycleEvent[] {
      return recorder.snapshot()
    },
    lifecycleMetrics(): GatewayMetrics {
      return deriveGatewayMetrics(recorder.snapshot())
    },
    close(): void {
      recorder.seal()
    },
    rateLimitError(now = Date.now()): GithubRateLimitError | null {
      return circuitUntil > now ? new GithubRateLimitError(circuitUntil, circuitKind) : null
    },
    noteRateLimitTrip(until: number, kind: GithubRateLimitKind): void {
      circuitUntil = until
      circuitKind = kind
    },
    assertCircuitOpen(): void {
      const error = owner.rateLimitError()
      if (error) throw error
    },
    rememberVersion(key: string, version: string | null | undefined): void {
      if (version) versions.set(key, version)
    },
    resourceVersion(key: string): string | null {
      return versions.get(key) ?? null
    },
    invalidate(prefix: string): void {
      for (const key of resources.keys()) {
        if (key === prefix || key.startsWith(`${prefix}/`)) resources.delete(key)
      }
      for (const key of aggregates.keys()) {
        if (key === prefix || key.startsWith(`${prefix}/`)) aggregates.delete(key)
      }
      versions.delete(prefix)
      for (const key of forcedResources.keys()) {
        if (key === prefix || key.startsWith(`${prefix}/`)) forcedResources.delete(key)
      }
      for (const key of resourceLoadSequence.keys()) {
        if (key === prefix || key.startsWith(`${prefix}/`)) {
          resourceLoadSequence.set(key, (resourceLoadSequence.get(key) ?? 0) + 1)
        }
      }
    },
    async cachedResource<T>(
      key: string,
      version: string | null | undefined,
      loader: () => Promise<T>,
      options: CachedResourceOptions<T> = {},
    ): Promise<T> {
      const requestId = owner.declareLogicalRequest('resource', key)
      try {
        owner.assertCircuitOpen()
      } catch (error) {
        owner.noteTerminal(requestId, 'rate-limited', error)
        return Promise.reject(error)
      }
      const forcedPending = forcedResources.get(key) as { promise: Promise<T>; requestId: string } | undefined
      if (!options.force && forcedPending) {
        recorder.emit({ kind: 'joined', requestId, leaderId: forcedPending.requestId, at: Date.now() })
        settleTerminalOn(forcedPending.promise, requestId)
        return forcedPending.promise
      }
      const knownVersion = version || null
      const cached = resources.get(key) as CachedValue<T> | undefined
      const now = Date.now()
      if (
        !options.force &&
        cached &&
        cached.expiresAt > now &&
        (knownVersion === null || cached.version === knownVersion)
      ) {
        recorder.emit({ kind: 'cache-hit', requestId, at: Date.now() })
        owner.noteTerminal(requestId, 'succeeded')
        return Promise.resolve(cached.value)
      }
      const load: Promise<T> = owner.runWithRequest(requestId, async () => {
        const sequence = (resourceLoadSequence.get(key) ?? 0) + 1
        resourceLoadSequence.set(key, sequence)
        const value = await loader()
        const loadedVersion = options.versionOf?.(value) || knownVersion
        // A later-started force read is authoritative. An older ordinary request
        // may still resolve for its caller, but must never overwrite that result.
        if (resourceLoadSequence.get(key) === sequence) {
          resources.set(key, {
            value,
            version: loadedVersion,
            expiresAt: Date.now() + (options.ttlMs ?? 30_000),
          })
          if (loadedVersion) versions.set(key, loadedVersion)
        }
        return value
      })
      settleTerminalOn(load, requestId)
      if (!options.force) return deduplicate(`resource:ordinary:${key}`, load, requestId)

      // `force` means fresh from this invocation point. It must not coalesce
      // with an earlier force call whose GitHub fact may already be obsolete.
      const forced = load
      forcedResources.set(key, { promise: forced, requestId })
      const clear = () => {
        if (forcedResources.get(key)?.promise === forced) forcedResources.delete(key)
      }
      void forced.then(clear, clear)
      return forced
    },
    async cachedAggregate<T>(key: string, ttlMs: number, force: boolean, loader: () => Promise<T>): Promise<T> {
      const requestId = owner.declareLogicalRequest('aggregate', key)
      try {
        owner.assertCircuitOpen()
      } catch (error) {
        owner.noteTerminal(requestId, 'rate-limited', error)
        return Promise.reject(error)
      }
      const cached = aggregates.get(key) as CachedValue<T> | undefined
      if (!force && cached && cached.expiresAt > Date.now()) {
        recorder.emit({ kind: 'cache-hit', requestId, at: Date.now() })
        owner.noteTerminal(requestId, 'succeeded')
        return Promise.resolve(cached.value)
      }
      const load = owner.runWithRequest(requestId, async () => {
        const value = await loader()
        aggregates.set(key, { value, version: null, expiresAt: Date.now() + ttlMs })
        return value
      })
      settleTerminalOn(load, requestId)
      return deduplicate(`aggregate:${key}`, load, requestId)
    },
  }

  function deduplicate<T>(key: string, created: Promise<T>, leaderRequestId: string): Promise<T> {
    const entry = inFlight.get(key) as { promise: Promise<T>; requestId: string } | undefined
    if (entry) {
      recorder.emit({ kind: 'joined', requestId: leaderRequestId, leaderId: entry.requestId, at: Date.now() })
      settleTerminalOn(entry.promise, leaderRequestId)
      return entry.promise
    }
    const tracked = created.finally(() => inFlight.delete(key))
    inFlight.set(key, { promise: tracked, requestId: leaderRequestId })
    return tracked
  }

  return owner
}
