import type { WorkItemContractSnapshot } from './contracts.ts'
/** Exact-byte inventory and conversion for the offline recovery upgrade. No active writers here. */
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

export type ContractFingerprint = (snapshot: WorkItemContractSnapshot) => string
export const digest = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`
  return JSON.stringify(value)
}
export type RecoveryManifest = Record<string, { hash: string }>
export const manifestOf = (files: Record<string, RecoveryFile>): RecoveryManifest =>
  Object.fromEntries(Object.entries(files).map(([path, file]) => [path, { hash: file.hash }]))
export interface RecoveryFile {
  hash: string
  bytes: string
}
export async function inventoryRecoveryTree(root: string): Promise<Record<string, RecoveryFile>> {
  const result: Record<string, RecoveryFile> = Object.create(null)
  async function visit(path: string, name: string) {
    const st = await lstat(path)
    if (st.isSymbolicLink()) throw new Error('state symbolic link is not migratable')
    if (st.isDirectory()) {
      for (const child of (await readdir(path)).sort())
        await visit(join(path, child), name ? `${name}/${child}` : child)
    } else if (st.isFile()) {
      const bytes = await readFile(path)
      result[name] = { hash: digest(bytes), bytes: bytes.toString('base64') }
    } else throw new Error('state contains unsupported file type')
  }
  await visit(root, '')
  return result
}
export function treeHashes(files: RecoveryManifest): string {
  return canonical(Object.fromEntries(Object.entries(files).map(([path, file]) => [path, file.hash])))
}
function relocated(path: unknown, oldRoot: string, newRoot: string): string {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('invalid artifact path')
  const suffix = relative(oldRoot, path)
  if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix))
    throw new Error('artifact is outside source root')
  return join(newRoot, suffix)
}
export function convertRecoveryFiles(
  files: Record<string, RecoveryFile>,
  oldRoot: string,
  newRoot: string,
  fingerprintOf?: ContractFingerprint,
): Record<string, RecoveryFile> {
  const targets: Record<string, RecoveryFile> = Object.create(null)
  function artifact(ref: Record<string, unknown>, required: boolean): Record<string, unknown> | null {
    if (
      !ref ||
      !['issue-snapshot', 'log', 'diff', 'provider-response', 'model-output', 'diagnostic'].includes(
        String(ref.kind),
      ) ||
      !['none', 'applied'].includes(String(ref.redaction)) ||
      typeof ref.artifactId !== 'string'
    )
      throw new Error('unknown artifact policy')
    const path = relocated(ref.path, oldRoot, newRoot)
    const oldFile = files[relative(oldRoot, String(ref.path)).split(sep).join('/')]
    if (!oldFile) {
      if (required) throw new Error('required artifact missing')
      return null
    }
    const bytes = Buffer.from(oldFile.bytes, 'base64')
    if (ref.contentHash !== `sha256-v1_${createHash('sha256').update(bytes).digest('base64url')}`)
      throw new Error('artifact hash mismatch')
    return { ...ref, path }
  }
  for (const [name, file] of Object.entries(files)) {
    if (name === '.clickvibe-state.json') continue
    if (name.split('/').some((part) => part === '..' || part === '.' || !part)) throw new Error('invalid source path')
    let bytes = Buffer.from(file.bytes, 'base64')
    if (name.endsWith('/snapshot.json')) {
      const snapshot = JSON.parse(bytes.toString('utf8'))
      if (snapshot.schemaVersion !== 1 || snapshot.canonicalizationVersion !== 1)
        throw new Error('unknown contract snapshot version')
      if (!fingerprintOf || fingerprintOf(snapshot) !== snapshot.fingerprint)
        throw new Error('contract fingerprint verification required or failed')
      if (snapshot.rawArtifact.path !== join(oldRoot, name.replace(/snapshot\.json$/, 'raw.json')))
        throw new Error('contract raw path mismatch')
      snapshot.rawArtifact = artifact(snapshot.rawArtifact, true)
      bytes = Buffer.from(JSON.stringify(snapshot))
    } else if (name.endsWith('/workflow.json')) {
      const workflow = JSON.parse(bytes.toString('utf8'))
      if (!workflow || typeof workflow.key !== 'string' || !Array.isArray(workflow.events))
        throw new Error('unknown workflow shape')
      if (workflow.autoRun) {
        workflow.autoRun.status = 'paused'
        workflow.autoRun.pausedReason = 'controller-error'
        workflow.autoRun.recoveryBudget = { schema: 1, runId: 'legacy-unknown', cooldownUsed: true, halted: true }
      }
      bytes = Buffer.from(JSON.stringify(workflow))
    } else if (/diagnostics(?:\.1)?\.jsonl$/.test(name)) {
      const lines = bytes
        .toString('utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const record = JSON.parse(line)
          if (record.recordType === 'diagnostic') {
            if (record.schemaVersion !== 1) throw new Error('unknown diagnostic schema')
            if (record.rawArtifact) {
              record.rawArtifact = artifact(record.rawArtifact, false)
              if (!record.rawArtifact) record.message = `${record.message}; source-ref-missing`
            }
            return JSON.stringify(record)
          }
          return line
        })
      bytes = Buffer.from(lines.length ? `${lines.join('\n')}\n` : '')
    }
    targets[name] = { hash: digest(bytes), bytes: bytes.toString('base64') }
  }
  return targets
}
