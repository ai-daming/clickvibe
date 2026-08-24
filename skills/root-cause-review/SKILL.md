---
name: root-cause-review
description: Adversarial multi-round code review that digs for root causes instead of verifying the latest patch. Reads the FULL review history of a PR (every round's findings, diff trend, issue contract), classifies findings into recurring themes, judges each fix's altitude (mechanism-level vs call-site-level), and can issue a stop-and-redesign verdict that halts incremental patching. Use when asked to review a PR that has failed review at least once before, when the same class of bug keeps coming back across rounds, when a fix diff keeps growing, or when asked "why does this keep failing" / "找根因" / "是不是同一类问题". Principles: docs/fix-discipline.md.
---

# Root-Cause Review

Ordinary review answers "does this round's patch work?". This skill answers "why does this bug class exist, and is the current fixing strategy converging?". It exists because a reviewer that only verifies the latest patch will happily certify ten rounds of the same mistake (case: issue #111, ten CRITICAL rounds, diff 93→2669 lines, root cause untouched until someone asked the cross-round question).

## Hard requirements

- Never review only the current diff. If review history exists and you did not read it, the review is invalid.
- Never output a CRITICAL finding without answering the invariant question for it (step 3).
- Never declare an invariant enforced without a completed enumeration table (step 4). Dynamic reproduction is not a substitute for enumeration.
- Verify by reproduction: a CRITICAL claim must be demonstrated (run a regression, construct the interleaving, count failures over iterations), not inferred from reading code. If you cannot reproduce it, downgrade to a suspicion and say so with a confidence level.
- `stop-and-redesign` is a first-class verdict. Do not soften it into another fix list.

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

### 3. Dual root-cause verdict (mandatory per finding)

- **Code root cause**: what missing invariant makes this entire class possible? Answer explicitly: "what construction would make this class impossible by design?" (single writer + atomic commit, capability in the API signature, one answering source, type-level ownership...). If the only answer you can produce is "add a check before the operation", you have not found the root cause.
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

### 6. Verdict

Exactly one of:

- **pass** — findings resolved at mechanism level, or no findings. State the invariant that now protects the class.
- **fix-these** — normal findings list (each with theme, dual root-cause, and whether the fix must be mechanism-level). Use only when themes are NOT recurring and diff is NOT diverging.
- **stop-and-redesign** — trigger on any of:
  1. the same theme recurs in ≥2 consecutive rounds;
  2. cumulative diff keeps growing across fix rounds (each fix adds net code);
  3. the current fix's altitude is call-site-level for a theme that already recurred once.

  Output is NOT a findings list. It is: the recurring theme, the missing invariant (half a page, as a requirement — not as an implementation), and the constraint that the next round must ship the mechanism (e.g. single-writer serialized store + atomic commit + capability-checked writes) plus deletion of the scattered call-site checks. Reference `docs/fix-discipline.md` principles by number.

## Output format

Keep the PR's existing Review Meta comment format so the loop's consumers keep working, and add two fields:

```text
== Review Meta ==
- event: review
- commit: <sha>
- issue: #<n>
- passed: true|false
- next: rework|stop-and-redesign
- round: <n>
- theme: <slug or "none">        ← recurring theme this round, if any
- verdict: pass|fix-these|stop-and-redesign
```

Findings entries follow the existing style (severity, confidence, file:line, reproduction evidence), each prefixed with its theme.

## What this skill does NOT do

- It does not redesign the system itself — it demands the redesign round and states the invariant. Writing the mechanism is the dev round's job.
- It does not replace machine gates (`check:layers`-style whitelists). Prose discipline is the weakest enforcement layer; report gate-shaped obligations as such.
