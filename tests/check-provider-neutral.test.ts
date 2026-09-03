/**
 * Provider-neutral core gate tests (ADR-0013 §3, issue #137 AC9).
 *
 * The gate keeps a CLOSED list of provider-neutral core modules and fails on
 * GitHub-specific imports, gh command construction, GitHub string literals,
 * GitHub-shaped type names, and GitHub response-field tokens inside them —
 * plus a missing core file, so removals must update the inventory.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { audit, CORE_FILES, scanSource } from '../scripts/check-provider-neutral.mjs'

const CLEAN_MODULE = `
export interface NeutralThing {
  provider: string
  id: string
}
export function neutral(value: NeutralThing): string {
  return value.provider + value.id
}
`

function hitsByRule(hits) {
  return Object.fromEntries([...new Set(hits.map((hit) => hit.rule))].map((rule) => [rule, true]))
}

test('the closed core inventory matches ADR-0013 §3 and every file exists', async () => {
  assert.deepEqual(CORE_FILES, [
    'src/infra/contracts.ts',
    'src/infra/work-item-identity.ts',
    'src/infra/project-binding.ts',
    'src/infra/repository-identity.ts',
    'src/workflow/work-item-contract.ts',
    'src/workflow/derive-from-facts.ts',
  ])
  assert.deepEqual(await audit(), [])
})

test('a github import inside a core module is a violation', () => {
  const hits = scanSource(`import type { GithubPrFact } from '../github/facts.ts'\n${CLEAN_MODULE}`, 'core.ts')
  assert.equal(hitsByRule(hits).githubImport, true)
  assert.equal(hitsByRule(hits).githubTypeName, true)
})

test('gh command construction is a violation and never allowlistable', () => {
  const hits = scanSource(`export const command = 'gh api repos/ai-daming/clickvibe'\n`, 'core.ts')
  assert.equal(hitsByRule(hits).ghCommand, true)
})

test('github string literals and response-field tokens are violations', () => {
  const hits = scanSource(
    `export const host = 'github.com'\nexport const url = makeUrl()\nconst field = payload.html_url\n`,
    'core.ts',
  )
  assert.equal(hitsByRule(hits).githubLiteral, true)
  assert.equal(hitsByRule(hits).githubResponseField, true)
})

test('comments mentioning GitHub are not violations', () => {
  const hits = scanSource(
    `// See https://github.com/ai-daming/clickvibe for history.\n/* git/GitHub facts stay authoritative. */\n${CLEAN_MODULE}`,
    'core.ts',
  )
  assert.deepEqual(hits, [])
})

test('the allowlisted plane identifier in contracts.ts stays green; a missing core file fails closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'provider-neutral-gate-'))
  try {
    for (const file of CORE_FILES) {
      const target = join(root, file)
      await mkdir(join(target, '..'), { recursive: true })
      await writeFile(
        target,
        file === 'src/infra/contracts.ts'
          ? `export interface DiagnosticSource {\n  source: 'clickvibe' | 'github-gateway' | 'remote-git'\n}\n`
          : CLEAN_MODULE,
        'utf8',
      )
    }
    assert.deepEqual(await audit(root), [])

    await rm(join(root, CORE_FILES[0]))
    const violations = await audit(root)
    assert.equal(violations.length, 1)
    assert.match(violations[0].message, /missing core module/i)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an unallowlisted github literal inside contracts.ts is a violation', () => {
  const hits = scanSource(`export const host = 'github.com'\n`, 'src/infra/contracts.ts')
  assert.equal(hitsByRule(hits).githubLiteral, true)
})
