export type DevelopAgent = 'codex' | 'claude' | 'dryrun'

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
  readonly #limit: number
  #entries: LogEntry[] = []
  #partial = ''
  #sequence = 0

  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('log limit must be positive')
    this.#limit = limit
  }

  appendLine(line: string): void {
    this.#sequence += 1
    this.#entries.push({ sequence: this.#sequence, line })
    if (this.#entries.length > this.#limit) {
      this.#entries.splice(0, this.#entries.length - this.#limit)
    }
  }

  appendChunk(chunk: string): void {
    const normalized = (this.#partial + chunk).replaceAll('\r\n', '\n').replaceAll('\r', '\n')
    const parts = normalized.split('\n')
    this.#partial = parts.pop() ?? ''
    for (const line of parts) this.appendLine(line)
  }

  flush(): void {
    if (this.#partial === '') return
    this.appendLine(this.#partial)
    this.#partial = ''
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
