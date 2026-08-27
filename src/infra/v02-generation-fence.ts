/** Process-generation fence shared by legacy task starts and the v0.2 upgrader. */
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { V02UpgradeGenerationFence, V02UpgradeOutcome } from './v02-upgrade-execution.ts'
import type { V02UpgradeHostActivity } from './v02-upgrade.ts'

interface FenceState {
  mode: 'legacy-open' | 'upgrade-held' | 'v0.2-active'
  token: symbol | null
}

const fenceSymbol = Symbol.for('clickvibe.v02-generation-fence')
const shared = globalThis as typeof globalThis & { [fenceSymbol]?: FenceState }
const fenceState = shared[fenceSymbol] ?? { mode: 'legacy-open', token: null }
if (!shared[fenceSymbol]) shared[fenceSymbol] = fenceState

function clickvibeRootForState(stateRoot: string): string {
  return dirname(stateRoot)
}

function journalPhase(root: string): string | null {
  const path = join(root, 'upgrade-v0.2.json')
  if (!existsSync(path)) return null
  try {
    const metadata = lstatSync(path)
    if (!metadata.isFile() || metadata.isSymbolicLink()) return 'unknown'
    const value = JSON.parse(readFileSync(path, 'utf8')) as { schemaVersion?: unknown; phase?: unknown }
    return value.schemaVersion === 1 && typeof value.phase === 'string' ? value.phase : 'unknown'
  } catch {
    return 'unknown'
  }
}

function hasV02Marker(stateRoot: string): boolean {
  const path = join(stateRoot, '.clickvibe-state.json')
  if (!existsSync(path)) return false
  try {
    const metadata = lstatSync(path)
    if (!metadata.isFile() || metadata.isSymbolicLink()) return true
    const value = JSON.parse(readFileSync(path, 'utf8')) as { schemaVersion?: unknown; generation?: unknown }
    return value.schemaVersion === 1 && value.generation === 'v0.2'
  } catch {
    return true
  }
}

/** Reject every legacy writer once an upgrade journal or v0.2 marker owns the state root. */
export function assertLegacyStateWriteAllowed(stateRoot: string): void {
  if (fenceState.mode !== 'legacy-open') throw new Error('legacy state write blocked by the v0.2 generation fence')
  const phase = journalPhase(clickvibeRootForState(stateRoot))
  if (phase !== null && phase !== 'rolled_back') {
    throw new Error(`legacy state write blocked by v0.2 recovery journal (${phase})`)
  }
  if (hasV02Marker(stateRoot)) throw new Error('legacy state write blocked by active v0.2 state')
}

/** Synchronous start boundary: no task can slip between fence acquisition and host observation. */
export function assertLegacyTaskStartAllowed(): void {
  if (fenceState.mode === 'upgrade-held') throw new Error('legacy task start blocked by the v0.2 generation fence')
  if (fenceState.mode === 'v0.2-active') throw new Error('legacy task start blocked by the active v0.2 generation')
  assertLegacyStateWriteAllowed(join(homedir(), '.clickvibe', 'state'))
}

export function createV02GenerationFence(observe: () => Promise<V02UpgradeHostActivity>): V02UpgradeGenerationFence {
  return {
    async acquire() {
      if (fenceState.mode !== 'legacy-open') throw new Error(`cannot acquire generation fence from ${fenceState.mode}`)
      const token = Symbol('v0.2-upgrade')
      fenceState.mode = 'upgrade-held'
      fenceState.token = token
      try {
        const activity = await observe()
        let released = false
        return {
          activity,
          async release(outcome: V02UpgradeOutcome) {
            if (released) return
            if (fenceState.token !== token || fenceState.mode !== 'upgrade-held') {
              throw new Error('v0.2 generation fence ownership changed before release')
            }
            fenceState.mode = outcome === 'verified' ? 'v0.2-active' : 'legacy-open'
            fenceState.token = null
            released = true
          },
        }
      } catch (reason) {
        if (fenceState.token === token) {
          fenceState.mode = 'legacy-open'
          fenceState.token = null
        }
        throw reason
      }
    },
  }
}

/** Test-only reset for the process-global fence singleton. */
export function resetV02GenerationFenceForTest(): void {
  fenceState.mode = 'legacy-open'
  fenceState.token = null
}
