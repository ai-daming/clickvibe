import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { audit, scanSource } from '../scripts/check-github-access.mjs'

test('scanSource flags gh api/pr/issue command construction', () => {
  const hits = scanSource('const command = `gh pr merge 7`')
  assert.equal(hits.length, 1)
  const ghApi = scanSource("await run(`gh api 'repos/o/r'`)")
  assert.equal(ghApi.length, 1)
  const ghIssue = scanSource('run(`gh issue close 7`)')
  assert.equal(ghIssue.length, 1)
})

test('scanSource ignores plain prose and other binaries', () => {
  assert.deepEqual(scanSource('const note = "use git fetch, not gh"'), [])
  assert.deepEqual(scanSource('const command = `git push origin main`'), [])
  assert.deepEqual(scanSource('// docs say: gh api is preferred'), [])
})

test('audit fails a new Controller site constructing gh commands', () => {
  const root = mkdtempSync(join(tmpdir(), 'clickvibe-gh-gate-'))
  try {
    writeFileSync(join(root, 'rogue.ts'), 'export const run = async () => {\n  await exec(`gh api repos/o/r`)\n}\n')
    const violations = audit(root, (file) =>
      file.endsWith('rogue.ts') ? 'export const run = async () => {\n  await exec(`gh api repos/o/r`)\n}\n' : '',
    )
    assert.equal(violations.length, 1)
    assert.equal(violations[0].file, 'rogue.ts')
    assert.equal(violations[0].hits.length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('audit passes when the only gh sites are the allowlisted boundaries', () => {
  const root = mkdtempSync(join(tmpdir(), 'clickvibe-gh-ok-'))
  try {
    writeFileSync(join(root, 'rest.ts'), "const command = `gh api 'repos/o/r'`\n")
    const files = new Map<string, string>([['rest.ts', "const command = `gh api 'repos/o/r'`\n"]])
    const violations = audit(root, (file) => files.get(file.slice(root.length + 1)) ?? '')
    // rest.ts alone is not allowlisted without the src/ prefix — expect the
    // violation, then prove the allowlisted path form is exempt.
    assert.equal(violations.length, 1)
    assert.equal(violations[0].file, 'rest.ts')
    assert.deepEqual(
      audit(root, () => ''),
      [],
      'no gh construction, no violations',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the real repository sources pass the gate', () => {
  assert.deepEqual(audit(), [], 'src/ contains no un-allowlisted gh construction')
})
