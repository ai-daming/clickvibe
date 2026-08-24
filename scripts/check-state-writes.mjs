import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import ts from 'typescript'

// Workflow-state persistence tripwire. The capability boundary is structural:
// raw mutators are private to workflow-persistence.ts, while its exported
// commands are admitted only to the semantic owners below. This script guards
// those module boundaries and state-path ownership; it deliberately does not
// claim to prove arbitrary JavaScript value-flow properties.

const PERSISTENCE_FILE = /workflow-persistence\.ts$/
const PATH_NAMES = new Set(['workflowPath', 'workflowStatePath'])
const PATH_ALLOWED = new Set(['src/infra/workflow-persistence.ts', 'src/infra/state-layout.ts', 'src/infra/state.ts'])
const PERSISTENCE_IMPORTS = new Map([
  [
    'src/infra/state.ts',
    new Set(['WorkflowConflictError', 'commitWorkflowCommand', 'workflowRevision', 'workflowStatePath']),
  ],
  [
    'src/infra/task-ownership.ts',
    new Set(['currentWorkflowTaskRef', 'WorkflowTaskCredential', 'WorkflowTaskExpectation']),
  ],
  ['src/workflow/task-claim.ts', new Set(['claimWorkflowTaskCommand'])],
  ['src/workflow/task-lease.ts', new Set(['mutateWorkflowTaskCommand', 'WorkflowTaskCommitResult'])],
  ['src/workflow/task-api.ts', new Set(['stopWorkflowTaskCommand'])],
])

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

function normalized(file) {
  return path.relative(process.cwd(), file).split(path.sep).join('/')
}

function allowedNames(relative) {
  for (const [file, names] of PERSISTENCE_IMPORTS) {
    if (relative === file || relative.endsWith(`/${file}`)) return names
  }
  return null
}

function importedNames(node) {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause
    if (!clause) return []
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) return ['*']
    return clause.namedBindings && ts.isNamedImports(clause.namedBindings)
      ? clause.namedBindings.elements.map((element) => element.propertyName?.text ?? element.name.text)
      : []
  }
  if (!node.exportClause) return ['*']
  return ts.isNamedExports(node.exportClause)
    ? node.exportClause.elements.map((element) => element.propertyName?.text ?? element.name.text)
    : ['*']
}

const roots = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['src']
const files = []
for (const root of roots) files.push(...(await collect(path.resolve(process.cwd(), root))))

const failures = []
for (const file of files) {
  const relative = normalized(file)
  const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const visit = (node) => {
    const specifier =
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : null
    if (specifier && PERSISTENCE_FILE.test(specifier)) {
      const permitted = allowedNames(relative)
      if (!permitted) {
        failures.push(`${relative}: import workflow-persistence directly outside a semantic command owner`)
      } else {
        for (const name of importedNames(node)) {
          const typeOnlyWildcard =
            name === '*' &&
            ((ts.isExportDeclaration(node) && node.isTypeOnly) ||
              (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly))
          if ((name === '*' && !typeOnlyWildcard) || (name !== '*' && !permitted.has(name))) {
            failures.push(`${relative}: workflow-persistence export ${name} is outside this module's capability`)
          }
        }
      }
    }
    if (![...PATH_ALLOWED].some((item) => relative === item || relative.endsWith(`/${item}`))) {
      if (ts.isIdentifier(node) && PATH_NAMES.has(node.text)) {
        failures.push(`${relative}: workflow state path may only be referenced in the persistence layer`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}

if (failures.length > 0) {
  console.error(`State-write tripwire failed:\n${failures.join('\n')}`)
  process.exitCode = 1
} else {
  console.log('State-write tripwire passed.')
}
