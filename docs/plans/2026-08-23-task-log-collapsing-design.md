# Task log collapsing design (Issue #79)

## Scope and approach

The client turns the existing `LiveLogEvent[]` into presentation-only blocks before rendering. Consecutive `command_output` events become one block; every other non-usage event remains an independent block, and usage events remain available to the terminal header without entering the body. Each block keeps a stable id derived from the first source-event position and kind, so appending live events does not remount earlier React rows. The pure transformation never mutates an event or changes the history, SSE, or JSONL contracts.

A second pure helper decides whether a block is long and returns either its complete text or a head preview. A block is long above 20 logical lines or 2,000 characters. Its preview contains at most eight complete leading lines and targets 800 characters; when the first line itself exceeds that target, it remains whole so the preview never cuts through a line. The UI owns only a set of expanded block ids. Long blocks start collapsed, expose their total line count, and can be expanded and collapsed in both embedded and detached terminals. Full and preview text use the terminal's existing pre-wrapped whitespace behavior.

## Verification

Pure tests cover aggregation boundaries, stable ids after append, usage exclusion, exact source-text preservation, logical line counts, line-boundary previews, and short-content passthrough. Component markup checks cover the default collapsed control and direct rendering of short message, action, stage, and system blocks. Typecheck, build, the full test suite, coverage, lint, formatting, layer checks, and size checks remain delivery gates.
