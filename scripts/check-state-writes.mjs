import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import ts from 'typescript'

// Workflow-state persistence boundary gate (docs/fix-discipline.md 机器门禁),
// AST-based so aliases, rebinding and namespace imports cannot bypass it:
// rule 1 — only the persistence layer may reference workflow state path helpers;
// rule 2 — the persistence module is reachable only via the state facade and
//          the pure ownership selector;
// rule 3 — snapshot/task mutations must be conditional (revision/capability
//          argument required; a bare one-argument call is last-writer-wins).

const MUTATION_NAMES = new Set(['saveWorkflow', 'saveWorkflowForTask', 'claimWorkflowTask', 'mutateWorkflowForTask'])
const PATH_NAMES = new Set(['workflowPath', 'workflowStatePath'])
const PATH_ALLOWED = new Set(['src/infra/workflow-persistence.ts', 'src/infra/state-layout.ts', 'src/infra/state.ts'])
const IMPORT_ALLOWED = new Set(['src/infra/state.ts', 'src/infra/task-ownership.ts'])

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await collect(absolute)))
    else if (/\.tsx?$/.test(entry.name)) files.push(absolute)
  }
  return files
}

function importSpecifier(node) {
  if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) return node.moduleSpecifier.text
  if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
    return node.moduleSpecifier.text
  }
  return null
}

/** Track local names bound to mutation/path functions, across aliases and rebinding. */
function trackBindings(source, targets) {
  const names = new Set()
  const visit = (node) => {
    if (!node) return
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text
      const relevant =
        /workflow-persistence(\.ts)?$/.test(specifier) ||
        /(^|\/)state(\.ts)?$/.test(specifier) ||
        /(^|\/)state-layout(\.ts)?$/.test(specifier)
      if (relevant && node.importClause) {
        const clause = node.importClause
        if (clause.name) names.add(clause.name.text) // default import of the facade
        if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) names.add(`*${clause.namedBindings.name.text}`)
          for (const element of clause.namedBindings.elements ?? []) {
            if (targets.has(element.propertyName?.text ?? element.name.text)) names.add(element.name.text)
          }
        }
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      names.has(node.initializer.text)
    ) {
      names.add(node.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return names
}

function allowed(set, relative) {
  return [...set].some((key) => relative === key || relative.endsWith(`/${key}`))
}

function checkFile(relative, source, failures) {
  const mutationNames = trackBindings(source, MUTATION_NAMES)

  if (!allowed(PATH_ALLOWED, relative)) {
    const visit = (node) => {
      if (!node) return
      if (ts.isIdentifier(node) && PATH_NAMES.has(node.text)) {
        failures.push(`${relative}: workflow state path may only be referenced in the persistence layer`)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }

  const visit = (node) => {
    if (!node) return
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = importSpecifier(node)
      if (/workflow-persistence(\.ts)?$/.test(specifier ?? '') && !allowed(IMPORT_ALLOWED, relative)) {
        failures.push(`${relative}: import workflow-persistence directly (must go through src/infra/state.ts)`)
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const isTrackedCall =
        (ts.isIdentifier(callee) && mutationNames.has(callee.text)) ||
        (ts.isPropertyAccessExpression(callee) &&
          mutationNames.has(`*${callee.expression.getText()}`) &&
          MUTATION_NAMES.has(callee.name.text))
      if (isTrackedCall && node.arguments.length < 2) {
        const name = ts.isIdentifier(callee) ? callee.text : callee.name.text
        failures.push(`${relative}: ${name} called without expected-revision/capability argument (last-writer-wins)`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}

const roots = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['src']
const failures = []
for (const root of roots) {
  const absoluteRoot = path.resolve(process.cwd(), root)
  const rootLabel = root.replace(/\/+$/, '').split('/').pop()
  for (const file of await collect(absoluteRoot)) {
    const relative = path.posix.join(rootLabel, path.relative(absoluteRoot, file).split(path.sep).join('/'))
    const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.ES2022, true)
    checkFile(relative, source, failures)
  }
}

if (failures.length > 0) {
  console.error(`State-write gate failed:\n${failures.join('\n')}`)
  process.exitCode = 1
} else {
  console.log('State-write gate passed.')
}
