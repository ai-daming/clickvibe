import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

/**
 * Negative fixtures for the state-write boundary gate: every case here MUST
 * fail `scripts/check-state-writes.mjs`. The gate is only a gate if the
 * bypasses it claims to catch (aliasing, rebinding, nested arguments,
 * direct persistence imports, stray path references) actually turn it red.
 */

function runGate(directory: string) {
  return spawnSync(process.execPath, [join('scripts', 'check-state-writes.mjs'), directory], {
    encoding: 'utf8',
  })
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

test('gate fails on a bare single-argument saveWorkflow call', async () => {
  await withFixtures(
    {
      'src/infra/state.ts': 'export async function saveWorkflow(w: unknown, r?: number) { void w; void r }',
      'src/workflow/bad.ts': [
        "import { saveWorkflow } from '../infra/state.ts'",
        'export async function f(w: unknown) { await saveWorkflow(w) }',
      ].join('\n'),
    },
    (directory) => {
      const result = runGate(directory)
      assert.equal(result.status, 1, `expected failure, got:\n${result.stdout}${result.stderr}`)
      assert.match(result.stderr ?? '', /saveWorkflow called without/)
    },
  )
})

test('gate fails on aliased imports and const rebinding', async () => {
  await withFixtures(
    {
      'src/infra/state.ts': 'export async function saveWorkflow(w: unknown, r?: number) { void w; void r }',
      'src/workflow/alias.ts': [
        "import { saveWorkflow as persist } from '../infra/state.ts'",
        'export async function f(w: unknown) { await persist(w) }',
      ].join('\n'),
      'src/workflow/rebind.ts': [
        "import { saveWorkflow } from '../infra/state.ts'",
        'const write = saveWorkflow',
        'export async function f(w: unknown) { await write(w) }',
      ].join('\n'),
    },
    (directory) => {
      const result = runGate(directory)
      assert.equal(result.status, 1, `expected failure, got:\n${result.stdout}${result.stderr}`)
      // Messages carry the original export name; the file path names the offender.
      assert.match(result.stderr ?? '', /alias\.ts: saveWorkflow called without/)
      assert.match(result.stderr ?? '', /rebind\.ts: saveWorkflow called without/)
    },
  )
})

test('gate fails on namespace-property rebinding, destructuring and reassignment', async () => {
  await withFixtures(
    {
      'src/infra/state.ts': 'export async function saveWorkflow(w: unknown, r?: number) { void w; void r }',
      'src/workflow/ns-rebind.ts': [
        "import * as state from '../infra/state.ts'",
        'const write = state.saveWorkflow',
        'export async function f(w: unknown) { await write(w) }',
      ].join('\n'),
      'src/workflow/destructure.ts': [
        "import * as st from '../infra/state.ts'",
        'const { saveWorkflow: d } = st',
        'export async function f(w: unknown) { await d(w) }',
      ].join('\n'),
      'src/workflow/reassign.ts': [
        "import { saveWorkflow } from '../infra/state.ts'",
        'let h: typeof saveWorkflow = async () => {}',
        'h = saveWorkflow',
        'export async function f(w: unknown) { await h(w) }',
      ].join('\n'),
    },
    (directory) => {
      const result = runGate(directory)
      assert.equal(result.status, 1, `expected failure, got:\n${result.stdout}${result.stderr}`)
      const stderr = result.stderr ?? ''
      for (const file of ['ns-rebind', 'destructure', 'reassign']) {
        assert.match(stderr, new RegExp(`${file}.ts: saveWorkflow called without`), `expected ${file} to be tracked`)
      }
    },
  )
})

test('gate fails on nested single-argument calls and namespace imports', async () => {
  await withFixtures(
    {
      'src/infra/state.ts': 'export async function saveWorkflow(w: unknown, r?: number) { void w; void r }',
      'src/workflow/nested.ts': [
        "import { saveWorkflow } from '../infra/state.ts'",
        'export async function f(w: unknown) { await saveWorkflow(structuredClone(w)) }',
      ].join('\n'),
      'src/workflow/namespace.ts': [
        "import * as state from '../infra/state.ts'",
        'export async function f(w: unknown) { await state.saveWorkflow(w) }',
      ].join('\n'),
    },
    (directory) => {
      const result = runGate(directory)
      assert.equal(result.status, 1, `expected failure, got:\n${result.stdout}${result.stderr}`)
      assert.equal(((result.stderr ?? '').match(/saveWorkflow called without/g) ?? []).length, 2)
    },
  )
})

test('gate fails on direct persistence imports and stray path references', async () => {
  await withFixtures(
    {
      'src/workflow/direct.ts': "import { saveWorkflowStateForTask } from '../infra/workflow-persistence.ts'",
      'src/infra/state-layout.ts': 'export function workflowPath(x: unknown): string { return String(x) }',
      'src/workflow/path.ts':
        "import { workflowPath } from '../infra/state-layout.ts'\nexport const p = (x: unknown) => workflowPath(x as never)",
    },
    (directory) => {
      const result = runGate(directory)
      assert.equal(result.status, 1, `expected failure, got:\n${result.stdout}${result.stderr}`)
      const stderr = result.stderr ?? ''
      assert.match(stderr, /import workflow-persistence directly/)
      assert.match(stderr, /workflow state path may only be referenced/)
    },
  )
})

test('gate confines claim, callback mutation and stop to their capability owners', async () => {
  await withFixtures(
    {
      'src/infra/state.ts': [
        'export async function claimWorkflowTask(...x: unknown[]) { void x }',
        'export async function mutateWorkflowForTask(...x: unknown[]) { void x }',
        'export async function stopWorkflowTask(...x: unknown[]) { void x }',
      ].join('\n'),
      'src/workflow/bypass.ts': [
        "import { claimWorkflowTask, mutateWorkflowForTask, stopWorkflowTask } from '../infra/state.ts'",
        'export async function f(w: unknown, token: unknown) {',
        '  await claimWorkflowTask(w, token)',
        '  await mutateWorkflowForTask(w, token)',
        '  await stopWorkflowTask(w, token)',
        '}',
      ].join('\n'),
    },
    (directory) => {
      const result = runGate(directory)
      assert.equal(result.status, 1, `expected failure, got:\n${result.stdout}${result.stderr}`)
      for (const name of ['claimWorkflowTask', 'mutateWorkflowForTask', 'stopWorkflowTask']) {
        assert.match(result.stderr ?? '', new RegExp(`${name} may only be called by its capability owner`))
      }
    },
  )
})

test('gate passes on conditional calls and whitelisted persistence modules', async () => {
  await withFixtures(
    {
      'src/workflow/good.ts': [
        "import { saveWorkflow, workflowRevision } from '../infra/state.ts'",
        'export async function f(w: unknown, r: number) { await saveWorkflow(w, r ?? workflowRevision(w as never)) }',
      ].join('\n'),
      'src/infra/state.ts': "export { saveWorkflowState as saveWorkflow } from './workflow-persistence.ts'",
      'src/infra/workflow-persistence.ts':
        "import { workflowPath } from './state-layout.ts'\nexport const p = workflowPath",
    },
    (directory) => {
      const result = runGate(directory)
      assert.equal(result.status, 0, `expected pass, got:\n${result.stdout}${result.stderr}`)
    },
  )
})
