# Auto-run Reconciliation Controller Design

## Boundary

Issue #74 adds one issue-scoped delivery controller. It does not decide whether an Issue is valuable, coordinate milestones, or replace Git/GitHub facts. Missing `autoRun` state always means manual mode.

## Model

`IssueWorkflow.autoRun` stores the confirmed configuration, start/deadline wall-clock timestamps, review count, status, pause reason, last observation, and unresolved review findings. A new start replaces this object, so its round count starts at zero while historical delivery events remain immutable.

The controller is level-triggered:

1. Reload the workflow from disk.
2. Refresh Git/GitHub facts and call the existing `deriveNextAction` path.
3. Evaluate budget, review rounds, task outcome, and the derived action with a pure decision function.
4. Apply at most one existing use case.
5. Reconcile again only after that use case has durably completed.

There is no persisted cursor that predicts the next state. Duplicate completion notifications are safe because existing task gates and a per-workflow reconciliation gate prevent duplicate side effects.

## Authorization and safety

Starting auto-run uses the existing preview -> explicit confirmation -> one-use execution contract. The authorization digest binds the exact Issue snapshot and all five configuration values. Internal agent starts reuse the existing development, review, and resume use cases. Auto-merge is disabled by default; when enabled it calls the same merge-and-cleanup use case and therefore preserves head, contract, GitHub, and sync-equivalence gates. No manual override is available to auto-run.

The existing create-PR browser jump becomes a privileged server action shared by the list, detail, command, and controller entry points. It first re-observes an existing open PR and otherwise pushes the exact workflow branch and creates a PR against the frozen base branch.

## Convergence and recovery

Review rounds are counted from persisted review-result events at or after the current auto-run start. A failed verdict at the configured limit pauses with all failed-round findings. Deadline expiry, task timeout/interruption, sync conflict, authorization rejection, and non-equivalent merge-gate rejection all persist an explicit pause reason and leave `deriveNextAction` untouched for manual takeover.

A host restart never guesses that an in-flight automatic action succeeded. The first state refresh converts a persisted `running` controller without a live task into `paused / session-interrupted`. A deadline timer stops a live task and persists `budget-exhausted` even when no browser is open.

## UI and tests

One reusable form is rendered from both Issue list rows and Issue detail. It shows auto-merge, development agent, review agent, round limit, and total budget with the required defaults. Pure tests cover allowed actions, default stop-before-merge, round/deadline boundaries, pause mapping, and missing-state manual fallback. Route tests cover one-use authorization, persistence, create-PR idempotence, and command/UI sharing; existing full-chain gates remain unchanged.
