# Workflow mutation invariants (#111 redesign)

## Invariants and enforcing construction

| # | Invariant | Construction (`file`: behavior) |
|---|---|---|
| 1 | Every commit has durable ordering. | `infra/workflow-persistence.ts`: legacy revision is `0`; a successful locked commit increments exactly once. |
| 2 | No unconditional mutation exists. | `infra/workflow-persistence.ts`: revision writes require `expectedRevision`; task writes require revision plus `{kind,taskId}`. |
| 3 | Validation and commit are indivisible across processes. | `infra/workflow-persistence.ts`: hard-link lock encloses reread, JSON validation, revision/capability validation, increment, temp write and rename. |
| 4 | A task starts as one complete generation. | `agent/task-supervisor.ts`: successful reservation has non-empty `hostJobId`; `workflow/task-claim.ts` commits `taskId+hostJobId+stage+agent` before Agent launch and settles losers. |
| 5 | Current task has one observed answer. | `infra/task-ownership.ts`: ownership carries exact `{kind,taskId}`; launch/reuse/deadline/stop consumers use it without stage/order guessing. |
| 6 | Locks are not re-entered. | `infra/workflow-persistence.ts`: caller mutation callbacks run outside the lock; the locked primitive receives a finished snapshot. |
| 7 | Conflict classes retain meaning. | `infra/workflow-persistence.ts`: task commit returns `committed`, `ownership-lost`, or `revision-conflict+currentRevision`; I/O/lock/JSON errors throw. |
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
| `workflow/develop-start` via `task-claim` | dev generation | ✓ claim-retry/non-empty host id |
| `workflow/resume` via `task-claim` | dev generation | ✓ claim-retry/non-empty host id |
| `workflow/review-flow` via `task-claim` | review generation/PR/session | ✓ claim-retry/non-empty host id |
| `workflow/review-start` recovery | review-ready cache | ✓ create/revision |
| `workflow/merge` override event | events | ✓ revision |
| `workflow/merge` delivery | delivery | ✓ revision |
| `workflow/merge.persistStep` | cleanup progress | ✓ revision |
| `workflow/merge.failCleanup` | cleanup error | ✓ revision |
| `workflow/merge.archiveWorkflow` | archive/auto-run | ✓ revision |
| `workflow/sync` success/conflict/failure | events | ✓ revision |
| `workflow/dev-completion.finalizeDevRun` | dev terminal/session | ✓ task-retry |
| `workflow/develop-start` synchronous failure | dev interrupted | ✓ task-retry |
| `workflow/resume` fallback/exit | dev state/session | ✓ task-retry |
| `workflow/review-flow` failure/parse/verdict | review state/result/session/events | ✓ task-retry |
| `workflow/review-flow` cleanup failure | review stage | ✓ task-retry |
| `workflow/review-flow` comment/fallback | publication/session | ✓ task-retry |
| `workflow/dev-delivery.recordDevDelivery` | dev event/PR | ✓ task-retry |
| `workflow/delivery-publish` | publication | ✓ task-retry |
| `workflow/task-api.stopTask` all states | interrupted stage/gate | ✓ task-retry |

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
