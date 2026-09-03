import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
/**
 * clickvibe host half — routes:
 * - `/clickvibe/api/fetch`          — fetch GitHub issue/PR data via gh
 * - `/clickvibe/api/command`        — text-command entry (issue #13): conversation
 *                                      triggers reuse the same action handlers below
 * - `/clickvibe/api/state`          — restore panel context (all workflows)
 * - `/clickvibe/api/develop`        — start dev: worktree+branch+agent
 * - `/clickvibe/api/develop/poll`   — incremental dev log/status (JSON)
 * - `/clickvibe/api/history`        — complete disk-backed task history
 * - `/clickvibe/api/stream`         — SSE live status stream for a task
 * - `/clickvibe/api/review`         — review the dev branch with codex/claude
 * - `/clickvibe/api/auto`           — reconcile one issue through review convergence
 * - `/clickvibe/api/create-pr`      — push and create/reuse the workflow PR
 * - `/clickvibe/api/resume`         — resume an interrupted dev session
 * - `/clickvibe/api/sync`           — sync the worktree with the remote base (issue #5)
 *
 * Workflow per issue (persisted under ~/.clickvibe/state/):
 *   developing → review-ready → reviewing → passed
 *                      ↑                  │
 *                      └── rework ────────┘
 */
import type { Context } from '@deepseek-ai/cordis'
import { ensureRemoteFresh, remoteFetch, remoteGitCoordinator } from './remote-git.ts'
import { parse as parseYaml } from 'yaml'
import { parseClickVibeConfigV1 } from './project-binding.ts'
import { verifyProjectBindingRepository } from './repository-identity.ts'
import { v02UpgradePlanFingerprint, type V02UpgradePlan } from './v02-upgrade.ts'
import {
  type AgentAuthorization,
  type AgentAuthorizationInput,
  AuthorizationStore,
  type DevelopAgent,
  LineLog,
  makeAuthorizationInput,
  parseGithubUrl,
  validatePrivilegedRequest,
} from './develop-core.ts'
import { LineBuffer } from './line-buffer.ts'
import { type RepositoryFreshness, RepositoryRefreshClock } from './repo-freshness.ts'
import type { IssueWorkflow, WorkflowTaskLease } from './state.ts'
import { ExclusiveTaskGate } from './task-gate.ts'

const MAX_BODY_BYTES = 64 * 1024

export interface ClickVibeConfig {
  schemaVersion?: 1
  repos: Record<string, string>
  worktreeRoot: string
  /** Remote-ref refresh interval for read paths. Clamped to 30-60 seconds. */
  fetchTtlSeconds?: number
  /** Maximum active controller-diagnostic JSONL size before one-segment rotation. */
  diagnosticsMaxBytes?: number
}

export const DEFAULT_FETCH_TTL_SECONDS = 45

export const READ_FETCH_WAIT_MS = 2_000

export const repositoryFreshness = { clear: () => remoteGitCoordinator().clearFreshness() }

export const dependencyRefreshClock = new RepositoryRefreshClock()

/** Coalesce one batch's dependency validation into one live repository snapshot. */
export const automaticDependencyValidationClock = new RepositoryRefreshClock()

/** In-memory live task handle: the running process + a status-line buffer. */
export interface LiveTask {
  taskId: string
  workflowKey: string
  workflow: IssueWorkflow
  kind: 'dev' | 'review'
  agent: DevelopAgent
  /** In-memory start of this exact run; a resumed run creates a new task/time. */
  startedAt: number
  process?: ReturnType<Context['shell']['start']>
  log: LineLog
  rawLog: LineBuffer
  closed: boolean
  status: 'running' | 'done' | 'failed' | 'stopped' | 'timed_out'
  exitCode: number | null
  timeout?: ReturnType<typeof setTimeout>
  cleanup?: ReturnType<typeof setTimeout>
  sessionId: string | null // 从事件流捕获的 agent 会话 id(续会话用)
  /** Claim-signed lifecycle capability; never reconstructed from persisted workflow state. */
  workflowLease: WorkflowTaskLease | null
}

export const liveTasks = new Map<string, LiveTask>()

export const reviewTaskGate = new ExclusiveTaskGate<LiveTask>()

export const mergingWorkflows = new Set<string>()

export const resumeTaskGate = new ExclusiveTaskGate<LiveTask>()

export const liveWaiters = new Map<string, Set<() => void>>()

export const authorizations = new AuthorizationStore()

export const TASK_LOG_LINES = 2000

export const TASK_TIMEOUT_MS = 24 * 60 * 60_000

export const TASK_RETENTION_MS = 5 * 60_000

export const MAX_TASKS = 64

export function taskId(prefix: string): string {
  return `${prefix}-${Date.now()}-${randomBytes(12).toString('base64url')}`
}

/** Notify SSE waiters that new lines are available for a task. */
export function notifyTask(taskId: string): void {
  const waiters = liveWaiters.get(taskId)
  if (waiters) for (const fn of waiters) fn()
}

/** Expand a leading `~` in a path to the user's home directory. */
export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

async function loadV02Config(home: string, raw: string, parsed: unknown): Promise<ClickVibeConfig> {
  const root = join(home, '.clickvibe')
  const config = parseClickVibeConfigV1(parsed)
  const [journalRaw, markerRaw] = await Promise.all([
    readFile(join(root, 'upgrade-v0.2.json'), 'utf8'),
    readFile(join(root, 'state', '.clickvibe-state.json'), 'utf8'),
  ])
  const journal = JSON.parse(journalRaw) as {
    schemaVersion?: unknown
    phase?: unknown
    planFingerprint?: unknown
    plan?: V02UpgradePlan
  }
  const marker = JSON.parse(markerRaw) as { schemaVersion?: unknown; generation?: unknown; planFingerprint?: unknown }
  if (journal.schemaVersion !== 1 || journal.phase !== 'verified' || typeof journal.planFingerprint !== 'string') {
    throw new Error('v0.2 config is not paired with a verified upgrade journal')
  }
  if (!journal.plan || v02UpgradePlanFingerprint(journal.plan) !== journal.planFingerprint) {
    throw new Error('v0.2 upgrade journal plan fingerprint is invalid')
  }
  if (
    journal.plan.paths.root !== root ||
    journal.plan.paths.activeConfig !== join(root, 'config.yaml') ||
    journal.plan.paths.activeState !== join(root, 'state') ||
    journal.plan.paths.journal !== join(root, 'upgrade-v0.2.json')
  ) {
    throw new Error('v0.2 upgrade journal paths do not belong to this ClickVibe home')
  }
  if (
    marker.schemaVersion !== 1 ||
    marker.generation !== 'v0.2' ||
    marker.planFingerprint !== journal.planFingerprint
  ) {
    throw new Error('v0.2 state marker fingerprint does not match the verified journal')
  }
  const digest = createHash('sha256').update(raw).digest('hex')
  if (journal.plan.targetConfig.sha256 !== digest) throw new Error('v0.2 config fingerprint does not match the journal')
  const repos: Record<string, string> = {}
  for (const binding of config.projectBindings) {
    if (binding.container.provider !== 'github' || binding.container.instance !== 'github.com') {
      throw new Error(
        `unsupported active ProjectBinding provider: ${binding.container.provider}@${binding.container.instance}`,
      )
    }
    const verified = await verifyProjectBindingRepository(binding)
    repos[binding.container.id] = verified.localPath
  }
  return {
    schemaVersion: 1,
    repos,
    worktreeRoot: config.worktreeRoot,
    fetchTtlSeconds: config.fetchTtlSeconds,
    diagnosticsMaxBytes: config.diagnosticsMaxBytes,
  }
}

/** Read config for an explicit home; schema-1 requires a verified config/state pair. */
export async function loadConfigFromHome(home: string): Promise<ClickVibeConfig> {
  const path = join(home, '.clickvibe', 'config.yaml')
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code !== 'ENOENT') throw reason
    return {
      repos: {},
      worktreeRoot: join(home, '.clickvibe', 'worktrees'),
      fetchTtlSeconds: DEFAULT_FETCH_TTL_SECONDS,
    }
  }
  const parsed = parseYaml(raw) as (Partial<ClickVibeConfig> & { schemaVersion?: unknown }) | null
  // Only the config file's own ENOENT selects defaults. Any schema-1 pairing
  // error (missing journal/marker included) is an explicit fail-closed error.
  if (parsed?.schemaVersion === 1) return await loadV02Config(home, raw, parsed)
  if (parsed?.schemaVersion !== undefined)
    throw new Error(`unsupported ClickVibe config schemaVersion: ${parsed.schemaVersion}`)
  throw new Error(
    'v0.1 config is no longer readable by the v0.2 runtime (ADR-0009 clean break); run `node scripts/upgrade-v0.2.mjs preview` and authorize the upgrade with its plan fingerprint',
  )
}

/** Read and strictly validate ~/.clickvibe/config.yaml. */
export function loadConfig(): Promise<ClickVibeConfig> {
  return loadConfigFromHome(homedir())
}

/** Extract owner/repo and issue number from a GitHub issue/PR URL. */
export function parseUrl(url: string): { kind: 'issue' | 'pr'; owner: string; repo: string; number: string } | null {
  return parseGithubUrl(url)
}

export function privilegedRequestError(req: IncomingMessage): string | null {
  return validatePrivilegedRequest({
    remoteAddress: req.socket.remoteAddress,
    host: req.headers.host,
    origin: req.headers.origin,
    requestMarker: req.headers['x-clickvibe-request'],
  })
}

export function authorizationInputFromPayload(
  action: AgentAuthorizationInput['action'],
  payload: unknown,
): AgentAuthorizationInput {
  const body = (payload ?? {}) as {
    url?: unknown
    agent?: unknown
    context?: unknown
    baseline?: unknown
    target?: unknown
    restoreTarget?: unknown
    override?: unknown
    autoRun?: unknown
    freshSession?: unknown
  }
  return makeAuthorizationInput({ ...body, action })
}

export function consumeAuthorization(
  action: AgentAuthorizationInput['action'],
  payload: unknown,
): AgentAuthorization | null {
  const body = (payload ?? {}) as { authorizationId?: unknown; authorizationDigest?: unknown }
  const input = authorizationInputFromPayload(action, payload)
  return authorizations.consume(String(body.authorizationId ?? ''), input, String(body.authorizationDigest ?? ''))
}

/** Read the (bounded) JSON request body. */
export function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      try {
        resolve(raw === '' ? {} : JSON.parse(raw))
      } catch {
        reject(new Error('malformed JSON body'))
      }
    })
    req.on('error', reject)
  })
}

/** Write a JSON response with the given status. */
export function writeJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

export function githubAwareStatus(result: { ok: boolean; error?: string }, success = 200, failure = 400): number {
  if (result.ok) return success
  return result.error?.startsWith('GitHub 额度已用完,约 ') ? 429 : failure
}

/** Run one foreground command; returns trimmed stdout or throws on non-zero. */
export async function runCommand(
  ctx: Context,
  command: string,
  options: {
    workdir?: string
    stdin?: string
    timeoutMs?: number
    sandboxPolicy?: { mode: 'read-only' | 'workspace-write' | 'danger-full-access'; workspaceRoot: string }
  } = {},
): Promise<string> {
  const spec = ctx.shell.resolve({
    command,
    workdir: options.workdir,
    stdin: options.stdin,
    timeoutMs: options.timeoutMs ?? 30000,
    sandboxPolicy: options.sandboxPolicy,
  })
  const result = await ctx.shell.run(spec)
  // stdout 超限时内存只保留尾部;有 spill 文件则读全文,否则明确报错而不是返回垃圾。
  // 注:插件可见的 shell 类型只声明 {text},运行时才有 truncated/spillPath,做宽断言。
  const out = result.stdout as { text: string; truncated?: boolean; spillPath?: string }
  if (result.exitCode !== 0) {
    // merge 等 Git 命令把 CONFLICT/文件提示打到 stdout,只拼 stderr 会丢冲突详情
    const stderr = result.stderr?.text?.trim() ?? ''
    const stdout = out.text.trim()
    const detail = [stderr, stdout].filter(Boolean).join('\n')
    throw new Error(`命令退出码 ${result.exitCode}${detail ? `: ${detail}` : ''}`)
  }
  if (out.truncated) {
    if (out.spillPath) {
      return (await readFile(out.spillPath, 'utf8')).trim()
    }
    throw new Error(`命令输出超过上限且无 spill 文件,无法获取完整输出`)
  }
  return out.text.trim()
}

/** Read a host subprocess spill file: the byte-complete stream beyond the in-memory cap. */
export async function readHostSpillFile(path: string): Promise<string> {
  return readFile(path, 'utf8')
}

export function fetchTtlMs(config: ClickVibeConfig): number {
  const seconds = Number(config.fetchTtlSeconds ?? DEFAULT_FETCH_TTL_SECONDS)
  return Math.min(60, Math.max(30, Number.isFinite(seconds) ? seconds : DEFAULT_FETCH_TTL_SECONDS)) * 1000
}

export async function ensureConfiguredRepoFresh(
  ctx: Context,
  config: ClickVibeConfig,
  repoKey: string,
  force = false,
): Promise<RepositoryFreshness | null> {
  const configuredPath = config.repos[repoKey]
  if (!configuredPath) return null
  const repoPath = resolve(expandHome(configuredPath))
  if (!existsSync(repoPath)) return null
  return ensureRemoteFresh({
    repoKey,
    ttlMs: fetchTtlMs(config),
    waitMs: READ_FETCH_WAIT_MS,
    force,
    refresh: async () => {
      await remoteFetch(ctx, {
        repoKey,
        workdir: repoPath,
        timeoutMs: 60_000,
        sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: repoPath },
      })
    },
  })
}

/** Read the current HEAD short-hash of a worktree (empty string on failure). */
export async function readWorktreeHead(ctx: Context, worktree: string): Promise<string | null> {
  try {
    const spec = ctx.shell.resolve({
      command: 'git rev-parse --short HEAD',
      workdir: worktree,
      timeoutMs: 10000,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: worktree },
    })
    const result = await ctx.shell.run(spec)
    if (result.exitCode !== 0) return null
    return result.stdout.text.trim() || null
  } catch {
    return null
  }
}
