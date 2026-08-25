import type { IssueWorkflow } from './state.ts'
import type { WorkflowStorageIdentity } from './state-layout.ts'

export const TASK_STATE_FIELDS = [
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

type TaskStateField = (typeof TASK_STATE_FIELDS)[number]
type ProtectedWorkflowField =
  | TaskStateField
  | 'key'
  | 'url'
  | 'repoKey'
  | 'revision'
  | 'taskStateRevision'
  | 'updatedAt'
type WorkflowMetadataField = Exclude<keyof IssueWorkflow, ProtectedWorkflowField>

/** Metadata patch incapable of carrying lifecycle state, even via a typed workflow variable. */
export type WorkflowMetadataPatch = Partial<Pick<IssueWorkflow, WorkflowMetadataField>> & {
  readonly [Field in ProtectedWorkflowField]?: never
}

const WORKFLOW_METADATA_FIELDS = new Set<WorkflowMetadataField>([
  'worktree',
  'branch',
  'prNumber',
  'issueState',
  'baseRef',
  'delivery',
  'issueSnapshot',
  'autoRun',
  'events',
])

export function applyWorkflowMetadataPatch(
  identity: WorkflowStorageIdentity,
  current: IssueWorkflow | null,
  patch: WorkflowMetadataPatch,
): IssueWorkflow {
  for (const field of Object.keys(patch)) {
    if (!WORKFLOW_METADATA_FIELDS.has(field as WorkflowMetadataField)) {
      throw new Error(`workflow metadata patch cannot write ${field}`)
    }
  }
  if (current) return { ...current, ...patch }
  if (typeof patch.worktree !== 'string' || typeof patch.branch !== 'string') {
    throw new Error('new workflow metadata requires worktree and branch')
  }
  return {
    key: identity.key,
    url: identity.url,
    repoKey: identity.repoKey,
    worktree: patch.worktree,
    branch: patch.branch,
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
    prNumber: patch.prNumber ?? null,
    issueState: patch.issueState ?? 'OPEN',
    baseRef: patch.baseRef ?? null,
    ...(patch.delivery === undefined ? {} : { delivery: patch.delivery }),
    ...(patch.issueSnapshot === undefined ? {} : { issueSnapshot: patch.issueSnapshot }),
    ...(patch.autoRun === undefined ? {} : { autoRun: patch.autoRun }),
    updatedAt: 0,
    events: patch.events ?? [],
  }
}
