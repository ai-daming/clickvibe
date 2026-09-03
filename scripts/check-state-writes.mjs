import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import ts from 'typescript'

// Workflow-state persistence tripwire. The capability boundary is structural:
// raw mutators are private to workflow-persistence.ts, while its exported
// commands are admitted only to the semantic owners below. This script guards
// those module boundaries and state-path ownership; it deliberately does not
// claim to prove arbitrary JavaScript value-flow properties.

// Per-state-class write tripwires (ADR-0013 §1). The capability boundary stays
// structural: quoted path literals and path-resolver identifiers may appear
// only in each class's owner modules, and module imports are admitted per file
// with a closed name set. Like the persistence rules above, this deliberately
// does not claim to prove arbitrary JavaScript value-flow properties.

const CONTRACT_STORE_FILE = /work-item-contract-store\.ts$/
const CONTRACT_STORE_IMPORTS = new Map([
  [
    'src/workflow/work-item-contract-repository.ts',
    new Set([
      'createRawArtifactRef',
      'publishWorkItemContractCapture',
      'readCurrentWorkItemContract',
      'WorkItemContractPublication',
      'WorkItemContractRead',
    ]),
  ],
])
const CONTRACT_PATH_ALLOWED = new Set(['src/infra/work-item-contract-store.ts'])
const CONTRACT_PATH_NAMES = new Set(['workItemContractPaths'])
const CONTRACT_PATH_LITERALS = ["'current.json'", '"current.json"']

const DIAGNOSTICS_FILE = /diagnostic-log-store\.ts$/
const DIAGNOSTICS_IMPORTS = new Map([
  ['src/infra/diagnostic-record.ts', new Set(['appendDiagnosticLine'])],
  [
    'src/infra/remote-git-evidence.ts',
    new Set(['appendDiagnosticLine', 'DEFAULT_DIAGNOSTIC_MAX_BYTES', 'waitForDiagnosticLines']),
  ],
  [
    'src/infra/task-diagnostics.ts',
    new Set(['appendDiagnosticLine', 'DEFAULT_DIAGNOSTIC_MAX_BYTES', 'waitForDiagnosticLines']),
  ],
  [
    'src/github/gateway-evidence.ts',
    new Set(['appendDiagnosticLine', 'DEFAULT_DIAGNOSTIC_MAX_BYTES', 'waitForDiagnosticLines']),
  ],
  ['src/workflow/work-item-contract-repository.ts', new Set(['DEFAULT_DIAGNOSTIC_MAX_BYTES'])],
])
const DIAGNOSTICS_PATH_ALLOWED = new Set([
  'src/infra/state-layout.ts',
  'src/infra/diagnostic-log-store.ts',
  'src/infra/diagnostic-record.ts',
])
const DIAGNOSTICS_PATH_NAMES = new Set(['diagnosticLogPath'])

const CONFIG_PATH_LITERAL = /['"](?:config\.yaml|\.clickvibe-state\.json)['"]/
const WRITE_PRIMITIVE = /\b(?:writeFile|appendFile|rename|rm|unlink|link|symlink|cp|mkdir|truncate)\s*\(/
/** May reference the quoted config/marker literals at all. */
const CONFIG_LITERAL_ALLOWED = (relative) =>
  /v02-upgrade[^/]*\.ts$/.test(relative) ||
  ['src/infra/runtime.ts', 'src/infra/project-config.ts', 'src/infra/v02-generation-fence.ts'].some(
    (item) => relative === item || relative.endsWith(`/${item}`),
  )
/** May additionally contain fs write primitives while referencing them; every entry needs a reason and a removal ticket. */
const CONFIG_WRITE_ALLOWLIST = new Map([
  [
    'src/infra/project-config.ts',
    'v0.1 repos read-modify-write writer; disposition table row A2 marks it 废弃 and its removal PR deletes this entry',
  ],
])

function allowedEntry(relative, table) {
  for (const [file, value] of table) {
    if (relative === file || relative.endsWith(`/${file}`)) return value
  }
  return null
}

function inAllowed(relative, set) {
  return [...set].some((item) => relative === item || relative.endsWith(`/${item}`))
}
const PERSISTENCE_FILE = /workflow-persistence\.ts$/
const PATH_NAMES = new Set(['workflowPath', 'workflowStatePath'])
const PATH_ALLOWED = new Set(['src/infra/workflow-persistence.ts', 'src/infra/state-layout.ts', 'src/infra/state.ts'])
const PERSISTENCE_IMPORTS = new Map([
  [
    'src/infra/state.ts',
    new Set([
      'WorkflowConflictError',
      'WorkflowMetadataPatch',
      'commitWorkflowMetadataCommand',
      'workflowRevision',
      'workflowStatePath',
    ]),
  ],
  [
    'src/infra/task-ownership.ts',
    new Set(['currentWorkflowTaskRef', 'WorkflowTaskCredential', 'WorkflowTaskExpectation']),
  ],
  ['src/workflow/task-claim.ts', new Set(['claimWorkflowTaskCommand'])],
  ['src/workflow/task-lease.ts', new Set(['mutateWorkflowTaskCommand', 'WorkflowTaskCommitResult'])],
  ['src/workflow/task-api.ts', new Set(['stopWorkflowTaskCommand'])],
  ['src/infra/baseline-restore-git.ts', new Set(['withBaselineRestoreWorkflowLocksCommand'])],
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
    if (specifier && CONTRACT_STORE_FILE.test(specifier)) {
      const permitted = allowedEntry(relative, CONTRACT_STORE_IMPORTS)
      if (!permitted) {
        failures.push(`${relative}: imports work-item-contract-store outside the capture repository`)
      } else {
        for (const name of importedNames(node)) {
          if (name === '*' || !permitted.has(name)) {
            failures.push(`${relative}: work-item-contract-store export ${name} is outside this module's capability`)
          }
        }
      }
    }
    if (specifier && DIAGNOSTICS_FILE.test(specifier)) {
      const permitted = allowedEntry(relative, DIAGNOSTICS_IMPORTS)
      if (!permitted) {
        failures.push(`${relative}: imports the diagnostics log store outside an admitted writer caller`)
      } else {
        for (const name of importedNames(node)) {
          if (name === '*' || !permitted.has(name)) {
            failures.push(`${relative}: diagnostics log store export ${name} is outside this caller's admitted names`)
          }
        }
      }
    }
    if (!inAllowed(relative, CONTRACT_PATH_ALLOWED)) {
      if (ts.isIdentifier(node) && CONTRACT_PATH_NAMES.has(node.text)) {
        failures.push(`${relative}: work-item-contract capture path may only be constructed in the contract store`)
      }
      for (const literal of CONTRACT_PATH_LITERALS) {
        if (ts.isStringLiteral(node) && node.text === literal.slice(1, -1)) {
          failures.push(`${relative}: work-item-contract capture path may only be constructed in the contract store`)
        }
      }
    }
    if (!inAllowed(relative, DIAGNOSTICS_PATH_ALLOWED)) {
      if (ts.isIdentifier(node) && DIAGNOSTICS_PATH_NAMES.has(node.text)) {
        failures.push(`${relative}: diagnostics path may only be resolved in the diagnostics write layer`)
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

  // Config and state-marker literals: file-level co-occurrence with fs write
  // primitives. Readers without write primitives stay admitted; only the
  // upgrade machine (plus explicitly ticketed temporary writers) may write.
  if (CONFIG_PATH_LITERAL.test(source.text)) {
    if (!CONFIG_LITERAL_ALLOWED(relative) && !allowedEntry(relative, CONFIG_WRITE_ALLOWLIST)) {
      failures.push(
        `${relative}: quoted config/state-marker literals belong to the upgrade machine or admitted readers`,
      )
    }
    const isUpgradeModule = /(^|\/)v02-upgrade[^/]*\.ts$/.test(relative)
    if (!isUpgradeModule && !allowedEntry(relative, CONFIG_WRITE_ALLOWLIST) && WRITE_PRIMITIVE.test(source.text)) {
      failures.push(`${relative}: active config/state-marker writes belong to the v0.2 upgrade machine`)
    }
  }
}

if (failures.length > 0) {
  console.error(`State-write tripwire failed:\n${failures.join('\n')}`)
  process.exitCode = 1
} else {
  console.log('State-write tripwire passed.')
}
