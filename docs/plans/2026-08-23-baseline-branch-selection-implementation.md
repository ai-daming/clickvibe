# Development Baseline Branch Selection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow the first development authorization to select a fetched `origin/*` baseline while keeping `baseRef` as the single frozen source for every later comparison and action.

**Architecture:** Git ref discovery and validation stay in `src/infra/git.ts`; pure baseline parsing and freeze decisions live in `src/workflow/baseline.ts`. The develop authorization digest binds the selected baseline, `ensureWorktree` freezes it exactly once, and downstream derive/sync/review/client code resolves the remote base only from `workflow.baseRef`.

**Tech Stack:** TypeScript, React, Node test runner, real git integration tests, Cordis shell fake.

---

### Task 1: Baseline contract and authorization binding

**Files:**
- Create: `src/workflow/baseline.ts`
- Modify: `src/infra/develop-core.ts`
- Modify: `src/infra/git.ts`
- Test: `tests/develop.test.ts`
- Test: `tests/state-view.test.ts`

1. Add failing pure tests for accepted `origin/*` refs, `origin/HEAD`, invalid/local refs, frozen-baseline equality, and issue-branch dependency extraction.
2. Add failing authorization tests proving `baseline` is digest-bound and tampering consumes/rejects the capability.
3. Run the targeted tests and record RED failures.
4. Implement the smallest pure contract and remote-ref listing/validation helpers.
5. Run the targeted tests to GREEN.

### Task 2: First worktree creation and freeze enforcement

**Files:**
- Modify: `src/agent/worktree.ts`
- Modify: `src/workflow/develop-start.ts`
- Test: `tests/worktree-integration.test.ts`
- Test: `tests/routes.test.ts`

1. Add failing tests for creation from a release ref, rejection of missing/non-origin refs, and rejection of changing a frozen baseline.
2. Run those tests to prove RED.
3. Thread the authorization-bound baseline into `ensureWorktree`, resolve `origin/HEAD` after fetch, and freeze `origin/<branch> @ <hash>` only after successful creation/recovery.
4. Keep omitted baseline behavior identical for dryrun and automatic development.
5. Run the targeted tests to GREEN.

### Task 3: Derivation, sync, review, and PR base

**Files:**
- Modify: `src/workflow/derive.ts`
- Modify: `src/workflow/sync.ts`
- Modify: `src/agent/prompts.ts`
- Modify: `src/infra/state.ts`
- Test: `tests/state-view-integration.test.ts`
- Test: `tests/sync-conflict.test.ts`
- Test: `tests/routes.test.ts`

1. Add failing integration tests where `release/*` advances independently from main.
2. Assert state compares against release, sync merges release, and review without PR diffs against release while a PR base remains authoritative.
3. Assert a deleted baseline returns a warning fact without blocking review/merge derivation.
4. Replace hard-coded `origin/main` use with the frozen base resolver and rerun targeted tests.

### Task 4: Develop authorization preview UI

**Files:**
- Modify: `src/workflow/merge.ts`
- Modify: `src/client/dev-authorization.ts`
- Modify: `src/client/dev-state.ts`
- Modify: `src/client/views/dev-section.tsx`
- Modify: `src/client/styles.ts`
- Test: `tests/dev-authorization.test.ts`
- Test: `tests/routes.test.ts`

1. Add failing tests for default-first branch options, frozen disabled state, and `Blocked by #N` suggestion metadata.
2. Return fetched baseline options in develop authorization previews.
3. Render an authorization dialog with an advanced baseline select for first development and a disabled frozen label thereafter.
4. Refresh the one-use authorization when selection changes; submit the exact bound baseline on develop.
5. Keep batch automatic development and dryrun on the omitted/default path.

### Task 5: Full gates and delivery

**Files:**
- Modify only files required by gate failures.

1. Run `pnpm run typecheck && pnpm run build && pnpm test`.
2. Run coverage with repository-supported Node flags and verify statements/branches/functions/lines are at least 85%.
3. Run `pnpm run lint` and `pnpm run check:size`.
4. Inspect `git diff --check`, dependency-layer gate output, and final diff for unrelated changes.
5. Commit the exact implementation, push `clickvibe-issue-60`, create/update the PR against `main`, and reread PR head/base/checks.
