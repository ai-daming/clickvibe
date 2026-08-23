import { randomBytes } from 'node:crypto'
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
 * - `/clickvibe/api/resume`         — resume an interrupted dev session
 * - `/clickvibe/api/sync`           — sync the worktree with the remote base (issue #5)
 *
 * Workflow per issue (persisted under ~/.clickvibe/state/):
 *   developing → review-ready → reviewing → passed
 *                      ↑                  │
 *                      └── rework ────────┘
 */
import type { Context } from '@deepseek-ai/cordis'
import { parse as parseYaml } from 'yaml'
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
import { type RepositoryFreshness, RepositoryFreshnessGate, RepositoryRefreshClock } from './repo-freshness.ts'
import { ExclusiveTaskGate } from './task-gate.ts'
import type { IssueWorkflow } from './state.ts'

const MAX_BODY_BYTES = 64 * 1024

export interface ClickVibeConfig {
  repos: Record<string, string>
  worktreeRoot: string
  /** Remote-ref refresh interval for read paths. Clamped to 30-60 seconds. */
  fetchTtlSeconds?: number
}

export const DEFAULT_FETCH_TTL_SECONDS = 45

export const READ_FETCH_WAIT_MS = 2_000

export const repositoryFreshness = new RepositoryFreshnessGate()

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

/** Read and parse ~/.clickvibe/config.yaml; missing/invalid yields a default. */
export async function loadConfig(): Promise<ClickVibeConfig> {
  const path = join(homedir(), '.clickvibe', 'config.yaml')
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = parseYaml(raw) as Partial<ClickVibeConfig> | null
    return {
      repos: parsed?.repos ?? {},
      worktreeRoot: parsed?.worktreeRoot ? expandHome(parsed.worktreeRoot) : join(homedir(), '.clickvibe', 'worktrees'),
      fetchTtlSeconds: parsed?.fetchTtlSeconds,
    }
  } catch {
    return {
      repos: {},
      worktreeRoot: join(homedir(), '.clickvibe', 'worktrees'),
      fetchTtlSeconds: DEFAULT_FETCH_TTL_SECONDS,
    }
  }
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
    freshSession?: unknown
    target?: unknown
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
    // git merge 等命令把 CONFLICT/文件提示打到 stdout,只拼 stderr 会丢冲突详情
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
  return repositoryFreshness.ensureWithin(
    repoPath,
    fetchTtlMs(config),
    async () => {
      await runCommand(ctx, 'git fetch origin --prune', {
        workdir: repoPath,
        timeoutMs: 30_000,
        sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: repoPath },
      })
    },
    READ_FETCH_WAIT_MS,
    force,
  )
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
