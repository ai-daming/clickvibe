import { readFile } from 'node:fs/promises'
import { logTaskDiagnostic } from '../infra/task-diagnostics.ts'
import { createGithubGatewayOwner, githubGatewayOwner, type GithubGatewayOwner } from './gateway-owner.ts'

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

const HOST_GITHUB_MINIMUM_INTERVAL_MS = 250

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

/** Extract `owner/repo` from a REST path for per-repository admission; unknown paths share one bucket. */
function repoKeyFromPath(path: string): string {
  const match = path.match(/repos\/([^/]+\/+[^/'"]+)/)
  return match ? match[1] : 'uncategorized'
}

/** The real resource bucket a path draws from: search endpoints have their own
 *  limit, everything else shares core (design §8 per-bucket isolation). */
function bucketFromPath(path: string): string {
  return path.startsWith('search/') ? 'search' : 'core'
}

function rateObservationFrom(headers: Map<string, string> | null) {
  if (!headers) return null
  const numberOr = (key: string): number | null => {
    const raw = headers.get(key)
    if (raw === undefined) return null
    const value = Number(raw)
    return Number.isFinite(value) ? value : null
  }
  // No rate headers at all → no bucket observation (unknown), never a
  // fabricated core bucket (#149 rounds 4-6).
  const hasAnyRateHeader = ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after'].some(
    (key) => headers.get(key) !== undefined,
  )
  if (!hasAnyRateHeader) return null
  const resource = headers.get('x-ratelimit-resource')
  return {
    // A missing resource stays null — a URL guess never impersonates
    // response evidence (review r8/F7).
    resource: resource !== undefined ? resource : null,
    limit: numberOr('x-ratelimit-limit'),
    remaining: numberOr('x-ratelimit-remaining'),
    used: numberOr('x-ratelimit-used'),
    reset: numberOr('x-ratelimit-reset'),
    retryAfterSeconds: numberOr('retry-after'),
    observedAt: Date.now(),
  }
}

/** One ctx-scoped REST reader: rate-limit circuit, request parsing and read caches. */
export class GithubRestReader {
  private readonly ctx: ShellContext
  private readonly minimumIntervalMs: number
  /** Gateway state host (caches, singleflight, versions, circuit); the reader keeps shell I/O only. */
  private readonly owner: GithubGatewayOwner

  constructor(ctx: ShellContext, options: { minimumIntervalMs?: number; owner?: GithubGatewayOwner } = {}) {
    this.ctx = ctx
    this.minimumIntervalMs = Math.max(0, options.minimumIntervalMs ?? HOST_GITHUB_MINIMUM_INTERVAL_MS)
    this.owner = options.owner ?? createGithubGatewayOwner()
  }

  rateLimitError(now = Date.now()): GithubRateLimitError | null {
    return this.owner.rateLimitError(now)
  }

  rememberVersion(key: string, version: string | null | undefined): void {
    this.owner.rememberVersion(key, version)
  }

  resourceVersion(key: string): string | null {
    return this.owner.resourceVersion(key)
  }

  invalidate(prefix: string): void {
    this.owner.invalidate(prefix)
  }

  private async output(result: Awaited<ReturnType<ShellContext['shell']['run']>>): Promise<string> {
    const stdout = result.stdout
    if (stdout.truncated) {
      if (!stdout.spillPath) throw new Error('GitHub REST 输出超过上限且无 spill 文件')
      return readFile(stdout.spillPath, 'utf8')
    }
    return stdout.text
  }

  private async request(
    path: string,
    accept?: string,
    timeoutMs = 30_000,
    mutation?: { method: 'POST' | 'PATCH'; body: unknown },
  ): Promise<IncludedResponse> {
    const repo = repoKeyFromPath(path)
    const bucket = this.owner.resolveResourceIdentity(path, bucketFromPath(path))
    return this.owner.submitStep(
      repo,
      timeoutMs,
      this.minimumIntervalMs,
      async () => {
        const requestId = this.owner.ambientRequestId()
        // A request queued before another resource trips the circuit must not
        // hit GitHub afterwards. Primary pauses are bucket-scoped (review
        // r6/F7): a dead core bucket must not fence a healthy search call.
        this.owner.assertCircuitOpen(bucket)
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
          if (requestId) this.owner.noteUpstreamSettled(requestId, false, null, path)
          if (result.exitCode !== 0 && /(?:rate limit|secondary rate)/i.test(detail)) {
            const until = Date.now() + 60 * 60_000
            this.owner.noteRateLimitTrip(until, 'unknown')
            logTaskDiagnostic('github-rate-circuit-trip', {
              kind: 'unknown' as const,
              path,
              until,
              note: 'gh CLI 失败且无响应头,按 60 分钟保守熔断',
            })
            throw new GithubRateLimitError(until, 'unknown')
          }
          if (result.exitCode !== 0) throw new Error(detail || `gh api 执行失败(exit ${result.exitCode})`)
          throw parseError
        }
        const detail = [result.stderr?.text, response.body].filter(Boolean).join('\n')
        if (isRateLimited(response, detail)) {
          if (requestId) this.owner.noteUpstreamSettled(requestId, false, rateObservationFrom(response.headers), path)
          const until = resetFrom(response.headers, Date.now())
          const kind: GithubRateLimitKind =
            response.headers.get('x-ratelimit-remaining') === '0' ? 'primary' : 'secondary'
          // The pause targets the bucket the RESPONSE says it consumed
          // (x-ratelimit-resource), never the URL guess; a primary response
          // without a resource stays credential-wide unknown — a path guess
          // must never impersonate response evidence (review r7/F7).
          const observedResource = response.headers.get('x-ratelimit-resource')
          this.owner.noteRateLimitTrip(until, kind, kind === 'primary' ? (observedResource ?? undefined) : undefined)
          logTaskDiagnostic('github-rate-circuit-trip', {
            kind,
            path,
            remaining: response.headers.get('x-ratelimit-remaining'),
            reset: response.headers.get('x-ratelimit-reset'),
            retryAfter: response.headers.get('retry-after'),
            until,
          })
          throw new GithubRateLimitError(until, kind)
        }
        if (result.exitCode !== 0 || response.status < 200 || response.status >= 300) {
          if (requestId) this.owner.noteUpstreamSettled(requestId, false, rateObservationFrom(response.headers), path)
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
      },
      { bucket },
    )
  }

  /** A top-level (non-loader) request is its own logical request in the lifecycle stream. */
  private async direct<T>(path: string, run: () => Promise<T>): Promise<T> {
    if (this.owner.ambientRequestId()) return run()
    const requestId = this.owner.declareLogicalRequest('direct', path)
    try {
      const value = await this.owner.runWithRequest(requestId, run)
      this.owner.noteTerminal(requestId, 'succeeded')
      return value
    } catch (error) {
      this.owner.noteTerminal(requestId, error instanceof GithubRateLimitError ? 'rate-limited' : 'failed', error)
      throw error
    }
  }

  async json<T = unknown>(path: string, accept?: string, timeoutMs?: number): Promise<T> {
    return this.direct(path, async () => {
      const response = await this.request(path, accept, timeoutMs)
      return this.settleAfterParse<T>(response, path)
    })
  }

  async mutate<T = unknown>(path: string, method: 'POST' | 'PATCH', body: unknown, timeoutMs?: number): Promise<T> {
    return this.direct(path, async () => {
      const response = await this.request(path, undefined, timeoutMs, { method, body })
      return this.settleAfterParse<T>(response, path)
    })
  }

  /** Settle the upstream step only once the payload actually parsed AND passed
   *  its shape validation — an HTTP 200 with a garbage or wrong-shape body is
   *  a failed step, never a successful settlement followed by a terminal
   *  failure (review r1; r5 pagination shape gap). */
  private async settleAfterParse<T>(
    response: IncludedResponse,
    path: string,
    validate?: (value: T) => void,
  ): Promise<T> {
    const requestId = this.owner.ambientRequestId()
    try {
      const value = JSON.parse(response.body || 'null') as T
      validate?.(value)
      if (requestId) this.owner.noteUpstreamSettled(requestId, true, rateObservationFrom(response.headers), path)
      return value
    } catch (error) {
      if (requestId) this.owner.noteUpstreamSettled(requestId, false, rateObservationFrom(response.headers), path)
      if (error instanceof SyntaxError) throw new Error(`GitHub REST 返回了无效 JSON: ${path}`)
      throw error
    }
  }

  async paginate<T>(path: string, accept?: string, timeoutMs?: number): Promise<T[]> {
    return this.direct(path, async () => {
      const values: T[] = []
      for (let page = 1; ; page++) {
        // Cost-bound admission: continuation pages re-enter admission under
        // the SAME logical deadline and declared dispatch bound (design §6.2).
        this.owner.admitNextPage()
        const separator = path.includes('?') ? '&' : '?'
        const response = await this.request(`${path}${separator}per_page=100&page=${page}`, accept, timeoutMs)
        const batch = await this.settleAfterParse<T[]>(response, path, (value) => {
          if (!Array.isArray(value)) throw new Error('GitHub REST 分页返回格式无效')
        })
        values.push(...batch)
        if (batch.length < 100) return values
      }
    })
  }

  /** Stamp the operation policy's admission attributes around a composition. */
  withAdmission<T>(
    priority: 'critical' | 'normal',
    deadlineMs: number,
    maxPages: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.owner.runWithAdmission({ priority, deadlineMs, maxPages }, fn)
  }

  cachedResource<T>(
    key: string,
    version: string | null | undefined,
    loader: () => Promise<T>,
    options: { ttlMs?: number; force?: boolean; versionOf?: (value: T) => string | null | undefined } = {},
  ): Promise<T> {
    return this.owner.cachedResource(key, version, loader, options)
  }

  async cachedAggregate<T>(
    key: string,
    ttlMs: number,
    force: boolean,
    loader: () => Promise<T>,
    options?: { derivedVersions?: (value: T) => Array<[key: string, version: string | null | undefined]> },
  ): Promise<T> {
    return this.owner.cachedAggregate(key, ttlMs, force, loader, options)
  }
}

const readers = new WeakMap<object, { owner: GithubGatewayOwner; reader: GithubRestReader }>()

/** One reader per ctx, all bound to the PROCESS-level owner — one credential
 *  scope owns one Gateway runtime regardless of how many ctx objects exist
 *  (review r2: per-ctx owners split one budget into parallel schedulers).
 * The cache entry carries its owner: close() swaps the process owner, and a
 * cached reader must never keep serving the closed generation (review r6/F3). */
export function githubRest(ctx: ShellContext): GithubRestReader {
  const key = ctx as object
  const owner = githubGatewayOwner()
  const existing = readers.get(key)
  if (existing && existing.owner === owner) return existing.reader
  const created = new GithubRestReader(ctx, { owner })
  readers.set(key, { owner, reader: created })
  return created
}

export function githubErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isGithubRateLimitError(error: unknown): error is GithubRateLimitError {
  return error instanceof GithubRateLimitError
}
