/** Explicit v0.1 -> v0.2 local config/state upgrade observation and execution. */
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { parseDocument, stringify as stringifyYaml } from 'yaml'
import type { ClickVibeConfigV1, ProjectBinding } from './contracts.ts'
import { createProjectBinding, parseClickVibeConfigV1 } from './project-binding.ts'
import { inspectRepositoryIdentityLocation, readRepositoryId } from './repository-identity.ts'

const execFileAsync = promisify(execFile)
const UPGRADE_VERSION = 'clickvibe-v02-upgrade-1'

export interface V02UpgradeChoices {
  primaryRemotes: Record<string, string>
  exclusions: Record<string, string>
}

export interface V02UpgradeHostActivity {
  liveTasks: string[]
  liveJobs: string[]
  oldPluginProcesses: string[]
}

export interface V02UpgradeBindingPlan extends ProjectBinding {
  realCommonDir: string
  repositoryIdExisted: boolean
  remoteUrl: string
}

export interface V02UpgradeStateInventory {
  status: 'present' | 'absent' | 'error'
  realPath: string | null
  device: number | null
  inode: number | null
  fileCount: number
  byteCount: number
  sha256: string
  entries: Array<{ path: string; bytes: number; sha256: string }>
  error?: string
}

export interface V02UpgradePlan {
  upgradeVersion: typeof UPGRADE_VERSION
  baselineSha: string
  createdAt: string
  nonce: string
  expectedJournal: 'absent' | { phase: 'rolled_back'; sha256: string }
  paths: {
    root: string
    activeConfig: string
    configBackup: string
    stagedConfig: string
    activeState: string
    stateBackup: string
    stagedState: string
    journal: string
    lock: string
  }
  legacyConfig: { status: 'present'; bytes: number; sha256: string }
  legacyState: V02UpgradeStateInventory
  bindings: V02UpgradeBindingPlan[]
  exclusions: Array<{ repoKey: string; localPath: string; reason: string; error: string; sha256: string }>
  worktrees: Array<{ repoKey: string; repositoryPath: string; porcelain: string }>
  hostActivity: V02UpgradeHostActivity
  targetConfig: { yaml: string; sha256: string }
}

export interface V02UpgradeBlockedItem {
  scope: 'config' | 'state' | 'repository' | 'host'
  key: string
  error: string
}

export interface V02UpgradeRecoveryAsset {
  path: string
  kind: 'file' | 'directory' | 'symlink' | 'other'
  bytes: number
  sha256?: string
  modifiedAt: string
}

export type V02UpgradePreview =
  | { status: 'previewed'; fingerprint: string; plan: V02UpgradePlan }
  | { status: 'blocked'; blocked: V02UpgradeBlockedItem[] }
  | {
      status: 'recovery'
      recovery: {
        journal: {
          status: 'complete' | 'corrupt' | 'unknown-schema'
          value?: unknown
          sha256?: string
          error?: string
        }
        assets: V02UpgradeRecoveryAsset[]
      }
    }

export interface PreviewV02UpgradeOptions {
  home: string
  baselineSha: string
  now?: string
  nonce?: string
  proposedRepositoryIds?: Record<string, string>
  choices: V02UpgradeChoices
  hostActivity: V02UpgradeHostActivity
}

interface LegacyConfig {
  repos: Record<string, string>
  worktreeRoot: string
  fetchTtlSeconds?: number
  diagnosticsMaxBytes?: number
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    )
  }
  return value
}

export function v02UpgradePlanFingerprint(plan: V02UpgradePlan): string {
  return sha256(JSON.stringify(canonicalValue(plan)))
}

function expandHome(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/')) return join(home, path.slice(2))
  return path
}

function parsePositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`)
  }
  return value
}

function parseLegacyConfig(raw: string, home: string): LegacyConfig {
  const document = parseDocument(raw)
  if (document.errors.length > 0) throw new Error(`config.yaml cannot be parsed: ${document.errors[0].message}`)
  const value = document.toJS() as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('legacy config must be an object')
  const input = value as Record<string, unknown>
  const unknown = Object.keys(input).filter(
    (key) => !['repos', 'worktreeRoot', 'fetchTtlSeconds', 'diagnosticsMaxBytes'].includes(key),
  )
  if (unknown.length > 0) throw new Error(`legacy config contains unknown field(s): ${unknown.join(', ')}`)
  if (input.repos !== undefined && (!input.repos || typeof input.repos !== 'object' || Array.isArray(input.repos))) {
    throw new Error('legacy config repos must be an owner/repository to path mapping')
  }
  const repos: Record<string, string> = {}
  for (const [repoKey, path] of Object.entries((input.repos ?? {}) as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(repoKey) || typeof path !== 'string' || path.length === 0) {
      throw new Error(`legacy config repos.${repoKey} is invalid`)
    }
    repos[repoKey] = resolve(expandHome(path, home))
  }
  const worktreeRootValue = input.worktreeRoot ?? join(home, '.clickvibe', 'worktrees')
  if (typeof worktreeRootValue !== 'string' || worktreeRootValue.length === 0) {
    throw new Error('legacy config worktreeRoot must be a non-empty string')
  }
  const fetchTtlSeconds = parsePositiveInteger(input.fetchTtlSeconds, 'fetchTtlSeconds')
  if (fetchTtlSeconds !== undefined && (fetchTtlSeconds < 30 || fetchTtlSeconds > 60)) {
    throw new Error('fetchTtlSeconds must be between 30 and 60')
  }
  const diagnosticsMaxBytes = parsePositiveInteger(input.diagnosticsMaxBytes, 'diagnosticsMaxBytes')
  return {
    repos,
    worktreeRoot: resolve(expandHome(worktreeRootValue, home)),
    ...(fetchTtlSeconds === undefined ? {} : { fetchTtlSeconds }),
    ...(diagnosticsMaxBytes === undefined ? {} : { diagnosticsMaxBytes }),
  }
}

async function git(repositoryPath: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', repositoryPath, ...args], { encoding: 'utf8' })
  return result.stdout.trim()
}

async function inventoryState(path: string): Promise<V02UpgradeStateInventory> {
  try {
    const root = await lstat(path)
    if (root.isSymbolicLink() || !root.isDirectory()) throw new Error('active state must be a real directory')
    const entries: V02UpgradeStateInventory['entries'] = []
    async function visit(directory: string): Promise<void> {
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        const child = join(directory, entry.name)
        if (entry.isSymbolicLink()) throw new Error(`state contains symlink: ${relative(path, child)}`)
        if (entry.isDirectory()) await visit(child)
        else if (entry.isFile()) {
          const bytes = await readFile(child)
          entries.push({ path: relative(path, child), bytes: bytes.length, sha256: sha256(bytes) })
        } else throw new Error(`state contains unsupported entry: ${relative(path, child)}`)
      }
    }
    await visit(path)
    const sorted = entries.sort((a, b) => a.path.localeCompare(b.path))
    return {
      status: 'present',
      realPath: await realpath(path),
      device: root.dev,
      inode: root.ino,
      fileCount: sorted.length,
      byteCount: sorted.reduce((total, entry) => total + entry.bytes, 0),
      sha256: sha256(JSON.stringify(sorted)),
      entries: sorted,
    }
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        status: 'absent',
        realPath: null,
        device: null,
        inode: null,
        fileCount: 0,
        byteCount: 0,
        sha256: sha256('absent'),
        entries: [],
      }
    }
    return {
      status: 'error',
      realPath: null,
      device: null,
      inode: null,
      fileCount: 0,
      byteCount: 0,
      sha256: sha256(`error:${errorMessage(reason)}`),
      entries: [],
      error: errorMessage(reason),
    }
  }
}

function pathStamp(now: string): string {
  return now.replace(/[-:.]/g, '')
}

function upgradePaths(home: string, now: string, nonce: string): V02UpgradePlan['paths'] {
  const root = join(home, '.clickvibe')
  const stamp = pathStamp(now)
  return {
    root,
    activeConfig: join(root, 'config.yaml'),
    configBackup: join(root, `config-v0.1-backup-${stamp}-${nonce}.yaml`),
    stagedConfig: join(root, `config-v0.2-staging-${nonce}.yaml`),
    activeState: join(root, 'state'),
    stateBackup: join(root, `state-v0.1-backup-${stamp}-${nonce}`),
    stagedState: join(root, `state-v0.2-staging-${nonce}`),
    journal: join(root, 'upgrade-v0.2.json'),
    lock: join(root, 'upgrade-v0.2.lock'),
  }
}

async function recoveryAssets(root: string): Promise<V02UpgradeRecoveryAsset[]> {
  const assets: V02UpgradeRecoveryAsset[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!/^(config|state|upgrade-v0\.2)/.test(entry.name)) continue
    const path = join(root, entry.name)
    const metadata = await lstat(path)
    const kind = entry.isSymbolicLink()
      ? 'symlink'
      : entry.isFile()
        ? 'file'
        : entry.isDirectory()
          ? 'directory'
          : 'other'
    const bytes = entry.isFile() ? await readFile(path) : null
    assets.push({
      path,
      kind,
      bytes: bytes?.length ?? metadata.size,
      ...(bytes ? { sha256: sha256(bytes) } : {}),
      modifiedAt: metadata.mtime.toISOString(),
    })
  }
  return assets.sort((a, b) => a.path.localeCompare(b.path))
}

async function inspectRecovery(paths: V02UpgradePlan['paths']): Promise<V02UpgradePreview | null> {
  let raw: string
  try {
    raw = await readFile(paths.journal, 'utf8')
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code === 'ENOENT') return null
    return {
      status: 'recovery',
      recovery: {
        journal: { status: 'corrupt', error: errorMessage(reason) },
        assets: await recoveryAssets(paths.root),
      },
    }
  }
  try {
    const value = JSON.parse(raw) as { schemaVersion?: unknown }
    return {
      status: 'recovery',
      recovery: {
        journal:
          value.schemaVersion === 1
            ? { status: 'complete', value, sha256: sha256(raw) }
            : { status: 'unknown-schema', value, sha256: sha256(raw) },
        assets: await recoveryAssets(paths.root),
      },
    }
  } catch (reason) {
    return {
      status: 'recovery',
      recovery: {
        journal: { status: 'corrupt', error: errorMessage(reason) },
        assets: await recoveryAssets(paths.root),
      },
    }
  }
}

async function inspectBinding(
  repoKey: string,
  localPath: string,
  primaryRemote: string | undefined,
  proposedRepositoryId: string | undefined,
): Promise<{ binding: V02UpgradeBindingPlan; worktree: V02UpgradePlan['worktrees'][number] }> {
  const location = await inspectRepositoryIdentityLocation(localPath)
  let repositoryId: string
  let repositoryIdExisted = true
  try {
    repositoryId = await readRepositoryId(localPath)
  } catch (reason) {
    if (
      (reason as NodeJS.ErrnoException).code !== 'ENOENT' &&
      !/(?:ENOENT|repositoryId is missing:)/.test(errorMessage(reason))
    )
      throw reason
    repositoryId = proposedRepositoryId ?? `repo_${randomUUID()}`
    repositoryIdExisted = false
  }
  const remotes = (await git(localPath, 'remote'))
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean)
    .sort()
  const selected = primaryRemote ?? (remotes.length === 1 ? remotes[0] : undefined)
  if (!selected) throw new Error(`primary remote must be selected from: ${remotes.join(', ') || '(none)'}`)
  if (!remotes.includes(selected)) throw new Error(`primary remote ${selected} does not exist`)
  const [owner, repository] = repoKey.split('/')
  const binding = createProjectBinding({
    container: { provider: 'github', instance: 'github.com', id: `${owner.toLowerCase()}/${repository.toLowerCase()}` },
    repository: { repositoryId, localPath: location.localPath, primaryRemote: selected },
  })
  return {
    binding: {
      ...binding,
      realCommonDir: location.commonDir,
      repositoryIdExisted,
      remoteUrl: await git(localPath, 'remote', 'get-url', selected),
    },
    worktree: {
      repoKey,
      repositoryPath: location.localPath,
      porcelain: await git(localPath, 'worktree', 'list', '--porcelain'),
    },
  }
}

export async function previewV02Upgrade(options: PreviewV02UpgradeOptions): Promise<V02UpgradePreview> {
  const now = options.now ?? new Date().toISOString()
  const nonce = options.nonce ?? randomUUID()
  const paths = upgradePaths(resolve(options.home), now, nonce)
  const recovery = await inspectRecovery(paths)
  let expectedJournal: V02UpgradePlan['expectedJournal'] = 'absent'
  if (recovery) {
    if (recovery.status !== 'recovery') return recovery
    const recoveredJournal = recovery.recovery.journal
    const value = recoveredJournal.status === 'complete' ? (recoveredJournal.value as { phase?: unknown }) : null
    if (value?.phase !== 'rolled_back' || !recoveredJournal.sha256) return recovery
    expectedJournal = { phase: 'rolled_back', sha256: recoveredJournal.sha256 }
  }
  const blocked: V02UpgradeBlockedItem[] = []
  let rawConfig: string
  let legacyConfig: LegacyConfig
  try {
    const configMetadata = await lstat(paths.activeConfig)
    if (!configMetadata.isFile() || configMetadata.isSymbolicLink()) {
      throw new Error('legacy config must be a real regular file')
    }
    rawConfig = await readFile(paths.activeConfig, 'utf8')
    legacyConfig = parseLegacyConfig(rawConfig, options.home)
  } catch (reason) {
    return { status: 'blocked', blocked: [{ scope: 'config', key: paths.activeConfig, error: errorMessage(reason) }] }
  }
  const state = await inventoryState(paths.activeState)
  if (state.status === 'error')
    blocked.push({ scope: 'state', key: paths.activeState, error: state.error ?? 'unknown state error' })
  for (const task of options.hostActivity.liveTasks)
    blocked.push({ scope: 'host', key: task, error: 'live ClickVibe task' })
  for (const job of options.hostActivity.liveJobs)
    blocked.push({ scope: 'host', key: job, error: 'live ClickVibe host job' })
  for (const process of options.hostActivity.oldPluginProcesses) {
    blocked.push({ scope: 'host', key: process, error: 'old ClickVibe plugin process is still active' })
  }

  const bindings: V02UpgradeBindingPlan[] = []
  const exclusions: V02UpgradePlan['exclusions'] = []
  const worktrees: V02UpgradePlan['worktrees'] = []
  for (const [repoKey, localPath] of Object.entries(legacyConfig.repos)) {
    try {
      const observed = await inspectBinding(
        repoKey,
        localPath,
        options.choices.primaryRemotes[repoKey],
        options.proposedRepositoryIds?.[repoKey],
      )
      if (options.choices.exclusions[repoKey]) {
        blocked.push({ scope: 'repository', key: repoKey, error: 'a valid repository cannot be silently excluded' })
        continue
      }
      bindings.push(observed.binding)
      worktrees.push(observed.worktree)
    } catch (reason) {
      const error = errorMessage(reason)
      const exclusionReason = options.choices.exclusions[repoKey]?.trim()
      if (exclusionReason) {
        exclusions.push({
          repoKey,
          localPath,
          reason: exclusionReason,
          error,
          sha256: sha256(JSON.stringify([repoKey, localPath, error, exclusionReason])),
        })
      } else blocked.push({ scope: 'repository', key: repoKey, error })
    }
  }
  if (blocked.length > 0) return { status: 'blocked', blocked }

  let targetConfig: ClickVibeConfigV1
  try {
    targetConfig = parseClickVibeConfigV1({
      schemaVersion: 1,
      worktreeRoot: legacyConfig.worktreeRoot,
      ...(legacyConfig.fetchTtlSeconds === undefined ? {} : { fetchTtlSeconds: legacyConfig.fetchTtlSeconds }),
      ...(legacyConfig.diagnosticsMaxBytes === undefined
        ? {}
        : { diagnosticsMaxBytes: legacyConfig.diagnosticsMaxBytes }),
      projectBindings: bindings.map(
        ({ realCommonDir: _common, repositoryIdExisted: _existed, remoteUrl: _url, ...binding }) => binding,
      ),
    })
  } catch (reason) {
    return { status: 'blocked', blocked: [{ scope: 'config', key: 'targetConfig', error: errorMessage(reason) }] }
  }
  const targetYaml = stringifyYaml(targetConfig, { lineWidth: 0 })
  const plan: V02UpgradePlan = {
    upgradeVersion: UPGRADE_VERSION,
    baselineSha: options.baselineSha,
    createdAt: now,
    nonce,
    expectedJournal,
    paths,
    legacyConfig: { status: 'present', bytes: Buffer.byteLength(rawConfig), sha256: sha256(rawConfig) },
    legacyState: state,
    bindings: bindings.sort((a, b) => a.container.id.localeCompare(b.container.id)),
    exclusions: exclusions.sort((a, b) => a.repoKey.localeCompare(b.repoKey)),
    worktrees: worktrees.sort((a, b) => a.repoKey.localeCompare(b.repoKey)),
    hostActivity: options.hostActivity,
    targetConfig: { yaml: targetYaml, sha256: sha256(targetYaml) },
  }
  return { status: 'previewed', fingerprint: v02UpgradePlanFingerprint(plan), plan }
}
