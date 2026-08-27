import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  assertLegacyStateWriteAllowed,
  assertLegacyTaskStartAllowed,
  createV02GenerationFence,
  resetV02GenerationFenceForTest,
} from '../src/infra/v02-generation-fence.ts'

test('generation fence linearizes new legacy starts and remains closed after verified cutover', async () => {
  resetV02GenerationFenceForTest()
  const fence = createV02GenerationFence(async () => ({ liveTasks: [], liveJobs: [], oldPluginProcesses: [] }))
  const held = await fence.acquire('sha256:plan')
  assert.throws(() => assertLegacyTaskStartAllowed(), /generation fence/)
  await held.release('verified')
  assert.throws(() => assertLegacyTaskStartAllowed(), /v0\.2 generation/)
  resetV02GenerationFenceForTest()
})

test('legacy state writers fail closed for active v0.2 state and unfinished or corrupt journals', async () => {
  const home = await mkdtemp(join(tmpdir(), 'clickvibe-v02-generation-'))
  const root = join(home, '.clickvibe')
  const state = join(root, 'state')
  try {
    await mkdir(state, { recursive: true })
    assert.doesNotThrow(() => assertLegacyStateWriteAllowed(state))
    await writeFile(join(root, 'upgrade-v0.2.json'), '{broken')
    assert.throws(() => assertLegacyStateWriteAllowed(state), /recovery journal/)
    await writeFile(join(root, 'upgrade-v0.2.json'), JSON.stringify({ schemaVersion: 1, phase: 'rolled_back' }))
    assert.doesNotThrow(() => assertLegacyStateWriteAllowed(state))
    await writeFile(join(state, '.clickvibe-state.json'), JSON.stringify({ schemaVersion: 1, generation: 'v0.2' }))
    assert.throws(() => assertLegacyStateWriteAllowed(state), /v0\.2 state/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('facts-changed and failed-before-journal release reopen the in-process start gate', async () => {
  for (const outcome of ['facts-changed', 'failed'] as const) {
    resetV02GenerationFenceForTest()
    const held = await createV02GenerationFence(async () => ({
      liveTasks: [],
      liveJobs: [],
      oldPluginProcesses: [],
    })).acquire('sha256:plan')
    await held.release(outcome)
    assert.doesNotThrow(() => assertLegacyTaskStartAllowed())
  }
})
