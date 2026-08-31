import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { audit, scanSource } from '../scripts/check-github-access.mjs'

test('scanSource evaluates literal, template, alias, concat and join constructions', () => {
  assert.equal(scanSource('const command = `gh pr merge 7`').length, 1)
  assert.equal(scanSource("await run(`gh api 'repos/o/r'`)").length, 1)
  assert.equal(scanSource('run(`gh issue close 7`)').length, 1)
  // r2 reviewer bypass: computed alias resolved through const bindings
  const aliased = scanSource(
    "const binary = 'gh'\nconst command = `${" + 'binary' + '} api repos/o/r/issues/1`\nexport const cmd = command',
  )
  assert.equal(aliased.length, 1, 'const alias must be evaluated, not slipped past')
  assert.equal(aliased[0].resolved, true)
  // concatenation
  const concat = scanSource("const c = 'gh' + ' api repos/o/r'\nexport const cmd = c")
  assert.equal(concat.length, 1)
  // array join
  const joined = scanSource("const c = ['gh', 'api', 'x'].join(' ')\nexport const cmd = c")
  assert.equal(joined.length, 1)
})

test('scanSource ignores prose, git commands and gh-issue identifiers that are not commands', () => {
  assert.deepEqual(scanSource('const note = "use git fetch, not gh"'), [])
  assert.deepEqual(scanSource('const command = `git push origin main`'), [])
  assert.deepEqual(scanSource("const skill = 'gh-issue'"), [])
  assert.deepEqual(scanSource("if (metadata.name !== 'gh-issue') throw new Error('bad')"), [])
})

test('audit fails a new Controller site constructing gh commands (rogue file matrix)', () => {
  const root = mkdtempSync(join(tmpdir(), 'clickvibe-gh-gate-'))
  try {
    const cases: Array<[name: string, source: string]> = [
      ['rogue.ts', 'export const run = async () => {\n  await exec(`gh api repos/o/r`)\n}\n'],
      ['alias.ts', "const b = 'gh'\nexport const run = async () => exec(`${" + 'b' + '} pr view 7`)\n'],
      ['join.ts', "export const run = async () => exec(['gh', 'issue', 'close', '7'].join(' '))\n"],
    ]
    const files = new Map<string, string>(cases)
    for (const [name, source] of cases) writeFileSync(join(root, name), source)
    const violations = audit(root, (file) => files.get(file.slice(root.length + 1)) ?? '')
    assert.deepEqual(
      violations.map((violation) => violation.file).sort(),
      ['alias.ts', 'join.ts', 'rogue.ts'].sort(),
      'computed/alias/join constructions are all caught',
    )
    assert.deepEqual(
      audit(root, () => ''),
      [],
      'no construction, no violations',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an allowlisted file is exempt; the real repository passes', () => {
  // embedded-skill.ts mentions the gh-issue skill path but constructs no command.
  const violations = audit()
  assert.deepEqual(violations, [], 'src/ contains no un-allowlisted gh construction')
})
