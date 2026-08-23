# Auto-run Review Rework Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the three actionable PR #100 review findings without weakening the authoritative-state or authorization boundaries.

**Architecture:** Keep `deriveNextAction` as the only action selector. Add a bounded observation retry only for its `none` result, record auto-merge completion at the merge handler's durable archive boundary, and synchronize an untouched client draft when asynchronous workflow defaults arrive.

**Tech Stack:** TypeScript, React 18, Node test runner, existing ClickVibe workflow persistence and handler APIs.

---

### Task 1: Preserve explicit terminal outcomes

**Files:**
- Modify: `src/infra/contracts.ts`
- Modify: `src/client/domain.ts`
- Modify: `src/client/auto-run.ts`
- Modify: `src/workflow/merge.ts`
- Modify: `src/workflow/auto-run.ts`
- Test: `tests/routes.test.ts`
- Test: `tests/auto-run-client.test.ts`

**Step 1:** Add failing assertions that successful auto-merge archives `autoRun.status=completed` with a terminal event, and cleanup failure pauses as `cleanup-failed`.

**Step 2:** Run the focused tests and confirm the assertions fail against the reviewed head.

**Step 3:** Persist the completion event immediately before archive, add the explicit cleanup failure reason, and preserve existing merge gates.

**Step 4:** Run focused tests until green.

### Task 2: Retry temporary observation gaps

**Files:**
- Modify: `src/workflow/auto-run-policy.ts`
- Modify: `src/workflow/auto-run.ts`
- Test: `tests/auto-run-policy.test.ts`

**Step 1:** Add failing tests for a bounded retry delay before the wall-clock deadline.

**Step 2:** Implement a five-second retry policy and a per-workflow observation timer; clear it on pause/completion and treat it as a live controller owner during orphan detection.

**Step 3:** Verify `nextAction=none` schedules re-observation without inventing an action or a pause reason.

### Task 3: Synchronize asynchronous form defaults

**Files:**
- Modify: `src/client/auto-run.ts`
- Modify: `src/client/views/auto-run-form.tsx`
- Test: `tests/auto-run-client.test.ts`

**Step 1:** Add a failing pure-state test: untouched draft follows the late workflow, edited draft remains unchanged.

**Step 2:** Add an effect guarded by an edit ref and route all five input changes through the guard.

**Step 3:** Run client tests and typecheck.

### Task 4: Verify and deliver

**Files:**
- Modify only if verification exposes a defect.

**Step 1:** Run `pnpm run typecheck && pnpm run build && pnpm test`.

**Step 2:** Run coverage, lint, formatting, size, layer, and diff checks.

**Step 3:** Fetch and merge any newer `origin/main`, then rerun affected gates.

**Step 4:** Commit, push `clickvibe-issue-74`, update PR #100, and reread its exact head and CI status.
