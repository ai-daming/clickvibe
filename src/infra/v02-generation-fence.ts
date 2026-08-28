/** Process-generation fence shared by legacy task starts and the v0.2 upgrader. */
import { execFile } from 'node:child_process'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { V02UpgradeGenerationFence, V02UpgradeOutcome } from './v02-upgrade-execution.ts'
import type { V02UpgradeHostActivity } from './v02-upgrade.ts'

const execFileAsync = promisify(execFile)

interface FenceState {
  mode: 'legacy-open' | 'upgrade-held' | 'v0.2-active'
  token: symbol | null
}

const fenceSymbol = Symbol.for('clickvibe.v02-generation-fence')
const shared = globalThis as typeof globalThis & { [fenceSymbol]?: FenceState }
const fenceState = shared[fenceSymbol] ?? { mode: 'legacy-open', token: null }
if (!shared[fenceSymbol]) shared[fenceSymbol] = fenceState

export class V02GenerationViolationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'V02GenerationViolationError'
  }
}

export function isV02GenerationViolation(reason: unknown): reason is V02GenerationViolationError {
  return reason instanceof V02GenerationViolationError
}

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
  if (fenceState.mode !== 'legacy-open')
    throw new V02GenerationViolationError('legacy state write blocked by the v0.2 generation fence')
  const phase = journalPhase(clickvibeRootForState(stateRoot))
  if (phase !== null && phase !== 'rolled_back') {
    throw new V02GenerationViolationError(`legacy state write blocked by v0.2 recovery journal (${phase})`)
  }
  if (hasV02Marker(stateRoot)) throw new V02GenerationViolationError('legacy state write blocked by active v0.2 state')
}

/** Synchronous start boundary: no task can slip between fence acquisition and host observation. */
export function assertLegacyTaskStartAllowed(): void {
  if (fenceState.mode === 'upgrade-held')
    throw new V02GenerationViolationError('legacy task start blocked by the v0.2 generation fence')
  if (fenceState.mode === 'v0.2-active')
    throw new V02GenerationViolationError('legacy task start blocked by the active v0.2 generation')
  assertLegacyStateWriteAllowed(join(homedir(), '.clickvibe', 'state'))
}

/**
 * Enumerate independently running legacy plugin processes. The host confirmation
 * below remains mandatory because an embedding host may hide plugin identity from
 * argv; this OS observation is a second, independent safety signal.
 */
export async function enumerateLegacyClickVibeProcesses(): Promise<string[]> {
  const result = await execFileAsync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
  const legacy = /(?:clickvibe-v0\.1-plugin|(?:^|[\s/])clickvibe\/(?:lib|src)\/index\.(?:js|ts)(?:\s|$))/i
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/)
      if (!match || Number(match[1]) === process.pid) return false
      return legacy.test(match[3])
    })
    .sort()
}

export interface V02GenerationFenceIntegration {
  /** Host-owned linearization point that blocks every legacy plugin/task entry. */
  acquireLegacyEntryBlock(): Promise<void>
  /** Independent proof that the acquired host block still owns every entry. */
  confirmLegacyEntryDisabled(): Promise<boolean>
  /** Reopen legacy entries on abort, or finalize their replacement on success. */
  settleLegacyEntryBlock(outcome: V02UpgradeOutcome): Promise<void>
  /** Host-owned live task/job observation after its start entry is closed. */
  observeHostActivity(): Promise<V02UpgradeHostActivity>
  /** Injectable only so tests can deterministically exercise the OS observer. */
  enumerateOldPluginProcesses?: () => Promise<string[]>
  waitForExitMs?: number
  pollIntervalMs?: number
}

function hasActivity(activity: V02UpgradeHostActivity): boolean {
  return activity.liveTasks.length > 0 || activity.liveJobs.length > 0 || activity.oldPluginProcesses.length > 0
}

async function waitForQuiescence(options: V02GenerationFenceIntegration): Promise<V02UpgradeHostActivity> {
  const enumerate = options.enumerateOldPluginProcesses ?? enumerateLegacyClickVibeProcesses
  const deadline = Date.now() + (options.waitForExitMs ?? 5_000)
  const interval = options.pollIntervalMs ?? 25
  let last: V02UpgradeHostActivity = { liveTasks: [], liveJobs: [], oldPluginProcesses: [] }
  while (true) {
    const [host, processes] = await Promise.all([options.observeHostActivity(), enumerate()])
    last = {
      liveTasks: [...new Set(host.liveTasks)].sort(),
      liveJobs: [...new Set(host.liveJobs)].sort(),
      oldPluginProcesses: [...new Set([...host.oldPluginProcesses, ...processes])].sort(),
    }
    if (!hasActivity(last)) return last
    if (Date.now() >= deadline) {
      throw new Error(
        `generation fence cannot prove quiescence; live tasks=${last.liveTasks.length}, live jobs=${last.liveJobs.length}, old ClickVibe processes=${last.oldPluginProcesses.length} still active`,
      )
    }
    await new Promise<void>((resolve) => setTimeout(resolve, interval))
  }
}

export function createV02GenerationFence(options: V02GenerationFenceIntegration): V02UpgradeGenerationFence {
  return {
    async acquire() {
      if (fenceState.mode !== 'legacy-open') throw new Error(`cannot acquire generation fence from ${fenceState.mode}`)
      const token = Symbol('v0.2-upgrade')
      fenceState.mode = 'upgrade-held'
      fenceState.token = token
      let hostBlockAcquired = false
      try {
        await options.acquireLegacyEntryBlock()
        hostBlockAcquired = true
        if (!(await options.confirmLegacyEntryDisabled())) {
          throw new Error('host cannot disable every legacy entry; close the host and use the offline upgrade entry')
        }
        const activity = await waitForQuiescence(options)
        if (!(await options.confirmLegacyEntryDisabled())) {
          throw new Error('legacy entry reopened during fence acquisition; use the offline upgrade entry')
        }
        let released = false
        return {
          activity,
          async release(outcome: V02UpgradeOutcome) {
            if (released) return
            if (fenceState.token !== token || fenceState.mode !== 'upgrade-held') {
              throw new Error('v0.2 generation fence ownership changed before release')
            }
            await options.settleLegacyEntryBlock(outcome)
            fenceState.mode = outcome === 'verified' ? 'v0.2-active' : 'legacy-open'
            fenceState.token = null
            released = true
          },
        }
      } catch (reason) {
        if (hostBlockAcquired) {
          try {
            await options.settleLegacyEntryBlock('failed')
          } catch (settleReason) {
            throw new AggregateError(
              [reason, settleReason],
              'generation fence acquisition and host-block release failed',
            )
          }
        }
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
