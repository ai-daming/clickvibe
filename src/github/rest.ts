import { readFile } from 'node:fs/promises'
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
 * Gateway access metrics in the frozen #133 units (issue #131 slice A):
 * every logical request lands in exactly one of hit / join / execution /
 * failure; upstream children, rate-limit budget snapshots, invalidations
 * and queue waits are recorded alongside as evidence.
 */
export interface GithubAccessCounters {
  logicalRequests: number
  cacheHits: number
  singleflightJoins: number
  executions: number
  failures: number
  upstreamRequests: number
  invalidations: number
  waitCount: number
  waitMsTotal: number
  /** Last observed account budget from response headers. */
  rateLimit: { resource: string; limit: number | null; remaining: number | null; reset: number | null } | null
  failureRecords: Array<{ operation: string; message: string }>
  invalidationRecords: string[]
}

const MAX_GATEWAY_EVIDENCE_RECORDS = 200

function emptyCounters(): GithubAccessCounters {
  return {
    logicalRequests: 0,
    cacheHits: 0,
    singleflightJoins: 0,
    executions: 0,
    failures: 0,
    upstreamRequests: 0,
    invalidations: 0,
    waitCount: 0,
    waitMsTotal: 0,
    rateLimit: null,
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
  readonly counters: GithubAccessCounters = emptyCounters()
  /** >0 while a cached loader composes upstream calls for one already-counted intent. */
  private loaderDepth = 0
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

  private recordFailure(operation: string, error: unknown): void {
    this.counters.failures++
    this.counters.failureRecords.push({
      operation,
      message: error instanceof Error ? error.message : String(error),
    })
    if (this.counters.failureRecords.length > MAX_GATEWAY_EVIDENCE_RECORDS) {
      this.counters.failureRecords.splice(0, this.counters.failureRecords.length - MAX_GATEWAY_EVIDENCE_RECORDS)
    }
  }

  private withLoaderDepth<T>(loader: () => Promise<T>): () => Promise<T> {
    return async () => {
      this.loaderDepth++
      try {
        return await loader()
      } finally {
        this.loaderDepth--
      }
    }
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

  invalidate(prefix: string): void {
    this.counters.invalidations++
    this.counters.invalidationRecords.push(prefix)
    if (this.counters.invalidationRecords.length > MAX_GATEWAY_EVIDENCE_RECORDS) {
      this.counters.invalidationRecords.splice(
        0,
        this.counters.invalidationRecords.length - MAX_GATEWAY_EVIDENCE_RECORDS,
      )
    }
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

  private recordBudgetSnapshot(headers: Map<string, string>): void {
    const remainingRaw = headers.get('x-ratelimit-remaining')
    if (remainingRaw === undefined) return
    const resetSeconds = Number(headers.get('x-ratelimit-reset'))
    const limitRaw = Number(headers.get('x-ratelimit-limit'))
    this.counters.rateLimit = {
      resource: headers.get('x-ratelimit-resource') ?? 'core',
      limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : null,
      remaining: Number.isFinite(Number(remainingRaw)) ? Number(remainingRaw) : null,
      reset: Number.isFinite(resetSeconds) && resetSeconds > 0 ? resetSeconds * 1000 : null,
    }
  }

  private async request(
    path: string,
    accept?: string,
    timeoutMs = 30_000,
    mutation?: { method: 'POST' | 'PATCH'; body: unknown },
  ): Promise<IncludedResponse> {
    const enteredAt = this.now()
    return serializeGithubRequest(this.minimumIntervalMs, async () => {
      // A request queued before another resource trips the circuit must not hit GitHub afterwards.
      this.assertCircuitOpen()
      // Queue wait (#133): access entry → physical dispatch. Service time
      // after dispatch is not queue wait and is not accumulated here.
      const waitMs = this.now() - enteredAt
      if (waitMs > 0) {
        this.counters.waitCount++
        this.counters.waitMsTotal += waitMs
      }
      this.counters.upstreamRequests++
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
      const result = await this.ctx.shell.run(spec)
      const stdout = await this.output(result)
      let response: IncludedResponse
      try {
        response = parseIncludedResponse(stdout)
      } catch (parseError) {
        const detail = [result.stderr?.text, stdout].filter(Boolean).join('\n').trim()
        if (result.exitCode !== 0 && /(?:rate limit|secondary rate)/i.test(detail)) {
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
        if (result.exitCode !== 0) throw new Error(detail || `gh api 执行失败(exit ${result.exitCode})`)
        throw parseError
      }
      this.recordBudgetSnapshot(response.headers)
      const detail = [result.stderr?.text, response.body].filter(Boolean).join('\n')
      if (isRateLimited(response, detail)) {
        this.circuitUntil = resetFrom(response.headers, Date.now())
        const kind: GithubRateLimitKind =
          response.headers.get('x-ratelimit-remaining') === '0' ? 'primary' : 'secondary'
        this.circuitKind = kind
        logTaskDiagnostic('github-rate-circuit-trip', {
          kind,
          path,
          remaining: response.headers.get('x-ratelimit-remaining'),
          reset: response.headers.get('x-ratelimit-reset'),
          retryAfter: response.headers.get('retry-after'),
          until: this.circuitUntil,
        })
        throw new GithubRateLimitError(this.circuitUntil, kind)
      }
      if (result.exitCode !== 0 || response.status < 200 || response.status >= 300) {
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
    const direct = this.loaderDepth === 0
    if (direct) this.counters.logicalRequests++
    try {
      const response = await this.request(path, accept, timeoutMs)
      try {
        const parsed = JSON.parse(response.body || 'null') as T
        if (direct) this.counters.executions++
        return parsed
      } catch {
        throw new Error(`GitHub REST 返回了无效 JSON: ${path}`)
      }
    } catch (error) {
      if (direct) this.recordFailure(`GET ${path}`, error)
      throw error
    }
  }

  async mutate<T = unknown>(path: string, method: 'POST' | 'PATCH', body: unknown, timeoutMs?: number): Promise<T> {
    const direct = this.loaderDepth === 0
    if (direct) this.counters.logicalRequests++
    try {
      const response = await this.request(path, undefined, timeoutMs, { method, body })
      try {
        const parsed = JSON.parse(response.body || 'null') as T
        if (direct) this.counters.executions++
        return parsed
      } catch {
        throw new Error(`GitHub REST 返回了无效 JSON: ${path}`)
      }
    } catch (error) {
      if (direct) this.recordFailure(`${method} ${path}`, error)
      throw error
    }
  }

  async paginate<T>(path: string, accept?: string, timeoutMs?: number): Promise<T[]> {
    const direct = this.loaderDepth === 0
    if (direct) this.counters.logicalRequests++
    this.loaderDepth++
    try {
      const values: T[] = []
      for (let page = 1; ; page++) {
        const separator = path.includes('?') ? '&' : '?'
        const batch = await this.json<T[]>(`${path}${separator}per_page=100&page=${page}`, accept, timeoutMs)
        if (!Array.isArray(batch)) throw new Error('GitHub REST 分页返回格式无效')
        values.push(...batch)
        if (batch.length < 100) {
          if (direct) this.counters.executions++
          return values
        }
      }
    } catch (error) {
      if (direct) this.recordFailure(`GET ${path} (paginate)`, error)
      throw error
    } finally {
      this.loaderDepth--
    }
  }

  async cachedResource<T>(
    key: string,
    version: string | null | undefined,
    loader: () => Promise<T>,
    options: { ttlMs?: number; force?: boolean; versionOf?: (value: T) => string | null | undefined } = {},
  ): Promise<T> {
    this.counters.logicalRequests++
    try {
      this.assertCircuitOpen()
    } catch (error) {
      this.recordFailure(`access ${key}`, error)
      throw error
    }
    const forcedPending = this.forcedResources.get(key) as Promise<T> | undefined
    if (!options.force && forcedPending) {
      this.counters.singleflightJoins++
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
      this.counters.cacheHits++
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
      }
      return value
    })
    if (!options.force) return this.deduplicate(`resource:ordinary:${key}`, load)

    // `force` means fresh from this invocation point. It must not coalesce
    // with an earlier force call whose GitHub fact may already be obsolete.
    const forced = this.withOutcome(`access ${key}`, load())
    this.forcedResources.set(key, forced)
    const clear = () => {
      if (this.forcedResources.get(key) === forced) this.forcedResources.delete(key)
    }
    void forced.then(clear, clear)
    return forced
  }

  async cachedAggregate<T>(key: string, ttlMs: number, force: boolean, loader: () => Promise<T>): Promise<T> {
    this.counters.logicalRequests++
    try {
      this.assertCircuitOpen()
    } catch (error) {
      this.recordFailure(`access ${key}`, error)
      throw error
    }
    const cached = this.aggregates.get(key) as CachedValue<T> | undefined
    if (!force && cached && cached.expiresAt > Date.now()) {
      this.counters.cacheHits++
      return cached.value
    }
    return this.deduplicate(`aggregate:${key}`, async () => {
      const value = await this.withLoaderDepth(loader)()
      this.aggregates.set(key, { value, version: null, expiresAt: Date.now() + ttlMs })
      return value
    })
  }

  private async deduplicate<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const pending = this.inFlight.get(key) as Promise<T> | undefined
    if (pending) {
      this.counters.singleflightJoins++
      return pending
    }
    const created = this.withOutcome(`access ${key}`, loader()).finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, created)
    return created
  }

  /** Leader outcome lands in exactly one bucket; joiners are already counted. */
  private async withOutcome<T>(operation: string, promise: Promise<T>): Promise<T> {
    try {
      const value = await promise
      this.counters.executions++
      return value
    } catch (error) {
      this.recordFailure(operation, error)
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
