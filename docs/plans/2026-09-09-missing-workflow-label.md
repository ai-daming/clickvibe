# Missing workflow must not imply delivery

Implementation Gate: READY. Baseline: 4049c8bd8c440e970d9fed27cddb3f9adde1bb4d.
Scope: frontend snapshot merge and action text only. Authority: reported incorrect delivered labels; local fix authorized by bug report, publication/deployment separate.
Accepted basis: architecture.md and authority-model.md (Git/GitHub facts own delivery), state-model.md P0 (merged PR, not record absence), AGENTS.md missing does not mean termination. Delta verification: no persistence, response schema, backend action or permission change.

Algorithm: incoming authoritative observations replace cached values. Missing entries do not assert completion: preserve the repository-list observation, except a stale cleanup action is disabled pending refresh. Display the resulting nextAction label without inferring delivery from the passed stage.
Data: existing Workflow.derived.nextAction only; producer snapshot merge, consumers panel row and selected-workflow view. Missing cleanup becomes none/状态待刷新, never an archived assertion. Fresh observations remain the sole source of terminal labels. No new concept or store.

```yaml
kind: VerifiedDesignReceipt
version: 1
work_id: clickvibe/missing-workflow-delivery-label
baseline_sha: 4049c8bd8c440e970d9fed27cddb3f9adde1bb4d
scope: frontend snapshot/action-label correction
architecture:
  artifacts: [docs/architecture.md, docs/architecture/authority-model.md, docs/state-model.md]
  acceptance_source: existing Accepted architecture at baseline
  acceptance_evidence: state-model P0 and AGENTS missing-evidence invariant
coverage:
  algorithms: preserve authoritative list observation; suppress stale cleanup only; fresh observation replaces cache
  data_structures: existing derived.nextAction, no new fields
  cross_trace: snapshot merge to project and selected-workflow action consumers
  invariants: no terminal inference from absence or review-passed stage
  failures_recovery: missing cleanup nonactionable until refreshed, preserving issue 89 stale-action protection
  migration: not applicable, no persistence changes
open_material_items: []
verified_by: Codex
verified_at: 2026-09-09
verdict: READY
```

TDD: reproduce idle+missing poll falsely becoming delivered, verify missing cleanup stays disabled without a completion claim, and prove new observations supersede the disabled cache. Keep existing unaffected merge tests. Run project checks, build and coverage.

Result: three red assertions reproduced the bogus delivery inference. All five snapshot tests now pass. Full validation: 879/879 tests, lines 92.87%, branches 85.34%, functions 91.24%; check and build passed with existing nonblocking warnings. No runtime deployment or persistent state modification is part of this fix.
