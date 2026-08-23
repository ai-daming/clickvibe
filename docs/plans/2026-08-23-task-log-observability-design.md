# Task log observability design (Issue #58)

## Scope

Move workflow state from the collision-prone flat key layout into
`~/.clickvibe/state/<owner>/<repo>/issue-<number>/workflow.json`. Keep the
workflow key as an internal identifier only. Development and review tasks each
own an immutable JSONL file under the issue directory. Existing poll and SSE
payloads keep their current cursor semantics.

## Storage model

GitHub coordinates, not `issueKey`, select the issue directory. New workflow
keys use a base64url encoding of `owner/repo` plus the issue number so distinct
repositories cannot collide. Existing workflow keys remain readable.

Each task file is named `<UTC-start>--<taskId>.jsonl`. Every record contains
`ts`, `level`, `kind`, `taskId`, `sequence`, `source`, and `line`. The sequence
is copied from the in-memory `LineLog` entry, so disk history and live delivery
share one cursor space. ClickVibe-prefixed lines are stored with
`source=clickvibe`; the history API maps them back to the existing
`source=system` client event shape.

Task completion appends a final structured system record carrying status and
exit code. History aggregation derives start/end timestamps, duration, and the
final status from the JSONL records. These metrics are additive API data; the
current client need not render them.

## Compatibility and migration

On state reads, migration scans legacy top-level workflow JSON documents and
moves each into its repository issue directory. Legacy `dev.log` and
`review.log` files are converted line-by-line into one JSONL task generation,
using the workflow's recorded task id when available. A source is removed only
after its destination is complete. Errors are swallowed so startup continues
and the unchanged source can be retried later.

`/history?taskId=...` searches persisted task files, allowing older rounds to
remain queryable after newer tasks replace the workflow's latest task id. The
legacy `key+kind` query remains an alias for the latest recorded round.

## Verification

Pure tests cover reversible paths and collision-free ids. Storage tests cover
valid JSONL, source/sequence fidelity, independent rounds, metrics, and legacy
migration. Existing `LineLog` tests continue to cover partial and oversized
lines, while route tests lock history lookup and SSE `__historyRequired`
fallback behavior.
