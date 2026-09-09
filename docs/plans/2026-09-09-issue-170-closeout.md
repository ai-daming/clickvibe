# #170 W1/W2/W3 closeout

Implementation Gate: READY. Baseline: a7e01544f231047bb9d6e7be2dd1a9a88a9a45ab.
Delta: ADR-0018 merged through #175 supplies the previously missing manual settlement transition. ADR-0016 diagnostic projection and ADR-0017 root isolation remain unchanged. Authority: maintainer requested 收尾, including the follow-up implementation PR. Live operations remain separately authorized.

```yaml
kind: VerifiedDesignReceipt
version: 1
work_id: ai-daming/clickvibe#170/warning-closeout
baseline_sha: a7e01544f231047bb9d6e7be2dd1a9a88a9a45ab
scope: safe diagnostics, blocked production, offline manual settlement procedure and verification
architecture:
  artifacts:
    - docs/architecture/decisions/0016-shell-worktree-recovery.md
    - docs/architecture/decisions/0017-recovery-state-root-isolation.md
    - docs/architecture/decisions/0018-manual-worktree-preparation-resolution.md
  acceptance_source: merged main at baseline, PRs 172/173/175
  acceptance_evidence: maintainer acceptance recorded in PR 174 comment 5594810065 and PR 175 merge
coverage:
  algorithms: ADR-0018 sections 1-6; fixed offline field delta and old/new/drift readback
  data_structures: existing preparation, revision, autoRun, note events; private old/new files and evidence hashes
  cross_trace: ADR-0018 section 8; prepare and claim consume settlement, panel consumes note
  invariants: unknown never implies termination; preserve original Git facts and recovery budget; new authorization mandatory
  failures_recovery: ADR-0018 sections 2 and 4; no replay, no rollback of authority, drift refusal
  migration: existing isolated root, no schema switch; deployment/onsite acceptance remain maintainer-owned release prerequisites
open_material_items: []
verified_by: Codex
verified_at: 2026-09-09
verdict: READY
```

Execution: carry forward W1; write red tests for blocked+note atomicity and offline settlement, implement inside existing storage boundaries, exercise real Git and exact private-file publication, then run coverage/check/build and submit PR. No production restart, state edit or upgrade.

## Invariant audit and delivered scope

| Invariant | Production enforcement | Verification |
|---|---|---|
| Unknown command outcome remains dispatched | ensureWorktree cross-runtime/endedCommands admission and typed-conflict catch | Real Git fixture with prior-runtime dispatched refuses preparation before manual settlement; no Git write replay |
| Explicit conflict blocks with durable reason | Five typed conflict sites: Git mismatch, dirty worktree, registration conflict, relative hooks, executable hook; transaction.block commits state and existing note together | Real dirty/hook cases plus branch-conflict regression; old durable dev log preserved |
| Blocking record forbids downstream writes | Existing assertPreparationSettled at task claim, baseline restore, workflow Git actions; preparation rejects blocked before dispatch | Existing gate suite plus old-generation claim rejection after manual settlement |
| Offline settlement is exact and repeatable | manual-preparation helper validates evidence, source/target bytes, allowed field delta and live scene; before-replace callback repeats checks; target readback syncs directory | Invalid state/identity/grants, wrong echo, tampered target, changed evidence, dirty/in-progress Git, old/new/drift publication; real CLI publish |
| Settlement never resumes an old run | Preserve original preparation identity and autoRun budget; advance taskStateRevision, devInterrupted=true, autoRun paused; new authorization required | No-grant preparation rejected; stale claim rejected; newly authorized prepare verifies existing worktree without add/switch/remove |
| Safe diagnostic text does not authorize recovery | Fixed category/phrase projection through existing writer/reader; failureKey unchanged | Real Git failure, secret/path omission, clipped tail and two-tail envelope tests |

The helper is imported only by its offline script and tests, not by host routing or any automatic workflow. Its state-path ownership is explicitly registered under ADR-0018 in the existing state-write gate. Note type uses the repository's existing `kind: 'note'` field; no new event schema.

Maintenance declarations are operator-owned evidence. Tests exercise a synthetic previous boot identity, not an actual host reboot; no onsite completion claim follows. Independent review, merge, maintenance authorization and real work-item acceptance remain separate gates.

## Final local validation

Node v26.4.0: `pnpm run coverage` 876/876 passed, lines 92.85%, branches 85.38%, functions 91.18%. `pnpm run check` and `pnpm run build` passed. Original thresholds unchanged. Runtime source was unchanged throughout this final validation; only this result paragraph was added afterward.

New failure tests were observed red before implementation. During regression, original conflict reason/dev log output was restored; the prior null-state assertion was replaced with blocked+note+zero-Git-write assertions to match ADR-0018. The initial failing full run is retained alongside final logs.
