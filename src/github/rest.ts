import { readFile } from 'node:fs/promises'

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

function recoveryLabel(resetAt: number): string {
  return new Date(resetAt).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

export class GithubRateLimitError extends Error {
  readonly resetAt: number

  constructor(resetAt: number) {
    super(`GitHub 额度已用完,约 ${recoveryLabel(resetAt)} 恢复`)
    this.name = 'GithubRateLimitError'
    this.resetAt = resetAt
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
  private readonly resources = new Map<string, CachedValue<unknown>>()
  private readonly aggregates = new Map<string, CachedValue<unknown>>()
  private readonly inFlight = new Map<string, Promise<unknown>>()
  private readonly versions = new Map<string, string>()
  private circuitUntil = 0

  constructor(ctx: ShellContext) {
    this.ctx = ctx
  }

  rateLimitError(now = Date.now()): GithubRateLimitError | null {
    return this.circuitUntil > now ? new GithubRateLimitError(this.circuitUntil) : null
  }

  rememberVersion(key: string, version: string | null | undefined): void {
    if (version) this.versions.set(key, version)
  }

  resourceVersion(key: string): string | null {
    return this.versions.get(key) ?? null
  }

  invalidate(prefix: string): void {
    for (const key of this.resources.keys()) {
      if (key === prefix || key.startsWith(`${prefix}/`)) this.resources.delete(key)
    }
    for (const key of this.aggregates.keys()) {
      if (key === prefix || key.startsWith(`${prefix}/`)) this.aggregates.delete(key)
    }
    this.versions.delete(prefix)
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

  private async request(
    path: string,
    accept?: string,
    timeoutMs = 30_000,
    mutation?: { method: 'POST' | 'PATCH'; body: unknown },
  ): Promise<IncludedResponse> {
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
    const result = await this.ctx.shell.run(spec)
    const stdout = await this.output(result)
    let response: IncludedResponse
    try {
      response = parseIncludedResponse(stdout)
    } catch (parseError) {
      const detail = [result.stderr?.text, stdout].filter(Boolean).join('\n').trim()
      if (result.exitCode !== 0 && /(?:rate limit|secondary rate)/i.test(detail)) {
        this.circuitUntil = Date.now() + 60 * 60_000
        throw new GithubRateLimitError(this.circuitUntil)
      }
      if (result.exitCode !== 0) throw new Error(detail || `gh api 执行失败(exit ${result.exitCode})`)
      throw parseError
    }
    const detail = [result.stderr?.text, response.body].filter(Boolean).join('\n')
    if (isRateLimited(response, detail)) {
      this.circuitUntil = resetFrom(response.headers, Date.now())
      throw new GithubRateLimitError(this.circuitUntil)
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
  }

  async json<T = unknown>(path: string, accept?: string, timeoutMs?: number): Promise<T> {
    const response = await this.request(path, accept, timeoutMs)
    try {
      return JSON.parse(response.body || 'null') as T
    } catch {
      throw new Error(`GitHub REST 返回了无效 JSON: ${path}`)
    }
  }

  async mutate<T = unknown>(path: string, method: 'POST' | 'PATCH', body: unknown, timeoutMs?: number): Promise<T> {
    const response = await this.request(path, undefined, timeoutMs, { method, body })
    try {
      return JSON.parse(response.body || 'null') as T
    } catch {
      throw new Error(`GitHub REST 返回了无效 JSON: ${path}`)
    }
  }

  async paginate<T>(path: string, accept?: string, timeoutMs?: number): Promise<T[]> {
    const values: T[] = []
    for (let page = 1; ; page++) {
      const separator = path.includes('?') ? '&' : '?'
      const batch = await this.json<T[]>(`${path}${separator}per_page=100&page=${page}`, accept, timeoutMs)
      if (!Array.isArray(batch)) throw new Error('GitHub REST 分页返回格式无效')
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
    this.assertCircuitOpen()
    const knownVersion = version || null
    const cached = this.resources.get(key) as CachedValue<T> | undefined
    const now = Date.now()
    if (
      !options.force &&
      cached &&
      cached.expiresAt > now &&
      (knownVersion === null || cached.version === knownVersion)
    )
      return cached.value
    return this.deduplicate(`resource:${key}`, async () => {
      const value = await loader()
      const loadedVersion = options.versionOf?.(value) || knownVersion
      this.resources.set(key, {
        value,
        version: loadedVersion,
        expiresAt: Date.now() + (options.ttlMs ?? 30_000),
      })
      if (loadedVersion) this.versions.set(key, loadedVersion)
      return value
    })
  }

  async cachedAggregate<T>(key: string, ttlMs: number, force: boolean, loader: () => Promise<T>): Promise<T> {
    this.assertCircuitOpen()
    const cached = this.aggregates.get(key) as CachedValue<T> | undefined
    if (!force && cached && cached.expiresAt > Date.now()) return cached.value
    return this.deduplicate(`aggregate:${key}`, async () => {
      const value = await loader()
      this.aggregates.set(key, { value, version: null, expiresAt: Date.now() + ttlMs })
      return value
    })
  }

  private async deduplicate<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const pending = this.inFlight.get(key) as Promise<T> | undefined
    if (pending) return pending
    const created = loader().finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, created)
    return created
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
