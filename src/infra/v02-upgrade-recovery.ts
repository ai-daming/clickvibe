/** Read-only recovery planning plus explicitly authorized resume/rollback. */
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { parseClickVibeConfigV1 } from './project-binding.ts'
import { ensurePlannedRepositoryId } from './repository-identity.ts'
import {
  durableRename,
  durableWriteExclusive,
  durableWriteReplace,
  ensureDurableDirectory,
  type V02UpgradeCheckpoint,
} from './v02-upgrade-durable.ts'
import {
  type V02UpgradeGenerationFence,
  type V02UpgradeJournal,
  verifyV02UpgradeCutover,
} from './v02-upgrade-execution.ts'
import { acquireV02UpgradeLock } from './v02-upgrade-lock.ts'
import { assertApprovedV02GenerationFence } from './v02-generation-fence.ts'
import { v02UpgradePlanFingerprint } from './v02-upgrade.ts'

interface RecoveryAsset {
  path: string
  status: 'absent' | 'file' | 'directory' | 'symlink' | 'other'
  device: number | null
  inode: number | null
  modifiedAt: string | null
  bytes: number
  sha256: string
  generation?: string
}

export interface V02UpgradeRecoveryPlan {
  upgradeVersion: 'clickvibe-v02-recovery-1'
  createdAt: string
  journal: { path: string; bytes: number; sha256: string; value: V02UpgradeJournal }
  assets: RecoveryAsset[]
}

export type V02UpgradeRecoveryPreview =
  | { status: 'recovery-previewed'; fingerprint: string; plan: V02UpgradeRecoveryPlan }
  | {
      status: 'recovery-blocked'
      error: string
      journal: { path: string; status: 'missing' | 'corrupt' | 'unknown-schema'; sha256?: string }
      decision: 'manual-recovery-required'
      assets: RecoveryAsset[]
    }

interface RecoveryOptions {
  plan: V02UpgradeRecoveryPlan
  fingerprint: string
  fence: V02UpgradeGenerationFence
  checkpoint?: V02UpgradeCheckpoint
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, entry]) => [key, canonical(entry)]),
    )
  }
  return value
}

function recoveryFingerprint(plan: V02UpgradeRecoveryPlan): string {
  return sha256(JSON.stringify(canonical(plan)))
}

async function directoryDigest(root: string): Promise<{ bytes: number; sha256: string }> {
  const entries: Array<{ path: string; bytes: number; sha256: string }> = []
  async function visit(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      compareText(a.name, b.name),
    )) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`recovery directory contains symlink: ${relative(root, path)}`)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) {
        const value = await readFile(path)
        entries.push({ path: relative(root, path), bytes: value.length, sha256: sha256(value) })
      } else throw new Error(`recovery directory contains unsupported entry: ${relative(root, path)}`)
    }
  }
  await visit(root)
  return { bytes: entries.reduce((total, entry) => total + entry.bytes, 0), sha256: sha256(JSON.stringify(entries)) }
}

async function observeAsset(path: string): Promise<RecoveryAsset> {
  try {
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) {
      return {
        path,
        status: 'symlink',
        device: metadata.dev,
        inode: metadata.ino,
        modifiedAt: metadata.mtime.toISOString(),
        bytes: metadata.size,
        sha256: '',
      }
    }
    if (metadata.isFile()) {
      const value = await readFile(path)
      return {
        path,
        status: 'file',
        device: metadata.dev,
        inode: metadata.ino,
        modifiedAt: metadata.mtime.toISOString(),
        bytes: value.length,
        sha256: sha256(value),
      }
    }
    if (metadata.isDirectory()) {
      const digest = await directoryDigest(path)
      let generation: string | undefined
      try {
        const marker = JSON.parse(await readFile(join(path, '.clickvibe-state.json'), 'utf8')) as {
          generation?: unknown
        }
        if (typeof marker.generation === 'string') generation = marker.generation
      } catch {
        // A legacy state directory has no generation marker.
      }
      return {
        path,
        status: 'directory',
        device: metadata.dev,
        inode: metadata.ino,
        modifiedAt: metadata.mtime.toISOString(),
        ...digest,
        ...(generation ? { generation } : {}),
      }
    }
    return {
      path,
      status: 'other',
      device: metadata.dev,
      inode: metadata.ino,
      modifiedAt: metadata.mtime.toISOString(),
      bytes: metadata.size,
      sha256: '',
    }
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path, status: 'absent', device: null, inode: null, modifiedAt: null, bytes: 0, sha256: sha256('absent') }
    }
    throw reason
  }
}

function recoveryPaths(journal: V02UpgradeJournal): string[] {
  const paths = journal.plan.paths
  return [
    paths.activeConfig,
    paths.configBackup,
    paths.stagedConfig,
    paths.activeState,
    paths.stateBackup,
    paths.stagedState,
  ]
}

async function candidateAssets(root: string): Promise<RecoveryAsset[]> {
  try {
    const names = (await readdir(root)).filter((name) => /^(?:config|state|upgrade-v0\.2)/.test(name)).sort(compareText)
    return Promise.all(names.map((name) => observeAsset(join(root, name))))
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw reason
  }
}

function parseJournal(raw: string): V02UpgradeJournal {
  const value = JSON.parse(raw) as V02UpgradeJournal
  if (value.schemaVersion !== 1 || !value.plan || typeof value.planFingerprint !== 'string') {
    throw new Error('upgrade journal schema is unknown')
  }
  if (v02UpgradePlanFingerprint(value.plan) !== value.planFingerprint)
    throw new Error('upgrade journal plan fingerprint is invalid')
  return value
}

export async function previewV02UpgradeRecovery(options: {
  home: string
  now?: string
}): Promise<V02UpgradeRecoveryPreview> {
  const root = join(resolve(options.home), '.clickvibe')
  const path = join(root, 'upgrade-v0.2.json')
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (reason) {
    const status = (reason as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'corrupt'
    return {
      status: 'recovery-blocked',
      error: errorMessage(reason),
      journal: { path, status },
      decision: 'manual-recovery-required',
      assets: await candidateAssets(root),
    }
  }
  let journal: V02UpgradeJournal
  try {
    journal = parseJournal(raw)
  } catch (reason) {
    return {
      status: 'recovery-blocked',
      error: errorMessage(reason),
      journal: {
        path,
        status: errorMessage(reason).includes('schema is unknown') ? 'unknown-schema' : 'corrupt',
        sha256: sha256(raw),
      },
      decision: 'manual-recovery-required',
      assets: await candidateAssets(root),
    }
  }
  const assets = await Promise.all(recoveryPaths(journal).map(observeAsset))
  const plan: V02UpgradeRecoveryPlan = {
    upgradeVersion: 'clickvibe-v02-recovery-1',
    createdAt: options.now ?? new Date().toISOString(),
    journal: { path, bytes: Buffer.byteLength(raw), sha256: sha256(raw), value: journal },
    assets,
  }
  return { status: 'recovery-previewed', fingerprint: recoveryFingerprint(plan), plan }
}

async function reobserve(plan: V02UpgradeRecoveryPlan): Promise<V02UpgradeRecoveryPreview> {
  return previewV02UpgradeRecovery({ home: dirname(dirname(plan.journal.path)), now: plan.createdAt })
}

async function publishJournal(journal: V02UpgradeJournal, checkpoint?: V02UpgradeCheckpoint): Promise<void> {
  journal.updatedAt = new Date().toISOString()
  await durableWriteReplace(journal.plan.paths.journal, `${JSON.stringify(journal, null, 2)}\n`, checkpoint)
}

async function fileHash(path: string): Promise<string | null> {
  try {
    return sha256(await readFile(path))
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw reason
  }
}

async function stateKind(path: string, journal: V02UpgradeJournal): Promise<'absent' | 'legacy' | 'v0.2' | 'unknown'> {
  const asset = await observeAsset(path)
  if (asset.status === 'absent') return 'absent'
  if (asset.status !== 'directory') return 'unknown'
  if (asset.generation === 'v0.2') {
    try {
      const marker = JSON.parse(await readFile(join(path, '.clickvibe-state.json'), 'utf8')) as {
        planFingerprint?: unknown
      }
      return marker.planFingerprint === journal.planFingerprint ? 'v0.2' : 'unknown'
    } catch {
      return 'unknown'
    }
  }
  return asset.sha256 === journal.plan.legacyState.sha256 ? 'legacy' : 'unknown'
}

async function ensurePrepared(journal: V02UpgradeJournal, checkpoint?: V02UpgradeCheckpoint): Promise<void> {
  const { plan } = journal
  const activeConfigHash = await fileHash(plan.paths.activeConfig)
  const backupHash = await fileHash(plan.paths.configBackup)
  if (backupHash === null) {
    if (activeConfigHash !== plan.legacyConfig.sha256) throw new Error('cannot reconstruct missing config backup')
    await durableWriteExclusive(plan.paths.configBackup, await readFile(plan.paths.activeConfig), checkpoint)
  } else if (backupHash !== plan.legacyConfig.sha256)
    throw new Error('config backup does not match the authorized legacy bytes')
  journal.actions.configBackup = 'verified'
  for (const binding of plan.bindings)
    await ensurePlannedRepositoryId(binding.repository.localPath, binding.repository.repositoryId)
  journal.actions.repositoryIds = 'verified'

  if (activeConfigHash !== plan.targetConfig.sha256) {
    const stagedHash = await fileHash(plan.paths.stagedConfig)
    if (stagedHash === null) await durableWriteExclusive(plan.paths.stagedConfig, plan.targetConfig.yaml, checkpoint)
    else if (stagedHash !== plan.targetConfig.sha256)
      throw new Error('staged config does not match the authorized target')
    parseClickVibeConfigV1(parseYaml(await readFile(plan.paths.stagedConfig, 'utf8')))
  }
  journal.actions.stagedConfig = 'verified'

  if ((await stateKind(plan.paths.activeState, journal)) !== 'v0.2') {
    const staged = await stateKind(plan.paths.stagedState, journal)
    if (staged === 'absent') {
      await ensureDurableDirectory(plan.paths.stagedState, checkpoint)
      await durableWriteExclusive(
        join(plan.paths.stagedState, '.clickvibe-state.json'),
        `${JSON.stringify({ schemaVersion: 1, generation: 'v0.2', planFingerprint: journal.planFingerprint, createdAt: plan.createdAt })}\n`,
        checkpoint,
      )
    } else if (staged !== 'v0.2') throw new Error('staged state is not the authorized v0.2 generation')
  }
  journal.actions.stagedState = 'verified'
  journal.phase = 'prepared'
  await publishJournal(journal, checkpoint)
}

async function resumeCutover(journal: V02UpgradeJournal, checkpoint?: V02UpgradeCheckpoint): Promise<void> {
  const { plan } = journal
  const activeState = await stateKind(plan.paths.activeState, journal)
  const backupState = await stateKind(plan.paths.stateBackup, journal)
  if (journal.initialState === 'present') {
    if (activeState === 'legacy' && backupState === 'absent') {
      journal.actions.stateBackup = 'intent'
      await publishJournal(journal, checkpoint)
      await durableRename(plan.paths.activeState, plan.paths.stateBackup, checkpoint)
      journal.actions.stateBackup = 'verified'
    } else if (!(['absent', 'v0.2'] as const).includes(activeState as 'absent' | 'v0.2') || backupState !== 'legacy') {
      throw new Error(`cannot resume state cutover from active=${activeState}, backup=${backupState}`)
    }
  } else journal.actions.stateBackup = 'initially-absent'
  if ((await stateKind(plan.paths.activeState, journal)) === 'absent') {
    journal.actions.stateActivation = 'intent'
    await publishJournal(journal, checkpoint)
    await durableRename(plan.paths.stagedState, plan.paths.activeState, checkpoint)
  }
  if ((await stateKind(plan.paths.activeState, journal)) !== 'v0.2') throw new Error('v0.2 state activation failed')
  journal.actions.stateActivation = 'verified'
  await publishJournal(journal, checkpoint)

  const activeConfigHash = await fileHash(plan.paths.activeConfig)
  if (activeConfigHash === plan.legacyConfig.sha256) {
    journal.actions.configActivation = 'intent'
    await publishJournal(journal, checkpoint)
    await durableRename(plan.paths.stagedConfig, plan.paths.activeConfig, checkpoint)
  } else if (activeConfigHash !== plan.targetConfig.sha256)
    throw new Error('active config is neither authorized generation')
  journal.actions.configActivation = 'verified'
  await verifyV02UpgradeCutover(journal)
  journal.phase = 'verified'
  await checkpoint?.('before-terminal-journal:verified')
  await publishJournal(journal, checkpoint)
  await checkpoint?.('after-terminal-journal:verified')
}

async function withRecoveryOwnership<T extends { status: string }>(
  options: RecoveryOptions,
  execute: (journal: V02UpgradeJournal) => Promise<T>,
): Promise<T | { status: 'facts-changed' } | { status: 'failed'; error: string }> {
  if (recoveryFingerprint(options.plan) !== options.fingerprint)
    throw new Error('recovery authorization fingerprint is invalid')
  assertApprovedV02GenerationFence(options.fence)
  const lock = await acquireV02UpgradeLock(
    options.plan.journal.value.plan.paths.lock,
    options.fingerprint,
    options.checkpoint,
  )
  let fence: Awaited<ReturnType<V02UpgradeGenerationFence['acquire']>> | undefined
  let outcome: 'verified' | 'facts-changed' | 'failed' | 'rolled-back' = 'failed'
  try {
    fence = await options.fence.acquire(options.fingerprint)
    const observed = await reobserve(options.plan)
    if (
      fence.activity.liveTasks.length > 0 ||
      fence.activity.liveJobs.length > 0 ||
      fence.activity.oldPluginProcesses.length > 0 ||
      observed.status !== 'recovery-previewed' ||
      observed.fingerprint !== options.fingerprint
    ) {
      outcome = 'facts-changed'
      return { status: 'facts-changed' }
    }
    const result = await execute(structuredClone(options.plan.journal.value))
    outcome = result.status === 'verified' ? 'verified' : 'rolled-back'
    return result
  } catch (reason) {
    return { status: 'failed', error: errorMessage(reason) }
  } finally {
    if (fence) await fence.release(outcome)
    await lock.release()
  }
}

export function resumeV02Upgrade(options: RecoveryOptions) {
  return withRecoveryOwnership(options, async (journal) => {
    if (journal.phase === 'rolled_back') {
      throw new Error('cannot resume rolled_back journal; start a new upgrade preview and authorization')
    }
    if (journal.phase === 'verified') throw new Error('cannot resume verified terminal journal')
    if (!['preparing', 'prepared', 'cutting-over', 'failed'].includes(journal.phase)) {
      throw new Error(`cannot resume journal from phase ${journal.phase}`)
    }
    await ensurePrepared(journal, options.checkpoint)
    await resumeCutover(journal, options.checkpoint)
    return { status: 'verified' as const, journal }
  })
}

export function rollbackV02Upgrade(options: RecoveryOptions) {
  return withRecoveryOwnership(options, async (journal) => {
    const { plan } = journal
    const active = await stateKind(plan.paths.activeState, journal)
    if (journal.initialState === 'present') {
      if (active === 'v0.2') {
        if ((await stateKind(plan.paths.stagedState, journal)) !== 'absent')
          throw new Error('cannot quarantine v0.2 state over existing staging')
        await durableRename(plan.paths.activeState, plan.paths.stagedState, options.checkpoint)
      } else if (active !== 'absent' && active !== 'legacy')
        throw new Error(`cannot rollback unknown active state (${active})`)
      if ((await stateKind(plan.paths.activeState, journal)) === 'absent') {
        if ((await stateKind(plan.paths.stateBackup, journal)) !== 'legacy')
          throw new Error('legacy cold backup is unavailable')
        await durableRename(plan.paths.stateBackup, plan.paths.activeState, options.checkpoint)
      }
    } else if (active === 'v0.2') {
      if ((await stateKind(plan.paths.stagedState, journal)) !== 'absent')
        throw new Error('cannot quarantine v0.2 state over existing staging')
      await durableRename(plan.paths.activeState, plan.paths.stagedState, options.checkpoint)
    } else if (active !== 'absent') throw new Error(`cannot restore initially absent state from ${active}`)
    if ((await fileHash(plan.paths.configBackup)) !== plan.legacyConfig.sha256)
      throw new Error('legacy config backup is unavailable')
    await durableWriteReplace(plan.paths.activeConfig, await readFile(plan.paths.configBackup), options.checkpoint)
    if ((await fileHash(plan.paths.activeConfig)) !== plan.legacyConfig.sha256)
      throw new Error('legacy config restore failed')
    journal.phase = 'rolled_back'
    await options.checkpoint?.('before-terminal-journal:rolled_back')
    await publishJournal(journal, options.checkpoint)
    await options.checkpoint?.('after-terminal-journal:rolled_back')
    return { status: 'rolled-back' as const, journal }
  })
}
