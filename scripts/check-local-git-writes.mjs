#!/usr/bin/env node
/**
 * Local-git write invalidation gate (issue #122, ADR-0007).
 *
 * Every Controller-owned file that runs a LOCAL GIT WRITE command must either
 * reference the invalidation API (notifyLocalGitMutation) or be explicitly
 * allowlisted here with a reason — e.g. low-level adapters whose invalidation
 * happens at the workflow-layer call site. A new write site that silently
 * skips invalidation would serve stale panel snapshots forever; this gate
 * turns that mistake into a red CI run.
 *
 * Read probes (branch --show-current, worktree list, diff, log, …) are not
 * writes and are ignored.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src')

/** Local git write verbs; read-only uses of these verbs are excluded below. */
const WRITE_VERB =
  /\bgit\s+(?:-[^\s'`"]+\s+)*(?:fetch|push|merge|commit|reset|stash|switch|checkout|worktree|branch|rebase|revert|restore|clean|cherry-pick|apply|bisect)\b/

/** Read-only invocations of otherwise-mutating verbs. */
const READ_USE =
  /\bgit\s+(?:-[^\s'`"]+\s+)*(?:(?:branch\s+--show-current)|(?:worktree\s+list)|(?:diff\b)|(?:log\b)|(?:show\b)|(?:status\b)|(?:rev-parse\b)|(?:rev-list\b)|(?:merge-base\b)|(?:merge-tree\b)|(?:symbolic-ref\b)|(?:show-ref\b)|(?:for-each-ref\b)|(?:cat-file\b)|(?:ls-remote\b))/

/** Files allowed to run local git writes without referencing invalidation here. */
export const ALLOWLIST = new Map(
  Object.entries({
    'src/infra/git.ts': 'low-level adapter; invalidation happens at workflow-layer callers',
    'src/infra/repository-git.ts': 'low-level adapter; syncConfiguredRepository call site invalidates',
    'src/infra/baseline-restore-git.ts': 'low-level adapter; restoreBaseBranch call site invalidates',
    'src/infra/develop-core.ts': 'command construction only; executed via ensureWorktree which invalidates',
    'src/agent/develop.ts': 'command construction only; executed via ensureWorktree which invalidates',
    'src/agent/prompts.ts':
      'prompt text only: instructs the Agent (Agent-owned calls), Controller executes nothing here',
    'src/infra/remote-git.ts':
      'low-level remote adapter (issue #135 slice A); call-site invalidation today, Coordinator owns it in slice B',
  }),
)

export function scanSource(source) {
  const lines = source.split('\n')
  const hits = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (!WRITE_VERB.test(line)) continue
    if (READ_USE.test(line)) continue
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
    const referencesInvalidation = source.includes('notifyLocalGitMutation')
    if (referencesInvalidation) continue
    const relative = file.slice(file.lastIndexOf('src'))
    if (ALLOWLIST.has(relative)) continue
    violations.push({ file: relative, hits })
  }
  return violations
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const violations = audit()
  if (violations.length > 0) {
    console.error('local-git write invalidation gate FAILED:')
    for (const violation of violations) {
      console.error(`\n${violation.file} runs local git writes without invalidation:`)
      for (const hit of violation.hits) console.error(`  L${hit.line}: ${hit.text}`)
    }
    console.error(
      '\nReference notifyLocalGitMutation({ repoKey, worktreePath? }, reason, trigger) at every exit past a write,' +
        ' or add an explicit allowlist entry with a reason.',
    )
    process.exit(1)
  }
  console.log(`local-git write invalidation gate passed (${ALLOWLIST.size} explained exceptions).`)
}
