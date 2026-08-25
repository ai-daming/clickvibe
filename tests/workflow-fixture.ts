import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { type IssueWorkflow, issueKey, statePath, WorkflowConflictError } from '../src/infra/state.ts'

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

export function autoRunWorkflowFixture(
  tempHome: string,
  number: string,
  overrides: Partial<IssueWorkflow> = {},
): IssueWorkflow {
  return {
    key: issueKey('owner/repo', number),
    url: `https://github.com/owner/repo/issues/${number}`,
    repoKey: 'owner/repo',
    worktree: tempHome,
    branch: `clickvibe-issue-${number}`,
    stage: 'idle',
    devAgent: null,
    devTaskId: null,
    devHostJobId: null,
    devSessionId: null,
    devSessionAgent: null,
    devInterrupted: false,
    reviewAgent: null,
    reviewTaskId: null,
    reviewHostJobId: null,
    reviewSessionId: null,
    reviewSessionAgent: null,
    reviewResult: null,
    prNumber: null,
    issueState: 'OPEN',
    baseRef: 'origin/main @ b9c6dea',
    autoRun: {
      status: 'running',
      autoMerge: false,
      devAgent: 'codex',
      reviewAgent: 'codex',
      maxRounds: 20,
      budgetHours: 24,
      startedAt: new Date().toISOString(),
      deadline: new Date(Date.now() + 60_000).toISOString(),
      step: 1,
      rounds: 0,
      unresolved: [],
      lastObservedAt: null,
      pausedReason: null,
    },
    updatedAt: Date.now(),
    events: [],
    ...overrides,
  }
}

/** Test setup only: writes an otherwise unreachable persisted lifecycle fixture. */
export async function commitWorkflowFixture(workflow: IssueWorkflow, expectedRevision: number | null): Promise<void> {
  const path = statePath(workflow)
  let current: IssueWorkflow | null = null
  try {
    current = JSON.parse(await readFile(path, 'utf8')) as IssueWorkflow
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const currentRevision = current?.revision ?? null
  if (currentRevision !== expectedRevision) throw new WorkflowConflictError(currentRevision)
  const taskStateChanged =
    current !== null && TASK_STATE_FIELDS.some((field) => !isDeepStrictEqual(current?.[field], workflow[field]))
  const next = {
    ...workflow,
    revision: (currentRevision ?? 0) + 1,
    taskStateRevision: (current?.taskStateRevision ?? workflow.taskStateRevision ?? 0) + Number(taskStateChanged),
    updatedAt: Date.now(),
  }
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.fixture`
  try {
    await writeFile(temporary, JSON.stringify(next, null, 2), 'utf8')
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
  Object.assign(workflow, next)
}
