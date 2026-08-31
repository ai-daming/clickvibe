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

/** v0.2 admission numbers — recorded here per ADR-0010 Neutral: values are
 *  pinned from the #133 frozen scenarios' shapes and must be re-cited when
 *  the frozen thresholds are rerun on the implementation SHA. */
const CREDENTIAL_TOTAL_CONCURRENCY = 6
const REPOSITORY_CONCURRENCY = 3
const UNKNOWN_BUDGET_PROBE_CAP = 2
const NORMAL_AGING_MS = 10_000

interface PendingStep {
  requestId: string
  repo: string
  priority: 'critical' | 'normal'
  deadlineAt: number
  enqueuedAt: number
  pacingMs: number
  run: () => Promise<unknown>
  settle: (value: unknown) => void
  fail: (error: unknown) => void
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

export interface CachedAggregateOptions<T> {
  /** Child resource versions observed by this aggregate settlement — the owner
   *  records them so callers never write reader cache state (design §11). */
  derivedVersions?: (value: T) => Array<[key: string, version: string | null | undefined]>
}

export interface GithubGatewayOwner {
  /** Opaque identity; never contains token material. */
  readonly credentialScopeId: string
  /** Declare one logical request; throws once the owner is closed. */
  declareLogicalRequest(scope: 'resource' | 'aggregate' | 'direct', key: string): string
  /** Ambient logical-request attribution for loader-internal upstream steps. */
  runWithRequest<T>(requestId: string, fn: () => Promise<T>): Promise<T>
  ambientRequestId(): string | null
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
  /**
   * Admit and execute ONE upstream HTTP step (ADR-0010 §6 dispatch loop).
   * Steps wait in priority lanes (critical first, normal with aging), are
   * picked by repository round-robin under credential/repo concurrency caps,
   * pass budget admission (known remaining / reset vs the step deadline) and
   * start no sooner than the pacing interval. A slow step occupies only its
   * own execution slot — no scheduler mutex is held while awaiting the network.
   */
  submitStep<T>(repo: string, timeoutMs: number, pacingMs: number, run: () => Promise<T>): Promise<T>
  /** Stamp the ambient operation priority ('critical' only for gate families). */
  withPriority<T>(priority: 'critical' | 'normal', fn: () => Promise<T>): Promise<T>

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
  cachedAggregate<T>(
    key: string,
    ttlMs: number,
    force: boolean,
    loader: () => Promise<T>,
    options?: CachedAggregateOptions<T>,
  ): Promise<T>
  /** Resolve when no step is waiting or running (test/evidence quiescence). */
  idle(): Promise<void>
  /** Stop admission, interrupt queued steps, drain running to a deadline, seal. */
  close(options?: { drainMs?: number }): Promise<void>
}

/** Conservative v0.2 scope: the host's gh auth is one credential. */
const CONSERVATIVE_CREDENTIAL_SCOPE = 'host-gh-auth:v1'

export function createGithubGatewayOwner(): GithubGatewayOwner {
  const waiting: PendingStep[] = []
  const running = new Map<number, PendingStep & { runner: Promise<unknown> }>()
  const lastDispatchPerRepo = new Map<string, number>()
  let nextStartAt = 0
  let dispatchScheduled = false
  let budget: { remaining: number; reset: number | null } | null = null // eslint-disable-line prefer-const
  let closed = false
  let idleWaiters: Array<() => void> = []
  const resources = new Map<string, CachedValue<unknown>>()
  const aggregates = new Map<string, CachedValue<unknown>>()
  const inFlight = new Map<string, { promise: Promise<unknown>; requestId: string }>()
  const forcedResources = new Map<string, { promise: Promise<unknown>; requestId: string }>()
  const versions = new Map<string, string>()
  const resourceLoadSequence = new Map<string, number>()
  const aggregateGenerations = new Map<string, number>()
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

  const requestPriorities = new Map<string, 'critical' | 'normal'>()
  const priorityAls = new AsyncLocalStorage<'critical' | 'normal'>()

  const flushIdleWaiters = () => {
    if (waiting.length === 0 && running.size === 0) {
      const waiters = idleWaiters
      idleWaiters = []
      for (const resolve of waiters) resolve()
    }
  }

  const scheduleDispatch = () => {
    flushIdleWaiters()
    if (dispatchScheduled) return
    dispatchScheduled = true
    queueMicrotask(() => {
      // Release BEFORE running: the loop's finally would otherwise free the
      // guard only on the next microtask tick, swallowing a submitStep that
      // shares the caller's synchronous block (the r2 stall).
      dispatchScheduled = false
      void dispatchLoop()
    })
  }

  /** Atomically REMOVE the next eligible step — the taker owns it exclusively,
   *  so concurrent dispatch loops can never double-dispatch one step. */
  const takeCandidate = (): PendingStep | null => {
    const now = Date.now()
    const eligible = waiting.filter((step) => {
      const repoRunning = [...running.values()].filter((entry) => entry.repo === step.repo).length
      return repoRunning < REPOSITORY_CONCURRENCY
    })
    if (eligible.length === 0) return null
    const critical = eligible.filter((step) => step.priority === 'critical')
    const aged = eligible.filter((step) => step.priority === 'normal' && now - step.enqueuedAt >= NORMAL_AGING_MS)
    const lane = critical.length > 0 ? critical : [...eligible.filter((s) => s.priority === 'normal'), ...aged]
    const pool = lane.length > 0 ? lane : eligible
    // Repository round-robin inside the lane: prefer the repo least recently
    // dispatched; ties break by FIFO (array order).
    let chosen = pool[0]
    for (const step of pool) {
      if ((lastDispatchPerRepo.get(step.repo) ?? 0) < (lastDispatchPerRepo.get(chosen.repo) ?? 0)) chosen = step
    }
    waiting.splice(waiting.indexOf(chosen), 1)
    return chosen
  }

  const dispatchLoop = async () => {
    for (;;) {
      const totalCap =
        budget === null
          ? Math.min(CREDENTIAL_TOTAL_CONCURRENCY, UNKNOWN_BUDGET_PROBE_CAP)
          : CREDENTIAL_TOTAL_CONCURRENCY
      if (running.size >= totalCap) return
      const candidate = takeCandidate()
      if (!candidate) {
        flushIdleWaiters()
        return
      }
      // A queued step whose deadline already passed fails closed as
      // interrupted — it must never spin or dispatch past its budget of time.
      if (Date.now() > candidate.deadlineAt) {
        const error = new Error('GitHub 上游步骤超时(排队超过 deadline)')
        owner.noteTerminal(candidate.requestId, 'interrupted', error)
        candidate.fail(error)
        continue
      }
      // Budget admission: a known-exhausted bucket keeps the step queued only
      // when reset lands before its deadline; otherwise it fails fast with a
      // retryAt (GithubRateLimitError.resetAt). Keeping it queued MUST return
      // — nothing in this loop can change the budget, and a `continue` here
      // would spin synchronously forever (the r2 hang).
      if (budget !== null && budget.remaining <= 0 && budget.reset !== null) {
        const resetAt = budget.reset * 1000
        if (resetAt > Date.now()) {
          if (resetAt > candidate.deadlineAt) {
            const error = new GithubRateLimitError(resetAt, 'primary')
            owner.noteTerminal(candidate.requestId, 'rate-limited', error)
            candidate.fail(error)
            continue
          }
          waiting.unshift(candidate)
          const wake = setTimeout(() => scheduleDispatch(), Math.max(resetAt - Date.now(), 1))
          wake.unref?.()
          return
        }
      }
      // Pacing between dispatch STARTS — monotonic re-check, no mutex held
      // across the network (the r2 failure mode of the old lane).
      while (Date.now() < nextStartAt) {
        await new Promise((resolve) => setTimeout(resolve, nextStartAt - Date.now()))
      }
      if (closed || recorder.sealed) {
        const error = new Error('Gateway 已关闭,排队步骤被中断')
        owner.noteTerminal(candidate.requestId, 'interrupted', error)
        candidate.fail(error)
        return
      }
      nextStartAt = Date.now() + candidate.pacingMs
      lastDispatchPerRepo.set(candidate.repo, Date.now())
      recorder.emit({
        kind: 'dispatched',
        requestId: candidate.requestId,
        step: (stepCounts.get(candidate.requestId) ?? 0) + 1,
        waitedMs: Date.now() - candidate.enqueuedAt,
        at: Date.now(),
      })
      stepCounts.set(candidate.requestId, (stepCounts.get(candidate.requestId) ?? 0) + 1)
      const ticket = Date.now() + Math.random()
      const runner = Promise.resolve()
        .then(() => candidate.run())
        .then(
          (value) => {
            running.delete(ticket)
            candidate.settle(value)
            scheduleDispatch()
          },
          (error) => {
            running.delete(ticket)
            candidate.fail(error)
            scheduleDispatch()
          },
        )
      running.set(ticket, { ...candidate, runner })
    }
  }

  const owner: GithubGatewayOwner = {
    credentialScopeId: CONSERVATIVE_CREDENTIAL_SCOPE,
    submitStep<T>(repo: string, timeoutMs: number, pacingMs: number, run: () => Promise<T>): Promise<T> {
      const requestId = owner.ambientRequestId()
      const priority = requestId ? (requestPriorities.get(requestId) ?? 'normal') : 'normal'
      return new Promise<T>((resolve, reject) => {
        if (closed || recorder.sealed) {
          reject(new Error('Gateway 已关闭,拒绝新的上游步骤'))
          return
        }
        const step: PendingStep = {
          requestId: requestId ?? 'gh-ambient',
          repo,
          priority,
          deadlineAt: Date.now() + Math.max(timeoutMs, 1),
          enqueuedAt: Date.now(),
          pacingMs,
          run: run as () => Promise<unknown>,
          settle: (value) => resolve(value as T),
          fail: reject,
        }
        waiting.push(step)
        recorder.emit({ kind: 'queued', requestId: step.requestId, at: Date.now() })
        scheduleDispatch()
      })
    },
    withPriority<T>(priority: 'critical' | 'normal', fn: () => Promise<T>): Promise<T> {
      return priorityAls.run(priority, fn)
    },
    idle(): Promise<void> {
      if (waiting.length === 0 && running.size === 0) return Promise.resolve()
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve)
      })
    },
    async close(options: { drainMs?: number } = {}): Promise<void> {
      closed = true
      const drainMs = options.drainMs ?? 5_000
      // Queued steps are interrupted immediately; running steps get the drain
      // window, and anything still unsettled at the deadline is terminal
      // interrupted before the recorder seals (ADR-0010 §10 close ordering).
      for (const step of waiting.splice(0)) {
        owner.noteTerminal(step.requestId, 'interrupted', 'Gateway 关闭:排队步骤被中断')
        step.fail(new Error('Gateway 已关闭,排队步骤被中断'))
      }
      if (running.size > 0) {
        await Promise.race([owner.idle(), new Promise((resolve) => setTimeout(resolve, drainMs))])
      }
      for (const step of running.values()) {
        owner.noteTerminal(step.requestId, 'interrupted', 'Gateway 关闭:运行步骤未在窗口内结算')
      }
      recorder.seal()
      flushIdleWaiters()
    },
    declareLogicalRequest(scope: 'resource' | 'aggregate' | 'direct', key: string): string {
      if (recorder.sealed) throw new Error('Gateway 已关闭,拒绝新的 GitHub 访问申请')
      nextRequestId += 1
      const requestId = `gh-${nextRequestId}`
      const priority = priorityAls.getStore() ?? 'normal'
      requestPriorities.set(requestId, priority)
      recorder.emit({ kind: 'declared', requestId, scope, key, priority, at: Date.now() })
      return requestId
    },
    runWithRequest<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
      return requestAls.run(requestId, fn)
    },
    ambientRequestId(): string | null {
      return requestAls.getStore() ?? null
    },
    noteUpstreamSettled(requestId: string, ok: boolean, rate: GatewayRateObservation | null): void {
      const step = stepCounts.get(requestId) ?? 1
      recorder.emit({ kind: 'upstream-settled', requestId, step, ok, rate, at: Date.now() })
      // The admission budget derives from the same evidence stream — a response
      // with real rate fields updates the known bucket; observations without
      // them never fabricate one (ADR-0010 §8).
      if (rate && rate.remaining !== null) {
        budget = { remaining: rate.remaining, reset: rate.reset }
      }
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
        if (key === prefix || key.startsWith(`${prefix}/`)) {
          aggregates.delete(key)
          aggregateGenerations.set(key, (aggregateGenerations.get(key) ?? 0) + 1)
        }
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
      // Lazy thunk: the loader must only start for the LEADER, after the
      // in-flight registration check — a follower that invokes its loader would
      // dispatch a second upstream request behind the leader (review r1).
      const startLoad = () =>
        owner.runWithRequest(requestId, async () => {
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
      if (!options.force) return deduplicate(`resource:ordinary:${key}`, startLoad, requestId)

      // `force` means fresh from this invocation point. It must not coalesce
      // with an earlier force call whose GitHub fact may already be obsolete.
      const forced = startLoad()
      settleTerminalOn(forced, requestId)
      forcedResources.set(key, { promise: forced, requestId })
      const clear = () => {
        if (forcedResources.get(key)?.promise === forced) forcedResources.delete(key)
      }
      void forced.then(clear, clear)
      return forced
    },
    async cachedAggregate<T>(
      key: string,
      ttlMs: number,
      force: boolean,
      loader: () => Promise<T>,
      options: CachedAggregateOptions<T> = {},
    ): Promise<T> {
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
      // Generation fencing + lazy leader, mirroring the resource path: a loader
      // that started before an invalidate() must never republish the stale
      // aggregate (review r3).
      const generation = (aggregateGenerations.get(key) ?? 0) + 1
      const startLoad = () =>
        owner.runWithRequest(requestId, async () => {
          const value = await loader()
          if ((aggregateGenerations.get(key) ?? 0) === generation - 1) {
            aggregates.set(key, { value, version: null, expiresAt: Date.now() + ttlMs })
            aggregateGenerations.set(key, generation)
            for (const [childKey, childVersion] of options?.derivedVersions?.(value) ?? []) {
              owner.rememberVersion(childKey, childVersion)
            }
          }
          return value
        })
      return deduplicate(`aggregate:${key}`, startLoad, requestId)
    },
  }

  function deduplicate<T>(key: string, start: () => Promise<T>, leaderRequestId: string): Promise<T> {
    const entry = inFlight.get(key) as { promise: Promise<T>; requestId: string } | undefined
    if (entry) {
      // Follower: zero loader invocation, zero dispatch — join the leader only.
      recorder.emit({ kind: 'joined', requestId: leaderRequestId, leaderId: entry.requestId, at: Date.now() })
      settleTerminalOn(entry.promise, leaderRequestId)
      return entry.promise
    }
    // Leader: register BEFORE starting, so a concurrent caller can only join.
    const created = start()
    settleTerminalOn(created, leaderRequestId)
    const tracked = created.finally(() => inFlight.delete(key))
    inFlight.set(key, { promise: tracked, requestId: leaderRequestId })
    return tracked
  }

  return owner
}

let processOwner: GithubGatewayOwner | null = null

/** The process-level owner for the conservative v0.2 credential scope. */
export function githubGatewayOwner(): GithubGatewayOwner {
  if (processOwner) return processOwner
  processOwner = createGithubGatewayOwner()
  return processOwner
}

/** Test isolation: drop the process owner so the next caller gets a fresh one. */
export function resetGithubGatewayOwnerForTests(): void {
  processOwner = null
}
