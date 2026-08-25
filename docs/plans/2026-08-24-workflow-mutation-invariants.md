# Workflow mutation invariants (#111 redesign)

## Round 17-18 abstraction contract: one workflow command domain and two write capabilities

The prior model had three independent ordering domains: ordinary snapshot
writes, a per-`LiveTask` callback queue, and controller stop writes launched by
an unawaited IIFE. The cross-process file lock serialized individual commits,
but it could not order these intents. A callback that had already entered its
queue could therefore advance the lease before stop acquired the lock; stop
then reported success before its revocation committed, or lost ownership and
left the callback verdict current.

The replacement abstraction has these invariants:

1. Every mutation of one workflow—metadata update, claim, callback mutation,
   stop, completion, verdict, and failure—is a command in the same domain keyed
   by the workflow state path. One in-process queue orders local commands; the
   existing per-path cross-process lock supplies the same commit order across
   hosts.
2. Validation, mutation, durable write, and the command result occur inside one
   awaited command entry. No caller may start a detached persistence IIFE.
3. Stop is a linearized chain terminator. It may follow and supersede an
   already-entered command for the same task, always advances
   `taskStateRevision`, and returns `stopped:true` only after revocation is
   durable. Commands ordered after stop still carry the old lease and are
   rejected as `ownership-lost`.
4. Raw persistence mutators are private implementation details of the command
   domain. The only ordinary public write accepts a storage identity plus an
   exact `WorkflowMetadataPatch`; task-state keys are `never` in that type and
   rejected again after the durable reread. Claim, task mutation, and stop
   accept the same narrow identity plus their capability, never a caller-owned
   `IssueWorkflow` snapshot. Passing a function through an object or
   higher-order helper cannot bypass an invariant because no exported function
   can commit an arbitrary workflow object.

This construction makes the previous “multiple ordering domains” state
unrepresentable: all commands converge before acquiring the same durable
serialization boundary, and stop cannot acknowledge completion outside it.

Round 18 also removes the disguised raw path (`commitWorkflow`, previously
renamed from `saveWorkflow`). `workflow-metadata.ts` owns the exact metadata
field set; protected lifecycle/identity/revision keys are `never` in the patch
type and are checked again after the locked reread. The facade export snapshot
and TypeScript-symbol test cover the real module surfaces instead of a selected
name blacklist. Consequently, a claim → stop → reload sequence has no public
API that can replay `stage`, verdict, interruption, task id, or session fields;
only a still-valid task lease can submit those fields, and stop has already
revoked that lease.

## Invariants and enforcing construction

| # | Invariant | Construction (`file`: behavior) |
|---|---|---|
| 1 | Metadata and lifecycle ordering are durable and distinct. | `infra/workflow-persistence.ts`: every public mutation first enters the workflow-path command queue, then the cross-process lock; every commit increments `revision`, while a lifecycle-field transition or explicit stop/claim advances `taskStateRevision` exactly once. Legacy counters normalize to `0`. |
| 2 | A running task cannot refresh its lifecycle capability from persisted state. | `infra/workflow-persistence.ts`: claim signs an opaque, frozen `WorkflowTaskLease {kind,taskId,taskStateRevision}`; `infra/runtime.ts`: `LiveTask` stores it; `workflow/task-lease.ts`: callback commands require that stored lease and replace it only with the lease returned by their own commit. No workflow snapshot can construct a callback lease. |
| 3 | Validation, mutation, commit and result share one awaited command domain. | `infra/workflow-persistence.ts`: `enqueueWorkflowCommand` orders metadata, claim, callback and stop commands by durable workflow path; the hard-link lock encloses reread, validation, increment, temp write and rename; callers receive a result only after `commit()` and lock release. |
| 4 | A task starts as one complete generation. | `agent/task-supervisor.ts`: a successful reservation has a non-empty `hostJobId`; develop/resume/review freeze the current task expectation immediately after the ownership gate; `workflow/task-claim.ts` atomically commits `taskId+hostJobId+stage+agent`, stores the returned lease on `LiveTask`, then launches the Agent; losers are settled without a lease or launch. |
| 5 | Stop is an irreversible chain terminator for the prior task lease. | `infra/workflow-persistence.ts`: `stopWorkflowTaskCommand` runs in the same command order as callbacks, rereads the exact current task, supersedes commands already ordered before it, clears stopped Review verdict/session state, and always advances `taskStateRevision`. `workflow/task-api.ts` awaits that durable result before returning `stopped:true`; later callback commands retain the old lease and return `ownership-lost`. |
| 6 | Current task has one observed answer. | `infra/task-ownership.ts`: ownership carries exact `{kind,taskId}`; launch/reuse/deadline/stop consumers use it without stage/order guessing. |
| 7 | Conflict classes retain meaning and raw writes are not an API. | `infra/workflow-persistence.ts`: results distinguish `committed`, `ownership-lost`, and revision conflict; raw snapshot/task/stop mutators remain private. `infra/state.ts` exposes `commitWorkflowMetadata(identity, expectedRevision, patch)` and no whole-object writer. Runtime export snapshots plus TypeScript symbol inspection reject new facade exports and any exported writer whose first parameter is a complete `IssueWorkflow`; the state-write script remains a secondary module-boundary tripwire. |
| 8 | Missing is not death. | `infra/task-ownership.ts`: local/registry absence yields `unknown` and keeps launch closed; only explicit outcome or supervisor terminal state yields `interrupted`. |

## Static mutation enumeration

| Mutation path | State | Protection |
|---|---|---|
| `agent/prompts.resolvePromptSnapshot` current snapshot | issue snapshot/state | ✓ command domain + revision |
| `agent/prompts.resolvePromptSnapshot` fallback | issue snapshot | ✓ command domain + revision |
| `agent/worktree.ensureWorktree` | worktree/branch/base | ✓ command domain + revision |
| `infra/state.appendEvent` | events | ✓ command domain + revision |
| `infra/state.migrateLegacyWorkflowFile` | legacy file placement | ✓ create-only hard link; never overwrites an existing workflow |
| `infra/state.archiveWorkflow` | delivery archive | ✓ command domain + revision |
| `infra/state.appendLog` without task id | compatibility log only | ✓ no workflow-state mutation; history reads the legacy log fallback |
| `workflow/auto-run.persistDecision` | cursor | ✓ command domain + revision |
| `workflow/auto-run.pauseAutoRun` | pause/event | ✓ command domain + revision |
| `workflow/auto-run.completeAutoRun` | completion/event | ✓ command domain + revision |
| `workflow/auto-run.applyDecision(rework)` | no direct lifecycle write | ✓ resume claim selects the configured auto-run agent and establishes it atomically |
| `workflow/auto-run.startAutoRun` | config/event | ✓ command domain + revision |
| `workflow/create-pr.createPullRequest` | PR number | ✓ command domain + revision |
| `workflow/develop-start` via `task-claim` | dev generation | ✓ command domain + gate-frozen ref + lifecycle CAS + non-empty host id |
| `workflow/resume` via `task-claim` | dev generation/session reset | ✓ command domain + gate-frozen ref + lifecycle CAS + non-empty host id |
| `workflow/review-flow` via `task-claim` | review generation/PR/session | ✓ command domain + gate-frozen ref + lifecycle CAS + non-empty host id |
| `workflow/review-start` recovery | PR/base/worktree metadata | ✓ metadata command; durable lifecycle remains `idle` until the review claim atomically writes `reviewing` |
| `workflow/merge` override event | events | ✓ command domain + revision |
| `workflow/merge` delivery | delivery | ✓ command domain + revision |
| `workflow/merge.persistStep` | cleanup progress | ✓ command domain + revision |
| `workflow/merge.failCleanup` | cleanup error | ✓ command domain + revision |
| `workflow/merge.archiveWorkflow` | archive/auto-run | ✓ command domain + revision |
| `workflow/sync` success/conflict/failure | events | ✓ command domain + revision |
| `workflow/dev-completion.finalizeDevRun` | dev terminal/session | ✓ command domain + frozen `LiveTask.workflowLease`; returned lease forwarded |
| `workflow/develop-start` synchronous failure | dev interrupted | ✓ command domain + frozen `LiveTask.workflowLease` |
| `workflow/resume` fallback/exit | dev state/session | ✓ command domain + frozen `LiveTask.workflowLease` |
| `workflow/review-flow` failure/parse/verdict | review state/result/session/events | ✓ command domain + frozen `LiveTask.workflowLease`; returned lease forwarded |
| `workflow/review-flow` cleanup failure | review stage | ✓ command domain + frozen `LiveTask.workflowLease` |
| `workflow/review-flow` comment/fallback | publication/session | ✓ command domain + frozen `LiveTask.workflowLease`; returned lease forwarded |
| `workflow/dev-delivery.recordDevDelivery` | dev event/PR | ✓ command domain + frozen `LiveTask.workflowLease`; returned lease forwarded |
| `workflow/delivery-publish` | publication | ✓ command domain + frozen `LiveTask.workflowLease`; returned lease forwarded |
| `workflow/task-api.stopTask` all states | interrupted stage/gate | ✓ awaited command-domain terminator; exact task ref; durable revocation before success |

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
