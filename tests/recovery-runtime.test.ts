import { fingerprintWorkItemContract } from '../src/workflow/work-item-contract.ts'
import assert from 'node:assert/strict'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { v02Home } from './helpers/v02-home.ts'
import { loadConfigFromHome } from '../src/infra/runtime.ts'
import { recoveryStateRoot } from '../src/infra/recovery-layout.ts'
import { previewRecoveryUpgrade, applyRecoveryUpgrade, resumeRecoveryUpgrade } from '../src/infra/recovery-upgrade.ts'
import {
  assertActiveStateWriteAllowed,
  createOfflineV02GenerationFence,
  V02_OFFLINE_HOST_DECLARATION,
  resetV02GenerationFenceForTest,
} from '../src/infra/v02-generation-fence.ts'
const baselineSha = '1a2ea2f02f17bd8df67f878141ac49321a9dbaa8'
test('new runtime requires a verified isolated root and never accepts the old schema for actions', async () => {
  const { home } = await v02Home(['fixture/runtime'])
  try {
    await assert.rejects(loadConfigFromHome(home), /recovery|升级/)
    assert.throws(() => assertActiveStateWriteAllowed(recoveryStateRoot(home)), /recovery|state/)
    const plan = await previewRecoveryUpgrade({ home, baselineSha, fingerprintOf: fingerprintWorkItemContract })
    await applyRecoveryUpgrade({
      plan,
      fingerprint: plan.fingerprint,
      fingerprintOf: fingerprintWorkItemContract,
      fence: createOfflineV02GenerationFence({
        declaration: V02_OFFLINE_HOST_DECLARATION,
        enumerateOldPluginProcesses: async () => [],
      }),
    })
    const config = await loadConfigFromHome(home)
    assert.equal(config.schemaVersion, 2)
    assert.ok(config.repos['fixture/runtime'])
    assertActiveStateWriteAllowed(recoveryStateRoot(home))
    const marker = join(recoveryStateRoot(home), '.clickvibe-state.json')
    const original = await readFile(marker, 'utf8')
    await writeFile(marker, '{"schemaVersion":999}')
    assert.throws(() => assertActiveStateWriteAllowed(recoveryStateRoot(home)), /recovery|marker/)
    await assert.rejects(
      resumeRecoveryUpgrade({
        home,
        fingerprint: plan.fingerprint,
        fingerprintOf: fingerprintWorkItemContract,
        fence: createOfflineV02GenerationFence({
          declaration: V02_OFFLINE_HOST_DECLARATION,
          enumerateOldPluginProcesses: async () => [],
        }),
      }),
      /recovery/,
    )

    await writeFile(marker, original)
    await writeFile(join(home, '.clickvibe', 'upgrade-recovery-1.json'), '{}')
    await assert.rejects(loadConfigFromHome(home), /recovery|journal/)
  } finally {
    resetV02GenerationFenceForTest()
    await rm(home, { recursive: true, force: true })
  }
})
