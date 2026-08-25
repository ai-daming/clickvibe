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

`auto-run.ts` remains the per-workflow single command domain. Reconcile signals,
deadline wakes and state-refresh recovery are coalesced by workflow key. Every
state transition uses the revision-checked metadata command; task starts continue
through the existing ownership and lease/fencing primitives.

`auto-run-recovery-policy.ts` is pure. It computes:

- capped exponential backoff with jitter (5 seconds to 5 minutes), without a
  retry-count limit;
- an exact-stack fingerprint and consecutive streak;
- the third-identical-stack fuse decision;
- watchdog eligibility, cooldown and the rolling hourly reattach limit.

`auto-run-recovery.ts` applies those decisions. Each retry persists a small
`controllerRecovery` checkpoint when workflow storage is available and writes a
full diagnostic record with the original stack. A temporarily unreadable state
file keeps a timer armed and performs no action until the workflow can be loaded
and its original deadline rechecked.

Rate limits bypass exponential backoff. `GithubRateLimitError.resetAt`, derived
from `Retry-After` before `x-ratelimit-reset`, schedules reset plus a two-second
buffer. The REST circuit rejects queued requests before they reach `gh` and keeps
the primary/secondary classification.

## Fuse and watchdog

Three consecutive occurrences of one exact stack pause as `controller-error` and
persist the fingerprint, streak, stack and fuse basis. Failures with another
stack break that streak. Confirmed running or unknown task ownership suppresses
the fuse: the controller retries without changing status or touching the task.

Only `paused/controller-error` enters the watchdog. After the persisted cooldown
it re-observes ownership inside the same command domain:

- `running`: reattach the controller without touching the task;
- `unknown`: wait and retry, with no new task;
- `interrupted`: convert to the semantic `session-interrupted` pause;
- `none`: reattach and let fresh facts derive the next action.

The event stream is the durable rolling-window ledger. Ten watchdog reattachments
within an hour delay the next wake until the oldest event leaves the window; they
do not permanently abandon the run.

## Budget and GitHub burst control

Every wake is bounded by the original deadline. At expiry, controller-error is
replaced by `budget-exhausted`; a host-confirmed task is stopped through its local
handle or host job ID before the pause is persisted. Unknown ownership is never
treated as permission to start or kill a task.

Host REST calls share one process-global serialized lane with a minimum launch
interval. Agent development, resume/rework and review prompts separately require
`gh api` REST, prohibit GraphQL-heavy `gh pr view`/`gh issue view` context reads,
and limit unchanged-resource reads to once per task.

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
