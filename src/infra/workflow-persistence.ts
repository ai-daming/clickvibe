import { randomBytes } from 'node:crypto'
import { link, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
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

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function recoverDeadLock(lockPath: string): Promise<void> {
  try {
    const owner = JSON.parse(await readFile(lockPath, 'utf8')) as { pid: number; token: string }
    if (!owner.token || processAlive(owner.pid)) return
    // A token-specific hard link is an atomic recovery claim. Only its creator
    // may unlink the stale lock, so a competing recovery cannot remove a new lock.
    await link(lockPath, `${lockPath}.stale-${owner.token}`)
    await unlink(lockPath)
  } catch {
    // The owner is alive, another process recovered it, or the lock disappeared.
  }
}

async function acquireLock(path: string): Promise<() => Promise<void>> {
  const lockPath = `${path}.lock`
  const token = `${process.pid}-${randomBytes(8).toString('hex')}`
  const candidate = `${lockPath}.${token}.candidate`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(candidate, JSON.stringify({ pid: process.pid, token }), 'utf8')
  const deadline = Date.now() + 10_000
  try {
    while (true) {
      try {
        await link(candidate, lockPath)
        return () => unlink(lockPath).catch(() => undefined)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EEXIST') throw error
        await recoverDeadLock(lockPath)
        if (Date.now() >= deadline) throw new Error(`workflow lock timeout: ${path}`)
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
      }
    }
  } finally {
    await unlink(candidate).catch(() => undefined)
  }
}

async function serialize<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const release = await acquireLock(path)
  try {
    return await operation()
  } finally {
    await release()
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
