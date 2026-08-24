# Workflow mutation invariants (#111 redesign round)

## Root cause and scope

The persisted workflow is shared by plugin reloads and by old/new host processes. A file lock and atomic rename protect mutual exclusion and JSON integrity, but they do not decide which controller generation is allowed to commit. An unconditional whole-object write can therefore serialize correctly and still overwrite a newer task generation.

This redesign covers every production mutation of `workflow.json`, not only Agent exit callbacks. Git/GitHub remain authoritative delivery facts; the workflow file is a durable coordination cache whose writers must nevertheless obey generation ordering.

## Invariants

1. **Durable ordering:** every stored workflow has a durable revision. Every successful commit increments it exactly once; legacy files read as revision `0`.
2. **No unconditional mutation:** every mutation API signature requires either an expected revision or a task capability plus the expected revision. There is no exported unconditional whole-object save.
3. **One conditional commit boundary:** the cross-process lock contains current-file read, JSON validation, revision/capability validation, revision increment, temp write and rename. A mismatch rejects without writing.
4. **Task start linearization:** a controller reserves a host job before launch, then establishes `taskId + hostJobId + stage + agent` in one revision-checked workflow commit. A losing controller settles its reservation and never starts an Agent process.
5. **One current-task answer:** `currentWorkflowTaskRef` is the only server-side selector for the current persisted task generation. Ownership observation, recovery, stop and persistence capability checks consume it.
6. **No lock re-entry:** the persistence boundary accepts a finished snapshot, not a callback. No caller code runs while the lock is held, so a mutation cannot recursively acquire its own workflow lock.
7. **Conflict is not I/O failure:** revision/capability mismatch has an explicit conflict result. Lock, read, parse and write failures throw; they are never collapsed into `false` or silently swallowed by the persistence primitive.
8. **Missing is not death:** revision conflict, missing registry data and missing local handles never prove Agent termination. Unknown ownership remains fail closed.

## Mutation API shape

- Revision mutation: `saveWorkflow(workflow, expectedRevision)`; `null` means create-only and cannot replace an existing file.
- Task mutation: `saveWorkflowForTask(workflow, capability, expectedRevision)`; both capability and revision must still match inside the lock.
- Both APIs commit a complete snapshot only after the conditional check. The committed revision is returned on the same object so a sequential caller can make its next conditional transition.
- Task-start callers perform one revision mutation after `reserveHostTask`; they do not persist an intermediate `taskId` with a missing `hostJobId`.

## Static mutation enumeration

The final review of this table is mechanical: `rg` finds no workflow `writeFile/rename` outside the persistence adapter, no unconditional save variant, and no production call missing the required revision/capability argument. “Revision CAS” below means the expected revision is required by the TypeScript signature and validated inside the cross-process lock; it is not caller-side check-then-write discipline.

| Mutation path | State changed | Protection in current HEAD |
|---|---|---|
| `agent/prompts.resolvePromptSnapshot` current snapshot | issue snapshot/state | revision CAS |
| `agent/prompts.resolvePromptSnapshot` persisted fallback | issue snapshot | revision CAS |
| `agent/worktree.ensureWorktree` | worktree/branch/base | revision CAS |
| `infra/state.appendEvent` | events | revision CAS propagated by signature |
| `infra/state.migrateLegacyWorkflowFile` | initial namespaced file | create-only CAS |
| `infra/state.archiveWorkflow` | delivery archive | revision CAS propagated by signature |
| `infra/state.appendLog` legacy task-id allocation | dev/review task id | revision CAS |
| `workflow/auto-run.persistDecision` | auto-run cursor | revision CAS |
| `workflow/auto-run.pauseAutoRun` | pause state/event | revision CAS through `appendEvent` |
| `workflow/auto-run.completeAutoRun` | completed state/event | revision CAS through `appendEvent` |
| `workflow/auto-run.applyDecision(rework)` | dev agent | revision CAS |
| `workflow/auto-run.startAutoRun` | auto-run start/event | revision CAS through `appendEvent` |
| `workflow/create-pr.createPullRequest` | PR number | revision CAS |
| `workflow/develop-start.startDevelop` via `task-claim` | dev ownership generation | single revision-CAS task-start transition; losing reservation is settled |
| `workflow/merge` merge override event | events | revision CAS through `appendEvent` |
| `workflow/merge` merged delivery | delivery | revision CAS |
| `workflow/merge.persistStep` | cleanup progress | revision CAS |
| `workflow/merge.failCleanup` | cleanup error | revision CAS; conflict distinct from I/O |
| `workflow/merge.archiveWorkflow` | archived delivery/auto-run | revision CAS |
| `workflow/resume.resumeDevelop` via `task-claim` | dev ownership generation | single revision-CAS task-start transition; losing reservation is settled |
| `workflow/review-flow` invalid session ownership | review session | folded into task-start revision CAS |
| `workflow/review-flow` discovered PR number | PR number | folded into task-start revision CAS |
| `workflow/review-flow.startReview` via `task-claim` | review ownership generation | single revision-CAS task-start transition; losing reservation is settled |
| `workflow/review-start.resolveReviewStartWorkflow` | recovered review-ready cache | create/revision CAS |
| `workflow/sync` successful/conflicted sync event | events | revision CAS through `appendEvent` |
| `workflow/sync` failed sync event | events | revision CAS through `appendEvent` |
| `workflow/dev-completion.finalizeDevRun` | dev terminal state/session | task capability + revision CAS |
| `workflow/develop-start` synchronous failure | dev interrupted | task capability + revision CAS |
| `workflow/resume` host reservation failure/fallback/exit | dev state/session | task capability + revision CAS |
| `workflow/review-flow` failure/parse/verdict/comment/fallback | review state/result/session/events | task capability + revision CAS |
| `workflow/review-flow` post-claim result-file cleanup failure | review stage | task capability + revision CAS; persistence failure remains explicit |
| `workflow/dev-delivery.recordDevDelivery` | dev event/PR | task capability + revision CAS |
| `workflow/delivery-publish` | publication result | task capability + revision CAS |
| `workflow/task-api.stopTask` running/unknown/terminal | interrupted stage and gate release | task capability + revision CAS |

Static audit commands and current result:

- `rg 'saveWorkflowStrict|saveWorkflowStateStrict' src` → 0 unconditional APIs.
- `rg 'saveWorkflow\([^,\n]+\)' src` → 0 one-argument whole-object writes.
- `rg 'writeFile|rename\(' src` → workflow JSON writes exist only in `infra/workflow-persistence.ts`; the other hits are project config and append-only task-log adapters.
- Persistence accepts a completed snapshot, never a mutation callback; therefore none of the rows can re-enter the same workflow lock.
- `saveWorkflowForTask` returns `false` only for revision/capability conflict. Lock/read/parse/write errors throw and the corruption regression asserts that they cannot be mistaken for a stale task.

## Current-task consumers

| Consumer | Protection |
|---|---|
| `infra/workflow-persistence` capability validation | consumes `currentWorkflowTaskRef` |
| `infra/task-ownership.observeTaskOwnership` | consumes `currentWorkflowTaskRef` |
| `workflow/develop-start` launch gate | consumes `observeWorkflowTask` |
| `workflow/resume` launch gate | consumes `observeWorkflowTask` |
| `workflow/review-flow` launch gate | consumes `observeWorkflowTask` |
| `workflow/handlers` stop command | consumes `observeWorkflowTask` result |
| `workflow/task-api` stop mutation | consumes `observeWorkflowTask` result and task capability commit |
| `workflow/auto-run` orphan/reconcile | consumes `observeWorkflowTask`; unknown remains closed |

## Adversarial proof obligations

1. Two independent controller processes load the same revision, reserve different host jobs and attempt resume. Exactly one ownership transition commits; the loser never launches an Agent.
2. A slow unconditional-style snapshot from the losing controller cannot replace the winner because no unconditional API exists and its expected revision is stale.
3. `observeWorkflowTask` continues to see the winning running host job; confirming the losing task id cannot reopen launch.
4. A stale task callback, a same-generation concurrent update, a dead lock owner and malformed workflow JSON produce four distinct outcomes: conflict, conflict/retry, recovered lock and thrown corruption error.

The integration proof also runs `resumeDevelop` in two independent, long-lived Node processes for 20 host-handoff rounds. Each process owns a separate local task map and host-job facade while sharing the same durable workflow: exactly one controller starts an Agent, the persisted winner remains observable as `running`, and launch stays fail closed.
