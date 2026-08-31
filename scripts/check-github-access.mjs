#!/usr/bin/env node
/**
 * GitHub-access gate (issue #131; ADR-0010 §7; design §11/§13).
 *
 * Controller-owned gh command construction is boundary-only. Detection is
 * SYNTAX-level, not line-regex: the scanner parses each TypeScript source,
 * statically evaluates string expressions (literals, template spans with
 * known identifiers, binary +, array join, const aliases) and flags any
 * evaluated value containing `gh api|pr|issue`. Computed aliases that the
 * evaluator cannot resolve are flagged as `unresolved` — the scanner cannot
 * prove them safe, so they fail closed.
 *
 * Allowed construction sites: the Gateway adapter (rest.ts), Agent prompt
 * instructions (a different boundary), and the named temporary write
 * allowlist pending Slice B.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const SRC_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src')

const ALLOWLIST = new Map(
  Object.entries({
    'src/github/rest.ts': 'the Gateway adapter itself — the only HTTP executor',
    'src/agent/prompts.ts': 'Agent-owned prompt instructions, never Controller execution (ADR-0007 exclusion)',
    'src/github/review-approval.ts': 'Slice B: typed approval + reviews readback',
    'src/workflow/dev-delivery.ts': 'Slice B: typed comment edit + readback',
    'src/workflow/delivery-publish.ts': 'Slice B: typed non-repeatable comment + marker/readback',
    'src/workflow/merge.ts': 'Slice B: exclusive merge/close write transaction',
  }),
)

const GH_COMMAND = /(?:^|\s)gh\s+(?:api|pr|issue)\b/

/** Evaluate a static string expression; null = not statically provable. */
function evaluateString(node, env) {
  switch (node.kind) {
    case ts.SyntaxKind.StringLiteral:
      return node.text
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      return node.text
    case ts.SyntaxKind.TemplateExpression: {
      let result = node.head.text
      for (const span of node.templateSpans) {
        const value = evaluateString(span.expression, env)
        if (value === null) return null
        result += value
        result += span.literal.text
      }
      return result
    }
    case ts.SyntaxKind.Identifier: {
      const binding = env.get(node.text)
      return binding === undefined ? null : binding
    }
    case ts.SyntaxKind.BinaryExpression: {
      if (node.operatorToken.kind !== ts.SyntaxKind.PlusToken) return null
      const left = evaluateString(node.left, env)
      const right = evaluateString(node.right, env)
      return left === null || right === null ? null : left + right
    }
    case ts.SyntaxKind.CallExpression: {
      if (node.expression.kind !== ts.SyntaxKind.PropertyAccessExpression) return null
      const access = node.expression
      if (access.name.text !== 'join') return null
      if (access.expression.kind !== ts.SyntaxKind.ArrayLiteralExpression) return null
      const separator = node.arguments.length > 0 ? evaluateString(node.arguments[0], env) : ','
      if (separator === null) return null
      const parts = []
      for (const element of access.expression.elements) {
        const value = evaluateString(element, env)
        if (value === null) return null
        parts.push(value)
      }
      return parts.join(separator)
    }
    default:
      return null
  }
}

/** File-level const string bindings used as evaluation aliases. */
function collectConstStrings(sourceFile) {
  const env = new Map()
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.kind === ts.SyntaxKind.Identifier &&
      node.initializer &&
      ts.isStringLiteral(node.initializer)
    ) {
      env.set(node.name.text, node.initializer.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return env
}

export function scanSource(source, fileName = 'virtual.ts') {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const env = collectConstStrings(sourceFile)
  const hits = []
  const reported = new Set()
  const report = (node, text, resolved) => {
    const pos = node.getStart(sourceFile)
    if (reported.has(pos)) return
    reported.add(pos)
    const { line } = sourceFile.getLineAndCharacterOfPosition(pos)
    hits.push({ line: line + 1, text: text.slice(0, 160), resolved })
  }
  const visit = (node) => {
    // Only string-builder shapes are evaluated or fail-closed; other node
    // kinds (whole files, statements, imports) are not command constructions.
    const isBuilder =
      ts.isTemplateExpression(node) ||
      ts.isBinaryExpression(node) ||
      ts.isCallExpression(node) ||
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node)
    // Binary + must actually be string-ish on at least one side; a pure
    // boolean comparison chain mentioning 'gh-issue' is not a construction.
    if (ts.isBinaryExpression(node) && node.operatorToken.kind !== ts.SyntaxKind.PlusToken) {
      ts.forEachChild(node, visit)
      return
    }
    if (isBuilder) {
      const value = evaluateString(node, env)
      if (value !== null && GH_COMMAND.test(value)) {
        report(node, value.trim(), true)
      } else if (value === null && (ts.isTemplateExpression(node) || ts.isBinaryExpression(node))) {
        // Fail closed only on string builders: a wrapper call forwards a
        // construction whose own site is (or will be) reported; template/plus
        // builders that resist evaluation are the real unknowns.
        const text = node.getText(sourceFile)
        if (/\bgh\b/.test(text) && /\b(?:api|pr|issue)\b/.test(text)) {
          report(node, `unresolved gh construction: ${text.trim()}`, false)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
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
    const hits = scanSource(read(file), file)
    if (hits.length === 0) continue
    const relative = file.startsWith(root) ? file.slice(root.length + 1) : file.slice(file.lastIndexOf('src'))
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
