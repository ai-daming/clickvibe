import { observeRecoveryGit, type RecoveryGitScene } from './recovery-git-inventory.ts'
import { v02UpgradePlanFingerprint } from './v02-upgrade.ts'
import { loadV02Config } from './runtime.ts'
/** Immutable recovery migration plan. Derived fingerprints never hash themselves. */
import { lstat, readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parse, stringify } from 'yaml'
import { parseClickVibeConfigV1 } from './project-binding.ts'
import { recoveryStateRoot, RECOVERY_GENERATION } from './recovery-layout.ts'
import {
  canonical,
  convertRecoveryFiles,
  digest,
  inventoryRecoveryTree,
  manifestOf,
  type ContractFingerprint,
  type RecoveryManifest,
} from './recovery-upgrade-files.ts'

export interface RecoveryUpgradePlan {
  schemaVersion: 1
  home: string
  baselineSha: string
  physicalRoot: string
  sourceConfig: string
  sourceJournal: string
  sourceMarker: string
  gitFacts: RecoveryGitScene[]
  sourceFiles: RecoveryManifest
  targetFiles: RecoveryManifest
  configTemplate: Record<string, unknown>
  markerTemplate: { schemaVersion: 2; generation: string; planFingerprint: string }
  fingerprint: string
}
export function recoveryFingerprint(plan: RecoveryUpgradePlan): string {
  const { fingerprint: _fingerprint, ...unsigned } = plan
  return digest(canonical(unsigned))
}
export function recoveryConfigBytes(plan: RecoveryUpgradePlan): string {
  return stringify({ ...plan.configTemplate, recoveryPlanFingerprint: plan.fingerprint })
}
export function recoveryMarkerBytes(plan: RecoveryUpgradePlan): string {
  return JSON.stringify({ ...plan.markerTemplate, planFingerprint: plan.fingerprint })
}
export function verifyRecoveryPlan(plan: RecoveryUpgradePlan, _fingerprintOf?: ContractFingerprint): void {
  if (
    plan.schemaVersion !== 1 ||
    !/^[a-f0-9]{40}$/.test(plan.baselineSha) ||
    plan.home !== resolve(plan.home) ||
    plan.fingerprint !== recoveryFingerprint(plan)
  )
    throw new Error('invalid recovery plan fingerprint')
  if (
    plan.markerTemplate.schemaVersion !== 2 ||
    plan.markerTemplate.generation !== RECOVERY_GENERATION ||
    plan.markerTemplate.planFingerprint !== '' ||
    plan.configTemplate.schemaVersion !== 2 ||
    plan.configTemplate.recoveryPlanFingerprint !== ''
  )
    throw new Error('invalid recovery plan templates')
  if (
    canonical(plan.configTemplate) !==
    canonical({ ...parseClickVibeConfigV1(parse(plan.sourceConfig)), schemaVersion: 2, recoveryPlanFingerprint: '' })
  )
    throw new Error('recovery config conversion mismatch')
  if (
    !Array.isArray(plan.gitFacts) ||
    plan.gitFacts.length !== parseClickVibeConfigV1(parse(plan.sourceConfig)).projectBindings.length
  )
    throw new Error('Git inventory missing from recovery plan')
  const sourceJournal = JSON.parse(plan.sourceJournal)
  const sourceMarker = JSON.parse(plan.sourceMarker)
  if (
    sourceJournal.schemaVersion !== 1 ||
    sourceJournal.phase !== 'verified' ||
    !sourceJournal.plan ||
    v02UpgradePlanFingerprint(sourceJournal.plan) !== sourceJournal.planFingerprint ||
    sourceJournal.plan.targetConfig.sha256 !== digest(plan.sourceConfig) ||
    sourceJournal.plan.paths.root !== join(plan.home, '.clickvibe') ||
    sourceMarker.schemaVersion !== 1 ||
    sourceMarker.generation !== 'v0.2' ||
    sourceMarker.planFingerprint !== sourceJournal.planFingerprint
  )
    throw new Error('source v0.2 pair is invalid')
  for (const tree of [plan.sourceFiles, plan.targetFiles])
    for (const [name, file] of Object.entries(tree)) {
      if (
        !name ||
        name.startsWith('/') ||
        name.split('/').some((part) => part === '.' || part === '..' || !part) ||
        !/^[a-f0-9]{64}$/.test(file.hash) ||
        Object.keys(file).some((key) => key !== 'hash')
      )
        throw new Error('invalid recovery manifest')
    }
  if (digest(plan.sourceMarker) !== plan.sourceFiles['.clickvibe-state.json']?.hash)
    throw new Error('source marker hash mismatch')
}
export async function previewRecoveryUpgrade(input: {
  home: string
  baselineSha: string
  fingerprintOf?: ContractFingerprint
}): Promise<RecoveryUpgradePlan> {
  const home = resolve(input.home)
  const parent = join(home, '.clickvibe')
  const rootMetadata = await lstat(parent)
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink())
    throw new Error('ClickVibe root alias is not supported')
  const physicalRoot = await realpath(parent)
  try {
    await lstat(recoveryStateRoot(home))
    throw new Error('target exists; use recovery')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  for (const name of ['config.yaml', 'upgrade-v0.2.json']) {
    const metadata = await lstat(join(parent, name))
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('source authority file is not regular')
  }
  const sourceConfig = await readFile(join(parent, 'config.yaml'), 'utf8')
  const sourceJournal = await readFile(join(parent, 'upgrade-v0.2.json'), 'utf8')
  await loadV02Config(home, sourceConfig, parse(sourceConfig))
  const config = parseClickVibeConfigV1(parse(sourceConfig))
  const gitFacts = await observeRecoveryGit(config)
  const sourceFiles = await inventoryRecoveryTree(join(parent, 'state'))
  const plan: RecoveryUpgradePlan = {
    schemaVersion: 1,
    home,
    physicalRoot,
    baselineSha: input.baselineSha,
    sourceConfig,
    sourceJournal,
    gitFacts,
    sourceMarker: Buffer.from(sourceFiles['.clickvibe-state.json'].bytes, 'base64').toString('utf8'),
    sourceFiles: manifestOf(sourceFiles),
    targetFiles: manifestOf(
      convertRecoveryFiles(sourceFiles, join(parent, 'state'), recoveryStateRoot(home), input.fingerprintOf),
    ),
    configTemplate: { ...config, schemaVersion: 2, recoveryPlanFingerprint: '' },
    markerTemplate: { schemaVersion: 2, generation: RECOVERY_GENERATION, planFingerprint: '' },
    fingerprint: '',
  }
  plan.fingerprint = recoveryFingerprint(plan)
  verifyRecoveryPlan(plan, input.fingerprintOf)
  return plan
}
