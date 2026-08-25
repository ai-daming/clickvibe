# Auto-run infrastructure recovery design (#120)

## Contract

Git/GitHub facts remain the only source for the next workflow action. Controller
recovery state only answers when reconciliation may run again; it never derives a
business stage or authorizes a task launch.

Semantic conclusions may stop or pause auto-run: the original budget deadline,
the configured review-round boundary, an explicit user/supervisor task terminal
outcome, an issue closure, an authorization-contract change, or a deterministic
merge gate rejection. Network, git/gh, filesystem, registry, controller and
cleanup execution failures never permanently stop it.

## Mechanism

`auto-run.ts` coalesces signals per workflow; revision-checked metadata commands
and the existing ownership/lease primitives remain the only mutation paths.

`auto-run-recovery-policy.ts` purely computes capped unlimited backoff, exact-stack
streak/fuse decisions, and watchdog cooldown/hourly limits.

`auto-run-recovery.ts` applies those decisions. Each retry persists a small
`controllerRecovery` checkpoint when workflow storage is available and writes a
full diagnostic record with the original stack. A temporarily unreadable state
file keeps a timer armed and performs no action until the workflow can be loaded
and its original deadline rechecked.

Rate limits use `Retry-After` before `x-ratelimit-reset`, schedule reset plus two
seconds, and let the REST circuit reject queued requests while retaining kind.

## Fuse and watchdog

Three consecutive occurrences of one exact stack pause as `controller-error` and
persist the fingerprint, streak, stack and fuse basis. Failures with another
stack break that streak. Confirmed running or unknown task ownership suppresses
the fuse: the controller retries without changing status or touching the task.

Only `paused/controller-error` enters the watchdog. After cooldown it re-observes
ownership: running reattaches without touching the task, unknown waits,
interrupted becomes semantic `session-interrupted`, and none resumes fact derivation.

The event stream is the durable rolling-window ledger. Ten watchdog reattachments
within an hour delay the next wake until the oldest event leaves the window; they
do not permanently abandon the run.

## Budget and GitHub burst control

Every wake is bounded by the original deadline. At expiry, controller-error is
replaced by `budget-exhausted`; a host-confirmed task is stopped through its local
handle or host job ID before the pause is persisted. Unknown ownership is never
treated as permission to start or kill a task.

Host REST calls share one serialized lane. Agent prompts require `gh api`, avoid
GraphQL-heavy context reads, and limit unchanged-resource reads to once per task.

## Verification map

| Invariant | Regression |
|---|---|
| Alternating transient failures never fuse or exhaust a count | 30-minute pure-policy simulation |
| Same exact stack trips at three | policy + durable integration diagnostics |
| Running task is unaffected | host-registry ownership integration |
| Watchdog is controller-error-only and hourly bounded | pure gate + persisted event integration |
| Retry/watchdog cannot cross deadline | expired paused state + host task stop tests |
| Filesystem observation gap does not abandon recovery | unavailable-state wake test |
| Primary/secondary rate scheduling stays distinct | REST circuit tests |
| Cross-resource host burst is serialized | blocked first request + minimum-start interval test |
| Queue dispatch preserves fuse/watchdog/semantic pause | public reconcile-entry integration |

## Action failure enumeration

| Producer | Failure source | Classification protection |
|---|---|---|
| `startDevelop` | confirmed live snapshot differs from authorized snapshot | explicit `authorization-denied` marker at comparison |
| `startDevelop` | missing/persisted snapshot, refresh, filesystem, git, task launch | unmarked, therefore controller retry |
| `createPullRequest` / `startReview` / `resumeDevelop` / `syncWorktree` | controller execution | unmarked, except existing structured sync conflict |
| `mergeAndCleanup` | gate verdict or post-merge cleanup | existing `gateFailures` / `cleanupPending` discriminators |
| `applyDecision` | any future unmarked action failure | defaults to controller retry; no text heuristic |
