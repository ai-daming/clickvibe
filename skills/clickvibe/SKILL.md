---
name: clickvibe
description: Trigger ClickVibe pipeline operations (develop / review / rework / resume / sync / stop / merge / status / issues) as text commands through the local ClickVibe host API, so the user can drive the whole issue-to-merge pipeline from a conversation ("把 #8 下单开发"). Use whenever the user asks to start, review, rework, resume, stop, sync, merge, or check the status of a ClickVibe issue — the panel UI is just one entry point; this Skill is the conversation entry point to the exact same backend actions.
---

# ClickVibe Conversation Operator

Operate the ClickVibe delivery pipeline from conversation. One command endpoint, one shared backend: every command below executes the identical checks and actions as the corresponding panel button.

## Endpoint

```sh
curl -s "$CLICKVIBE_API_BASE/clickvibe/api/command" \
  -H 'content-type: application/json' \
  -H "origin: $CLICKVIBE_API_BASE" \
  -H 'x-clickvibe-request: 1' \
  -d '{"command":"..."}'
```

`CLICKVIBE_API_BASE` defaults to `http://127.0.0.1:3080` (the DSH web host). The three headers above are required for write commands; without them the server answers 403 before reading any config.

## Command grammar

Full reference: `docs/command-reference.md` in the ClickVibe repo. Summary:

```text
help | projects
issues [repoKey]
status <#N | issue-url> [repoKey]
develop <target> [repoKey] [codex|claude] [context=…]
review <target> [repoKey] [codex|claude]
rework <target> [context=…]      # carries review feedback automatically
resume <target> [context=…]
sync <target> | stop <target> | merge <target>
```

- Translate the user's natural language ("把 #8 下单开发", "看看 23 什么进度", "合并掉 #23") into this strict grammar; the server does not guess. Chinese verb aliases (下单开发/审查/返工/恢复/合并/同步/停止/状态) are accepted natively.
- `#N` / `N` / full issue URL all work; `review` also accepts a PR URL. With multiple configured repos the repoKey is required; when omitted and ambiguous the server returns an actionable error — relay it, do not guess.

## Read the response

- `text` is the user-facing readable result — show it (or summarize it) in the conversation. It is safe to relay verbatim.
- Read commands (`status`/`issues`/`projects`) answer immediately.
- Write commands (`develop`/`review`/`rework`/`resume`/`merge`) return `needsConfirmation: true` plus a one-time `authorization`. This is a preview, nothing has executed yet.

## Two-phase confirmation protocol

1. Send the command → receive preview `text` + `authorization` (2-minute TTL).
2. Show the preview and ask the user to confirm. A recommendation, a discussion conclusion, or prior permission for another action is **not** authorization.
3. Only after an explicit yes, resend the same command with `authorizationId`, `authorizationDigest` (and `target` for merge) added to the JSON body.
4. The server revalidates the frozen snapshot before executing; if the issue changed, it rejects and you must preview again. Relay failures verbatim — never claim success without an `ok: true` execution response.

`sync` / `stop` / dryrun need no one-time authorization but still require the privileged headers.

### Merge gate override (issue #49)

A `merge` rejected by ClickVibe's own gates returns `gateFailures` (review-hash / contract checks) plus a readable list. Relay every failure item to the user. Only if the user explicitly accepts each item may you re-preview with `merge <target> override=<reason>` — the reason is mandatory, is written into the audit timeline, and only skips ClickVibe-side gates (GitHub branch protection still applies). Never suggest an override yourself; re-running Review is the default path.

## Hard boundaries

- Never execute a write command without explicit user confirmation of the exact preview.
- Merge is a human decision (版本能不能发): preview must be shown and confirmed every time; never batch-confirm.
- Do not construct or guess authorization credentials; they are issued only by the preview phase.
- Do not expose the endpoint beyond loopback, and do not put tokens or the authorization digest into public artifacts (the digest inside a private conversation reply is fine).
- Do not reimplement pipeline logic locally (worktrees, review verdicts, merge gates) — ask `status` instead; git/GitHub-derived state on the server is the only authority.
