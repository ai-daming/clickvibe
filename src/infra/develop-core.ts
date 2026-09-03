import { createHash, randomBytes } from 'node:crypto'
import {
  isValidGitBranchName,
  type MergeAuthorizationTarget,
  mergeAuthorizationTarget,
  type RestoreAuthorizationTarget,
  restoreAuthorizationTarget,
} from './authorization-target.ts'
import { type AutoRunAuthorizationConfig, parseAutoRunAuthorization } from './auto-run-authorization.ts'
import type { ContractAuthorizationBinding, PromptSnapshot } from './contracts.ts'

export type DevelopAgent = 'codex' | 'claude' | 'dryrun'
export type AgentAction = 'develop' | 'review' | 'resume' | 'create-pr' | 'merge' | 'auto' | 'restore-base'

/**
 * ClickVibe 自身合并门禁项(issue #49);GitHub 侧保护永远不可跳过。
 */
export const MERGE_OVERRIDE_GATES = [
  'review-hash', // 实时 PR HEAD 与最近一次通过的 review 结论哈希不一致
  'review-base', // 实时 PR base 与最近一次通过的 review 基线身份不一致
  'review-contract-missing', // 最近通过的 review 缺少验收契约快照
  'contract-unreadable', // 无法读取当前验收契约
  'contract-changed', // 验收契约已变更
] as const

export type MergeOverrideGate = (typeof MERGE_OVERRIDE_GATES)[number]

/** 人工放行原因的长度上限(与面板本地校验保持一致)。 */
export const MERGE_OVERRIDE_REASON_MAX = 500

/** 门禁 key → 面板/审计展示文案的唯一来源;服务端下发,客户端不再自行维护映射。 */
export const MERGE_GATE_LABELS: Record<MergeOverrideGate, string> = {
  'review-hash': 'PR HEAD 与 review 结论哈希不一致',
  'review-base': 'PR base 与 review 结论基线不一致',
  'review-contract-missing': 'review 缺少验收契约快照',
  'contract-unreadable': '无法读取当前验收契约',
  'contract-changed': '验收契约已变更',
}

export function mergeGateLabel(key: MergeOverrideGate | string): string {
  return MERGE_GATE_LABELS[key as MergeOverrideGate] ?? key
}

export const RESUME_REJECT_WINDOW_MS = 15_000

const CODEX_PERMISSION_FLAGS = `-c 'approval_policy="never"' -s danger-full-access`
const CLAUDE_PERMISSION_FLAGS = '--dangerously-skip-permissions'

/** Build a brand-new agent command; used after an exact resume id is rejected. */
export function buildFreshAgentCommand(agent: Exclude<DevelopAgent, 'dryrun'>): string {
  return agent === 'claude'
    ? `claude -p ${CLAUDE_PERMISSION_FLAGS} --verbose --output-format stream-json`
    : `codex exec ${CODEX_PERMISSION_FLAGS} --json -`
}

/** Build the command that continues an existing development session. */
export function buildResumeAgentCommand(agent: Exclude<DevelopAgent, 'dryrun'>, sessionId: string | null): string {
  if (agent === 'claude') {
    return sessionId
      ? `claude -p --resume ${shellQuote(sessionId)} ${CLAUDE_PERMISSION_FLAGS} --verbose --output-format stream-json`
      : `claude -p --continue ${CLAUDE_PERMISSION_FLAGS} --verbose --output-format stream-json`
  }
  return sessionId
    ? `codex exec ${CODEX_PERMISSION_FLAGS} resume ${shellQuote(sessionId)} --json -`
    : `codex exec ${CODEX_PERMISSION_FLAGS} resume --last --json -`
}

/** Only a quick failure before session initialization proves an exact id is stale. */
export function shouldFallbackFromExactResume(facts: {
  hadExactSessionId: boolean
  status: 'running' | 'done' | 'failed' | 'stopped' | 'timed_out'
  exitCode: number | null
  elapsedMs: number
  sawSessionId: boolean
}): boolean {
  return (
    facts.hadExactSessionId &&
    facts.status === 'failed' &&
    facts.exitCode !== null &&
    facts.exitCode !== 0 &&
    facts.elapsedMs <= RESUME_REJECT_WINDOW_MS &&
    !facts.sawSessionId
  )
}

export interface GithubTarget {
  kind: 'issue' | 'pr'
  owner: string
  repo: string
  number: string
}

export function parseAgent(value: unknown): DevelopAgent {
  const agent = String(value ?? 'codex')
    .trim()
    .toLowerCase()
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
  const depIndex = lines.findIndex((line) => /^##\s*依赖\s*$/.test(line.trim()))
  if (depIndex === -1) return []
  const numbers: number[] = []
  for (let i = depIndex + 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line === '') continue
    if (/^##(?!#)/.test(line)) break // 下一个二级章节,兼容 `##参考`
    // 自动改写行里的旧编号只用于审计,不能重新形成活跃依赖边。
    if (/^(?:依赖\s*:\s*)?无\s*[（(]原\s+Blocked by\b.*已完成.*自动更新[)）]\s*$/i.test(line)) continue
    if (!/Blocked by\s*#\d+/i.test(line)) continue
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

export interface LogEntry {
  sequence: number
  line: string
}

export interface DetailedLogRead extends LogRead {
  entries: LogEntry[]
}

export interface LogRead {
  cursor: number
  lines: string[]
  truncated: boolean
}

/** Line-count-bounded, non-destructive log with independent cursor readers. */
export class LineLog {
  readonly #limit: number
  #entries: LogEntry[] = []
  #partial = ''
  #pendingCr = false
  #sequence = 0

  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('log limit must be positive')
    this.#limit = limit
  }

  appendLine(line: string): number {
    this.#sequence += 1
    this.#entries.push({ sequence: this.#sequence, line })
    if (this.#entries.length > this.#limit) {
      this.#entries.splice(0, this.#entries.length - this.#limit)
    }
    return this.#sequence
  }

  appendChunk(chunk: string): void {
    const endLine = () => {
      this.appendLine(this.#partial)
      this.#partial = ''
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
      } else {
        this.#partial += character
      }
    }
  }

  flush(): void {
    if (this.#pendingCr) {
      this.#pendingCr = false
      this.appendLine(this.#partial)
    } else if (this.#partial !== '') {
      this.appendLine(this.#partial)
    }
    this.#partial = ''
  }

  read(cursor: number): LogRead {
    const detailed = this.readDetailed(cursor)
    const lines = detailed.entries.map((entry) => entry.line)
    if (detailed.truncated) lines.unshift('[clickvibe] 较早日志已截断')
    return {
      cursor: detailed.cursor,
      lines,
      truncated: detailed.truncated,
    }
  }

  readDetailed(cursor: number): DetailedLogRead {
    const safeCursor = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0
    const oldest = this.#entries[0]?.sequence ?? this.#sequence + 1
    const truncated = safeCursor < oldest - 1
    const entries = this.#entries.filter((entry) => entry.sequence > safeCursor)
    return { cursor: this.#sequence, lines: entries.map((entry) => entry.line), entries, truncated }
  }
}

export type IssuePromptSnapshot = PromptSnapshot
export interface AgentAuthorizationInput {
  action: AgentAction
  url: string
  agent: 'codex' | 'claude' | null
  context: string
  baseline?: string
  autoRun?: AutoRunAuthorizationConfig
  /** Manual choice to abandon the resumable session while preserving git artifacts. */
  freshSession?: true
  target?: MergeAuthorizationTarget
  restoreTarget?: RestoreAuthorizationTarget
  /** 人工放行(仅 merge):被用户二次确认跳过的门禁项与放行原因;计入授权摘要,不可篡改。 */
  override?: {
    skipped: MergeOverrideGate[]
    reason: string
  }
}

export interface AgentAuthorization {
  id: string
  input: AgentAuthorizationInput
  snapshot: IssuePromptSnapshot | null
  contract: ContractAuthorizationBinding | null
  digest: string
  expiresAt: number
}

function stableAuthorizationValue(
  input: AgentAuthorizationInput,
  contract: ContractAuthorizationBinding | null,
): string {
  return JSON.stringify({ input, contract })
}

export function authorizationDigest(
  input: AgentAuthorizationInput,
  contract: ContractAuthorizationBinding | null,
): string {
  return createHash('sha256').update(stableAuthorizationValue(input, contract)).digest('hex')
}

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

  issue(
    input: AgentAuthorizationInput,
    snapshot: IssuePromptSnapshot | null,
    contract: ContractAuthorizationBinding | null = null,
  ): AgentAuthorization {
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
      contract,
      digest: authorizationDigest(input, contract),
      expiresAt: this.#now() + this.#ttlMs,
    }
    this.#entries.set(authorization.id, authorization)
    return authorization
  }

  consume(id: string, input: AgentAuthorizationInput, digest: string): AgentAuthorization | null {
    this.prune()
    const authorization = this.#entries.get(id)
    if (!authorization) return null
    this.#entries.delete(id)
    const expected = authorizationDigest(input, authorization.contract)
    if (digest !== authorization.digest || expected !== authorization.digest) return null
    return authorization
  }

  prune(): void {
    const now = this.#now()
    for (const [id, authorization] of this.#entries) {
      if (authorization.expiresAt <= now) this.#entries.delete(id)
    }
  }

  get size(): number {
    return this.#entries.size
  }
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
  baseline?: unknown
  freshSession?: unknown
  target?: unknown
  restoreTarget?: unknown
  override?: unknown
  autoRun?: unknown
}): AgentAuthorizationInput {
  const action = String(value.action ?? '') as AgentAction
  if (!['develop', 'review', 'resume', 'create-pr', 'merge', 'auto', 'restore-base'].includes(action)) {
    throw new Error('不支持的 Agent 操作')
  }
  const parsedAgent =
    action === 'merge' || action === 'create-pr' || action === 'auto' || action === 'restore-base'
      ? null
      : parseAgent(value.agent)
  if (parsedAgent === 'dryrun') throw new Error('dryrun 不需要高权限授权')
  const url = String(value.url ?? '').trim()
  if (!parseGithubUrl(url)) throw new Error('GitHub URL 无效')
  let baseline: string | undefined
  if (action === 'develop' && value.baseline !== undefined) {
    baseline = String(value.baseline).trim()
    if (!baseline.startsWith('origin/') || !isValidGitBranchName(baseline.slice('origin/'.length))) {
      throw new Error('开发基线只接受 origin/* 远端分支')
    }
  }
  const freshSession = value.freshSession === true
  if (freshSession && action !== 'resume' && action !== 'review') {
    throw new Error('新开会话只支持 resume 或 review')
  }
  let target: AgentAuthorizationInput['target']
  if (action === 'merge' && value.target !== undefined) {
    target = mergeAuthorizationTarget(value.target)
  }
  let restoreTarget: AgentAuthorizationInput['restoreTarget']
  if (action === 'restore-base' && value.restoreTarget !== undefined) {
    restoreTarget = restoreAuthorizationTarget(value.restoreTarget)
  }
  let override: AgentAuthorizationInput['override']
  if (
    action === 'merge' &&
    typeof value.override === 'object' &&
    value.override !== null &&
    !Array.isArray(value.override)
  ) {
    const raw = value.override as { skipped?: unknown; reason?: unknown }
    const skipped = Array.isArray(raw.skipped) ? [...new Set(raw.skipped.map((item) => String(item)))] : []
    const known = MERGE_OVERRIDE_GATES as readonly string[]
    if (skipped.length === 0 || skipped.some((key) => !known.includes(key))) {
      throw new Error('人工放行的门禁项无效')
    }
    const reason = String(raw.reason ?? '').trim()
    if (reason === '' || reason.length > MERGE_OVERRIDE_REASON_MAX) {
      throw new Error(`人工放行的放行原因无效(需 1-${MERGE_OVERRIDE_REASON_MAX} 字)`)
    }
    override = { skipped: skipped as MergeOverrideGate[], reason }
  }
  const autoRun = action === 'auto' ? parseAutoRunAuthorization(value.autoRun) : undefined
  return {
    action,
    url,
    agent: parsedAgent,
    context: typeof value.context === 'string' ? value.context.trim() : '',
    ...(baseline ? { baseline } : {}),
    ...(autoRun ? { autoRun } : {}),
    ...(freshSession ? { freshSession: true } : {}),
    ...(target ? { target } : {}),
    ...(restoreTarget ? { restoreTarget } : {}),
    ...(override ? { override } : {}),
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
  const { targetBranch, pathExists, pathEmpty, registeredBranch, branchExists, branchWorktree } = snapshot

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
