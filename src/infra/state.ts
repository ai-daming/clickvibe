/** Project-scoped workflow state and task-log compatibility facade. */
import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isAutoRunState } from './contracts.ts'
import type { AutoRunState, DeliveryPublication, DeliveryStats, PromptSnapshot } from './contracts.ts'
export type { AutoRunPausedReason, AutoRunState, AutoRunUnresolvedRound } from './contracts.ts'
import { issueKey, legacyIssueKey, taskLogPath, type WorkflowStorageIdentity } from './state-layout.ts'
import {
  appendTaskLog as appendTaskLogRecord,
  appendTaskLogNext,
  listTaskIds,
  migrateLegacyLog,
  readTaskLog as readTaskLogRecords,
  startTaskLog as createTaskLog,
  type AppendTaskLogOptions,
  type TaskLogKind,
  type TaskLogRead,
} from './task-log-store.ts'
import {
  claimWorkflowTaskState as claimWorkflowTask,
  saveWorkflowState as saveWorkflow,
  saveWorkflowStateForTask as saveWorkflowForTask,
  workflowRevision,
  workflowStatePath,
} from './workflow-persistence.ts'
export { WorkflowConflictError } from './workflow-persistence.ts'
export type { WorkflowTaskClaim, WorkflowTaskCredential } from './workflow-persistence.ts'
export { claimWorkflowTask, saveWorkflow, saveWorkflowForTask, workflowRevision }
export { issueKey } from './state-layout.ts'
export type WorkflowStage =
  | 'idle' // 未开始开发
  | 'developing' // 开发中(可能有中断)
  | 'review-ready' // 开发完成,待 review
  | 'reviewing' // review 中
  | 'passed' // review 通过
export type SessionAgent = 'codex' | 'claude'
export interface DeliveryCleanup {
  worktree: boolean
  localBranch: boolean
  remoteBranch: boolean
  issue: boolean
}
export interface WorkflowDelivery {
  status: 'merged' | 'cleanup-pending' | 'archived'
  mergedAt: string
  prHead: string
  mergeStrategy: 'merge'
  cleanup: DeliveryCleanup
  lastError?: string
}
export interface IssueWorkflow {
  key: string
  url: string
  repoKey: string
  worktree: string
  branch: string
  stage: WorkflowStage
  devAgent: 'codex' | 'claude' | null
  devTaskId: string | null
  devHostJobId?: string | null
  devSessionId: string | null
  devSessionAgent: SessionAgent | null
  devInterrupted: boolean
  reviewAgent: 'codex' | 'claude' | null
  reviewTaskId: string | null
  reviewHostJobId?: string | null
  reviewSessionId: string | null
  reviewSessionAgent: SessionAgent | null
  reviewResult: { passed: boolean; issues: string[]; commentUrl?: string } | null
  /** 关联的 PR 号(开发分支的代码产物);issue 为 key,PR 记录在这里。 */
  prNumber: string | null
  /** 最近一次从 GitHub 看到的 issue 状态(推导『已关闭→无动作』,issue #5)。 */
  issueState: 'OPEN' | 'CLOSED'
  /** 开发基线:开 worktree 时基于的分支与提交(如 origin/main @ a8a7b5f)。 */
  baseRef: string | null
  /** GitHub merge 已确认后的不可逆事实与幂等清理进度。 */
  delivery?: WorkflowDelivery
  /** 最近一次成功抓取或启动授权确认的完整 Issue 需求快照。 */
  issueSnapshot?: PromptSnapshot
  /** Optional controller cache; missing or invalid state never blocks manual actions. */
  autoRun?: AutoRunState
  /** Durable compare-and-swap token. Missing legacy values normalize to zero. */
  revision?: number
  updatedAt: number
  /** 完整历史事件链:每次开发提交/review/恢复各一条,按时间追加。 */
  events: WorkflowEvent[]
}

/** One historical event in an issue's workflow timeline. */
export interface WorkflowEvent {
  kind: 'dev' | 'review' | 'rework' | 'resume' | 'note' | 'merge-override' | 'auto-run'
  at: string
  durationMs?: number
  hash?: string // dev/review 锚定 commit 的短码
  round?: number // Review 结论落地轮次;旧事件缺失时降级展示
  step?: number // 仅 auto-run 事件:本次自动跑已推进的步数(自动动作数);缺失为旧事件
  agent?: SessionAgent // 动作实际使用的 agent 快照
  stats?: DeliveryStats // fork point..锚定 HEAD 的 git 事实
  taskId?: string // 结构化任务日志锚点
  verdict?: { passed: boolean; issues: string[] } // review 结论(仅 review 事件)
  /** review 启动时冻结的 Issue 验收契约。旧事件缺失时按过期处理。 */
  issueContract?: IssueContractSnapshot
  /** 本次开发完成前仍待修复的上一轮 review 问题数。 */
  fixed?: number
  /** 用户在动作触发时填写的附加说明(issue #54);只进 prompt 与本地时间线,不发布到 GitHub。 */
  userContext?: string
  /** 对应公开 GitHub 流水节点的发布结果;缺失表示旧的本地事件。 */
  publication?: DeliveryPublication
  note?: string
  /** 人工放行审计(仅 merge-override 事件):用户确认跳过的门禁项。 */
  skipped?: string[]
  /** 人工放行审计(仅 merge-override 事件):跳过项展示文案,由服务端下发,面板零映射。 */
  skippedLabels?: string[]
  /** 人工放行审计(仅 merge-override 事件):用户填写的放行原因。 */
  reason?: string
  /** 人工放行审计(仅 merge-override 事件):执行放行的本机用户。 */
  operator?: string
}

export interface IssueContractSnapshot {
  /** GitHub issue body 原文的 SHA-256。 */
  bodyHash: string
  /** GitHub 在冻结快照时返回的 updatedAt，保留作审计证据。 */
  updatedAt: string
}
export function issueBodyHash(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex')
}

/** Apply the durable state shared by initial-development and resumed runs. */
export function applyDevRunOutcome(
  workflow: IssueWorkflow,
  status: 'running' | 'done' | 'failed' | 'stopped' | 'timed_out',
  exitCode: number | null,
  sessionId: string | null,
  agent: SessionAgent,
): boolean {
  const completed = status === 'done' && exitCode === 0
  workflow.stage = completed ? 'review-ready' : 'developing'
  workflow.devInterrupted = !completed
  // The session starts before the task completes. Keep its id even when the
  // process is later killed or exits non-zero so recovery resumes this session.
  recordSessionId(workflow, 'dev', sessionId, agent)
  if (completed) workflow.reviewResult = null
  return completed
}

/** Persist a session id together with the agent family that emitted it. */
export function recordSessionId(
  workflow: IssueWorkflow,
  kind: 'dev' | 'review',
  sessionId: string | null,
  agent: SessionAgent,
): void {
  if (!sessionId) return
  if (kind === 'dev') {
    workflow.devSessionId = sessionId
    workflow.devSessionAgent = agent
  } else {
    workflow.reviewSessionId = sessionId
    workflow.reviewSessionAgent = agent
  }
}

/** Validate ownership before resume; legacy/unknown/mismatched owners are stale. */
export function resolveSessionForAgent(
  workflow: IssueWorkflow,
  kind: 'dev' | 'review',
  agent: SessionAgent,
): { sessionId: string | null; invalid: boolean } {
  const idField = kind === 'dev' ? 'devSessionId' : 'reviewSessionId'
  const agentField = kind === 'dev' ? 'devSessionAgent' : 'reviewSessionAgent'
  const sessionId = workflow[idField]
  if (!sessionId) {
    workflow[agentField] = null
    return { sessionId: null, invalid: false }
  }
  if (workflow[agentField] !== agent) {
    workflow[idField] = null
    workflow[agentField] = null
    return { sessionId: null, invalid: true }
  }
  return { sessionId, invalid: false }
}

/** Clear only the rejected id, never a newer session captured concurrently. */
export function clearStaleSessionId(
  workflow: IssueWorkflow,
  kind: 'dev' | 'review',
  rejectedSessionId: string,
): boolean {
  const field = kind === 'dev' ? 'devSessionId' : 'reviewSessionId'
  const agentField = kind === 'dev' ? 'devSessionAgent' : 'reviewSessionAgent'
  if (workflow[field] !== rejectedSessionId) return false
  workflow[field] = null
  workflow[agentField] = null
  return true
}

function normalizeWorkflow(workflow: IssueWorkflow): IssueWorkflow {
  const raw = workflow as IssueWorkflow & Record<string, unknown>
  if (raw.devSessionAgent !== 'codex' && raw.devSessionAgent !== 'claude') workflow.devSessionAgent = null
  if (raw.reviewSessionAgent !== 'codex' && raw.reviewSessionAgent !== 'claude') workflow.reviewSessionAgent = null
  if (!workflow.devSessionId) workflow.devSessionAgent = null
  if (!workflow.reviewSessionId) workflow.reviewSessionAgent = null
  if (!isAutoRunState(workflow.autoRun)) delete workflow.autoRun
  if (workflow.revision === undefined) workflow.revision = 0
  return workflow
}

/** Append one event to a workflow and persist. */
export async function appendEvent(
  workflow: IssueWorkflow,
  event: WorkflowEvent,
  expectedRevision: number,
): Promise<void> {
  workflow.events = workflow.events ?? []
  workflow.events.push(event)
  await saveWorkflow(workflow, expectedRevision)
}

/** Derive the per-issue state directory. */
export function stateDir(): string {
  return join(homedir(), '.clickvibe', 'state')
}

export function statePath(workflow: WorkflowStorageIdentity): string {
  return workflowStatePath(workflow)
}

export function logPath(workflow: WorkflowStorageIdentity, kind: TaskLogKind, taskId: string): string {
  return taskLogPath(stateDir(), workflow, kind, taskId)
}

async function readWorkflowFile(path: string): Promise<IssueWorkflow | null> {
  try {
    return normalizeWorkflow(JSON.parse(await readFile(path, 'utf8')) as IssueWorkflow)
  } catch {
    return null
  }
}

function currentKey(workflow: IssueWorkflow): string | null {
  const number = workflow.url.match(/\/(?:issues|pull)\/(\d+)(?:[/?#]|$)/)?.[1]
  if (!number) return null
  try {
    return issueKey(workflow.repoKey, number)
  } catch {
    return null
  }
}

async function storedWorkflowFiles(): Promise<string[]> {
  const root = stateDir()
  const files: string[] = []
  try {
    for (const owner of await readdir(root, { withFileTypes: true })) {
      if (!owner.isDirectory() || owner.name === 'archive') continue
      for (const repo of await readdir(join(root, owner.name), { withFileTypes: true })) {
        if (!repo.isDirectory()) continue
        for (const issue of await readdir(join(root, owner.name, repo.name), { withFileTypes: true })) {
          if (issue.isDirectory() && /^issue-[1-9]\d*$/.test(issue.name)) {
            files.push(join(root, owner.name, repo.name, issue.name, 'workflow.json'))
          }
        }
      }
    }
  } catch {
    return files
  }
  return files
}

async function migrateWorkflowLogs(workflow: IssueWorkflow): Promise<void> {
  for (const kind of ['dev', 'review'] as const) {
    const legacy = join(stateDir(), workflow.key, `${kind}.log`)
    const taskId = kind === 'dev' ? workflow.devTaskId : workflow.reviewTaskId
    if (!taskId) continue
    try {
      await migrateLegacyLog(
        stateDir(),
        workflow,
        kind,
        taskId,
        legacy,
        new Date(workflow.updatedAt || 0).toISOString(),
      )
    } catch {
      // Best effort: leave the source untouched so a later startup can retry.
    }
  }
}

async function migrateLegacyWorkflowFile(path: string): Promise<void> {
  const workflow = await readWorkflowFile(path)
  if (!workflow) return
  const destination = statePath(workflow)
  try {
    const existing = await readWorkflowFile(destination)
    if (existing && existing.key !== workflow.key) throw new Error('workflow migration target belongs to another issue')
    if (!existing) await saveWorkflow(workflow, null)
    await rm(path)
    await migrateWorkflowLogs(workflow)
  } catch {
    // Migration is retryable and must not prevent startup.
  }
}

const migrations = new Map<string, Promise<void>>()

async function migrateLegacyState(): Promise<void> {
  const root = stateDir()
  const existing = migrations.get(root)
  if (existing) return existing
  const migration = (async () => {
    try {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.json')) {
          await migrateLegacyWorkflowFile(join(root, entry.name))
        }
      }
      const archive = join(root, 'archive')
      try {
        for (const entry of await readdir(archive, { withFileTypes: true })) {
          if (entry.isFile() && entry.name.endsWith('.json')) await migrateLegacyWorkflowFile(join(archive, entry.name))
        }
        await rm(archive, { recursive: false }).catch(() => undefined)
      } catch {
        // No legacy archive directory.
      }
    } catch {
      // Missing state root or a transient read failure is non-fatal.
    }
  })()
  migrations.set(root, migration)
  try {
    await migration
  } finally {
    if (migrations.get(root) === migration) migrations.delete(root)
  }
}

export async function loadWorkflow(key: string): Promise<IssueWorkflow | null> {
  await migrateLegacyState()
  for (const path of await storedWorkflowFiles()) {
    const workflow = await readWorkflowFile(path)
    if (workflow && (workflow.key === key || currentKey(workflow) === key || legacyIssueKey(workflow.key) === key)) {
      await migrateWorkflowLogs(workflow)
      return workflow.delivery?.status === 'archived' ? null : workflow
    }
  }
  return null
}

export async function loadAllWorkflows(): Promise<IssueWorkflow[]> {
  await migrateLegacyState()
  const workflows: IssueWorkflow[] = []
  for (const path of await storedWorkflowFiles()) {
    const workflow = await readWorkflowFile(path)
    if (workflow) {
      await migrateWorkflowLogs(workflow)
      if (workflow.delivery?.status !== 'archived') workflows.push(workflow)
    }
  }
  return workflows.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function loadAllArchivedWorkflows(): Promise<IssueWorkflow[]> {
  await migrateLegacyState()
  const workflows: IssueWorkflow[] = []
  for (const path of await storedWorkflowFiles()) {
    const workflow = await readWorkflowFile(path)
    if (workflow?.delivery?.status === 'archived') workflows.push(workflow)
  }
  return workflows.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function archiveWorkflow(workflow: IssueWorkflow, expectedRevision: number): Promise<void> {
  await saveWorkflow(workflow, expectedRevision)
}

export async function startTaskLog(workflow: IssueWorkflow, kind: TaskLogKind, taskId: string): Promise<void> {
  try {
    await createTaskLog(stateDir(), workflow, kind, taskId)
  } catch {
    // Log persistence remains best-effort.
  }
}

export async function appendTaskLog(
  workflow: IssueWorkflow,
  kind: TaskLogKind,
  taskId: string,
  sequence: number,
  line: string,
  options: AppendTaskLogOptions = {},
): Promise<void> {
  try {
    await appendTaskLogRecord(stateDir(), workflow, kind, taskId, sequence, line, options)
  } catch {
    // Log persistence remains best-effort.
  }
}

export async function readTaskLog(workflow: IssueWorkflow, kind: TaskLogKind, taskId: string): Promise<TaskLogRead> {
  return readTaskLogRecords(stateDir(), workflow, kind, taskId)
}

/** Compatibility append for workflow actions outside a live agent task. */
export async function appendLog(key: string, kind: 'dev' | 'review', line: string): Promise<void> {
  try {
    const workflow = await loadWorkflow(key)
    let taskId = kind === 'dev' ? workflow?.devTaskId : workflow?.reviewTaskId
    if (workflow && !taskId) {
      taskId = `legacy-${kind}-${Date.now()}`
      if (kind === 'dev') workflow.devTaskId = taskId
      else workflow.reviewTaskId = taskId
      await saveWorkflow(workflow, workflowRevision(workflow))
      await migrateWorkflowLogs(workflow)
    }
    if (workflow && taskId) {
      await appendTaskLogNext(stateDir(), workflow, kind, taskId, line)
      return
    }
    const legacyAlias = legacyIssueKey(key)
    let storageKey = key
    if (legacyAlias) {
      try {
        await readFile(join(stateDir(), legacyAlias, `${kind}.log`), 'utf8')
        storageKey = legacyAlias
      } catch {
        // No legacy alias exists; use the current stable id.
      }
    }
    const legacyPath = join(stateDir(), storageKey, `${kind}.log`)
    await mkdir(join(legacyPath, '..'), { recursive: true })
    await appendFile(legacyPath, `${line}\n`, 'utf8')
  } catch {
    // log persistence is best-effort
  }
}

/** @deprecated New task generations call startTaskLog with an explicit task id. */
export async function resetLog(key: string, kind: 'dev' | 'review'): Promise<void> {
  const workflow = await loadWorkflow(key)
  const taskId = kind === 'dev' ? workflow?.devTaskId : workflow?.reviewTaskId
  if (workflow && taskId) await startTaskLog(workflow, kind, taskId)
}

/** Read the complete durable log at an ordered snapshot boundary. */
export async function readLogHistory(key: string, kind: 'dev' | 'review'): Promise<string[]> {
  const workflow = await loadWorkflow(key)
  if (!workflow) {
    try {
      const raw = await readFile(join(stateDir(), key, `${kind}.log`), 'utf8')
      const lines = raw.split('\n')
      if (lines.at(-1) === '') lines.pop()
      return lines
    } catch {
      return []
    }
  }
  const taskId = kind === 'dev' ? workflow.devTaskId : workflow.reviewTaskId
  if (!taskId) return []
  return (await readTaskLog(workflow, kind, taskId)).encodedLines
}

export async function readLogTail(key: string, kind: 'dev' | 'review', limit = 500): Promise<string[]> {
  const lines = await readLogHistory(key, kind)
  return lines.slice(Math.max(0, lines.length - limit))
}

export async function findTaskHistory(taskId: string): Promise<{
  workflow: IssueWorkflow
  kind: TaskLogKind
  history: TaskLogRead
} | null> {
  for (const workflow of [...(await loadAllWorkflows()), ...(await loadAllArchivedWorkflows())]) {
    for (const kind of ['dev', 'review'] as const) {
      if ((await listTaskIds(stateDir(), workflow, kind)).includes(taskId)) {
        return { workflow, kind, history: await readTaskLog(workflow, kind, taskId) }
      }
    }
  }
  return null
}

export async function findWorkflowByIssue(repoKey: string, issue: string): Promise<IssueWorkflow | null> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoKey) || !/^[1-9]\d*$/.test(issue)) return null
  for (const workflow of [...(await loadAllWorkflows()), ...(await loadAllArchivedWorkflows())]) {
    const number = workflow.url.match(/\/(?:issues|pull)\/(\d+)(?:[/?#]|$)/)?.[1]
    if (workflow.repoKey === repoKey && number === issue) return workflow
  }
  return null
}
