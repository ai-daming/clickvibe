# Auto-run Reconciliation Controller Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a one-click, issue-scoped delivery reconciler that runs development through current-head Review convergence and optionally gated merge/cleanup.

**Architecture:** Persist only configuration and audit/recovery state. On every completed action, re-observe authoritative facts through the existing enrichment and `deriveNextAction` path, then apply exactly one shared use case. Keep policy in pure functions and all GitHub/process/storage effects in their existing layers.

**Tech Stack:** TypeScript, Node test runner, React 18, Cordis shell, GitHub CLI/REST, JSON workflow persistence.

---

### Task 1: Pure policy and durable model

**Files:**
- Create: `src/workflow/auto-run-policy.ts`
- Modify: `src/infra/state.ts`
- Test: `tests/auto-run-policy.test.ts`

1. Write failing decision-table tests for allowed actions, default merge stop, wall-clock deadline, review-count limit, unresolved finding aggregation, and missing state.
2. Run `node --test tests/auto-run-policy.test.ts` and preserve RED evidence.
3. Add the minimal `AutoRunState` model, normalization, and pure decision functions.
4. Run the focused test to GREEN.

### Task 2: Shared create-PR action

**Files:**
- Modify: `src/github/pr.ts`
- Create: `src/workflow/create-pr.ts`
- Modify: `src/workflow/dispatch.ts`, `src/infra/develop-core.ts`, `src/infra/runtime.ts`
- Test: `tests/auto-run-routes.test.ts`

1. Write failing tests for exact-branch PR detection, idempotent reuse, push/create behavior, and one-use authorization.
2. Implement the GitHub adapter and workflow use case with current workflow/base facts.
3. Expose the privileged method without weakening loopback/same-origin or authorization checks.
4. Run focused route tests to GREEN.

### Task 3: Reconciler and completion hooks

**Files:**
- Create: `src/workflow/auto-run.ts`, `src/workflow/auto-run-signal.ts`
- Modify: `src/workflow/develop-start.ts`, `src/workflow/review-flow.ts`, `src/workflow/resume.ts`, `src/workflow/handlers.ts`, `src/workflow/dispatch.ts`
- Test: `tests/auto-run-routes.test.ts`

1. Write failing tests proving re-observation, one action per pass, deduplication, persistence, pauses, and optional gated merge.
2. Implement start/pause/reconcile with a per-workflow gate and deadline timer.
3. Notify reconciliation only after action state and audit events are durable.
4. Convert orphaned running controllers to explicit session-interrupted pause on state refresh.
5. Run focused tests to GREEN.

### Task 4: Command and reusable UI entry

**Files:**
- Modify: `src/workflow/command.ts`, `src/workflow/handlers.ts`, `docs/command-reference.md`
- Create: `src/client/auto-run.ts`, `src/client/views/auto-run-form.tsx`
- Modify: `src/client/domain.ts`, `src/client/views/project-panel.tsx`, `src/client/views/dev-section.tsx`, `src/client/styles.ts`
- Test: `tests/command-parse.test.ts`, `tests/command.test.ts`, `tests/auto-run-client.test.ts`, `tests/client-styles.test.ts`

1. Write failing parser/config/default/view-model tests.
2. Add `/clickvibe auto #N` configuration parsing and the same backend start action.
3. Add the shared five-field form to list and detail, plus paused/running status and unresolved findings.
4. Run client and command tests to GREEN.

### Task 5: Full verification and delivery

**Files:**
- Modify only files required by failures.

1. Run `pnpm run typecheck && pnpm run build && pnpm test`.
2. Run `pnpm run coverage`, `pnpm run lint`, `pnpm run format:check`, `pnpm run check:size`, and `pnpm run check:layers`.
3. Inspect the exact diff and verify no unrelated user changes were overwritten.
4. Commit, push `clickvibe-issue-74`, create/update the PR, and reread the exact PR head/status.
