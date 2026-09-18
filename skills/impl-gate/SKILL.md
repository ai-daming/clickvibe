---
name: impl-gate
description: Decide whether a software change may enter implementation by verifying an accepted architecture baseline, including both algorithms and data structures. Use before coding, or when implementation/review exposes missing ownership, lifecycle, concurrency, persistence, failure-recovery, or cross-boundary design. Do not use for general problem framing or to invent architecture during coding.
metadata:
  author: "大铭 (https://github.com/ai-daming)"
  copyright: "Copyright © 大铭"
---

# Implementation Gate

Prevent a business Issue, an acceptance checklist, or a pile of data shapes from being mistaken for an implementation-ready design.

The governing test is:

> 程序 = 算法 + 数据结构

A design is incomplete when it describes only goals and records, or only processing steps. The two sides must constrain each other: the algorithm names the state it reads and changes; each durable or shared structure names the algorithm and production consumer that use it.

This skill is a read-only readiness gate. It does not authorize coding, edit an Issue, accept an architecture on the maintainer's behalf, or replace `$challenge`, `$grill`, or architecture design.

## Inputs

Collect facts rather than asking the user to retrieve them:

- the requested implementation scope and Issue/specification;
- repository instructions, current architecture entry point, Accepted ADRs, and relevant design artifacts;
- an exact code baseline when the work is repository-bound;
- prior decisions, known constraints, affected modules and external boundaries;
- any candidate design receipt.

If these facts are unavailable, preserve the failed lookup or missing source instead of filling the gap with assumptions.

## Gate

### 1. Bind the work

Record the work identity, exact baseline, requested scope, fixed constraints, and implementation authority. Authorization to design is not authorization to implement.

### 2. Select the verification depth

- **Full verification:** no inspectable prior verification exists, or the change introduces an uncovered ownership, lifecycle, algorithm, data structure, compatibility, or recovery boundary. Audit all material parts of the design-readiness contract.
- **Delta verification:** an accepted, previously verified design and its evidence are available. Compare the prior and current exact baselines, scope, design revisions, and material decisions. Trace changed behavior and its affected producers, consumers, invariants, and failure paths; cite unchanged evidence with a reason it still applies.
- If that comparison is unavailable or exposes a design gap, investigate or expand to full verification. Diff size alone never selects the mode.

A new HEAD requires reassessment, not automatic redesign or renewed acceptance of unchanged decisions. This is architecture coverage verification, not a substitute for independent code review at the current HEAD.

### 3. Test whether existing architecture is sufficient

Trace the requested change against the accepted architecture. A named L1-L4 scheme may help, but is never required. Inspect the actual architectural impact:

- fact ownership and authority;
- state/lifecycle transitions and atomic boundaries;
- scheduling, ordering, retry, deduplication, caching, invalidation, concurrency, cancellation, restart, or recovery algorithms;
- schemas, request/response shapes, queues, events, leases, caches, files, tables, and other shared or durable structures;
- module/service/process/account/repository/worktree boundaries;
- compatibility, migration, rollback, and operational failure modes.

A large diff can remain inside an accepted design. A small change can require design when it changes one of these contracts.

### 4. Verify design completeness

Use [references/design-readiness-contract.md](references/design-readiness-contract.md) for full verification and for issuing/checking receipts. For delta verification, reuse previously read unchanged rules and trace evidence, and inspect all affected contract sections; if either is unavailable, read the full contract. Audit the candidate design semantically. Do not accept headings or field presence as proof. Follow behavior end to end and verify that every new concept has a production consumer and every critical transition has owned state and failure semantics.

Check implementation/release prerequisites and deferred obligations in the accepted design, relevant comments, migration instructions, and runbook, not only the Issue checklist. A necessary later step must have a stable record of work and completion criteria, a confirmed responsible person/team, and a maintained pending-work list with a review date or actionable trigger. An existing release-task step can satisfy this; an Issue number or the phrase “business follow-up” alone cannot.

Identify which gate each obligation affects: implementation, merge, release, or closure. A fully designed deployment prerequisite may remain unexecuted while implementation is `READY` if its ownership, ordering, validation and release-blocking condition are accepted and recorded. Missing prerequisite design is `DESIGN_REQUIRED`; unverifiable ownership/acceptance is `NEEDS_EVIDENCE`; a user-owned trade-off is `NEEDS_DECISION`. Do not turn every optional improvement into an obligation or rewrite required AC as deferred work. Record this evidence once in the existing design/receipt references; see the readiness contract's prerequisite section.

Route unresolved matters precisely:

- missing repository/runtime facts → `NEEDS_EVIDENCE` and investigate;
- consequential user-owned choice → `NEEDS_DECISION` and use `$grill`;
- wrong or unsupported problem framing → `REFRAME` and use `$challenge`;
- architecture work absent or incomplete → `DESIGN_REQUIRED`;
- candidate design complete but not explicitly accepted by the maintainer → `AWAITING_ACCEPTANCE`;
- accepted design covers the exact scope and baseline → `READY`.

### 5. Issue or verify the receipt

Only `READY` may produce a `VerifiedDesignReceipt`. Use the schema and validity rules in the reference. A receipt records evidence; it does not make weak design true.

For newly introduced architecture, `READY` requires explicit maintainer acceptance of the referenced design. For work wholly inside an already Accepted baseline, record that baseline as the acceptance source.

A receipt becomes stale for changed work identity, baseline, scope, design, or material decisions. Reassess the delta and issue a new receipt at the current baseline after `READY`; preserve the old receipt as history. A prior receipt is never silently relabeled as current. Unchanged maintainer acceptance remains usable only for the scope and design it actually covers.

Record implementation authority separately. `READY` may be issued without execution authority; when the user already authorized the exact implementation scope, do not ask for the same permission again. A complete newly introduced design still needs explicit acceptance.

## Output

Lead with a human explanation, then provide the machine-like receipt. A gate code is not self-explanatory.

The human layer must answer:

1. **What is about to be built or changed?** Give enough prior context that a reader unfamiliar with the Issue can follow.
2. **Why is it ready or not ready?** Translate missing architecture into behavior: who decides order, what happens after a crash, which record is authoritative, or how conflicting writes are handled.
3. **What could go wrong if coding starts now?** Give a concrete scenario whenever the gap involves shared state, scheduling, migration, persistence, retry, concurrency, rollback, or recovery.
4. **What happens next?** Say who does the next action. If a user decision is required, end with “你现在只需要决定：…”.

Define technical terms on first use. Do not expose bare shorthand such as `L3`, `atomic boundary`, `fact owner`, `generation`, `AC4`, or a schema/table name without a short ordinary-language explanation. Exact paths, SHAs, ADRs, and type names belong in a following **Technical evidence** section.

Example for `DESIGN_REQUIRED`:

> **人话结论：现在不能开始写代码。** 我们已经知道要“减少多个工作区重复访问 GitHub”，但还没有决定谁统一排队、哪些请求可以合并、限额用完后怎么办，以及程序重启时正在排队的请求算失败还是重试。
>
> **举例：** 两个工作区同时刷新同一个 PR。如果各自维护队列，它们可能同时消耗同一账号的最后一次 API 配额；如果共用队列，又必须先定义哪个账号和哪些请求可以共享。
>
> **下一步：** 先完成并确认这套调度与重启规则，再进入实现。

Keep the explanation proportional. For a covered change, a short paragraph citing the accepted design and checked delta is sufficient; do not recreate the original design narrative or ask resolved questions. When invoked by another skill, supply one result/evidence record for the caller to reference.

After that human layer, append the gate result:

```text
Implementation Gate: READY | DESIGN_REQUIRED | AWAITING_ACCEPTANCE | NEEDS_EVIDENCE | NEEDS_DECISION | REFRAME
Work: <issue/task identity>
Baseline: <exact SHA or explicit non-repository baseline>
Verification: <full / delta; previous baseline and reused evidence when applicable>
Architecture source: <accepted artifact(s), or missing>
Algorithm coverage: <complete / gaps>
Data-structure coverage: <complete / gaps>
Open material items: <none or list>
Implementation authority: <existing instruction and scope, or not granted>
Next action: <concrete authorized continuation or missing gate>
```

For `READY`, append the receipt. For every other verdict, state the minimum missing evidence, design work, decision, or acceptance action and stop before implementation.

Before sending, apply this reader check: a technically capable reader with no repository history must understand “要做什么、缺什么、会出什么问题、下一步是什么” without decoding internal labels. If not, rewrite the human layer; do not remove the technical evidence.

## Rules

- Do not equate Issue goals, AC, tests, wire formats, class diagrams, or tables with architecture.
- Do not demand a new ADR when the accepted architecture already decides the change.
- Do not let a Coding Agent design an L2/L3 boundary incrementally while implementing it.
- Do not let a reviewer prescribe an unaccepted architecture as the only repair.
- Do not treat green CI or a successful prototype as evidence that ownership and lifecycle are designed.
- Do not validate receipts by regex or field existence alone; semantic traceability is the gate.
- Keep implementation authorization separate even after `READY`.

For calibration examples, read [references/examples.md](references/examples.md).
