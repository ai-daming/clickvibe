/**
 * Gateway owner (issue #131 slice A; ADR-0010 §1/§3-§6/§10).
 *
 * One credential scope owns one Gateway runtime: the request lanes, the
 * observation caches with their generations, in-flight singleflight, forced
 * reads, resource versions, the per-bucket rate budget and the lifecycle
 * evidence writer. v0.2 is deliberately conservative about scope identity —
 * the `gh` CLI host auth cannot be safely split into distinct credentials, so
 * every owner declares the same single scope (under-sharing reuse is
 * acceptable, splitting one budget never is).
 *
 * Readers bind to an owner and keep only shell I/O and response parsing:
 * two readers on one owner share observations, singleflight and the circuit
 * (worktrees attribute calls, they never own Gateway state).
 *
 * Admission is driven by the typed operation policy (operations.ts): the
 * priority lane, ONE absolute logical deadline shared by every step of a
 * request (pagination continuations never mint a fresh window) and a
 * per-request dispatch (cost) bound all arrive through the admission context
 * the policy wraps around its executor.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { logTaskDiagnostic } from '../infra/task-diagnostics.ts'
import { GithubRateLimitError, type GithubRateLimitKind } from './rest.ts'
import { createDiagnosticEvidenceSink } from './gateway-evidence.ts'
import {
  GatewayLifecycleRecorder,
  type GatewayEvidenceSink,
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

/** Attributes the operation policy declares; the owner composes them into the
 *  ambient admission context (priority lanes, absolute deadline, cost bound). */
export interface GatewayAdmissionAttributes {
  priority: 'critical' | 'normal'
  deadlineMs: number
  maxPages: number
}

interface GatewayAdmission {
  priority: 'critical' | 'normal'
  deadlineAt: number
  maxPages: number
}

/** One real resource bucket's last published snapshot (design §8). */
interface BucketLedger {
  limit: number | null
  remaining: number | null
  used: number | null
  reset: number | null
  observedAt: number
  /** Monotonic republish counter — tells a step whether fresh evidence
   *  superseded its dispatch (vs. a silently consumed unit). */
  evidenceSeq: number
}

interface PendingStep {
  requestId: string
  repo: string
  bucket: string
  priority: 'critical' | 'normal'
  deadlineAt: number
  enqueuedAt: number
  /** Evidence sequence at dispatch — see settleReservation. */
  evidenceSeq: number
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

export interface SubmitStepOptions {
  /** Resource bucket the step draws from (`search` endpoints vs `core`). */
  bucket?: string
}

export interface GithubGatewayOwner {
  /** Opaque identity; never contains token material. */
  readonly credentialScopeId: string
  /** Declare one logical request; throws once the owner is closed. */
  declareLogicalRequest(scope: 'resource' | 'aggregate' | 'direct', key: string): string
  /** Ambient logical-request attribution for loader-internal upstream steps. */
  runWithRequest<T>(requestId: string, fn: () => Promise<T>): Promise<T>
  ambientRequestId(): string | null
  /**
   * Stamp the policy's admission attributes (priority lane, absolute logical
   * deadline, per-request dispatch bound) around a composition. Nested calls
   * compose: critical propagates inward, deadlines only tighten, and the
   * innermost bound governs pagination.
   */
  runWithAdmission<T>(attributes: GatewayAdmissionAttributes, fn: () => Promise<T>): Promise<T>
  /** Cost-bound admission before dispatching the next pagination page. */
  admitNextPage(): void
  /** Settle one HTTP step with the response's real rate fields (null when absent). */
  noteUpstreamSettled(requestId: string, ok: boolean, rate: GatewayRateObservation | null): void
  /** Terminal for a logical request; exactly one per request — a second
   *  outcome is recorded as a late diagnostic and never rewrites the first. */
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
   * pass per-bucket budget admission (known remaining is atomically reserved
   * at dispatch and released at settlement; unknown buckets probe
   * conservatively) and start no sooner than the pacing interval. A slow step
   * occupies only its own execution slot — no scheduler mutex is held while
   * awaiting the network.
   */
  submitStep<T>(
    repo: string,
    timeoutMs: number,
    pacingMs: number,
    run: () => Promise<T>,
    options?: SubmitStepOptions,
  ): Promise<T>

  rateLimitError(now?: number): GithubRateLimitError | null
  /** Record a rate-limit trip observed on a response (kind from the response shape). */
  /**
   * Primary exhaustion pauses ONLY the hit resource bucket (ADR-0010 §3);
   * secondary/Retry-After pauses the whole credential (review r6/F7).
   */
  noteRateLimitTrip(until: number, kind: GithubRateLimitKind, bucket?: string): void
  assertCircuitOpen(bucket?: string): void
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
  /** Stop admission, interrupt queued steps, drain running to a deadline, fence
   *  late settlements behind a new owner generation, seal and flush evidence. */
  close(options?: { drainMs?: number }): Promise<void>
}

/** Conservative v0.2 scope: the host's gh auth is one credential. */
const CONSERVATIVE_CREDENTIAL_SCOPE = 'host-gh-auth:v1'

export function createGithubGatewayOwner(
  options: { sink?: GatewayEvidenceSink; agingMs?: number } = {},
): GithubGatewayOwner {
  const evidenceSink = options.sink
  const agingMs = options.agingMs ?? NORMAL_AGING_MS
  const waiting: PendingStep[] = []
  const running = new Map<number, PendingStep & { runner: Promise<unknown> }>()
  const lastDispatchPerRepo = new Map<string, number>()
  let nextStartAt = 0
  let dispatchScheduled = false
  const buckets = new Map<string, BucketLedger>()
  const reservedByBucket = new Map<string, number>()
  let ownerGeneration = 0
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
  const recorder = new GatewayLifecycleRecorder(options.sink)
  const requestAls = new AsyncLocalStorage<string>()
  const admissionAls = new AsyncLocalStorage<GatewayAdmission>()
  const stepCounts = new Map<string, number>()
  const requestPriorities = new Map<string, 'critical' | 'normal'>()
  const terminaledRequests = new Set<string>()
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
    const aged = eligible.filter((step) => step.priority === 'normal' && now - step.enqueuedAt >= agingMs)
    // ADR-0010: normal aging is a scheduling dimension, not a tie-breaker —
    // a request that already waited past the aging threshold gets its
    // execution turn before NEW critical arrivals (review r6/F2: without
    // this, a steady critical stream starves panel refreshes forever).
    const lane =
      aged.length > 0 ? aged : critical.length > 0 ? critical : eligible.filter((s) => s.priority === 'normal')
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

  /** Put a step back at the head of its lane order and stop this loop pass —
   *  the deciding fact (a settlement or a timer) re-schedules dispatch. */
  const requeueFront = (step: PendingStep) => {
    waiting.unshift(step)
  }

  const releaseReservation = (bucket: string) => {
    const outstanding = (reservedByBucket.get(bucket) ?? 1) - 1
    if (outstanding > 0) reservedByBucket.set(bucket, outstanding)
    else reservedByBucket.delete(bucket)
  }

  /** Settle the reservation on one step's completion. A bucket whose evidence
   *  sequence moved past this dispatch was republished by a real response —
   *  the published remaining already carries the truth; a step that settled
   *  WITHOUT rate fields really consumed a unit, so the published remaining
   *  drops by one — sequential headerless requests must not re-spend the
   *  same unit forever (review r5/F7). */
  const settleReservation = (step: PendingStep) => {
    const ledger = buckets.get(step.bucket)
    if (ledger && ledger.evidenceSeq === step.evidenceSeq && ledger.remaining !== null && ledger.remaining > 0) {
      ledger.remaining -= 1
    }
    releaseReservation(step.bucket)
  }

  const noteLateResponse = (step: PendingStep, phase: 'settled' | 'rejected') => {
    logTaskDiagnostic('github-gateway-late-response', {
      requestId: step.requestId,
      repo: step.repo,
      bucket: step.bucket,
      phase,
      note: '迟到响应被 owner generation 隔离:调用方保留 interrupted terminal,缓存不回填',
    })
  }

  const dispatchLoop = async () => {
    for (;;) {
      if (running.size >= CREDENTIAL_TOTAL_CONCURRENCY) return
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
      // Per-bucket budget admission (design §8). A published ledger whose
      // reset already elapsed is stale — drop it and probe like unknown.
      let ledger = buckets.get(candidate.bucket)
      if (ledger && ledger.reset !== null && ledger.reset * 1000 <= Date.now()) {
        buckets.delete(candidate.bucket)
        ledger = undefined
      }
      if (ledger && ledger.remaining !== null) {
        const outstanding = reservedByBucket.get(candidate.bucket) ?? 0
        if (ledger.remaining - outstanding <= 0) {
          if (outstanding > 0) {
            // The in-flight reservation owns the truth; wait for its
            // settlement instead of failing on a possibly-stale number.
            requeueFront(candidate)
            return
          }
          const resetAt = ledger.reset !== null ? ledger.reset * 1000 : null
          if (resetAt !== null && resetAt > Date.now()) {
            if (resetAt > candidate.deadlineAt) {
              const error = new GithubRateLimitError(resetAt, 'primary')
              owner.noteTerminal(candidate.requestId, 'rate-limited', error)
              candidate.fail(error)
              continue
            }
            requeueFront(candidate)
            const wake = setTimeout(() => scheduleDispatch(), Math.max(resetAt - Date.now(), 1))
            wake.unref?.()
            return
          }
          // Exhausted with no usable reset: forget the guess, probe on.
          buckets.delete(candidate.bucket)
        }
      } else if (!ledger) {
        // Unknown budget: at most a conservative number of probe steps runs
        // concurrently; a settlement publishes the bucket and unlocks the lane.
        const unknownRunning = [...running.values()].filter((entry) => !buckets.has(entry.bucket)).length
        if (unknownRunning >= UNKNOWN_BUDGET_PROBE_CAP) {
          requeueFront(candidate)
          return
        }
      }
      // Pacing between dispatch STARTS — monotonic re-check, no mutex held
      // across the network (the r2 failure mode of the old lane).
      while (Date.now() < nextStartAt) {
        await new Promise((resolve) => setTimeout(resolve, nextStartAt - Date.now()))
      }
      // The deadline is absolute for the whole logical request: pacing may
      // have crossed it while this step waited its turn — an expired request
      // must fail, never spend a GitHub call (review r6/F2).
      if (Date.now() > candidate.deadlineAt) {
        const error = new Error('GitHub 上游步骤超时(等待 pacing 超过 deadline)')
        owner.noteTerminal(candidate.requestId, 'interrupted', error)
        candidate.fail(error)
        continue
      }
      if (closed || recorder.sealed) {
        const error = new Error('Gateway 已关闭,排队步骤被中断')
        owner.noteTerminal(candidate.requestId, 'interrupted', error)
        candidate.fail(error)
        return
      }
      const dispatchGeneration = ownerGeneration
      reservedByBucket.set(candidate.bucket, (reservedByBucket.get(candidate.bucket) ?? 0) + 1)
      candidate.evidenceSeq = buckets.get(candidate.bucket)?.evidenceSeq ?? 0
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
            settleReservation(candidate)
            // Generation fence: a settlement that lands after the close
            // deadline must not resolve its caller or publish anything — the
            // caller already owns its interrupted terminal.
            if (ownerGeneration !== dispatchGeneration) {
              noteLateResponse(candidate, 'settled')
              candidate.fail(new Error('GitHub 网关已关闭:迟到响应被丢弃'))
            } else {
              candidate.settle(value)
            }
            scheduleDispatch()
          },
          (error) => {
            running.delete(ticket)
            settleReservation(candidate)
            if (ownerGeneration !== dispatchGeneration) {
              noteLateResponse(candidate, 'rejected')
              candidate.fail(new Error('GitHub 网关已关闭:迟到响应被丢弃'))
            } else {
              candidate.fail(error)
            }
            scheduleDispatch()
          },
        )
      running.set(ticket, { ...candidate, runner })
    }
  }

  const owner: GithubGatewayOwner = {
    credentialScopeId: CONSERVATIVE_CREDENTIAL_SCOPE,
    submitStep<T>(
      repo: string,
      timeoutMs: number,
      pacingMs: number,
      run: () => Promise<T>,
      options: SubmitStepOptions = {},
    ): Promise<T> {
      const requestId = owner.ambientRequestId()
      const ambient = admissionAls.getStore()
      const priority = ambient?.priority ?? (requestId ? (requestPriorities.get(requestId) ?? 'normal') : 'normal')
      return new Promise<T>((resolve, reject) => {
        if (closed || recorder.sealed) {
          reject(new Error('Gateway 已关闭,拒绝新的上游步骤'))
          return
        }
        const step: PendingStep = {
          requestId: requestId ?? 'gh-ambient',
          repo,
          bucket: options.bucket ?? 'core',
          priority,
          // One absolute logical deadline per request — a continuation page
          // may only tighten the window, never mint a fresh one.
          deadlineAt: Math.min(Date.now() + Math.max(timeoutMs, 1), ambient?.deadlineAt ?? Number.POSITIVE_INFINITY),
          enqueuedAt: Date.now(),
          evidenceSeq: 0,
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
    runWithAdmission<T>(attributes: GatewayAdmissionAttributes, fn: () => Promise<T>): Promise<T> {
      const ambient = admissionAls.getStore()
      const admission: GatewayAdmission = {
        priority: attributes.priority === 'critical' || ambient?.priority === 'critical' ? 'critical' : 'normal',
        deadlineAt: Math.min(
          ambient?.deadlineAt ?? Number.POSITIVE_INFINITY,
          Date.now() + Math.max(attributes.deadlineMs, 1),
        ),
        maxPages: attributes.maxPages,
      }
      return admissionAls.run(admission, fn)
    },
    admitNextPage(): void {
      const admission = admissionAls.getStore()
      if (!admission) return
      const requestId = requestAls.getStore()
      if (!requestId) return
      const dispatched = stepCounts.get(requestId) ?? 0
      if (dispatched + 1 > admission.maxPages) {
        throw new Error(
          `GitHub 读取超出声明的成本上界:请求 ${requestId} 已派发 ${dispatched} 次,声明上界 ${admission.maxPages} 次`,
        )
      }
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
        const error = new Error('Gateway 已关闭,运行步骤未在窗口内结算')
        owner.noteTerminal(step.requestId, 'interrupted', error)
        // The caller's promise must end — a terminal event alone leaves the
        // panel spinner hanging forever (review r6/F3). First-terminal-wins
        // already fences any late settlement.
        step.fail(error)
      }
      // Fence every still-in-flight settlement: from here on a late response
      // is diagnostic-only — no caller resolution, no cache publish, no
      // second terminal.
      ownerGeneration += 1
      recorder.seal()
      await evidenceSink?.flush()
      flushIdleWaiters()
    },
    declareLogicalRequest(scope: 'resource' | 'aggregate' | 'direct', key: string): string {
      if (closed || recorder.sealed) throw new Error('Gateway 已关闭,拒绝新的 GitHub 访问申请')
      nextRequestId += 1
      const requestId = `gh-${nextRequestId}`
      const priority = admissionAls.getStore()?.priority ?? 'normal'
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
      // The per-bucket budget derives from the same evidence stream — a
      // response with real rate fields republishes its bucket; observations
      // without them never fabricate one (ADR-0010 §8).
      if (rate && rate.remaining !== null) {
        const previous = buckets.get(rate.resource ?? 'core')
        buckets.set(rate.resource ?? 'core', {
          limit: rate.limit,
          remaining: rate.remaining,
          used: rate.used,
          reset: rate.reset,
          observedAt: rate.observedAt,
          evidenceSeq: (previous?.evidenceSeq ?? 0) + 1,
        })
      }
    },
    noteTerminal(
      requestId: string,
      outcome: 'succeeded' | 'failed' | 'rate-limited' | 'interrupted',
      error?: unknown,
    ): void {
      if (terminaledRequests.has(requestId)) {
        // Exactly one terminal per logical request: a late second outcome
        // (typically the fenced rejection after close) stays diagnostic.
        logTaskDiagnostic('github-gateway-late-terminal', {
          requestId,
          lateOutcome: outcome,
          error: errorText(error),
          note: '首个 terminal 保留;迟到结果仅作诊断,不改写业务结局',
        })
        return
      }
      terminaledRequests.add(requestId)
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
    noteRateLimitTrip(until: number, kind: GithubRateLimitKind, bucket?: string): void {
      if (kind === 'primary' && bucket) {
        // Publish the paused bucket through the same ledger the admission
        // path already consumes: remaining 0 + reset re-uses the existing
        // wait-or-fail semantics instead of a second circuit mechanism.
        const previous = buckets.get(bucket)
        buckets.set(bucket, {
          limit: previous?.limit ?? null,
          remaining: 0,
          used: previous?.used ?? null,
          reset: Math.floor(until / 1000),
          observedAt: Date.now(),
          evidenceSeq: (previous?.evidenceSeq ?? 0) + 1,
        })
        return
      }
      circuitUntil = until
      circuitKind = kind
    },
    assertCircuitOpen(bucket?: string): void {
      const global = owner.rateLimitError()
      if (global) throw global
      if (bucket) {
        const ledger = buckets.get(bucket)
        if (ledger && ledger.remaining === 0 && ledger.reset !== null && ledger.reset * 1000 > Date.now()) {
          throw new GithubRateLimitError(ledger.reset * 1000, 'primary')
        }
      }
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
  processOwner = createGithubGatewayOwner({ sink: createDiagnosticEvidenceSink() })
  return processOwner
}

/** Stop the process owner (plugin dispose): admission closes, queued steps
 *  interrupt, running steps drain, evidence flushes. The next caller gets a
 *  fresh owner — nothing crosses the credential generation. */
export async function closeGithubGateway(options: { drainMs?: number } = {}): Promise<void> {
  const owner = processOwner
  processOwner = null
  await owner?.close(options)
}

/** Test isolation: drop the process owner so the next caller gets a fresh one. */
export function resetGithubGatewayOwnerForTests(): void {
  processOwner = null
}
