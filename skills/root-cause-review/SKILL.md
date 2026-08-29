---
name: root-cause-review
description: Adversarial multi-round code review that digs for root causes instead of verifying the latest patch. Reads the FULL review history of a PR (every round's findings, diff trend, issue contract), classifies findings into recurring themes, judges each fix's altitude (mechanism-level vs call-site-level), and can issue a stop-and-redesign verdict that halts incremental patching. Use when asked to review a PR that has failed review at least once before, when the same class of bug keeps coming back across rounds, when a fix diff keeps growing, or when asked "why does this keep failing" / "找根因" / "是不是同一类问题". Principles: docs/fix-discipline.md.
---

# Root-Cause Review

Ordinary review answers "does this round's patch work?". This skill answers "why does this bug class exist, and is the current fixing strategy converging?". It exists because a reviewer that only verifies the latest patch will happily certify ten rounds of the same mistake (case: issue #111, ten CRITICAL rounds, diff 93→2669 lines, root cause untouched until someone asked the cross-round question).

## Hard requirements

- Always identify the role in the visible verdict as `**身份：Review Agent**`. Use `LGTM` only for a `pass` verdict bound to the current exact head; never use it for `fix-these`, `stop-and-redesign`, pending gates, draft PRs, or stale heads.
- Never review only the current diff. If review history exists and you did not read it, the review is invalid.
- Never output a CRITICAL finding without answering the invariant question for it (step 3).
- Never declare an invariant enforced without a completed enumeration table (step 4). Dynamic reproduction is not a substitute for enumeration.
- Verify by reproduction: a CRITICAL claim must be demonstrated (run a regression, construct the interleaving, count failures over iterations), not inferred from reading code. If you cannot reproduce it, downgrade to a suspicion and say so with a confidence level.
- `stop-and-redesign` is a first-class verdict. Do not soften it into another fix list.
- A Review comment is not architecture authorization. State the invariant and closure evidence; do not prescribe a new type, protocol, table, layer, or shared model as the only implementation unless an Accepted baseline already requires it.

## Procedure

### 1. Collect the full history

- All review comments on the PR (every round's findings, including which were claimed fixed).
- The linked issue's contract (目标/验收标准/依赖) and its comments.
- Per-round diff stats (commits, files changed, insertions) — `git log --oneline` plus `git show --stat` per round commit, or the PR's cumulative diff against base.
- If this is the first review round, skip cross-round steps and say so; steps 3, 4 still apply.

### 2. Classify findings into themes

Group every historical finding (not just the current one) into recurring themes. Known themes from the #111 case; extend the taxonomy rather than forcing fits:

- 多事实源各执一词 (two derivations of "what is current" disagree)
- 迟到写入覆盖后继 (late callback overwrites successor state)
- 用缺失证明死亡 (absence of a record treated as proof of termination)
- 不变量按样本打补丁 (guard covers only the branch named in the previous round)
- 检查散布调用点 (check-then-act replicated at N call sites instead of one primitive)

For each current finding, state: new theme, or recurrence of theme X (rounds N, M, ...).

Before a finding may block approval, record its contract anchor, current-head reproduction, impact, minimal closure condition, and explicit non-goal. On re-review, maintain a closure ledger for prior findings and explain whether every newly introduced blocker came from the new diff or was previously missed. A generic checklist preference or a cleaner design is not a contract anchor.

### 3. Dual root-cause verdict (mandatory per finding)

- **Code root cause**: what missing invariant makes this entire class possible? Answer explicitly: "what construction would make this class impossible by design?" (single writer + atomic commit, capability in the API signature, one answering source, type-level ownership...). If the only answer you can produce is "add a check before the operation", you have not found the root cause. **Match against the known-pattern catalog first** (docs/fix-discipline.md 原则 9: lost update → CAS; stale writer overwrites successor → fencing token/lease; check-then-act → move validation inside the critical section; inconsistent answers → single source of truth). If the finding matches a known pattern, its closure condition must cover that pattern's complete invariant rather than one local symptom. When that requires changing an L2/L3 architecture, require a design-only confirmation round instead of prescribing implementation from the review comment.
- **Process root cause**: why did this bug survive to this round? (nobody asked the cross-round question / the guard was scoped to the previous finding / the test encoded the author's mental model). Only answerable with history — which is why step 1 is non-negotiable.

### 4. Static invariant audit (mandatory, before any dynamic testing)

For each declared invariant (and each invariant the current fix claims to enforce), enumerate ALL code paths that could violate it — not the ones the fix touched, all of them:

- Every caller of every mutation API (grep the unconditional/legacy variants too, not just the new credentialed one).
- Every consumer of the single answering source (anyone re-deriving "what is current" locally).
- Every write entry point to the shared state (files, registries, caches).

Produce an explicit enumeration table: path → invariant it could violate → protected by construction / protected by caller discipline / unprotected. Any row that is not "protected by construction" is a finding — **no dynamic reproduction required**. Existence-class gaps (which paths bypass the mechanism) are statically enumerable and must be found ALL AT ONCE in this step; finding them one per round means this step was skipped.

Dynamic adversarial testing (see Hard requirements: verify by reproduction) remains necessary but only for ordering-class holes the table cannot see (logic inside the critical section, lock semantics, recovery paths). Enumeration first, interleaving second.

### 5. Fix-altitude judgment

For the fix under review (or proposed): mechanism-level or call-site-level?

- Mechanism-level: the invariant is enforced by a type, a storage primitive, or a serialization point; violators cannot be written.
- Call-site-level: correctness depends on every caller remembering to check. Allowed only as registered debt with a convergence deadline.
- **Fake-redesign check (rename detection)**: when a round claims an abstraction was replaced, diff the public API/export surface before and after. An old capability that survives under a new name (same signature shape, same reach) means the redesign did not happen — the finding stands regardless of new structure added around it. Case: round 18 renamed saveWorkflow to commitWorkflow and kept it exported with full-object reach while the new command domain shipped around it.
- **Occam gate**: before recommending a new concept, name the AC it closes, the production consumer that reads its value, the final-behavior difference when removed, and why an existing mechanism cannot express the invariant. If any answer is missing, require reuse or deletion instead. Occam is a tie-breaker between sufficient fixes, not an independent blocker.

### 6. Verdict

Exactly one of:

- **pass** — findings resolved at mechanism level, or no findings. State the invariant that now protects the class, identify as `Review Agent`, and include `LGTM`.
- **fix-these** — normal findings list (each with theme, dual root-cause, and whether the fix must be mechanism-level). Use only when themes are NOT recurring and diff is NOT diverging.
- **stop-and-redesign** — trigger on any of:
  1. the same theme recurs in ≥2 consecutive rounds;
  2. cumulative diff keeps growing across fix rounds (each fix adds net code);
  3. the current fix's altitude is call-site-level for a theme that already recurred once.

  Output is NOT a findings list. It is: the recurring theme, the missing invariant, the closure evidence, and a **design-only** next round. That round enumerates consumers and bypasses, performs the Occam deletion pass, states non-goals, and proposes the smallest mechanism candidate; it must not modify business code. Implementation begins only after the maintainer accepts the design. Reference `docs/fix-discipline.md` principles by number.

  **Abstraction escalation (chain terminator):** if a theme recurs AFTER a mechanism-level fix shipped for it, the next verdict escalates past implementation — it must name the shared model itself as wrong (e.g. "single-file whole-object snapshot persistence cannot express this invariant; replace the abstraction"), not demand another layer of fencing on the same model. Patching an exhausted abstraction yields onion layer N+1, never convergence.

**Every non-pass verdict MUST end with a "下一轮指令" block**. The reviewer freezes the invariant and closure condition, not an unaccepted architecture implementation:

```text
## 下一轮指令
按 docs/fix-discipline.md〈修复轮|重设计轮〉模板执行,处理 N 项:
1. <finding> → <契约锚点 + 可复现行为 + 最小关闭条件 + 非目标>
2. ...
交付物:<closure ledger/枚举表/回归/最终行为验收>。若为重设计轮,只提交待确认设计,不得修改业务代码。
```

Keep one unambiguous closure condition per finding. Implementation choices remain bounded by the Accepted architecture and maintainer decisions; reviewer preference does not amend either.

## Output format

Keep the PR's existing Review Meta comment format so the loop's consumers keep working, and add two fields:

```text
== Review Meta ==
- event: review
- role: Review Agent
- commit: <sha>
- issue: #<n>
- passed: true|false
- next: rework|stop-and-redesign
- round: <n>
- theme: <slug or "none">        ← recurring theme this round, if any
- verdict: pass|fix-these|stop-and-redesign
```

Findings entries follow the existing style (severity, confidence, file:line, reproduction evidence), each prefixed with its theme.

The visible body starts with `**身份：Review Agent**`. A pass body includes `LGTM`; non-pass bodies must not contain it.

## What this skill does NOT do

- It does not redesign the system itself — it demands a design-only round and states the invariant. A later dev round implements only the maintainer-accepted design.
- It does not replace machine gates (`check:layers`-style whitelists). Prose discipline is the weakest enforcement layer; report gate-shaped obligations as such.
