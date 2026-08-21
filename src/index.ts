/** ClickVibe Host routes: GitHub fetch plus issue development tasks. */
import type { Context } from '@deepseek-ai/cordis'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
  LineLog,
  decideWorktreeRecovery,
  parseAgent,
  parseGithubUrl,
  shellQuote,
  type DevelopAgent,
} from './develop.js'

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
        stdoutMaxBytes?: number
        workdir?: string
        stdin?: string
        sandboxPolicy?: {
          mode: 'read-only' | 'workspace-write' | 'danger-full-access'
          workspaceRoot: string
        }
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

const ROUTE = '/clickvibe/api'
const MAX_BODY_BYTES = 64 * 1024
const MAX_LOG_LINES = 2_000
const OUTPUT_PUMP_MS = 200

const ISSUE_FIELDS = [
  'number', 'title', 'state', 'stateReason', 'author', 'createdAt',
  'updatedAt', 'closedAt', 'body', 'url', 'labels', 'assignees',
  'milestone', 'comments', 'reactionGroups', 'isPinned',
].join(',')

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

interface DevTask {
  id: string
  repo: string
  number: string
  worktree: string
  branch: string
  agent: DevelopAgent
  status: 'creating' | 'running' | 'done' | 'failed'
  exitCode: number | null
  log: LineLog
  process?: ReturnType<Context['shell']['start']>
}

interface WorktreeRecord {
  path: string
  branch: string
}

const tasks = new Map<string, DevTask>()

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

async function loadConfig(): Promise<ClickVibeConfig> {
  const configPath = join(homedir(), '.clickvibe', 'config.yaml')
  try {
    const parsed = parseYaml(await readFile(configPath, 'utf8')) as Partial<ClickVibeConfig> | null
    if (parsed?.repos !== undefined && (typeof parsed.repos !== 'object' || parsed.repos === null
      || Object.values(parsed.repos).some((value) => typeof value !== 'string'))) {
      throw new Error('repos 必须是 owner/repo 到本地路径的字符串映射')
    }
    if (parsed?.worktreeRoot !== undefined && typeof parsed.worktreeRoot !== 'string') {
      throw new Error('worktreeRoot 必须是字符串路径')
    }
    return {
      repos: parsed?.repos ?? {},
      worktreeRoot: resolve(expandHome(parsed?.worktreeRoot ?? join(homedir(), '.clickvibe', 'worktrees'))),
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { repos: {}, worktreeRoot: join(homedir(), '.clickvibe', 'worktrees') }
    }
    throw new Error(`读取 ${configPath} 失败: ${String(error instanceof Error ? error.message : error)}`)
  }
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
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
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolveBody(raw === '' ? {} : JSON.parse(raw))
      } catch {
        reject(new Error('malformed JSON body'))
      }
    })
    req.on('error', reject)
  })
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

async function runShell(
  ctx: Context,
  command: string,
  options: {
    workdir?: string
    timeoutMs?: number
    sandboxPolicy?: {
      mode: 'read-only' | 'workspace-write' | 'danger-full-access'
      workspaceRoot: string
    }
  } = {},
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const result = await ctx.shell.run(ctx.shell.resolve({
    command,
    workdir: options.workdir,
    timeoutMs: options.timeoutMs ?? 30_000,
    sandboxPolicy: options.sandboxPolicy,
  }))
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.text.trim(),
    stderr: result.stderr?.text?.trim() ?? '',
  }
}

async function runChecked(
  ctx: Context,
  command: string,
  options: Parameters<typeof runShell>[2] = {},
): Promise<string> {
  const result = await runShell(ctx, command, options)
  if (result.exitCode !== 0) {
    throw new Error(`命令退出码 ${result.exitCode}${result.stderr ? `: ${result.stderr}` : ''}`)
  }
  return result.stdout
}

function parseWorktreeList(output: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = []
  let path: string | null = null
  let branch = 'HEAD'
  for (const line of `${output}\n`.split('\n')) {
    if (line.startsWith('worktree ')) path = resolve(line.slice('worktree '.length))
    else if (line.startsWith('branch refs/heads/')) branch = line.slice('branch refs/heads/'.length)
    else if (line === 'detached') branch = 'HEAD'
    else if (line === '' && path !== null) {
      records.push({ path, branch })
      path = null
      branch = 'HEAD'
    }
  }
  return records
}

async function ensureWorktree(
  ctx: Context,
  repoPath: string,
  worktree: string,
  branch: string,
  log: LineLog,
): Promise<void> {
  const policy = { mode: 'danger-full-access' as const, workspaceRoot: repoPath }
  const list = await runChecked(ctx, 'git worktree list --porcelain', { workdir: repoPath, sandboxPolicy: policy })
  const records = parseWorktreeList(list)
  const normalizedTarget = resolve(worktree)
  const atPath = records.find((record) => record.path === normalizedTarget)
  const atBranch = records.find((record) => record.branch === branch)
  const pathExists = existsSync(normalizedTarget)
  const pathEmpty = pathExists ? (await readdir(normalizedTarget)).length === 0 : false
  const branchCheck = await runShell(
    ctx,
    `git show-ref --verify --quiet ${shellQuote(`refs/heads/${branch}`)}`,
    { workdir: repoPath, sandboxPolicy: policy },
  )
  const recovery = decideWorktreeRecovery({
    targetBranch: branch,
    pathExists,
    pathEmpty,
    registeredBranch: atPath?.branch ?? null,
    branchExists: branchCheck.exitCode === 0,
    branchWorktree: atBranch?.path ?? null,
  })

  if (recovery.kind === 'conflict') throw new Error(recovery.reason)
  if (recovery.kind === 'reuse') {
    log.appendLine('[clickvibe] worktree 与分支已存在,复用')
    return
  }
  if (recovery.kind === 'attach-detached') {
    await runChecked(ctx, `git switch -c ${shellQuote(branch)}`, {
      workdir: normalizedTarget,
      timeoutMs: 60_000,
      sandboxPolicy: policy,
    })
    log.appendLine('[clickvibe] 已为 detached worktree 创建目标分支')
    return
  }
  if (recovery.kind === 'attach-existing') {
    await runChecked(ctx, `git switch ${shellQuote(branch)}`, {
      workdir: normalizedTarget,
      timeoutMs: 60_000,
      sandboxPolicy: policy,
    })
    log.appendLine('[clickvibe] 已将 detached worktree 切换到现有目标分支')
    return
  }

  await mkdir(dirname(normalizedTarget), { recursive: true })
  const branchArg = recovery.kind === 'add-new-branch'
    ? `-b ${shellQuote(branch)}`
    : shellQuote(branch)
  await runChecked(ctx, `git worktree add ${shellQuote(normalizedTarget)} ${branchArg}`, {
    workdir: repoPath,
    timeoutMs: 60_000,
    sandboxPolicy: policy,
  })
  log.appendLine(recovery.kind === 'add-new-branch'
    ? '[clickvibe] worktree 与分支创建完成'
    : '[clickvibe] 已从现有分支恢复 worktree')
}

function buildPrompt(item: Record<string, unknown>): string {
  const comments = Array.isArray(item.comments)
    ? (item.comments as { author?: { login?: string } | null; body?: string }[])
        .map((comment) => `@${comment.author?.login ?? 'unknown'}: ${comment.body ?? ''}`)
        .join('\n\n---\n\n')
    : ''
  return [
    `请开发这个 GitHub issue: ${item.title ?? ''}`,
    String(item.url ?? ''),
    '',
    '--- issue 正文 ---',
    String(item.body ?? ''),
    comments ? `--- 评论 ---\n${comments}` : '',
    '--- 要求 ---',
    '1. 先理解需求,如有歧义可自行判断或提问',
    '2. 实现代码改动',
    '3. 运行相关测试',
    '4. 完成后 git commit 并推送分支',
    '5. 用 gh 创建 PR(若适用)',
  ].join('\n')
}

async function fetchIssue(
  ctx: Context,
  payload: unknown,
): Promise<{ ok: true; data: { kind: 'issue' | 'pr'; item: unknown } } | { ok: false; error: string }> {
  const url = String((payload as { url?: unknown } | undefined)?.url ?? '').trim()
  const parsed = parseGithubUrl(url)
  if (!parsed) {
    return { ok: false, error: '请输入形如 https://github.com/owner/repo/issues/123 或 /pull/123 的链接' }
  }
  const isPR = parsed.kind === 'pr'
  const command = `${isPR ? 'gh pr view' : 'gh issue view'} ${shellQuote(url)} --json ${isPR ? PR_FIELDS : ISSUE_FIELDS}`
  try {
    const result = await runShell(ctx, command, { timeoutMs: 20_000 })
    if (result.exitCode !== 0) {
      return { ok: false, error: result.stderr || `gh 执行失败(exit ${result.exitCode})` }
    }
    return { ok: true, data: { kind: parsed.kind, item: JSON.parse(result.stdout) as unknown } }
  } catch (error) {
    return { ok: false, error: `抓取异常: ${String(error instanceof Error ? error.message : error)}` }
  }
}

function agentCommand(agent: DevelopAgent): string {
  if (agent === 'dryrun') return 'pwd && git branch --show-current && git status --short --branch'
  if (agent === 'claude') return 'claude -p - --output-format stream-json --verbose'
  return 'codex exec --json -s danger-full-access -'
}

function drainProcess(task: DevTask): void {
  if (!task.process) return
  const read = task.process.readOutput()
  if (read.delta !== '') task.log.appendChunk(read.delta)
  if (read.lossy) task.log.appendLine('[clickvibe] agent 原始输出超长,部分内容已截断')
}

function runTaskProcess(ctx: Context, task: DevTask, prompt: string | undefined): void {
  const spec = ctx.shell.resolve({
    command: agentCommand(task.agent),
    workdir: task.worktree,
    stdin: prompt,
    stdoutMaxBytes: 4 * 1024 * 1024,
    sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: task.worktree },
  })
  task.process = ctx.shell.start(spec)
  task.status = 'running'
  task.log.appendLine(`[clickvibe] 启动 ${task.agent}…`)
  const timer = setInterval(() => drainProcess(task), OUTPUT_PUMP_MS)
  void task.process.done.then(() => {
    clearInterval(timer)
    drainProcess(task)
    task.log.flush()
    task.exitCode = task.process?.exitCode ?? null
    task.status = task.exitCode === 0 ? 'done' : 'failed'
    task.log.appendLine(`[clickvibe] ${task.agent} 结束,退出码 ${task.exitCode}`)
  })
}

async function startDevelop(
  ctx: Context,
  payload: unknown,
): Promise<
  | { ok: true; taskId: string; worktree: string; branch: string }
  | { ok: false; error: string }
> {
  const body = (payload ?? {}) as { url?: unknown; agent?: unknown }
  const url = String(body.url ?? '').trim()
  const parsed = parseGithubUrl(url)
  if (!parsed || parsed.kind !== 'issue') return { ok: false, error: '一键开发仅支持 GitHub issue 链接' }

  let agent: DevelopAgent
  try {
    agent = parseAgent(body.agent)
  } catch (error) {
    return { ok: false, error: String(error instanceof Error ? error.message : error) }
  }

  let config: ClickVibeConfig
  try {
    config = await loadConfig()
  } catch (error) {
    return { ok: false, error: String(error instanceof Error ? error.message : error) }
  }
  const repoKey = `${parsed.owner}/${parsed.repo}`
  const configuredRepo = config.repos[repoKey]
  if (!configuredRepo) {
    return { ok: false, error: `本地未配置仓库 ${repoKey},请在 ~/.clickvibe/config.yaml 的 repos 中添加映射` }
  }
  const repoPath = resolve(expandHome(configuredRepo))
  if (!existsSync(repoPath)) return { ok: false, error: `仓库路径不存在: ${repoPath}` }

  const project = basename(repoPath)
  const branch = `${project}-issue-${parsed.number}`
  const worktree = join(config.worktreeRoot, project, branch)
  for (const existing of tasks.values()) {
    if (existing.repo === repoKey && existing.number === parsed.number
      && (existing.status === 'creating' || existing.status === 'running')) {
      if (existing.agent === agent) {
        return { ok: true, taskId: existing.id, worktree: existing.worktree, branch: existing.branch }
      }
      return { ok: false, error: `该 issue 已有 ${existing.agent} 任务运行中` }
    }
  }

  const task: DevTask = {
    id: `dev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    repo: repoKey,
    number: parsed.number,
    worktree,
    branch,
    agent,
    status: 'creating',
    exitCode: null,
    log: new LineLog(MAX_LOG_LINES),
  }
  tasks.set(task.id, task)

  void (async () => {
    try {
      task.log.appendLine(`[clickvibe] worktree: ${worktree}`)
      await ensureWorktree(ctx, repoPath, worktree, branch, task.log)
      if (agent === 'dryrun') {
        runTaskProcess(ctx, task, undefined)
        return
      }
      task.log.appendLine('[clickvibe] 抓取 issue 数据…')
      const fetched = await fetchIssue(ctx, { url })
      if (!fetched.ok) throw new Error(fetched.error)
      runTaskProcess(ctx, task, buildPrompt(fetched.data.item as Record<string, unknown>))
    } catch (error) {
      task.status = 'failed'
      task.log.flush()
      task.log.appendLine(`[clickvibe] 失败: ${String(error instanceof Error ? error.message : error)}`)
    }
  })()

  return { ok: true, taskId: task.id, worktree, branch }
}

function pollDevelop(payload: unknown):
  | {
      ok: true
      taskId: string
      status: DevTask['status']
      exitCode: number | null
      cursor: number
      delta: string[]
      truncated: boolean
      done: boolean
    }
  | { ok: false; error: string } {
  const body = (payload ?? {}) as { taskId?: unknown; cursor?: unknown }
  const taskId = String(body.taskId ?? '')
  const task = tasks.get(taskId)
  if (!task) return { ok: false, error: `未知任务 ${taskId}` }
  const cursor = Number(body.cursor ?? 0)
  const read = task.log.read(cursor)
  return {
    ok: true,
    taskId,
    status: task.status,
    exitCode: task.exitCode,
    cursor: read.cursor,
    delta: read.lines,
    truncated: read.truncated,
    done: task.status === 'done' || task.status === 'failed',
  }
}

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
      const method = pathname.startsWith(`${ROUTE}/`) ? pathname.slice(`${ROUTE}/`.length) : ''
      if (!new Set(['fetch', 'develop', 'develop/poll']).has(method)) {
        writeJson(res, 404, { ok: false, error: `unknown method "${method}"` })
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
      } else if (method === 'develop') {
        const result = await startDevelop(ctx, payload)
        writeJson(res, result.ok ? 200 : 400, result)
      } else {
        const result = pollDevelop(payload)
        writeJson(res, result.ok ? 200 : 400, result)
      }
    },
  })
}
