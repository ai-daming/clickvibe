# #170 Recovery Implementation Plan

**Goal:** Implement ADR-0016 without changing live config/state or running the upgrade.
**Architecture:** 1a2ea2f02f17bd8df67f878141ac49321a9dbaa8, Accepted ADR-0016 + ADR-0017. Preserve workflow CAS and one writer, unknown-result safety, durable retry limits and explicit offline upgrade.
**Tech Stack:** TypeScript, node:test, real temporary Git repositories, existing shell and filesystem adapters.
**Authority:** User requested 实现; no publication, merge or on-machine migration authorization.

## 1. Freeze verification and enumerate bypasses
- Record source baseline and inspect workflow/task/diagnostic/contract writers, preparation callers and retry reset paths.
- Before implementation test the accepted old-runtime refusal assumption against real baseline writers in temporary directories.
- Any falsified architecture assumption reopens impl-gate for that boundary; never weaken assertions to proceed.

## 2. Shell cause diagnostics
- Red: tests/shell-failure.test.ts drives runCommand through real returned/rejected shell outcomes and shared diagnostic reader. Assert classification, cause precedence, redaction, stable identity and persistence failure visibility.
- Green: src/infra/runtime.ts, src/infra/shell-failure.ts, shared diagnostic writer/artifact transport. Keep plain successful stdout contract.
- Verify: node --test tests/shell-failure.test.ts tests/runtime-edge.test.ts tests/runtime-contract.test.ts tests/diagnostic-record.test.ts.

## 3. Preparation and claim
- Red: real Git tests for successful write with failed state persistence, dispatched restart, same-workflow overlap, stop/claim races and independent workflows.
- Green: src/infra/workflow-persistence.ts transaction API, preparation record/decision modules, src/agent/worktree.ts, develop-start and auto-run entrypoints, claim/stop and existing write consumers.
- Verify existing worktree and task-lease contracts; update rollback behavior assertions only as explicitly superseded by ADR-0016.

## 4. Persistent bounded recovery
- Red: tests/auto-run-recovery.test.ts and policy tests exercise first fuse, one cooldown, second fuse, restart, actual progress, rate-limit separation and rejected stale writes.
- Green: protected recoveryBudget commands; auto-run-recovery.ts and policy integrate stable errors and durable halt. Timers never own counters.

## 5. Offline generation conversion
- Red: temporary config/state migration with original/target hash manifests, crash at each checkpoint, no-use rollback, used-state refusal, old-runtime rejection.
- Green: dedicated offline upgrade runner and journal, config/marker pairing; no live conversion.
- Block activation unless owner, explicit plan authorization and release checklist are satisfied.

## 6. Delivery verification
- pnpm run typecheck && pnpm run build && pnpm test
- pnpm run coverage && pnpm run lint && pnpm run format:check
- pnpm run check:size && pnpm run check:layers && pnpm run check:state-writes && pnpm run check:local-git-writes && pnpm run check:github-access && pnpm run check:provider-neutral && pnpm run check:style-tokens
- Review diff, record remaining release obligations, create publication preview only after local checks pass.

## Progress
- Implementation worktree created at exact merged design baseline; frozen dependency install passed.
- First red phase: node --test tests/recovery-old-writer.test.ts => 2 pass, 3 fail. Production code still exactly b92f150. Old-writer compatibility assumption falsified; implementation gate reopened for ADR-0016 §7.1 only. Do not alter production code merely to make a frozen-old-runtime probe green.

- 2026-09-09: #173 merged, delta gate READY at 1a2ea2f; source unchanged, root isolation probe 4/4 already passed. Old rejection tests retained under docs/baselines as superseded evidence, not active acceptance tests. User explicitly authorized implementation; no wait on documentation CI.

## Implementation checkpoint
- Shell cause normalization, bounded redacted diagnostic artifacts and UI detail reader implemented; artifact retention shares the diagnostics queue.
- Preparation, claim, stop and existing Git actions share the durable workflow lock. Pending command results are not replayed. Stop revokes pre-start task generation; failures preserve Git state.
- Recovery budget is protected from generic metadata/task writes; one cooldown, second fuse halts; unknown budget does not admit automatic actions.
- Isolated root loader and offline plan/apply/resume/rollback runner implemented. Manifest stores hashes only; payloads stay in source/backup/staging. Current contract reader verifies rebased artifacts before activation.
- Original old-writer probe/report retained outside the worktree under Codex artifacts/history; ADR-0017's source-controlled probe remains the current isolation evidence.
- Static gates and build passed; final full tests and coverage passed. No user config/state migrated; no implementation push/PR/merge performed.

- Additional adversarial checks cover replaced-run failures, expired automatic claims, unclaimed/foreign jobs and pending fuse checkpoints. Both preparation metadata and recovery allowance acknowledgments now fsync before permitting external work.
- Migration preview now includes current Git/worktree identity and status hashes, rejects colliding derived paths, and re-observes before conversion. All published migration phases have restart tests; completed resume validates the live pair rather than trusting its journal label.
- Operator handoff: docs/operations/issue-170-recovery-upgrade.md; maintenance, exact plan authorization and real-work-item acceptance remain pending and owned by the maintainer.

## Local validation completed
- Frozen implementation baseline: 1a2ea2f02f17bd8df67f878141ac49321a9dbaa8 (ADR-0016/0017 merged).
- pnpm run coverage: 871 tests passed, zero failures; lines 92.80%, branches 85.26%, functions 91.13%. This command executes the complete test suite with the repository thresholds.
- pnpm run check and pnpm run build: passed. Existing non-blocking lint/build notices remain; no gate or coverage threshold was reduced.
- Verification includes source/Git drift, independent copies and artifact references, all published migration phases, used-state rollback refusal, relative-hook uncertainty, preservation after a post-Git disk failure, stopped/replaced/expired authority and pending-fuse restoration.
- All changes remain in the isolated implementation checkout. User config/state and DSH runtime have not been upgraded; live incident provenance and real-work-item acceptance remain explicit release obligations.
