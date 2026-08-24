# Workflow mutation invariants (#111 redesign)

## Invariants and enforcing construction

| # | Invariant | Construction (`file`: behavior) |
|---|---|---|
| 1 | Metadata and lifecycle ordering are durable and distinct. | `infra/state.ts`: legacy `revision` and `taskStateRevision` normalize to `0`; `infra/workflow-persistence.ts`: every commit increments `revision`, while a lifecycle-field transition or explicit stop/claim advances `taskStateRevision` exactly once. |
| 2 | A running task cannot refresh its lifecycle capability from persisted state. | `infra/workflow-persistence.ts`: claim signs an opaque, frozen `WorkflowTaskLease {kind,taskId,taskStateRevision}`; `infra/runtime.ts`: `LiveTask` stores that lease; `workflow/task-lease.ts`: every callback mutation requires the stored lease and serially replaces it only with the lease returned by its own successful commit. No workflow snapshot can construct a callback lease. |
| 3 | Validation and commit are one awaited cross-process critical section. | `infra/workflow-persistence.ts`: the hard-link lock encloses reread, JSON validation, both tokens, capability validation, increment, temp write and rename; `commit()` is awaited before `finally` releases the lock. |
| 4 | A task starts as one complete generation. | `agent/task-supervisor.ts`: a successful reservation has a non-empty `hostJobId`; develop/resume/review freeze the current task expectation immediately after the ownership gate; `workflow/task-claim.ts` atomically commits `taskId+hostJobId+stage+agent`, stores the returned lease on `LiveTask`, then launches the Agent; losers are settled without a lease or launch. |
| 5 | Same-generation metadata cannot replay an obsolete lifecycle intent. | `infra/workflow-persistence.ts`: callback mutation may retry a `revision-conflict` only with its lease's original `taskStateRevision`; a lifecycle-token change returns `ownership-lost`. Claim retries retain the gate-frozen task ref and lifecycle token. `stopWorkflowTaskState` is a separate controller-only transition that always advances `taskStateRevision`, permanently invalidating the stopped `LiveTask` lease. |
| 6 | Current task has one observed answer. | `infra/task-ownership.ts`: ownership carries exact `{kind,taskId}`; launch/reuse/deadline/stop consumers use it without stage/order guessing. |
| 7 | Conflict classes retain meaning and locks are not re-entered. | `infra/workflow-persistence.ts`: callbacks run outside the lock; results distinguish `committed`, `ownership-lost`, and `revision-conflict+currentRevision+currentTaskStateRevision`; I/O/lock/JSON errors throw. |
| 8 | Missing is not death. | `infra/task-ownership.ts`: local/registry absence yields `unknown` and keeps launch closed; only explicit outcome or supervisor terminal state yields `interrupted`. |

## Static mutation enumeration

| Mutation path | State | Protection |
|---|---|---|
| `agent/prompts.resolvePromptSnapshot` current snapshot | issue snapshot/state | ✓ revision |
| `agent/prompts.resolvePromptSnapshot` fallback | issue snapshot | ✓ revision |
| `agent/worktree.ensureWorktree` | worktree/branch/base | ✓ revision |
| `infra/state.appendEvent` | events | ✓ revision |
| `infra/state.migrateLegacyWorkflowFile` | initial file | ✓ create-only |
| `infra/state.archiveWorkflow` | delivery archive | ✓ revision |
| `infra/state.appendLog` legacy id | task id | ✓ revision |
| `workflow/auto-run.persistDecision` | cursor | ✓ revision |
| `workflow/auto-run.pauseAutoRun` | pause/event | ✓ revision |
| `workflow/auto-run.completeAutoRun` | completion/event | ✓ revision |
| `workflow/auto-run.applyDecision(rework)` | dev agent | ✓ revision |
| `workflow/auto-run.startAutoRun` | config/event | ✓ revision |
| `workflow/create-pr.createPullRequest` | PR number | ✓ revision |
| `workflow/develop-start` via `task-claim` | dev generation | ✓ gate-frozen ref + lifecycle CAS + non-empty host id |
| `workflow/resume` via `task-claim` | dev generation/session reset | ✓ gate-frozen ref + lifecycle CAS + non-empty host id |
| `workflow/review-flow` via `task-claim` | review generation/PR/session | ✓ gate-frozen ref + lifecycle CAS + non-empty host id |
| `workflow/review-start` recovery | review-ready cache | ✓ create/revision |
| `workflow/merge` override event | events | ✓ revision |
| `workflow/merge` delivery | delivery | ✓ revision |
| `workflow/merge.persistStep` | cleanup progress | ✓ revision |
| `workflow/merge.failCleanup` | cleanup error | ✓ revision |
| `workflow/merge.archiveWorkflow` | archive/auto-run | ✓ revision |
| `workflow/sync` success/conflict/failure | events | ✓ revision |
| `workflow/dev-completion.finalizeDevRun` | dev terminal/session | ✓ serialized `LiveTask.workflowLease`; returned lease forwarded |
| `workflow/develop-start` synchronous failure | dev interrupted | ✓ serialized `LiveTask.workflowLease`; no snapshot-derived token |
| `workflow/resume` fallback/exit | dev state/session | ✓ serialized `LiveTask.workflowLease`; no snapshot-derived token |
| `workflow/review-flow` failure/parse/verdict | review state/result/session/events | ✓ serialized `LiveTask.workflowLease`; returned lease forwarded |
| `workflow/review-flow` cleanup failure | review stage | ✓ serialized `LiveTask.workflowLease`; no snapshot-derived token |
| `workflow/review-flow` comment/fallback | publication/session | ✓ serialized `LiveTask.workflowLease`; returned lease forwarded |
| `workflow/dev-delivery.recordDevDelivery` | dev event/PR | ✓ serialized `LiveTask.workflowLease`; returned lease forwarded |
| `workflow/delivery-publish` | publication | ✓ serialized `LiveTask.workflowLease`; returned lease forwarded |
| `workflow/task-api.stopTask` all states | interrupted stage/gate | ✓ controller-only stop transition; exact task ref + frozen expectation; always revokes prior lease |

## Current-task consumer enumeration

| Consumer | Exact-ref construction |
|---|---|
| persistence capability/claim | locked `currentWorkflowTaskRef` comparison |
| ownership observation | returns host/local-confirmed `{kind,taskId}` |
| develop/resume/review launch reuse | returns `TaskLaunchDecision.task.taskId` |
| review-start pre-resolution | delegates to ownership gate; no local/stage selector |
| handlers and stop API | consume ownership result task ref |
| auto-run orphan/reconcile | consume ownership result; unknown stays closed |
| auto-run deadline | kills only local handle matching ownership gate ref |
| state view/client recovery | expose the same ownership task ref |
