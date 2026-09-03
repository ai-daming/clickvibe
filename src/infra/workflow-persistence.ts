import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { acquireLinkLock } from './link-lock.ts'
import type { IssueWorkflow } from './state.ts'
import { workflowPath, type WorkflowStorageIdentity } from './state-layout.ts'
import { applyWorkflowMetadataPatch, TASK_STATE_FIELDS, type WorkflowMetadataPatch } from './workflow-metadata.ts'
import { assertLegacyStateWriteAllowed } from './v02-generation-fence.ts'
export type { WorkflowMetadataPatch } from './workflow-metadata.ts'
export interface WorkflowTaskCredential {
  kind: 'dev' | 'review'
  taskId: string
}
declare const workflowTaskLeaseBrand: unique symbol
/** Opaque lifecycle capability signed by a successful task claim/commit. */
export interface WorkflowTaskLease extends WorkflowTaskCredential {
  readonly taskStateRevision: number
  readonly [workflowTaskLeaseBrand]: true
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

type Committed = { status: 'committed'; revision: number; taskStateRevision: number; workflow: IssueWorkflow }
type TaskCommitted = Committed & { lease: WorkflowTaskLease }
type RevisionConflict = { status: 'revision-conflict'; currentRevision: number; currentTaskStateRevision: number }
type OwnershipLost = {
  status: 'ownership-lost'
  currentRevision: number | null
  currentTaskStateRevision: number | null
}
type ConditionalRevisionConflict = {
  status: 'revision-conflict'
  currentRevision: number | null
  currentTaskStateRevision?: number
}
type ConditionalCommitResult = Committed | OwnershipLost | ConditionalRevisionConflict

export type WorkflowTaskCommitResult = TaskCommitted | OwnershipLost | RevisionConflict

export type WorkflowTaskClaimResult =
  | TaskCommitted
  | (OwnershipLost & { currentTask: WorkflowTaskCredential | null })
  | RevisionConflict

export type WorkflowTaskStopResult = Committed | OwnershipLost

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

function signWorkflowTaskLease(task: WorkflowTaskCredential, taskStateRevision: number): WorkflowTaskLease {
  return Object.freeze({ kind: task.kind, taskId: task.taskId, taskStateRevision }) as WorkflowTaskLease
}

export function workflowRevision(workflow: Pick<IssueWorkflow, 'revision'>): number | null {
  return workflow.revision ?? null
}

export function workflowStatePath(workflow: WorkflowStorageIdentity): string {
  return workflowPath(join(homedir(), '.clickvibe', 'state'), workflow)
}

const workflowCommandQueues = new Map<string, Promise<void>>()

/**
 * One local command order per durable workflow. Every exported mutation enters
 * here before competing for the cross-process file lock, so callback, stop,
 * claim and ordinary writes cannot form independent in-process ordering domains.
 */
function enqueueWorkflowCommand<T>(workflow: WorkflowStorageIdentity, execute: () => Promise<T>): Promise<T> {
  const key = workflowStatePath(workflow)
  assertLegacyStateWriteAllowed(join(homedir(), '.clickvibe', 'state'))
  const previous = workflowCommandQueues.get(key) ?? Promise.resolve()
  const operation = previous
    .catch(() => undefined)
    .then(async () => {
      assertLegacyStateWriteAllowed(join(homedir(), '.clickvibe', 'state'))
      return execute()
    })
  const tail = operation.then(
    () => undefined,
    () => undefined,
  )
  workflowCommandQueues.set(key, tail)
  void tail.finally(() => {
    if (workflowCommandQueues.get(key) === tail) workflowCommandQueues.delete(key)
  })
  return operation
}

const acquireLock = acquireLinkLock

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
  assertLegacyStateWriteAllowed(join(homedir(), '.clickvibe', 'state'))
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  try {
    assertLegacyStateWriteAllowed(join(homedir(), '.clickvibe', 'state'))
    await writeFile(temporary, JSON.stringify(workflow, null, 2), { encoding: 'utf8', mode: 0o600 })
    assertLegacyStateWriteAllowed(join(homedir(), '.clickvibe', 'state'))
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function commit(
  path: string,
  current: IssueWorkflow | null,
  source: IssueWorkflow,
  revision: number,
  forceTaskStateAdvance = false,
): Promise<Committed> {
  const currentTaskStateRevision = current ? storedTaskStateRevision(current) : storedTaskStateRevision(source)
  const taskStateRevision =
    currentTaskStateRevision + Number(current !== null && (forceTaskStateAdvance || taskStateChanged(current, source)))
  const next = { ...source, revision: revision + 1, taskStateRevision, updatedAt: Date.now() }
  await atomicWrite(path, next)
  return { status: 'committed', revision: next.revision, taskStateRevision, workflow: next }
}

async function conditionalCommit(
  identity: WorkflowStorageIdentity,
  workflow: IssueWorkflow,
  expectedRevision: number | null,
  task?: WorkflowTaskCredential,
  expectedTaskStateRevision?: number,
  forceTaskStateAdvance = false,
): Promise<ConditionalCommitResult> {
  const path = workflowStatePath(identity)
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
    return await commit(path, current, workflow, currentRevision ?? 0, forceTaskStateAdvance)
  } finally {
    await release()
  }
}

/** Commit metadata only; lifecycle fields are rejected before and inside the lock. */
async function commitWorkflowMetadata(
  identity: WorkflowStorageIdentity,
  expectedRevision: number | null,
  patch: WorkflowMetadataPatch,
): Promise<IssueWorkflow> {
  const path = workflowStatePath(identity)
  const release = await acquireLock(path)
  try {
    const current = await readCurrent(path)
    const currentRevision = current ? storedRevision(current) : null
    if (currentRevision !== expectedRevision) throw new WorkflowConflictError(currentRevision)
    const next = applyWorkflowMetadataPatch(identity, current, patch)
    return (await commit(path, current, next, currentRevision ?? 0)).workflow
  } finally {
    await release()
  }
}

/** Establish one complete task generation; no intermediate owner can be persisted. */
async function claimWorkflowTask(
  identity: WorkflowStorageIdentity,
  claim: WorkflowTaskClaim,
  expectedRevision: number | null,
  expectation: WorkflowTaskExpectation,
): Promise<WorkflowTaskClaimResult> {
  if (typeof claim.hostJobId !== 'string' || claim.hostJobId.trim() === '') {
    throw new Error('task claim hostJobId must be non-empty')
  }
  const path = workflowStatePath(identity)
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
    if (!current) return { status: 'ownership-lost', currentRevision, currentTaskStateRevision, currentTask }
    const next: IssueWorkflow = { ...current }
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
    const committed = await commit(path, current, next, currentRevision ?? 0, true)
    return { ...committed, lease: signWorkflowTaskLease(claim, committed.taskStateRevision) }
  } finally {
    await release()
  }
}

/** Distinguish a retryable same-owner revision from permanent capability loss. */
async function saveWorkflowForTask(
  identity: WorkflowStorageIdentity,
  workflow: IssueWorkflow,
  lease: WorkflowTaskLease,
  expectedRevision: number,
): Promise<WorkflowTaskCommitResult> {
  const result = await conditionalCommit(identity, workflow, expectedRevision, lease, lease.taskStateRevision)
  if (result.status === 'revision-conflict' && result.currentTaskStateRevision === undefined) {
    return { status: 'ownership-lost', currentRevision: result.currentRevision, currentTaskStateRevision: null }
  }
  return result.status === 'committed'
    ? { ...result, lease: signWorkflowTaskLease(lease, result.taskStateRevision) }
    : (result as OwnershipLost | RevisionConflict)
}

/** Reapply one pure task mutation after metadata-only revisions without holding the file lock. */
async function mutateWorkflowForTask(
  identity: WorkflowStorageIdentity,
  lease: WorkflowTaskLease,
  mutate: (current: IssueWorkflow) => void,
): Promise<Exclude<WorkflowTaskCommitResult, { status: 'revision-conflict' }>> {
  let current = await readCurrent(workflowStatePath(identity))
  if (!current) return { status: 'ownership-lost', currentRevision: null, currentTaskStateRevision: null }
  while (true) {
    const next = structuredClone(current)
    mutate(next)
    const result = await saveWorkflowForTask(identity, next, lease, storedRevision(current))
    if (result.status === 'committed') return result
    if (result.status === 'ownership-lost') return result
    const reloaded = await readCurrent(workflowStatePath(identity))
    if (!reloaded) return { status: 'ownership-lost', currentRevision: null, currentTaskStateRevision: null }
    current = reloaded
  }
}

/** Controller-only stop transition: exact task + frozen observation, always revoking the prior task lease. */
async function stopWorkflowTask(
  identity: WorkflowStorageIdentity,
  task: WorkflowTaskCredential,
): Promise<WorkflowTaskStopResult> {
  const path = workflowStatePath(identity)
  const release = await acquireLock(path)
  try {
    const current = await readCurrent(path)
    const currentRevision = current ? storedRevision(current) : null
    const currentTaskStateRevision = current ? storedTaskStateRevision(current) : null
    if (!current || !ownsCurrentTask(current, task)) {
      return { status: 'ownership-lost', currentRevision, currentTaskStateRevision }
    }
    const next = structuredClone(current)
    next.stage = task.kind === 'dev' ? 'developing' : 'review-ready'
    if (task.kind === 'dev') {
      next.devInterrupted = true
    } else {
      next.reviewResult = null
      next.reviewSessionId = null
      next.reviewSessionAgent = null
    }
    const committed = await commit(path, current, next, currentRevision ?? 0, true)
    return committed
  } finally {
    await release()
  }
}

/** Revision-checked metadata command; lifecycle fields are unrepresentable at its API boundary. */
export function commitWorkflowMetadataCommand(
  identity: WorkflowStorageIdentity,
  expectedRevision: number | null,
  patch: WorkflowMetadataPatch,
): Promise<IssueWorkflow> {
  return enqueueWorkflowCommand(identity, () => commitWorkflowMetadata(identity, expectedRevision, patch))
}

type BaselineRestoreWorkflowTransaction = {
  commitMetadata(identity: WorkflowStorageIdentity, patch: WorkflowMetadataPatch): Promise<IssueWorkflow>
}
/** Hold all related durable workflow locks through baseline validation and restoration. */
export function withBaselineRestoreWorkflowLocksCommand<T>(
  identities: WorkflowStorageIdentity[],
  operation: (transaction: BaselineRestoreWorkflowTransaction) => Promise<T>,
): Promise<T> {
  const unique = new Map(identities.map((identity) => [workflowStatePath(identity), identity]))
  const ordered = [...unique.entries()].sort(([left], [right]) => left.localeCompare(right))
  const acquire = (index: number): Promise<T> => {
    if (index >= ordered.length) {
      const lockedPaths = new Set(ordered.map(([path]) => path))
      return operation({
        commitMetadata: async (identity, patch) => {
          const path = workflowStatePath(identity)
          if (!lockedPaths.has(path)) throw new Error(`baseline restore transaction does not own ${path}`)
          const current = await readCurrent(path)
          const next = applyWorkflowMetadataPatch(identity, current, patch)
          return (await commit(path, current, next, current ? storedRevision(current) : 0)).workflow
        },
      })
    }
    const [path, identity] = ordered[index]
    return enqueueWorkflowCommand(identity, async () => {
      const release = await acquireLock(path)
      try {
        return await acquire(index + 1)
      } finally {
        await release()
      }
    })
  }
  return acquire(0)
}

/** Semantic claim command. Raw claim persistence remains private to this module. */
export function claimWorkflowTaskCommand(
  identity: WorkflowStorageIdentity,
  claim: WorkflowTaskClaim,
  expectedRevision: number | null,
  expectation: WorkflowTaskExpectation,
): Promise<WorkflowTaskClaimResult> {
  return enqueueWorkflowCommand(identity, () => claimWorkflowTask(identity, claim, expectedRevision, expectation))
}

/** Semantic callback command. Its frozen lease is validated inside the durable critical section. */
export function mutateWorkflowTaskCommand(
  identity: WorkflowStorageIdentity,
  lease: WorkflowTaskLease,
  mutate: (current: IssueWorkflow) => void,
): Promise<Exclude<WorkflowTaskCommitResult, { status: 'revision-conflict' }>> {
  return enqueueWorkflowCommand(identity, () => mutateWorkflowForTask(identity, lease, mutate))
}

/** Semantic stop command and chain terminator for the exact current task. */
export function stopWorkflowTaskCommand(
  identity: WorkflowStorageIdentity,
  task: WorkflowTaskCredential,
): Promise<WorkflowTaskStopResult> {
  return enqueueWorkflowCommand(identity, () => stopWorkflowTask(identity, task))
}
