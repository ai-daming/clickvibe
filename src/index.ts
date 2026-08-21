/**
 * clickvibe host half — routes:
 * - `/clickvibe/api/fetch`          — fetch GitHub issue/PR data via gh
 * - `/clickvibe/api/state`          — restore panel context (all workflows)
 * - `/clickvibe/api/develop`        — start dev: worktree+branch+agent
 * - `/clickvibe/api/develop/poll`   — incremental dev log/status (JSON)
 * - `/clickvibe/api/stream`         — SSE live status stream for a task
 * - `/clickvibe/api/review`         — review the dev branch with codex/claude
 * - `/clickvibe/api/resume`         — resume an interrupted dev session
 *
 * Workflow per issue (persisted under ~/.clickvibe/state/):
 *   developing → review-ready → reviewing → passed
 *                      ↑                  │
 *                      └── rework ────────┘
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename, dirname, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { decideWorktreeRecovery, shellQuote } from './develop.ts'
import {
  appendEvent,
  appendLog,
  issueKey,
  loadAllWorkflows,
  loadWorkflow,
  logPath,
  readLogTail,
  saveWorkflow,
  type IssueWorkflow,
  type WorkflowStage,
} from './state.ts'
import { parseAgentChunk, type AgentKind } from './agent-stream.ts'

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
  agent: AgentKind
  process?: ReturnType<Context['shell']['start']>
  lines: string[]          // 已解析的状态行(供 SSE 增量读取)
  closed: boolean
  sessionId: string | null // 从事件流捕获的 agent 会话 id(续会话用)
}

const liveTasks = new Map<string, LiveTask>()
const liveWaiters = new Map<string, Set<() => void>>()

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
  const m = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)/)
  if (!m) return null
  return { kind: m[3] === 'pull' ? 'pr' : 'issue', owner: m[1], repo: m[2], number: m[4] }
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
  if (result.exitCode !== 0) {
    const stderr = result.stderr?.text?.trim() ?? ''
    throw new Error(`命令退出码 ${result.exitCode}${stderr ? `: ${stderr}` : ''}`)
  }
  return result.stdout.text.trim()
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
 * Derive the live state of a workflow from git facts + its event history.
 * The stored `stage`/`reviewResult` stay as-is; this adds `derived` with
 * the current worktree HEAD and whether commits exist beyond the last
 * recorded dev event (i.e. un-reviewed work).
 */
async function deriveWorkflowState(
  ctx: Context,
  workflow: IssueWorkflow,
): Promise<IssueWorkflow & { derived: { head: string | null; hasNewCommits: boolean; lastDevHash: string | null; lastReviewHash: string | null } }> {
  const head = existsSync(workflow.worktree) ? await readWorktreeHead(ctx, workflow.worktree) : null
  const events = workflow.events ?? []
  let lastDevHash: string | null = null
  let lastReviewHash: string | null = null
  for (const ev of events) {
    if (ev.kind === 'dev' || ev.kind === 'rework') lastDevHash = ev.hash ?? lastDevHash
    if (ev.kind === 'review') lastReviewHash = ev.hash ?? lastReviewHash
  }
  // 有新提交 = worktree HEAD 不在已记录的任何 dev/rework 事件哈希里
  const hasNewCommits = head !== null && lastDevHash !== null && head !== lastDevHash
  return {
    ...workflow,
    derived: { head, hasNewCommits, lastDevHash, lastReviewHash },
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
      const knownMethods = new Set(['fetch', 'state', 'develop', 'develop/poll', 'stream', 'review', 'resume'])
      if (method === undefined || !knownMethods.has(method)) {
        writeJson(res, 404, { ok: false, error: 'unknown method' })
        return
      }

      // SSE stream endpoint (GET)
      if (method === 'stream') {
        handleStream(req, res)
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
      if (method === 'state') {
        const workflows = await loadAllWorkflows()
        // 附加推导状态:worktree HEAD + 相对最新事件的进展(不覆盖存储)
        const enriched = []
        for (const w of workflows) {
          const derived = await deriveWorkflowState(ctx, w)
          enriched.push(derived)
        }
        writeJson(res, 200, { ok: true, workflows: enriched })
        return
      }
      if (method === 'develop') {
        const result = await startDevelop(ctx, payload)
        writeJson(res, result.ok ? 200 : 400, result)
        return
      }
      if (method === 'develop/poll') {
        const result = await pollDevelop(payload)
        writeJson(res, result.ok ? 200 : 400, result)
        return
      }
      if (method === 'review') {
        const result = await startReview(ctx, payload)
        writeJson(res, result.ok ? 200 : 400, result)
        return
      }
      if (method === 'resume') {
        const result = await resumeDevelop(ctx, payload)
        writeJson(res, result.ok ? 200 : 400, result)
        return
      }

      writeJson(res, 404, { ok: false, error: `unknown method "${method}"` })
    },
  })
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
    const data: { kind: 'issue' | 'pr'; item: unknown; timeline?: unknown } = { kind: parsed.kind, item: parsedJson }
    // issue 额外拉 timeline,提取关联事件(linked PR/commit)——GitHub UI 的
    // "linked a pull request" 就来自 cross-referenced 事件
    if (!isPR) {
      data.timeline = await fetchTimeline(ctx, parsed.owner, parsed.repo, parsed.number)
    }
    return { ok: true, data }
  } catch (error) {
    return { ok: false, error: `抓取异常: ${String(error instanceof Error ? error.message : error)}` }
  }
}

/** Fetch the issue timeline and keep only the events worth showing. */
async function fetchTimeline(ctx: Context, owner: string, repo: string, number: string): Promise<unknown[]> {
  const command = `gh api repos/${owner}/${repo}/issues/${number}/timeline -H "Accept: application/vnd.github+json" --jq '[.[] | select(.event == "cross-referenced" or .event == "referenced" or .event == "connected" or .event == "closed" or .event == "reopened") | {event, created_at, actor: .actor.login, commit_id, source: (if .source then {number: .source.issue.number, title: .source.issue.title, html_url: .source.issue.html_url, state: .source.issue.state} else null end)}]'`
  try {
    const spec = ctx.shell.resolve({ command, timeoutMs: 15000 })
    const result = await ctx.shell.run(spec)
    if (result.exitCode !== 0) return []
    return JSON.parse(result.stdout.text) as unknown[]
  } catch {
    return []
  }
}

/** Build the development prompt from issue/PR data. */
function buildPrompt(item: Record<string, unknown>): string {
  const comments = Array.isArray(item.comments)
    ? (item.comments as { author?: { login?: string } | null; body?: string }[])
        .map((c) => `@${c.author?.login ?? 'unknown'}: ${c.body ?? ''}`)
        .join('\n\n---\n\n')
    : ''
  return [
    `请开发这个 GitHub ${item.url?.toString().includes('/pull/') ? 'PR' : 'issue'}: ${item.title ?? ''}`,
    String(item.url ?? ''),
    '',
    '--- issue 正文 ---',
    String(item.body ?? ''),
    comments ? '--- 评论 ---\n' + comments : '',
    '--- 要求 ---',
    '1. 先理解需求,如有歧义可自行判断或提问',
    '2. 实现代码改动',
    '3. 运行相关测试',
    '4. 完成后 git commit 并推送分支',
    '5. 用 gh 创建 PR(若适用)',
  ].join('\n')
}

/** Build the review prompt: review the dev branch diff against the issue. */
function buildReviewPrompt(workflow: IssueWorkflow): string {
  return [
    `请 review 分支 ${workflow.branch} 相对其 base 的代码改动,对照 issue:`,
    workflow.url,
    '',
    '要求:',
    '1. 用 git diff 查看改动(相对主干)',
    '2. 检查:需求是否完整实现、是否有 bug/安全隐患、测试是否覆盖',
    '3. 不要修改任何文件,只做只读 review',
    '4. 最后一行必须输出一个 JSON 对象(单独一行,不要包裹在代码块里),格式:',
    '{"passed": true|false, "issues": ["问题1(含文件/位置/原因)", "问题2", ...]}',
    '   passed=true 表示无问题;有任意问题则 passed=false 并列出全部。',
  ].join('\n')
}

/** Extract the final JSON verdict object from review log lines. */
function extractReviewJson(lines: string[]): { passed: boolean; issues: string[] } | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    const match = line.match(/\{.*"passed".*\}/)
    if (!match) continue
    try {
      const obj = JSON.parse(match[0]) as { passed?: unknown; issues?: unknown }
      if (typeof obj.passed !== 'boolean') continue
      const issues = Array.isArray(obj.issues)
        ? obj.issues.filter((x): x is string => typeof x === 'string')
        : []
      return { passed: obj.passed, issues }
    } catch {
      // 不是合法 JSON,继续找前一行
    }
  }
  return null
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
      devInterrupted: false,
      reviewAgent: null,
      reviewTaskId: null,
      reviewSessionId: null,
      reviewResult: null,
      updatedAt: Date.now(),
      events: [],
    }
  }
  // 旧状态文件兜底:补 events / reviewSessionId 字段
  if (!Array.isArray(workflow.events)) workflow.events = []
  if (workflow.reviewSessionId === undefined) workflow.reviewSessionId = null
  // 校正路径字段(配置可能变化)
  workflow.worktree = worktree
  workflow.branch = branch

  // 幂等建 worktree:用完整恢复决策(处理 reuse/attach/conflict/重建),
  // 而不是简单判断目录是否存在。git 操作需要无沙箱(写主仓库 .git/refs)。
  const policy = { mode: 'danger-full-access' as const, workspaceRoot: expandedRepo }
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
    const branchArg = branchExists ? shellQuote(branch) : `-b ${shellQuote(branch)}`
    await runCommand(ctx, `git worktree add ${shellQuote(normalizedTarget)} ${branchArg}`, { workdir: expandedRepo, timeoutMs: 60000, sandboxPolicy: policy })
    await appendLog(workflow.key, 'dev', `[clickvibe] stale worktree 已重建`)
  } else {
    // add-new-branch / add-existing-branch:确保父目录存在后创建/复用
    const { mkdir } = await import('node:fs/promises')
    await mkdir(dirname(normalizedTarget), { recursive: true })
    const branchArg = recovery.kind === 'add-new-branch'
      ? `-b ${shellQuote(branch)}`
      : shellQuote(branch)
    await runCommand(ctx, `git worktree add ${shellQuote(normalizedTarget)} ${branchArg}`, { workdir: expandedRepo, timeoutMs: 60000, sandboxPolicy: policy })
    await appendLog(workflow.key, 'dev', recovery.kind === 'add-new-branch'
      ? `[clickvibe] worktree 与分支创建完成`
      : `[clickvibe] 已从现有分支恢复 worktree`)
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
function attachAgentProcess(
  ctx: Context,
  task: LiveTask,
  command: string,
  workdir: string,
  prompt: string,
  onExit: (exitCode: number | null, sessionId: string | null) => void,
): void {
  const spec = ctx.shell.resolve({
    command,
    workdir,
    stdin: prompt,
    timeoutMs: 600000,
    sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: workdir },
  })
  const process = ctx.shell.start(spec)
  task.process = process

  // 轮询读取 agent 输出,解析为状态行,写入内存缓冲 + 落盘日志
  const pump = setInterval(() => {
    const read = process.readOutput()
    if (read.delta !== '') {
      const parsed = parseAgentChunk(task.agent, read.delta)
      for (const line of parsed.lines) {
        task.lines.push(line.text)
        void appendLog(task.workflowKey, task.kind, line.text)
      }
      if (parsed.sessionId) task.sessionId = parsed.sessionId
      if (read.lossy) {
        task.lines.push('[clickvibe] 输出被截断(日志过长)')
      }
      notifyTask(task.taskId)
    }
  }, 500)

  void process.done.then(() => {
    clearInterval(pump)
    task.closed = true
    notifyTask(task.taskId)
    onExit(process.exitCode, task.sessionId)
  })
}

/** Start a development task: worktree + branch + background agent run. */
async function startDevelop(
  ctx: Context,
  payload: unknown,
): Promise<
  | { ok: true; taskId: string; worktree: string; branch: string }
  | { ok: false; error: string }
> {
  const body = (payload ?? {}) as { url?: unknown; agent?: unknown; context?: unknown }
  const url = String(body.url ?? '').trim()
  const agentRaw = String(body.agent ?? 'codex').trim().toLowerCase()
  const agent: AgentKind = agentRaw === 'claude' ? 'claude' : 'codex'
  const extraContext = typeof body.context === 'string' ? body.context.trim() : ''
  const parsed = parseUrl(url)
  if (!parsed) {
    return { ok: false, error: '请输入形如 https://github.com/owner/repo/issues/123 的链接' }
  }
  if (parsed.kind !== 'issue') {
    return { ok: false, error: '一键开发仅支持 issue 链接' }
  }

  const ensured = await ensureWorktree(ctx, parsed)
  if (!ensured.ok) return ensured
  const { workflow } = ensured

  // 已有开发任务在跑:复用
  if (workflow.devTaskId && liveTasks.has(workflow.devTaskId) && !liveTasks.get(workflow.devTaskId)!.closed) {
    return { ok: true, taskId: workflow.devTaskId, worktree: workflow.worktree, branch: workflow.branch }
  }

  const taskId = `dev-${Date.now()}`
  const live: LiveTask = {
    taskId,
    workflowKey: workflow.key,
    kind: 'dev',
    agent,
    lines: [],
    closed: false,
    sessionId: null,
  }
  liveTasks.set(taskId, live)
  workflow.devAgent = agent
  workflow.devTaskId = taskId
  workflow.devInterrupted = false
  workflow.stage = 'developing'
  await saveWorkflow(workflow)

  void (async () => {
    try {
      await appendLog(workflow.key, 'dev', `[clickvibe] 抓取 issue 数据…`)
      const fetchResult = await fetchIssue(ctx, { url })
      if (!fetchResult.ok) throw new Error(fetchResult.error)
      let prompt = buildPrompt(fetchResult.data.item as Record<string, unknown>)
      if (extraContext !== '') {
        prompt += '\n\n--- 附加上下文(来自 review 或其他) ---\n' + extraContext
      }

      await appendLog(workflow.key, 'dev', `[clickvibe] 启动 ${agent} 开发…`)
      const agentCommand = agent === 'claude'
        ? 'claude -p --verbose --output-format stream-json'
        : 'codex exec --json -'

      attachAgentProcess(ctx, live, agentCommand, workflow.worktree, prompt, async (exitCode, sessionId) => {
        await appendLog(workflow.key, 'dev', `[clickvibe] ${agent} 结束,退出码 ${exitCode}`)
        const reloaded = await loadWorkflow(workflow.key)
        if (reloaded) {
          if (exitCode === 0) {
            reloaded.stage = 'review-ready'
            reloaded.devInterrupted = false
            // 记录 agent 会话 id(供续会话精确恢复,不用 --last)
            if (sessionId) reloaded.devSessionId = sessionId
            // 记录开发提交事件:读 worktree HEAD 作为锚定哈希
            const head = await readWorktreeHead(ctx, workflow.worktree)
            await appendEvent(reloaded, {
              kind: extraContext !== '' ? 'rework' : 'dev',
              at: new Date().toISOString(),
              hash: head ?? undefined,
              note: `${agent} 完成开发${extraContext !== '' ? '(按 review 意见返工)' : ''}`,
            })
          } else {
            reloaded.devInterrupted = true
          }
          await saveWorkflow(reloaded)
        }
      })
    } catch (error) {
      live.closed = true
      await appendLog(workflow.key, 'dev', `[clickvibe] 失败: ${String(error instanceof Error ? error.message : error)}`)
    }
  })()

  return { ok: true, taskId, worktree: workflow.worktree, branch: workflow.branch }
}

/** Consume incremental dev log/status for one task. */
async function pollDevelop(
  payload: unknown,
): Promise<
  | { ok: true; taskId: string; status: string; exitCode: number | null; delta: string[]; done: boolean }
  | { ok: false; error: string }
> {
  const taskId = String((payload as { taskId?: unknown } | undefined)?.taskId ?? '')
  const live = liveTasks.get(taskId)
  if (!live) {
    return { ok: false, error: `未知任务 ${taskId}` }
  }
  const delta = live.lines.splice(0, live.lines.length)
  return {
    ok: true,
    taskId,
    status: live.closed ? (live.process?.exitCode === 0 ? 'done' : 'failed') : 'running',
    exitCode: live.process?.exitCode ?? null,
    delta,
    done: live.closed,
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
    connection: 'keep-alive',
  })

  let index = 0
  let closed = false

  const flush = () => {
    if (closed) return
    while (index < live.lines.length) {
      const line = live.lines[index]
      index += 1
      res.write(`data: ${JSON.stringify(line)}\n\n`)
    }
    if (live.closed) {
      res.write(`data: ${JSON.stringify({ __done: true })}\n\n`)
      res.end()
      closed = true
    }
  }

  flush()
  if (!closed) {
    const wake = () => flush()
    const waiters = liveWaiters.get(taskId) ?? new Set<() => void>()
    waiters.add(wake)
    liveWaiters.set(taskId, waiters)
    req.on('close', () => {
      waiters.delete(wake)
      if (waiters.size === 0) liveWaiters.delete(taskId)
    })
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
  const agentRaw = String(body.agent ?? 'codex').trim().toLowerCase()
  const agent: AgentKind = agentRaw === 'claude' ? 'claude' : 'codex'
  const parsed = parseUrl(url)
  if (!parsed) {
    return { ok: false, error: '请输入形如 https://github.com/owner/repo/issues/123 的链接' }
  }
  if (parsed.kind !== 'issue') {
    return { ok: false, error: 'review 仅支持 issue 链接' }
  }

  const key = issueKey(`${parsed.owner}/${parsed.repo}`, parsed.number)
  const workflow = await loadWorkflow(key)
  if (!workflow || workflow.stage === 'idle' || workflow.stage === 'developing') {
    return { ok: false, error: '该 issue 尚未完成开发,无法 review' }
  }
  if (!existsSync(workflow.worktree)) {
    return { ok: false, error: `worktree 不存在: ${workflow.worktree}` }
  }

  const taskId = `review-${Date.now()}`
  const live: LiveTask = {
    taskId,
    workflowKey: workflow.key,
    kind: 'review',
    agent,
    lines: [],
    closed: false,
    sessionId: workflow.reviewSessionId,
  }
  liveTasks.set(taskId, live)
  workflow.reviewAgent = agent
  workflow.reviewTaskId = taskId
  workflow.stage = 'reviewing'
  await saveWorkflow(workflow)

  // review 与 dev 同规则:有上次会话 id 就续会话(精确 id,不用 --last),
  // 续会话时提示"代码已更新,检查之前的问题是否已解决并审查新改动";
  // 没有会话 id 则新开会话。
  const sessionId = workflow.reviewSessionId
  let agentCommand: string
  if (agent === 'claude') {
    agentCommand = sessionId
      ? `claude -p --resume ${shellQuoteId(sessionId)} --verbose --output-format stream-json`
      : 'claude -p --verbose --output-format stream-json'
  } else {
    agentCommand = sessionId
      ? `codex exec resume ${shellQuoteId(sessionId)} --json -`
      : 'codex exec --json -'
  }
  const prompt = sessionId
    ? '请继续 review。代码已更新,请先确认之前发现的问题是否已解决,再审查新改动,最后输出同样的 JSON 结论。'
    : buildReviewPrompt(workflow)

  await appendLog(workflow.key, 'review', `[clickvibe] 启动 ${agent} review${sessionId ? `(续会话 ${sessionId})` : ''}…`)
  attachAgentProcess(ctx, live, agentCommand, workflow.worktree, prompt, async (exitCode, newSessionId) => {
    await appendLog(workflow.key, 'review', `[clickvibe] review 结束,退出码 ${exitCode}`)
    // 优先用 agent 输出的 JSON 结论(完整、不受截断/分块影响);
    // JSON 缺失时回退到 ❌/✅ 文本判定。
    const lines = await readLogTail(workflow.key, 'review', 200)
    const json = extractReviewJson(lines)
    const passed = json ? json.passed : reviewVerdict(lines).passed
    const issues = passed ? [] : (json?.issues ?? extractIssues(lines))
    const reloaded = await loadWorkflow(workflow.key)
    if (reloaded) {
      reloaded.reviewResult = { passed, issues }
      reloaded.stage = passed ? 'passed' : 'review-ready' // 有问题 → 可回开发(rework)
      // 记录 review 会话 id(供下次 review 续会话)
      if (newSessionId) reloaded.reviewSessionId = newSessionId
      // 记录 review 历史事件:锚定被 review 的 HEAD
      const reviewedHead = await readWorktreeHead(ctx, workflow.worktree)
      await appendEvent(reloaded, {
        kind: 'review',
        at: new Date().toISOString(),
        hash: reviewedHead ?? undefined,
        verdict: { passed, issues },
        note: `${agent} review${passed ? ' 通过' : ` 发现 ${issues.length} 个问题`}`,
      })
      await saveWorkflow(reloaded)
      // 发到 GitHub issue 评论
      void postReviewComment(ctx, workflow.url, passed, issues)
    }
  })

  return { ok: true, taskId }
}

/** Decide the review verdict from the log: ❌ wins over ✅; neither → fail closed. */
function reviewVerdict(lines: string[]): { passed: boolean } {
  let sawFail = false
  let sawPass = false
  for (const line of lines) {
    const t = line.trim()
    // 结论可能带 emoji/状态前缀(💬/🔧/⚠️…),用 includes 判断更稳
    if (t.includes('❌') && /发现|存在|问题|Review/.test(t)) sawFail = true
    if (t.includes('✅') && !/本轮完成|会话结束/.test(t)) sawPass = true
    if (/Review\s*通过|未发现问题|无问题/.test(t)) sawPass = true
  }
  return { passed: !sawFail && sawPass }
}

/** Extract issue lines from a review result (lines after a ❌ header). */
/** Extract issue lines from review log lines (lines after a ❌ verdict). */
function extractIssues(lines: string[]): string[] {
  const out: string[] = []
  // 只取最后一个包含 ❌ 的行(agent 的最终结论;前面可能有中间自查的 ❌)
  let verdictIndex = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('❌')) verdictIndex = i
  }
  if (verdictIndex === -1) return []
  const verdict = lines[verdictIndex]
  const rest = verdict.slice(verdict.indexOf('❌') + 1)
  // 按 "N. " 编号切分条目;若无编号条目则走下面的行收集
  const parts = rest.split(/(?=\d+\.\s)/).filter((s) => /^\d+\./.test(s.trim()))
  if (parts.length > 0) {
    for (const p of parts) {
      const item = p.replace(/^\d+\.\s*/, '').trim()
      if (item !== '') out.push(item)
    }
  } else {
    // 无编号条目:收集结论行之后非状态、非 clickvibe 的行
    for (let i = verdictIndex + 1; i < lines.length; i++) {
      const t = lines[i].trim()
      if (t === '' || /^✅|^⚠️|^🚀|^💭|^🔧|^\[clickvibe\]|本轮完成|会话结束/.test(t)) break
      out.push(t)
    }
  }
  return out.slice(0, 20)
}

/** Post the review result to the issue's GitHub comments. */
async function postReviewComment(ctx: Context, issueUrl: string, passed: boolean, issues: string[]): Promise<void> {
  const body = passed
    ? '## ✅ ClickVibe Review 通过\n\n自动 review 未发现问题。'
    : `## ❌ ClickVibe Review 发现问题(${issues.length} 条)\n\n${issues.map((i) => `- ${i}`).join('\n')}`
  // body 走 stdin(--body-file -),避免 shell 转义破坏反引号/换行;
  // URL 用单引号安全引用(与 develop.ts 的 shellQuote 一致)。
  const command = `gh issue comment '${issueUrl.replaceAll("'", "'\\''")}' --body-file -`
  try {
    await runCommand(ctx, command, { stdin: body, timeoutMs: 30000 })
  } catch {
    // posting is best-effort
  }
}

/** Resume (or continue) a dev session with an exact session id; `context`
 *  carries extra instructions (e.g. review issues for a rework). */
async function resumeDevelop(
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

  // 没有记录会话 id(旧版本开发或会话已丢):回退到新开会话,但保留 context
  if (!workflow.devSessionId) {
    return await startDevelop(ctx, { url, agent: workflow.devAgent ?? 'codex', context: extraContext })
  }

  const oldLive = liveTasks.get(workflow.devTaskId)
  if (oldLive && !oldLive.closed) {
    return { ok: true, taskId: oldLive.taskId }
  }

  const taskId = `dev-${Date.now()}`
  const live: LiveTask = {
    taskId,
    workflowKey: workflow.key,
    kind: 'dev',
    agent: workflow.devAgent ?? 'codex',
    lines: [],
    closed: false,
    sessionId: workflow.devSessionId,
  }
  liveTasks.set(taskId, live)
  workflow.devTaskId = taskId
  workflow.devInterrupted = false
  workflow.stage = 'developing'
  await saveWorkflow(workflow)

  // 用精确会话 id 续会话(不能用 --last/--continue:worktree 里可能有多个
  // agent 会话,--last 续的是"最近那个",不一定是我们这个)。
  // sessionId 缺失时回退 --last/--continue(尽力而为)。
  const agent = workflow.devAgent ?? 'codex'
  const sessionId = workflow.devSessionId
  let command: string
  if (agent === 'claude') {
    command = sessionId
      ? `claude -p --resume ${shellQuoteId(sessionId)} --verbose --output-format stream-json`
      : 'claude -p --continue --verbose --output-format stream-json'
  } else {
    command = sessionId
      ? `codex exec resume ${shellQuoteId(sessionId)} --json -`
      : 'codex exec --json --last -'
  }
  const prompt = extraContext !== ''
    ? `请继续完成开发任务,并处理以下 review 意见:\n${extraContext}`
    : '请继续完成刚才的开发任务。'

  await appendLog(workflow.key, 'dev', `[clickvibe] 恢复 ${agent} 会话${sessionId ? `(${sessionId})` : ''}…`)
  attachAgentProcess(ctx, live, command, workflow.worktree, prompt, async (exitCode, newSessionId) => {
    await appendLog(workflow.key, 'dev', `[clickvibe] ${agent} 恢复结束,退出码 ${exitCode}`)
    const reloaded = await loadWorkflow(workflow.key)
    if (reloaded) {
      reloaded.stage = exitCode === 0 ? 'review-ready' : 'developing'
      reloaded.devInterrupted = exitCode !== 0
      if (newSessionId) reloaded.devSessionId = newSessionId
      await saveWorkflow(reloaded)
    }
  })

  return { ok: true, taskId }
}

/** Quote an opaque id for a shell command (single-quote safe). */
function shellQuoteId(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
