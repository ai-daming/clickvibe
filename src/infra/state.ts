/** Project-scoped workflow state and task-log compatibility facade. */
import { createHash } from 'node:crypto'
import { appendFile, link, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isAutoRunState } from './contracts.ts'
import type { AutoRunState, DeliveryPublication, DeliveryStats, PromptSnapshot } from './contracts.ts'
export type { AutoRunPausedReason, AutoRunState, AutoRunUnresolvedRound } from './contracts.ts'
import { issueKey, taskLogPath, type WorkflowStorageIdentity } from './state-layout.ts'
import {
  appendTaskLog as appendTaskLogRecord,
  appendTaskLogNext,
  listTaskIds,
  readTaskLog as readTaskLogRecords,
  startTaskLog as createTaskLog,
  type AppendTaskLogOptions,
  type TaskLogKind,
  type TaskLogRead,
} from './task-log-store.ts'
import {
  commitWorkflowMetadataCommand,
  type WorkflowMetadataPatch,
  workflowRevision,
  workflowStatePath,
} from './workflow-persistence.ts'
import { assertActiveStateWriteAllowed, isV02GenerationViolation } from './v02-generation-fence.ts'
import type { RemoteGitWriteAttempt } from './remote-git-coordinator.ts'
export { WorkflowConflictError } from './workflow-persistence.ts'
export type * from './workflow-persistence.ts'
export { workflowRevision }
export { applyDevRunOutcome, clearStaleSessionId, recordSessionId, resolveSessionForAgent } from './workflow-session.ts'
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
  /** Merge-cleanup-owned delete marker; prepared recovery is readback-only. */
  remoteBranchAttempt?: RemoteGitWriteAttempt
  issue: boolean
  /** 关闭评论写事务的 attempt marker(merge 清理步骤账本):'pending' 表示已准备派发,重启恢复只回读;'confirmed' 表示已发布。 */
  issueComment?: 'pending' | 'confirmed'
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
  /** PR 创建写事务的 attempt marker:派发前落盘,重启恢复只回读不再创建。 */
  prCreate?: { status: 'pending'; at: string }
  /** Caller-owned Remote Git write markers. Terminal attempts remain as audit
   *  evidence; prepared/unknown attempts recover by readback only. */
  remoteGitAttempts?: Partial<Record<'sync' | 'pr-push' | 'baseline-restore', RemoteGitWriteAttempt>>
  /** 最近一次从 GitHub 看到的 issue 状态(推导『已关闭→无动作』,issue #5)。 */
  issueState: 'OPEN' | 'CLOSED'
  /** 开发基线:不可变远端分支 + 最近一次成功合入 worktree 并持久化的 tip。 */
  baseRef: string | null
  /** GitHub merge 已确认后的不可逆事实与幂等清理进度。 */
  delivery?: WorkflowDelivery
  /** 最近一次成功抓取或启动授权确认的完整 Issue 需求快照。 */
  issueSnapshot?: PromptSnapshot
  /** Optional controller cache; missing or invalid state never blocks manual actions. */
  autoRun?: AutoRunState
  revision?: number
  taskStateRevision?: number
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
  reviewBase?: { ref: string; sha: string } // PR retargeting invalidates the verdict
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
  /** 原生 Approve 尝试凭证(仅 review 事件,slice B):派发前落盘,回读谓词安全恢复。 */
  approvalAttempt?: { status: 'pending' | 'confirmed' | 'failed' | 'unknown' }
  operator?: string
}

export type IssueContractSnapshot =
  | { fingerprint: `wic1_${string}`; capturedAt: string }
  | { bodyHash: string; updatedAt: string } // decoded legacy evidence; never authorizes a v0.2 action

type WorkflowMetadataState = WorkflowStorageIdentity &
  Pick<
    IssueWorkflow,
    | 'worktree'
    | 'branch'
    | 'prNumber'
    | 'issueState'
    | 'baseRef'
    | 'delivery'
    | 'issueSnapshot'
    | 'autoRun'
    | 'events'
    | 'remoteGitAttempts'
  >

/** Persist metadata without accepting any lifecycle field or whole workflow snapshot. */
export function commitWorkflowMetadata(
  identity: WorkflowStorageIdentity,
  expectedRevision: number | null,
  patch: WorkflowMetadataPatch,
): Promise<IssueWorkflow> {
  return commitWorkflowMetadataCommand(identity, expectedRevision, patch)
}

export function issueBodyHash(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex')
}

function normalizeWorkflow(workflow: IssueWorkflow): IssueWorkflow {
  const raw = workflow as IssueWorkflow & Record<string, unknown>
  if (raw.devSessionAgent !== 'codex' && raw.devSessionAgent !== 'claude') workflow.devSessionAgent = null
  if (raw.reviewSessionAgent !== 'codex' && raw.reviewSessionAgent !== 'claude') workflow.reviewSessionAgent = null
  if (!workflow.devSessionId) workflow.devSessionAgent = null
  if (!workflow.reviewSessionId) workflow.reviewSessionAgent = null
  if (!isAutoRunState(workflow.autoRun)) delete workflow.autoRun
  if (workflow.revision === undefined) workflow.revision = 0
  if (workflow.taskStateRevision === undefined) workflow.taskStateRevision = 0
  return workflow
}

/** Append one event to a workflow and persist. */
export async function appendEvent(
  workflow: WorkflowMetadataState,
  event: WorkflowEvent,
  expectedRevision: number,
): Promise<void> {
  workflow.events = workflow.events ?? []
  workflow.events.push(event)
  Object.assign(
    workflow,
    await commitWorkflowMetadata(workflow, expectedRevision, {
      worktree: workflow.worktree,
      branch: workflow.branch,
      prNumber: workflow.prNumber,
      issueState: workflow.issueState,
      baseRef: workflow.baseRef,
      delivery: workflow.delivery,
      autoRun: workflow.autoRun,
      events: workflow.events,
      remoteGitAttempts: workflow.remoteGitAttempts,
    }),
  )
}

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

export async function loadWorkflow(key: string): Promise<IssueWorkflow | null> {
  for (const path of await storedWorkflowFiles()) {
    const workflow = await readWorkflowFile(path)
    if (workflow && (workflow.key === key || currentKey(workflow) === key)) {
      return workflow.delivery?.status === 'archived' ? null : workflow
    }
  }
  return null
}

export async function loadAllWorkflows(includeArchived = false): Promise<IssueWorkflow[]> {
  const workflows: IssueWorkflow[] = []
  for (const path of await storedWorkflowFiles()) {
    const workflow = await readWorkflowFile(path)
    if (workflow) {
      if (includeArchived || workflow.delivery?.status !== 'archived') workflows.push(workflow)
    }
  }
  return workflows.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function loadAllArchivedWorkflows(): Promise<IssueWorkflow[]> {
  const workflows: IssueWorkflow[] = []
  for (const path of await storedWorkflowFiles()) {
    const workflow = await readWorkflowFile(path)
    if (workflow?.delivery?.status === 'archived') workflows.push(workflow)
  }
  return workflows.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function archiveWorkflow(workflow: WorkflowMetadataState, expectedRevision: number): Promise<void> {
  Object.assign(
    workflow,
    await commitWorkflowMetadata(workflow, expectedRevision, {
      delivery: workflow.delivery,
      issueState: workflow.issueState,
      autoRun: workflow.autoRun,
      events: workflow.events,
    }),
  )
}

export async function startTaskLog(
  workflow: WorkflowStorageIdentity,
  kind: TaskLogKind,
  taskId: string,
): Promise<void> {
  try {
    await createTaskLog(stateDir(), workflow, kind, taskId)
  } catch (reason) {
    if (isV02GenerationViolation(reason)) throw reason
    // Log persistence remains best-effort.
  }
}

export async function appendTaskLog(
  workflow: WorkflowStorageIdentity,
  kind: TaskLogKind,
  taskId: string,
  sequence: number,
  line: string,
  options: AppendTaskLogOptions = {},
): Promise<void> {
  try {
    await appendTaskLogRecord(stateDir(), workflow, kind, taskId, sequence, line, options)
  } catch (reason) {
    if (isV02GenerationViolation(reason)) throw reason
    // Log persistence remains best-effort.
  }
}

export async function readTaskLog(
  workflow: WorkflowStorageIdentity,
  kind: TaskLogKind,
  taskId: string,
): Promise<TaskLogRead> {
  return readTaskLogRecords(stateDir(), workflow, kind, taskId)
}

/** Compatibility append for workflow actions outside a live agent task. */
export async function appendLog(key: string, kind: 'dev' | 'review', line: string): Promise<void> {
  try {
    const workflow = await loadWorkflow(key)
    let taskId = kind === 'dev' ? workflow?.devTaskId : workflow?.reviewTaskId
    if (workflow && !taskId) {
      taskId = null
    }
    if (workflow && taskId) {
      await appendTaskLogNext(stateDir(), workflow, kind, taskId, line)
      return
    }
    const legacyPath = join(stateDir(), key, `${kind}.log`)
    assertActiveStateWriteAllowed(stateDir())
    await mkdir(join(legacyPath, '..'), { recursive: true })
    assertActiveStateWriteAllowed(stateDir())
    await appendFile(legacyPath, `${line}\n`, 'utf8')
  } catch (reason) {
    if (isV02GenerationViolation(reason)) throw reason
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
  const readLegacy = async (): Promise<string[]> => {
    try {
      const raw = await readFile(join(stateDir(), key, `${kind}.log`), 'utf8')
      const lines = raw.split('\n')
      if (lines.at(-1) === '') lines.pop()
      return lines
    } catch {
      return []
    }
  }
  if (!workflow) return readLegacy()
  const taskId = kind === 'dev' ? workflow.devTaskId : workflow.reviewTaskId
  if (!taskId) return readLegacy()
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
