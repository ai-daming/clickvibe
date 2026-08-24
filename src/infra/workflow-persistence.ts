import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { IssueWorkflow } from './state.ts'
import { workflowPath, type WorkflowStorageIdentity } from './state-layout.ts'

export interface WorkflowTaskCredential {
  kind: 'dev' | 'review'
  taskId: string
}

type OwnershipFields = Pick<IssueWorkflow, 'stage' | 'devTaskId' | 'reviewTaskId'>

function taskSequence(taskId: string): number {
  const value = Number(taskId.match(/^[a-z]+-(\d+)-/)?.[1])
  return Number.isSafeInteger(value) ? value : 0
}

/** The one persisted answer to which task generation currently owns workflow writes. */
export function currentWorkflowTaskRef(workflow: OwnershipFields): WorkflowTaskCredential | null {
  if (workflow.stage === 'developing' && workflow.devTaskId) return { kind: 'dev', taskId: workflow.devTaskId }
  if (workflow.stage === 'reviewing' && workflow.reviewTaskId) return { kind: 'review', taskId: workflow.reviewTaskId }
  const tasks: WorkflowTaskCredential[] = [
    ...(workflow.devTaskId ? [{ kind: 'dev' as const, taskId: workflow.devTaskId }] : []),
    ...(workflow.reviewTaskId ? [{ kind: 'review' as const, taskId: workflow.reviewTaskId }] : []),
  ]
  return tasks.reduce<WorkflowTaskCredential | null>((latest, task) => {
    if (!latest) return task
    return taskSequence(task.taskId) >= taskSequence(latest.taskId) ? task : latest
  }, null)
}

function ownsCurrentTask(workflow: OwnershipFields, credential: WorkflowTaskCredential): boolean {
  const current = currentWorkflowTaskRef(workflow)
  return current?.kind === credential.kind && current.taskId === credential.taskId
}

export function workflowStatePath(workflow: WorkflowStorageIdentity): string {
  return workflowPath(join(homedir(), '.clickvibe', 'state'), workflow)
}

const queueSymbol = Symbol.for('clickvibe.workflow-write-queues')
type QueueGlobal = typeof globalThis & { [queueSymbol]?: Map<string, Promise<void>> }
const queueGlobal = globalThis as QueueGlobal
if (!queueGlobal[queueSymbol]) queueGlobal[queueSymbol] = new Map()
const writeQueues = queueGlobal[queueSymbol]

async function serialize<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(path) ?? Promise.resolve()
  const result = previous.catch(() => undefined).then(operation)
  const settled = result.then(
    () => undefined,
    () => undefined,
  )
  writeQueues.set(path, settled)
  try {
    return await result
  } finally {
    if (writeQueues.get(path) === settled) writeQueues.delete(path)
  }
}

async function atomicWrite(path: string, workflow: IssueWorkflow): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  workflow.updatedAt = Date.now()
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(workflow, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

export async function saveWorkflowStateStrict(workflow: IssueWorkflow): Promise<void> {
  const path = workflowStatePath(workflow)
  await serialize(path, () => atomicWrite(path, workflow))
}

export async function saveWorkflowState(workflow: IssueWorkflow): Promise<void> {
  await saveWorkflowStateStrict(workflow).catch(() => undefined)
}

/** Validate the task capability after taking the per-workflow lock, then atomically commit. */
export async function saveWorkflowStateForTask(
  workflow: IssueWorkflow,
  credential: WorkflowTaskCredential,
): Promise<boolean> {
  const path = workflowStatePath(workflow)
  return serialize(path, async () => {
    let current: IssueWorkflow
    try {
      current = JSON.parse(await readFile(path, 'utf8')) as IssueWorkflow
    } catch {
      return false
    }
    if (!ownsCurrentTask(current, credential)) return false
    await atomicWrite(path, workflow)
    return true
  }).catch(() => false)
}
