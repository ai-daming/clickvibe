import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { audit, ALLOWLIST, scanSource } from '../scripts/check-local-git-writes.mjs'

test('scanSource flags local git write commands', () => {
  const hits = scanSource("await runCommand(ctx, 'git push origin main')\nawait runCommand(ctx, 'git worktree add x')")
  assert.equal(hits.length, 2)
  assert.deepEqual(
    hits.map((hit) => hit.line),
    [1, 2],
  )
})

test('scanSource ignores read-only probes of mutating verbs', () => {
  const source = [
    "runCommand(ctx, 'git branch --show-current')",
    "runCommand(ctx, 'git worktree list --porcelain')",
    "runCommand(ctx, 'git rev-list --left-right --count main...HEAD')",
    "runCommand(ctx, 'git merge-base --is-ancestor a b')",
    "runCommand(ctx, 'git status --porcelain')",
    "runCommand(ctx, 'git show-ref --verify refs/heads/main')",
  ].join('\n')
  const hits = scanSource(source)
  assert.deepEqual(hits, [], `unexpected write flags: ${JSON.stringify(hits)}`)
})

test('audit requires invalidation references or an allowlist entry', () => {
  const root = mkdtempSync(join(tmpdir(), 'clickvibe-gate-'))
  try {
    mkdirSync(join(root, 'src'))
    writeFileSync(
      join(root, 'src', 'writes-with-invalidation.ts'),
      "const cmd = 'git push origin main'\nnotifyLocalGitMutation({ repoKey }, 'sync', 'syncWorktree')",
    )
    writeFileSync(join(root, 'src', 'writes-silent.ts'), "const cmd = 'git commit -m x'")
    writeFileSync(join(root, 'src', 'reads-only.ts'), "const cmd = 'git status --porcelain'")

    const violations = audit(root, (file) => readFileSyncShim(file))
    assert.deepEqual(
      violations.map((violation) => violation.file),
      ['src/writes-silent.ts'],
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  function readFileSyncShim(file) {
    return file.endsWith('writes-with-invalidation.ts')
      ? "const cmd = 'git push origin main'\nnotifyLocalGitMutation({ repoKey }, 'sync', 'syncWorktree')"
      : file.endsWith('writes-silent.ts')
        ? "const cmd = 'git commit -m x'"
        : "const cmd = 'git status --porcelain'"
  }
})

test('an allowlisted file with writes passes without an invalidation reference', () => {
  const root = mkdtempSync(join(tmpdir(), 'clickvibe-gate-allow-'))
  try {
    const allowlistedPath = [...ALLOWLIST.keys()][0]
    mkdirSync(join(root, allowlistedPath, '..'), { recursive: true })
    assert.ok(allowlistedPath, 'allowlist must expose at least one path')
    writeFileSync(join(root, allowlistedPath), "const cmd = 'git fetch origin --prune'")
    const violations = audit(root, () => "const cmd = 'git fetch origin --prune'")
    assert.deepEqual(violations, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
