import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
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

test('raw workflow mutators are absent from the public module surface', () => {
  const rawNames = [
    'saveWorkflow',
    'saveWorkflowForTask',
    'claimWorkflowTask',
    'mutateWorkflowForTask',
    'stopWorkflowTask',
    'saveWorkflowState',
    'saveWorkflowStateForTask',
    'claimWorkflowTaskState',
    'mutateWorkflowStateForTask',
    'stopWorkflowTaskState',
  ]
  for (const name of rawNames) {
    assert.equal(name in stateFacade, false, `${name} leaked from the state facade`)
    assert.equal(name in persistence, false, `${name} leaked from the persistence module`)
  }
})

test('tripwire rejects persistence imports outside semantic command owners and stray state paths', async () => {
  await withFixtures(
    {
      'src/workflow/direct.ts':
        "import { commitWorkflowCommand } from '../infra/workflow-persistence.ts'\nexport const x = commitWorkflowCommand",
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
