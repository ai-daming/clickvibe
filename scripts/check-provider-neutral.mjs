#!/usr/bin/env node
/**
 * Provider-neutral core gate (ADR-0013 §3, issue #137 AC9).
 *
 * The provider-neutral core is a CLOSED module inventory. Inside those files,
 * GitHub-specific imports, gh command construction, GitHub string literals,
 * GitHub-shaped type names, and GitHub response-field tokens are violations.
 * Only literal/token/name hits may be allowlisted with a reason; github
 * imports and gh command construction are structural red lines. A listed core
 * file that no longer exists also fails, so the inventory cannot rot silently.
 */

import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const SRC_ROOT = path.resolve(import.meta.dirname, '..')

/** Closed core inventory per ADR-0013 §3 (identity, bindings, contract canonicalization, pure derive). */
export const CORE_FILES = [
  'src/infra/contracts.ts',
  'src/infra/work-item-identity.ts',
  'src/infra/project-binding.ts',
  'src/infra/repository-identity.ts',
  'src/workflow/work-item-contract.ts',
  'src/workflow/derive-from-facts.ts',
]

/** Literal/token/name exemptions with reasons; githubImport and ghCommand are never exempt. */
const ALLOWLIST = new Map([
  [
    'src/infra/contracts.ts',
    new Set([
      // ADR-0007 names the plane "GitHub REST Gateway"; DiagnosticRecord.source
      // is a value-level plane taxonomy, not a provider type leak.
      'github-gateway',
    ]),
  ],
])

const GITHUB_IMPORT =
  /(?:^|[\s;}])(?:import|export)[^;'"`]*?from\s*['"][^'"]*(?:^|\/)github\/[^'"]*['"]|import\s*\(\s*['"][^'"]*(?:^|\/)github\/[^'"]*['"]/
const GH_COMMAND = /\bgh\s+(?:api|pr|issue)\b/
const GITHUB_LITERAL = /(['"`])(?:[^'"`\n\\]|\\.)*[Gg]it[Hh]ub(?:[^'"`\n\\]|\\.)*\1/g
const GITHUB_TYPE_NAME = /\bGithub[A-Z]\w*/
const GITHUB_RESPONSE_FIELD = /\b(?:html_url|node_id)\b/

/** Remove //-line and block comments (approximate; errs toward scanning more, never less). */
export function stripComments(source) {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, '')
  return withoutBlocks
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
}

export function scanSource(rawSource, fileName = 'virtual.ts') {
  const source = stripComments(rawSource)
  const lines = source.split('\n')
  const allowlist = ALLOWLIST.get(fileName) ?? new Set()
  const hits = []
  const report = (line, rule, text) => hits.push({ line, rule, text: text.trim().slice(0, 160) })

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (GITHUB_IMPORT.test(line)) report(index + 1, 'githubImport', line)
    if (GH_COMMAND.test(line)) report(index + 1, 'ghCommand', line)
    if (GITHUB_RESPONSE_FIELD.test(line) && !allowlist.has('html_url') && !allowlist.has('node_id')) {
      report(index + 1, 'githubResponseField', line)
    }
    for (const match of line.matchAll(GITHUB_LITERAL)) {
      const literal = match[0].slice(1, -1)
      if (!allowlist.has(literal)) report(index + 1, 'githubLiteral', line)
    }
    const typeName = line.match(GITHUB_TYPE_NAME)
    if (typeName && !allowlist.has(typeName[0])) report(index + 1, 'githubTypeName', line)
  }
  return hits
}

export async function audit(root = SRC_ROOT, read = (file) => readFile(file, 'utf8')) {
  const violations = []
  for (const file of CORE_FILES) {
    const absolute = path.join(root, file)
    let exists = true
    try {
      exists = (await stat(absolute)).isFile()
    } catch {
      exists = false
    }
    if (!exists) {
      violations.push({ file, message: `missing core module: ${file}` })
      continue
    }
    const hits = scanSource(await read(absolute), file)
    if (hits.length > 0) violations.push({ file, message: `${hits.length} GitHub-specific hit(s)`, hits })
  }
  return violations
}

const isMain = process.argv[1] && import.meta.filename === path.resolve(process.argv[1])
if (isMain) {
  const violations = await audit()
  if (violations.length > 0) {
    console.error('Provider-neutral core gate FAILED:')
    for (const violation of violations) {
      console.error(`\n${violation.file}: ${violation.message}`)
      for (const hit of violation.hits ?? []) console.error(`  L${hit.line} [${hit.rule}]: ${hit.text}`)
    }
    console.error(
      '\nCore modules must stay provider-neutral (ADR-0013 §3); literal exemptions need an ALLOWLIST entry with a reason. github imports and gh command construction are never exempt.',
    )
    process.exit(1)
  }
  console.log(
    `Provider-neutral core gate passed (${CORE_FILES.length} core modules, ${ALLOWLIST.size} exempted files).`,
  )
}
