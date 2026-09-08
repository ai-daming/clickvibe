import { fingerprintWorkItemContract } from '../../src/workflow/work-item-contract.ts'
/** Activate test homes through the same two offline upgrade machines as a real deployment. */
import { rm } from 'node:fs/promises'
import {
  createOfflineV02GenerationFence,
  resetV02GenerationFenceForTest,
  V02_OFFLINE_HOST_DECLARATION,
} from '../../src/infra/v02-generation-fence.ts'
import { previewRecoveryUpgrade, applyRecoveryUpgrade } from '../../src/infra/recovery-upgrade.ts'
import { activateV02Home, v02Home, type ActivateV02HomeOptions } from './v02-home.ts'
const baselineSha = '1a2ea2f02f17bd8df67f878141ac49321a9dbaa8'
export async function finishRecoveryHome(home: string): Promise<void> {
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
  resetV02GenerationFenceForTest()
}
export async function activateRecoveryHome(
  home: string,
  repos: Record<string, string>,
  options: ActivateV02HomeOptions = {},
): Promise<void> {
  await activateV02Home(home, repos, { ...options, deleteAfterActivation: [] })
  await finishRecoveryHome(home)
  for (const path of options.deleteAfterActivation ?? []) await rm(path, { recursive: true, force: true })
}
export async function recoveryHome(keys: string[], options: ActivateV02HomeOptions = {}) {
  const result = await v02Home(keys, { ...options, deleteAfterActivation: [] })
  await finishRecoveryHome(result.home)
  for (const path of options.deleteAfterActivation ?? []) await rm(path, { recursive: true, force: true })
  return result
}
