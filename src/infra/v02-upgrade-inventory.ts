/** Read-only discovery of existing v0.2 upgrade and recovery evidence. */
import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parseDocument } from 'yaml'
import type { V02UpgradePlan, V02UpgradePreview, V02UpgradeRecoveryAsset } from './v02-upgrade.ts'

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

async function recoveryAssets(root: string): Promise<V02UpgradeRecoveryAsset[]> {
  const assets: V02UpgradeRecoveryAsset[] = []
  let entries: Dirent[]
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw reason
  }
  for (const entry of entries) {
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
  return assets.sort((a, b) => compareText(a.path, b.path))
}

async function hasJournalLessUpgradeEvidence(
  paths: V02UpgradePlan['paths'],
  assets: V02UpgradeRecoveryAsset[],
): Promise<boolean> {
  const nonce = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
  const stamp = '\\d{8}T\\d{9}Z'
  const artifact = new RegExp(
    `^(?:config-v0\\.1-backup-${stamp}-${nonce}\\.yaml|config-v0\\.2-staging-${nonce}\\.yaml|state-v0\\.1-backup-${stamp}-${nonce}|state-v0\\.2-staging-${nonce})$`,
    'i',
  )
  if (assets.some((asset) => artifact.test(basename(asset.path)))) return true
  try {
    const parsed = parseDocument(await readFile(paths.activeConfig, 'utf8')).toJS() as {
      schemaVersion?: unknown
    } | null
    if (parsed?.schemaVersion === 1) return true
  } catch {
    // Config validation remains the ordinary preview's responsibility.
  }
  try {
    const marker = JSON.parse(await readFile(join(paths.activeState, '.clickvibe-state.json'), 'utf8')) as {
      generation?: unknown
    }
    return marker.generation === 'v0.2'
  } catch {
    return false
  }
}

export async function inspectV02UpgradeRecovery(paths: V02UpgradePlan['paths']): Promise<V02UpgradePreview | null> {
  let raw: string
  try {
    raw = await readFile(paths.journal, 'utf8')
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code === 'ENOENT') {
      const assets = await recoveryAssets(paths.root)
      if (!(await hasJournalLessUpgradeEvidence(paths, assets))) return null
      return {
        status: 'recovery',
        recovery: { journal: { status: 'missing', error: 'upgrade journal is missing' }, assets },
      }
    }
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
