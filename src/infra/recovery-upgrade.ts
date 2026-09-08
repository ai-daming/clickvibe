import { loadRecoveryConfig } from './recovery-config.ts'
import { parse } from 'yaml'
import { parseClickVibeConfigV1 } from './project-binding.ts'
import { observeRecoveryGit } from './recovery-git-inventory.ts'
import { canonical } from './recovery-upgrade-files.ts'
import { readCurrentWorkItemContract } from './work-item-contract-store.ts'
/** Offline migration only: no caller can activate it without a validated host-stop fence and exact plan. */
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { acquireV02UpgradeLock } from './v02-upgrade-lock.ts'
import { assertApprovedV02GenerationFence } from './v02-generation-fence.ts'
import type { V02UpgradeGenerationFence } from './v02-upgrade-execution.ts'
import { durableRename, durableWriteExclusive, durableWriteReplace } from './v02-upgrade-durable.ts'
import { recoveryJournalPath, recoveryStateRoot } from './recovery-layout.ts'
import {
  digest,
  convertRecoveryFiles,
  manifestOf,
  inventoryRecoveryTree,
  treeHashes,
  type ContractFingerprint,
  type RecoveryFile,
  type RecoveryManifest,
} from './recovery-upgrade-files.ts'
import {
  previewRecoveryUpgrade,
  recoveryConfigBytes,
  recoveryMarkerBytes,
  verifyRecoveryPlan,
  type RecoveryUpgradePlan,
} from './recovery-upgrade-plan.ts'
export { previewRecoveryUpgrade }
export type { RecoveryUpgradePlan }

type Phase = 'prepared' | 'staged' | 'config-written' | 'root-published' | 'verified' | 'rolled-back'
export interface RecoveryJournal {
  schemaVersion: 1
  phase: Phase
  plan: RecoveryUpgradePlan
  fingerprint: string
}
interface ResumeOptions {
  fingerprintOf?: ContractFingerprint
  home: string
  fingerprint: string
  fence: V02UpgradeGenerationFence
  checkpoint?: (name: string) => void | Promise<void>
}
interface ApplyOptions extends Omit<ResumeOptions, 'home'> {
  plan: RecoveryUpgradePlan
}
const paths = (plan: RecoveryUpgradePlan) => ({
  parent: join(plan.home, '.clickvibe'),
  source: join(plan.home, '.clickvibe', 'state'),
  target: recoveryStateRoot(plan.home),
  stage: join(plan.home, '.clickvibe', `.stage-recovery-${plan.fingerprint}`),
  backup: join(plan.home, '.clickvibe', `backup-recovery-${plan.fingerprint}`),
  config: join(plan.home, '.clickvibe', 'config.yaml'),
  journal: recoveryJournalPath(plan.home),
})
async function exists(path: string): Promise<boolean> {
  try {
    const st = await lstat(path)
    if (st.isSymbolicLink()) throw new Error('upgrade path is a symbolic link')
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
async function regularBytes(path: string): Promise<string> {
  const st = await lstat(path)
  if (!st.isFile() || st.isSymbolicLink()) throw new Error('upgrade expected a regular file')
  return readFile(path, 'utf8')
}
function targetFiles(plan: RecoveryUpgradePlan): RecoveryManifest {
  const marker = recoveryMarkerBytes(plan)
  return {
    ...plan.targetFiles,
    '.clickvibe-state.json': { hash: digest(marker) },
  }
}
async function sameTree(root: string, files: RecoveryManifest): Promise<void> {
  if (treeHashes(await inventoryRecoveryTree(root)) !== treeHashes(files))
    throw new Error('state file set/hash changed or drifted')
}
async function writeTree(root: string, files: Record<string, RecoveryFile>): Promise<void> {
  if (await exists(root)) {
    const current = await inventoryRecoveryTree(root)
    for (const [name, file] of Object.entries(current))
      if (files[name]?.hash !== file.hash) throw new Error('staging/backup drift')
  } else await mkdir(root, { mode: 0o700 })
  for (const [name, file] of Object.entries(files)) {
    const destination = join(root, name)
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    if (!(await exists(destination))) await durableWriteExclusive(destination, Buffer.from(file.bytes, 'base64'))
    const st = await lstat(destination)
    if (!st.isFile() || st.nlink !== 1 || digest(await readFile(destination)) !== file.hash)
      throw new Error('copy must be an independent exact-byte file')
  }
  await sameTree(root, files)
}
async function sourceUnchanged(plan: RecoveryUpgradePlan, allowConvertedConfig: boolean): Promise<void> {
  const p = paths(plan)
  if ((await realpath(p.parent)) !== plan.physicalRoot) throw new Error('ClickVibe root identity changed')
  if (
    canonical(await observeRecoveryGit(parseClickVibeConfigV1(parse(plan.sourceConfig)))) !== canonical(plan.gitFacts)
  )
    throw new Error('Git scene changed after preview')
  await sameTree(p.source, plan.sourceFiles)
  if ((await regularBytes(join(p.parent, 'upgrade-v0.2.json'))) !== plan.sourceJournal)
    throw new Error('source journal changed')
  const config = await regularBytes(p.config)
  if (config !== plan.sourceConfig && (!allowConvertedConfig || config !== recoveryConfigBytes(plan)))
    throw new Error('source config changed')
}
async function saveJournal(journal: RecoveryJournal, checkpoint?: ResumeOptions['checkpoint']): Promise<void> {
  await durableWriteReplace(recoveryJournalPath(journal.plan.home), JSON.stringify(journal))
  await checkpoint?.(journal.phase)
}
async function loadJournal(
  home: string,
  fingerprint: string,
  fingerprintOf?: ContractFingerprint,
): Promise<RecoveryJournal> {
  const journal = JSON.parse(await regularBytes(recoveryJournalPath(home))) as RecoveryJournal
  if (
    journal.schemaVersion !== 1 ||
    journal.fingerprint !== fingerprint ||
    journal.plan.home !== home ||
    !['prepared', 'staged', 'config-written', 'root-published', 'verified', 'rolled-back'].includes(journal.phase)
  )
    throw new Error('invalid recovery journal')
  verifyRecoveryPlan(journal.plan, fingerprintOf)
  if (journal.plan.fingerprint !== fingerprint) throw new Error('journal fingerprint mismatch')
  return journal
}
async function offline<T>(
  home: string,
  fingerprint: string,
  fence: V02UpgradeGenerationFence,
  run: () => Promise<T>,
): Promise<T> {
  assertApprovedV02GenerationFence(fence)
  const lock = await acquireV02UpgradeLock(join(home, '.clickvibe', 'upgrade-v0.2.lock'), fingerprint)
  try {
    const held = await fence.acquire(fingerprint)
    try {
      return await run()
    } finally {
      await held.release('released')
    } // Releases only the process-local fence; disk journal owns the recovery generation.
  } finally {
    await lock.release()
  }
}
async function finish(
  journal: RecoveryJournal,
  checkpoint?: ResumeOptions['checkpoint'],
  fingerprintOf?: ContractFingerprint,
): Promise<RecoveryJournal> {
  const plan = journal.plan
  const p = paths(plan)
  if (journal.phase === 'rolled-back') throw new Error('rolled-back migration requires a new preview')
  if (journal.phase === 'verified') {
    await loadRecoveryConfig(plan.home)
    return journal
  }
  await sourceUnchanged(plan, true)
  const targets = targetFiles(plan)
  if (!(await exists(p.target))) {
    const source = await inventoryRecoveryTree(p.source)
    if (treeHashes(source) !== treeHashes(plan.sourceFiles)) throw new Error('source changed')
    const contents = convertRecoveryFiles(source, p.source, p.target, fingerprintOf)
    if (treeHashes(contents) !== treeHashes(plan.targetFiles))
      throw new Error('conversion differs from authorized plan')
    const marker = recoveryMarkerBytes(plan)
    contents['.clickvibe-state.json'] = { hash: digest(marker), bytes: Buffer.from(marker).toString('base64') }
    await writeTree(p.stage, contents)
    await verifyContracts(p.stage, p.target, plan, fingerprintOf)
    journal.phase = 'staged'
    await saveJournal(journal, checkpoint)
    await sourceUnchanged(plan, true)
    if ((await regularBytes(p.config)) !== recoveryConfigBytes(plan))
      await durableWriteReplace(p.config, recoveryConfigBytes(plan))
    journal.phase = 'config-written'
    await saveJournal(journal, checkpoint)
    await durableRename(p.stage, p.target)
  }
  await sameTree(p.target, targets)
  await verifyContracts(p.target, p.target, plan, fingerprintOf)
  if ((await regularBytes(p.config)) !== recoveryConfigBytes(plan))
    throw new Error('config mismatch at root publication')
  journal.phase = 'root-published'
  await saveJournal(journal, checkpoint)
  await sourceUnchanged(plan, true)
  journal.phase = 'verified'
  await saveJournal(journal, checkpoint)
  return journal
}
export async function applyRecoveryUpgrade(options: ApplyOptions): Promise<RecoveryJournal> {
  verifyRecoveryPlan(options.plan, options.fingerprintOf)
  if (options.fingerprint !== options.plan.fingerprint) throw new Error('authorization fingerprint mismatch')
  return offline(options.plan.home, options.fingerprint, options.fence, async () => {
    const plan = options.plan
    const p = paths(plan)
    if (await exists(p.journal)) throw new Error('recovery journal exists; use resume')
    if (await exists(p.target)) throw new Error('target exists')
    await sourceUnchanged(plan, false)
    const backup = {
      ...Object.fromEntries(
        Object.entries(await inventoryRecoveryTree(p.source)).map(([name, value]) => [`state/${name}`, value]),
      ),
      'config.yaml': { hash: digest(plan.sourceConfig), bytes: Buffer.from(plan.sourceConfig).toString('base64') },
      'upgrade-v0.2.json': {
        hash: digest(plan.sourceJournal),
        bytes: Buffer.from(plan.sourceJournal).toString('base64'),
      },
    }
    await writeTree(p.backup, backup)
    await sourceUnchanged(plan, false)
    const journal: RecoveryJournal = { schemaVersion: 1, phase: 'prepared', plan, fingerprint: options.fingerprint }
    await durableWriteExclusive(p.journal, JSON.stringify(journal))
    await options.checkpoint?.('prepared')
    return finish(journal, options.checkpoint, options.fingerprintOf)
  })
}
export async function resumeRecoveryUpgrade(options: ResumeOptions): Promise<RecoveryJournal> {
  return offline(options.home, options.fingerprint, options.fence, async () =>
    finish(
      await loadJournal(options.home, options.fingerprint, options.fingerprintOf),
      options.checkpoint,
      options.fingerprintOf,
    ),
  )
}
export async function rollbackRecoveryUpgrade(options: ResumeOptions): Promise<RecoveryJournal> {
  return offline(options.home, options.fingerprint, options.fence, async () => {
    const journal = await loadJournal(options.home, options.fingerprint, options.fingerprintOf)
    const p = paths(journal.plan)
    if (journal.phase === 'rolled-back') return journal
    await sourceUnchanged(journal.plan, true)
    if (await exists(p.target)) {
      await sameTree(p.target, targetFiles(journal.plan))
      if (await exists(p.stage)) throw new Error('staging path already exists during rollback')
      await durableRename(p.target, p.stage)
    }
    await durableWriteReplace(p.config, journal.plan.sourceConfig)
    journal.phase = 'rolled-back'
    await saveJournal(journal, options.checkpoint)
    return journal
  })
}

async function verifyContracts(
  root: string,
  artifactRoot: string,
  plan: RecoveryUpgradePlan,
  fingerprintOf?: ContractFingerprint,
): Promise<void> {
  for (const name of Object.keys(plan.targetFiles)) {
    if (!name.endsWith('/contract/current.json')) continue
    if (!fingerprintOf) throw new Error('contract fingerprint verifier required')
    const pointer = JSON.parse(await readFile(join(root, name), 'utf8'))
    if (typeof pointer.captureId !== 'string' || !/^capture1_[A-Za-z0-9_-]{43}$/.test(pointer.captureId))
      throw new Error('invalid current capture id')
    const snapshotName = name.replace(/current\.json$/, `captures/${pointer.captureId}/snapshot.json`)
    const snapshotFile = plan.targetFiles[snapshotName]
    if (!snapshotFile) throw new Error('contract current capture missing')
    const snapshot = JSON.parse(await readFile(join(root, snapshotName), 'utf8'))
    const bundle = await readCurrentWorkItemContract({
      root,
      artifactRoot,
      workItem: snapshot.workItem,
      fingerprintOf: (value) => fingerprintOf(value) as `wic1_${string}`,
    })
    if (bundle.state !== 'known') throw new Error(`contract migration validation failed: ${bundle.reason}`)
  }
}
