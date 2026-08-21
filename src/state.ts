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

/** The workflow stage of one issue. */
export type WorkflowStage =
  | 'idle'        // 未开始开发
  | 'developing'  // 开发中(可能有中断)
  | 'review-ready'// 开发完成,待 review
  | 'reviewing'   // review 中
  | 'passed'      // review 通过

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
  devInterrupted: boolean
  reviewAgent: 'codex' | 'claude' | null
  reviewTaskId: string | null
  reviewResult: { passed: boolean; issues: string[]; commentUrl?: string } | null
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
  note?: string
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

/** Load one issue's workflow state; missing file yields a fresh idle record. */
export async function loadWorkflow(key: string): Promise<IssueWorkflow | null> {
  try {
    const raw = await readFile(statePath(key), 'utf8')
    return JSON.parse(raw) as IssueWorkflow
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
        workflows.push(JSON.parse(raw) as IssueWorkflow)
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
  try {
    const dir = dirname(logPath(key, kind))
    await mkdir(dir, { recursive: true })
    await appendFile(logPath(key, kind), `${line}\n`, 'utf8')
  } catch {
    // log persistence is best-effort
  }
}

/** Read a log file's tail; returns up to `limit` last lines. */
export async function readLogTail(key: string, kind: 'dev' | 'review', limit = 500): Promise<string[]> {
  try {
    const raw = await readFile(logPath(key, kind), 'utf8')
    const lines = raw.split('\n')
    return lines.slice(Math.max(0, lines.length - limit - 1), lines.length - 1)
  } catch {
    return []
  }
}

/** Derive a stable issue key from repo + number (safe for filenames). */
export function issueKey(repoKey: string, number: string): string {
  return `${repoKey.replace(/[^A-Za-z0-9_.-]/g, '-')}-${number}`
}
