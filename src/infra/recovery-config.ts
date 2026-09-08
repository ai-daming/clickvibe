/** Strict config/journal/new-root pairing. Every writer re-observes the small authority files. */
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { parse } from 'yaml'
import { parseClickVibeConfigV1 } from './project-binding.ts'
import {
  recoveryConfigBytes,
  recoveryFingerprint,
  recoveryMarkerBytes,
  type RecoveryUpgradePlan,
} from './recovery-upgrade-plan.ts'
import { recoveryJournalPath, recoveryStateRoot } from './recovery-layout.ts'
import { verifyProjectBindingRepository } from './repository-identity.ts'

function regular(path: string): string {
  const st = lstatSync(path)
  if (!st.isFile() || st.isSymbolicLink()) throw new Error('recovery authority file must be regular')
  return readFileSync(path, 'utf8')
}
export function readRecoveryAuthority(home: string): { plan: RecoveryUpgradePlan; rawConfig: string } {
  try {
    const root = recoveryStateRoot(home)
    if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())
      throw new Error('invalid recovery state root')
    const journal = JSON.parse(regular(recoveryJournalPath(home)))
    const plan = journal.plan as RecoveryUpgradePlan
    if (
      journal.schemaVersion !== 1 ||
      journal.phase !== 'verified' ||
      !plan ||
      plan.schemaVersion !== 1 ||
      plan.home !== home ||
      journal.fingerprint !== plan.fingerprint ||
      recoveryFingerprint(plan) !== plan.fingerprint
    )
      throw new Error('invalid recovery journal or fingerprint')
    if (realpathSync(dirname(root)) !== plan.physicalRoot) throw new Error('recovery root identity changed')
    if (regular(join(root, '.clickvibe-state.json')) !== recoveryMarkerBytes(plan))
      throw new Error('recovery marker mismatch')
    if (
      plan.markerTemplate.schemaVersion !== 2 ||
      plan.markerTemplate.generation !== 'v0.2-recovery-1' ||
      plan.configTemplate.schemaVersion !== 2
    )
      throw new Error('unknown recovery schema')
    const rawConfig = regular(join(home, '.clickvibe', 'config.yaml'))
    if (rawConfig !== recoveryConfigBytes(plan)) throw new Error('recovery config mismatch')
    return { plan, rawConfig }
  } catch (error) {
    throw new Error('recovery state is unavailable or unverified; run the authorized offline upgrade', { cause: error })
  }
}
export function assertRecoveryStateWriteAllowed(root: string): void {
  const home = dirname(dirname(root))
  if (root !== recoveryStateRoot(home)) throw new Error('invalid recovery root')
  readRecoveryAuthority(home)
}
export async function loadRecoveryConfig(home: string) {
  const { rawConfig } = readRecoveryAuthority(home)
  const { recoveryPlanFingerprint: _fingerprint, ...raw } = parse(rawConfig)
  const config = parseClickVibeConfigV1({ ...raw, schemaVersion: 1 })
  const repos: Record<string, string> = {}
  const projects = new Set<string>()
  for (const binding of config.projectBindings) {
    if (binding.container.provider !== 'github' || binding.container.instance !== 'github.com')
      throw new Error('unsupported ProjectBinding provider')
    const verified = await verifyProjectBindingRepository(binding)
    const project = basename(verified.localPath)
    if (projects.has(project)) throw new Error('worktree path collision: repositories share the same basename')
    projects.add(project)
    repos[binding.container.id] = verified.localPath
  }
  return {
    schemaVersion: 2 as const,
    repos,
    worktreeRoot: config.worktreeRoot,
    fetchTtlSeconds: config.fetchTtlSeconds,
    diagnosticsMaxBytes: config.diagnosticsMaxBytes,
  }
}
