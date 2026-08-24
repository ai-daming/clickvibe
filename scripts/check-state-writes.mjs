import { readdir } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import ts from 'typescript'

// Workflow-state persistence boundary gate (docs/fix-discipline.md 机器门禁).
// Symbol-based: every CallExpression is resolved through the TypeScript
// TypeChecker to the real export of state/workflow-persistence, following
// import aliases, namespace properties, reassignment and destructuring —
// name-set tracking was bypassed twice (rounds 15/16), so tracking follows
// symbols, not strings.
//
// rule 1 — only the persistence layer may reference workflow state path helpers;
// rule 2 — the persistence module is reachable only via the state facade and
//          the pure ownership selector;
// rule 3 — snapshot/task mutations must be conditional (revision/lease
//          argument required; a bare one-argument call is last-writer-wins).

const MUTATION_NAMES = new Set(['saveWorkflow', 'saveWorkflowForTask', 'claimWorkflowTask', 'mutateWorkflowForTask'])
const PATH_NAMES = new Set(['workflowPath', 'workflowStatePath'])
const FACADE_FILE = /(^|\/)state\.ts$/
const PERSISTENCE_FILE = /workflow-persistence\.ts$/

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

function allowed(set, relative) {
  return [...set].some((key) => relative === key || relative.endsWith(`/${key}`))
}

const roots = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['src']
const rootFiles = []
for (const root of roots) rootFiles.push(...(await collect(path.resolve(process.cwd(), root))))

const program = ts.createProgram(rootFiles, {
  allowImportingTsExtensions: true,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  noEmit: true,
})
const checker = program.getTypeChecker()

/** Resolve an expression to the export symbol it denotes, following aliases. */
function exportSymbol(expression) {
  if (!expression) return null
  let symbol = checker.getSymbolAtLocation(expression)
  if (!symbol) return null
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol)
  return symbol
}

function isTrackedExport(symbol) {
  if (!symbol?.declarations?.length) return false
  if (!MUTATION_NAMES.has(symbol.name)) return false
  return symbol.declarations.some((declaration) => {
    const file = declaration.getSourceFile().fileName
    return FACADE_FILE.test(file) || PERSISTENCE_FILE.test(file)
  })
}

/**
 * The tracked mutation a local binding was initialized from, if any.
 * Handles `const x = saveWorkflow`, `x = state.saveWorkflow`,
 * `const { saveWorkflow: w } = state`, and one hop through another local.
 */
function initializedMutation(declaration, localTracked) {
  if (ts.isVariableDeclaration(declaration) || ts.isBinaryExpression(declaration)) {
    const value = ts.isVariableDeclaration(declaration) ? declaration.initializer : declaration.right
    if (!value) return null
    if (ts.isIdentifier(value) && localTracked.has(value.text)) return localTracked.get(value.text)
    if (ts.isPropertyAccessExpression(value)) {
      const property = exportSymbol(value.name)
      if (isTrackedExport(property)) return property.name
    }
    const direct = exportSymbol(value)
    if (isTrackedExport(direct)) return direct.name
  }
  if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)) {
    const property =
      declaration.propertyName && ts.isIdentifier(declaration.propertyName)
        ? declaration.propertyName.text
        : declaration.name.text
    if (MUTATION_NAMES.has(property)) return property
  }
  return null
}

const failures = []
for (const sourceFile of program.getSourceFiles()) {
  if (!rootFiles.some((file) => file === sourceFile.fileName)) continue
  const relative = path.relative(process.cwd(), sourceFile.fileName).split(path.sep).join('/')

  // Local bindings carrying tracked mutations, resolved to export symbol names.
  const localTracked = new Map()
  const collectBindings = (node) => {
    if (!node) return
    const origin = initializedMutation(node, localTracked)
    if (origin) {
      const name = ts.isVariableDeclaration(node)
        ? node.name.text
        : ts.isBinaryExpression(node) && ts.isIdentifier(node.left)
          ? node.left.text
          : ts.isBindingElement(node) && ts.isIdentifier(node.name)
            ? node.name.text
            : null
      if (name) localTracked.set(name, origin)
    }
    ts.forEachChild(node, collectBindings)
  }
  collectBindings(sourceFile)

  const trackedCallName = (callee) => {
    const symbol = exportSymbol(callee)
    if (isTrackedExport(symbol)) return symbol.name
    if (ts.isIdentifier(callee) && localTracked.has(callee.text)) return localTracked.get(callee.text)
    return null
  }

  const visit = (node) => {
    if (!node) return
    const specifier =
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : null
    if (specifier && PERSISTENCE_FILE.test(specifier) && !allowed(IMPORT_ALLOWED, relative)) {
      failures.push(`${relative}: import workflow-persistence directly (must go through src/infra/state.ts)`)
    }
    if (!allowed(PATH_ALLOWED, relative) && ts.isIdentifier(node) && PATH_NAMES.has(node.text)) {
      failures.push(`${relative}: workflow state path may only be referenced in the persistence layer`)
    }
    if (ts.isCallExpression(node)) {
      const name = trackedCallName(node.expression)
      if (name && node.arguments.length < 2) {
        failures.push(`${relative}: ${name} called without expected-revision/lease argument (last-writer-wins)`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}

if (failures.length > 0) {
  console.error(`State-write gate failed:\n${failures.join('\n')}`)
  process.exitCode = 1
} else {
  console.log('State-write gate passed.')
}
