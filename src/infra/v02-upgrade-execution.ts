/** Authorized execution of the explicit v0.1 -> v0.2 upgrade transaction. */
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { parseClickVibeConfigV1 } from './project-binding.ts'
import { ensurePlannedRepositoryId, readRepositoryId } from './repository-identity.ts'
import {
  durableRename,
  durableWriteExclusive,
  durableWriteReplace,
  ensureDurableDirectory,
  type V02UpgradeCheckpoint,
} from './v02-upgrade-durable.ts'
import { acquireV02UpgradeLock, type V02UpgradeLockOwner } from './v02-upgrade-lock.ts'
import {
  previewV02Upgrade,
  inventoryV02StateDirectory,
  v02UpgradePlanFingerprint,
  type V02UpgradeHostActivity,
  type V02UpgradePlan,
  type V02UpgradePreview,
} from './v02-upgrade.ts'

export type V02UpgradeOutcome = 'verified' | 'facts-changed' | 'failed' | 'rolled-back'

export interface V02UpgradeGenerationFence {
  acquire(planFingerprint: string): Promise<{
    activity: V02UpgradeHostActivity
    release(outcome: V02UpgradeOutcome): Promise<void>
  }>
}

export interface V02UpgradeJournal {
  schemaVersion: 1
  phase: 'preparing' | 'prepared' | 'cutting-over' | 'verified' | 'failed' | 'rolled_back'
  planFingerprint: string
  plan: V02UpgradePlan
  lockOwner: V02UpgradeLockOwner
  initialState: 'present' | 'absent'
  actions: {
    configBackup: 'pending' | 'verified'
    repositoryIds: 'pending' | 'verified'
    stagedConfig: 'pending' | 'verified'
    stagedState: 'pending' | 'verified'
    stateBackup: 'pending' | 'intent' | 'verified' | 'initially-absent'
    stateActivation: 'pending' | 'intent' | 'verified'
    configActivation: 'pending' | 'intent' | 'verified'
  }
  errors: Array<{ at: string; action: string; message: string }>
  updatedAt: string
}

export type V02UpgradeApplyResult =
  | { status: 'verified'; journal: V02UpgradeJournal }
  | { status: 'facts-changed'; preview: V02UpgradePreview }
  | { status: 'failed'; error: string; journal?: V02UpgradeJournal }

export interface ApplyV02UpgradeOptions {
  plan: V02UpgradePlan
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

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw reason
  }
}

function choicesFromPlan(plan: V02UpgradePlan) {
  const primaryRemotes: Record<string, string> = {}
  const proposedRepositoryIds: Record<string, string> = {}
  for (const worktree of plan.worktrees) {
    const binding = plan.bindings.find((item) => item.repository.localPath === worktree.repositoryPath)
    if (!binding) throw new Error(`authorized plan has no binding for ${worktree.repoKey}`)
    primaryRemotes[worktree.repoKey] = binding.repository.primaryRemote
    proposedRepositoryIds[worktree.repoKey] = binding.repository.repositoryId
  }
  const exclusions = Object.fromEntries(plan.exclusions.map((item) => [item.repoKey, item.reason]))
  return { primaryRemotes, proposedRepositoryIds, exclusions }
}

async function observeAuthorizedFacts(
  plan: V02UpgradePlan,
  hostActivity: V02UpgradeHostActivity,
): Promise<V02UpgradePreview> {
  const choices = choicesFromPlan(plan)
  return previewV02Upgrade({
    home: dirname(plan.paths.root),
    baselineSha: plan.baselineSha,
    now: plan.createdAt,
    nonce: plan.nonce,
    proposedRepositoryIds: choices.proposedRepositoryIds,
    choices: { primaryRemotes: choices.primaryRemotes, exclusions: choices.exclusions },
    hostActivity,
  })
}

function initialJournal(plan: V02UpgradePlan, fingerprint: string, lockOwner: V02UpgradeLockOwner): V02UpgradeJournal {
  if (plan.legacyState.status === 'error') throw new Error('cannot execute a plan with unreadable legacy state')
  return {
    schemaVersion: 1,
    phase: 'preparing',
    planFingerprint: fingerprint,
    plan,
    lockOwner,
    initialState: plan.legacyState.status,
    actions: {
      configBackup: 'pending',
      repositoryIds: 'pending',
      stagedConfig: 'pending',
      stagedState: 'pending',
      stateBackup: 'pending',
      stateActivation: 'pending',
      configActivation: 'pending',
    },
    errors: [],
    updatedAt: new Date().toISOString(),
  }
}

async function publishJournal(
  journal: V02UpgradeJournal,
  exclusive: boolean,
  callback?: V02UpgradeCheckpoint,
): Promise<void> {
  journal.updatedAt = new Date().toISOString()
  const raw = `${JSON.stringify(journal, null, 2)}\n`
  if (exclusive) await durableWriteExclusive(journal.plan.paths.journal, raw, callback)
  else await durableWriteReplace(journal.plan.paths.journal, raw, callback)
}

async function prepareAssets(journal: V02UpgradeJournal, callback?: V02UpgradeCheckpoint): Promise<void> {
  const { plan } = journal
  const configBytes = await readFile(plan.paths.activeConfig)
  if (configBytes.length !== plan.legacyConfig.bytes || sha256(configBytes) !== plan.legacyConfig.sha256) {
    throw new Error('legacy config changed after authorization')
  }
  await durableWriteExclusive(plan.paths.configBackup, configBytes, callback)
  if (sha256(await readFile(plan.paths.configBackup)) !== plan.legacyConfig.sha256) {
    throw new Error('config backup read-back verification failed')
  }
  journal.actions.configBackup = 'verified'
  await publishJournal(journal, false, callback)

  for (const binding of plan.bindings) {
    await ensurePlannedRepositoryId(binding.repository.localPath, binding.repository.repositoryId)
  }
  journal.actions.repositoryIds = 'verified'
  await publishJournal(journal, false, callback)

  await durableWriteExclusive(plan.paths.stagedConfig, plan.targetConfig.yaml, callback)
  const stagedConfig = await readFile(plan.paths.stagedConfig, 'utf8')
  parseClickVibeConfigV1(parseYaml(stagedConfig))
  if (sha256(stagedConfig) !== plan.targetConfig.sha256) throw new Error('staged config read-back verification failed')
  journal.actions.stagedConfig = 'verified'
  await publishJournal(journal, false, callback)

  await ensureDurableDirectory(plan.paths.stagedState, callback)
  const marker = {
    schemaVersion: 1,
    generation: 'v0.2',
    planFingerprint: journal.planFingerprint,
    createdAt: plan.createdAt,
  }
  await durableWriteExclusive(
    join(plan.paths.stagedState, '.clickvibe-state.json'),
    `${JSON.stringify(marker)}\n`,
    callback,
  )
  journal.actions.stagedState = 'verified'
  journal.phase = 'prepared'
  await publishJournal(journal, false, callback)
}

async function cutOver(journal: V02UpgradeJournal, callback?: V02UpgradeCheckpoint): Promise<void> {
  const { plan } = journal
  journal.phase = 'cutting-over'
  if (journal.initialState === 'present') {
    journal.actions.stateBackup = 'intent'
    await publishJournal(journal, false, callback)
    await durableRename(plan.paths.activeState, plan.paths.stateBackup, callback)
    journal.actions.stateBackup = 'verified'
    await publishJournal(journal, false, callback)
  } else {
    journal.actions.stateBackup = 'initially-absent'
    await publishJournal(journal, false, callback)
  }

  journal.actions.stateActivation = 'intent'
  await publishJournal(journal, false, callback)
  await durableRename(plan.paths.stagedState, plan.paths.activeState, callback)
  journal.actions.stateActivation = 'verified'
  await publishJournal(journal, false, callback)

  journal.actions.configActivation = 'intent'
  await publishJournal(journal, false, callback)
  await durableRename(plan.paths.stagedConfig, plan.paths.activeConfig, callback)
  journal.actions.configActivation = 'verified'
  await publishJournal(journal, false, callback)
}

export async function verifyV02UpgradeCutover(journal: V02UpgradeJournal): Promise<void> {
  const { plan } = journal
  const activeConfig = await readFile(plan.paths.activeConfig, 'utf8')
  parseClickVibeConfigV1(parseYaml(activeConfig))
  if (sha256(activeConfig) !== plan.targetConfig.sha256)
    throw new Error('active config does not match the authorized plan')
  if (sha256(await readFile(plan.paths.configBackup)) !== plan.legacyConfig.sha256) {
    throw new Error('config backup no longer matches the legacy config')
  }
  if (journal.initialState === 'present') {
    const backup = await inventoryV02StateDirectory(plan.paths.stateBackup)
    if (
      backup.status !== 'present' ||
      backup.sha256 !== plan.legacyState.sha256 ||
      backup.fileCount !== plan.legacyState.fileCount ||
      backup.byteCount !== plan.legacyState.byteCount ||
      backup.device !== plan.legacyState.device ||
      backup.inode !== plan.legacyState.inode
    ) {
      throw new Error('legacy state backup no longer matches the authorized legacy state')
    }
  } else if (await exists(plan.paths.stateBackup)) {
    throw new Error('legacy state backup was fabricated although the source was initially absent')
  }
  const marker = JSON.parse(await readFile(join(plan.paths.activeState, '.clickvibe-state.json'), 'utf8')) as {
    schemaVersion?: unknown
    generation?: unknown
    planFingerprint?: unknown
  }
  if (
    marker.schemaVersion !== 1 ||
    marker.generation !== 'v0.2' ||
    marker.planFingerprint !== journal.planFingerprint
  ) {
    throw new Error('active state marker does not match the authorized plan')
  }
  for (const binding of plan.bindings) {
    if ((await readRepositoryId(binding.repository.localPath)) !== binding.repository.repositoryId) {
      throw new Error(`repositoryId read-back mismatch for ${binding.repository.localPath}`)
    }
  }
}

export async function applyV02Upgrade(options: ApplyV02UpgradeOptions): Promise<V02UpgradeApplyResult> {
  const expectedFingerprint = v02UpgradePlanFingerprint(options.plan)
  if (options.fingerprint !== expectedFingerprint)
    throw new Error('authorization fingerprint does not match the supplied plan')
  const lock = await acquireV02UpgradeLock(options.plan.paths.lock, options.fingerprint, options.checkpoint)
  let fence: Awaited<ReturnType<V02UpgradeGenerationFence['acquire']>> | undefined
  let journal: V02UpgradeJournal | undefined
  let journalPublished = false
  let outcome: V02UpgradeOutcome = 'failed'
  let result: V02UpgradeApplyResult
  try {
    fence = await options.fence.acquire(options.fingerprint)
    const observed = await observeAuthorizedFacts(options.plan, fence.activity)
    if (observed.status !== 'previewed' || observed.fingerprint !== options.fingerprint) {
      outcome = 'facts-changed'
      result = { status: 'facts-changed', preview: observed }
    } else {
      journal = initialJournal(options.plan, options.fingerprint, lock.owner)
      await publishJournal(journal, options.plan.expectedJournal === 'absent', options.checkpoint)
      journalPublished = true
      await prepareAssets(journal, options.checkpoint)
      await cutOver(journal, options.checkpoint)
      await verifyV02UpgradeCutover(journal)
      journal.phase = 'verified'
      await options.checkpoint?.('before-terminal-journal:verified')
      await publishJournal(journal, false, options.checkpoint)
      await options.checkpoint?.('after-terminal-journal:verified')
      outcome = 'verified'
      result = { status: 'verified', journal }
    }
  } catch (reason) {
    const message = errorMessage(reason)
    if (journal && journalPublished) {
      journal.phase = 'failed'
      journal.errors.push({ at: new Date().toISOString(), action: 'apply', message })
      try {
        await publishJournal(journal, false, options.checkpoint)
      } catch (journalReason) {
        result = {
          status: 'failed',
          error: `${message}; journal update failed: ${errorMessage(journalReason)}`,
          journal,
        }
        const failures: unknown[] = []
        if (fence) await fence.release(outcome).catch((releaseReason) => failures.push(releaseReason))
        await lock.release().catch((releaseReason) => failures.push(releaseReason))
        if (failures.length > 0) throw new AggregateError(failures, 'failed to release v0.2 upgrade ownership')
        return result
      }
    }
    result = { status: 'failed', error: message, ...(journal ? { journal } : {}) }
  }
  const failures: unknown[] = []
  if (fence) await fence.release(outcome).catch((reason) => failures.push(reason))
  await lock.release().catch((reason) => failures.push(reason))
  if (failures.length > 0) throw new AggregateError(failures, 'failed to release v0.2 upgrade ownership')
  return result
}
