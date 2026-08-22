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
import { join, basename, dirname, resolve, relative, isAbsolute } from 'node:path'
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
import { checkIssueContract, type IssueContractCheck } from './issue-contract.ts'
import {
  deriveNextAction,
  deriveWorkflowStatus,
  workflowBaseBranch,
  type IssueContractStatus,
  type IssueContractUnknownReason,
  type NextAction,
  type WorkflowFacts,
} from './state-view.ts'
import {
  appendEvent,
  appendLog,
  applyDevRunOutcome,
  archiveWorkflow,
  clearStaleSessionId,
  issueKey,
  issueBodyHash,
  loadAllArchivedWorkflows,
  loadAllWorkflows,
  loadWorkflow,
  readLogHistory,
  readLogTail,
  recordSessionId,
  resetLog,
  resolveSessionForAgent,
  saveWorkflow,
  saveWorkflowStrict,
  type IssueWorkflow,
  type IssueContractSnapshot,
  type WorkflowEvent,
} from './state.ts'
import { buildDevComment, buildReviewComment } from './delivery-comment.ts'
import { extractGithubCommentUrl } from './delivery-publication.ts'
import { approvePassedReview } from './review-approval.ts'
import {
  decodeLiveLogLine,
  encodeLiveLogEvent,
  type LiveLogEvent,
} from './live-output.ts'
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
import {
  RepositoryFreshnessGate,
  RepositoryRefreshClock,
  aggregateRepositoryFreshness,
  type RepositoryFreshness,
} from './repo-freshness.ts'
import {
  deriveReviewDecision,
  githubErrorMessage,
  githubRest,
  isGithubRateLimitError,
} from './github-rest.ts'

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

interface ClickVibeConfig {
  repos: Record<string, string>
  worktreeRoot: string
  /** Remote-ref refresh interval for read paths. Clamped to 30-60 seconds. */
  fetchTtlSeconds?: number
}

const DEFAULT_FETCH_TTL_SECONDS = 45
const READ_FETCH_WAIT_MS = 2_000
const repositoryFreshness = new RepositoryFreshnessGate()
const dependencyRefreshClock = new RepositoryRefreshClock()

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
const mergingWorkflows = new Set<string>()
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
  const body = (payload ?? {}) as { url?: unknown; agent?: unknown; context?: unknown; target?: unknown }
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

function githubAwareStatus(result: { ok: boolean; error?: string }, success = 200, failure = 400): number {
  if (result.ok) return success
  return result.error?.startsWith('GitHub 额度已用完,约 ') ? 429 : failure
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

function fetchTtlMs(config: ClickVibeConfig): number {
  const seconds = Number(config.fetchTtlSeconds ?? DEFAULT_FETCH_TTL_SECONDS)
  return Math.min(60, Math.max(30, Number.isFinite(seconds) ? seconds : DEFAULT_FETCH_TTL_SECONDS)) * 1000
}

async function ensureConfiguredRepoFresh(
  ctx: Context,
  config: ClickVibeConfig,
  repoKey: string,
  force = false,
): Promise<RepositoryFreshness | null> {
  const configuredPath = config.repos[repoKey]
  if (!configuredPath) return null
  const repoPath = resolve(expandHome(configuredPath))
  if (!existsSync(repoPath)) return null
  return repositoryFreshness.ensureWithin(repoPath, fetchTtlMs(config), async () => {
    await runCommand(ctx, 'git fetch origin --prune', {
      workdir: repoPath,
      timeoutMs: 30_000,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: repoPath },
    })
  }, READ_FETCH_WAIT_MS, force)
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
    const owner = repoKey.split('/')[0]
    const prs = await githubRest(ctx).json<Array<{ number?: number }>>(
      `repos/${repoKey}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=1`,
    )
    return prs[0]?.number === undefined ? null : String(prs[0].number)
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
  reviewedIssueBodyHash: string | null
  currentIssueBodyHash: string | null
  reviewedIssueUpdatedAt: string | null
  currentIssueUpdatedAt: string | null
  issueContractCurrent: boolean
  issueContractStatus: IssueContractStatus
  issueContractUnknownReason: IssueContractUnknownReason
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
  headRefOid?: string
  baseRefName?: string
}

interface GithubUserRest { login?: string }
interface GithubLabelRest { name?: string; color?: string }
interface GithubMilestoneRest { title?: string; number?: number }
interface GithubCommentRest {
  user?: GithubUserRest | null
  body?: string | null
  created_at?: string
  updated_at?: string
}
interface GithubReviewRest {
  id?: number
  user?: GithubUserRest | null
  body?: string | null
  state?: string
  submitted_at?: string | null
}
interface GithubIssueDetailRest {
  number: number
  title: string
  state: string
  state_reason?: string | null
  user?: GithubUserRest | null
  created_at?: string
  updated_at?: string
  closed_at?: string | null
  body?: string | null
  html_url: string
  labels?: GithubLabelRest[]
  assignees?: GithubUserRest[]
  milestone?: GithubMilestoneRest | null
}
interface GithubPrDetailRest extends GithubIssueDetailRest {
  merged_at?: string | null
  additions?: number
  deletions?: number
  changed_files?: number
  commits?: number
  draft?: boolean
  mergeable?: boolean | null
  mergeable_state?: string
  base?: { ref?: string; sha?: string }
  head?: { ref?: string; sha?: string }
}

function mapComments(comments: GithubCommentRest[]): Array<{ author: { login: string }; createdAt: string; updatedAt: string; body: string }> {
  return comments.map((comment) => ({
    author: { login: String(comment.user?.login ?? 'unknown') },
    createdAt: String(comment.created_at ?? ''),
    updatedAt: String(comment.updated_at ?? ''),
    body: String(comment.body ?? ''),
  }))
}

function mapIssueDetail(issue: GithubIssueDetailRest, comments: GithubCommentRest[]): Record<string, unknown> {
  return {
    number: issue.number,
    title: issue.title,
    state: String(issue.state).toUpperCase(),
    stateReason: issue.state_reason ?? null,
    author: { login: String(issue.user?.login ?? 'unknown') },
    createdAt: issue.created_at ?? '',
    updatedAt: issue.updated_at ?? '',
    closedAt: issue.closed_at ?? null,
    body: issue.body ?? '',
    url: issue.html_url,
    labels: (issue.labels ?? []).map((label) => ({ name: String(label.name ?? ''), color: label.color })),
    assignees: (issue.assignees ?? []).map((user) => ({ login: String(user.login ?? '') })),
    milestone: issue.milestone ? { title: String(issue.milestone.title ?? ''), number: issue.milestone.number } : null,
    comments: mapComments(comments),
    reactionGroups: [],
    isPinned: false,
  }
}

function mapPrDetail(
  pr: GithubPrDetailRest,
  comments: GithubCommentRest[],
  reviews: GithubReviewRest[],
  requested: { users?: GithubUserRest[]; teams?: Array<{ name?: string; slug?: string }> },
): Record<string, unknown> {
  return {
    ...mapIssueDetail(pr, comments),
    state: pr.merged_at ? 'MERGED' : String(pr.state).toUpperCase(),
    mergedAt: pr.merged_at ?? null,
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    changedFiles: pr.changed_files ?? 0,
    commits: Array.from({ length: Math.max(0, pr.commits ?? 0) }, () => ({})),
    isDraft: pr.draft ?? false,
    mergeable: pr.mergeable === null || pr.mergeable === undefined ? 'UNKNOWN' : pr.mergeable ? 'MERGEABLE' : 'CONFLICTING',
    mergeStateStatus: String(pr.mergeable_state ?? 'unknown').toUpperCase(),
    baseRefName: String(pr.base?.ref ?? ''),
    headRefName: String(pr.head?.ref ?? ''),
    reviews: reviews.map((review) => ({
      author: { login: String(review.user?.login ?? 'unknown') },
      body: String(review.body ?? ''),
      state: String(review.state ?? '').toUpperCase(),
      submittedAt: review.submitted_at ?? null,
    })),
    reviewRequests: [
      ...(requested.users ?? []).map((user) => ({ login: String(user.login ?? '') })),
      ...(requested.teams ?? []).map((team) => ({ name: String(team.name ?? team.slug ?? '') })),
    ],
    reviewDecision: deriveReviewDecision(reviews),
  }
}

async function fetchPrRestDetail(ctx: Context, repoKey: string, number: string | number, force = false, timeoutMs?: number): Promise<GithubPrDetailRest> {
  const rest = githubRest(ctx)
  const key = `${repoKey}/pulls/${number}`
  return rest.cachedResource(key, rest.resourceVersion(key), () =>
    rest.json<GithubPrDetailRest>(`repos/${repoKey}/pulls/${number}`, undefined, timeoutMs), {
      force,
      versionOf: (pr) => pr.updated_at,
    })
}

async function fetchPrRestReviews(ctx: Context, repoKey: string, number: string | number, timeoutMs?: number): Promise<GithubReviewRest[]> {
  const rest = githubRest(ctx)
  const resourceKey = `${repoKey}/pulls/${number}`
  return rest.cachedResource(`${resourceKey}/reviews`, rest.resourceVersion(resourceKey), () =>
    rest.paginate<GithubReviewRest>(`repos/${repoKey}/pulls/${number}/reviews`, undefined, timeoutMs))
}

async function fetchIssueRestDetail(ctx: Context, repoKey: string, number: string | number, force = false, timeoutMs?: number): Promise<GithubIssueDetailRest> {
  const rest = githubRest(ctx)
  const key = `${repoKey}/issues/${number}`
  return rest.cachedResource(key, rest.resourceVersion(key), () =>
    rest.json<GithubIssueDetailRest>(`repos/${repoKey}/issues/${number}`, undefined, timeoutMs), {
      force,
      versionOf: (issue) => issue.updated_at,
    })
}

interface DeriveOptions {
  pr?: GithubPrFact | null
  prStatusKnown?: boolean
  branchExists?: boolean
  hasCommits?: boolean
  defaultBranch?: string
  issueContract?: IssueContractSnapshot | null
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
  let lastReviewContract: IssueContractSnapshot | null = null
  for (const ev of events) {
    if (ev.kind === 'dev' || ev.kind === 'rework') lastDevHash = ev.hash ?? lastDevHash
    if (ev.kind === 'review') {
      lastReviewHash = ev.hash ?? lastReviewHash
      lastReviewContract = ev.issueContract ?? null
    }
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
  const currentIssueContract = options.issueContract ?? null
  // updatedAt 是审计证据；正文 hash 才是契约身份，避免评论/标签更新误杀结论。
  const issueContractStatus: IssueContractStatus = lastReviewContract === null
    ? 'unknown'
    : currentIssueContract === null
      ? 'unknown'
      : lastReviewContract.bodyHash === currentIssueContract.bodyHash
        ? 'current'
        : 'changed'
  const issueContractUnknownReason: IssueContractUnknownReason = issueContractStatus !== 'unknown'
    ? null
    : lastReviewContract === null
      ? 'missing-review-snapshot'
      : 'current-contract-unavailable'
  const issueContractCurrent = issueContractStatus === 'current'
  // 结论同时绑定当前 HEAD 与验收契约；旧事件缺契约快照时 fail closed。
  const verdictCurrent = reviewPassed !== null
    && head !== null
    && reviewedHash !== null
    && head === reviewedHash
    && issueContractCurrent

  const devLive = workflow.devTaskId ? liveTasks.get(workflow.devTaskId) : undefined
  const reviewLive = workflow.reviewTaskId ? liveTasks.get(workflow.reviewTaskId) : undefined
  const taskRunning = (devLive !== undefined && !devLive.closed) || (reviewLive !== undefined && !reviewLive.closed)

  const facts: WorkflowFacts = {
    issueOpen: (workflow.issueState ?? 'OPEN') !== 'CLOSED',
    prMerged: workflow.delivery !== undefined
      || options.pr?.state === 'MERGED'
      || options.pr?.mergedAt !== null && options.pr?.mergedAt !== undefined,
    cleanupPending: workflow.delivery !== undefined && workflow.delivery.status !== 'archived',
    prState: options.pr?.state ?? null,
    prStatusKnown: options.prStatusKnown,
    prNumber: options.pr?.number ?? workflowPrNumber,
    stage: workflow.stage,
    devInterrupted: workflow.devInterrupted,
    taskRunning,
    head,
    reviewedHash,
    reviewPassed,
    issueContractStatus,
    issueContractUnknownReason,
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
      reviewedIssueBodyHash: lastReviewContract?.bodyHash ?? null,
      currentIssueBodyHash: currentIssueContract?.bodyHash ?? null,
      reviewedIssueUpdatedAt: lastReviewContract?.updatedAt ?? null,
      currentIssueUpdatedAt: currentIssueContract?.updatedAt ?? null,
      issueContractCurrent,
      issueContractStatus,
      issueContractUnknownReason,
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
      const knownMethods = new Set(['fetch', 'projects', 'repo/issues', 'state', 'authorize', 'develop', 'develop/poll', 'history', 'stream', 'review', 'resume', 'stop', 'sync', 'merge'])
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
        writeJson(res, githubAwareStatus(result), result)
        return
      }
      if (method === 'projects') {
        const result = await listProjects()
        writeJson(res, 200, result)
        return
      }
      if (method === 'repo/issues') {
        const result = await fetchRepositoryIssues(ctx, payload)
        writeJson(res, githubAwareStatus(result), result)
        return
      }
      if (method === 'state') {
        const filter = payload as { url?: unknown; repoKey?: unknown; forceRefresh?: unknown } | undefined
        const url = String(filter?.url ?? '')
        const repoKey = String(filter?.repoKey ?? '')
        const config = await loadConfig()
        const active = await loadAllWorkflows()
        const archived = url === '' ? [] : await loadAllArchivedWorkflows()
        const workflows = [...active, ...archived].filter((workflow) =>
          (url === '' || workflow.url === url) && (repoKey === '' || workflow.repoKey === repoKey),
        )
        const parsedRepo = parseUrl(url)
        const repoKeys = new Set(
          repoKey ? [repoKey]
            : parsedRepo ? [`${parsedRepo.owner}/${parsedRepo.repo}`]
              : workflows.map((workflow) => workflow.repoKey),
        )
        try {
          for (const key of repoKeys) {
            const circuitError = githubRest(ctx).rateLimitError()
            if (circuitError) throw circuitError
          }
          const freshnesses = (await Promise.all([...repoKeys].map((key) =>
            ensureConfiguredRepoFresh(ctx, config, key, filter?.forceRefresh === true),
          ))).filter((value): value is RepositoryFreshness => value !== null)
          const dependenciesRefreshDue = [...repoKeys]
            .map((key) => dependencyRefreshClock.take(key, fetchTtlMs(config), filter?.forceRefresh === true))
            .some(Boolean)
          const enriched = await enrichWorkflowStates(ctx, workflows, config)
          const freshness = aggregateRepositoryFreshness(freshnesses)
          writeJson(res, 200, { ok: true, workflows: enriched, freshness, dependenciesRefreshDue })
        } catch (error) {
          const message = isGithubRateLimitError(error) ? error.message : `状态刷新失败: ${githubErrorMessage(error)}`
          writeJson(res, isGithubRateLimitError(error) ? 429 : 400, { ok: false, error: message })
        }
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
      if (method === 'merge') {
        const securityError = privilegedRequestError(req)
        if (securityError) {
          writeJson(res, 403, { ok: false, error: securityError })
          return
        }
        try {
          if (!consumeAuthorization('merge', payload)) {
            writeJson(res, 403, { ok: false, error: '合并授权无效、已使用或已过期,请重新预览确认' })
            return
          }
        } catch (error) {
          writeJson(res, 400, { ok: false, error: String(error instanceof Error ? error.message : error) })
          return
        }
        const result = await mergeAndCleanup(ctx, payload)
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
  includeReviews = true,
): Promise<GithubPrLookup> {
  const hasPrNumber = prNumber !== null && prNumber !== undefined
  try {
    const rest = githubRest(ctx)
    let raw: GithubPrDetailRest | undefined
    if (hasPrNumber) {
      raw = await fetchPrRestDetail(ctx, repoKey, String(prNumber), false, 5_000)
    } else {
      const owner = repoKey.split('/')[0]
      raw = await rest.cachedResource(`${repoKey}/pulls/head/${branch}`, null, async () =>
        (await rest.json<GithubPrDetailRest[]>(
          `repos/${repoKey}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=1`,
          undefined,
          5_000,
        ))[0])
    }
    if (!raw) return { known: true, pr: null }
    rest.rememberVersion(`${repoKey}/pulls/${raw.number}`, raw.updated_at)
    // lists 之外的回源刷新默认带 reviews 推导 reviewDecision;已有本地 verdict 时
    // 跳过,省掉一轮 pulls/{n}/reviews 请求(列表路径由调用方按需传入)。
    const reviews = includeReviews ? await fetchPrRestReviews(ctx, repoKey, raw.number, 5_000) : []
    return {
      known: true,
      pr: {
        number: String(raw.number),
        state: raw.merged_at ? 'MERGED' : String(raw.state).toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN',
        mergedAt: raw.merged_at ?? null,
        headRefName: String(raw.head?.ref ?? branch),
        url: String(raw.html_url ?? `https://github.com/${repoKey}/pull/${raw.number}`),
        reviewDecision: deriveReviewDecision(reviews),
        headRefOid: raw.head?.sha ? String(raw.head.sha) : undefined,
        baseRefName: raw.base?.ref ? String(raw.base.ref) : undefined,
      },
    }
  } catch (error) {
    if (isGithubRateLimitError(error)) throw error
    return { known: false, pr: null }
  }
}

async function fetchGithubIssueState(
  ctx: Context,
  url: string,
): Promise<'OPEN' | 'CLOSED' | null> {
  try {
    const parsed = parseUrl(url)
    if (!parsed || parsed.kind !== 'issue') return null
    const issue = await fetchIssueRestDetail(ctx, `${parsed.owner}/${parsed.repo}`, parsed.number, false, 5_000)
    return String(issue.state).toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN'
  } catch (error) {
    if (isGithubRateLimitError(error)) throw error
    return null
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

/** Enrich every stored workflow concurrently; parallel GitHub reads cost at most one 5s window. */
export async function enrichWorkflowStates(
  ctx: Context,
  workflows: IssueWorkflow[],
  configOverride?: ClickVibeConfig,
): Promise<Array<IssueWorkflow & { derived: WorkflowDerived }>> {
  const config = configOverride ?? await loadConfig()
  return Promise.all(workflows.map(async (workflow) => {
    const [prLookup, branchFacts, currentIssue, liveIssueState] = await Promise.all([
      fetchGithubPrFact(ctx, workflow.repoKey, workflow.branch, workflow.prNumber),
      readConfiguredBranchFacts(ctx, config, workflow),
      fetchIssueContract(ctx, workflow.url).catch(() => null),
      fetchGithubIssueState(ctx, workflow.url),
    ])
    return deriveWorkflowState(ctx, {
      ...workflow,
      issueState: liveIssueState
        ?? (currentIssue?.state === 'OPEN' || currentIssue?.state === 'CLOSED' ? currentIssue.state : workflow.issueState),
    }, {
      pr: prLookup.pr,
      prStatusKnown: workflow.prNumber ? prLookup.known && prLookup.pr !== null : prLookup.known,
      issueContract: currentIssue?.contract ?? null,
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
  contract: IssueContractCheck
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
  updated_at?: string
  html_url: string
  head?: { ref?: string }
}

interface RepositoryGithubSnapshot {
  issues: RepositoryIssueRest[]
  pulls: RepositoryPrRest[]
}

async function fetchGithubRepoSnapshot(
  ctx: Context,
  repoKey: string,
  ttlMs: number,
  force: boolean,
): Promise<RepositoryGithubSnapshot> {
  const rest = githubRest(ctx)
  return rest.cachedAggregate(`repo:${repoKey}`, ttlMs, force, async () => {
    const [issues, pulls] = await Promise.all([
      rest.paginate<RepositoryIssueRest>(`repos/${repoKey}/issues?state=all`),
      rest.paginate<RepositoryPrRest>(`repos/${repoKey}/pulls?state=all`),
    ])
    return { issues, pulls }
  })
}

export async function fetchRepositoryIssues(
  ctx: Context,
  payload: unknown,
  overrides: { config?: ClickVibeConfig; workflows?: IssueWorkflow[] } = {},
): Promise<
  | { ok: true; repoKey: string; issues: unknown[]; freshness: RepositoryFreshness | null }
  | { ok: false; error: string }
> {
  const repoKey = String((payload as { repoKey?: unknown } | undefined)?.repoKey ?? '').trim()
  const config = overrides.config ?? await loadConfig()
  const configuredPath = config.repos[repoKey]
  if (!configuredPath) return { ok: false, error: `未配置项目 ${repoKey}` }
  const forceRefresh = (payload as { forceRefresh?: unknown } | undefined)?.forceRefresh === true
  const freshness = await ensureConfiguredRepoFresh(ctx, config, repoKey, forceRefresh)

  try {
    const rest = githubRest(ctx)
    const [githubSnapshot, allWorkflows] = await Promise.all([
      fetchGithubRepoSnapshot(ctx, repoKey, fetchTtlMs(config), forceRefresh),
      overrides.workflows ? Promise.resolve(overrides.workflows) : loadAllWorkflows(),
    ])
    const allIssues = githubSnapshot.issues
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
        contract: checkIssueContract(issue.body ?? ''),
      }))
    const prs = githubSnapshot.pulls.map<GithubPrFact>((pr) => ({
      number: String(pr.number),
      state: pr.merged_at ? 'MERGED' : pr.state.toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN',
      mergedAt: pr.merged_at,
      headRefName: String(pr.head?.ref ?? ''),
      url: pr.html_url,
      reviewDecision: null,
    }))
    for (const issue of allIssues) rest.rememberVersion(`${repoKey}/issues/${issue.number}`, issue.updatedAt)
    for (const pr of githubSnapshot.pulls) rest.rememberVersion(`${repoKey}/pulls/${pr.number}`, pr.updated_at)

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
    const prByNumber = new Map<string, GithubPrFact>()
    for (const raw of prs) {
      if (!prByNumber.has(String(raw.number))) prByNumber.set(String(raw.number), { ...raw, number: String(raw.number) })
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

    const activeIssues = allIssues.filter((issue) => {
      if (String(issue.state).toUpperCase() === 'OPEN') return true
      const workflow = workflowByNumber.get(issue.number)
      return workflow?.delivery !== undefined && workflow.delivery.status !== 'archived'
    })
    const issues = await Promise.all(activeIssues.map(async (issue) => {
      const existing = workflowByNumber.get(issue.number)
      const branch = existing?.branch ?? `${project}-issue-${issue.number}`
      const worktree = existing?.worktree ?? join(config.worktreeRoot, project, branch)
      const branchExists = refs.has(branch) || refs.has(`origin/${branch}`)
      // 列表页优先消费快照事实:pulls?state=all 已含全部(含已合并/已关闭)PR,
      // 冷启动不再为每个 workflow 打 pulls/{n}(+reviews) 网络请求,首屏秒开;
      // 只有快照缺失该编号(分支重命名/新 PR 未入快照)才按编号回源刷新,
      // 沿用"编号刷新 + 刷新失败关门"的既有语义(tests/routes.test.ts)。
      // 已有持久化 reviewResult 时跳过 reviews 详情,verdict 以本地为准。
      const snapshotPr = existing?.prNumber ? prByNumber.get(String(existing.prNumber)) : null
      let pr: GithubPrFact | null
      let prStatusKnown: boolean
      if (snapshotPr) {
        pr = snapshotPr
        prStatusKnown = true
      } else if (existing?.prNumber) {
        const lookup = await fetchGithubPrFact(ctx, repoKey, branch, existing.prNumber, existing.reviewResult === null)
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
      workflow.issueState = String(issue.state).toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN'
      const derived = await deriveWorkflowState(ctx, workflow, {
        pr,
        prStatusKnown,
        branchExists,
        hasCommits,
        defaultBranch,
        issueContract: {
          bodyHash: issueBodyHash(issue.body),
          updatedAt: issue.updatedAt ?? '',
        },
      })
      const blockedBy = parseDependencies(issue.body).map((number) => {
        const dependency = issueByNumber.get(number)
        return { number, title: dependency?.title ?? '', state: String(dependency?.state ?? 'UNKNOWN').toUpperCase() }
      })
      return { ...issue, blockedBy, workflow: derived, contract: checkIssueContract(issue.body ?? '') }
    }))
    dependencyRefreshClock.mark(repoKey)
    return { ok: true, repoKey, issues, freshness }
  } catch (error) {
    return { ok: false, error: isGithubRateLimitError(error) ? error.message : `项目 issue 抓取失败: ${githubErrorMessage(error)}` }
  }
}

/** Validate the URL and run gh, returning the { ok, ... } envelope. */
async function fetchIssue(
  ctx: Context,
  payload: unknown,
): Promise<
  | { ok: true; data: { kind: 'issue' | 'pr'; item: unknown; timeline?: unknown; dependencies?: { blockedBy: IssueDependency[]; blocking: IssueDependency[] } }; dependencyError?: string }
  | { ok: false; error: string }
> {
  const url = String((payload as { url?: unknown } | undefined)?.url ?? '').trim()
  const parsed = parseUrl(url)
  if (!parsed) {
    return { ok: false, error: '请输入形如 https://github.com/owner/repo/issues/123 或 /pull/123 的链接' }
  }
  const isPR = parsed.kind === 'pr'
  try {
    const repoKey = `${parsed.owner}/${parsed.repo}`
    const rest = githubRest(ctx)
    const resourceKey = `${repoKey}/${isPR ? 'pulls' : 'issues'}/${parsed.number}`
    const panelCacheKey = `${resourceKey}/panel`
    const forceRefresh = (payload as { forceRefresh?: unknown } | undefined)?.forceRefresh === true
    const detail = await rest.cachedResource(panelCacheKey, rest.resourceVersion(resourceKey), async () => {
      if (isPR) {
        const pr = await fetchPrRestDetail(ctx, repoKey, parsed.number, forceRefresh, 20_000)
        const [comments, reviews, requested] = await Promise.all([
          rest.paginate<GithubCommentRest>(`repos/${repoKey}/issues/${parsed.number}/comments`, undefined, 20_000),
          fetchPrRestReviews(ctx, repoKey, parsed.number, 20_000),
          rest.json<{ users?: GithubUserRest[]; teams?: Array<{ name?: string; slug?: string }> }>(`repos/${repoKey}/pulls/${parsed.number}/requested_reviewers`, undefined, 20_000),
        ])
        return { item: mapPrDetail(pr, comments, reviews, requested), updatedAt: pr.updated_at ?? '' }
      }
      const issue = await fetchIssueRestDetail(ctx, repoKey, parsed.number, forceRefresh, 20_000)
      const [comments, timeline] = await Promise.all([
        rest.paginate<GithubCommentRest>(`repos/${repoKey}/issues/${parsed.number}/comments`, undefined, 20_000),
        fetchTimeline(ctx, parsed.owner, parsed.repo, parsed.number),
      ])
      return { item: mapIssueDetail(issue, comments), timeline, updatedAt: issue.updated_at ?? '' }
    }, {
      force: forceRefresh,
      ttlMs: fetchTtlMs(await loadConfig()),
      versionOf: (value) => value.updatedAt,
    })
    const data: { kind: 'issue' | 'pr'; item: unknown; timeline?: unknown; dependencies?: { blockedBy: IssueDependency[]; blocking: IssueDependency[] } } = {
      kind: parsed.kind,
      item: detail.item,
      ...(detail.timeline ? { timeline: detail.timeline } : {}),
    }
    let dependencyError: string | undefined
    // issue 额外拉 timeline,提取关联事件(linked PR/commit)——GitHub UI 的
    // "linked a pull request" 就来自 cross-referenced 事件
    if (!isPR) {
      // 依赖图:blockedBy 来自本 issue 正文,blocking 扫描 repo 内其它 issue
      const dependencyResult = await fetchDependencies(ctx, parsed, detail.item as { body?: unknown }, forceRefresh)
      if (dependencyResult.ok) {
        data.dependencies = dependencyResult.dependencies
        dependencyRefreshClock.mark(`${parsed.owner}/${parsed.repo}`)
      } else {
        dependencyError = dependencyResult.error
      }
    }
    return { ok: true, data, ...(dependencyError ? { dependencyError } : {}) }
  } catch (error) {
    return { ok: false, error: isGithubRateLimitError(error) ? error.message : `抓取异常: ${githubErrorMessage(error)}` }
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

interface ReviewIssueContract {
  title: string
  body: string
  state: string
  contract: IssueContractSnapshot
}

/** Read the exact Issue contract that one review run evaluates. */
async function fetchIssueContract(ctx: Context, url: string, force = false): Promise<ReviewIssueContract> {
  const parsed = parseUrl(url)
  if (!parsed || parsed.kind !== 'issue') throw new Error('review workflow 缺少有效 Issue URL')
  const item = await fetchIssueRestDetail(ctx, `${parsed.owner}/${parsed.repo}`, parsed.number, force, 5_000)
  const body = String(item.body ?? '')
  return {
    title: String(item.title ?? ''),
    body,
    state: String(item.state ?? '').toUpperCase(),
    contract: {
      bodyHash: issueBodyHash(body),
      updatedAt: String(item.updated_at ?? ''),
    },
  }
}

function latestPassingReview(workflow: IssueWorkflow): WorkflowEvent | null {
  const latestReview = [...(workflow.events ?? [])].reverse().find((event) => event.kind === 'review') ?? null
  if (!latestReview?.verdict?.passed || !workflow.reviewResult?.passed) return null
  return latestReview
}

function latestPassingReviewHash(workflow: IssueWorkflow): string | null {
  return latestPassingReview(workflow)?.hash?.trim() || null
}

function sameCommitHash(reviewedHash: string, prHead: string): boolean {
  const reviewed = reviewedHash.trim().toLowerCase()
  const head = prHead.trim().toLowerCase()
  return reviewed.length >= 7 && head.length >= 7
    && (reviewed === head || head.startsWith(reviewed) || reviewed.startsWith(head))
}

/**
 * 判定实时 PR HEAD 是否为「R 与 origin/main 的纯同步合并」(issue #48):
 * H 必须是恰好两个父提交的 merge commit,其中一个父提交精确等于被审提交 R
 * (R 的任何后代 —— 分支侧新提交、叠加 merge —— 都不放行),另一个父提交位于
 * 当前 origin/main 的历史上,且 H 的树与 git merge-tree 对两父的自动合并结果
 * 完全一致 —— 任何手工冲突决断(哪怕一行)都会破坏该等价。
 * 任一 git 事实无法核实时按不满足处理(fail closed)。
 */
export async function isSyncEquivalentMerge(
  ctx: Context,
  worktree: string,
  reviewedHash: string,
  prHead: string,
): Promise<boolean> {
  if (!existsSync(worktree)) return false
  const policy = { mode: 'danger-full-access' as const, workspaceRoot: worktree }
  const gitOk = async (args: string, timeoutMs = 30_000): Promise<boolean> => {
    try {
      await runCommand(ctx, `git ${args}`, { workdir: worktree, timeoutMs, sandboxPolicy: policy })
      return true
    } catch {
      return false
    }
  }
  const gitOut = async (args: string): Promise<string | null> => {
    try {
      const output = await runCommand(ctx, `git ${args}`, { workdir: worktree, timeoutMs: 30_000, sandboxPolicy: policy })
      return output.trim() || null
    } catch {
      return null
    }
  }
  // 先同步远端:被检的 H(远端分支 HEAD)与最新 origin/main 对象必须在本地可解析
  if (!await gitOk('fetch origin --prune', 60_000)) return false
  const head = await gitOut(`rev-parse --verify ${shellQuote(`${prHead}^{commit}`)}`)
  const reviewed = await gitOut(`rev-parse --verify ${shellQuote(`${reviewedHash}^{commit}`)}`)
  if (!head || !reviewed || head === reviewed) return false
  const parentsLine = await gitOut(`rev-list --parents -n 1 ${head}`)
  if (!parentsLine) return false
  const [headOid, ...parents] = parentsLine.split(/\s+/)
  if (headOid !== head || parents.length !== 2) return false
  if (!parents.includes(reviewed)) return false
  const mainSide = parents[0] === reviewed ? parents[1] : parents[0]
  // 另一父必须位于当前 origin/main 历史上(同步来源只能是 main)
  const mergeBase = await gitOut(`merge-base ${mainSide} origin/main`)
  if (!mergeBase || mergeBase !== mainSide) return false
  // 树等价:H 的树必须与 R、main 侧的干净自动合并结果逐字节一致
  const autoTree = await gitOut(`merge-tree --write-tree ${reviewed} ${mainSide}`)
  const headTree = autoTree === null ? null : await gitOut(`rev-parse ${head}^{tree}`)
  return !!autoTree && !!headTree && headTree === autoTree.split(/\s+/)[0]
}

/**
 * 合并门禁的 HEAD 一致性校验(issue #48):R 与 H 哈希一致直接放行;不一致时
 * 唯一例外是 H 为 R 与最新 origin/main 的纯同步合并,其余(含 H 比 R 旧、
 * 分叉、分支侧新提交)一律要求重新 Review。
 */
export async function assertReviewHeadMatchesPr(
  ctx: Context,
  worktree: string,
  reviewedHash: string | null,
  prHead: string | null | undefined,
): Promise<void> {
  if (prHead && reviewedHash) {
    if (sameCommitHash(reviewedHash, prHead)) return
    if (await isSyncEquivalentMerge(ctx, worktree, reviewedHash, prHead)) return
  }
  throw new Error('合并门禁拒绝:实时 PR HEAD 与最近一次通过的 review 结论哈希不一致,且不满足同步等价,需重新 Review')
}

/** Server-side merge gate: unknown and changed contracts both fail closed. */
async function assertReviewContractCurrent(ctx: Context, workflow: IssueWorkflow): Promise<void> {
  const reviewedContract = latestPassingReview(workflow)?.issueContract
  if (!reviewedContract) {
    throw new Error('合并门禁拒绝:最近通过的 review 缺少验收契约快照,需重新 Review')
  }
  let current: ReviewIssueContract
  try {
    current = await fetchIssueContract(ctx, workflow.url, true)
  } catch (error) {
    throw new Error(`合并门禁拒绝:无法读取当前验收契约: ${String(error instanceof Error ? error.message : error)}`)
  }
  if (current.contract.bodyHash !== reviewedContract.bodyHash) {
    throw new Error('合并门禁拒绝:验收契约已变更,需重新 Review')
  }
}

async function mergeAuthorizationPreview(ctx: Context, url: string): Promise<{
  prNumber: string
  branch: string
  head: string
  mergeFlag: '--merge'
  cleanup: string[]
}> {
  const parsed = parseUrl(url)
  if (!parsed || parsed.kind !== 'issue') throw new Error('合并目标必须是 GitHub Issue URL')
  const repoKey = `${parsed.owner}/${parsed.repo}`
  const workflow = await loadWorkflow(issueKey(repoKey, parsed.number))
  if (!workflow || !workflow.prNumber) throw new Error('未找到可合并的 workflow 或关联 PR')
  const lookup = await fetchGithubPrFact(ctx, repoKey, workflow.branch, workflow.prNumber)
  if (!lookup.known || !lookup.pr) throw new Error('无法读取实时 PR 状态,请稍后重试')
  if (lookup.pr.state === 'CLOSED') throw new Error('PR 已关闭且未合并,不能执行合并')
  if (lookup.pr.headRefName !== workflow.branch) throw new Error('实时 PR 分支与 workflow 不一致,拒绝合并')
  if (!workflow.delivery) {
    await assertReviewHeadMatchesPr(ctx, workflow.worktree, latestPassingReviewHash(workflow), lookup.pr.headRefOid)
    await assertReviewContractCurrent(ctx, workflow)
  }
  return {
    prNumber: lookup.pr.number,
    branch: workflow.branch,
    head: lookup.pr.headRefOid ?? workflow.delivery?.prHead ?? '',
    mergeFlag: '--merge',
    cleanup: ['worktree', '本地分支', '远端分支', `Issue #${parsed.number}`, 'workflow 归档'],
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
    let mergePreview: Awaited<ReturnType<typeof mergeAuthorizationPreview>> | null = null
    if (input.action === 'develop') {
      const fetched = await fetchIssue(ctx, { url: input.url })
      if (!fetched.ok) return fetched
      snapshot = issueSnapshot(fetched.data.item as Record<string, unknown>)
      if (snapshot.state !== 'OPEN') return { ok: false, error: '只有 OPEN Issue 可以启动开发' }
      if (JSON.stringify(body.expectedSnapshot) !== JSON.stringify(snapshot)) {
        return { ok: false, error: 'Issue 内容已变化或未提供完整预览快照,请刷新面板并重新确认' }
      }
    } else if (input.action === 'merge') {
      mergePreview = await mergeAuthorizationPreview(ctx, input.url)
    }
    const authorizationInput: AgentAuthorizationInput = mergePreview
      ? {
          ...input,
          target: {
            prNumber: mergePreview.prNumber,
            branch: mergePreview.branch,
            head: mergePreview.head,
            mergeFlag: mergePreview.mergeFlag,
          },
        }
      : input
    const authorization = authorizations.issue(authorizationInput, snapshot)
    return {
      ok: true,
      authorizationId: authorization.id,
      authorizationDigest: authorization.digest,
      expiresAt: authorization.expiresAt,
      preview: mergePreview ?? (snapshot
        ? {
            action: input.action,
            agent: input.agent,
            url: snapshot.url,
            title: snapshot.title,
            updatedAt: snapshot.updatedAt,
            commentCount: snapshot.comments.length,
            digest: authorization.digest,
          }
        : { action: input.action, agent: input.agent, url: input.url, digest: authorization.digest }),
      ...(mergePreview ? { target: authorizationInput.target } : {}),
    }
  } catch (error) {
    return { ok: false, error: String(error instanceof Error ? error.message : error) }
  }
}

type MergeResult =
  | { ok: true; merged: true; archived: true; prNumber: string }
  | { ok: false; error: string; merged?: boolean; cleanupPending?: boolean }

async function mergeAndCleanup(ctx: Context, payload: unknown): Promise<MergeResult> {
  const url = String((payload as { url?: unknown } | undefined)?.url ?? '').trim()
  const parsed = parseUrl(url)
  if (!parsed || parsed.kind !== 'issue') return { ok: false, error: '合并目标必须是 GitHub Issue URL' }
  const repoKey = `${parsed.owner}/${parsed.repo}`
  const key = issueKey(repoKey, parsed.number)
  if (mergingWorkflows.has(key)) return { ok: false, error: '该 PR 正在合并或清理,请等待当前请求完成' }
  mergingWorkflows.add(key)
  try {
    return await mergeAndCleanupUnlocked(ctx, payload)
  } finally {
    mergingWorkflows.delete(key)
  }
}

async function mergeAndCleanupUnlocked(ctx: Context, payload: unknown): Promise<MergeResult> {
  const url = String((payload as { url?: unknown } | undefined)?.url ?? '').trim()
  const parsed = parseUrl(url)
  if (!parsed || parsed.kind !== 'issue') return { ok: false, error: '合并目标必须是 GitHub Issue URL' }
  const repoKey = `${parsed.owner}/${parsed.repo}`
  const workflow = await loadWorkflow(issueKey(repoKey, parsed.number))
  if (!workflow || !workflow.prNumber) return { ok: false, error: '未找到可合并的 workflow 或关联 PR' }

  const config = await loadConfig()
  const configuredRepo = config.repos[repoKey]
  if (!configuredRepo) return { ok: false, error: `未配置项目 ${repoKey}` }
  const repoPath = resolve(expandHome(configuredRepo))
  const worktree = resolve(workflow.worktree)
  const worktreeRoot = resolve(config.worktreeRoot)
  const relativeWorktree = relative(worktreeRoot, worktree)
  if (relativeWorktree === '' || relativeWorktree.startsWith('..') || isAbsolute(relativeWorktree)) {
    return { ok: false, error: 'workflow worktree 不在已配置 worktreeRoot 内,拒绝清理' }
  }
  if (workflow.branch.trim() === '') return { ok: false, error: 'workflow 分支无效,拒绝清理' }

  let lookup = await fetchGithubPrFact(ctx, repoKey, workflow.branch, workflow.prNumber)
  if (!lookup.known || !lookup.pr) return { ok: false, error: '无法读取实时 PR 状态,状态未改变' }
  let pr = lookup.pr
  if (pr.state === 'CLOSED') return { ok: false, error: 'PR 已关闭且未合并,状态未改变' }
  if (pr.headRefName !== workflow.branch) return { ok: false, error: '实时 PR 分支与 workflow 不一致,拒绝合并' }
  if (workflow.branch === (pr.baseRefName ?? workflowBaseBranch(workflow.baseRef))) {
    return { ok: false, error: 'workflow 分支等于 PR 基线分支,拒绝清理' }
  }
  if (!pr.headRefOid) return { ok: false, error: '实时 PR HEAD 缺失,拒绝合并' }

  if (!workflow.delivery) {
    try {
      await assertReviewHeadMatchesPr(ctx, workflow.worktree, latestPassingReviewHash(workflow), pr.headRefOid)
      await assertReviewContractCurrent(ctx, workflow)
    } catch (error) {
      return { ok: false, error: String(error instanceof Error ? error.message : error) }
    }
    if (pr.state !== 'MERGED') {
      const command = [
        'gh pr merge', shellQuote(pr.number), '--repo', shellQuote(repoKey),
        '--merge', '--match-head-commit', shellQuote(pr.headRefOid),
        '--body', shellQuote(`Closes #${parsed.number}`),
      ].join(' ')
      try {
        await runCommand(ctx, command, { timeoutMs: 120_000 })
        githubRest(ctx).invalidate(`${repoKey}/pulls/${pr.number}`)
        githubRest(ctx).invalidate(`repo:${repoKey}`)
      } catch (error) {
        return { ok: false, error: `PR 合并失败: ${String(error instanceof Error ? error.message : error)}` }
      }
      lookup = await fetchGithubPrFact(ctx, repoKey, workflow.branch, workflow.prNumber)
      if (!lookup.known || !lookup.pr || lookup.pr.state !== 'MERGED') {
        return { ok: false, error: 'gh pr merge 已返回,但实时 PR 状态尚未确认 MERGED;未开始清理' }
      }
      pr = lookup.pr
    }
    const confirmedHead = pr.headRefOid
    if (!confirmedHead) return { ok: false, error: 'PR 已合并,但无法读取被合并的 HEAD;未开始清理' }
    workflow.delivery = {
      status: 'merged',
      mergedAt: pr.mergedAt ?? new Date().toISOString(),
      prHead: confirmedHead,
      mergeStrategy: 'merge',
      cleanup: { worktree: false, localBranch: false, remoteBranch: false, issue: false },
    }
    try {
      await saveWorkflowStrict(workflow)
    } catch (error) {
      return {
        ok: false,
        merged: true,
        cleanupPending: true,
        error: `PR 已合并,但无法持久化清理状态: ${String(error instanceof Error ? error.message : error)}`,
      }
    }
  } else if (pr.state !== 'MERGED') {
    return { ok: false, error: '本地记录为已合并,但 GitHub 实时状态不一致;拒绝继续清理' }
  }

  const delivery = workflow.delivery
  if (!delivery) return { ok: false, error: 'delivery 状态丢失,拒绝清理' }
  const policy = { mode: 'danger-full-access' as const, workspaceRoot: repoPath }
  const persistStep = async (): Promise<void> => {
    delivery.status = 'cleanup-pending'
    delete delivery.lastError
    await saveWorkflowStrict(workflow)
  }
  const failCleanup = async (label: string, error: unknown): Promise<MergeResult> => {
    const detail = String(error instanceof Error ? error.message : error)
    delivery.status = 'cleanup-pending'
    delivery.lastError = `${label}: ${detail}`
    await saveWorkflowStrict(workflow).catch(() => {})
    return { ok: false, merged: true, cleanupPending: true, error: `PR 已合并;${label}失败,可重试: ${detail}` }
  }

  if (!delivery.cleanup.worktree) {
    try {
      const records = parseWorktreeList(await runCommand(ctx, 'git worktree list --porcelain', {
        workdir: repoPath, timeoutMs: 15_000, sandboxPolicy: policy,
      }))
      const registered = records.some((record) => record.path === worktree)
      if (registered) {
        await runCommand(ctx, `git worktree remove ${shellQuote(worktree)}`, {
          workdir: repoPath, timeoutMs: 60_000, sandboxPolicy: policy,
        })
      } else if (existsSync(worktree)) {
        throw new Error('路径仍存在但不是已注册 worktree,拒绝删除')
      }
      delivery.cleanup.worktree = true
      await persistStep()
    } catch (error) {
      return failCleanup('移除 worktree', error)
    }
  }

  if (!delivery.cleanup.localBranch) {
    try {
      await runCommand(ctx,
        `if git show-ref --verify --quiet ${shellQuote(`refs/heads/${workflow.branch}`)}; then git branch -D -- ${shellQuote(workflow.branch)}; fi`,
        { workdir: repoPath, timeoutMs: 30_000, sandboxPolicy: policy },
      )
      delivery.cleanup.localBranch = true
      await persistStep()
    } catch (error) {
      return failCleanup('删除本地分支', error)
    }
  }

  if (!delivery.cleanup.remoteBranch) {
    try {
      await runCommand(ctx,
        `if git ls-remote --exit-code --heads origin ${shellQuote(`refs/heads/${workflow.branch}`)} >/dev/null 2>&1; then git push origin --delete ${shellQuote(workflow.branch)}; fi`,
        { workdir: repoPath, timeoutMs: 60_000, sandboxPolicy: policy },
      )
      delivery.cleanup.remoteBranch = true
      await persistStep()
    } catch (error) {
      return failCleanup('删除远端分支', error)
    }
  }

  if (!delivery.cleanup.issue) {
    try {
      const issueState = await fetchGithubIssueState(ctx, url)
      if (issueState === null) throw new Error('无法读取实时 Issue 状态')
      if (issueState === 'OPEN') {
        await runCommand(ctx,
          `gh issue close ${shellQuote(parsed.number)} --repo ${shellQuote(repoKey)} --comment ${shellQuote(`由 PR #${pr.number} 以 merge commit 合并交付。`)}`,
          { timeoutMs: 30_000 },
        )
        githubRest(ctx).invalidate(`${repoKey}/issues/${parsed.number}`)
        githubRest(ctx).invalidate(`repo:${repoKey}`)
      }
      workflow.issueState = 'CLOSED'
      delivery.cleanup.issue = true
      await persistStep()
    } catch (error) {
      return failCleanup('关闭 Issue', error)
    }
  }

  try {
    delivery.status = 'archived'
    delete delivery.lastError
    await archiveWorkflow(workflow)
  } catch (error) {
    return failCleanup('归档 workflow', error)
  }
  return { ok: true, merged: true, archived: true, prNumber: pr.number }
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
  forceRefresh = false,
): Promise<
  | { ok: true; dependencies: { blockedBy: IssueDependency[]; blocking: IssueDependency[] } }
  | { ok: false; error: string }
> {
  let issues: { number: number; title: string; state: string; body: string }[] = []
  try {
    const config = await loadConfig()
    const repoKey = `${target.owner}/${target.repo}`
    const snapshot = await fetchGithubRepoSnapshot(ctx, repoKey, fetchTtlMs(config), forceRefresh)
    issues = snapshot.issues
      .filter((issue) => issue.pull_request === undefined)
      .map((issue) => ({
        number: issue.number,
        title: issue.title,
        state: String(issue.state).toUpperCase(),
        body: issue.body ?? '',
      }))
  } catch (error) {
    return { ok: false, error: isGithubRateLimitError(error) ? error.message : `GitHub 依赖刷新失败: ${githubErrorMessage(error)}` }
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
  return { ok: true, dependencies: { blockedBy, blocking } }
}

/** Fetch the issue timeline and keep only the events worth showing. */
async function fetchTimeline(ctx: Context, owner: string, repo: string, number: string): Promise<unknown[]> {
  try {
    const events = await githubRest(ctx).paginate<{
      event?: string
      created_at?: string
      actor?: GithubUserRest | null
      commit_id?: string | null
      source?: { issue?: { number?: number; title?: string; html_url?: string; state?: string; pull_request?: { merged_at?: string | null } | null } } | null
    }>(`repos/${owner}/${repo}/issues/${number}/timeline`, 'application/vnd.github+json', 15_000)
    const visible = new Set(['cross-referenced', 'referenced', 'connected', 'closed', 'reopened'])
    return events.filter((event) => visible.has(String(event.event ?? ''))).map((event) => {
      const source = event.source?.issue
      return {
        event: event.event,
        created_at: event.created_at,
        actor: String(event.actor?.login ?? ''),
        commit_id: event.commit_id ?? null,
        source: source ? {
          number: source.number,
          title: source.title,
          html_url: source.html_url,
          state: source.state,
          is_pr: source.pull_request != null,
          pr_merged: source.pull_request?.merged_at != null,
        } : null,
      }
    })
  } catch (error) {
    if (isGithubRateLimitError(error)) throw error
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
    const rest = githubRest(ctx)
    const key = `${workflow.repoKey}/pulls/${workflow.prNumber}`
    const comments = await rest.cachedResource(`${key}/comments`, rest.resourceVersion(key), () =>
      rest.paginate<GithubCommentRest>(`repos/${workflow.repoKey}/issues/${workflow.prNumber}/comments`))
    return comments.map((comment) => ({
      author: String(comment.user?.login ?? 'unknown'),
      body: String(comment.body ?? ''),
    }))
  } catch (error) {
    if (isGithubRateLimitError(error)) throw error
    return null
  }
}

/** Refresh at stage start; only a complete persisted snapshot may cover an outage. */
async function resolvePromptSnapshot(
  ctx: Context,
  workflow: IssueWorkflow,
): Promise<ResolvedPromptSnapshot | { error: string }> {
  // A privileged stage start must revalidate the frozen authorization snapshot;
  // this security boundary intentionally bypasses the display cache.
  const fetched = await fetchIssue(ctx, { url: workflow.url, forceRefresh: true })
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
  reviewedHead: string,
  sessionId: string | null = null,
): Promise<string> {
  // 解析 base:PR 有 baseRefName(若记录过),否则尝试 origin/HEAD 主干
  let base = 'origin/main'
  if (workflow.prNumber) {
    const baseRef = await fetchPrBase(ctx, workflow.repoKey, workflow.prNumber)
    if (baseRef) base = `origin/${baseRef}`
  }
  const prUrl = workflow.prNumber ? `https://github.com/${workflow.repoKey}/pull/${workflow.prNumber}` : '未关联'
  const contractHash = issueBodyHash(resolved.snapshot.body)
  return buildStagePrompt({
    stage: 'review',
    ...resolved,
    worktree: workflow.worktree,
    status: [
      `分支: ${workflow.branch}`,
      `PR: ${prUrl}`,
      `被审 commit: ${reviewedHead}`,
      `对比 base: ${base}`,
      `契约正文 SHA-256: ${contractHash}`,
      `会话模式: ${sessionId ? `续接 review 会话 ${sessionId};保留既有审查记忆` : '全新 review 会话'}`,
    ],
    requirements: [
      '先执行 git fetch origin 同步远端最新状态(并行开发时 base 可能已变化)。',
      `执行 git diff ${base}...HEAD 查看完整改动。`,
      ...(sessionId ? ['先复核之前发现的问题是否已解决,再审查全部新改动。'] : []),
      '严格按当前需求快照中的验收标准逐条审查,同时检查 bug、安全隐患和测试覆盖。',
      '验证结果必须区分:命令已执行但断言/检查失败的问题以「[验证不通过]」开头;因权限、环境或外部依赖导致命令无法执行的问题以「[无法验证]」开头,不得混淆。',
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
    const pr = await fetchPrRestDetail(ctx, repoKey, prNumber)
    const name = String(pr.base?.ref ?? '').trim()
    return name === '' ? null : name
  } catch (error) {
    if (isGithubRateLimitError(error)) throw error
    return null
  }
}

/** Fetch a PR's head branch name via gh (to locate its worktree). */
async function fetchPrHeadBranch(ctx: Context, owner: string, repo: string, prNumber: string): Promise<string | null> {
  try {
    const pr = await fetchPrRestDetail(ctx, `${owner}/${repo}`, prNumber)
    const name = String(pr.head?.ref ?? '').trim()
    return name === '' ? null : name
  } catch (error) {
    if (isGithubRateLimitError(error)) throw error
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

function pushTaskLine(task: LiveTask, value: string | LiveLogEvent): void {
  const event: LiveLogEvent = typeof value === 'string'
    ? value.startsWith('[clickvibe]')
      ? { source: 'system', kind: 'system', text: value }
      : { source: 'agent', kind: 'text', text: value }
    : value
  const line = encodeLiveLogEvent(event)
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
          pushTaskLine(task, {
            source: 'agent',
            agent: task.agent as AgentKind,
            kind: line.kind,
            text: line.text,
            ...(line.usage ? { usage: line.usage } : {}),
          })
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
    const fetched = await fetchIssue(ctx, { url, forceRefresh: true })
    if (!fetched.ok) return fetched
    const snapshot = issueSnapshot(fetched.data.item as Record<string, unknown>)
    if (snapshot.state !== 'OPEN') return { ok: false, error: '只有 OPEN Issue 可以执行 dryrun' }
  } else if (!authorizedSnapshot || authorizedSnapshot.url !== url || authorizedSnapshot.state !== 'OPEN') {
    return { ok: false, error: '缺少与该 OPEN Issue 绑定的服务端确认快照' }
  } else {
    const fetched = await fetchIssue(ctx, { url, forceRefresh: true })
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
      const agentCommand = buildFreshAgentCommand(agent)

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
  const decoded = read.lines.map(decodeLiveLogLine)
  return {
    ok: true,
    taskId,
    status: live.status,
    exitCode: live.exitCode,
    cursor: read.cursor,
    delta: decoded.map((event) => event.text),
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
  | { ok: true; taskId: string | null; key: string; kind: HistoryKind; lines: string[]; events: LiveLogEvent[]; cursor: number; active: boolean }
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
  const events = lines.map(decodeLiveLogLine)
  return {
    ok: true,
    taskId: target.taskId,
    key: target.key,
    kind: target.kind,
    lines: events.map((event) => event.text),
    events,
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
      const event = decodeLiveLogLine(entry.line)
      res.write(`id: ${entry.sequence}\ndata: ${JSON.stringify({ line: event.text, event, cursor: entry.sequence })}\n\n`)
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

/** Sync a workflow's worktree with the remote base, then push the PR branch.
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
    // Do not rely on git merge to reject a dirty tree:Git permits unrelated
    // local changes, which would otherwise let the merge commit be pushed.
    // An existing conflicted merge keeps following the conflict-preservation
    // path below so callers still receive conflict:true and the file list.
    if (!await hasMergeConflict(ctx, workflow.worktree)) {
      const changes = await runCommand(ctx, 'git status --porcelain', {
        workdir: workflow.worktree,
        timeoutMs: 10_000,
        sandboxPolicy: { mode: 'read-only', workspaceRoot: workflow.worktree },
      })
      if (changes) throw new Error('worktree 有未提交改动,请先提交或清理后再同步')
    }
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
    await appendLog(workflow.key, 'dev', `[clickvibe] 同步:推送 ${workflow.branch} 到 origin…`)
    await runCommand(ctx, `git push origin ${shellQuote(workflow.branch)}`, {
      workdir: workflow.worktree,
      timeoutMs: 60_000,
      sandboxPolicy: policy,
    })
    await appendLog(workflow.key, 'dev', `[clickvibe] 同步并推送完成,HEAD ${head ?? '未知'}`)
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
  // workflow 校验后、冻结契约/HEAD 等任何 await 之前同步占位。重复请求会立即
  // 复用 taskId,不会重复支付 GitHub 刷新超时,也不会交错清理结论文件并双开 review。
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
  // Prompt 与 review 事件必须绑定同一份快照，避免两次 GitHub 读取之间的契约漂移。
  const reviewIssue: ReviewIssueContract = {
    title: resolvedSnapshot.snapshot.title,
    body: resolvedSnapshot.snapshot.body,
    state: resolvedSnapshot.snapshot.state,
    contract: {
      bodyHash: issueBodyHash(resolvedSnapshot.snapshot.body),
      updatedAt: resolvedSnapshot.snapshot.updatedAt,
    },
  }
  await resetLog(workflow.key, 'review')

  // Review must inspect the branch against current remote refs. Keep review
  // available during an outage, but make the degraded input explicit in its log.
  try {
    await runCommand(ctx, 'git fetch origin --prune', {
      workdir: workflow.worktree,
      timeoutMs: 60_000,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: workflow.worktree },
    })
    pushTaskLine(live, '[clickvibe] review 前已同步远端(origin)')
  } catch (error) {
    pushTaskLine(live, `[clickvibe] review 前 git fetch 失败(继续): ${String(error instanceof Error ? error.message : error)}`)
  }

  if (reviewIssue.state !== 'OPEN') {
    finishTask(live, 'failed', 1)
    return { ok: false, error: '只有 OPEN Issue 可以启动 review' }
  }
  const reviewedHead = await readWorktreeHead(ctx, workflow.worktree)
  if (!reviewedHead) {
    finishTask(live, 'failed', 1)
    return { ok: false, error: '无法冻结被审 HEAD,请检查 worktree 后重试' }
  }

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
  const prompt = await buildReviewPrompt(ctx, workflow, resolvedSnapshot, reviewedHead, sessionId)

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
    const lines = (await readLogTail(workflow.key, 'review', 200)).map((line) => decodeLiveLogLine(line).text)
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
      const event: WorkflowEvent = {
        kind: 'review',
        at: new Date().toISOString(),
        hash: reviewedHead,
        verdict: { passed, issues },
        issueContract: reviewIssue.contract,
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
      const approval = await approvePassedReview({
        repoKey: reloaded.repoKey,
        prNumber: reloaded.prNumber,
        passed,
      }, (command) => runCommand(ctx, command, { timeoutMs: 30000 }))
      if (approval === 'approved') {
        pushTaskLine(live, '[clickvibe] 已提交 GitHub 原生 Approve (LGTM)')
      } else if (approval === 'failed') {
        pushTaskLine(live, '[clickvibe] GitHub 原生 Approve 失败(继续,不影响 Review 结论与评论)')
      }
    }
  }, sessionId ? {
    staleSessionId: sessionId,
    prepare: async () => {
      const reloaded = await loadWorkflow(workflow.key)
      if (reloaded && clearStaleSessionId(reloaded, 'review', sessionId)) await saveWorkflow(reloaded)
      return {
        command: buildFreshAgentCommand(agent),
        prompt: await buildReviewPrompt(ctx, workflow, resolvedSnapshot, reviewedHead),
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
    const number = workflow.prNumber ?? parseUrl(workflow.url)?.number
    if (number) githubRest(ctx).invalidate(`${workflow.repoKey}/${target === 'pr' ? 'pulls' : 'issues'}/${number}`)
    githubRest(ctx).invalidate(`repo:${workflow.repoKey}`)
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
