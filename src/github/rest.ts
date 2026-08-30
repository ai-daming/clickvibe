import { readFile } from 'node:fs/promises'
import { AsyncLocalStorage } from 'node:async_hooks'
import { logTaskDiagnostic } from '../infra/task-diagnostics.ts'

interface ShellContext {
  shell: {
    resolve(spec: { command: string; timeoutMs?: number; stdin?: string }): unknown
    run(spec: unknown): Promise<{
      exitCode: number | null
      stdout: { text: string; truncated?: boolean; spillPath?: string }
      stderr?: { text?: string }
    }>
  }
}

interface CachedValue<T> {
  value: T
  version: string | null
  expiresAt: number
}

/**
 * Gateway evidence in the frozen #133 units (issue #131 slice A). Numeric
 * access counters (logical/hit/join/execution/wait) are deferred to the
 * slice that consumes them — the threshold assertions and scheduling of the
 * Gateway mechanism — per the concept-budget discipline; what ships here is
 * the evidence that already has production consumers: failures and
 * invalidations land in the persisted diagnostics channel, the per-response
 * rate-limit series feeds the circuit-trip diagnostic.
 */

/** One observed rate-limit sample from a single response (#133: every response records the bucket). */
export interface RateLimitSample {
  /** null when the response carried no rate headers at all. */
  resource: string | null
  limit: number | null
  remaining: number | null
  /** limit − remaining when both are known. */
  used: number | null
  reset: number | null
  observedAt: number
}

/** One failure evidence row: the raw upstream operation and/or the access scope it failed. */
export interface AccessFailureRecord {
  level: 'upstream' | 'access'
  operation: string
  message: string
  scope: string | null
}

/** One invalidation evidence row (#133 unit: object, reason, triggering action, generation, subsequent observation). */
export interface InvalidationRecord {
  seq: number
  /** Per-prefix invalidation generation; distinguishes repeat invalidations of the same scope. */
  generation: number
  prefix: string
  reason: string
  trigger: string
  /** observed once a subsequent cached load repopulated a matching key; pending = unknown. */
  status: 'pending' | 'observed'
  observedAt: number | null
  observedKey: string | null
}

export interface GithubAccessEvidence {
  /** Append-only per-response series (capped); same-bucket responses never overwrite each other. */
  rateLimitSamples: RateLimitSample[]
  /** Latest snapshot per resource bucket; consumed by the circuit-trip diagnostic. */
  rateLimitBuckets: Record<string, RateLimitSample>
  failureRecords: AccessFailureRecord[]
  invalidationRecords: InvalidationRecord[]
}

const MAX_GATEWAY_EVIDENCE_RECORDS = 200

function emptyEvidence(): GithubAccessEvidence {
  return {
    rateLimitSamples: [],
    rateLimitBuckets: {},
    failureRecords: [],
    invalidationRecords: [],
  }
}

interface GithubReviewRest {
  id?: number
  user?: { login?: string } | null
  state?: string
  submitted_at?: string | null
}

interface IncludedResponse {
  status: number
  headers: Map<string, string>
  body: string
}

interface HostGithubRequestLane {
  tail: Promise<void>
  nextStartAt: number
}

/**
 * Composition scope: upstream calls a cached loader composes for one access
 * intent. Evidence routing uses it — a composed failure records its access
 * level at the wrapper (which knows the true scope), while direct calls
 * record their own access level.
 */
const accessCompositionScope = new AsyncLocalStorage<{ composed: boolean }>()

const HOST_GITHUB_MINIMUM_INTERVAL_MS = 250
const hostGithubLaneSymbol = Symbol.for('clickvibe.github-request-lane')

function hostGithubLane(): HostGithubRequestLane {
  const root = globalThis as unknown as Record<PropertyKey, unknown>
  const existing = root[hostGithubLaneSymbol] as HostGithubRequestLane | undefined
  if (existing) return existing
  const created = { tail: Promise.resolve(), nextStartAt: 0 }
  root[hostGithubLaneSymbol] = created
  return created
}

async function serializeGithubRequest<T>(minimumIntervalMs: number, request: () => Promise<T>): Promise<T> {
  const lane = hostGithubLane()
  const previous = lane.tail
  let release = () => {}
  lane.tail = new Promise<void>((resolve) => {
    release = resolve
  })
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
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function parseIncludedResponse(output: string): IncludedResponse {
  const normalized = output.replace(/\r\n/g, '\n')
  const separator = normalized.indexOf('\n\n')
  const headerText = separator >= 0 ? normalized.slice(0, separator) : normalized
  const body = separator >= 0 ? normalized.slice(separator + 2) : ''
  const lines = headerText.split('\n')
  const statusMatch = lines.shift()?.match(/^HTTP\/\S+\s+(\d{3})/i)
  if (!statusMatch) throw new Error('GitHub REST 响应缺少 HTTP 状态行')
  const headers = new Map<string, string>()
  for (const line of lines) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim())
  }
  return { status: Number(statusMatch[1]), headers, body }
}

function resetFrom(headers: Map<string, string>, now: number): number {
  const retryAfter = Number(headers.get('retry-after'))
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return now + retryAfter * 1000
  const resetSeconds = Number(headers.get('x-ratelimit-reset'))
  if (Number.isFinite(resetSeconds) && resetSeconds > 0) return resetSeconds * 1000
  return now + 60 * 60_000
}

function isRateLimited(response: IncludedResponse, detail: string): boolean {
  if (response.status === 429) return true
  if (response.headers.get('x-ratelimit-remaining') === '0') return true
  return response.status === 403 && /(?:rate limit|secondary rate)/i.test(detail)
}

export function recoveryLabel(resetAt: number): string {
  return new Date(resetAt).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

export type GithubRateLimitKind = 'primary' | 'secondary' | 'unknown'

export class GithubRateLimitError extends Error {
  readonly resetAt: number
  readonly kind: GithubRateLimitKind

  constructor(resetAt: number, kind: GithubRateLimitKind = 'primary') {
    const label = recoveryLabel(resetAt)
    super(
      kind === 'secondary'
        ? `GitHub 二级限流(突发检测),约 ${label} 恢复`
        : kind === 'unknown'
          ? `GitHub 限流(类型未知),约 ${label} 恢复`
          : `GitHub 额度已用完,约 ${label} 恢复`,
    )
    this.name = 'GithubRateLimitError'
    this.resetAt = resetAt
    this.kind = kind
  }
}

/**
 * Derive GraphQL's coarse reviewDecision from REST reviews. Only each actor's
 * latest decisive review counts; later approval clears that actor's old change
 * request, while comments do not replace a decisive review.
 */
export function deriveReviewDecision(reviews: GithubReviewRest[]): 'APPROVED' | 'CHANGES_REQUESTED' | null {
  const latest = new Map<string, GithubReviewRest>()
  const sorted = [...reviews].sort((left, right) => {
    const time = String(left.submitted_at ?? '').localeCompare(String(right.submitted_at ?? ''))
    return time || Number(left.id ?? 0) - Number(right.id ?? 0)
  })
  for (const review of sorted) {
    const login = String(review.user?.login ?? '')
    const state = String(review.state ?? '').toUpperCase()
    if (!login || !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(state)) continue
    if (state === 'DISMISSED') latest.delete(login)
    else latest.set(login, review)
  }
  if ([...latest.values()].some((review) => String(review.state).toUpperCase() === 'CHANGES_REQUESTED')) {
    return 'CHANGES_REQUESTED'
  }
  return [...latest.values()].some((review) => String(review.state).toUpperCase() === 'APPROVED') ? 'APPROVED' : null
}

/** One ctx-scoped REST reader: rate-limit circuit, request parsing and read caches. */
export class GithubRestReader {
  private readonly ctx: ShellContext
  private readonly minimumIntervalMs: number
  private readonly now: () => number
  readonly evidence: GithubAccessEvidence = emptyEvidence()
  private invalidationSeq = 0
  private readonly prefixGenerations = new Map<string, number>()
  private readonly resources = new Map<string, CachedValue<unknown>>()
  private readonly aggregates = new Map<string, CachedValue<unknown>>()
  private readonly inFlight = new Map<string, Promise<unknown>>()
  private readonly forcedResources = new Map<string, Promise<unknown>>()
  private readonly versions = new Map<string, string>()
  private readonly resourceLoadSequence = new Map<string, number>()
  private circuitUntil = 0
  private circuitKind: GithubRateLimitKind = 'unknown'

  constructor(ctx: ShellContext, options: { minimumIntervalMs?: number; now?: () => number } = {}) {
    this.ctx = ctx
    this.minimumIntervalMs = Math.max(0, options.minimumIntervalMs ?? HOST_GITHUB_MINIMUM_INTERVAL_MS)
    this.now = options.now ?? Date.now
  }

  private recordFailure(operation: string, error: unknown, scope: string | null = null): void {
    this.pushFailureRecord({
      level: 'access',
      operation,
      scope,
      message: error instanceof Error ? error.message : String(error),
    })
  }

  /** Raw upstream evidence: retained even when the access layer already recorded the failure. */
  private recordUpstreamFailure(operation: string, error: unknown): void {
    this.pushFailureRecord({
      level: 'upstream',
      operation,
      scope: null,
      message: error instanceof Error ? error.message : String(error),
    })
  }

  private pushFailureRecord(record: AccessFailureRecord): void {
    this.evidence.failureRecords.push(record)
    if (this.evidence.failureRecords.length > MAX_GATEWAY_EVIDENCE_RECORDS) {
      this.evidence.failureRecords.splice(0, this.evidence.failureRecords.length - MAX_GATEWAY_EVIDENCE_RECORDS)
    }
    // Production consumer + 错误不埋葬: failures land in the persisted
    // diagnostics channel the panel can query.
    logTaskDiagnostic('github-access-failure', {
      level: record.level,
      operation: record.operation,
      scope: record.scope,
      message: record.message,
    })
  }

  rateLimitError(now = Date.now()): GithubRateLimitError | null {
    return this.circuitUntil > now ? new GithubRateLimitError(this.circuitUntil, this.circuitKind) : null
  }

  rememberVersion(key: string, version: string | null | undefined): void {
    if (version) this.versions.set(key, version)
  }

  resourceVersion(key: string): string | null {
    return this.versions.get(key) ?? null
  }

  invalidate(prefix: string, reason: string, trigger: string): void {
    this.invalidationSeq++
    const generation = (this.prefixGenerations.get(prefix) ?? 0) + 1
    this.prefixGenerations.set(prefix, generation)
    const record: InvalidationRecord = {
      seq: this.invalidationSeq,
      generation,
      prefix,
      reason,
      trigger,
      status: 'pending',
      observedAt: null,
      observedKey: null,
    }
    this.evidence.invalidationRecords.push(record)
    if (this.evidence.invalidationRecords.length > MAX_GATEWAY_EVIDENCE_RECORDS) {
      this.evidence.invalidationRecords.splice(
        0,
        this.evidence.invalidationRecords.length - MAX_GATEWAY_EVIDENCE_RECORDS,
      )
    }
    logTaskDiagnostic('github-rest-invalidation', { ...record })
    for (const key of this.resources.keys()) {
      if (key === prefix || key.startsWith(`${prefix}/`)) this.resources.delete(key)
    }
    for (const key of this.aggregates.keys()) {
      if (key === prefix || key.startsWith(`${prefix}/`)) this.aggregates.delete(key)
    }
    this.versions.delete(prefix)
    for (const key of this.forcedResources.keys()) {
      if (key === prefix || key.startsWith(`${prefix}/`)) this.forcedResources.delete(key)
    }
    for (const key of this.resourceLoadSequence.keys()) {
      if (key === prefix || key.startsWith(`${prefix}/`)) {
        this.resourceLoadSequence.set(key, (this.resourceLoadSequence.get(key) ?? 0) + 1)
      }
    }
  }

  private assertCircuitOpen(): void {
    const error = this.rateLimitError()
    if (error) throw error
  }

  private async output(result: Awaited<ReturnType<ShellContext['shell']['run']>>): Promise<string> {
    const stdout = result.stdout
    if (stdout.truncated) {
      if (!stdout.spillPath) throw new Error('GitHub REST 输出超过上限且无 spill 文件')
      return readFile(stdout.spillPath, 'utf8')
    }
    return stdout.text
  }

  /** A subsequent cached load completes every pending invalidation whose prefix covers the key (#133: invalidation without re-observation stays unknown). */
  private observeInvalidationsFor(key: string): void {
    const now = this.now()
    for (const record of this.evidence.invalidationRecords) {
      if (record.status !== 'pending') continue
      if (key !== record.prefix && !key.startsWith(`${record.prefix}/`)) continue
      record.status = 'observed'
      record.observedAt = now
      record.observedKey = key
      // The completion is a durable fact (#133: invalidation without a
      // recorded re-observation stays unknown), persisted readback-able.
      logTaskDiagnostic('github-rest-invalidation-observed', {
        seq: record.seq,
        generation: record.generation,
        prefix: record.prefix,
        reason: record.reason,
        trigger: record.trigger,
        observedKey: record.observedKey,
        observedAt: record.observedAt,
      })
    }
  }

  /**
   * Every response leaves an observation (review round 4): present fields
   * survive, missing ones are explicit null (unknown) — a partial-header or
   * bare response is distinguishable from "no response happened" and never
   * drops an already-seen bucket/limit/reset.
   */
  private recordBudgetSnapshot(headers: Map<string, string>): RateLimitSample {
    // A missing resource header stays unknown (review round 5): no `core`
    // fabrication, no named-bucket update from an unattributed response.
    const resource = headers.get('x-ratelimit-resource') ?? null
    const limitRaw = Number(headers.get('x-ratelimit-limit'))
    const remainingRaw = Number(headers.get('x-ratelimit-remaining'))
    const resetSeconds = Number(headers.get('x-ratelimit-reset'))
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : null
    const remaining = Number.isFinite(remainingRaw) ? Number(remainingRaw) : null
    const sample: RateLimitSample = {
      resource,
      limit,
      remaining,
      used: limit !== null && remaining !== null ? limit - remaining : null,
      reset: Number.isFinite(resetSeconds) && resetSeconds > 0 ? resetSeconds * 1000 : null,
      observedAt: this.now(),
    }
    this.evidence.rateLimitSamples.push(sample)
    if (this.evidence.rateLimitSamples.length > MAX_GATEWAY_EVIDENCE_RECORDS) {
      this.evidence.rateLimitSamples.splice(0, this.evidence.rateLimitSamples.length - MAX_GATEWAY_EVIDENCE_RECORDS)
    }
    if (resource !== null) this.evidence.rateLimitBuckets[resource] = sample
    return sample
  }

  private async request(
    path: string,
    accept?: string,
    timeoutMs = 30_000,
    mutation?: { method: 'POST' | 'PATCH'; body: unknown },
  ): Promise<IncludedResponse> {
    return serializeGithubRequest(this.minimumIntervalMs, async () => {
      // A request queued before another resource trips the circuit must not hit GitHub afterwards.
      this.assertCircuitOpen()
      const command = [
        'gh api --include',
        shellQuote(path),
        mutation ? `--method ${mutation.method} --input -` : '',
        accept ? `-H ${shellQuote(`Accept: ${accept}`)}` : '',
      ]
        .filter(Boolean)
        .join(' ')
      const spec = this.ctx.shell.resolve({
        command,
        timeoutMs,
        ...(mutation ? { stdin: JSON.stringify(mutation.body) } : {}),
      })
      const requestOperation = `${mutation?.method ?? 'GET'} ${path}`
      let result: Awaited<ReturnType<ShellContext['shell']['run']>>
      let stdout: string
      try {
        result = await this.ctx.shell.run(spec)
        stdout = await this.output(result)
      } catch (transportError) {
        // The child was dispatched and the transport failed (shell reject,
        // spill read): upstream-level evidence must survive (review round 2).
        this.recordUpstreamFailure(requestOperation, transportError)
        throw transportError
      }
      let response: IncludedResponse
      try {
        response = parseIncludedResponse(stdout)
      } catch (parseError) {
        const detail = [result.stderr?.text, stdout].filter(Boolean).join('\n').trim()
        if (result.exitCode !== 0 && /(?:rate limit|secondary rate)/i.test(detail)) {
          this.recordUpstreamFailure(requestOperation, new GithubRateLimitError(Date.now() + 60 * 60_000, 'unknown'))
          this.circuitUntil = Date.now() + 60 * 60_000
          this.circuitKind = 'unknown'
          logTaskDiagnostic('github-rate-circuit-trip', {
            kind: 'unknown' as const,
            path,
            until: this.circuitUntil,
            note: 'gh CLI 失败且无响应头,按 60 分钟保守熔断',
          })
          throw new GithubRateLimitError(this.circuitUntil, 'unknown')
        }
        if (result.exitCode !== 0) {
          const cliFailure = new Error(detail || `gh api 执行失败(exit ${result.exitCode})`)
          this.recordUpstreamFailure(requestOperation, cliFailure)
          throw cliFailure
        }
        this.recordUpstreamFailure(requestOperation, parseError)
        throw parseError
      }
      const currentSample = this.recordBudgetSnapshot(response.headers)
      const detail = [result.stderr?.text, response.body].filter(Boolean).join('\n')
      if (isRateLimited(response, detail)) {
        const kind: GithubRateLimitKind =
          response.headers.get('x-ratelimit-remaining') === '0' ? 'primary' : 'secondary'
        this.recordUpstreamFailure(
          requestOperation,
          new GithubRateLimitError(resetFrom(response.headers, Date.now()), kind),
        )
        this.circuitUntil = resetFrom(response.headers, Date.now())
        this.circuitKind = kind
        logTaskDiagnostic('github-rate-circuit-trip', {
          kind,
          path,
          // Bound to THIS response's observation (review round 5/6): the
          // resource stays unknown when the header is missing, a prior
          // response's bucket never leaks — but the numeric budget fields
          // this response DID carry are always persisted (review round 6:
          // dropping the whole sample because one field is unknown erases
          // known evidence).
          resource: currentSample.resource,
          bucket: currentSample,
          retryAfter: response.headers.get('retry-after'),
          until: this.circuitUntil,
        })
        throw new GithubRateLimitError(this.circuitUntil, kind)
      }
      if (result.exitCode !== 0 || response.status < 200 || response.status >= 300) {
        this.recordUpstreamFailure(
          requestOperation,
          new Error(`GitHub REST ${response.status}: ${response.body.trim() || result.stderr?.text || '请求失败'}`),
        )
        let message = response.body.trim()
        try {
          const parsed = JSON.parse(response.body) as { message?: unknown }
          message = String(parsed.message ?? message)
        } catch {
          /* retain raw response body */
        }
        throw new Error(`GitHub REST ${response.status}: ${message || result.stderr?.text || '请求失败'}`)
      }
      return response
    })
  }

  async json<T = unknown>(path: string, accept?: string, timeoutMs?: number): Promise<T> {
    try {
      const response = await this.request(path, accept, timeoutMs)
      try {
        return JSON.parse(response.body || 'null') as T
      } catch (parseError) {
        // The upstream child returned an unparseable body: it is upstream
        // evidence even though the child itself exited zero (review round 3).
        this.recordUpstreamFailure(`GET ${path}`, parseError)
        throw new Error(`GitHub REST 返回了无效 JSON: ${path}`)
      }
    } catch (error) {
      if (!this.isComposed()) this.recordFailure(`GET ${path}`, error, null)
      throw error
    }
  }

  async mutate<T = unknown>(path: string, method: 'POST' | 'PATCH', body: unknown, timeoutMs?: number): Promise<T> {
    try {
      const response = await this.request(path, undefined, timeoutMs, { method, body })
      try {
        return JSON.parse(response.body || 'null') as T
      } catch (parseError) {
        this.recordUpstreamFailure(`${method} ${path}`, parseError)
        throw new Error(`GitHub REST 返回了无效 JSON: ${path}`)
      }
    } catch (error) {
      if (!this.isComposed()) this.recordFailure(`${method} ${path}`, error, null)
      throw error
    }
  }

  async paginate<T>(path: string, accept?: string, timeoutMs?: number): Promise<T[]> {
    const values: T[] = []
    for (let page = 1; ; page++) {
      const separator = path.includes('?') ? '&' : '?'
      const pagePath = `${path}${separator}per_page=100&page=${page}`
      const batch = await this.json<T[]>(pagePath, accept, timeoutMs)
      if (!Array.isArray(batch)) {
        // The upstream child answered 2xx with the wrong shape: the raw page
        // operation is the evidence (review round 4), at both levels — this
        // access (or the composed wrapper's scope) plus the upstream GET.
        const shapeFailure = new Error(`GitHub REST 分页返回格式无效: ${JSON.stringify(batch).slice(0, 120)}`)
        this.recordUpstreamFailure(`GET ${pagePath}`, shapeFailure)
        if (!this.isComposed()) this.recordFailure(`GET ${path} (paginate)`, shapeFailure, null)
        throw shapeFailure
      }
      values.push(...batch)
      if (batch.length < 100) return values
    }
  }

  async cachedResource<T>(
    key: string,
    version: string | null | undefined,
    loader: () => Promise<T>,
    options: { ttlMs?: number; force?: boolean; versionOf?: (value: T) => string | null | undefined } = {},
  ): Promise<T> {
    try {
      this.assertCircuitOpen()
    } catch (error) {
      this.recordFailure(`access ${key}`, error, key)
      throw error
    }
    const forcedPending = this.forcedResources.get(key) as Promise<T> | undefined
    if (!options.force && forcedPending) {
      return forcedPending
    }
    const knownVersion = version || null
    const cached = this.resources.get(key) as CachedValue<T> | undefined
    const now = Date.now()
    if (
      !options.force &&
      cached &&
      cached.expiresAt > now &&
      (knownVersion === null || cached.version === knownVersion)
    ) {
      return cached.value
    }
    const load = this.withLoaderDepth(async () => {
      const sequence = (this.resourceLoadSequence.get(key) ?? 0) + 1
      this.resourceLoadSequence.set(key, sequence)
      const value = await loader()
      const loadedVersion = options.versionOf?.(value) || knownVersion
      // A later-started force read is authoritative. An older ordinary request
      // may still resolve for its caller, but must never overwrite that result.
      if (this.resourceLoadSequence.get(key) === sequence) {
        this.resources.set(key, {
          value,
          version: loadedVersion,
          expiresAt: Date.now() + (options.ttlMs ?? 30_000),
        })
        if (loadedVersion) this.versions.set(key, loadedVersion)
        this.observeInvalidationsFor(key)
      }
      return value
    })
    if (!options.force) return this.deduplicate(`resource:ordinary:${key}`, load)

    // `force` means fresh from this invocation point. It must not coalesce
    // with an earlier force call whose GitHub fact may already be obsolete.
    const forced = this.withOutcome(key, load())
    this.forcedResources.set(key, forced)
    const clear = () => {
      if (this.forcedResources.get(key) === forced) this.forcedResources.delete(key)
    }
    void forced.then(clear, clear)
    return forced
  }

  async cachedAggregate<T>(key: string, ttlMs: number, force: boolean, loader: () => Promise<T>): Promise<T> {
    try {
      this.assertCircuitOpen()
    } catch (error) {
      this.recordFailure(`access ${key}`, error, key)
      throw error
    }
    const cached = this.aggregates.get(key) as CachedValue<T> | undefined
    if (!force && cached && cached.expiresAt > Date.now()) {
      return cached.value
    }
    return this.deduplicate(`aggregate:${key}`, async () => {
      const value = await this.withLoaderDepth(loader)()
      this.aggregates.set(key, { value, version: null, expiresAt: Date.now() + ttlMs })
      this.observeInvalidationsFor(key)
      return value
    })
  }

  private async deduplicate<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const pending = this.inFlight.get(key) as Promise<T> | undefined
    if (pending) {
      return pending
    }
    // `key` is an internal dedup handle (`resource:ordinary:…`); the scope
    // carried in evidence is the access key without the handle prefix.
    const scope = key.replace(/^(?:resource:ordinary:|aggregate:)/, '')
    const created = this.withOutcome(scope, loader()).finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, created)
    return created
  }

  private isComposed(): boolean {
    return accessCompositionScope.getStore()?.composed === true
  }

  private withLoaderDepth<T>(loader: () => Promise<T>): () => Promise<T> {
    return () => accessCompositionScope.run({ composed: true }, loader)
  }

  /** The access scope a leader failure surfaced through; evidence only (counters land with their consumers in slice B). */
  private async withOutcome<T>(scope: string, promise: Promise<T>): Promise<T> {
    try {
      return await promise
    } catch (error) {
      this.recordFailure(`access ${scope}`, error, scope)
      throw error
    }
  }
}

const readers = new WeakMap<object, GithubRestReader>()

export function githubRest(ctx: ShellContext): GithubRestReader {
  const key = ctx as object
  const existing = readers.get(key)
  if (existing) return existing
  const created = new GithubRestReader(ctx)
  readers.set(key, created)
  return created
}

export function githubErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isGithubRateLimitError(error: unknown): error is GithubRateLimitError {
  return error instanceof GithubRateLimitError
}
