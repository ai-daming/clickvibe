/**
 * Gateway owner (issue #131 slice A; ADR-0010 §1/§3-§6/§10).
 *
 * One credential scope owns one Gateway runtime: the request lanes, the
 * observation caches with their generations, in-flight singleflight, forced
 * reads, resource cache.versions, the per-bucket rate budget and the lifecycle
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
import { createWriteLeaseRegistry } from './gateway-write-leases.ts'
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

interface GatewayAdmission {
  priority: 'critical' | 'normal'
  deadlineAt: number
  maxPages: number
}

/** Conservative v0.2 scope: the host's gh auth is one credential. */
import {
  admitCandidate as admitCandidatePure,
  type BucketLedger,
  selectCandidate,
  type PendingStep,
} from './gateway-scheduling.ts'
import { GatewayCache, type CachedValue } from './gateway-cache.ts'
import type {
  CachedAggregateOptions,
  CachedResourceOptions,
  GatewayAdmissionAttributes,
  GithubGatewayOwner,
  SubmitStepOptions,
} from './gateway-contracts.ts'

const CONSERVATIVE_CREDENTIAL_SCOPE = 'host-gh-auth:v1'

export function createGithubGatewayOwner(
  options: { sink?: GatewayEvidenceSink; agingMs?: number } = {},
): GithubGatewayOwner {
  const evidenceSink = options.sink
  const agingMs = options.agingMs ?? NORMAL_AGING_MS
  const waiting: PendingStep[] = []
  const running = new Map<number, PendingStep & { runner: Promise<unknown> }>()
  const observedResourceByTicket = new Map<number, string | null>()
  const lastDispatchPerRepo = new Map<string, number>()
  let nextStartAt = 0
  let dispatchScheduled = false
  const buckets = new Map<string, BucketLedger>()
  // Path-template → real resource identity learned from responses (review
  // r9/F7): admission must check the bucket GitHub actually charges for this
  // path, not a URL guess. No new layer — one map beside the ledgers it feeds.
  const resourceIdentityByPath = new Map<string, string>()
  const reservedByBucket = new Map<string, number>()
  let ownerGeneration = 0
  let closed = false
  let idleWaiters: Array<() => void> = []
  const cache = new GatewayCache()
  let circuitUntil = 0
  let circuitKind: GithubRateLimitKind = 'unknown'
  const recorder = new GatewayLifecycleRecorder(options.sink)
  // Write leases (ADR-0010 §9) live in their own module (pure move): held as
  // a set, granted whole from a FIFO queue; reads of covered keys wait for
  // release; the transaction's own readback runs exempt. Queued entries carry
  // their logical request id so close() settles them with one terminal.
  const writeLeases = createWriteLeaseRegistry({
    noteInterruptedTerminal: (requestId, error) => owner.noteTerminal(requestId, 'interrupted', error),
  })
  const requestAls = new AsyncLocalStorage<string>()
  const admissionAls = new AsyncLocalStorage<GatewayAdmission>()
  const stepCounts = new Map<string, number>()
  // Continuation-page counter per logical request: maxPages bounds PAGES
  // (admitNextPage), not every step — a write transaction's POST/PATCH steps
  // must not silently consume the readback's page budget (review F1).
  const pageCounts = new Map<string, number>()
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
    // Quiescence = nothing waiting, nothing pacing, nothing running (review
    // r9: waiting+running-only resolved idle() while a step still paced) —
    // and no write-lease waiter: a queued write or a lease-blocked read is
    // live work the owner still owes a settlement to (review F2).
    if (waiting.length === 0 && running.size === 0 && pacing.size === 0 && writeLeases.pendingWaiters() === 0) {
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
    const runningRepos = new Map<string, number>()
    for (const step of running.values()) runningRepos.set(step.repo, (runningRepos.get(step.repo) ?? 0) + 1)
    const chosen = selectCandidate({
      waiting,
      runningRepos,
      lastDispatchPerRepo,
      repositoryConcurrency: REPOSITORY_CONCURRENCY,
      agingMs,
      now: Date.now(),
    })
    if (!chosen) return null
    waiting.splice(waiting.indexOf(chosen), 1)
    return chosen
  }

  /** Put a step back at the head of its lane order and stop this loop pass —
   *  the deciding fact (a settlement or a timer) re-schedules dispatch. */
  // A dequeued candidate paces before it runs: during that window it is in
  // NEITHER waiting NOR running — close()/idle() must still see it (review
  // r7/F3: an invisible mid-pacing request survived close with no terminal).
  const pacing = new Map<string, PendingStep>()

  const requeueFront = (step: PendingStep) => {
    pacing.delete(step.requestId)
    waiting.unshift(step)
  }

  const resourceKeyFor = (path: string): string => path.replace(/\d+/g, 'n')

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
  const settleReservation = (step: PendingStep, observedResource: string | null = null) => {
    // The reservation was taken under the resolved identity (learned or
    // guessed); the ledger charge applies ONLY when the response did not
    // publish a different real resource — a real response's headers are the
    // authority and charging the guessed ledger would pollute it (review
    // r9/F7: core deducted for a code_scanning_upload call).
    if (observedResource === null || observedResource === step.bucket) {
      const ledger = buckets.get(step.bucket)
      if (ledger && ledger.evidenceSeq === step.evidenceSeq && ledger.remaining !== null && ledger.remaining > 0) {
        ledger.remaining -= 1
      }
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

  const admitCandidate = (candidate: PendingStep): 'dispatch' | 'requeue' | 'rejected' =>
    admitCandidatePure(candidate, {
      running,
      buckets,
      reservedByBucket,
      credentialConcurrency: CREDENTIAL_TOTAL_CONCURRENCY,
      repositoryConcurrency: REPOSITORY_CONCURRENCY,
      unknownBudgetProbeCap: UNKNOWN_BUDGET_PROBE_CAP,
      noteTerminal: owner.noteTerminal,
      scheduleDispatch,
    })

  const dispatchLoop = async () => {
    for (;;) {
      if (running.size >= CREDENTIAL_TOTAL_CONCURRENCY) return
      const candidate = takeCandidate()
      if (!candidate) {
        if (pacing.size === 0) flushIdleWaiters()
        return
      }
      pacing.set(candidate.requestId, candidate)
      // A queued step whose deadline already passed fails closed as
      // interrupted — it must never spin or dispatch past its budget of time.
      if (Date.now() > candidate.deadlineAt) {
        pacing.delete(candidate.requestId)
        const error = new Error('GitHub 上游步骤超时(排队超过 deadline)')
        owner.noteTerminal(candidate.requestId, 'interrupted', error)
        candidate.fail(error)
        flushIdleWaiters()
        continue
      }
      const earlyAdmission = admitCandidate(candidate)
      if (earlyAdmission === 'requeue') {
        requeueFront(candidate)
        return
      }
      if (earlyAdmission === 'rejected') {
        pacing.delete(candidate.requestId)
        flushIdleWaiters()
        continue
      }
      // Pacing between dispatch STARTS — monotonic re-check, no mutex held
      // across the network (the r2 failure mode of the old lane).
      while (Date.now() < nextStartAt) {
        await new Promise((resolve) => setTimeout(resolve, nextStartAt - Date.now()))
      }
      // The deadline is absolute for the whole logical request: pacing may
      // have crossed it while this step waited its turn — an expired request
      // must fail, never spend a GitHub call (review r6/F2).
      pacing.delete(candidate.requestId)
      if (Date.now() > candidate.deadlineAt) {
        const error = new Error('GitHub 上游步骤超时(等待 pacing 超过 deadline)')
        owner.noteTerminal(candidate.requestId, 'interrupted', error)
        candidate.fail(error)
        flushIdleWaiters()
        continue
      }
      pacing.delete(candidate.requestId)
      if (closed || recorder.sealed) {
        const error = new Error('Gateway 已关闭,排队步骤被中断')
        owner.noteTerminal(candidate.requestId, 'interrupted', error)
        candidate.fail(error)
        return
      }
      pacing.delete(candidate.requestId)
      // The sleep admitted races: concurrency and budget may have moved while
      // this step paced — the gate re-runs as the final indivisible decision
      // before run() (review r8/F2). A requeue reschedules via a running
      // settlement (something holds the slot this candidate needs) or the
      // budget wake timer.
      const late = admitCandidate(candidate)
      if (late === 'requeue') {
        requeueFront(candidate)
        return
      }
      if (late === 'rejected') {
        flushIdleWaiters()
        continue
      }
      // One authoritative decision timestamp for the pacing interval AND the
      // dispatched event — two Date.now() calls made the recorded interval
      // shorter than the enforced one (CI attempt-1 flake, review r9).
      const decisionAt = Date.now()
      const dispatchGeneration = ownerGeneration
      reservedByBucket.set(candidate.bucket, (reservedByBucket.get(candidate.bucket) ?? 0) + 1)
      candidate.evidenceSeq = buckets.get(candidate.bucket)?.evidenceSeq ?? 0
      nextStartAt = decisionAt + candidate.pacingMs
      lastDispatchPerRepo.set(candidate.repo, decisionAt)
      recorder.emit({
        kind: 'dispatched',
        requestId: candidate.requestId,
        step: (stepCounts.get(candidate.requestId) ?? 0) + 1,
        waitedMs: decisionAt - candidate.enqueuedAt,
        at: decisionAt,
      })
      stepCounts.set(candidate.requestId, (stepCounts.get(candidate.requestId) ?? 0) + 1)
      const ticket = Date.now() + Math.random()
      const runner = Promise.resolve()
        .then(() => candidate.run())
        .then(
          (value) => {
            running.delete(ticket)
            settleReservation(candidate, observedResourceByTicket.get(ticket) ?? null)
            observedResourceByTicket.delete(ticket)
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
            settleReservation(candidate, observedResourceByTicket.get(ticket) ?? null)
            observedResourceByTicket.delete(ticket)
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
      const pages = pageCounts.get(requestId) ?? 0
      if (pages + 1 > admission.maxPages) {
        throw new Error(
          `GitHub 读取超出声明的成本上界:请求 ${requestId} 已派发 ${pages} 页,声明上界 ${admission.maxPages} 页`,
        )
      }
      pageCounts.set(requestId, pages + 1)
    },
    idle(): Promise<void> {
      if (waiting.length === 0 && running.size === 0 && pacing.size === 0) return Promise.resolve()
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve)
      })
    },
    async close(options: { drainMs?: number } = {}): Promise<void> {
      closed = true
      const drainMs = options.drainMs ?? 5_000
      // Queued write-lease acquisitions and reads waiting behind a lease are
      // part of the write machinery close() must settle (review F2): a waiter
      // that survives the seal would either hang forever or wake up inside a
      // closed Gateway. The registry emits one interrupted terminal per
      // queued write; a waiting read has not declared yet and simply fails.
      writeLeases.interruptAll()
      // Queued steps are interrupted immediately; running steps get the drain
      // window, and anything still unsettled at the deadline is terminal
      // interrupted before the recorder seals (ADR-0010 §10 close ordering).
      for (const step of waiting.splice(0)) {
        owner.noteTerminal(step.requestId, 'interrupted', 'Gateway 关闭:排队步骤被中断')
        step.fail(new Error('Gateway 已关闭,排队步骤被中断'))
      }
      for (const step of pacing.values()) {
        pacing.delete(step.requestId)
        const error = new Error('Gateway 已关闭:节流等待中的步骤被中断')
        owner.noteTerminal(step.requestId, 'interrupted', error)
        step.fail(error)
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
      // Sweep first: every DECLARED request leaves exactly one terminal —
      // a write whose readback would only settle after the seal (or an
      // in-flight singleflight leader) is closed out here as interrupted
      // (review F2: 已登记请求必须有 terminal).
      for (const requestId of requestPriorities.keys()) {
        if (!terminaledRequests.has(requestId)) {
          owner.noteTerminal(requestId, 'interrupted', 'Gateway 关闭:未决请求被中断')
        }
      }
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
    /** Resolve the resource identity for a path: learned from real responses,
     *  falling back to the URL classification (review r9/F7). */
    resolveResourceIdentity(path: string, fallback: string): string {
      return resourceIdentityByPath.get(resourceKeyFor(path)) ?? fallback
    },
    ambientRequestId(): string | null {
      return requestAls.getStore() ?? null
    },
    noteUpstreamSettled(requestId: string, ok: boolean, rate: GatewayRateObservation | null, path?: string): void {
      const step = stepCounts.get(requestId) ?? 1
      recorder.emit({ kind: 'upstream-settled', requestId, step, ok, rate, at: Date.now() })
      if (rate && rate.resource) {
        if (path) resourceIdentityByPath.set(resourceKeyFor(path), rate.resource)
        for (const [ticket, entry] of running) {
          if (entry.requestId === requestId) observedResourceByTicket.set(ticket, rate.resource)
        }
      }
      // The per-bucket budget derives from the same evidence stream — a
      // response with real rate fields republishes its bucket; observations
      // without them never fabricate one (ADR-0010 §8).
      // An unknown resource (null) never creates or updates a NAMED bucket
      // — unknown is missing evidence, not a fabricated bucket name
      // (review r8/F7).
      if (rate && rate.remaining !== null && rate.resource !== null) {
        const previous = buckets.get(rate.resource)
        buckets.set(rate.resource, {
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
      outcome: 'succeeded' | 'failed' | 'rate-limited' | 'interrupted' | 'unknown',
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
    acquireWriteLeases(keys: string[], requestId: string): Promise<() => void> {
      return writeLeases.acquire(keys, requestId).then((release) => () => {
        release()
        // Lease transitions are quiescence-relevant: a released write may
        // have been the last live work (review F2).
        flushIdleWaiters()
      })
    },
    waitReadableResource: (key: string) => writeLeases.waitReadable(key),
    runWithLeaseExemption<T>(fn: () => Promise<T>): Promise<T> {
      return writeLeases.runExempt(fn)
    },
    noteWriteInvalidated(requestId: string, keys: string[]): void {
      recorder.emit({ kind: 'write-invalidated', requestId, keys, at: Date.now() })
    },
    noteReadbackSettled(requestId: string, confirmed: boolean): void {
      recorder.emit({ kind: 'readback-settled', requestId, confirmed, at: Date.now() })
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
      if (version) cache.versions.set(key, version)
    },
    resourceVersion(key: string): string | null {
      return cache.versions.get(key) ?? null
    },
    invalidate(prefix: string): void {
      for (const key of cache.resources.keys()) {
        if (key === prefix || key.startsWith(`${prefix}/`)) cache.resources.delete(key)
      }
      for (const key of cache.aggregates.keys()) {
        if (key === prefix || key.startsWith(`${prefix}/`)) {
          cache.aggregates.delete(key)
          cache.aggregateGenerations.set(key, (cache.aggregateGenerations.get(key) ?? 0) + 1)
        }
      }
      cache.versions.delete(prefix)
      for (const key of cache.forcedResources.keys()) {
        if (key === prefix || key.startsWith(`${prefix}/`)) cache.forcedResources.delete(key)
      }
      for (const key of cache.resourceLoadSequence.keys()) {
        if (key === prefix || key.startsWith(`${prefix}/`)) {
          cache.resourceLoadSequence.set(key, (cache.resourceLoadSequence.get(key) ?? 0) + 1)
        }
      }
    },
    async cachedResource<T>(
      key: string,
      version: string | null | undefined,
      loader: () => Promise<T>,
      options: CachedResourceOptions<T> = {},
    ): Promise<T> {
      // Reads of a lease-held resource queue behind the write transaction
      // (ADR-0010 §9) — including cache hits, which may predate the write.
      await writeLeases.waitReadable(key)
      const requestId = owner.declareLogicalRequest('resource', key)
      try {
        owner.assertCircuitOpen()
      } catch (error) {
        owner.noteTerminal(requestId, 'rate-limited', error)
        return Promise.reject(error)
      }
      const forcedPending = cache.forcedResources.get(key) as { promise: Promise<T>; requestId: string } | undefined
      if (!options.force && forcedPending) {
        recorder.emit({ kind: 'joined', requestId, leaderId: forcedPending.requestId, at: Date.now() })
        settleTerminalOn(forcedPending.promise, requestId)
        return forcedPending.promise
      }
      const knownVersion = version || null
      const cached = cache.resources.get(key) as CachedValue<T> | undefined
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
          const sequence = (cache.resourceLoadSequence.get(key) ?? 0) + 1
          cache.resourceLoadSequence.set(key, sequence)
          const value = await loader()
          const loadedVersion = options.versionOf?.(value) || knownVersion
          // A later-started force read is authoritative. An older ordinary request
          // may still resolve for its caller, but must never overwrite that result.
          if (cache.resourceLoadSequence.get(key) === sequence) {
            cache.resources.set(key, {
              value,
              version: loadedVersion,
              expiresAt: Date.now() + (options.ttlMs ?? 30_000),
            })
            if (loadedVersion) cache.versions.set(key, loadedVersion)
          }
          return value
        })
      if (!options.force) return deduplicate(`resource:ordinary:${key}`, startLoad, requestId)

      // `force` means fresh from this invocation point. It must not coalesce
      // with an earlier force call whose GitHub fact may already be obsolete.
      const forced = startLoad()
      settleTerminalOn(forced, requestId)
      cache.forcedResources.set(key, { promise: forced, requestId })
      const clear = () => {
        if (cache.forcedResources.get(key)?.promise === forced) cache.forcedResources.delete(key)
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
      await writeLeases.waitReadable(key)
      const requestId = owner.declareLogicalRequest('aggregate', key)
      try {
        owner.assertCircuitOpen()
      } catch (error) {
        owner.noteTerminal(requestId, 'rate-limited', error)
        return Promise.reject(error)
      }
      const cached = cache.aggregates.get(key) as CachedValue<T> | undefined
      if (!force && cached && cached.expiresAt > Date.now()) {
        recorder.emit({ kind: 'cache-hit', requestId, at: Date.now() })
        owner.noteTerminal(requestId, 'succeeded')
        return Promise.resolve(cached.value)
      }
      // Generation fencing + lazy leader, mirroring the resource path: a loader
      // that started before an invalidate() must never republish the stale
      // aggregate (review r3).
      const generation = (cache.aggregateGenerations.get(key) ?? 0) + 1
      const startLoad = () =>
        owner.runWithRequest(requestId, async () => {
          const value = await loader()
          if ((cache.aggregateGenerations.get(key) ?? 0) === generation - 1) {
            cache.aggregates.set(key, { value, version: null, expiresAt: Date.now() + ttlMs })
            cache.aggregateGenerations.set(key, generation)
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
    const entry = cache.inFlight.get(key) as { promise: Promise<T>; requestId: string } | undefined
    if (entry) {
      // Follower: zero loader invocation, zero dispatch — join the leader only.
      recorder.emit({ kind: 'joined', requestId: leaderRequestId, leaderId: entry.requestId, at: Date.now() })
      settleTerminalOn(entry.promise, leaderRequestId)
      return entry.promise
    }
    // Leader: register BEFORE starting, so a concurrent caller can only join.
    const created = start()
    settleTerminalOn(created, leaderRequestId)
    const tracked = created.finally(() => cache.inFlight.delete(key))
    cache.inFlight.set(key, { promise: tracked, requestId: leaderRequestId })
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

export type {
  CachedAggregateOptions,
  CachedResourceOptions,
  GatewayAdmissionAttributes,
  GithubGatewayOwner,
  SubmitStepOptions,
} from './gateway-contracts.ts'
