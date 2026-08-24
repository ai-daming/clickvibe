import { randomBytes } from 'node:crypto'
import { link, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { IssueWorkflow } from './state.ts'
import { workflowPath, type WorkflowStorageIdentity } from './state-layout.ts'

export interface WorkflowTaskCredential {
  kind: 'dev' | 'review'
  taskId: string
}

export interface WorkflowTaskClaim extends WorkflowTaskCredential {
  agent: 'codex' | 'claude'
  hostJobId: string
  resetSession?: boolean
  prNumber?: string | null
}

export interface WorkflowTaskExpectation {
  task: WorkflowTaskCredential | null
  taskStateRevision: number
}

type Committed = { status: 'committed'; revision: number; taskStateRevision: number }
type RevisionConflict = { status: 'revision-conflict'; currentRevision: number; currentTaskStateRevision: number }
type OwnershipLost = {
  status: 'ownership-lost'
  currentRevision: number | null
  currentTaskStateRevision: number | null
}

export type WorkflowTaskCommitResult = Committed | OwnershipLost | RevisionConflict

export type WorkflowTaskClaimResult =
  | Committed
  | (OwnershipLost & { currentTask: WorkflowTaskCredential | null })
  | RevisionConflict

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

function storedTaskStateRevision(workflow: Pick<IssueWorkflow, 'taskStateRevision'>): number {
  if (workflow.taskStateRevision === undefined) return 0
  if (!Number.isSafeInteger(workflow.taskStateRevision) || workflow.taskStateRevision < 0) {
    throw new Error('invalid workflow taskStateRevision')
  }
  return workflow.taskStateRevision
}

const TASK_STATE_FIELDS = [
  'stage',
  'devAgent',
  'devTaskId',
  'devHostJobId',
  'devSessionId',
  'devSessionAgent',
  'devInterrupted',
  'reviewAgent',
  'reviewTaskId',
  'reviewHostJobId',
  'reviewSessionId',
  'reviewSessionAgent',
  'reviewResult',
] as const satisfies readonly (keyof IssueWorkflow)[]

function taskStateChanged(current: IssueWorkflow, next: IssueWorkflow): boolean {
  return TASK_STATE_FIELDS.some((field) => {
    const currentValue =
      field === 'devSessionAgent' && !current.devSessionId
        ? null
        : field === 'reviewSessionAgent' && !current.reviewSessionId
          ? null
          : current[field]
    const nextValue =
      field === 'devSessionAgent' && !next.devSessionId
        ? null
        : field === 'reviewSessionAgent' && !next.reviewSessionId
          ? null
          : next[field]
    if (field === 'stage') return currentValue !== nextValue
    if (field === 'devInterrupted') return Boolean(currentValue) !== Boolean(nextValue)
    return !isDeepStrictEqual(currentValue ?? null, nextValue ?? null)
  })
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

async function commit(
  path: string,
  target: IssueWorkflow,
  current: IssueWorkflow | null,
  source: IssueWorkflow,
  revision: number,
): Promise<Committed> {
  const currentTaskStateRevision = current ? storedTaskStateRevision(current) : storedTaskStateRevision(source)
  const taskStateRevision = currentTaskStateRevision + Number(current !== null && taskStateChanged(current, source))
  const next = { ...source, revision: revision + 1, taskStateRevision, updatedAt: Date.now() }
  await atomicWrite(path, next)
  Object.assign(target, next)
  return { status: 'committed', revision: next.revision, taskStateRevision }
}

async function conditionalCommit(
  workflow: IssueWorkflow,
  expectedRevision: number | null,
  task?: WorkflowTaskCredential,
  expectedTaskStateRevision?: number,
): Promise<WorkflowTaskCommitResult | { status: 'revision-conflict'; currentRevision: number | null }> {
  const path = workflowStatePath(workflow)
  const release = await acquireLock(path)
  try {
    const current = await readCurrent(path)
    const currentRevision = current ? storedRevision(current) : null
    const currentTaskStateRevision = current ? storedTaskStateRevision(current) : null
    if (
      task &&
      (!current || !ownsCurrentTask(current, task) || currentTaskStateRevision !== expectedTaskStateRevision)
    ) {
      return { status: 'ownership-lost', currentRevision, currentTaskStateRevision }
    }
    if (currentRevision !== expectedRevision) {
      if (currentTaskStateRevision === null) return { status: 'revision-conflict', currentRevision }
      return { status: 'revision-conflict', currentRevision, currentTaskStateRevision }
    }
    return await commit(path, workflow, current, workflow, currentRevision ?? 0)
  } finally {
    await release()
  }
}

/** Commit one snapshot only if its durable revision is still current. */
export async function saveWorkflowState(workflow: IssueWorkflow, expectedRevision: number | null): Promise<void> {
  const result = await conditionalCommit(workflow, expectedRevision)
  if (result.status !== 'committed') throw new WorkflowConflictError(result.currentRevision)
}

/** Establish one complete task generation; no intermediate owner can be persisted. */
export async function claimWorkflowTaskState(
  workflow: IssueWorkflow,
  claim: WorkflowTaskClaim,
  expectedRevision: number | null,
  expectation: WorkflowTaskExpectation,
): Promise<WorkflowTaskClaimResult> {
  if (typeof claim.hostJobId !== 'string' || claim.hostJobId.trim() === '') {
    throw new Error('task claim hostJobId must be non-empty')
  }
  const path = workflowStatePath(workflow)
  const release = await acquireLock(path)
  try {
    const current = await readCurrent(path)
    const currentRevision = current ? storedRevision(current) : null
    const currentTaskStateRevision = current ? storedTaskStateRevision(current) : null
    const currentTask = current ? currentWorkflowTaskRef(current) : null
    if (currentTask?.kind !== expectation.task?.kind || currentTask?.taskId !== expectation.task?.taskId) {
      return { status: 'ownership-lost', currentRevision, currentTaskStateRevision, currentTask }
    }
    if (currentTaskStateRevision !== expectation.taskStateRevision) {
      return { status: 'ownership-lost', currentRevision, currentTaskStateRevision, currentTask }
    }
    if (currentRevision !== expectedRevision) {
      if (currentRevision === null || currentTaskStateRevision === null) {
        return { status: 'ownership-lost', currentRevision, currentTaskStateRevision, currentTask }
      }
      return { status: 'revision-conflict', currentRevision, currentTaskStateRevision }
    }
    const next: IssueWorkflow = { ...(current ?? workflow) }
    if (claim.kind === 'dev') {
      next.devAgent = claim.agent
      next.devTaskId = claim.taskId
      next.devHostJobId = claim.hostJobId
      next.devInterrupted = false
      if (claim.resetSession) {
        next.devSessionId = null
        next.devSessionAgent = null
      }
      next.stage = 'developing'
    } else {
      next.reviewAgent = claim.agent
      next.reviewTaskId = claim.taskId
      next.reviewHostJobId = claim.hostJobId
      if (claim.resetSession) {
        next.reviewSessionId = null
        next.reviewSessionAgent = null
      }
      if (claim.prNumber !== undefined) next.prNumber = claim.prNumber
      next.stage = 'reviewing'
    }
    return await commit(path, workflow, current, next, currentRevision ?? 0)
  } finally {
    await release()
  }
}

/** Distinguish a retryable same-owner revision from permanent capability loss. */
export async function saveWorkflowStateForTask(
  workflow: IssueWorkflow,
  credential: WorkflowTaskCredential,
  expectedRevision: number,
  expectedTaskStateRevision: number,
): Promise<WorkflowTaskCommitResult> {
  return conditionalCommit(
    workflow,
    expectedRevision,
    credential,
    expectedTaskStateRevision,
  ) as Promise<WorkflowTaskCommitResult>
}

/** Reapply one pure task mutation after metadata-only revisions without holding the file lock. */
export async function mutateWorkflowStateForTask(
  workflow: IssueWorkflow,
  credential: WorkflowTaskCredential,
  mutate: (current: IssueWorkflow) => void,
): Promise<Exclude<WorkflowTaskCommitResult, { status: 'revision-conflict' }>> {
  let current = workflow
  const expectedTaskStateRevision = storedTaskStateRevision(workflow)
  while (true) {
    const next = structuredClone(current)
    mutate(next)
    const result = await saveWorkflowStateForTask(next, credential, storedRevision(current), expectedTaskStateRevision)
    if (result.status === 'committed') {
      Object.assign(workflow, next)
      return result
    }
    if (result.status === 'ownership-lost') return result
    const reloaded = await readCurrent(workflowStatePath(workflow))
    if (!reloaded) return { status: 'ownership-lost', currentRevision: null, currentTaskStateRevision: null }
    current = reloaded
  }
}
