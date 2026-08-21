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
import { join, basename } from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
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

/**
 * The clickvibe plugin: exports the profile-patch plugin contract.
 */
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
        writeJson(res, 200, { ok: true, workflows })
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
      reviewResult: null,
      updatedAt: Date.now(),
    }
  }
  // 校正路径字段(配置可能变化)
  workflow.worktree = worktree
  workflow.branch = branch

  // 幂等建 worktree(无沙箱:git 需要写主仓库 .git/refs)
  if (!existsSync(worktree)) {
    await appendLog(workflow.key, 'dev', `[clickvibe] 创建 worktree: ${worktree}`)
    await runCommand(
      ctx,
      `git worktree add ${JSON.stringify(worktree)} -b ${JSON.stringify(branch)}`,
      {
        workdir: expandedRepo,
        timeoutMs: 60000,
        sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: expandedRepo },
      },
    )
    await appendLog(workflow.key, 'dev', `[clickvibe] worktree 创建完成`)
  }

  await saveWorkflow(workflow)
  return { ok: true, workflow, worktree, branch }
}

/** Start (or restart) a dev task in the live map with status parsing. */
function attachAgentProcess(
  ctx: Context,
  task: LiveTask,
  command: string,
  workdir: string,
  prompt: string,
  onExit: (exitCode: number | null) => void,
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
      const lines = parseAgentChunk(task.agent, read.delta)
      for (const line of lines) {
        task.lines.push(line.text)
        void appendLog(task.workflowKey, task.kind, line.text)
      }
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
    onExit(process.exitCode)
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

      attachAgentProcess(ctx, live, agentCommand, workflow.worktree, prompt, async (exitCode) => {
        await appendLog(workflow.key, 'dev', `[clickvibe] ${agent} 结束,退出码 ${exitCode}`)
        const reloaded = await loadWorkflow(workflow.key)
        if (reloaded) {
          if (exitCode === 0) {
            reloaded.stage = 'review-ready'
            reloaded.devInterrupted = false
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
  }
  liveTasks.set(taskId, live)
  workflow.reviewAgent = agent
  workflow.reviewTaskId = taskId
  workflow.stage = 'reviewing'
  await saveWorkflow(workflow)

  const prompt = buildReviewPrompt(workflow)
  const agentCommand = agent === 'claude'
    ? 'claude -p --verbose --output-format stream-json'
    : 'codex exec --json -'

  await appendLog(workflow.key, 'review', `[clickvibe] 启动 ${agent} review…`)
  attachAgentProcess(ctx, live, agentCommand, workflow.worktree, prompt, async (exitCode) => {
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

/** Resume an interrupted dev session (codex exec resume / claude --continue). */
async function resumeDevelop(
  ctx: Context,
  payload: unknown,
): Promise<{ ok: true; taskId: string } | { ok: false; error: string }> {
  const body = (payload ?? {}) as { url?: unknown }
  const url = String(body.url ?? '').trim()
  const parsed = parseUrl(url)
  if (!parsed || parsed.kind !== 'issue') {
    return { ok: false, error: '请输入形如 https://github.com/owner/repo/issues/123 的链接' }
  }
  const key = issueKey(`${parsed.owner}/${parsed.repo}`, parsed.number)
  const workflow = await loadWorkflow(key)
  if (!workflow || !workflow.devInterrupted || !workflow.devTaskId) {
    return { ok: false, error: '没有可恢复的中断任务' }
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
  }
  liveTasks.set(taskId, live)
  workflow.devTaskId = taskId
  workflow.devInterrupted = false
  workflow.stage = 'developing'
  await saveWorkflow(workflow)

  // resume 需要会话 id(codex)或 --continue(claude);这里先尝试从日志找 session
  const command = workflow.devAgent === 'claude'
    ? 'claude -p --continue --verbose --output-format stream-json'
    : 'codex exec --json --last -'
  const prompt = '请继续完成刚才的开发任务。'

  await appendLog(workflow.key, 'dev', `[clickvibe] 恢复 ${workflow.devAgent} 会话…`)
  attachAgentProcess(ctx, live, command, workflow.worktree, prompt, async (exitCode) => {
    await appendLog(workflow.key, 'dev', `[clickvibe] ${workflow.devAgent} 恢复结束,退出码 ${exitCode}`)
    const reloaded = await loadWorkflow(workflow.key)
    if (reloaded) {
      reloaded.stage = exitCode === 0 ? 'review-ready' : 'developing'
      reloaded.devInterrupted = exitCode !== 0
      await saveWorkflow(reloaded)
    }
  })

  return { ok: true, taskId }
}
