# Design Readiness Contract

Use this contract only when the requested change has architectural impact or a candidate design/receipt must be verified. It is independent of any repository-specific L1-L4 naming scheme.

## Complete design evidence

A design is ready only when the evidence answers every material item below or gives a justified, inspectable `not applicable`.

### 1. Scope and baseline

- The work has a stable Issue/task identity and an exact repository baseline when applicable.
- In-scope and out-of-scope behavior are explicit.
- Accepted requirements and user decisions are distinguishable from agent recommendations.
- The design covers the implementation being authorized, not an earlier or narrower slice.

### 2. Boundaries and ownership

- Every authoritative fact has one named owner and one answering source.
- Process, account, repository, worktree, tenant, user, and credential scopes are distinguished where they change isolation or contention.
- Every external side effect has a named adapter/authority boundary.
- Every shared write has an atomic or serialization boundary and, where needed, an ownership/generation credential.

### 3. Algorithms

Describe behavior as transitions, not feature nouns. Cover the relevant normal and abnormal sequences:

- admission and rejection;
- ordering, priority, fairness, and starvation prevention;
- merge/coalescing, deduplication, and idempotency;
- read consistency, caching, invalidation, and freshness;
- pagination, batching, retry, backoff, and rate/budget handling;
- cancellation, timeout, shutdown/drain, restart, and late completion;
- write dispatch, uncertain outcome, readback, recovery, and non-replay rules.

For each algorithm, name its input state, output state, decision owner, termination condition, and behavior after partial failure.

### 4. Data structures

For every new or changed request, queue item, state record, cache entry, event, table, file, lease, token, or protocol field:

- define its semantic meaning and scope;
- name who creates, mutates, reads, expires, persists, and deletes it;
- name the algorithmic decision that consumes its value;
- distinguish missing, unknown, pending, failed, and terminal states;
- define compatibility and migration when durable or externally visible.

Delete a concept when only a presence check or a purpose-built test consumes it and removing it changes no final behavior.

### 5. Algorithm–structure cross-check

Build a two-way trace rather than two independent lists:

| Algorithm/transition | State read | State written | Owner/serialization point | Failure result |
|---|---|---|---|---|
| `<operation>` | `<fields/records>` | `<fields/records>` | `<owner>` | `<observable result>` |

Then reverse it:

| Structure/field | Producer | Production consumer | Decision affected | Lifecycle |
|---|---|---|---|---|
| `<concept>` | `<producer>` | `<consumer>` | `<behavior difference>` | `<create→settle/delete>` |

An empty cell is a design gap unless justified as not applicable.

### 6. Invariants and failure modes

- Invariants are decidable propositions, not aspirations.
- Every invariant identifies its enforcement construction and authoritative universe of callers/consumers.
- Concurrent orderings, partial success, dependency failure, process death, stale callbacks, and retries are addressed where reachable.
- Missing evidence remains unknown; it does not become success, death, or completion.
- Diagnostics/evidence lifecycle is separate from the business commit boundary unless the accepted domain explicitly makes it authoritative.

### 7. Alternatives and consequences

- At least one credible alternative or the existing mechanism is compared.
- The chosen design states the trade-off it accepts, not only its benefits.
- Non-goals prevent a reviewer or Coding Agent from silently expanding the design.
- Migration, rollback, feature gating, or clean-break behavior is explicit when contracts or durable state change.

### 8. Verification

- Acceptance criteria map to architectural behavior and later implementation tests.
- Tests include adjacent boundaries and critical interactions, not only the example that motivated the change.
- Static inventories cover finite bypass/caller sets; dynamic tests cover ordering and failure windows.
- The verification plan observes final behavior through production boundaries and does not replace the mechanism with mocks.

### 9. Prerequisites and handover

Identify required work described as separate, later, manual, external, or outside this implementation in the design, migration notes, relevant comments and runbook. Keyword search can locate candidates but does not establish completeness. Distinguish current AC, accepted prerequisites for a later gate, genuine out-of-scope obligations, and optional ideas/non-goals.

For each required later step, cite one stable record with the remaining behavior and completion criteria, evidence that a responsible person/team accepted the work (or an established assignment policy applies), and a maintained pending-work list with a review date or actionable trigger. A runbook step qualifies when attached to an owned release task with ordering, verification, and a condition that blocks unsafe release; a free-standing document or an unowned Issue does not.

Mark its actual gate. Design readiness does not mean the deployment step already ran. Missing algorithms, state transitions, sequencing, or failure semantics still block design readiness; missing acceptance/evidence routes to the appropriate unresolved gate. An in-scope acceptance criterion cannot be discharged merely by opening another Issue. Waiving an obligation needs an explicit decision by the authorized owner, with rationale and risk; changes to AC or accepted design require their normal contract/acceptance process.

Reuse this evidence in the receipt's existing coverage fields; do not create a second handover database or change the receipt schema.

## VerifiedDesignReceipt

Emit this YAML-shaped block only after the semantic audit is `READY`:

```yaml
kind: VerifiedDesignReceipt
version: 1
work_id: "<stable issue/task identity>"
baseline_sha: "<40-char commit SHA or explicit non-repository marker>"
scope: "<implementation scope covered by this receipt>"
architecture:
  artifacts:
    - "<path/URL plus immutable revision when available>"
  acceptance_source: "<Accepted ADR/repository baseline or explicit maintainer acceptance>"
  acceptance_evidence: "<where that acceptance was observed>"
coverage:
  algorithms: "<sections/table rows that cover behavior>"
  data_structures: "<sections/table rows that cover state>"
  cross_trace: "<two-way algorithm/structure trace>"
  invariants: "<invariant source>"
  failures_recovery: "<failure/restart/rollback source>"
  migration: "<source or justified not-applicable>"
open_material_items: []
verified_by: "<agent/reviewer identity>"
verified_at: "<ISO-8601 timestamp>"
verdict: READY
```

## Receipt validity

A receipt is valid only while all of these remain true:

1. `work_id` identifies the current work.
2. `baseline_sha` is the current inspected baseline. On a changed baseline, explicitly reassess the delta before issuing a new receipt; retain the old receipt as historical evidence.
3. `scope` covers the requested implementation.
4. Every referenced artifact exists at the cited revision.
5. The architecture is Accepted for that scope; a draft authored by the Coding Agent is not self-accepting.
6. Both sides of the algorithm–structure trace are semantically complete.
7. No material user decision remains open.
8. Readiness and execution authority remain separate. A `READY` receipt can be valid before implementation is authorized; check existing authority for the exact scope before execution, without requesting it again when already granted.

For delta verification, retain the same receipt schema. In the gate result or linked evidence, record the previous baseline, changed scope/paths, affected algorithm–structure trace, reused evidence and why it still applies, and the current outcome. Reuse of accepted design does not inherit a prior code-review approval. Expand to full verification when this impact trace is unavailable or incomplete.

Structural parsing can check shape, but cannot establish conditions 3–7. Never describe a shape-only check as design verification.
