import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  assertLegacyStateWriteAllowed,
  assertLegacyTaskStartAllowed,
  createV02GenerationFence,
  enumerateLegacyClickVibeProcesses,
  resetV02GenerationFenceForTest,
} from '../src/infra/v02-generation-fence.ts'

const idleActivity = { liveTasks: [] as string[], liveJobs: [] as string[], oldPluginProcesses: [] as string[] }

function integratedFence(
  overrides: {
    legacyEntryDisabled?: boolean
    observeHostActivity?: () => Promise<typeof idleActivity>
    enumerateOldPluginProcesses?: () => Promise<string[]>
  } = {},
) {
  return createV02GenerationFence({
    acquireLegacyEntryBlock: async () => {},
    confirmLegacyEntryDisabled: async () => overrides.legacyEntryDisabled ?? true,
    settleLegacyEntryBlock: async () => {},
    observeHostActivity: overrides.observeHostActivity ?? (async () => idleActivity),
    enumerateOldPluginProcesses: overrides.enumerateOldPluginProcesses ?? (async () => []),
    waitForExitMs: 20,
    pollIntervalMs: 1,
  })
}

test('generation fence linearizes new legacy starts and remains closed after verified cutover', async () => {
  resetV02GenerationFenceForTest()
  const fence = integratedFence()
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
    const held = await integratedFence().acquire('sha256:plan')
    await held.release(outcome)
    assert.doesNotThrow(() => assertLegacyTaskStartAllowed())
  }
})

test('online fence refuses when the host cannot prove the legacy entry is disabled', async () => {
  resetV02GenerationFenceForTest()
  await assert.rejects(integratedFence({ legacyEntryDisabled: false }).acquire('sha256:plan'), /offline upgrade/)
  assert.doesNotThrow(() => assertLegacyTaskStartAllowed())
})

test('process enumeration finds a real legacy ClickVibe process and fence waits fail closed', async () => {
  resetV02GenerationFenceForTest()
  const child = spawn(
    process.execPath,
    ['-e', "console.log('READY'); setInterval(() => {}, 1000)", 'clickvibe-v0.1-plugin'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  try {
    await once(child.stdout, 'data')
    const observed = await enumerateLegacyClickVibeProcesses()
    assert.equal(
      observed.some((entry) => entry.includes(String(child.pid))),
      true,
      JSON.stringify(observed),
    )
    await assert.rejects(
      integratedFence({ enumerateOldPluginProcesses: enumerateLegacyClickVibeProcesses }).acquire('sha256:plan'),
      /old ClickVibe processes.*still active/,
    )
  } finally {
    child.kill()
    if (child.exitCode === null) await once(child, 'exit')
    resetV02GenerationFenceForTest()
  }
})

test('legacy startup migration cannot scan or move files after a v0.2 marker takes ownership', async () => {
  const home = await mkdtemp(join(tmpdir(), 'clickvibe-v02-legacy-migration-'))
  const root = join(home, '.clickvibe')
  const state = join(root, 'state')
  const legacy = join(state, 'legacy.json')
  const moduleUrl = new URL('../src/infra/state.ts', import.meta.url).href
  try {
    await mkdir(state, { recursive: true })
    await writeFile(legacy, '{}\n')
    await writeFile(join(state, '.clickvibe-state.json'), '{"schemaVersion":1,"generation":"v0.2"}\n')
    const script = `
      import { loadAllWorkflows } from ${JSON.stringify(moduleUrl)};
      try { await loadAllWorkflows(); console.log('ALLOWED') }
      catch (error) { console.log('BLOCKED:' + error.message) }
    `
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8')
    })
    const [code] = (await once(child, 'exit')) as [number]
    assert.equal(code, 0)
    assert.match(output, /BLOCKED:.*v0\.2 state/)
    assert.equal(await readFile(legacy, 'utf8'), '{}\n')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
