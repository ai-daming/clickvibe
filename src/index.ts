/**
 * clickvibe host half:
 * - `/clickvibe/api/fetch` — fetch GitHub issue/PR data via gh,
 * - `/clickvibe/api/develop` — start a development task: create a git
 *   worktree + branch for the issue's repo, then run codex/claude
 *   non-interactively inside it,
 * - `/clickvibe/api/develop/poll` — consume incremental task log/status.
 *
 * Config lives at ~/.clickvibe/config.yaml (see project README).
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { parse as parseYaml } from 'yaml'

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

/** Body size bound of one JSON request (defense against unbounded reads). */
const MAX_BODY_BYTES = 64 * 1024

/** Fields the issue fetch requests from gh (all verified against rc.8). */
const ISSUE_FIELDS = [
  'number', 'title', 'state', 'stateReason', 'author', 'createdAt',
  'updatedAt', 'closedAt', 'body', 'url', 'labels', 'assignees',
  'milestone', 'comments', 'reactionGroups', 'isPinned',
].join(',')

/** Fields the PR fetch requests from gh (all verified against rc.8). */
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

/** One in-flight development task. */
interface DevTask {
  id: string
  repo: string
  number: string
  worktree: string
  branch: string
  agent: 'codex' | 'claude'
  status: 'creating' | 'running' | 'done' | 'failed'
  exitCode: number | null
  log: string[]
  process?: ReturnType<Context['shell']['start']>
}

const tasks = new Map<string, DevTask>()

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
 * The clickvibe plugin: exports the profile-patch plugin contract
 * (inject / apply) the cordis loader expects.
 */
export const name = 'clickvibe'

export const inject = ['webServer', 'shell']

export function apply(ctx: Context): void {
  ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://clickvibe.internal').pathname
      const method = pathname.startsWith(`${ROUTE}/`) ? pathname.slice(`${ROUTE}/`.length) : undefined
      const knownMethods = new Set(['fetch', 'develop', 'develop/poll'])
      if (method === undefined || !knownMethods.has(method)) {
        writeJson(res, 404, { ok: false, error: 'unknown method' })
        return
      }

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
      if (method === 'develop') {
        const result = await startDevelop(ctx, payload)
        writeJson(res, result.ok ? 200 : 400, result)
        return
      }
      if (method === 'develop/poll') {
        const result = pollDevelop(payload)
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
): Promise<{ ok: true; data: { kind: 'issue' | 'pr'; item: unknown } } | { ok: false; error: string }> {
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
    return { ok: true, data: { kind: parsed.kind, item: parsedJson } }
  } catch (error) {
    return { ok: false, error: `抓取异常: ${String(error instanceof Error ? error.message : error)}` }
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

/** Start a development task: worktree + branch + background agent run. */
async function startDevelop(
  ctx: Context,
  payload: unknown,
): Promise<
  | { ok: true; taskId: string; worktree: string; branch: string }
  | { ok: false; error: string }
> {
  const body = (payload ?? {}) as { url?: unknown; agent?: unknown }
  const url = String(body.url ?? '').trim()
  const agentRaw = String(body.agent ?? 'codex').trim().toLowerCase()
  const agent = agentRaw === 'claude' ? 'claude' : 'codex'
  const parsed = parseUrl(url)
  if (!parsed) {
    return { ok: false, error: '请输入形如 https://github.com/owner/repo/issues/123 的链接' }
  }
  if (parsed.kind !== 'issue') {
    return { ok: false, error: '一键开发仅支持 issue 链接' }
  }

  const config = await loadConfig()
  const repoKey = `${parsed.owner}/${parsed.repo}`
  const repoPath = config.repos[repoKey]
  if (!repoPath) {
    return {
      ok: false,
      error: `本地未配置仓库 ${repoKey},请在 ~/.clickvibe/config.yaml 的 repos 中添加映射`,
    }
  }
  const expandedRepo = expandHome(repoPath)
  if (!existsSync(expandedRepo)) {
    return { ok: false, error: `仓库路径不存在: ${expandedRepo}` }
  }

  const project = basename(expandedRepo)
  const branch = `${project}-issue-${parsed.number}`
  const worktree = join(config.worktreeRoot, project, branch)

  // 同一 issue 已有任务在跑:直接返回现有任务
  for (const task of tasks.values()) {
    if (task.repo === repoKey && task.number === parsed.number && task.status !== 'failed') {
      return { ok: true, taskId: task.id, worktree: task.worktree, branch: task.branch }
    }
  }

  const taskId = `dev-${Date.now()}`
  const task: DevTask = {
    id: taskId,
    repo: repoKey,
    number: parsed.number,
    worktree,
    branch,
    agent,
    status: 'creating',
    exitCode: null,
    log: [],
  }
  tasks.set(taskId, task)

  void (async () => {
    try {
      // 幂等建 worktree:已存在则跳过
      task.log.push(`[clickvibe] worktree: ${worktree}`)
      if (!existsSync(worktree)) {
        const worktreeOut = await runCommand(
          ctx,
          `git worktree add ${JSON.stringify(worktree)} -b ${JSON.stringify(branch)}`,
          {
            workdir: expandedRepo,
            timeoutMs: 60000,
            // git 需要写主仓库的 .git/refs(sandbox 默认 read-only 会以
            // EPERM 拒绝创建 ref 锁),worktree 创建必须在无沙箱下进行
            sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: expandedRepo },
          },
        )
        task.log.push(`[clickvibe] worktree 创建完成: ${worktreeOut}`)
      } else {
        task.log.push('[clickvibe] worktree 已存在,复用')
      }

      // 抓 issue 数据拼 prompt
      task.log.push('[clickvibe] 抓取 issue 数据…')
      const fetchResult = await fetchIssue(ctx, { url })
      if (!fetchResult.ok) {
        throw new Error(fetchResult.error)
      }
      const prompt = buildPrompt(fetchResult.data.item as Record<string, unknown>)

      // 后台启动 agent
      task.log.push(`[clickvibe] 启动 ${agent} 开发…`)
      task.status = 'running'
      const agentCommand = agent === 'claude'
        ? 'claude -p - --output-format text'
        : 'codex exec --json -'
      const spec = ctx.shell.resolve({
        command: agentCommand,
        workdir: worktree,
        stdin: prompt,
        timeoutMs: 600000,
        // codex/claude 需要完整的 IPC/进程能力,sandbox 会以 EPERM 拒绝其
        // app-server 初始化 —— 开发任务必须在无沙箱(danger-full-access)下运行
        sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: worktree },
      })
      const process = ctx.shell.start(spec)
      task.process = process
      void process.done.then(() => {
        task.exitCode = process.exitCode
        task.status = process.exitCode === 0 ? 'done' : 'failed'
        task.log.push(`[clickvibe] ${agent} 结束,退出码 ${process.exitCode}`)
      })
    } catch (error) {
      task.status = 'failed'
      task.exitCode = null
      task.log.push(`[clickvibe] 失败: ${String(error instanceof Error ? error.message : error)}`)
    }
  })()

  return { ok: true, taskId, worktree, branch }
}

/** Consume incremental log/status for one task. */
function pollDevelop(
  payload: unknown,
): { ok: true; taskId: string; status: string; exitCode: number | null; delta: string[]; done: boolean } | { ok: false; error: string } {
  const taskId = String((payload as { taskId?: unknown } | undefined)?.taskId ?? '')
  const task = tasks.get(taskId)
  if (!task) {
    return { ok: false, error: `未知任务 ${taskId}` }
  }
  const delta: string[] = []
  if (task.process) {
    const read = task.process.readOutput()
    if (read.delta !== '') delta.push(read.delta)
    if (read.lossy) delta.push('[clickvibe] 输出被截断(日志过长)')
  }
  // 内部日志(worktree 创建等)增量补发
  const newLogs = task.log.splice(0, task.log.length)
  delta.push(...newLogs)
  return {
    ok: true,
    taskId,
    status: task.status,
    exitCode: task.exitCode,
    delta,
    done: task.status === 'done' || task.status === 'failed',
  }
}
