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

export interface WorkflowTaskClaim extends WorkflowTaskCredential {
  agent: 'codex' | 'claude'
  hostJobId: string | null
}

export class WorkflowConflictError extends Error {
  readonly currentRevision: number | null

  constructor(currentRevision: number | null) {
    super('workflow revision conflict')
    this.name = 'WorkflowConflictError'
    this.currentRevision = currentRevision
  }
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

export function workflowRevision(workflow: Pick<IssueWorkflow, 'revision'>): number | null {
  return workflow.revision ?? null
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

function storedRevision(workflow: IssueWorkflow): number {
  if (workflow.revision === undefined) return 0
  if (!Number.isSafeInteger(workflow.revision) || workflow.revision < 0) {
    throw new Error('invalid workflow revision')
  }
  return workflow.revision
}

async function readCurrent(path: string): Promise<IssueWorkflow | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as IssueWorkflow
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function atomicWrite(path: string, workflow: IssueWorkflow): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(workflow, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function conditionalCommit(
  workflow: IssueWorkflow,
  expectedRevision: number | null,
  task?: WorkflowTaskCredential,
): Promise<{ committed: true } | { committed: false; currentRevision: number | null }> {
  const path = workflowStatePath(workflow)
  const release = await acquireLock(path)
  try {
    const current = await readCurrent(path)
    const currentRevision = current ? storedRevision(current) : null
    if (currentRevision !== expectedRevision || (task && (!current || !ownsCurrentTask(current, task)))) {
      return { committed: false, currentRevision }
    }
    const next = {
      ...workflow,
      revision: (currentRevision ?? 0) + 1,
      updatedAt: Date.now(),
    }
    await atomicWrite(path, next)
    Object.assign(workflow, next)
    return { committed: true }
  } finally {
    await release()
  }
}

/** Commit one snapshot only if its durable revision is still current. */
export async function saveWorkflowState(workflow: IssueWorkflow, expectedRevision: number | null): Promise<void> {
  const result = await conditionalCommit(workflow, expectedRevision)
  if (!result.committed) throw new WorkflowConflictError(result.currentRevision)
}

/** Establish one complete task generation; no intermediate owner can be persisted. */
export async function claimWorkflowTaskState(
  workflow: IssueWorkflow,
  claim: WorkflowTaskClaim,
  expectedRevision: number | null,
): Promise<void> {
  const next: IssueWorkflow = { ...workflow }
  if (claim.kind === 'dev') {
    next.devAgent = claim.agent
    next.devTaskId = claim.taskId
    next.devHostJobId = claim.hostJobId
    next.devInterrupted = false
    next.stage = 'developing'
  } else {
    next.reviewAgent = claim.agent
    next.reviewTaskId = claim.taskId
    next.reviewHostJobId = claim.hostJobId
    next.stage = 'reviewing'
  }
  await saveWorkflowState(next, expectedRevision)
  Object.assign(workflow, next)
}

/** A false result means only capability/revision conflict; persistence errors throw. */
export async function saveWorkflowStateForTask(
  workflow: IssueWorkflow,
  credential: WorkflowTaskCredential,
  expectedRevision: number,
): Promise<boolean> {
  return (await conditionalCommit(workflow, expectedRevision, credential)).committed
}
