import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createV02GenerationFence, resetV02GenerationFenceForTest } from '../src/infra/v02-generation-fence.ts'
import { durableRename, durableWriteExclusive, ensureDurableDirectory } from '../src/infra/v02-upgrade-durable.ts'
import { type V02UpgradeGenerationFence } from '../src/infra/v02-upgrade-execution.ts'
import { acquireV02UpgradeLock } from '../src/infra/v02-upgrade-lock.ts'
import { previewV02UpgradeRecovery, rollbackV02Upgrade } from '../src/infra/v02-upgrade-recovery.ts'

function integratedFence(
  observeHostActivity: () => Promise<{
    liveTasks: string[]
    liveJobs: string[]
    oldPluginProcesses: string[]
  }> = async () => ({ liveTasks: [], liveJobs: [], oldPluginProcesses: [] }),
) {
  return createV02GenerationFence({
    acquireLegacyEntryBlock: async () => {},
    confirmLegacyEntryDisabled: async () => true,
    settleLegacyEntryBlock: async () => {},
    observeHostActivity,
    enumerateOldPluginProcesses: async () => [],
    waitForExitMs: 20,
    pollIntervalMs: 1,
  })
}

test('durable primitives reject collisions and clean an interrupted temporary publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-v02-durable-'))
  const firstDirectory = join(root, 'first')
  const secondDirectory = join(root, 'second')
  try {
    await ensureDurableDirectory(firstDirectory)
    await ensureDurableDirectory(firstDirectory)
    await ensureDurableDirectory(secondDirectory)
    const destination = join(firstDirectory, 'value')
    await durableWriteExclusive(destination, 'complete')
    await assert.rejects(durableWriteExclusive(destination, 'replacement'), { code: 'EEXIST' })
    const interrupted = join(firstDirectory, 'interrupted')
    await assert.rejects(
      durableWriteExclusive(interrupted, 'partial', (checkpoint) => {
        if (checkpoint.startsWith('after-file-write:')) throw new Error('injected write interruption')
      }),
      /injected write interruption/,
    )
    assert.equal(
      (await readdir(firstDirectory)).some((name) => name.includes('interrupted')),
      false,
    )
    const moved = join(secondDirectory, 'value')
    await durableRename(destination, moved)
    assert.equal(await readFile(moved, 'utf8'), 'complete')
    await writeFile(join(root, 'not-a-directory'), 'x')
    await assert.rejects(ensureDurableDirectory(join(root, 'not-a-directory')), /expected real directory/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('generation fence rejects a competing holder and resets if host observation fails', async () => {
  resetV02GenerationFenceForTest()
  const held = await integratedFence().acquire('first')
  await assert.rejects(integratedFence().acquire('second'), /cannot acquire/)
  await held.release('facts-changed')
  await assert.rejects(
    integratedFence(async () => {
      throw new Error('host observation unavailable')
    }).acquire('third'),
    /host observation unavailable/,
  )
  const recovered = await integratedFence().acquire('fourth')
  await recovered.release('facts-changed')
  resetV02GenerationFenceForTest()
})

test('upgrade lock rejects malformed ownership and conservatively reclaims a proven dead owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-v02-stale-lock-'))
  const path = join(root, 'upgrade-v0.2.lock')
  try {
    await writeFile(path, '{}')
    await assert.rejects(acquireV02UpgradeLock(path, 'plan'), /invalid owner record/)
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        token: 'live-owner-with-different-locale',
        pid: process.pid,
        processStart: 'locale-dependent-mismatch',
        acquiredAt: '2026-08-27T00:00:00.000Z',
        planFingerprint: 'old-plan',
      }),
    )
    await assert.rejects(acquireV02UpgradeLock(path, 'plan'), /already locked/)
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        token: 'dead-owner',
        pid: 2_147_483_647,
        processStart: 'never',
        acquiredAt: '2026-08-27T00:00:00.000Z',
        planFingerprint: 'old-plan',
      }),
    )
    const recovered = await acquireV02UpgradeLock(path, 'new-plan')
    await recovered.release()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('corrupt recovery journal inventories every candidate and changed evidence invalidates authorization', async () => {
  const home = await mkdtemp(join(tmpdir(), 'clickvibe-v02-corrupt-recovery-'))
  const root = join(home, '.clickvibe')
  try {
    await mkdir(join(root, 'state'), { recursive: true })
    await writeFile(join(root, 'config.yaml'), 'repos: {}\n')
    await writeFile(join(root, 'config-v0.1-backup-evidence.yaml'), 'legacy\n')
    await writeFile(join(root, 'upgrade-v0.2.json'), '{broken')
    const corrupt = await previewV02UpgradeRecovery({ home })
    assert.equal(corrupt.status, 'recovery-blocked')
    assert.equal(corrupt.journal.status, 'corrupt')
    assert.equal(corrupt.decision, 'manual-recovery-required')
    assert.deepEqual(
      corrupt.assets.map((asset) => asset.path.split('/').at(-1)),
      ['config-v0.1-backup-evidence.yaml', 'config.yaml', 'state', 'upgrade-v0.2.json'],
    )

    const journal = {
      schemaVersion: 1,
      phase: 'rolled_back',
      planFingerprint: 'invalid-until-parsed',
      plan: {},
    }
    await writeFile(join(root, 'upgrade-v0.2.json'), JSON.stringify(journal))
    const invalid = await previewV02UpgradeRecovery({ home })
    assert.equal(invalid.status, 'recovery-blocked')

    await rm(join(root, 'upgrade-v0.2.json'))
    const missing = await previewV02UpgradeRecovery({ home })
    assert.equal(missing.status, 'recovery-blocked')
    assert.equal(missing.journal.status, 'missing')
    assert.equal(missing.decision, 'manual-recovery-required')
    assert.match(missing.assets.map((asset) => asset.path).join('\n'), /config-v0\.1-backup/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('recovery authorization fingerprint is checked before any lock or fence mutation', async () => {
  let acquired = false
  const fence: V02UpgradeGenerationFence = {
    async acquire() {
      acquired = true
      throw new Error('must not acquire')
    },
  }
  await assert.rejects(
    rollbackV02Upgrade({
      plan: {
        upgradeVersion: 'clickvibe-v02-recovery-1',
        createdAt: '2026-08-27T00:00:00.000Z',
        journal: {
          path: '/invalid',
          bytes: 0,
          sha256: '',
          value: {} as never,
        },
        assets: [],
      },
      fingerprint: 'wrong',
      fence,
    }),
    /recovery authorization fingerprint is invalid/,
  )
  assert.equal(acquired, false)
})
