import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

test('r5/F6: helper forwarding and literal indirection fail closed', () => {
  // Reviewer repro: forwarding literals through an untracked helper.
  assert.ok(
    scanSource("exec(build('gh','api','repos/o/r'))").length >= 1,
    'literal gh+api arguments to any helper are a construction site',
  )
  assert.ok(
    scanSource("run(['gh', 'api'].concat(args))").length >= 1,
    'array element pairs gh+api count as construction',
  )
  const helper = scanSource("function build() { return 'gh' + ' api x' }\nexport const go = () => exec(build())")
  assert.ok(helper.length >= 2, `helper body AND its call site are reported (saw ${helper.length})`)
  assert.ok(
    scanSource("const c = 'gh' + op").length >= 1,
    'an unresolved concat headed by a standalone gh token fails closed',
  )
})

test('r5/F6: the allowlist binds named symbols — a rogue read inside an allowlisted file is caught', () => {
  const root = mkdtempSync(join(tmpdir(), 'clickvibe-gh-gate-symbols-'))
  try {
    const rest = [
      'export class GithubRestReader {',
      '  private async request() {',
      "    const command = ['gh api --include', path].join(' ')",
      '    return command',
      '  }',
      '}',
      'export const rogue = () => exec(`gh api repos/o/r/rogue`)',
    ].join('\n')
    const files = new Map([
      ['src/github/rest.ts', rest],
      ['src/agent/prompts.ts', 'export const tip = "优先使用 `gh api` REST"\n'],
      ['src/agent/prompts-exec.ts', 'export const bad = () => run(`gh api repos/o/r`)\n'],
      ['src/client/panel.tsx', 'export const panel = () => exec(`gh api repos/o/r`)\n'],
    ])
    for (const [name, source] of files) {
      const path = join(root, name)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, source)
    }
    const violations = audit(root, (file) => files.get(file.slice(root.length + 1)) ?? '')
    assert.deepEqual(
      violations.map((violation) => violation.file).sort(),
      ['src/agent/prompts-exec.ts', 'src/client/panel.tsx', 'src/github/rest.ts'].sort(),
      'prompt TEXT stays allowed, execution inside the prompt boundary does not, rogue symbols in rest.ts are caught',
    )
    const restViolation = violations.find((violation) => violation.file === 'src/github/rest.ts')
    assert.ok(restViolation, 'rest.ts still reports its rogue symbol')
    assert.ok(
      restViolation.hits.every((hit) => hit.symbol !== 'request'),
      'the allowlisted request method itself is not reported',
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

test('r6/F6 regression: a same-name second declaration never borrows the allowlist entry', () => {
  const root = mkdtempSync(join(tmpdir(), 'clickvibe-gh-gate-name-'))
  try {
    mkdirSync(join(root, 'src', 'github'), { recursive: true })
    // Mirrors the allowlisted rest.ts entry (request@1, clean) plus a rogue
    // SECOND declaration with the same name that constructs a gh command.
    const files = new Map<string, string>([
      [
        'src/github/rest.ts',
        [
          'export class Reader {',
          '  private async request(path: string) {',
          '    return exec(`gh api --include repos/o/r`)',
          '  }',
          '}',
          'function request(path: string) {',
          '  return exec(`gh api repos/o/r/rogue --input x`)',
          '}',
          'export const cmd = request',
        ].join('\n'),
      ],
    ])
    for (const [name, source] of files) {
      const target = join(root, name)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, source)
    }
    const violations = audit(root, (file) => files.get(file.slice(root.length + 1)) ?? '')
    assert.equal(violations.length, 1, `the same-name rogue declaration must be flagged: ${JSON.stringify(violations)}`)
    const hits = violations[0].hits as Array<{ decl?: string }>
    assert.ok(
      hits.every((hit) => hit.decl === 'request@2' || hit.helperKeys),
      `violations must pin declaration identity (request@2), got ${JSON.stringify(hits)}`,
    )
    // And the clean single-declaration shape still passes untouched.
    const clean = new Map<string, string>([
      [
        'src/github/rest.ts',
        [
          'export class Reader {',
          '  private async request(path: string) {',
          '    return exec(`gh api --include repos/o/r`)',
          '  }',
          '}',
        ].join('\n'),
      ],
    ])
    assert.deepEqual(
      audit(root, (file) => clean.get(file.slice(root.length + 1)) ?? ''),
      [],
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
