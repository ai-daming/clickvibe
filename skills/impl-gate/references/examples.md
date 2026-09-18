# Calibration Examples

These examples calibrate verdicts; they are not templates to copy mechanically.

## READY — change inside an accepted boundary

Request: Add one optional display field to an existing read model. The Accepted architecture already owns the source field, mapping layer, compatibility rule, and UI consumer. No persistent shape, authority, lifecycle, concurrency, or external protocol changes.

Expected result: `READY` after confirming the exact baseline and scope. Cite the existing architecture. Do not demand a new ADR because several files change.

## READY — new HEAD inside the same accepted design

Request: Continue an already authorized implementation after a local commit. The work identity, accepted design, and material decisions are unchanged. Compare exact baselines and verify the diff plus its affected consumers/failure paths still implement that design.

Expected result: delta verification and a new `READY` receipt at the current baseline. Reuse existing design acceptance and scope-specific implementation authority without asking again. The old code review does not approve this HEAD; independent review must reassess it. If the delta instead introduces an uncovered restart or ownership rule, enter full verification and report the actual gap.

## READY with an outstanding release prerequisite

Request: Implement a resolver whose accepted design requires legacy data mapping before activation. The mapping algorithm, failure handling, release ordering and verification are defined; an owned release task contains the mandatory mapping step and blocks activation until it passes.

Expected result: implementation may be `READY`, but release remains gated on the mapping result. Reuse the release task instead of requiring a duplicate Issue. If the mapping is only mentioned as “execute separately” with no algorithm or sequencing, report `DESIGN_REQUIRED`; if the design is complete but the claimed assignment cannot be verified, report `NEEDS_EVIDENCE`.

## DESIGN_REQUIRED — goals and data shapes without an algorithm

Request: Reduce GitHub calls across several worktrees. The Issue lists counters, cache records, rate-limit headers, and acceptance tests, but does not decide who owns scheduling, how requests are admitted or merged, what scope shares a budget, what happens on restart, or how uncertain writes are handled.

Expected result: `DESIGN_REQUIRED`. The data structures do not imply a scheduler or its lifecycle. Require a design-only round that joins admission/settlement algorithms to their owned state before coding.

## NEEDS_DECISION — architecture depends on product authority

Request: Automatically retry an externally visible create operation after a timeout. Runtime facts show the first attempt may have succeeded, and the provider offers no idempotency key. Whether duplicates are acceptable is a product-owned risk decision.

Expected result: `NEEDS_DECISION`; use `$grill`. Do not let the agent silently choose retry or no-retry and do not hide the question inside implementation detail.

## AWAITING_ACCEPTANCE — complete candidate is not yet a baseline

Request: Implement a scheduler described by a design-only PR. The document covers ownership, algorithms, state, failure modes, alternatives, migration, and tests, but the PR is still open and no explicit maintainer acceptance of the completed artifact is recorded.

Expected result: `AWAITING_ACCEPTANCE`. Request design review/acceptance; do not redesign it and do not let the Coding Agent self-accept it by writing `Status: Accepted` in the draft.

## NEEDS_EVIDENCE — impact cannot yet be classified

Request: Replace a repository-local cache claimed to be unused. Caller and consumer inventories have not been inspected, and the current architecture document may be stale.

Expected result: `NEEDS_EVIDENCE`. Inspect the repository and runtime before deciding whether deletion is local or architectural.

## REFRAME — the requested solution is not supported by the problem

Request: Add a global queue because one endpoint was slow, but no evidence distinguishes upstream latency, local serialization, client timeout, or request volume.

Expected result: `REFRAME`; use `$challenge` or gather causal evidence. A scheduler is not justified merely because a timeout occurred.
