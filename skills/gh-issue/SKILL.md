---
name: gh-issue
description: Safely create, edit, comment on, classify, and close GitHub Issues with the GitHub CLI, following the ClickVibe issue contract (目标/验收标准/依赖) and a refresh-preview-authorize-verify mutation workflow. Use whenever an Agent is asked to create an Issue; edit its title, body, labels, milestone, assignees, parent, Sub-issues, or dependencies; add a comment; or close or reopen an Issue — including ClickVibe's own auto-pickable issues. Refresh GitHub facts, validate against the repository's issue contract, preview the exact mutation, require explicit authorization, execute only the authorized change, and read GitHub again to verify the result.
---

# GitHub Issue Operator

Operate GitHub Issues through one governed mutation workflow. GitHub is the authority for Issue content, classification, relationships, Milestone membership, comments, and state. Never copy those facts into local configuration; local caches may normalize but never redefine them.

## Issue contract

Validate every create/update against the repository's declared issue policy. Default contract (ClickVibe):

- `## 目标` — what to do (required).
- `## 验收标准` — `- [ ]` checklist (required). Each item may carry a verification prefix deciding who may check it:
  - default (no prefix) = auto: the agent may verify during Review;
  - `[人工]` / `[外部]` = only the user may check; an agent never auto-checks these, and code/tests passing is not completion evidence for them.
- `## 依赖` — direct prerequisites only: for A→B→C record B blocked by A and C blocked by B, never transitive redundancy. Prefer native GitHub Blocked by; the body form `依赖: Blocked by #NN` / `依赖: 无` is a fallback.
- Optional: `## 约束` (boundaries: don't do X), `## 入口` (run/test commands).

Authoritative spec: `docs/issue-contract.md` in the ClickVibe repo. Operating on another repository, read that repository's own declared issue policy; if it declares none, apply the minimal semantics above. Missing required fields must be flagged, not invented.

## Supported actions

```text
CREATE
UPDATE
COMMENT
SET_LABELS
SET_MILESTONE
SET_ASSIGNEES
SET_RELATIONSHIP
CLOSE
REOPEN
```

Treat all of these as variants of one governed mutation workflow, not separate skills.

## Mutation workflow

1. Resolve the exact GitHub host, `owner/repository`, and Issue number, or confirm that CREATE has no Issue yet. Never rely on the current directory alone when the target is ambiguous.
2. Refresh the repository and Issue from GitHub: title, body, state, labels or native type, Milestone, assignees, `updatedAt`, URL, Parent/Sub-issues, and direct dependencies.
3. Validate the proposed content against the Issue contract: Goal, Acceptance Criteria (checkable, prefixed), direct dependencies. Separate confirmed decisions from suggestions and inferred intent.
4. Produce a concise mutation plan and show the exact user-visible preview: body diff for edits, complete rendered Markdown for create/comment, every write listed. A create-plus-relationships plan is multi-write; preview, authorization, and verification must cover every step.
5. Require explicit authorization for the exact mutation. A discussion conclusion, an agent recommendation, or prior permission for another mutation is not authorization.
6. Immediately refresh the target again. If `updatedAt`, body, labels, state, or relevant relationships changed since the preview, stop and regenerate the plan instead of overwriting concurrent work.
7. Execute only the authorized mutation. Use `gh issue` for Issue fields and `gh api` for native relationship operations. Pass multiline bodies through stdin or `--body-file -`; never interpolate untrusted Markdown into a shell command.
8. Read GitHub again and compare the result with the plan. Report partial application explicitly; never claim success from a zero exit code without verifying GitHub state.

## Body versus comment

Update the body when the current contract changes (Goal, Acceptance Criteria, dependencies, constraints). Add a comment for append-only history: rationale, progress, blockers, investigation results, evidence, risks, next action. A comment does not redefine the contract; an accepted requirement change must become a body update.

## Review and completion evidence

- An agent's completion statement, commit creation, or test pass is not completion evidence.
- A Review verdict binds the PR head SHA; if the head changes, the old verdict no longer unlocks integration.
- For ClickVibe issues, a verdict also binds the contract fingerprint (hash of the 目标/验收标准 body sections): if the body contract changes, the verdict expires and Review must run again. Do not silently reinterpret existing work against a new target. Spec: `docs/state-model.md`.
- Close a DELIVERY issue only after verifying the PR, head, independent Review, Acceptance Criteria, and closing evidence.

## Hard boundaries

- Do not write to GitHub without explicit authorization for the exact mutation.
- Do not create, close, reopen, reclassify, or relate Issues merely because an Agent recommends it.
- Do not overwrite concurrent GitHub edits.
- Do not treat local configuration, an Agent transcript, or a ledger as a competing source of GitHub truth.
- Do not expose tokens, secrets, or sensitive private evidence in commands, previews, comments, or bodies.
- Do not implement code, approve or merge a PR, deploy, or perform production writes under this Skill.