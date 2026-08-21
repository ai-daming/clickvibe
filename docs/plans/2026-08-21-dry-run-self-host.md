# Dry-run and Self-host Development Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a safe dry-run development path, recoverable issue worktrees, cursor-based line logs, and live panel polling to ClickVibe.

**Architecture:** Keep development tasks in Host memory and isolate pure validation, log-buffer, and worktree-decision logic for tests. The HTTP layer starts background shell processes while the Client polls immutable cursor ranges, so retries and multiple readers cannot consume each other's logs.

**Tech Stack:** TypeScript, React 18, Cordis/DSH shell service, Node test runner through Vitest, GitHub CLI, Git worktrees.

---

### Task 1: Pure task and worktree primitives

**Files:**
- Create: `src/develop.ts`
- Create: `tests/develop.test.ts`
- Modify: `package.json`

1. Add failing tests for strict `codex | claude | dryrun` parsing, POSIX shell quoting, chunk-to-line buffering, cursor polling, truncation, and worktree-state decisions.
2. Run `pnpm test` and confirm the missing module/tests fail.
3. Implement the smallest pure types and functions that satisfy those cases.
4. Run `pnpm test` and confirm the primitive suite passes.

### Task 2: Host develop and poll API

**Files:**
- Modify: `src/index.ts`
- Modify: `tests/develop.test.ts`

1. Add tests for task startup/dry-run command selection and recovery command plans through exported pure seams.
2. Extend the Cordis shell declaration with background process support and bounded output.
3. Add config loading, repository validation, idempotent worktree recovery, Issue prompt construction, task lifecycle, periodic output draining, and cursor-based polling.
4. Register `develop` and `develop/poll` routes and reject unknown agents instead of falling back.
5. Run `pnpm test` and `pnpm run typecheck`.

### Task 3: Live panel logs

**Files:**
- Modify: `src/client/index.tsx`

1. Add the one-click development panel for open Issues.
2. Poll with the returned cursor, append only new lines, keep the log scrolled to the latest output, and stop cleanly on done/failed or API errors.
3. Render worktree/branch, terminal state, failures, and truncation hints without claiming success for failed processes.
4. Run `pnpm run typecheck` and `pnpm run build`.

### Task 4: Documentation and acceptance

**Files:**
- Modify: `README.md`

1. Document config, Host APIs, dry-run curl flow, polling cursor, recovery semantics, and safety limits.
2. Install/link the built plugin in the local DSH profile if necessary and restart the Host.
3. Trigger dry-run by curl, poll to `done`, and verify `git status` shows no dry-run code changes.
4. Observe the panel receiving incremental agent lines.
5. Verify the current `clickvibe-issue-1` worktree/branch and final commit as the self-host Codex run.

### Task 5: Delivery

**Files:**
- Modify only files listed above.

1. Review `git diff --check`, status, tests, typecheck, and build.
2. Commit with an Issue-focused message.
3. Push `clickvibe-issue-1` to `origin`.
4. Create a PR against `main` with acceptance evidence and `Closes #1`.
5. Read the PR back and report CI/review/deployment gates separately.
