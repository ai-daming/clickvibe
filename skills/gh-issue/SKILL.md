---
name: gh-issue
description: Safely create, update, comment on, classify, relate, and close GitHub Issues while preserving the target repository's Issue evidence contract. Use for any GitHub Issue mutation. Refresh authoritative facts, distinguish framing, delivery-contract, design, acceptance, history, and metadata changes, preview their downstream invalidation, require exact authorization, execute only the authorized writes, and read GitHub back to verify the result.
---

# GitHub Issue Operator

Operate GitHub Issues through one governed mutation workflow. GitHub is the authority for Issue content, classification, relationships, Milestone membership, comments, and state. Local tools may normalize these facts but must not redefine them.

## Load the Issue contract

Before planning CREATE or UPDATE:

1. Read the target repository's instructions, Issue templates, supported labels or native types, and declared Issue contract.
2. Treat that repository-owned contract as authoritative. Do not copy another repository's headings, classifications, labels, or lifecycle concepts into it.
3. If no repository contract exists, require the minimal semantic content: problem and evidence status, goal, checkable Acceptance Criteria, and direct dependencies.
4. Distinguish confirmed contract, unresolved decisions, Agent recommendations, historical evidence, and inferred intent. Missing required meaning must be reported, not invented.
5. A missing optional boundary is not automatically an explicit empty value. Preserve `unknown` when repository policy distinguishes unknown from none.

For ClickVibe, read `docs/issue-contract.md`. Do not hardcode its canonical fingerprint fields or algorithm in this Skill.

## Existing Issue compatibility

Classify the Issue contract status before proposing a mutation:

```text
current | legacy-compatible | unknown | conflicting
```

- CREATE must satisfy the repository's current minimum contract.
- An existing ClickVibe Issue that still has the former minimum semantics—goal, checkable Acceptance Criteria, and direct dependencies—may be `legacy-compatible`; do not invalidate it merely because newer headings are absent.
- Missing newer semantics remain `unknown`, not an empty list or implicit permission. A downstream gate that needs the missing fact still stops unless the existing body or an Accepted design answers it explicitly.
- COMMENT, acceptance-checkbox, and metadata-only mutations do not force format migration.
- The first `contractAffecting` mutation to a legacy-compatible Issue must upgrade it to the current minimum contract in the same preview.
- Do not bulk-migrate, silently rewrite, or lift a frozen-body constraint. Each Issue mutation retains its own preview and authorization boundary.

Compatibility status controls mutation admission; it is not a canonicalization version or fingerprint input.

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

## Classify mutation impact

Before previewing a body or relationship mutation, classify every changed meaning:

- `framingAffecting`: changes why the work exists or reverses material problem evidence;
- `contractAffecting`: changes the delivery target, Acceptance Criteria semantics or verification authority, direct dependencies, Non-goals, or constraints;
- `designAffecting`: changes architecture impact or the Accepted design reference;
- `acceptanceEvidence`: changes criterion completion or its evidence without changing the criterion;
- `historyOnly`: appends rationale, progress, investigation, or prior decision evidence;
- `metadataOnly`: changes Provider metadata that the repository does not define as contract-bearing.

A mutation may have more than one class. When classification is ambiguous and the less disruptive interpretation could preserve an invalid authorization or Review, stop with `unknown` instead of guessing.

## Mutation plan

Use this logical structure; adapting presentation is allowed, but do not omit authority, concurrency, downstream impact, or authorization fields:

```text
IssueMutationPlan
├── action
├── repository
├── issueNumber?
├── expectedUpdatedAt?
├── repositoryPolicySource
├── issueContractStatus
├── rationale
├── exactWrites[]
├── impactClasses[]
├── invalidatedEvidence[]
├── requiredNextGates[]
└── requiredAuthorization
```

Creating an Issue and then adding a Parent, dependency, label, or comment is a multi-write plan. The preview, authorization, execution, and verification must cover every write.

## Mutation workflow

1. Resolve the exact GitHub host, `owner/repository`, and Issue number, or confirm that CREATE has no Issue yet. Never rely on the current directory alone when the target is ambiguous.
2. Before CREATE, search both existing Issues, including closed Issues, and the codebase for duplicate or already delivered work.
3. Refresh title, body, state, labels or native type, Milestone, assignees, `updatedAt`, URL, Parent/Sub-issues, and direct dependencies.
4. Load the repository Issue contract and classify the current Issue as `current`, `legacy-compatible`, `unknown`, or `conflicting`.
5. Parse current and proposed content by evidence role. Preserve unknown values and conflicts between native relationships and body fallbacks. Require a current-contract upgrade in the same preview when a legacy-compatible Issue receives a `contractAffecting` mutation.
6. Classify semantic differences and determine which challenge verdict, decision record, implementation-gate receipt, authorization, or Review may be stale.
7. Show the exact user-visible writes and all downstream consequences: use a semantic body diff for edits and complete rendered Markdown for CREATE or COMMENT.
8. Require explicit authorization for that exact plan. A discussion conclusion, Agent recommendation, gate verdict, development brief, or prior permission for another mutation is not authorization.
9. Immediately refresh the target again. If `updatedAt`, body, classification, state, or relevant relationships changed since the preview, stop and regenerate the plan instead of overwriting concurrent work.
10. Execute only the authorized mutation. Use `gh issue` for supported Issue fields and `gh api` for native relationship operations. Pass multiline bodies through stdin or `--body-file -`; never interpolate untrusted Markdown into a shell command.
11. Read GitHub again and compare the result with the plan. Report partial application, unresolved invalidation, and original failures explicitly; never claim success from a zero exit code alone.

## Body versus comment

Update the body when the current contract or stable framing/design information changes. Add a comment for append-only history such as rationale, progress, blockers, investigation, execution evidence, risks, or next action.

A comment does not redefine the contract. If a comment records an accepted requirement or decision change, propose a separate body update and classify its downstream impact before delivery consumes it.

## Review and completion evidence

- An Agent completion statement, commit creation, or test pass is not completion evidence.
- A Review verdict binds the exact PR head; a changed head requires another Review.
- A Review also binds the repository-defined canonical contract fingerprint. This Skill does not decide its fields, normalization, serialization, algorithm, or version.
- If the repository cannot interpret the current contract schema or canonicalization version, report `unknown` and do not preserve an authorization or Review as current.
- Close a delivery Issue only after verifying its PR, exact head, independent Review, Acceptance Criteria, required external evidence, and repository closing gates.

## Hard boundaries

- Do not write to GitHub without explicit authorization for the exact mutation.
- Do not create, close, reopen, reclassify, or relate Issues merely because an Agent recommends it.
- Do not overwrite concurrent GitHub edits.
- Do not treat local configuration, an Agent transcript, or a ledger as a competing source of GitHub truth.
- Do not expose tokens, secrets, sensitive private evidence, or raw private transcripts in previews, commands, comments, or bodies.
- Do not implement code, approve or merge a PR, deploy, or perform production writes under this Skill.
