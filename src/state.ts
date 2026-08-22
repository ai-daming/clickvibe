/**
 * clickvibe persistent workflow state.
 *
 * One JSON document per issue under ~/.clickvibe/state/, plus per-issue log
 * files. Survives web restarts and page refreshes so the panel can restore
 * its context (the issue being viewed + its dev/review workflow stage).
 */
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import type { DeliveryPublication } from './delivery-publication.ts'

/** The workflow stage of one issue. */
export type WorkflowStage =
  | 'idle'        // 未开始开发
  | 'developing'  // 开发中(可能有中断)
  | 'review-ready'// 开发完成,待 review
  | 'reviewing'   // review 中
  | 'passed'      // review 通过

export type SessionAgent = 'codex' | 'claude'

export interface IssueWorkflow {
  key: string
  url: string
  repoKey: string
  worktree: string
  branch: string
  stage: WorkflowStage
  devAgent: 'codex' | 'claude' | null
  devTaskId: string | null
  devSessionId: string | null
  devSessionAgent: SessionAgent | null
  devInterrupted: boolean
  reviewAgent: 'codex' | 'claude' | null
  reviewTaskId: string | null
  reviewSessionId: string | null
  reviewSessionAgent: SessionAgent | null
  reviewResult: { passed: boolean; issues: string[]; commentUrl?: string } | null
  /** 关联的 PR 号(开发分支的代码产物);issue 为 key,PR 记录在这里。 */
  prNumber: string | null
  /** 最近一次从 GitHub 看到的 issue 状态(推导『已关闭→无动作』,issue #5)。 */
  issueState: 'OPEN' | 'CLOSED'
  /** 开发基线:开 worktree 时基于的分支与提交(如 origin/main @ a8a7b5f)。 */
  baseRef: string | null
  updatedAt: number
  /** 完整历史事件链:每次开发提交/review/恢复各一条,按时间追加。 */
  events: WorkflowEvent[]
}

/** One historical event in an issue's workflow timeline. */
export interface WorkflowEvent {
  kind: 'dev' | 'review' | 'rework' | 'resume' | 'note'
  at: string
  /** commit hash 短码(dev/review 锚定的提交)。 */
  hash?: string
  /** review 结论(仅 review 事件)。 */
  verdict?: { passed: boolean; issues: string[] }
  /** 本次开发完成前仍待修复的上一轮 review 问题数。 */
  fixed?: number
  /** 对应公开 GitHub 流水节点的发布结果;缺失表示旧的本地事件。 */
  publication?: DeliveryPublication
  note?: string
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
  return workflow
}

/** Append one event to a workflow and persist. */
export async function appendEvent(workflow: IssueWorkflow, event: WorkflowEvent): Promise<void> {
  workflow.events = workflow.events ?? []
  workflow.events.push(event)
  await saveWorkflow(workflow)
}

/** Derive the per-issue state directory. */
export function stateDir(): string {
  return join(homedir(), '.clickvibe', 'state')
}

/** Derive the state file path for one issue key. */
export function statePath(key: string): string {
  return join(stateDir(), `${key}.json`)
}

/** Derive the log file path for one issue's dev/review log. */
export function logPath(key: string, kind: 'dev' | 'review'): string {
  return join(stateDir(), key, `${kind}.log`)
}

// Keep every operation for one persistent log in call order. Besides avoiding
// reordered appendFile completions, this gives /history a real snapshot
// boundary: writes queued before the read are included, later writes are SSE
// increments after the returned in-memory cursor.
const logQueues = new Map<string, Promise<unknown>>()

function enqueueLogOperation<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = logQueues.get(path) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(operation)
  logQueues.set(path, current)
  void current.finally(() => {
    if (logQueues.get(path) === current) logQueues.delete(path)
  }).catch(() => undefined)
  return current
}

/** Load one issue's workflow state; missing file yields a fresh idle record. */
export async function loadWorkflow(key: string): Promise<IssueWorkflow | null> {
  try {
    const raw = await readFile(statePath(key), 'utf8')
    return normalizeWorkflow(JSON.parse(raw) as IssueWorkflow)
  } catch {
    return null
  }
}

/** Load every stored workflow (for panel restore). */
export async function loadAllWorkflows(): Promise<IssueWorkflow[]> {
  try {
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(stateDir())
    const workflows: IssueWorkflow[] = []
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      try {
        const raw = await readFile(join(stateDir(), entry), 'utf8')
        workflows.push(normalizeWorkflow(JSON.parse(raw) as IssueWorkflow))
      } catch {
        // corrupt state file: skip
      }
    }
    return workflows.sort((a, b) => b.updatedAt - a.updatedAt)
  } catch {
    return []
  }
}

/** Persist one issue's workflow state (atomic-ish: write then ignore errors). */
export async function saveWorkflow(workflow: IssueWorkflow): Promise<void> {
  try {
    await mkdir(stateDir(), { recursive: true })
    workflow.updatedAt = Date.now()
    await writeFile(statePath(workflow.key), JSON.stringify(workflow, null, 2), 'utf8')
  } catch {
    // state persistence must never break the request path
  }
}

/** Append one line to an issue's log file (creating the directory). */
export async function appendLog(key: string, kind: 'dev' | 'review', line: string): Promise<void> {
  const path = logPath(key, kind)
  try {
    await enqueueLogOperation(path, async () => {
      await mkdir(dirname(path), { recursive: true })
      await appendFile(path, `${line}\n`, 'utf8')
    })
  } catch {
    // log persistence is best-effort
  }
}

/** Start a new task generation while preserving full history within that run. */
export async function resetLog(key: string, kind: 'dev' | 'review'): Promise<void> {
  const path = logPath(key, kind)
  try {
    await enqueueLogOperation(path, async () => {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, '', 'utf8')
    })
  } catch {
    // log persistence is best-effort
  }
}

/** Read the complete durable log at an ordered snapshot boundary. */
export async function readLogHistory(key: string, kind: 'dev' | 'review'): Promise<string[]> {
  const path = logPath(key, kind)
  try {
    return await enqueueLogOperation(path, async () => {
      const raw = await readFile(path, 'utf8')
      const lines = raw.split('\n')
      if (lines.at(-1) === '') lines.pop()
      return lines
    })
  } catch {
    return []
  }
}

/** Read a log file's tail; returns up to `limit` last lines. */
export async function readLogTail(key: string, kind: 'dev' | 'review', limit = 500): Promise<string[]> {
  const lines = await readLogHistory(key, kind)
  return lines.slice(Math.max(0, lines.length - limit))
}

/** Derive a stable issue key from repo + number (safe for filenames). */
export function issueKey(repoKey: string, number: string): string {
  return `${repoKey.replace(/[^A-Za-z0-9_.-]/g, '-')}-${number}`
}
