import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import ts from 'typescript'
import * as stateFacade from '../src/infra/state.ts'
import * as persistence from '../src/infra/workflow-persistence.ts'

function runGate(directory: string) {
  return spawnSync(process.execPath, [join('scripts', 'check-state-writes.mjs'), directory], { encoding: 'utf8' })
}

async function withFixtures(files: Record<string, string>, run: (directory: string) => void) {
  const directory = await mkdtemp(join(tmpdir(), 'state-write-gate-'))
  try {
    for (const [name, contents] of Object.entries(files)) {
      const file = join(directory, name)
      await mkdir(join(file, '..'), { recursive: true })
      await writeFile(file, contents, 'utf8')
    }
    run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const EXPECTED_STATE_EXPORTS = [
  'WorkflowConflictError',
  'appendEvent',
  'appendLog',
  'appendTaskLog',
  'applyDevRunOutcome',
  'archiveWorkflow',
  'clearStaleSessionId',
  'commitWorkflowMetadata',
  'findTaskHistory',
  'findWorkflowByIssue',
  'issueBodyHash',
  'issueKey',
  'loadAllArchivedWorkflows',
  'loadAllWorkflows',
  'loadWorkflow',
  'logPath',
  'readLogHistory',
  'readLogTail',
  'readTaskLog',
  'recordSessionId',
  'resetLog',
  'resolveSessionForAgent',
  'startTaskLog',
  'stateDir',
  'statePath',
  'workflowRevision',
]

const EXPECTED_PERSISTENCE_EXPORTS = [
  'WorkflowConflictError',
  'claimWorkflowTaskCommand',
  'commitWorkflowMetadataCommand',
  'currentWorkflowTaskRef',
  'mutateWorkflowTaskCommand',
  'stopWorkflowTaskCommand',
  'workflowRevision',
  'workflowStatePath',
]

function fullWorkflowFirstParameterExports(): string[] {
  const config = ts.readConfigFile(resolve('tsconfig.json'), ts.sys.readFile)
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve('.'))
  const program = ts.createProgram(parsed.fileNames, parsed.options)
  const checker = program.getTypeChecker()
  const state = program.getSourceFile(resolve('src/infra/state.ts'))
  if (!state) throw new Error('state facade source missing from TypeScript program')
  const stateSymbol = checker.getSymbolAtLocation(state)
  if (!stateSymbol) throw new Error('state facade module symbol missing')
  const issueWorkflowSymbol = checker.getExportsOfModule(stateSymbol).find((symbol) => symbol.name === 'IssueWorkflow')
  if (!issueWorkflowSymbol) throw new Error('IssueWorkflow export missing')
  const issueWorkflowType = checker.getDeclaredTypeOfSymbol(issueWorkflowSymbol)
  const metadataPatchAlias = checker
    .getExportsOfModule(stateSymbol)
    .find((symbol) => symbol.name === 'WorkflowMetadataPatch')
  if (!metadataPatchAlias) throw new Error('WorkflowMetadataPatch export missing')
  const metadataPatchSymbol =
    metadataPatchAlias.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(metadataPatchAlias) : metadataPatchAlias
  const metadataPatchType = checker.getDeclaredTypeOfSymbol(metadataPatchSymbol)
  assert.equal(
    checker.isTypeAssignableTo(issueWorkflowType, metadataPatchType),
    false,
    'a complete IssueWorkflow remains assignable to WorkflowMetadataPatch',
  )

  const unsafe: string[] = []
  for (const relative of ['src/infra/state.ts', 'src/infra/workflow-persistence.ts']) {
    const source = program.getSourceFile(resolve(relative))
    const moduleSymbol = source && checker.getSymbolAtLocation(source)
    if (!source || !moduleSymbol) throw new Error(`module symbol missing: ${relative}`)
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported
      const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0]
      if (!declaration) continue
      const type = checker.getTypeOfSymbolAtLocation(symbol, declaration)
      for (const signature of checker.getSignaturesOfType(type, ts.SignatureKind.Call)) {
        const first = signature.getParameters()[0]
        const firstDeclaration = first?.valueDeclaration ?? first?.declarations?.[0]
        if (!first || !firstDeclaration) continue
        const firstType = checker.getTypeOfSymbolAtLocation(first, firstDeclaration)
        if (
          checker.isTypeAssignableTo(firstType, issueWorkflowType) &&
          checker.isTypeAssignableTo(issueWorkflowType, firstType)
        ) {
          unsafe.push(`${relative}:${exported.name}`)
        }
      }
    }
  }
  return unsafe.sort()
}

test('workflow state modules expose only the frozen semantic surface', () => {
  assert.deepEqual(Object.keys(stateFacade).sort(), EXPECTED_STATE_EXPORTS)
  assert.deepEqual(Object.keys(persistence).sort(), EXPECTED_PERSISTENCE_EXPORTS)
  assert.deepEqual(fullWorkflowFirstParameterExports(), [])
})

test('tripwire rejects persistence imports outside semantic command owners and stray state paths', async () => {
  await withFixtures(
    {
      'src/workflow/direct.ts':
        "import { commitWorkflowMetadataCommand } from '../infra/workflow-persistence.ts'\nexport const x = commitWorkflowMetadataCommand",
      'src/infra/state-layout.ts': 'export function workflowPath(x: unknown): string { return String(x) }',
      'src/workflow/path.ts':
        "import { workflowPath } from '../infra/state-layout.ts'\nexport const p = (x: unknown) => workflowPath(x)",
    },
    (directory) => {
      const result = runGate(directory)
      assert.equal(result.status, 1, `expected failure, got:\n${result.stdout}${result.stderr}`)
      assert.match(result.stderr ?? '', /outside a semantic command owner/)
      assert.match(result.stderr ?? '', /workflow state path may only be referenced/)
    },
  )
})

test('tripwire confines each semantic command to its designated owner', async () => {
  await withFixtures(
    {
      'src/workflow/task-lease.ts':
        "import { stopWorkflowTaskCommand } from '../infra/workflow-persistence.ts'\nexport const x = stopWorkflowTaskCommand",
    },
    (directory) => {
      const result = runGate(directory)
      assert.equal(result.status, 1, `expected failure, got:\n${result.stdout}${result.stderr}`)
      assert.match(result.stderr ?? '', /stopWorkflowTaskCommand is outside this module's capability/)
    },
  )
})

test('tripwire passes the repository command owners', () => {
  const result = spawnSync(process.execPath, [join('scripts', 'check-state-writes.mjs')], { encoding: 'utf8' })
  assert.equal(result.status, 0, `expected pass, got:\n${result.stdout}${result.stderr}`)
})
