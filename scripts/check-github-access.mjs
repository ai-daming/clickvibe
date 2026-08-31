#!/usr/bin/env node
/**
 * GitHub-access gate (issue #131 slice A; ADR-0010 §7).
 *
 * Controller-owned GitHub access must go through the Gateway adapter
 * (src/github/rest.ts) or the typed operations layer. Direct `gh api/issue/pr`
 * command construction is allowed only in:
 *   - src/github/rest.ts (the adapter itself)
 *   - the explicitly allowlisted temporary write sites pending Slice B
 *   - src/agent/prompts.ts (Agent-owned instructions — a different boundary,
 *     never a Controller execution)
 * A new Controller site constructing gh commands outside these boundaries is
 * a CI failure: it would bypass the owner's lane, caches, budget and metrics.
 *
 * The scan is line-level over production sources; Agent prompt text lines are
 * excluded by the prompts.ts allowlist entry.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src')

/** Boundaries where direct gh command construction is legitimate. */
const ALLOWLIST = new Map(
  Object.entries({
    'src/github/rest.ts': 'the Gateway adapter itself — the only HTTP executor',
    'src/agent/prompts.ts': 'Agent-owned prompt instructions, never Controller execution (ADR-0007 exclusion)',
    // Temporary write allowlist pending Slice B (ADR-0010 §7: Slice A may only
    // shrink this list; Slice B deletes it):
    'src/github/review-approval.ts': 'Slice B: typed approval + reviews readback',
    'src/workflow/dev-delivery.ts': 'Slice B: typed comment edit + readback',
    'src/workflow/delivery-publish.ts': 'Slice B: typed non-repeatable comment + marker/readback',
    'src/workflow/merge.ts': 'Slice B: exclusive merge/close write transaction',
  }),
)

const GH_COMMAND = /[`'"]\s*gh\s+(api|pr|issue)\b/

export function scanSource(source) {
  const hits = []
  const lines = source.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (!GH_COMMAND.test(line)) continue
    hits.push({ line: index + 1, text: line.trim().slice(0, 160) })
  }
  return hits
}

function listTypeScriptFiles(root) {
  const files = []
  for (const entry of readdirSync(root)) {
    const path = join(root, entry)
    if (statSync(path).isDirectory()) {
      files.push(...listTypeScriptFiles(path))
    } else if (entry.endsWith('.ts')) {
      files.push(path)
    }
  }
  return files
}

export function audit(root = SRC_ROOT, read = (file) => readFileSync(file, 'utf8')) {
  const violations = []
  for (const file of listTypeScriptFiles(root)) {
    const source = read(file)
    const hits = scanSource(source)
    if (hits.length === 0) continue
    const relative = file.startsWith(root) ? file.slice(root.length + 1) : file
    const allowKey = file.includes('/src/') ? `src/${relative}` : relative
    if (ALLOWLIST.has(allowKey)) continue
    violations.push({ file: allowKey, hits })
  }
  return violations
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const violations = audit()
  if (violations.length > 0) {
    console.error('GitHub-access gate FAILED:')
    for (const violation of violations) {
      console.error(`\n${violation.file} constructs gh commands outside the Gateway boundaries:`)
      for (const hit of violation.hits) console.error(`  L${hit.line}: ${hit.text}`)
    }
    console.error(
      '\nRoute Controller access through the Gateway adapter (src/github/rest.ts) or the typed operations layer; direct gh construction is allowlist-only (Slice B removes the write sites).',
    )
    process.exit(1)
  }
  console.log(`GitHub-access gate passed (${ALLOWLIST.size} explained boundaries).`)
}
