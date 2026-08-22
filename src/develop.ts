import { createHash, randomBytes } from 'node:crypto'

export type DevelopAgent = 'codex' | 'claude' | 'dryrun'
export type AgentAction = 'develop' | 'review' | 'resume'

/** Build the command that continues an existing development session. */
export function buildResumeAgentCommand(agent: Exclude<DevelopAgent, 'dryrun'>, sessionId: string | null): string {
  if (agent === 'claude') {
    return sessionId
      ? `claude -p --resume ${shellQuote(sessionId)} --dangerously-skip-permissions --verbose --output-format stream-json`
      : 'claude -p --continue --dangerously-skip-permissions --verbose --output-format stream-json'
  }
  return sessionId
    ? `codex exec resume ${shellQuote(sessionId)} -c approval_policy=never -c 'sandbox_mode="danger-full-access"' --json -`
    : 'codex exec resume --last -c approval_policy=never -c \'sandbox_mode="danger-full-access"\' --json -'
}

export interface GithubTarget {
  kind: 'issue' | 'pr'
  owner: string
  repo: string
  number: string
}

export function parseAgent(value: unknown): DevelopAgent {
  const agent = String(value ?? 'codex').trim().toLowerCase()
  if (agent === 'codex' || agent === 'claude' || agent === 'dryrun') return agent
  throw new Error(`不支持的 agent "${agent}"`)
}

export function parseGithubUrl(value: string): GithubTarget | null {
  const match = value.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)\/?(?:\?[^#]*)?(?:#.*)?$/)
  if (!match) return null
  return {
    kind: match[3] === 'pull' ? 'pr' : 'issue',
    owner: match[1],
    repo: match[2],
    number: match[4],
  }
}

/** Quote one argument for a POSIX shell command without allowing expansion. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * Parse the `## 依赖` section of an issue body (issue-contract machine-readable
 * convention: `Blocked by #NN`, multiple deps comma-separated; `无` = none).
 * Returns the referenced issue numbers, empty when the section is missing.
 */
export function parseDependencies(body: string | null | undefined): number[] {
  const lines = String(body ?? '').split('\n')
  const depIndex = lines.findIndex((line) => /^##\s*依赖/.test(line.trim()))
  if (depIndex === -1) return []
  const numbers: number[] = []
  for (let i = depIndex + 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line === '') continue
    if (/^##\s/.test(line)) break // 下一个章节
    for (const match of line.matchAll(/#(\d+)/g)) {
      const number = Number(match[1])
      if (!numbers.includes(number)) numbers.push(number)
    }
  }
  return numbers
}

/** Build a worktree command whose new branch is explicitly rooted at the fetched remote base. */
export function buildWorktreeAddCommand(options: {
  path: string
  branch: string
  branchExists: boolean
  remoteBase: string
}): string {
  return options.branchExists
    ? `git worktree add ${shellQuote(options.path)} ${shellQuote(options.branch)}`
    : `git worktree add -b ${shellQuote(options.branch)} ${shellQuote(options.path)} ${shellQuote(options.remoteBase)}`
}

interface LogEntry {
  sequence: number
  line: string
}

export interface LogRead {
  cursor: number
  lines: string[]
  truncated: boolean
}

/** Bounded, non-destructive line log with independent cursor readers. */
export class LineLog {
  static readonly MAX_LINE_CHARS = 64 * 1024
  readonly #limit: number
  #entries: LogEntry[] = []
  #partial = ''
  #discardPartial = false
  #pendingCr = false
  #sequence = 0

  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('log limit must be positive')
    this.#limit = limit
  }

  appendLine(line: string): void {
    const bounded = line.length > LineLog.MAX_LINE_CHARS
      ? `${line.slice(0, LineLog.MAX_LINE_CHARS)}… [clickvibe] 单行日志已截断`
      : line
    this.#sequence += 1
    this.#entries.push({ sequence: this.#sequence, line: bounded })
    if (this.#entries.length > this.#limit) {
      this.#entries.splice(0, this.#entries.length - this.#limit)
    }
  }

  appendChunk(chunk: string): void {
    const endLine = () => {
      if (!this.#discardPartial) this.appendLine(this.#partial)
      this.#partial = ''
      this.#discardPartial = false
    }
    for (const character of chunk) {
      if (this.#pendingCr) {
        this.#pendingCr = false
        endLine()
        if (character === '\n') continue
      }
      if (character === '\r') {
        this.#pendingCr = true
      } else if (character === '\n') {
        endLine()
      } else if (!this.#discardPartial) {
        this.#partial += character
        if (this.#partial.length > LineLog.MAX_LINE_CHARS) {
          this.appendLine(this.#partial)
          this.#partial = ''
          this.#discardPartial = true
        }
      }
    }
  }

  flush(): void {
    if (this.#pendingCr) {
      this.#pendingCr = false
      if (!this.#discardPartial) this.appendLine(this.#partial)
    } else if (this.#partial !== '' && !this.#discardPartial) {
      this.appendLine(this.#partial)
    }
    this.#partial = ''
    this.#discardPartial = false
  }

  read(cursor: number): LogRead {
    const safeCursor = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0
    const oldest = this.#entries[0]?.sequence ?? this.#sequence + 1
    const truncated = safeCursor < oldest - 1
    const lines = this.#entries
      .filter((entry) => entry.sequence > safeCursor)
      .map((entry) => entry.line)
    if (truncated) lines.unshift('[clickvibe] 较早日志已截断')
    return { cursor: this.#sequence, lines, truncated }
  }
}

export interface IssuePromptSnapshot {
  url: string
  title: string
  body: string
  state: string
  updatedAt: string
  comments: { author: string; body: string }[]
}

export interface AgentAuthorizationInput {
  action: AgentAction
  url: string
  agent: 'codex' | 'claude'
  context: string
}

export interface AgentAuthorization {
  id: string
  input: AgentAuthorizationInput
  snapshot: IssuePromptSnapshot | null
  digest: string
  expiresAt: number
}

function stableAuthorizationValue(input: AgentAuthorizationInput, snapshot: IssuePromptSnapshot | null): string {
  return JSON.stringify({ input, snapshot })
}

export function authorizationDigest(
  input: AgentAuthorizationInput,
  snapshot: IssuePromptSnapshot | null,
): string {
  return createHash('sha256').update(stableAuthorizationValue(input, snapshot)).digest('hex')
}

/** One-use, short-lived server authorization bound to an exact action and issue snapshot. */
export class AuthorizationStore {
  readonly #ttlMs: number
  readonly #limit: number
  readonly #now: () => number
  #entries = new Map<string, AgentAuthorization>()

  constructor(options: { ttlMs?: number; limit?: number; now?: () => number } = {}) {
    this.#ttlMs = options.ttlMs ?? 2 * 60_000
    this.#limit = options.limit ?? 64
    this.#now = options.now ?? Date.now
    if (this.#ttlMs < 1 || this.#limit < 1) throw new Error('authorization bounds must be positive')
  }

  issue(input: AgentAuthorizationInput, snapshot: IssuePromptSnapshot | null): AgentAuthorization {
    this.prune()
    while (this.#entries.size >= this.#limit) {
      const oldest = this.#entries.keys().next().value as string | undefined
      if (!oldest) break
      this.#entries.delete(oldest)
    }
    const authorization: AgentAuthorization = {
      id: randomBytes(24).toString('base64url'),
      input,
      snapshot,
      digest: authorizationDigest(input, snapshot),
      expiresAt: this.#now() + this.#ttlMs,
    }
    this.#entries.set(authorization.id, authorization)
    return authorization
  }

  consume(id: string, input: AgentAuthorizationInput, digest: string): AgentAuthorization | null {
    this.prune()
    const authorization = this.#entries.get(id)
    if (!authorization) return null
    // Consume before comparison so a guessed/tampered request cannot retry a capability.
    this.#entries.delete(id)
    const expected = authorizationDigest(input, authorization.snapshot)
    if (digest !== authorization.digest || expected !== authorization.digest) return null
    return authorization
  }

  prune(): void {
    const now = this.#now()
    for (const [id, authorization] of this.#entries) {
      if (authorization.expiresAt <= now) this.#entries.delete(id)
    }
  }

  get size(): number { return this.#entries.size }
}

export interface RequestSecurityInput {
  remoteAddress?: string | null
  host?: string | string[]
  origin?: string | string[]
  requestMarker?: string | string[]
}

export function isLoopbackAddress(value: string | null | undefined): boolean {
  if (!value) return false
  const normalized = value.startsWith('::ffff:') ? value.slice('::ffff:'.length) : value
  return normalized === '127.0.0.1' || normalized === '::1'
}

/** Protect privileged agent starts from remote/LAN and browser CSRF requests. */
export function validatePrivilegedRequest(input: RequestSecurityInput): string | null {
  if (!isLoopbackAddress(input.remoteAddress)) return '仅允许本机回环地址启动 Agent'
  const host = Array.isArray(input.host) ? input.host[0] : input.host
  const origin = Array.isArray(input.origin) ? input.origin[0] : input.origin
  const marker = Array.isArray(input.requestMarker) ? input.requestMarker[0] : input.requestMarker
  if (!host || !origin || marker !== '1') return '缺少同源 Agent 授权请求头'
  try {
    const parsed = new URL(origin)
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.host !== host) {
      return '拒绝跨站 Agent 请求'
    }
  } catch {
    return 'Origin 无效'
  }
  return null
}

export function makeAuthorizationInput(value: {
  action?: unknown
  url?: unknown
  agent?: unknown
  context?: unknown
}): AgentAuthorizationInput {
  const action = String(value.action ?? '') as AgentAction
  if (action !== 'develop' && action !== 'review' && action !== 'resume') {
    throw new Error('不支持的 Agent 操作')
  }
  const agent = parseAgent(value.agent)
  if (agent === 'dryrun') throw new Error('dryrun 不需要高权限授权')
  const url = String(value.url ?? '').trim()
  if (!parseGithubUrl(url)) throw new Error('GitHub URL 无效')
  return {
    action,
    url,
    agent,
    context: typeof value.context === 'string' ? value.context.trim() : '',
  }
}

export interface WorktreeSnapshot {
  targetBranch: string
  pathExists: boolean
  pathEmpty: boolean
  /** Short branch name, or HEAD for a detached registered worktree. */
  registeredBranch: string | null
  branchExists: boolean
  /** Registered location of the intended branch, if any. */
  branchWorktree: string | null
}

export type WorktreeRecovery =
  | { kind: 'add-new-branch' }
  | { kind: 'add-existing-branch' }
  | { kind: 'reuse' }
  | { kind: 'attach-detached' }
  | { kind: 'attach-existing' }
  | { kind: 'repair'; reason: string }
  | { kind: 'conflict'; reason: string }

/** Decide a safe recovery action without deleting or overwriting directories. */
export function decideWorktreeRecovery(snapshot: WorktreeSnapshot): WorktreeRecovery {
  const {
    targetBranch, pathExists, pathEmpty, registeredBranch, branchExists, branchWorktree,
  } = snapshot

  if (branchWorktree !== null && registeredBranch !== targetBranch) {
    return { kind: 'conflict', reason: `目标分支已被其他 worktree 使用: ${branchWorktree}` }
  }

  if (registeredBranch !== null) {
    if (registeredBranch === 'HEAD') {
      return branchExists ? { kind: 'attach-existing' } : { kind: 'attach-detached' }
    }
    if (registeredBranch !== '') {
      if (registeredBranch !== targetBranch) {
        return { kind: 'conflict', reason: `目标路径已检出其他分支: ${registeredBranch}` }
      }
      // 注册匹配目标分支:仅当路径真实存在且非空才能复用;
      // 路径消失或为空(stale 注册)→ repair:先清理注册再重建。
      if (pathExists && !pathEmpty) return { kind: 'reuse' }
      return {
        kind: 'repair',
        reason: `注册记录指向 ${targetBranch} 但路径${pathExists ? '为空' : '不存在'},需要清理注册后重建`,
      }
    }
  }

  if (pathExists && !pathEmpty) {
    return { kind: 'conflict', reason: '目标路径是未注册的非空目录,拒绝覆盖' }
  }
  return branchExists ? { kind: 'add-existing-branch' } : { kind: 'add-new-branch' }
}
