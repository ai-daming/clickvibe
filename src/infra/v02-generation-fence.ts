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

const approvedFences = new WeakSet<V02UpgradeGenerationFence>()
const disabledOnlineFences = new WeakSet<V02UpgradeGenerationFence>()

function approveFence(fence: V02UpgradeGenerationFence): V02UpgradeGenerationFence {
  approvedFences.add(fence)
  return fence
}

/** Reject caller-built no-op fences before the upgrader creates its lock candidate. */
export function assertApprovedV02GenerationFence(fence: V02UpgradeGenerationFence): void {
  if (!approvedFences.has(fence)) {
    throw new Error('v0.2 apply requires a generation fence from an approved generation fence factory')
  }
  if (disabledOnlineFences.has(fence)) {
    throw new Error('online v0.2 apply is disabled until DSH host integration registers a real generation capability')
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

/**
 * Admit current-format runtime writers exactly when the state root has one
 * consistent owner (ADR-0009 D1/D6, protocol §1): a verified journal plus the
 * v0.2 marker owns the root for the v0.2 runtime; a rolled-back or journal-free
 * root without a marker keeps pre-upgrade semantics. An in-progress upgrade,
 * any partial/torn journal phase, or journal/marker drift stays fail-closed.
 */
export function assertActiveStateWriteAllowed(stateRoot: string): void {
  if (fenceState.mode === 'upgrade-held')
    throw new V02GenerationViolationError('state write blocked: v0.2 upgrade holds the generation fence')
  if (fenceState.mode === 'v0.2-active') return
  const phase = journalPhase(clickvibeRootForState(stateRoot))
  const marker = hasV02Marker(stateRoot)
  if (phase === null || phase === 'rolled_back') {
    if (marker) throw new V02GenerationViolationError('state write blocked: v0.2 marker without a completed upgrade')
    return
  }
  if (phase === 'verified') {
    if (!marker)
      throw new V02GenerationViolationError('state write blocked: verified journal without the v0.2 state marker')
    return
  }
  throw new V02GenerationViolationError(`state write blocked by v0.2 recovery journal (${phase})`)
}

/** Synchronous start boundary: no task can slip between fence acquisition and host observation. */
export function assertLegacyTaskStartAllowed(): void {
  if (fenceState.mode === 'upgrade-held')
    throw new V02GenerationViolationError('legacy task start blocked by the v0.2 generation fence')
  if (fenceState.mode === 'v0.2-active')
    throw new V02GenerationViolationError('legacy task start blocked by the active v0.2 generation')
  assertActiveStateWriteAllowed(join(homedir(), '.clickvibe', 'state'))
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

export const V02_OFFLINE_HOST_DECLARATION = 'host-stopped-and-restart-disabled' as const

export interface V02OfflineGenerationFenceOptions {
  /** Explicit operator assertion that the embedding DSH host is stopped and cannot restart during apply. */
  declaration: typeof V02_OFFLINE_HOST_DECLARATION
  /** Secondary observation for standalone legacy processes whose argv exposes ClickVibe. */
  enumerateOldPluginProcesses?: () => Promise<string[]>
  waitForExitMs?: number
  pollIntervalMs?: number
}

function hasActivity(activity: V02UpgradeHostActivity): boolean {
  return activity.liveTasks.length > 0 || activity.liveJobs.length > 0 || activity.oldPluginProcesses.length > 0
}

async function waitForOfflineQuiescence(options: V02OfflineGenerationFenceOptions): Promise<V02UpgradeHostActivity> {
  const enumerate = options.enumerateOldPluginProcesses ?? enumerateLegacyClickVibeProcesses
  const deadline = Date.now() + (options.waitForExitMs ?? 5_000)
  const interval = options.pollIntervalMs ?? 25
  let last: V02UpgradeHostActivity = { liveTasks: [], liveJobs: [], oldPluginProcesses: [] }
  while (true) {
    const processes = await enumerate()
    last = {
      liveTasks: [],
      liveJobs: [],
      oldPluginProcesses: [...new Set(processes)].sort(),
    }
    if (!hasActivity(last)) return last
    if (Date.now() >= deadline) {
      throw new Error(
        `generation fence cannot prove offline quiescence; old ClickVibe processes=${last.oldPluginProcesses.length} still active`,
      )
    }
    await new Promise<void>((resolve) => setTimeout(resolve, interval))
  }
}

/** Online apply has no product factory until the DSH host owns a real entry-block capability. */
export function createOnlineV02GenerationFence(): V02UpgradeGenerationFence {
  const fence = approveFence({
    async acquire() {
      throw new Error('online v0.2 apply is disabled until DSH host integration registers a real generation capability')
    },
  })
  disabledOnlineFences.add(fence)
  return fence
}

/**
 * Offline apply is the only executable Slice 2 path. The declaration covers the
 * in-process-plugin shape that cannot be proven from argv; OS enumeration remains
 * a secondary guard for independently running legacy binaries.
 */
export function createOfflineV02GenerationFence(options: V02OfflineGenerationFenceOptions): V02UpgradeGenerationFence {
  if (options.declaration !== V02_OFFLINE_HOST_DECLARATION) {
    throw new Error('offline v0.2 apply requires an explicit declaration that the DSH host is stopped')
  }
  return approveFence({
    async acquire() {
      if (fenceState.mode !== 'legacy-open') throw new Error(`cannot acquire generation fence from ${fenceState.mode}`)
      const token = Symbol('v0.2-upgrade')
      fenceState.mode = 'upgrade-held'
      fenceState.token = token
      try {
        const activity = await waitForOfflineQuiescence(options)
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
  })
}

/** Test-only reset for the process-global fence singleton. */
export function resetV02GenerationFenceForTest(): void {
  fenceState.mode = 'legacy-open'
  fenceState.token = null
}
