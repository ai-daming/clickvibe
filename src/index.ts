/**
 * clickvibe host half — routes:
 * - `/clickvibe/api/fetch`          — fetch GitHub issue/PR data via gh
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
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename, dirname, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
  AuthorizationStore,
  LineLog,
  buildFreshAgentCommand,
  buildResumeAgentCommand,
  buildWorktreeAddCommand,
  decideWorktreeRecovery,
  isLoopbackAddress,
  makeAuthorizationInput,
  parseAgent,
  parseDependencies,
  parseGithubUrl,
  shellQuote,
  shouldFallbackFromExactResume,
  validatePrivilegedRequest,
  type AgentAuthorization,
  type AgentAuthorizationInput,
  type DevelopAgent,
  type IssuePromptSnapshot,
} from './develop.ts'
import { deriveNextAction, deriveWorkflowStatus, workflowBaseBranch, type NextAction, type WorkflowFacts } from './state-view.ts'
import {
  appendEvent,
  appendLog,
  applyDevRunOutcome,
  clearStaleSessionId,
  issueKey,
  loadAllWorkflows,
  loadWorkflow,
  readLogHistory,
  readLogTail,
  recordSessionId,
  resetLog,
  resolveSessionForAgent,
  saveWorkflow,
  type IssueWorkflow,
  type WorkflowEvent,
} from './state.ts'
import { buildDevComment, buildReviewComment } from './delivery-comment.ts'
import { extractGithubCommentUrl } from './delivery-publication.ts'
import { parseAgentChunk, type AgentKind } from './agent-stream.ts'
import {
  clearReviewResultFile,
  loadReviewResult,
  REVIEW_RESULT_RELATIVE_PATH,
} from './review-result.ts'
import { ExclusiveTaskGate } from './task-gate.ts'
import {
  buildStagePrompt,
  selectReviewFeedback,
  type PromptSnapshot,
  type SnapshotFreshness,
} from './prompt.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: {
      register(route: {
        kind: 'exact' | 'prefix'
        path: string
        handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
      }): () => void
    }
    shell: {
      resolve(request: {
        command: string
        timeoutMs?: number
        workdir?: string
        stdin?: string
        sandboxPolicy?: { mode: 'read-only' | 'workspace-write' | 'danger-full-access'; workspaceRoot: string }
      }): unknown
      run(spec: unknown): Promise<{
        exitCode: number | null
        stdout: { text: string }
        stderr?: { text?: string }
      }>
      start(spec: unknown): {
        status: string
        exitCode: number | null
        readonly done: Promise<void>
        readOutput(): { delta: string; lossy: boolean }
        kill(): boolean
      }
    }
  }
}

/** Prefix route owning every /clickvibe/api/<method> request. */
const ROUTE = '/clickvibe/api'

/** Body size bound of one JSON request. */
const MAX_BODY_BYTES = 64 * 1024

/** Fields the issue fetch requests from gh (verified against rc.8). */
const ISSUE_FIELDS = [
  'number', 'title', 'state', 'stateReason', 'author', 'createdAt',
  'updatedAt', 'closedAt', 'body', 'url', 'labels', 'assignees',
  'milestone', 'comments', 'reactionGroups', 'isPinned',
].join(',')

/** Fields the PR fetch requests from gh (verified against rc.8). */
const PR_FIELDS = [
  'number', 'title', 'state', 'author', 'createdAt', 'updatedAt',
  'closedAt', 'mergedAt', 'body', 'url', 'labels', 'assignees',
  'milestone', 'additions', 'deletions', 'changedFiles', 'commits',
  'isDraft', 'mergeable', 'mergeStateStatus', 'baseRefName',
  'headRefName', 'reviews', 'reviewRequests', 'comments',
].join(',')

interface ClickVibeConfig {
  repos: Record<string, string>
  worktreeRoot: string
}

/** In-memory live task handle: the running process + a status-line buffer. */
interface LiveTask {
  taskId: string
  workflowKey: string
  kind: 'dev' | 'review'
  agent: DevelopAgent
  process?: ReturnType<Context['shell']['start']>
  log: LineLog
  rawLog: LineLog
  rawCursor: number
  closed: boolean
  status: 'running' | 'done' | 'failed' | 'stopped' | 'timed_out'
  exitCode: number | null
  timeout?: ReturnType<typeof setTimeout>
  cleanup?: ReturnType<typeof setTimeout>
  sessionId: string | null // 从事件流捕获的 agent 会话 id(续会话用)
}

const liveTasks = new Map<string, LiveTask>()
const reviewTaskGate = new ExclusiveTaskGate<LiveTask>()
const resumeTaskGate = new ExclusiveTaskGate<LiveTask>()
const liveWaiters = new Map<string, Set<() => void>>()
const authorizations = new AuthorizationStore()
const TASK_LOG_LINES = 2000
const TASK_TIMEOUT_MS = 24 * 60 * 60_000
const TASK_RETENTION_MS = 5 * 60_000
const MAX_TASKS = 64

function taskId(prefix: string): string {
  return `${prefix}-${Date.now()}-${randomBytes(12).toString('base64url')}`
}

/** Notify SSE waiters that new lines are available for a task. */
function notifyTask(taskId: string): void {
  const waiters = liveWaiters.get(taskId)
  if (waiters) for (const fn of waiters) fn()
}

/** Expand a leading `~` in a path to the user's home directory. */
function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

/** Read and parse ~/.clickvibe/config.yaml; missing/invalid yields a default. */
async function loadConfig(): Promise<ClickVibeConfig> {
  const path = join(homedir(), '.clickvibe', 'config.yaml')
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = parseYaml(raw) as Partial<ClickVibeConfig> | null
    return {
      repos: parsed?.repos ?? {},
      worktreeRoot: parsed?.worktreeRoot ? expandHome(parsed.worktreeRoot) : join(homedir(), '.clickvibe', 'worktrees'),
    }
  } catch {
    return {
      repos: {},
      worktreeRoot: join(homedir(), '.clickvibe', 'worktrees'),
    }
  }
}

/** Extract owner/repo and issue number from a GitHub issue/PR URL. */
function parseUrl(url: string): { kind: 'issue' | 'pr'; owner: string; repo: string; number: string } | null {
  return parseGithubUrl(url)
}

function privilegedRequestError(req: IncomingMessage): string | null {
  return validatePrivilegedRequest({
    remoteAddress: req.socket.remoteAddress,
    host: req.headers.host,
    origin: req.headers.origin,
    requestMarker: req.headers['x-clickvibe-request'],
  })
}

function authorizationInputFromPayload(
  action: AgentAuthorizationInput['action'],
  payload: unknown,
): AgentAuthorizationInput {
  const body = (payload ?? {}) as { url?: unknown; agent?: unknown; context?: unknown }
  return makeAuthorizationInput({ ...body, action })
}

function consumeAuthorization(
  action: AgentAuthorizationInput['action'],
  payload: unknown,
): AgentAuthorization | null {
  const body = (payload ?? {}) as { authorizationId?: unknown; authorizationDigest?: unknown }
  const input = authorizationInputFromPayload(action, payload)
  return authorizations.consume(
    String(body.authorizationId ?? ''),
    input,
    String(body.authorizationDigest ?? ''),
  )
}

/** Read the (bounded) JSON request body. */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
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
function writeJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** Run one foreground command; returns trimmed stdout or throws on non-zero. */
async function runCommand(
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

/** Read the current HEAD short-hash of a worktree (empty string on failure). */
async function readWorktreeHead(ctx: Context, worktree: string): Promise<string | null> {
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

/**
 * Detect the PR opened from a branch (via gh). Returns the PR number or null.
 */
async function detectLinkedPr(ctx: Context, repoKey: string, branch: string): Promise<string | null> {
  try {
    const spec = ctx.shell.resolve({
      command: `gh pr list --repo ${repoKey} --head ${shellQuote(branch)} --state open --json number --jq '.[0].number // ""'`,
      timeoutMs: 15000,
    })
    const result = await ctx.shell.run(spec)
    if (result.exitCode !== 0) return null
    const num = result.stdout.text.trim()
    return num === '' ? null : num
  } catch {
    return null
  }
}

/** Result of one ahead/behind comparison (commits of one ref relative to another). */
interface GitCompare {
  behind: number
  ahead: number
}

/** Worktree facts the authoritative state view derives on every /state request. */
interface WorkflowDerived {
  head: string | null
  branch: string | null
  mainHead: string | null
  originMainHead: string | null
  upstreamHead: string | null
  aheadOfMain: number
  behindMain: number
  aheadOfBase: number
  behindBase: number
  aheadOfUpstream: number | null
  behindUpstream: number | null
  needsSync: boolean
  /** Worktree sits in an unresolved conflicted merge (MERGE_HEAD exists). */
  mergeConflict: boolean
  lastDevHash: string | null
  lastReviewHash: string | null
  reviewedHash: string | null
  hasNewCommits: boolean
  verdictCurrent: boolean
  nextAction: NextAction
  status: 'idle' | 'developing' | 'review-ready' | 'reviewing' | 'passed'
  baseBranch: string
}

interface GithubPrFact {
  number: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  mergedAt: string | null
  headRefName: string
  url: string
  reviewDecision: string | null
}

interface DeriveOptions {
  pr?: GithubPrFact | null
  prStatusKnown?: boolean
  branchExists?: boolean
  hasCommits?: boolean
  defaultBranch?: string
}

/** Short hash of one ref inside the worktree's repo (null when unresolvable). */
async function readRefShort(ctx: Context, workdir: string, ref: string): Promise<string | null> {
  try {
    const spec = ctx.shell.resolve({
      command: `git rev-parse --short ${shellQuote(ref)}`,
      workdir,
      timeoutMs: 10000,
      sandboxPolicy: { mode: 'read-only', workspaceRoot: workdir },
    })
    const result = await ctx.shell.run(spec)
    if (result.exitCode !== 0) return null
    const out = result.stdout.text.trim()
    return out === '' ? null : out
  } catch {
    return null
  }
}

/** Current branch of the worktree (null when detached or missing). */
async function readBranch(ctx: Context, workdir: string): Promise<string | null> {
  try {
    const spec = ctx.shell.resolve({
      command: 'git branch --show-current',
      workdir,
      timeoutMs: 10000,
      sandboxPolicy: { mode: 'read-only', workspaceRoot: workdir },
    })
    const result = await ctx.shell.run(spec)
    if (result.exitCode !== 0) return null
    const out = result.stdout.text.trim()
    return out === '' ? null : out
  } catch {
    return null
  }
}

/** Ahead/behind of `right` relative to `left` (commits in left but not in right = behind). */
async function readRevCount(ctx: Context, workdir: string, left: string, right: string): Promise<GitCompare | null> {
  try {
    const spec = ctx.shell.resolve({
      command: `git rev-list --left-right --count ${shellQuote(left)}...${shellQuote(right)}`,
      workdir,
      timeoutMs: 10000,
      sandboxPolicy: { mode: 'read-only', workspaceRoot: workdir },
    })
    const result = await ctx.shell.run(spec)
    if (result.exitCode !== 0) return null
    const [behind, ahead] = result.stdout.text.trim().split(/\s+/).map(Number)
    if (!Number.isFinite(behind) || !Number.isFinite(ahead)) return null
    return { behind, ahead }
  } catch {
    return null
  }
}

/** True when the worktree sits in an unresolved conflicted merge (MERGE_HEAD exists). */
async function hasMergeConflict(ctx: Context, workdir: string): Promise<boolean> {
  return (await readRefShort(ctx, workdir, 'MERGE_HEAD')) !== null
}

/** List unresolved conflict files (git diff --name-only --diff-filter=U).
 *  Empty when none or unreadable — callers treat it as best-effort detail. */
async function listConflictFiles(ctx: Context, workdir: string): Promise<string[]> {
  try {
    const output = await runCommand(ctx, 'git diff --name-only --diff-filter=U', {
      workdir,
      timeoutMs: 10000,
      sandboxPolicy: { mode: 'read-only', workspaceRoot: workdir },
    })
    return output.split('\n').map((line) => line.trim()).filter(Boolean)
  } catch {
    return []
  }
}

/** Format a conflict-file list as a readable suffix (";冲突文件:a、b"), '' when none. */
function conflictFileSuffix(files: string[]): string {
  return files.length > 0 ? `;冲突文件:${files.join('、')}` : ''
}

/** Preface instruction for resume/rework agents when the worktree is not on the
 *  latest base: merge origin/<base> (and resolve any conflict) before continuing
 *  (issue #26). Empty when the worktree is already up to date. */
export async function buildMergePreface(ctx: Context, worktree: string, baseBranch: string): Promise<string> {
  if (await hasMergeConflict(ctx, worktree)) {
    const files = await listConflictFiles(ctx, worktree)
    return `注意:worktree 里有一次未完成的合并(origin/${baseBranch})冲突${conflictFileSuffix(files)}。请先用 git status 查看冲突文件,解决全部冲突并完成 git commit,然后再继续后续任务。`
  }
  const compare = await readRevCount(ctx, worktree, `origin/${baseBranch}`, 'HEAD')
  if (compare && compare.behind > 0) {
    return `注意:本地分支落后 origin/${baseBranch}。请先执行 git merge --no-edit origin/${baseBranch}(如有冲突,解决后完成提交),然后再继续后续任务。`
  }
  return ''
}

/**
 * Derive the authoritative state of a workflow from git facts + event history
 * (issue #5). Runs on every /state request so the panel never needs a
 * restart/refresh to see current status; the stored `stage`/`reviewResult`
 * stay as-is, and `derived` carries the three-way comparison (worktree /
 * main / remote), the review-verdict HEAD binding and the single next action.
 */
/** Derive the authoritative state of a workflow from git facts + event history.
 *  Exported for integration tests; /state calls it on every request. */
export async function deriveWorkflowState(
  ctx: Context,
  workflow: IssueWorkflow,
  options: DeriveOptions = {},
): Promise<IssueWorkflow & { derived: WorkflowDerived }> {
  const workflowPrNumber = workflow.prNumber == null ? null : String(workflow.prNumber)
  const worktree = workflow.worktree
  const exists = existsSync(worktree)
  const events = workflow.events ?? []
  let lastDevHash: string | null = null
  let lastReviewHash: string | null = null
  for (const ev of events) {
    if (ev.kind === 'dev' || ev.kind === 'rework') lastDevHash = ev.hash ?? lastDevHash
    if (ev.kind === 'review') lastReviewHash = ev.hash ?? lastReviewHash
  }

  const head = exists ? await readWorktreeHead(ctx, worktree) : null
  const branch = exists ? await readBranch(ctx, worktree) : null
  const hasUncommittedChanges = exists
    ? await runCommand(ctx, 'git status --porcelain', {
        workdir: worktree,
        timeoutMs: 10000,
        sandboxPolicy: { mode: 'read-only', workspaceRoot: worktree },
      }).then((output) => output !== '').catch(() => false)
    : false

  let mainHead: string | null = null
  let aheadOfMain = 0
  let behindMain = 0
  let originMainHead: string | null = null
  let aheadOfBase = 0
  let behindBase = 0
  let upstreamHead: string | null = null
  let aheadOfUpstream: number | null = null
  let behindUpstream: number | null = null

  if (exists && head !== null) {
    mainHead = await readRefShort(ctx, worktree, 'main')
    if (mainHead) {
      const compare = await readRevCount(ctx, worktree, 'main', 'HEAD')
      if (compare) { behindMain = compare.behind; aheadOfMain = compare.ahead }
    }
    originMainHead = await readRefShort(ctx, worktree, 'origin/main')
    if (originMainHead) {
      const compare = await readRevCount(ctx, worktree, 'origin/main', 'HEAD')
      if (compare) { behindBase = compare.behind; aheadOfBase = compare.ahead }
    }
    if (branch) {
      upstreamHead = await readRefShort(ctx, worktree, `origin/${branch}`)
      if (upstreamHead) {
        const compare = await readRevCount(ctx, worktree, `origin/${branch}`, 'HEAD')
        if (compare) { behindUpstream = compare.behind; aheadOfUpstream = compare.ahead }
      }
    }
  }

  // 有新提交 = worktree HEAD 不在已记录的任何 dev/rework 事件哈希里
  const hasNewCommits = head !== null && lastDevHash !== null && head !== lastDevHash
  // worktree 落后远端基线(origin/main 或远端同名分支)→ 需要同步
  const needsSync = behindBase > 0 || (behindUpstream ?? 0) > 0
  // 未完成的冲突合并(MERGE_HEAD 存在):sync 只会再次失败,必须由 agent 收拾(issue #26)
  const mergeConflict = exists && await hasMergeConflict(ctx, worktree)
  const githubReviewPassed = options.pr?.reviewDecision === 'APPROVED'
    ? true
    : options.pr?.reviewDecision === 'CHANGES_REQUESTED'
      ? false
      : null
  const reviewPassed = workflow.reviewResult?.passed ?? githubReviewPassed
  const reviewedHash = lastReviewHash ?? (githubReviewPassed !== null ? head : null)
  // 结论仍针对当前 HEAD 才算数;HEAD 变化后旧结论不冒充当前状态
  const verdictCurrent = reviewPassed !== null && head !== null && reviewedHash !== null && head === reviewedHash

  const devLive = workflow.devTaskId ? liveTasks.get(workflow.devTaskId) : undefined
  const reviewLive = workflow.reviewTaskId ? liveTasks.get(workflow.reviewTaskId) : undefined
  const taskRunning = (devLive !== undefined && !devLive.closed) || (reviewLive !== undefined && !reviewLive.closed)

  const facts: WorkflowFacts = {
    issueOpen: (workflow.issueState ?? 'OPEN') !== 'CLOSED',
    prMerged: options.pr?.state === 'MERGED' || options.pr?.mergedAt !== null && options.pr?.mergedAt !== undefined,
    prState: options.pr?.state ?? null,
    prStatusKnown: options.prStatusKnown,
    prNumber: options.pr?.number ?? workflowPrNumber,
    stage: workflow.stage,
    devInterrupted: workflow.devInterrupted,
    taskRunning,
    head,
    reviewedHash,
    reviewPassed,
    hasNewCommits,
    needsSync,
    mergeConflict,
    branchExists: options.branchExists ?? branch !== null,
    worktreeExists: exists,
    worktreeValid: !exists || branch === workflow.branch,
    hasUncommittedChanges,
    hasCommits: options.hasCommits ?? aheadOfBase > 0,
    hasResumeSession: workflow.devSessionId !== null,
  }
  const nextAction = deriveNextAction(facts)
  const baseBranch = workflowBaseBranch(workflow.baseRef, options.defaultBranch ?? 'main')
  const status = deriveWorkflowStatus(facts)

  return {
    ...workflow,
    prNumber: options.pr?.number ?? workflowPrNumber,
    derived: {
      head,
      branch,
      mainHead,
      originMainHead,
      upstreamHead,
      aheadOfMain,
      behindMain,
      aheadOfBase,
      behindBase,
      aheadOfUpstream,
      behindUpstream,
      needsSync,
      mergeConflict,
      lastDevHash,
      lastReviewHash,
      reviewedHash,
      hasNewCommits,
      verdictCurrent,
      nextAction,
      status,
      baseBranch,
    },
  }
}
export const name = 'clickvibe'

export const inject = ['webServer', 'shell']

export function apply(ctx: Context): void {
  ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST' && req.method !== 'GET') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://clickvibe.internal').pathname
      const method = pathname.startsWith(`${ROUTE}/`) ? pathname.slice(`${ROUTE}/`.length) : undefined
      const knownMethods = new Set(['fetch', 'projects', 'repo/issues', 'state', 'authorize', 'develop', 'develop/poll', 'history', 'stream', 'review', 'resume', 'stop', 'sync'])
      if (method === undefined || !knownMethods.has(method)) {
        writeJson(res, 404, { ok: false, error: 'unknown method' })
        return
      }

      // SSE stream endpoint (GET)
      if (method === 'stream') {
        if (req.method !== 'GET') {
          writeJson(res, 405, { ok: false, error: 'stream requires GET' })
          return
        }
        handleStream(req, res)
        return
      }

      if (method === 'history') {
        if (req.method !== 'GET') {
          writeJson(res, 405, { ok: false, error: 'history requires GET' })
          return
        }
        const result = await getTaskHistory(req)
        writeJson(res, result.ok ? 200 : 404, result)
        return
      }

      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }

      // JSON POST endpoints
      let payload: unknown
      try {
        payload = await readJsonBody(req)
      } catch (error) {
        writeJson(res, 400, { ok: false, error: String(error instanceof Error ? error.message : error) })
        return
      }

      if (method === 'fetch') {
        const result = await fetchIssue(ctx, payload)
        writeJson(res, result.ok ? 200 : 400, result)
        return
      }
      if (method === 'projects') {
        const result = await listProjects()
        writeJson(res, 200, result)
        return
      }
      if (method === 'repo/issues') {
        const result = await fetchRepositoryIssues(ctx, payload)
        writeJson(res, result.ok ? 200 : 400, result)
        return
      }
      if (method === 'state') {
        const filter = payload as { url?: unknown; repoKey?: unknown } | undefined
        const url = String(filter?.url ?? '')
        const repoKey = String(filter?.repoKey ?? '')
        const workflows = (await loadAllWorkflows()).filter((workflow) =>
          (url === '' || workflow.url === url) && (repoKey === '' || workflow.repoKey === repoKey),
        )
        const enriched = await enrichWorkflowStates(ctx, workflows)
        writeJson(res, 200, { ok: true, workflows: enriched })
        return
      }
      if (method === 'authorize') {
        const securityError = privilegedRequestError(req)
        if (securityError) {
          writeJson(res, 403, { ok: false, error: securityError })
          return
        }
        const result = await authorizeAgent(ctx, payload)
        writeJson(res, result.ok ? 200 : 400, result)
        return
      }
      if (method === 'develop') {
        let authorization: AgentAuthorization | null = null
        try {
          const requestedAgent = parseAgent((payload as { agent?: unknown } | undefined)?.agent)
          if (requestedAgent === 'dryrun') {
            if (!isLoopbackAddress(req.socket.remoteAddress)) {
              writeJson(res, 403, { ok: false, error: 'dryrun 仅允许本机回环地址触发' })
              return
            }
          } else {
            const securityError = privilegedRequestError(req)
            if (securityError) {
              writeJson(res, 403, { ok: false, error: securityError })
              return
            }
            authorization = consumeAuthorization('develop', payload)
            if (!authorization) {
              writeJson(res, 403, { ok: false, error: 'Agent 授权无效、已使用或已过期,请重新预览确认' })
              return
            }
          }
        } catch (error) {
          writeJson(res, 400, { ok: false, error: String(error instanceof Error ? error.message : error) })
          return
        }
        const result = await startDevelop(ctx, payload, authorization?.snapshot ?? null)
        writeJson(res, result.ok ? 200 : 400, result)
        return
      }
      if (method === 'develop/poll') {
        const result = await pollDevelop(payload)
        writeJson(res, result.ok ? 200 : 400, result)
        return
      }
      if (method === 'review') {
        const securityError = privilegedRequestError(req)
        if (securityError) {
          writeJson(res, 403, { ok: false, error: securityError })
          return
        }
        try {
          if (!consumeAuthorization('review', payload)) {
            writeJson(res, 403, { ok: false, error: 'Agent 授权无效、已使用或已过期,请重新确认' })
            return
          }
        } catch (error) {
          writeJson(res, 400, { ok: false, error: String(error instanceof Error ? error.message : error) })
          return
        }
        const result = await startReview(ctx, payload)
        writeJson(res, result.ok ? 200 : 400, result)
        return
      }
      if (method === 'resume') {
        const securityError = privilegedRequestError(req)
        if (securityError) {
          writeJson(res, 403, { ok: false, error: securityError })
          return
        }
        try {
          if (!consumeAuthorization('resume', payload)) {
            writeJson(res, 403, { ok: false, error: 'Agent 授权无效、已使用或已过期,请重新确认' })
            return
          }
        } catch (error) {
          writeJson(res, 400, { ok: false, error: String(error instanceof Error ? error.message : error) })
          return
        }
        const result = await resumeDevelop(ctx, payload)
        writeJson(res, result.ok ? 200 : 400, result)
        return
      }
      if (method === 'stop') {
        const securityError = privilegedRequestError(req)
        if (securityError) {
          writeJson(res, 403, { ok: false, error: securityError })
          return
        }
        const result = stopTask(payload)
        writeJson(res, result.ok ? 200 : 400, result)
        return
      }
      if (method === 'sync') {
        const securityError = privilegedRequestError(req)
        if (securityError) {
          writeJson(res, 403, { ok: false, error: securityError })
          return
        }
        const result = await syncWorktree(ctx, payload)
        writeJson(res, result.ok ? 200 : 400, result)
        return
      }

      writeJson(res, 404, { ok: false, error: `unknown method "${method}"` })
    },
  })
}

async function listProjects(): Promise<{ ok: true; projects: { repoKey: string; path: string; available: boolean }[] }> {
  const config = await loadConfig()
  return {
    ok: true,
    projects: Object.entries(config.repos)
      .map(([repoKey, path]) => ({ repoKey, path: expandHome(path), available: existsSync(expandHome(path)) }))
      .sort((a, b) => a.repoKey.localeCompare(b.repoKey)),
  }
}

interface GithubPrLookup {
  known: boolean
  pr: GithubPrFact | null
}

async function fetchGithubPrFact(
  ctx: Context,
  repoKey: string,
  branch: string,
  prNumber: string | number | null,
): Promise<GithubPrLookup> {
  const hasPrNumber = prNumber !== null && prNumber !== undefined
  const selector = hasPrNumber ? shellQuote(String(prNumber)) : `--head ${shellQuote(branch)} --state all --limit 1`
  const command = hasPrNumber
    ? `gh pr view ${selector} --repo ${shellQuote(repoKey)} --json number,state,mergedAt,headRefName,url,reviewDecision`
    : `gh pr list --repo ${shellQuote(repoKey)} ${selector} --json number,state,mergedAt,headRefName,url,reviewDecision --jq '.[0] // {}'`
  try {
    const output = await runCommand(ctx, command, { timeoutMs: 5000 })
    const raw = JSON.parse(output || '{}') as Partial<GithubPrFact> & { number?: number | string }
    if (raw.number === undefined) return { known: true, pr: null }
    return {
      known: true,
      pr: {
        number: String(raw.number),
        state: raw.state === 'MERGED' ? 'MERGED' : raw.state === 'CLOSED' ? 'CLOSED' : 'OPEN',
        mergedAt: raw.mergedAt ?? null,
        headRefName: String(raw.headRefName ?? branch),
        url: String(raw.url ?? `https://github.com/${repoKey}/pull/${raw.number}`),
        reviewDecision: raw.reviewDecision ?? null,
      },
    }
  } catch {
    return { known: false, pr: null }
  }
}

async function readConfiguredBranchFacts(
  ctx: Context,
  config: ClickVibeConfig,
  workflow: IssueWorkflow,
): Promise<{ branchExists?: boolean; hasCommits?: boolean; defaultBranch?: string }> {
  const configuredPath = config.repos[workflow.repoKey]
  if (!configuredPath) return {}
  const repoPath = expandHome(configuredPath)
  if (!existsSync(repoPath)) return {}
  const policy = { mode: 'read-only' as const, workspaceRoot: repoPath }
  const localRef = `refs/heads/${workflow.branch}`
  const remoteRef = `refs/remotes/origin/${workflow.branch}`
  const branchRef = await runCommand(ctx,
    `if git show-ref --verify --quiet ${shellQuote(localRef)}; then printf %s ${shellQuote(workflow.branch)}; elif git show-ref --verify --quiet ${shellQuote(remoteRef)}; then printf %s ${shellQuote(`origin/${workflow.branch}`)}; else exit 1; fi`,
    { workdir: repoPath, timeoutMs: 3000, sandboxPolicy: policy },
  ).catch(() => '')
  const defaultRef = await runCommand(ctx, 'git symbolic-ref --quiet --short refs/remotes/origin/HEAD', {
    workdir: repoPath, timeoutMs: 3000, sandboxPolicy: policy,
  }).catch(() => '')
  if (!branchRef) return { branchExists: false, defaultBranch: defaultRef.replace(/^origin\//, '') || undefined }
  const baseRef = defaultRef || 'origin/main'
  const hasCommits = await runCommand(ctx, `git rev-list --count ${shellQuote(baseRef)}..${shellQuote(branchRef)}`, {
    workdir: repoPath, timeoutMs: 3000, sandboxPolicy: policy,
  }).then((count) => Number(count) > 0).catch(() => false)
  return { branchExists: true, hasCommits, defaultBranch: defaultRef.replace(/^origin\//, '') || undefined }
}

/** Enrich every stored workflow concurrently; one unreachable GitHub call costs at most one 5s window. */
export async function enrichWorkflowStates(
  ctx: Context,
  workflows: IssueWorkflow[],
  configOverride?: ClickVibeConfig,
): Promise<Array<IssueWorkflow & { derived: WorkflowDerived }>> {
  const config = configOverride ?? await loadConfig()
  return Promise.all(workflows.map(async (workflow) => {
    const [prLookup, branchFacts] = await Promise.all([
      fetchGithubPrFact(ctx, workflow.repoKey, workflow.branch, workflow.prNumber),
      readConfiguredBranchFacts(ctx, config, workflow),
    ])
    return deriveWorkflowState(ctx, workflow, {
      pr: prLookup.pr,
      prStatusKnown: workflow.prNumber ? prLookup.known && prLookup.pr !== null : prLookup.known,
      ...branchFacts,
    })
  }))
}

interface RepositoryIssueItem {
  number: number
  title: string
  state: string
  body: string
  url: string
  updatedAt?: string
  labels?: { name: string; color?: string }[]
  milestone?: { title: string; number?: number } | null
}

interface RepositoryIssueRest {
  number: number
  title: string
  state: string
  body: string | null
  html_url: string
  updated_at?: string
  labels?: { name: string; color?: string }[]
  milestone?: { title: string; number?: number } | null
  pull_request?: unknown
}

interface RepositoryPrRest {
  number: number
  state: string
  merged_at: string | null
  html_url: string
  head?: { ref?: string }
}

function flattenGithubPages<T>(value: unknown): T[] {
  if (!Array.isArray(value)) throw new Error('GitHub 分页返回格式无效')
  return value.flatMap((page) => Array.isArray(page) ? page as T[] : [page as T])
}

export async function fetchRepositoryIssues(
  ctx: Context,
  payload: unknown,
  overrides: { config?: ClickVibeConfig; workflows?: IssueWorkflow[] } = {},
): Promise<
  | { ok: true; repoKey: string; issues: unknown[] }
  | { ok: false; error: string }
> {
  const repoKey = String((payload as { repoKey?: unknown } | undefined)?.repoKey ?? '').trim()
  const config = overrides.config ?? await loadConfig()
  const configuredPath = config.repos[repoKey]
  if (!configuredPath) return { ok: false, error: `未配置项目 ${repoKey}` }

  const issueCommand = `gh api --paginate --slurp ${shellQuote(`repos/${repoKey}/issues?state=all&per_page=100`)}`
  const prCommand = `gh api --paginate --slurp ${shellQuote(`repos/${repoKey}/pulls?state=all&per_page=100`)}`
  try {
    const [issueOutput, prOutput, allWorkflows] = await Promise.all([
      runCommand(ctx, issueCommand, { timeoutMs: 30000 }),
      runCommand(ctx, prCommand, { timeoutMs: 30000 }),
      overrides.workflows ? Promise.resolve(overrides.workflows) : loadAllWorkflows(),
    ])
    const allIssues = flattenGithubPages<RepositoryIssueRest>(JSON.parse(issueOutput))
      .filter((issue) => issue.pull_request === undefined)
      .map<RepositoryIssueItem>((issue) => ({
        number: issue.number,
        title: issue.title,
        state: issue.state.toUpperCase(),
        body: issue.body ?? '',
        url: issue.html_url,
        updatedAt: issue.updated_at,
        labels: issue.labels,
        milestone: issue.milestone,
      }))
    const prs = flattenGithubPages<RepositoryPrRest>(JSON.parse(prOutput)).map<GithubPrFact>((pr) => ({
      number: String(pr.number),
      state: pr.merged_at ? 'MERGED' : pr.state.toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN',
      mergedAt: pr.merged_at,
      headRefName: String(pr.head?.ref ?? ''),
      url: pr.html_url,
      reviewDecision: null,
    }))

    const issueByNumber = new Map(allIssues.map((issue) => [issue.number, issue]))
    const workflowByNumber = new Map(
      allWorkflows
        .filter((workflow) => workflow.repoKey === repoKey)
        .map((workflow) => [Number(parseUrl(workflow.url)?.number), workflow]),
    )
    const prByBranch = new Map<string, GithubPrFact>()
    for (const raw of prs) {
      if (!raw.headRefName || prByBranch.has(raw.headRefName)) continue
      prByBranch.set(raw.headRefName, { ...raw, number: String(raw.number) })
    }

    const repoPath = expandHome(configuredPath)
    const project = basename(repoPath)
    let refs = new Set<string>()
    let defaultBranch = 'main'
    if (existsSync(repoPath)) {
      const policy = { mode: 'read-only' as const, workspaceRoot: repoPath }
      const [refOutput, defaultRef] = await Promise.all([
        runCommand(ctx, "git for-each-ref --format='%(refname:short)' refs/heads refs/remotes/origin", {
          workdir: repoPath, timeoutMs: 5000, sandboxPolicy: policy,
        }).catch(() => ''),
        runCommand(ctx, 'git symbolic-ref --quiet --short refs/remotes/origin/HEAD', {
          workdir: repoPath, timeoutMs: 3000, sandboxPolicy: policy,
        }).catch(() => ''),
      ])
      refs = new Set(refOutput.split('\n').filter(Boolean))
      defaultBranch = defaultRef.replace(/^origin\//, '') || defaultBranch
    }

    const openIssues = allIssues.filter((issue) => String(issue.state).toUpperCase() === 'OPEN')
    const issues = await Promise.all(openIssues.map(async (issue) => {
      const existing = workflowByNumber.get(issue.number)
      const branch = existing?.branch ?? `${project}-issue-${issue.number}`
      const worktree = existing?.worktree ?? join(config.worktreeRoot, project, branch)
      const branchExists = refs.has(branch) || refs.has(`origin/${branch}`)
      let pr: GithubPrFact | null
      let prStatusKnown: boolean
      if (existing?.prNumber) {
        const lookup = await fetchGithubPrFact(ctx, repoKey, branch, existing.prNumber)
        pr = lookup.pr
        prStatusKnown = lookup.known && lookup.pr !== null
      } else {
        pr = prByBranch.get(branch) ?? null
        prStatusKnown = true
      }
      let hasCommits = false
      if (branchExists && existsSync(repoPath)) {
        hasCommits = await runCommand(ctx, `git rev-list --count ${shellQuote(`origin/${defaultBranch}`)}..${shellQuote(branch)}`, {
          workdir: repoPath,
          timeoutMs: 10000,
          sandboxPolicy: { mode: 'read-only', workspaceRoot: repoPath },
        }).then((count) => Number(count) > 0).catch(() => false)
      }
      const workflow: IssueWorkflow = existing ?? {
        key: issueKey(repoKey, String(issue.number)),
        url: issue.url,
        repoKey,
        worktree,
        branch,
        stage: pr ? 'review-ready' : 'idle',
        devAgent: null,
        devTaskId: null,
        devSessionId: null,
        devSessionAgent: null,
        devInterrupted: false,
        reviewAgent: null,
        reviewTaskId: null,
        reviewSessionId: null,
        reviewSessionAgent: null,
        reviewResult: null,
        prNumber: pr?.number ?? null,
        issueState: 'OPEN',
        baseRef: null,
        updatedAt: 0,
        events: [],
      }
      workflow.worktree = worktree
      workflow.branch = branch
      workflow.issueState = 'OPEN'
      const derived = await deriveWorkflowState(ctx, workflow, {
        pr, prStatusKnown, branchExists, hasCommits, defaultBranch,
      })
      const blockedBy = parseDependencies(issue.body).map((number) => {
        const dependency = issueByNumber.get(number)
        return { number, title: dependency?.title ?? '', state: String(dependency?.state ?? 'UNKNOWN').toUpperCase() }
      })
      return { ...issue, blockedBy, workflow: derived }
    }))
    return { ok: true, repoKey, issues }
  } catch (error) {
    return { ok: false, error: `项目 issue 抓取失败: ${String(error instanceof Error ? error.message : error)}` }
  }
}

/** Validate the URL and run gh, returning the { ok, ... } envelope. */
async function fetchIssue(
  ctx: Context,
  payload: unknown,
): Promise<{ ok: true; data: { kind: 'issue' | 'pr'; item: unknown; timeline?: unknown } } | { ok: false; error: string }> {
  const url = String((payload as { url?: unknown } | undefined)?.url ?? '').trim()
  const parsed = parseUrl(url)
  if (!parsed) {
    return { ok: false, error: '请输入形如 https://github.com/owner/repo/issues/123 或 /pull/123 的链接' }
  }
  const isPR = parsed.kind === 'pr'
  const command = `${isPR ? 'gh pr view' : 'gh issue view'} ${url} --json ${isPR ? PR_FIELDS : ISSUE_FIELDS}`
  try {
    const spec = ctx.shell.resolve({ command, timeoutMs: 20000 })
    const result = await ctx.shell.run(spec)
    if (result.exitCode !== 0) {
      const stderr = result.stderr?.text ?? ''
      return { ok: false, error: stderr || `gh 执行失败(exit ${result.exitCode})` }
    }
    const parsedJson = JSON.parse(result.stdout.text) as unknown
    const data: { kind: 'issue' | 'pr'; item: unknown; timeline?: unknown; dependencies?: { blockedBy: IssueDependency[]; blocking: IssueDependency[] } } = { kind: parsed.kind, item: parsedJson }
    // issue 额外拉 timeline,提取关联事件(linked PR/commit)——GitHub UI 的
    // "linked a pull request" 就来自 cross-referenced 事件
    if (!isPR) {
      data.timeline = await fetchTimeline(ctx, parsed.owner, parsed.repo, parsed.number)
      // 依赖图:blockedBy 来自本 issue 正文,blocking 扫描 repo 内其它 issue
      data.dependencies = await fetchDependencies(ctx, parsed, parsedJson as { body?: unknown })
    }
    return { ok: true, data }
  } catch (error) {
    return { ok: false, error: `抓取异常: ${String(error instanceof Error ? error.message : error)}` }
  }
}

function issueSnapshot(item: Record<string, unknown>): IssuePromptSnapshot {
  const url = String(item.url ?? '')
  if (!parseUrl(url)) throw new Error('GitHub 返回了无效 URL')
  const comments = Array.isArray(item.comments)
    ? (item.comments as { author?: { login?: string } | null; body?: unknown }[]).map((comment) => ({
        author: String(comment.author?.login ?? 'unknown'),
        body: String(comment.body ?? ''),
      }))
    : []
  return {
    url,
    title: String(item.title ?? ''),
    body: String(item.body ?? ''),
    state: String(item.state ?? '').toUpperCase(),
    updatedAt: String(item.updatedAt ?? ''),
    comments,
  }
}

async function authorizeAgent(
  ctx: Context,
  payload: unknown,
): Promise<
  | { ok: true; authorizationId: string; authorizationDigest: string; expiresAt: number; preview: unknown }
  | { ok: false; error: string }
> {
  try {
    const body = (payload ?? {}) as { action?: unknown; expectedSnapshot?: unknown }
    const action = String(body.action ?? '') as AgentAuthorizationInput['action']
    const input = authorizationInputFromPayload(action, payload)
    let snapshot: IssuePromptSnapshot | null = null
    if (input.action === 'develop') {
      const fetched = await fetchIssue(ctx, { url: input.url })
      if (!fetched.ok) return fetched
      snapshot = issueSnapshot(fetched.data.item as Record<string, unknown>)
      if (snapshot.state !== 'OPEN') return { ok: false, error: '只有 OPEN Issue 可以启动开发' }
      if (JSON.stringify(body.expectedSnapshot) !== JSON.stringify(snapshot)) {
        return { ok: false, error: 'Issue 内容已变化或未提供完整预览快照,请刷新面板并重新确认' }
      }
    }
    const authorization = authorizations.issue(input, snapshot)
    return {
      ok: true,
      authorizationId: authorization.id,
      authorizationDigest: authorization.digest,
      expiresAt: authorization.expiresAt,
      preview: snapshot
        ? {
            action: input.action,
            agent: input.agent,
            url: snapshot.url,
            title: snapshot.title,
            updatedAt: snapshot.updatedAt,
            commentCount: snapshot.comments.length,
            digest: authorization.digest,
          }
        : { action: input.action, agent: input.agent, url: input.url, digest: authorization.digest },
    }
  } catch (error) {
    return { ok: false, error: String(error instanceof Error ? error.message : error) }
  }
}

/** One resolved dependency entry (number + title + state). */
interface IssueDependency {
  number: number
  title: string
  state: string
}

/**
 * Resolve an issue's dependency graph (issue-contract convention):
 * - blockedBy: issues this issue depends on, parsed from its `## 依赖` body section;
 * - blocking: issues that declare a dependency on this issue.
 * Scans the repo's issues once via gh (local, fast).
 */
async function fetchDependencies(
  ctx: Context,
  target: { owner: string; repo: string; number: string },
  item: { body?: unknown },
): Promise<{ blockedBy: IssueDependency[]; blocking: IssueDependency[] }> {
  const empty: { blockedBy: IssueDependency[]; blocking: IssueDependency[] } = { blockedBy: [], blocking: [] }
  const command = `gh issue list --repo ${target.owner}/${target.repo} --state all --limit 100 --json number,title,state,body`
  let issues: { number: number; title: string; state: string; body: string }[] = []
  try {
    const spec = ctx.shell.resolve({ command, timeoutMs: 20000 })
    const result = await ctx.shell.run(spec)
    if (result.exitCode !== 0) return empty
    const parsed = JSON.parse(result.stdout.text) as unknown
    if (!Array.isArray(parsed)) return empty
    issues = parsed as { number: number; title: string; state: string; body: string }[]
  } catch {
    return empty
  }

  const current = Number(target.number)
  const byNumber = new Map(issues.filter((i) => Number.isInteger(i.number)).map((i) => [i.number, i]))

  const blockedBy: IssueDependency[] = []
  for (const number of parseDependencies(String(item.body ?? ''))) {
    const found = byNumber.get(number)
    blockedBy.push(found
      ? { number: found.number, title: found.title, state: found.state }
      : { number, title: '', state: 'unknown' })
  }
  const blocking: IssueDependency[] = []
  for (const issue of issues) {
    if (issue.number === current) continue
    if (parseDependencies(issue.body).includes(current)) {
      blocking.push({ number: issue.number, title: issue.title, state: issue.state })
    }
  }
  blockedBy.sort((a, b) => a.number - b.number)
  blocking.sort((a, b) => a.number - b.number)
  return { blockedBy, blocking }
}

/** Fetch the issue timeline and keep only the events worth showing. */
async function fetchTimeline(ctx: Context, owner: string, repo: string, number: string): Promise<unknown[]> {
  const command = `gh api repos/${owner}/${repo}/issues/${number}/timeline -H "Accept: application/vnd.github+json" --jq '[.[] | select(.event == "cross-referenced" or .event == "referenced" or .event == "connected" or .event == "closed" or .event == "reopened") | {event, created_at, actor: .actor.login, commit_id, source: (if .source then {number: .source.issue.number, title: .source.issue.title, html_url: .source.issue.html_url, state: .source.issue.state, is_pr: (.source.issue.pull_request != null), pr_merged: (.source.issue.pull_request.merged_at != null)} else null end)}]'`
  try {
    const spec = ctx.shell.resolve({ command, timeoutMs: 15000 })
    const result = await ctx.shell.run(spec)
    if (result.exitCode !== 0) return []
    return JSON.parse(result.stdout.text) as unknown[]
  } catch {
    return []
  }
}

interface ResolvedPromptSnapshot {
  snapshot: PromptSnapshot
  freshness: SnapshotFreshness
  fetchError?: string
}

async function fetchPrPromptComments(
  ctx: Context,
  workflow: IssueWorkflow,
): Promise<{ author: string; body: string }[] | null> {
  if (!workflow.prNumber) return []
  try {
    const spec = ctx.shell.resolve({
      command: `gh pr view ${workflow.prNumber} --repo ${workflow.repoKey} --json comments`,
      timeoutMs: 20000,
    })
    const result = await ctx.shell.run(spec)
    if (result.exitCode !== 0) return null
    const parsed = JSON.parse(result.stdout.text) as { comments?: unknown }
    if (!Array.isArray(parsed.comments)) return null
    return (parsed.comments as { author?: { login?: string } | null; body?: unknown }[]).map((comment) => ({
      author: String(comment.author?.login ?? 'unknown'),
      body: String(comment.body ?? ''),
    }))
  } catch {
    return null
  }
}

/** Refresh at stage start; only a complete persisted snapshot may cover an outage. */
async function resolvePromptSnapshot(
  ctx: Context,
  workflow: IssueWorkflow,
): Promise<ResolvedPromptSnapshot | { error: string }> {
  const fetched = await fetchIssue(ctx, { url: workflow.url })
  if (fetched.ok) {
    const snapshot = issueSnapshot(fetched.data.item as Record<string, unknown>)
    const prComments = await fetchPrPromptComments(ctx, workflow)
    if (prComments) snapshot.comments.push(...prComments)
    workflow.issueSnapshot = snapshot
    if (snapshot.state === 'OPEN' || snapshot.state === 'CLOSED') workflow.issueState = snapshot.state
    await saveWorkflow(workflow)
    return { snapshot, freshness: 'current' }
  }
  const snapshot = workflow.issueSnapshot
  if (!snapshot) {
    return { error: `无法刷新 Issue,且没有可回退的持久化需求快照: ${fetched.error}` }
  }
  workflow.issueSnapshot = snapshot
  await saveWorkflow(workflow)
  return { snapshot, freshness: 'persisted', fetchError: fetched.error.slice(0, 500) }
}

function sameSnapshot(left: PromptSnapshot, right: PromptSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

const DEVELOPMENT_REQUIREMENTS = [
  '先执行 git fetch origin 同步远端,并检查 base(默认 origin/main)是否有更新;若已有更新,先合并或变基到最新再继续。',
  '先理解当前需求快照;如有歧义可自行判断或提问。',
  '实现代码改动,并保留现有 worktree 中尚未提交的有效工作。',
  '运行相关测试。',
  '完成后 git commit 并推送当前分支。',
  '用 gh 创建或更新 PR(若适用)。',
]

function buildDevelopPrompt(
  workflow: IssueWorkflow,
  resolved: ResolvedPromptSnapshot,
  extraContext: string,
): string {
  return buildStagePrompt({
    stage: extraContext === '' ? 'develop' : 'rework',
    ...resolved,
    worktree: workflow.worktree,
    status: [
      `分支: ${workflow.branch}`,
      `开发基线: ${workflow.baseRef ?? '未知'}`,
      ...(extraContext ? ['附加上下文:', extraContext] : []),
    ],
    requirements: DEVELOPMENT_REQUIREMENTS,
  })
}

/** Build the review prompt: review `git diff base...HEAD` against the issue.
 *  base 取远端主干(origin/main 或 PR base),让 agent 用真实 diff 审查。 */
async function buildReviewPrompt(
  ctx: Context,
  workflow: IssueWorkflow,
  resolved: ResolvedPromptSnapshot,
  sessionId: string | null = null,
): Promise<string> {
  // 解析 base:PR 有 baseRefName(若记录过),否则尝试 origin/HEAD 主干
  let base = 'origin/main'
  if (workflow.prNumber) {
    const baseRef = await fetchPrBase(ctx, workflow.repoKey, workflow.prNumber)
    if (baseRef) base = `origin/${baseRef}`
  }
  const head = await readWorktreeHead(ctx, workflow.worktree)
  const prUrl = workflow.prNumber ? `https://github.com/${workflow.repoKey}/pull/${workflow.prNumber}` : '未关联'
  return buildStagePrompt({
    stage: 'review',
    ...resolved,
    worktree: workflow.worktree,
    status: [
      `分支: ${workflow.branch}`,
      `PR: ${prUrl}`,
      `当前 commit: ${head ?? '未知'}`,
      `对比 base: ${base}`,
      `会话模式: ${sessionId ? `续接 review 会话 ${sessionId};保留既有审查记忆` : '全新 review 会话'}`,
    ],
    requirements: [
      '先执行 git fetch origin 同步远端最新状态(并行开发时 base 可能已变化)。',
      `执行 git diff ${base}...HEAD 查看完整改动。`,
      ...(sessionId ? ['先复核之前发现的问题是否已解决,再审查全部新改动。'] : []),
      '严格按当前需求快照中的验收标准逐条审查,同时检查 bug、安全隐患和测试覆盖。',
      `除 ${REVIEW_RESULT_RELATIVE_PATH} 外不要修改任何文件,只做只读 review。`,
      `必须使用写文件工具把最终结论写入 ${REVIEW_RESULT_RELATIVE_PATH},格式:{"passed":true|false,"issues":["问题1(含文件/位置/原因)",...]};passed=true 表示无问题,有任意问题则 false 并列全。`,
      '最后一行再输出同一个 JSON 对象(单独一行,不要代码块),仅作为兼容兜底。',
    ],
  })
}

async function buildResumePrompt(
  ctx: Context,
  workflow: IssueWorkflow,
  resolved: ResolvedPromptSnapshot,
  extraContext: string,
  mergePreface: string,
  sessionId: string | null,
): Promise<string> {
  const localIssues = workflow.reviewResult?.passed === false ? workflow.reviewResult.issues : []
  const selected = selectReviewFeedback({
    unresolvedReview: workflow.reviewResult?.passed === false,
    snapshot: resolved.snapshot,
    freshness: resolved.freshness,
    localEvents: workflow.events,
    localIssues,
  })
  let reviewFeedback: { source: string; text: string } | null = selected
  if (extraContext !== '' && !selected?.text.includes(extraContext)) {
    reviewFeedback = {
      source: selected ? `${selected.source}+request-context` : 'request-context',
      text: selected ? `${selected.text}\n\n${extraContext}` : extraContext,
    }
  }
  const rework = reviewFeedback !== null || localIssues.length > 0
  const head = await readWorktreeHead(ctx, workflow.worktree)
  return buildStagePrompt({
    stage: rework ? 'rework' : 'resume',
    ...resolved,
    worktree: workflow.worktree,
    status: [
      `分支: ${workflow.branch}`,
      `当前 commit: ${head ?? '未知'}`,
      `开发基线: ${workflow.baseRef ?? '未知'}`,
      `会话模式: ${sessionId ? `续接精确开发会话 ${sessionId};会话记忆优先用于理解既有工作` : '全新会话;从当前快照与 worktree 重新建立上下文'}`,
    ],
    reviewFeedback,
    requirements: [
      ...(mergePreface ? [mergePreface] : []),
      ...(sessionId
        ? ['优先利用当前会话记忆继续工作,但记忆与当前需求快照冲突时以快照为准。']
        : ['先读取 git diff 和未提交改动,再按当前需求快照继续;不要依赖已失效会话的旧记忆。']),
      ...(rework ? ['逐条处理“当前状态”中的 Review 意见,完成后重新验证。'] : []),
      ...DEVELOPMENT_REQUIREMENTS,
    ],
  })
}

/** Fetch a PR's base ref name via gh. */
async function fetchPrBase(ctx: Context, repoKey: string, prNumber: string): Promise<string | null> {
  try {
    const spec = ctx.shell.resolve({
      command: `gh pr view ${prNumber} --repo ${repoKey} --json baseRefName --jq '.baseRefName // ""'`,
      timeoutMs: 15000,
    })
    const result = await ctx.shell.run(spec)
    if (result.exitCode !== 0) return null
    const name = result.stdout.text.trim()
    return name === '' ? null : name
  } catch {
    return null
  }
}

/** Fetch a PR's head branch name via gh (to locate its worktree). */
async function fetchPrHeadBranch(ctx: Context, owner: string, repo: string, prNumber: string): Promise<string | null> {
  try {
    const spec = ctx.shell.resolve({
      command: `gh pr view ${prNumber} --repo ${owner}/${repo} --json headRefName --jq '.headRefName // ""'`,
      timeoutMs: 15000,
    })
    const result = await ctx.shell.run(spec)
    if (result.exitCode !== 0) return null
    const name = result.stdout.text.trim()
    return name === '' ? null : name
  } catch {
    return null
  }
}

/** Create (or reuse) the workflow record and the worktree+branch. */
async function ensureWorktree(ctx: Context, parsed: { owner: string; repo: string; number: string }): Promise<
  | { ok: true; workflow: IssueWorkflow; worktree: string; branch: string }
  | { ok: false; error: string }
> {
  const config = await loadConfig()
  const repoKey = `${parsed.owner}/${parsed.repo}`
  const repoPath = config.repos[repoKey]
  if (!repoPath) {
    return { ok: false, error: `本地未配置仓库 ${repoKey},请在 ~/.clickvibe/config.yaml 的 repos 中添加映射` }
  }
  const expandedRepo = expandHome(repoPath)
  if (!existsSync(expandedRepo)) {
    return { ok: false, error: `仓库路径不存在: ${expandedRepo}` }
  }

  const key = issueKey(repoKey, parsed.number)
  let workflow = await loadWorkflow(key)
  const project = basename(expandedRepo)
  const branch = `${project}-issue-${parsed.number}`
  const worktree = join(config.worktreeRoot, project, branch)

  if (!workflow) {
    workflow = {
      key,
      url: `https://github.com/${repoKey}/issues/${parsed.number}`,
      repoKey,
      worktree,
      branch,
      stage: 'idle',
      devAgent: null,
      devTaskId: null,
      devSessionId: null,
      devSessionAgent: null,
      devInterrupted: false,
      reviewAgent: null,
      reviewTaskId: null,
      reviewSessionId: null,
      reviewSessionAgent: null,
      reviewResult: null,
      prNumber: null,
      issueState: 'OPEN',
      baseRef: null,
      updatedAt: Date.now(),
      events: [],
    }
  }
  // 旧状态文件兜底:裸 session id 不猜 agent 归属,后续 resume 会按无效处理。
  if (!Array.isArray(workflow.events)) workflow.events = []
  if (workflow.reviewSessionId === undefined) workflow.reviewSessionId = null
  if (workflow.devSessionAgent === undefined) workflow.devSessionAgent = null
  if (workflow.reviewSessionAgent === undefined) workflow.reviewSessionAgent = null
  if (workflow.prNumber === undefined) workflow.prNumber = null
  if (workflow.issueState === undefined) workflow.issueState = 'OPEN'
  if (workflow.baseRef === undefined) workflow.baseRef = null
  // 校正路径字段(配置可能变化)
  workflow.worktree = worktree
  workflow.branch = branch

  // 新分支只能从 fetch 后的远端默认分支创建,不能继承配置仓库碰巧停留的 HEAD。
  const policy = { mode: 'danger-full-access' as const, workspaceRoot: expandedRepo }
  await runCommand(ctx, 'git fetch origin --prune', {
    workdir: expandedRepo,
    sandboxPolicy: policy,
    timeoutMs: 60_000,
  })
  let remoteBase = await runCommand(ctx, 'git symbolic-ref --quiet --short refs/remotes/origin/HEAD', {
    workdir: expandedRepo,
    sandboxPolicy: policy,
    timeoutMs: 10_000,
  }).catch(() => '')
  if (!remoteBase) {
    const hasMain = await runCommand(
      ctx,
      `git show-ref --verify --quiet ${shellQuote('refs/remotes/origin/main')}; echo $?`,
      { workdir: expandedRepo, sandboxPolicy: policy, timeoutMs: 10_000 },
    )
    if (hasMain.trim() !== '0') return { ok: false, error: '无法确定 origin 默认分支,请设置 origin/HEAD' }
    remoteBase = 'origin/main'
  }
  const remoteBaseHash = await runCommand(ctx, `git rev-parse --short ${shellQuote(remoteBase)}`, {
    workdir: expandedRepo,
    sandboxPolicy: policy,
    timeoutMs: 10_000,
  })

  // 幂等建 worktree:用完整恢复决策(处理 reuse/attach/conflict/重建),
  // 而不是简单判断目录是否存在。git 操作需要无沙箱(写主仓库 .git/refs)。
  const listOut = await runCommand(ctx, 'git worktree list --porcelain', { workdir: expandedRepo, sandboxPolicy: policy, timeoutMs: 15000 })
  const records = parseWorktreeList(listOut)
  const normalizedTarget = resolve(worktree)
  const atPath = records.find((r) => r.path === normalizedTarget)
  const atBranch = records.find((r) => r.branch === branch)
  const pathExists = existsSync(normalizedTarget)
  let pathEmpty = false
  if (pathExists) {
    const { readdir } = await import('node:fs/promises')
    pathEmpty = (await readdir(normalizedTarget)).length === 0
  }
  const branchOut = await runCommand(
    ctx,
    `git show-ref --verify --quiet ${shellQuote(`refs/heads/${branch}`)}; echo $?`,
    { workdir: expandedRepo, sandboxPolicy: policy, timeoutMs: 15000 },
  )
  const branchExists = branchOut.trim() === '0'
  const recovery = decideWorktreeRecovery({
    targetBranch: branch,
    pathExists,
    pathEmpty,
    registeredBranch: atPath?.branch ?? null,
    branchExists,
    branchWorktree: atBranch?.path ?? null,
  })

  if (recovery.kind === 'conflict') {
    await appendLog(workflow.key, 'dev', `[clickvibe] worktree 冲突: ${recovery.reason}`)
    return { ok: false, error: `worktree 冲突: ${recovery.reason}` }
  }

  if (recovery.kind === 'reuse') {
    await appendLog(workflow.key, 'dev', `[clickvibe] worktree 已存在,复用`)
  } else if (recovery.kind === 'attach-detached') {
    await runCommand(ctx, `git switch -c ${shellQuote(branch)}`, { workdir: normalizedTarget, timeoutMs: 60000, sandboxPolicy: policy })
    await appendLog(workflow.key, 'dev', `[clickvibe] 已为 detached worktree 创建目标分支`)
  } else if (recovery.kind === 'attach-existing') {
    await runCommand(ctx, `git switch ${shellQuote(branch)}`, { workdir: normalizedTarget, timeoutMs: 60000, sandboxPolicy: policy })
    await appendLog(workflow.key, 'dev', `[clickvibe] 已将 detached worktree 切换到现有目标分支`)
  } else if (recovery.kind === 'repair') {
    // stale 注册:先清理 git 注册记录(路径为空时可顺带删空目录),再重建
    await appendLog(workflow.key, 'dev', `[clickvibe] 修复 stale 注册: ${recovery.reason}`)
    if (pathExists && pathEmpty) {
      const { rmdir } = await import('node:fs/promises')
      await rmdir(normalizedTarget).catch(() => { /* 非空时忽略,交给 git */ })
    }
    await runCommand(ctx, `git worktree remove --force ${shellQuote(normalizedTarget)}`, { workdir: expandedRepo, timeoutMs: 60000, sandboxPolicy: policy }).catch(() => { /* 记录已不在也忽略 */ })
    const { mkdir } = await import('node:fs/promises')
    await mkdir(dirname(normalizedTarget), { recursive: true })
    const command = buildWorktreeAddCommand({ path: normalizedTarget, branch, branchExists, remoteBase })
    await runCommand(ctx, command, { workdir: expandedRepo, timeoutMs: 60000, sandboxPolicy: policy })
    await appendLog(workflow.key, 'dev', `[clickvibe] stale worktree 已重建`)
  } else {
    // add-new-branch / add-existing-branch:确保父目录存在后创建/复用
    const { mkdir } = await import('node:fs/promises')
    await mkdir(dirname(normalizedTarget), { recursive: true })
    const command = buildWorktreeAddCommand({
      path: normalizedTarget,
      branch,
      branchExists: recovery.kind !== 'add-new-branch',
      remoteBase,
    })
    await runCommand(ctx, command, { workdir: expandedRepo, timeoutMs: 60000, sandboxPolicy: policy })
    await appendLog(workflow.key, 'dev', recovery.kind === 'add-new-branch'
      ? `[clickvibe] worktree 与分支创建完成`
      : `[clickvibe] 已从现有分支恢复 worktree`)
  }

  // 记录开发基线:首次开发时记下明确的远端默认分支 + fetch 后提交。
  if (!workflow.baseRef) {
    workflow.baseRef = `${remoteBase} @ ${remoteBaseHash}`
    await appendLog(workflow.key, 'dev', `[clickvibe] 开发基线: ${workflow.baseRef}`)
  }

  await saveWorkflow(workflow)
  return { ok: true, workflow, worktree, branch }
}

/** Parse `git worktree list --porcelain` output into { path, branch } records. */
function parseWorktreeList(output: string): { path: string; branch: string | null }[] {
  const records: { path: string; branch: string | null }[] = []
  let current: { path: string; branch: string | null } | null = null
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') {
      if (current) { records.push(current); current = null }
      continue
    }
    if (trimmed.startsWith('worktree ')) {
      current = { path: trimmed.slice('worktree '.length), branch: null }
    } else if (trimmed.startsWith('branch ') && current) {
      current.branch = trimmed.slice('branch refs/heads/'.length)
    } else if (trimmed.startsWith('detached') && current) {
      current.branch = 'HEAD'
    }
  }
  if (current) records.push(current)
  return records
}

/** Start (or restart) a dev task in the live map with status parsing. */
function createLiveTask(
  taskId: string,
  workflowKey: string,
  kind: LiveTask['kind'],
  agent: DevelopAgent,
  sessionId: string | null,
): LiveTask {
  for (const [id, task] of liveTasks) {
    if (liveTasks.size < MAX_TASKS) break
    if (task.closed) {
      if (task.cleanup) clearTimeout(task.cleanup)
      liveTasks.delete(id)
      liveWaiters.delete(id)
    }
  }
  if (liveTasks.size >= MAX_TASKS) throw new Error('运行中任务过多,请先停止或等待现有任务完成')
  const task: LiveTask = {
    taskId,
    workflowKey,
    kind,
    agent,
    log: new LineLog(TASK_LOG_LINES),
    rawLog: new LineLog(TASK_LOG_LINES),
    rawCursor: 0,
    closed: false,
    status: 'running',
    exitCode: null,
    sessionId,
  }
  liveTasks.set(taskId, task)
  return task
}

function pushTaskLine(task: LiveTask, line: string): void {
  task.log.appendLine(line)
  void appendLog(task.workflowKey, task.kind, line)
  notifyTask(task.taskId)
}

function scheduleTaskCleanup(task: LiveTask): void {
  task.cleanup = setTimeout(() => {
    liveTasks.delete(task.taskId)
    liveWaiters.delete(task.taskId)
  }, TASK_RETENTION_MS)
  task.cleanup.unref?.()
}

function finishTask(
  task: LiveTask,
  status: Exclude<LiveTask['status'], 'running'>,
  exitCode: number | null,
): void {
  if (task.closed) return
  task.closed = true
  task.status = status
  task.exitCode = exitCode
  if (task.kind === 'review') reviewTaskGate.release(task.workflowKey, task)
  else resumeTaskGate.release(task.workflowKey, task)
  if (task.timeout) clearTimeout(task.timeout)
  notifyTask(task.taskId)
  scheduleTaskCleanup(task)
}

function attachAgentProcess(
  ctx: Context,
  task: LiveTask,
  command: string,
  workdir: string,
  prompt: string,
  onExit: (exitCode: number | null, sessionId: string | null) => void | Promise<void>,
  resumeFallback?: {
    staleSessionId: string
    prepare: () => Promise<{ command: string; prompt: string }>
  },
): void {
  task.timeout = setTimeout(() => {
    if (task.closed) return
    pushTaskLine(task, `[clickvibe] Agent 超过 ${TASK_TIMEOUT_MS / 3_600_000} 小时,已终止`)
    task.status = 'timed_out'
    task.process?.kill()
  }, TASK_TIMEOUT_MS)
  task.timeout.unref?.()

  const launch = (
    attemptCommand: string,
    attemptPrompt: string,
    fallback: typeof resumeFallback,
  ): void => {
    let process: ReturnType<Context['shell']['start']>
    try {
      const spec = ctx.shell.resolve({
        command: attemptCommand,
        workdir,
        stdin: attemptPrompt,
        timeoutMs: TASK_TIMEOUT_MS,
        sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: workdir },
      })
      process = ctx.shell.start(spec)
    } catch (error) {
      pushTaskLine(task, `[clickvibe] Agent 启动失败: ${String(error instanceof Error ? error.message : error)}`)
      task.status = 'failed'
      task.exitCode = 1
      void Promise.resolve()
        .then(() => onExit(1, task.sessionId))
        .catch((exitError: unknown) => pushTaskLine(task, `[clickvibe] 启动失败收尾异常: ${String(exitError)}`))
        .finally(() => finishTask(task, 'failed', 1))
      return
    }
    task.process = process
    const startedAt = Date.now()
    let sawSessionId = false

    // 轮询读取 agent 输出,解析为状态行,写入内存缓冲 + 落盘日志
    const drain = (flush = false) => {
      const read = process.readOutput()
      if (read.delta !== '') task.rawLog.appendChunk(read.delta)
      if (flush) task.rawLog.flush()
      const raw = task.rawLog.read(task.rawCursor)
      task.rawCursor = raw.cursor
      if (raw.lines.length > 0) {
        const parsed = parseAgentChunk(task.agent as AgentKind, raw.lines.join('\n'))
        for (const line of parsed.lines) {
          pushTaskLine(task, line.text)
        }
        if (parsed.sessionId) {
          sawSessionId = true
          task.sessionId = parsed.sessionId
        }
      }
      if (raw.truncated || read.lossy) {
        pushTaskLine(task, '[clickvibe] Agent 原始输出被截断(日志过长)')
      }
    }
    const pump = setInterval(() => drain(), 250)

    const settle = async (processError?: unknown): Promise<void> => {
      clearInterval(pump)
      drain(true)
      if (processError !== undefined) {
        pushTaskLine(task, `[clickvibe] Agent 进程异常: ${String(processError instanceof Error ? processError.message : processError)}`)
      }
      const status = task.status === 'timed_out' || task.status === 'stopped'
        ? task.status
        : process.exitCode === 0 ? 'done' : 'failed'
      if (processError === undefined && fallback && shouldFallbackFromExactResume({
        hadExactSessionId: fallback.staleSessionId !== '',
        status,
        exitCode: process.exitCode,
        elapsedMs: Date.now() - startedAt,
        sawSessionId,
      })) {
        task.sessionId = null
        pushTaskLine(task, '[clickvibe] 精确会话已失效,清除 stale sessionId 并回退全新会话…')
        try {
          const next = await fallback.prepare()
          if (task.status === 'stopped' || task.status === 'timed_out') {
            await onExit(process.exitCode, null)
            finishTask(task, task.status, process.exitCode)
            return
          }
          task.exitCode = null
          launch(next.command, next.prompt, undefined)
          return
        } catch (error) {
          pushTaskLine(task, `[clickvibe] 全新会话回退准备失败: ${String(error instanceof Error ? error.message : error)}`)
        }
      }
      task.status = status
      task.exitCode = process.exitCode
      try {
        await onExit(process.exitCode, task.sessionId)
      } finally {
        finishTask(task, status, process.exitCode)
      }
    }

    void process.done.then(
      () => settle(),
      (error: unknown) => settle(error),
    ).catch((error: unknown) => {
      pushTaskLine(task, `[clickvibe] 任务收尾失败: ${String(error instanceof Error ? error.message : error)}`)
      if (!task.closed) finishTask(task, task.status === 'running' ? 'failed' : task.status, task.exitCode)
    })
  }

  launch(command, prompt, resumeFallback)
}

/** Start a development task: worktree + branch + background agent run. */
async function startDevelop(
  ctx: Context,
  payload: unknown,
  authorizedSnapshot: IssuePromptSnapshot | null,
): Promise<
  | { ok: true; taskId: string; worktree: string; branch: string }
  | { ok: false; error: string }
> {
  const body = (payload ?? {}) as { url?: unknown; agent?: unknown; context?: unknown }
  const url = String(body.url ?? '').trim()
  let agent: DevelopAgent
  try {
    agent = parseAgent(body.agent)
  } catch (error) {
    return { ok: false, error: String(error instanceof Error ? error.message : error) }
  }
  const extraContext = typeof body.context === 'string' ? body.context.trim() : ''
  const parsed = parseUrl(url)
  if (!parsed) {
    return { ok: false, error: '请输入形如 https://github.com/owner/repo/issues/123 的链接' }
  }
  if (parsed.kind !== 'issue') {
    return { ok: false, error: '一键开发仅支持 issue 链接' }
  }

  let launchSnapshot: ResolvedPromptSnapshot | null = null
  if (agent === 'dryrun') {
    const fetched = await fetchIssue(ctx, { url })
    if (!fetched.ok) return fetched
    const snapshot = issueSnapshot(fetched.data.item as Record<string, unknown>)
    if (snapshot.state !== 'OPEN') return { ok: false, error: '只有 OPEN Issue 可以执行 dryrun' }
  } else if (!authorizedSnapshot || authorizedSnapshot.url !== url || authorizedSnapshot.state !== 'OPEN') {
    return { ok: false, error: '缺少与该 OPEN Issue 绑定的服务端确认快照' }
  } else {
    const fetched = await fetchIssue(ctx, { url })
    if (fetched.ok) {
      const current = issueSnapshot(fetched.data.item as Record<string, unknown>)
      if (!sameSnapshot(current, authorizedSnapshot)) {
        return { ok: false, error: 'Issue 内容在确认后已变化,旧授权已失效;请刷新面板并按当前快照重新确认' }
      }
      launchSnapshot = { snapshot: current, freshness: 'current' }
    } else {
      launchSnapshot = {
        snapshot: authorizedSnapshot,
        freshness: 'persisted',
        fetchError: fetched.error.slice(0, 500),
      }
    }
  }

  const ensured = await ensureWorktree(ctx, parsed)
  if (!ensured.ok) return ensured
  const { workflow } = ensured
  // issue 已校验为 OPEN(真实 agent 走授权快照,dryrun 走抓取校验)
  workflow.issueState = 'OPEN'
  if (launchSnapshot) workflow.issueSnapshot = launchSnapshot.snapshot

  if (agent === 'dryrun') {
    // A safety probe is not a new durable development generation: never
    // rotate the previous real task's disk-backed history here.
    const taskIdValue = taskId('dryrun')
    let live: LiveTask
    try {
      live = createLiveTask(taskIdValue, workflow.key, 'dev', agent, null)
    } catch (error) {
      return { ok: false, error: String(error instanceof Error ? error.message : error) }
    }
    void (async () => {
      try {
        pushTaskLine(live, '[clickvibe] dry-run: 不会启动 Codex/Claude')
        const policy = { mode: 'read-only' as const, workspaceRoot: workflow.worktree }
        for (const command of ['pwd', 'git branch --show-current', 'git status --short --branch']) {
          pushTaskLine(live, `$ ${command}`)
          const output = await runCommand(ctx, command, { workdir: workflow.worktree, timeoutMs: 10_000, sandboxPolicy: policy })
          for (const line of output.split('\n')) if (line !== '') pushTaskLine(live, line)
        }
        pushTaskLine(live, '[clickvibe] dry-run 完成')
        finishTask(live, 'done', 0)
      } catch (error) {
        pushTaskLine(live, `[clickvibe] dry-run 失败: ${String(error instanceof Error ? error.message : error)}`)
        finishTask(live, 'failed', 1)
      }
    })()
    return { ok: true, taskId: taskIdValue, worktree: workflow.worktree, branch: workflow.branch }
  }
  if (!authorizedSnapshot || !launchSnapshot) return { ok: false, error: '服务端确认快照丢失,请重新确认' }

  // 已有开发任务在跑:复用
  if (workflow.devTaskId && liveTasks.has(workflow.devTaskId) && !liveTasks.get(workflow.devTaskId)!.closed) {
    return { ok: true, taskId: workflow.devTaskId, worktree: workflow.worktree, branch: workflow.branch }
  }

  const taskIdValue = taskId('dev')
  let live: LiveTask
  try {
    live = createLiveTask(taskIdValue, workflow.key, 'dev', agent, null)
  } catch (error) {
    return { ok: false, error: String(error instanceof Error ? error.message : error) }
  }
  // Rotate only after both worktree preparation and LiveTask creation succeed;
  // failed start attempts must not destroy the previous authoritative history.
  await resetLog(workflow.key, 'dev')
  workflow.devAgent = agent
  workflow.devTaskId = taskIdValue
  workflow.devInterrupted = false
  workflow.stage = 'developing'
  await saveWorkflow(workflow)

  void (async () => {
    try {
      pushTaskLine(live, `[clickvibe] 使用${launchSnapshot.freshness === 'current' ? '当前' : '持久化回退(可能过期)'} Issue 快照(${launchSnapshot.snapshot.updatedAt || '无更新时间'})`)
      const prompt = buildDevelopPrompt(workflow, launchSnapshot, extraContext)

      pushTaskLine(live, `[clickvibe] 启动 ${agent} 开发…`)
      const agentCommand = agent === 'claude'
        ? 'claude -p --dangerously-skip-permissions --verbose --output-format stream-json'
        : 'codex exec -c approval_policy=never -s danger-full-access --json -'

      attachAgentProcess(ctx, live, agentCommand, workflow.worktree, prompt, async (exitCode, sessionId) => {
        pushTaskLine(live, `[clickvibe] ${agent} 结束,退出码 ${exitCode}`)
        const reloaded = await loadWorkflow(workflow.key)
        if (reloaded) {
          const fixedIssues = reloaded.reviewResult?.passed === false ? [...reloaded.reviewResult.issues] : []
          if (applyDevRunOutcome(reloaded, live.status, exitCode, sessionId, agent)) {
            // 开发完成(含 rework):旧的 review 结论已归档到 events 历史,
            // 当前回到"待 review"——不能继续显示"Review 未通过"
            const head = await readWorktreeHead(ctx, workflow.worktree)
            await recordDevDelivery(ctx, reloaded, agent, head, fixedIssues, extraContext !== '' ? 'rework' : 'dev')
          }
          await saveWorkflow(reloaded)
        }
      })
    } catch (error) {
      pushTaskLine(live, `[clickvibe] 失败: ${String(error instanceof Error ? error.message : error)}`)
      const reloaded = await loadWorkflow(workflow.key)
      if (reloaded) {
        reloaded.stage = 'developing'
        reloaded.devInterrupted = true
        await saveWorkflow(reloaded)
      }
      finishTask(live, 'failed', 1)
    }
  })()

  return { ok: true, taskId: taskIdValue, worktree: workflow.worktree, branch: workflow.branch }
}

/** Consume incremental dev log/status for one task. */
async function pollDevelop(
  payload: unknown,
): Promise<
  | { ok: true; taskId: string; status: string; exitCode: number | null; cursor: number; delta: string[]; truncated: boolean; done: boolean }
  | { ok: false; error: string }
> {
  const taskId = String((payload as { taskId?: unknown } | undefined)?.taskId ?? '')
  const cursor = Number((payload as { cursor?: unknown } | undefined)?.cursor ?? 0)
  const live = liveTasks.get(taskId)
  if (!live) {
    return { ok: false, error: `未知任务 ${taskId}` }
  }
  const read = live.log.read(cursor)
  return {
    ok: true,
    taskId,
    status: live.status,
    exitCode: live.exitCode,
    cursor: read.cursor,
    delta: read.lines,
    truncated: read.truncated,
    done: live.closed,
  }
}

type HistoryKind = 'dev' | 'review'

async function resolveHistoryTarget(taskIdValue: string, requestedKey: string, requestedKind: string): Promise<{
  taskId: string | null
  key: string
  kind: HistoryKind
  live: LiveTask | null
} | null> {
  if (taskIdValue !== '') {
    const live = liveTasks.get(taskIdValue) ?? null
    if (live) return { taskId: taskIdValue, key: live.workflowKey, kind: live.kind, live }
    const workflow = (await loadAllWorkflows()).find((item) =>
      item.devTaskId === taskIdValue || item.reviewTaskId === taskIdValue)
    if (!workflow) return null
    const kind: HistoryKind = workflow.reviewTaskId === taskIdValue ? 'review' : 'dev'
    return { taskId: taskIdValue, key: workflow.key, kind, live: null }
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(requestedKey)) return null
  if (requestedKind !== 'dev' && requestedKind !== 'review') return null
  const workflow = await loadWorkflow(requestedKey)
  if (!workflow) return null
  const storedTaskId = requestedKind === 'dev' ? workflow.devTaskId : workflow.reviewTaskId
  const live = storedTaskId ? liveTasks.get(storedTaskId) ?? null : null
  return { taskId: storedTaskId, key: requestedKey, kind: requestedKind, live }
}

/** Complete disk history plus the exact cursor where SSE increments begin. */
async function getTaskHistory(req: IncomingMessage): Promise<
  | { ok: true; taskId: string | null; key: string; kind: HistoryKind; lines: string[]; cursor: number; active: boolean }
  | { ok: false; error: string }
> {
  const url = new URL(req.url ?? '/', 'http://clickvibe.internal')
  const target = await resolveHistoryTarget(
    url.searchParams.get('taskId')?.trim() ?? '',
    url.searchParams.get('key')?.trim() ?? '',
    url.searchParams.get('kind')?.trim() ?? '',
  )
  if (!target) return { ok: false, error: '找不到对应任务历史' }

  // Capture the live sequence before enqueueing the ordered disk read. No
  // await may occur between these operations: that is the history/SSE fence.
  const cursor = target.live?.log.read(Number.MAX_SAFE_INTEGER).cursor ?? 0
  const historyPromise = readLogHistory(target.key, target.kind)
  const lines = await historyPromise
  return {
    ok: true,
    taskId: target.taskId,
    key: target.key,
    kind: target.kind,
    lines,
    cursor,
    active: target.live !== null && !target.live.closed,
  }
}

/** SSE live stream: pushes parsed status lines for a task as they arrive. */
function handleStream(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://clickvibe.internal')
  const taskId = url.searchParams.get('taskId') ?? ''
  const live = liveTasks.get(taskId)
  if (!live) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: `未知任务 ${taskId}` }))
    return
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'x-accel-buffering': 'no',
    connection: 'keep-alive',
  })

  const lastEventId = Array.isArray(req.headers['last-event-id'])
    ? req.headers['last-event-id'][0]
    : req.headers['last-event-id']
  const parseCursor = (value: string | undefined | null): number => {
    const parsed = Number(value ?? 0)
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
  }
  let cursor = Math.max(parseCursor(url.searchParams.get('cursor')), parseCursor(lastEventId))
  let closed = false
  let heartbeat: ReturnType<typeof setInterval> | undefined

  const close = () => {
    if (closed) return
    closed = true
    if (heartbeat) clearInterval(heartbeat)
    res.end()
  }

  const flush = () => {
    if (closed) return
    const read = live.log.readDetailed(cursor)
    if (read.truncated) {
      res.write(`data: ${JSON.stringify({ __historyRequired: true })}\n\n`)
      close()
      return
    }
    cursor = read.cursor
    for (const entry of read.entries) {
      res.write(`id: ${entry.sequence}\ndata: ${JSON.stringify({ line: entry.line, cursor: entry.sequence })}\n\n`)
    }
    if (live.closed) {
      res.write(`data: ${JSON.stringify({ __done: true })}\n\n`)
      close()
    }
  }

  flush()
  if (!closed) {
    const wake = () => flush()
    const waiters = liveWaiters.get(taskId) ?? new Set<() => void>()
    waiters.add(wake)
    liveWaiters.set(taskId, waiters)
    heartbeat = setInterval(() => {
      if (!closed) res.write(': keep-alive\n\n')
    }, 15_000)
    heartbeat.unref?.()
    req.on('close', () => {
      waiters.delete(wake)
      if (waiters.size === 0) liveWaiters.delete(taskId)
      if (heartbeat) clearInterval(heartbeat)
      closed = true
    })
  }
}

function stopTask(payload: unknown): { ok: true; taskId: string; stopped: boolean } | { ok: false; error: string } {
  const taskId = String((payload as { taskId?: unknown } | undefined)?.taskId ?? '')
  const task = liveTasks.get(taskId)
  if (!task) return { ok: false, error: `未知任务 ${taskId}` }
  if (task.closed) return { ok: true, taskId, stopped: false }
  pushTaskLine(task, '[clickvibe] 用户请求停止任务')
  task.status = 'stopped'
  const stopped = task.process?.kill() ?? false
  if (!task.process) finishTask(task, 'stopped', null)
  void (async () => {
    const workflow = await loadWorkflow(task.workflowKey)
    if (!workflow) return
    if (task.kind === 'dev') {
      workflow.stage = 'developing'
      workflow.devInterrupted = true
    } else {
      workflow.stage = 'review-ready'
    }
    await saveWorkflow(workflow)
  })()
  return { ok: true, taskId, stopped }
}

/** Sync a workflow's worktree with the remote base (git fetch + merge origin/main).
 *  Keeps the worktree on the latest base so dev/review never target stale code
 *  (issue #5). The merge result is recorded as a timeline event.
 *  合并冲突时不回滚:现场(MERGE_HEAD + 冲突标记)原样保留,转交返工 agent
 *  解决(issue #26),避免「同步失败 → 门禁不放行 rework」的死锁。 */
export async function syncWorktree(
  ctx: Context,
  payload: unknown,
): Promise<
  | { ok: true; worktree: string; branch: string; head: string | null }
  | { ok: false; error: string; conflict?: boolean; files?: string[] }
> {
  const url = String((payload as { url?: unknown } | undefined)?.url ?? '').trim()
  const parsed = parseUrl(url)
  if (!parsed || parsed.kind !== 'issue') {
    return { ok: false, error: '请输入形如 https://github.com/owner/repo/issues/123 的链接' }
  }
  const key = issueKey(`${parsed.owner}/${parsed.repo}`, parsed.number)
  const workflow = await loadWorkflow(key)
  if (!workflow || !existsSync(workflow.worktree)) {
    return { ok: false, error: '该 issue 尚无 worktree,无法同步' }
  }
  const policy = { mode: 'danger-full-access' as const, workspaceRoot: workflow.worktree }
  try {
    await appendLog(workflow.key, 'dev', '[clickvibe] 同步:git fetch origin…')
    await runCommand(ctx, 'git fetch origin --prune', { workdir: workflow.worktree, timeoutMs: 60_000, sandboxPolicy: policy })
    await appendLog(workflow.key, 'dev', '[clickvibe] 同步:合并 origin/main…')
    try {
      await runCommand(ctx, 'git merge --no-edit origin/main', { workdir: workflow.worktree, timeoutMs: 60_000, sandboxPolicy: policy })
    } catch (error) {
      // issue #26:合并冲突不再 abort 回滚丢弃现场。冲突状态(MERGE_HEAD +
      // 冲突标记)原样保留,转交返工 agent 解决;非冲突失败(如本地脏改动
      // 导致 git 自行中止)没有可保留的现场,照旧透传错误。
      if (await hasMergeConflict(ctx, workflow.worktree)) {
        const message = String(error instanceof Error ? error.message : error)
        // 冲突详情透传(issue #26):文件清单记日志、进时间线、随错误返回面板
        const files = await listConflictFiles(ctx, workflow.worktree)
        const suffix = conflictFileSuffix(files)
        const note = `合并 origin/main 冲突,现场已保留(未回滚),转交返工 agent 处理${suffix}`
        await appendLog(workflow.key, 'dev', `[clickvibe] ${note}`)
        const reloaded = await loadWorkflow(workflow.key)
        if (reloaded) {
          await appendEvent(reloaded, {
            kind: 'note',
            at: new Date().toISOString(),
            note,
          })
        }
        return {
          ok: false,
          conflict: true,
          files,
          error: `合并 origin/main 冲突,现场已保留:${message}${suffix}。可直接「按意见返工」,agent 会先解决冲突再修意见`,
        }
      }
      throw error
    }
    const head = await readWorktreeHead(ctx, workflow.worktree)
    await appendLog(workflow.key, 'dev', `[clickvibe] 同步完成,HEAD ${head ?? '未知'}`)
    // 记录同步事件到权威时间线(不改变开发/审查语义)
    const reloaded = await loadWorkflow(workflow.key)
    if (reloaded) {
      await appendEvent(reloaded, {
        kind: 'note',
        at: new Date().toISOString(),
        hash: head ?? undefined,
        note: 'worktree 已同步到 origin/main',
      })
    }
    return { ok: true, worktree: workflow.worktree, branch: workflow.branch, head }
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error)
    await appendLog(workflow.key, 'dev', `[clickvibe] 同步失败: ${message}`)
    return { ok: false, error: `同步失败: ${message}` }
  }
}

/** Start a review task on the dev branch with codex/claude. */
async function startReview(
  ctx: Context,
  payload: unknown,
): Promise<
  | { ok: true; taskId: string }
  | { ok: false; error: string }
> {
  const body = (payload ?? {}) as { url?: unknown; agent?: unknown }
  const url = String(body.url ?? '').trim()
  const parsedAgent = parseAgent(body.agent)
  if (parsedAgent === 'dryrun') return { ok: false, error: 'review 不支持 dryrun' }
  const agent: AgentKind = parsedAgent
  const parsed = parseUrl(url)
  if (!parsed) {
    return { ok: false, error: '请输入形如 https://github.com/owner/repo/issues/123 或 /pull/123 的链接' }
  }

  // 定位 workflow:issue URL → 直接按 key;PR URL → 按 prNumber 或 head 分支反查
  let workflow: IssueWorkflow | null = null
  if (parsed.kind === 'issue') {
    const key = issueKey(`${parsed.owner}/${parsed.repo}`, parsed.number)
    workflow = await loadWorkflow(key)
  } else {
    // PR:先按已记录的 prNumber 找,再按 head 分支找(可能尚未记录)
    const all = await loadAllWorkflows()
    const repoKey = `${parsed.owner}/${parsed.repo}`
    workflow = all.find((w) => w.repoKey === repoKey && w.prNumber === parsed.number) ?? null
    if (!workflow) {
      const prInfo = await fetchPrHeadBranch(ctx, parsed.owner, parsed.repo, parsed.number)
      if (prInfo) {
        workflow = all.find((w) => w.repoKey === repoKey && w.branch === prInfo) ?? null
      }
    }
  }

  if (!workflow || workflow.stage === 'idle' || workflow.stage === 'developing') {
    return { ok: false, error: '该 issue 尚未完成开发,无法 review' }
  }
  if (!existsSync(workflow.worktree)) {
    return { ok: false, error: `worktree 不存在: ${workflow.worktree}` }
  }
  const ownedReviewSession = resolveSessionForAgent(workflow, 'review', agent)
  const sessionId = ownedReviewSession.sessionId
  // Network reads happen only after this synchronous per-workflow reservation.
  // Concurrent requests may load the same workflow, but only one can create a
  // LiveTask; every follower reuses that exact task without refreshing again.
  let reservation: { task: LiveTask; created: boolean }
  try {
    reservation = reviewTaskGate.reserve(workflow.key, () => {
      const id = taskId('review')
      return createLiveTask(id, workflow.key, 'review', agent, sessionId)
    })
  } catch (error) {
    return { ok: false, error: String(error instanceof Error ? error.message : error) }
  }
  if (!reservation.created) return { ok: true, taskId: reservation.task.taskId }
  const live = reservation.task
  const resolvedSnapshot = await resolvePromptSnapshot(ctx, workflow)
  if ('error' in resolvedSnapshot) {
    finishTask(live, 'failed', 1)
    return { ok: false, error: resolvedSnapshot.error }
  }
  await resetLog(workflow.key, 'review')

  if (ownedReviewSession.invalid) {
    await saveWorkflow(workflow)
    pushTaskLine(live, '[clickvibe] review sessionId 归属缺失或与当前 agent 不一致,已清除并启动全新会话')
  }

  // 记录关联 PR(若 review 的是 PR 且未记录)
  if (parsed.kind === 'pr' && !workflow.prNumber) {
    workflow.prNumber = parsed.number
    await saveWorkflow(workflow)
  }

  // A prior run's file must never become the next run's verdict.
  try {
    await clearReviewResultFile(workflow.worktree)
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error)
    pushTaskLine(live, `[clickvibe] 无法清除旧 review 结论文件: ${message}`)
    finishTask(live, 'failed', 1)
    return { ok: false, error: `无法清除旧 review 结论文件: ${message}` }
  }

  workflow.reviewAgent = agent
  workflow.reviewTaskId = live.taskId
  workflow.stage = 'reviewing'
  await saveWorkflow(workflow)

  // 仅续接归属匹配的精确会话;旧状态无 owner 或跨 agent 时直接全新 review。
  const agentCommand = sessionId
    ? buildResumeAgentCommand(agent, sessionId)
    : buildFreshAgentCommand(agent)
  const prompt = await buildReviewPrompt(ctx, workflow, resolvedSnapshot, sessionId)

  pushTaskLine(live, `[clickvibe] 启动 ${agent} review${sessionId ? `(续会话 ${sessionId})` : ''}…`)
  attachAgentProcess(ctx, live, agentCommand, workflow.worktree, prompt, async (exitCode, newSessionId) => {
    pushTaskLine(live, `[clickvibe] review 结束,退出码 ${exitCode}`)
    if (live.status !== 'done' || exitCode !== 0) {
      const interrupted = await loadWorkflow(workflow.key)
      if (interrupted) {
        recordSessionId(interrupted, 'review', newSessionId, agent)
        interrupted.stage = 'review-ready'
        await saveWorkflow(interrupted)
      }
      return
    }
    const lines = await readLogTail(workflow.key, 'review', 200)
    const resolved = await loadReviewResult(workflow.worktree, lines)
    if (!resolved.result) {
      pushTaskLine(live, `[clickvibe] review 结论解析异常:${resolved.parseError ?? '原因未知'},需要重新 Review`)
      const invalid = await loadWorkflow(workflow.key)
      if (invalid) {
        recordSessionId(invalid, 'review', newSessionId, agent)
        invalid.reviewResult = null
        invalid.stage = 'review-ready'
        await saveWorkflow(invalid)
      }
      return
    }
    if (resolved.source === 'file') {
      pushTaskLine(live, `[clickvibe] review 结论来源: ${REVIEW_RESULT_RELATIVE_PATH}`)
    } else {
      pushTaskLine(
        live,
        `[clickvibe] review 结论文件不可用(${resolved.fileError ?? '原因未知'}),回退 ${resolved.source === 'stdout-json' ? 'stdout JSON' : 'stdout 表情行'}判定`,
      )
    }
    const { passed, issues } = resolved.result
    const reloaded = await loadWorkflow(workflow.key)
    if (reloaded) {
      reloaded.reviewResult = { passed, issues }
      reloaded.stage = passed ? 'passed' : 'review-ready' // 有问题 → 可回开发(rework)
      // 记录 review 会话 id(供下次 review 续会话)
      recordSessionId(reloaded, 'review', newSessionId, agent)
      const reviewedHead = await readWorktreeHead(ctx, workflow.worktree)
      const event: WorkflowEvent = {
        kind: 'review',
        at: new Date().toISOString(),
        hash: reviewedHead ?? undefined,
        verdict: { passed, issues },
        note: `${agent} review${passed ? ' 通过' : ` 发现 ${issues.length} 个问题`}`,
      }
      await appendEvent(reloaded, event)
      const issueNumber = parseUrl(reloaded.url)?.number ?? 'unknown'
      const body = buildReviewComment({
        commit: reviewedHead ?? 'unknown', issueNumber, passed, issues, agent, at: event.at,
      })
      await publishDeliveryComment(ctx, reloaded, event, body)
      if (event.publication?.status === 'posted' && event.publication.url && reloaded.reviewResult) {
        reloaded.reviewResult.commentUrl = event.publication.url
        await saveWorkflow(reloaded)
      }
    }
  }, sessionId ? {
    staleSessionId: sessionId,
    prepare: async () => {
      const reloaded = await loadWorkflow(workflow.key)
      if (reloaded && clearStaleSessionId(reloaded, 'review', sessionId)) await saveWorkflow(reloaded)
      return {
        command: buildFreshAgentCommand(agent),
        prompt: await buildReviewPrompt(ctx, workflow, resolvedSnapshot),
      }
    },
  } : undefined)

  return { ok: true, taskId: live.taskId }
}

/** Record one dev/rework delivery and publish its matching GitHub node. */
async function recordDevDelivery(
  ctx: Context,
  workflow: IssueWorkflow,
  agent: 'codex' | 'claude',
  head: string | null,
  fixedIssues: string[],
  kind: 'dev' | 'rework',
): Promise<void> {
  if (!workflow.prNumber) {
    const pr = await detectLinkedPr(ctx, workflow.repoKey, workflow.branch)
    if (pr) workflow.prNumber = pr
  }
  const event: WorkflowEvent = {
    kind,
    at: new Date().toISOString(),
    hash: head ?? undefined,
    fixed: fixedIssues.length,
    note: `${agent} 完成开发${kind === 'rework' ? '(按 review 意见返工)' : ''}`,
  }
  await appendEvent(workflow, event)
  const issueNumber = parseUrl(workflow.url)?.number ?? 'unknown'
  const body = buildDevComment({
    commit: head ?? 'unknown', issueNumber, fixedIssues, agent, at: event.at,
  })
  await publishDeliveryComment(ctx, workflow, event, body)
}

/** Publish a public delivery node without pretending a failed write succeeded. */
async function publishDeliveryComment(
  ctx: Context,
  workflow: IssueWorkflow,
  event: WorkflowEvent,
  body: string,
): Promise<void> {
  const target = workflow.prNumber ? 'pr' : 'issue'
  const targetUrl = workflow.prNumber
    ? `https://github.com/${workflow.repoKey}/pull/${workflow.prNumber}`
    : workflow.url
  const command = `gh issue comment ${shellQuote(targetUrl)} --body-file -`
  try {
    const output = await runCommand(ctx, command, { stdin: body, timeoutMs: 30000 })
    const commentUrl = extractGithubCommentUrl(output)
    event.publication = {
      target,
      status: 'posted',
      ...(commentUrl ? { url: commentUrl } : {}),
    }
    await appendLog(workflow.key, event.kind === 'review' ? 'review' : 'dev', `[clickvibe] 已发布 GitHub ${target === 'pr' ? 'PR' : 'Issue'} 评论${event.publication.url ? `: ${event.publication.url}` : ''}`)
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).slice(0, 500)
    event.publication = { target, status: 'failed', error: message }
    await appendLog(workflow.key, event.kind === 'review' ? 'review' : 'dev', `[clickvibe] GitHub 评论发布失败: ${message}`)
  }
  await saveWorkflow(workflow)
}

/** Resume (or continue) a dev session with an exact session id; `context`
 *  carries extra instructions (e.g. review issues for a rework).
 *  Exported for integration tests; the /resume route calls it. */
export async function resumeDevelop(
  ctx: Context,
  payload: unknown,
): Promise<{ ok: true; taskId: string } | { ok: false; error: string }> {
  const body = (payload ?? {}) as { url?: unknown; context?: unknown }
  const url = String(body.url ?? '').trim()
  const extraContext = typeof body.context === 'string' ? body.context.trim() : ''
  const parsed = parseUrl(url)
  if (!parsed || parsed.kind !== 'issue') {
    return { ok: false, error: '请输入形如 https://github.com/owner/repo/issues/123 的链接' }
  }
  const key = issueKey(`${parsed.owner}/${parsed.repo}`, parsed.number)
  const workflow = await loadWorkflow(key)
  if (!workflow || !workflow.devTaskId) {
    return { ok: false, error: '该 issue 尚无开发记录,无法续会话' }
  }

  const oldLive = liveTasks.get(workflow.devTaskId)
  if (oldLive && !oldLive.closed) {
    return { ok: true, taskId: oldLive.taskId }
  }

  const agent = workflow.devAgent ?? 'codex'
  const ownedDevSession = resolveSessionForAgent(workflow, 'dev', agent)
  const sessionId = ownedDevSession.sessionId
  // Reserve synchronously before the snapshot's GitHub awaits. This is the
  // per-workflow invariant preventing double-clicked resume requests from
  // launching multiple agents against the same git worktree.
  let reservation: { task: LiveTask; created: boolean }
  try {
    reservation = resumeTaskGate.reserve(workflow.key, () => {
      const id = taskId('dev')
      return createLiveTask(id, workflow.key, 'dev', agent, sessionId)
    })
  } catch (error) {
    return { ok: false, error: String(error instanceof Error ? error.message : error) }
  }
  if (!reservation.created) return { ok: true, taskId: reservation.task.taskId }
  const live = reservation.task
  const resolvedSnapshot = await resolvePromptSnapshot(ctx, workflow)
  if ('error' in resolvedSnapshot) {
    finishTask(live, 'failed', 1)
    return { ok: false, error: resolvedSnapshot.error }
  }
  await resetLog(workflow.key, 'dev')
  workflow.devTaskId = live.taskId
  workflow.devInterrupted = false
  workflow.stage = 'developing'
  await saveWorkflow(workflow)
  if (ownedDevSession.invalid) {
    pushTaskLine(live, '[clickvibe] dev sessionId 归属缺失或与当前 agent 不一致,已清除并启动全新会话')
  }

  // 用精确会话 id 续会话(不能用 --last/--continue:worktree 里可能有多个
  // agent 会话,--last 续的是"最近那个",不一定是我们这个)。
  // sessionId 缺失时回退 --last/--continue(尽力而为)。
  const command = ownedDevSession.invalid
    ? buildFreshAgentCommand(agent)
    : buildResumeAgentCommand(agent, sessionId)
  // 续会话前也同步远端(并行开发时 base 会变化)
  try {
    await runCommand(ctx, 'git fetch origin', {
      workdir: workflow.worktree,
      timeoutMs: 30000,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: workflow.worktree },
    })
    pushTaskLine(live, `[clickvibe] 已同步远端(origin)`)
  } catch (e) {
    pushTaskLine(live, `[clickvibe] git fetch 失败(继续): ${String(e instanceof Error ? e.message : e)}`)
  }

  // issue #26:worktree 落后基线或处于冲突合并中时,把「合并 main、解决冲突」
  // 作为前置指令交给 agent(danger-full-access 有能力处理),review 意见不再
  // 被同步门禁挡住送不进来。
  const mergePreface = await buildMergePreface(ctx, workflow.worktree, workflowBaseBranch(workflow.baseRef))

  const prompt = await buildResumePrompt(
    ctx,
    workflow,
    resolvedSnapshot,
    extraContext,
    mergePreface,
    sessionId,
  )

  pushTaskLine(live, `[clickvibe] 恢复 ${agent} 会话${sessionId ? `(${sessionId})` : ''}…`)
  attachAgentProcess(ctx, live, command, workflow.worktree, prompt, async (exitCode, newSessionId) => {
    pushTaskLine(live, `[clickvibe] ${agent} 恢复结束,退出码 ${exitCode}`)
    const reloaded = await loadWorkflow(workflow.key)
    if (reloaded) {
      const fixedIssues = reloaded.reviewResult?.passed === false ? [...reloaded.reviewResult.issues] : []
      if (applyDevRunOutcome(reloaded, live.status, exitCode, newSessionId, agent)) {
        // rework 完成:旧的 review 结论已归档到 events,回到"待 review",
        // 不能继续显示"Review 未通过"让用户无限重复点
        const head = await readWorktreeHead(ctx, workflow.worktree)
        await recordDevDelivery(ctx, reloaded, agent, head, fixedIssues, 'rework')
      }
      await saveWorkflow(reloaded)
    }
  }, sessionId ? {
    staleSessionId: sessionId,
    prepare: async () => {
      const reloaded = await loadWorkflow(workflow.key)
      if (reloaded && clearStaleSessionId(reloaded, 'dev', sessionId)) await saveWorkflow(reloaded)
      return {
        command: buildFreshAgentCommand(agent),
        prompt: await buildResumePrompt(ctx, workflow, resolvedSnapshot, extraContext, mergePreface, null),
      }
    },
  } : undefined)

  return { ok: true, taskId: live.taskId }
}
