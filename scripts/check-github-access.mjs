#!/usr/bin/env node
/**
 * GitHub-access gate (issue #131; ADR-0010 §7; design §11/§13).
 *
 * Controller-owned gh command construction is boundary-only, and the boundary
 * is SYMBOL-level, not file-level: the allowlist names the exact functions
 * and methods allowed to assemble gh commands inside each file. A rogue read
 * added anywhere else in an allowlisted file is still caught (review r5/F6).
 *
 * Detection is SYNTAX-level with static expression evaluation (literals,
 * template spans with known identifiers, binary +, array join, const
 * aliases). Beyond provable constructions it fails closed on:
 *  - forwarded literals: any call/array passing consecutive 'gh' + subcommand
 *    string arguments to a helper the scanner cannot see through;
 *  - gh-headed unknowns: concat/template chains whose statically known part
 *    is a standalone `gh` token;
 *  - helper forwarding: call sites of locally-defined functions that
 *    construct gh commands (unless that helper symbol is allowlisted);
 *  - prompt-text boundary: a prompt module is allowed to MENTION gh commands
 *    only while it stays execution-free (no run/resolve/exec capability).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const SRC_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src')

const ALLOWLIST = new Map(
  Object.entries({
    'src/github/rest.ts': {
      boundary: 'adapter',
      symbols: ['request'],
      reason: 'the Gateway HTTP executor method — the only place a Controller gh command is assembled',
    },
    'src/agent/prompts.ts': {
      boundary: 'prompt-text',
      symbols: [],
      reason: 'Agent-owned prompt text (ADR-0007 exclusion) — allowed only while the module stays execution-free',
    },
    'src/github/review-approval.ts': {
      boundary: 'slice-b-write',
      symbols: ['approvePassedReview'],
      reason: 'Slice B: typed approval write + readback',
    },
    'src/workflow/dev-delivery.ts': {
      boundary: 'slice-b-write',
      symbols: ['markPreviousReviewFixed'],
      reason: 'Slice B: typed comment edit + readback',
    },
    'src/workflow/delivery-publish.ts': {
      boundary: 'slice-b-write',
      symbols: ['publishDeliveryComment'],
      reason: 'Slice B: typed non-repeatable comment publish',
    },
    'src/workflow/merge.ts': {
      boundary: 'slice-b-write',
      symbols: ['mergeAndCleanupUnlocked'],
      reason: 'Slice B: exclusive merge/close transaction',
    },
  }),
)

const GH_COMMAND = /(?:^|\s)gh\s+(?:api|pr|issue)\b/
const GH_SUBCOMMANDS = new Set(['api', 'pr', 'issue'])
const EXEC_CAPABILITY = /(?:^|\.)(?:run|resolve|start|execute|exec|execSync|spawn|spawnSync|runCommand)$/

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

/** Statically-known string fragments inside an expression (empty = none). */
function staticFragments(node, env, out = []) {
  if (!node) return out
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    out.push(node.text)
  } else if (ts.isTemplateExpression(node)) {
    out.push(node.head.text)
    for (const span of node.templateSpans) {
      staticFragments(span.expression, env, out)
      out.push(span.literal.text)
    }
  } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    staticFragments(node.left, env, out)
    staticFragments(node.right, env, out)
  } else if (ts.isArrayLiteralExpression(node)) {
    for (const element of node.elements) staticFragments(element, env, out)
  }
  return out
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

/** Consecutive statically-known 'gh' + subcommand pair inside call arguments
 *  or array elements — an indirection the scanner cannot see through. */
function forwardsGhLiterals(elements, env) {
  for (let index = 0; index < elements.length - 1; index += 1) {
    const first = evaluateString(elements[index], env)
    const second = evaluateString(elements[index + 1], env)
    if (first === 'gh' && second !== null && GH_SUBCOMMANDS.has(second)) return true
  }
  return false
}

/** True when the module EXECUTES a gh command (execution of git & co stays a
 *  different access plane — the prompt boundary forbids gh execution only). */
function executesGhCommand(sourceFile, env) {
  let found = false
  const visit = (node) => {
    if (ts.isCallExpression(node) && EXEC_CAPABILITY.test(node.expression.getText(sourceFile))) {
      for (const argument of node.arguments) {
        const value = evaluateString(argument, env)
        if (value !== null && GH_COMMAND.test(value)) found = true
        if (
          value === null &&
          (ts.isTemplateExpression(argument) || ts.isBinaryExpression(argument)) &&
          /\bgh\b/.test(argument.getText(sourceFile)) &&
          /\b(?:api|pr|issue)\b/.test(argument.getText(sourceFile))
        ) {
          found = true
        }
      }
    }
    if (!found) ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

export function scanSource(source, fileName = 'virtual.ts') {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const env = collectConstStrings(sourceFile)
  const hits = []
  const reported = new Set()
  const report = (node, text, resolved, rule, scope, helper) => {
    const pos = node.getStart(sourceFile)
    if (reported.has(pos)) return
    reported.add(pos)
    const { line } = sourceFile.getLineAndCharacterOfPosition(pos)
    hits.push({ line: line + 1, text: text.slice(0, 160), resolved, rule, symbol: scope, helper })
  }

  // Pass 1: construction hits with their enclosing symbols; pass 2 reports
  // call sites of hit-containing LOCAL helpers (forwarding).
  const helperBuilders = new Set()
  const scopeOf = new Map()

  const visit = (node, scope) => {
    let inner = scope
    if (ts.isFunctionDeclaration(node) && node.name) {
      inner = node.name.text
    } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      inner = node.name.text
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) inner = node.name.text
      ts.forEachChild(node, (child) => visit(child, inner))
      return
    }
    scopeOf.set(node, inner)
    // A hit inside a named local function makes that function a gh-construction
    // helper; pass 2 reports its call sites.
    const registerHelper = () => {
      if (inner !== '(top-level)') helperBuilders.add(inner)
    }

    // Only string-builder shapes are evaluated or fail-closed; other node
    // kinds (whole files, statements, imports) are not command constructions.
    const isBuilder =
      ts.isTemplateExpression(node) ||
      ts.isBinaryExpression(node) ||
      ts.isCallExpression(node) ||
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node)
    if (ts.isBinaryExpression(node) && node.operatorToken.kind !== ts.SyntaxKind.PlusToken) {
      ts.forEachChild(node, (child) => visit(child, inner))
      return
    }
    if (isBuilder) {
      const value = evaluateString(node, env)
      if (value !== null && GH_COMMAND.test(value)) {
        report(node, value.trim(), true, 'static', inner)
        registerHelper()
      } else if (value === null && (ts.isTemplateExpression(node) || ts.isBinaryExpression(node))) {
        const text = node.getText(sourceFile)
        const mentionsGhCommand = /\bgh\b/.test(text) && /\b(?:api|pr|issue)\b/.test(text)
        const ghHeadedUnknown = staticFragments(node, env).some((fragment) => /^(?:gh)(?:\s|$)/.test(fragment))
        if (mentionsGhCommand || ghHeadedUnknown) {
          report(node, `unresolved gh construction: ${text.trim()}`, false, 'unresolved', inner)
          registerHelper()
        }
      }
    }
    // Forwarded literals: gh + subcommand passed positionally to any helper,
    // or parked in an array that is not a statically-joined command itself.
    if (ts.isCallExpression(node) && forwardsGhLiterals(node.arguments, env)) {
      report(node, `forwarded gh literals: ${node.getText(sourceFile).trim()}`, false, 'forwarded', inner)
      registerHelper()
    }
    if (ts.isArrayLiteralExpression(node)) {
      const parent = node.parent
      const isJoinBase =
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === node &&
        parent.name.text === 'join' &&
        ts.isCallExpression(parent.parent)
      if (!isJoinBase && forwardsGhLiterals(node.elements, env)) {
        report(node, `forwarded gh literals: ${node.getText(sourceFile).trim()}`, false, 'forwarded', inner)
      }
    }
    ts.forEachChild(node, (child) => visit(child, inner))
  }
  visit(sourceFile, '(top-level)')

  // Pass 2: calling a local gh-command builder is a construction site too.
  const visitCalls = (node, scope) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && helperBuilders.has(node.expression.text)) {
      report(
        node,
        `forwards gh construction via helper ${node.expression.text}()`,
        false,
        'helper-forward',
        scope,
        node.expression.text,
      )
    }
    ts.forEachChild(node, (child) => visitCalls(child, scope))
  }
  visitCalls(sourceFile, '(top-level)')
  return hits.sort((left, right) => left.line - right.line)
}

function listTypeScriptFiles(root) {
  const files = []
  for (const entry of readdirSync(root)) {
    const path = join(root, entry)
    if (statSync(path).isDirectory()) {
      files.push(...listTypeScriptFiles(path))
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      files.push(path)
    }
  }
  return files
}

export function audit(root = SRC_ROOT, read = (file) => readFileSync(file, 'utf8')) {
  const violations = []
  for (const file of listTypeScriptFiles(root)) {
    const source = read(file)
    const hits = scanSource(source, file)
    if (hits.length === 0) continue
    const relative = file.startsWith(root) ? file.slice(root.length + 1) : file.slice(file.lastIndexOf('src'))
    // Fixture roots may place files under their own src/; normalize so the
    // allowlist always keys on the canonical 'src/...' shape.
    const allowKey =
      file.includes('/src/') || relative.startsWith('src/') ? `src/${relative.replace(/^src\//, '')}` : relative
    const entry = ALLOWLIST.get(allowKey)
    if (!entry) {
      violations.push({ file: allowKey, hits })
      continue
    }
    if (entry.boundary === 'prompt-text') {
      // Prompt text may mention gh commands only while the module never
      // EXECUTES one (ADR-0007 exclusion is about text; git is another plane).
      const capability = executesGhCommand(
        ts.createSourceFile(allowKey, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
        collectConstStrings(ts.createSourceFile(allowKey, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)),
      )
      if (capability) {
        violations.push({ file: allowKey, hits, boundary: 'prompt-text boundary executes a gh command' })
      }
      continue
    }
    const rogue = hits.filter(
      (hit) => !entry.symbols.includes(hit.symbol) && !(hit.helper && entry.symbols.includes(hit.helper)),
    )
    if (rogue.length > 0) violations.push({ file: allowKey, hits: rogue, boundary: entry.boundary })
  }
  return violations
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const violations = audit()
  if (violations.length > 0) {
    console.error('GitHub-access gate FAILED:')
    for (const violation of violations) {
      console.error(`\n${violation.file} constructs gh commands outside its named boundary symbols:`)
      for (const hit of violation.hits) console.error(`  L${hit.line} [${hit.symbol}] (${hit.rule}): ${hit.text}`)
    }
    console.error(
      '\nRoute Controller access through the Gateway adapter (src/github/rest.ts) or the typed operations layer; direct gh construction is allowlisted per SYMBOL only (Slice B removes the write sites).',
    )
    process.exit(1)
  }
  console.log(`GitHub-access gate passed (${ALLOWLIST.size} symbol-bound boundaries).`)
}
