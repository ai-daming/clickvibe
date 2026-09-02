/** The Gateway owner public contract (issue #131, ADR-0010). Types-only
 *  module: the implementation lives in gateway-owner.ts; this header is the
 *  surface the REST adapter and consumers code against (review r9 size split).
 *  GatewayClosedError is the one runtime value: every rejection path that
 *  provably never dispatched throws it (review CF1).
 */
import type { GatewayLifecycleEvent, GatewayMetrics, GatewayRateObservation } from './gateway-lifecycle.ts'
import type { GithubRateLimitError, GithubRateLimitKind } from './rest.ts'

/** Rejection raised on paths that provably never dispatched: submissions
 *  after close, queue/pacing interrupts, and interrupted lease waits. A write
 *  transaction seeing this knows zero upstream execution happened. The
 *  drain-timeout of an already-RUNNING step deliberately stays a plain Error
 *  — the step may have reached GitHub. */
export class GatewayClosedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GatewayClosedError'
  }
}

export interface GatewayAdmissionAttributes {
  priority: 'critical' | 'normal'
  deadlineMs: number
  maxPages: number
}
export interface SubmitStepOptions {
  /** Resource bucket the step draws from (`search` endpoints vs `core`). */
  bucket?: string
}

export interface CachedResourceOptions<T> {
  ttlMs?: number
  force?: boolean
  versionOf?: (value: T) => string | null | undefined
}
export interface CachedAggregateOptions<T> {
  /** Child resource cache.versions observed by this aggregate settlement — the owner
   *  records them so callers never write reader cache state (design §11). */
  derivedVersions?: (value: T) => Array<[key: string, version: string | null | undefined]>
}

export interface GithubGatewayOwner {
  /** Opaque identity; never contains token material. */
  readonly credentialScopeId: string
  /** Declare one logical request; throws once the owner is closed. */
  declareLogicalRequest(scope: 'resource' | 'aggregate' | 'direct' | 'write', key: string): string
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
  noteUpstreamSettled(requestId: string, ok: boolean, rate: GatewayRateObservation | null, path?: string): void
  /** Resolve the resource identity for a path (learned ?? URL classification). */
  resolveResourceIdentity(path: string, fallback: string): string
  /** Terminal for a logical request; exactly one per request — a second
   *  outcome is recorded as a late diagnostic and never rewrites the first. */
  noteTerminal(
    requestId: string,
    outcome: 'succeeded' | 'failed' | 'rate-limited' | 'interrupted' | 'unknown',
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
  /**
   * Acquire the exclusive write lease for a sorted key set ATOMICALLY
   * (ADR-0010 §9): leases are granted as a whole from a FIFO queue, so two
   * overlapping write transactions can never deadlock or interleave.
   * Returns the release function; the transaction's invalidation and
   * readback both happen while held. The caller passes the ALREADY declared
   * logical request id: the request must be visible to the lifecycle stream
   * before it blocks on the queue, and close() settles a queued acquisition
   * with exactly one interrupted terminal.
   */
  acquireWriteLeases(keys: string[], requestId: string): Promise<() => void>
  /** Wait until no held write lease covers this read key (child paths included). */
  waitReadableResource(key: string): Promise<void>
  /** Run a composition exempt from read-side lease waiting (the write
   *  transaction's own authoritative readback — it must not queue behind
   *  itself). */
  runWithLeaseExemption<T>(fn: () => Promise<T>): Promise<T>
  /** Record the write-side invalidation in the lifecycle stream. */
  noteWriteInvalidated(requestId: string, keys: string[]): void
  /** Record the authoritative post-write readback settlement. */
  noteReadbackSettled(requestId: string, confirmed: boolean): void
  /**
   * Track one whole logical write transaction for close() (review CF1): the
   * owner waits within its drain window for the transaction to settle its own
   * single terminal. Not a second state machine — a join on the existing
   * transaction promise.
   */
  runLogicalWrite<T>(requestId: string, run: () => Promise<T>): Promise<T>
  /**
   * Mark that this write's dispatch has been attempted. A transaction still
   * unsettled at the close deadline MAY have executed upstream once this is
   * set — its sweep terminal is unknown, never interrupted.
   */
  noteWriteDispatchAttempted(requestId: string): void
  /** Resolve when no step is waiting or running (test/evidence quiescence). */
  idle(): Promise<void>
  /** Stop admission, interrupt queued steps, drain running to a deadline, fence
   *  late settlements behind a new owner generation, seal and flush evidence. */
  close(options?: { drainMs?: number }): Promise<void>
}
