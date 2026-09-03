/** ADR-0012 immutable capture bundle and atomic current-pointer persistence. */
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { ArtifactRef, WorkItemContractSnapshot, WorkItemIdentity } from './contracts.ts'
import { acquireLinkLock } from './link-lock.ts'
import { workItemKey } from './work-item-identity.ts'

export interface WorkItemContractPaths {
  contract: string
  captures: string
  current: string
}

type KnownBundle = {
  state: 'known'
  captureId: string
  snapshot: WorkItemContractSnapshot
  raw: Buffer
}

export type WorkItemContractRead = KnownBundle | { state: 'unknown'; reason: string }
export type WorkItemContractPublication =
  | (KnownBundle & { status: 'published' | 'unchanged' | 'stale' })
  | { state: 'unknown'; reason: string }

interface ReaderOptions {
  root: string
  workItem: WorkItemIdentity
  fingerprintOf: (snapshot: WorkItemContractSnapshot) => `wic1_${string}`
}

interface PublisherOptions extends ReaderOptions {
  raw: Buffer
  snapshot: WorkItemContractSnapshot
  compareSourceVersion: (current: string, candidate: string) => number | null
  checkpoint?: (name: ContractPublicationCheckpoint) => void | Promise<void>
}

export type ContractPublicationCheckpoint =
  | 'before-raw-write'
  | 'after-raw-write'
  | 'after-snapshot-write'
  | 'before-capture-rename'
  | 'after-capture-rename'
  | 'after-captures-fsync'
  | 'before-pointer-temp-write'
  | 'after-pointer-temp-write'
  | 'before-pointer-rename'
  | 'after-pointer-rename'
  | 'after-contract-fsync'

function rawDigest(raw: Uint8Array): string {
  return createHash('sha256').update(raw).digest('base64url')
}

export function workItemContractPaths(root: string, workItem: WorkItemIdentity): WorkItemContractPaths {
  const contract = join(root, 'work-items', workItemKey(workItem), 'contract')
  return { contract, captures: join(contract, 'captures'), current: join(contract, 'current.json') }
}

export function createRawArtifactRef(workItem: WorkItemIdentity, raw: Uint8Array, root = ''): ArtifactRef {
  const digest = rawDigest(raw)
  const captureId = `capture1_${digest}`
  return {
    artifactId: captureId,
    kind: 'issue-snapshot',
    path: join(workItemContractPaths(root, workItem).captures, captureId, 'raw.json'),
    contentHash: `sha256-v1_${digest}`,
    redaction: 'none',
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function writeSynced(path: string, value: Uint8Array): Promise<void> {
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(value)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function sameWorkItem(left: WorkItemIdentity, right: WorkItemIdentity): boolean {
  return workItemKey(left) === workItemKey(right)
}

async function readCapture(
  paths: WorkItemContractPaths,
  workItem: WorkItemIdentity,
  captureId: string,
  fingerprint: string,
  fingerprintOf: ReaderOptions['fingerprintOf'],
): Promise<WorkItemContractRead> {
  if (!/^capture1_[A-Za-z0-9_-]{43}$/.test(captureId)) return { state: 'unknown', reason: 'invalid-capture-id' }
  const directory = join(paths.captures, captureId)
  try {
    const [raw, encoded] = await Promise.all([
      readFile(join(directory, 'raw.json')),
      readFile(join(directory, 'snapshot.json'), 'utf8'),
    ])
    const snapshot = JSON.parse(encoded) as WorkItemContractSnapshot
    if (
      snapshot.schemaVersion !== 1 ||
      snapshot.canonicalizationVersion !== 1 ||
      !/^wic1_[A-Za-z0-9_-]{43}$/.test(snapshot.fingerprint)
    ) {
      return { state: 'unknown', reason: 'unknown-snapshot-version' }
    }
    if (!sameWorkItem(snapshot.workItem, workItem)) return { state: 'unknown', reason: 'work-item-mismatch' }
    if (snapshot.rawArtifact.artifactId !== captureId) return { state: 'unknown', reason: 'artifact-capture-mismatch' }
    if (
      snapshot.rawArtifact.kind !== 'issue-snapshot' ||
      snapshot.rawArtifact.redaction !== 'none' ||
      !/^sha256-v1_[A-Za-z0-9_-]{43}$/.test(snapshot.rawArtifact.contentHash)
    ) {
      return { state: 'unknown', reason: 'unknown-artifact-policy' }
    }
    if (snapshot.rawArtifact.contentHash !== `sha256-v1_${rawDigest(raw)}`) {
      return { state: 'unknown', reason: 'raw-content-hash-mismatch' }
    }
    if (snapshot.rawArtifact.path !== join(directory, 'raw.json'))
      return { state: 'unknown', reason: 'raw-artifact-path-mismatch' }
    if (snapshot.fingerprint !== fingerprint || fingerprintOf(snapshot) !== fingerprint) {
      return { state: 'unknown', reason: 'contract-fingerprint-mismatch' }
    }
    return { state: 'known', captureId, snapshot, raw }
  } catch {
    return { state: 'unknown', reason: 'invalid-contract-bundle' }
  }
}

export async function readCurrentWorkItemContract(options: ReaderOptions): Promise<WorkItemContractRead> {
  const paths = workItemContractPaths(options.root, options.workItem)
  let current: { schemaVersion?: unknown; captureId?: unknown; fingerprint?: unknown }
  try {
    current = JSON.parse(await readFile(paths.current, 'utf8')) as typeof current
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { state: 'unknown', reason: 'missing-current-contract' }
      : { state: 'unknown', reason: 'invalid-current-contract' }
  }
  if (
    current.schemaVersion !== 1 ||
    typeof current.fingerprint !== 'string' ||
    !/^wic1_[A-Za-z0-9_-]{43}$/.test(current.fingerprint)
  ) {
    return { state: 'unknown', reason: 'unknown-current-version' }
  }
  if (typeof current.captureId !== 'string') return { state: 'unknown', reason: 'invalid-current-contract' }
  return readCapture(paths, options.workItem, current.captureId, current.fingerprint, options.fingerprintOf)
}

async function publishCaptureFiles(
  paths: WorkItemContractPaths,
  snapshot: WorkItemContractSnapshot,
  raw: Buffer,
  checkpoint?: PublisherOptions['checkpoint'],
): Promise<void> {
  const captureId = snapshot.rawArtifact.artifactId
  const destination = join(paths.captures, captureId)
  const staging = join(paths.contract, `.staging-${process.pid}-${randomBytes(8).toString('hex')}`)
  await mkdir(staging, { recursive: false, mode: 0o700 })
  try {
    await checkpoint?.('before-raw-write')
    await writeSynced(join(staging, 'raw.json'), raw)
    await checkpoint?.('after-raw-write')
    const readback = await readFile(join(staging, 'raw.json'))
    if (rawDigest(readback) !== rawDigest(raw)) throw new Error('raw artifact readback mismatch')
    await writeSynced(join(staging, 'snapshot.json'), Buffer.from(`${JSON.stringify(snapshot)}\n`, 'utf8'))
    await checkpoint?.('after-snapshot-write')
    await syncDirectory(staging)
    await checkpoint?.('before-capture-rename')
    try {
      await rename(staging, destination)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' && (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY')
        throw error
      const [storedRaw, storedSnapshot] = await Promise.all([
        readFile(join(destination, 'raw.json')),
        readFile(join(destination, 'snapshot.json'), 'utf8'),
      ])
      if (!storedRaw.equals(raw) || JSON.stringify(JSON.parse(storedSnapshot)) !== JSON.stringify(snapshot)) {
        throw new Error(`immutable contract capture collision: ${captureId}`)
      }
    }
    await checkpoint?.('after-capture-rename')
    await syncDirectory(paths.captures)
    await checkpoint?.('after-captures-fsync')
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

export async function publishWorkItemContractCapture(options: PublisherOptions): Promise<WorkItemContractPublication> {
  const paths = workItemContractPaths(options.root, options.workItem)
  await mkdir(paths.captures, { recursive: true, mode: 0o700 })
  const release = await acquireLinkLock(paths.current)
  try {
    if (!sameWorkItem(options.snapshot.workItem, options.workItem))
      return { state: 'unknown', reason: 'work-item-mismatch' }
    const artifact = createRawArtifactRef(options.workItem, options.raw, options.root)
    if (JSON.stringify(options.snapshot.rawArtifact) !== JSON.stringify(artifact)) {
      return { state: 'unknown', reason: 'raw-artifact-mismatch' }
    }
    if (options.fingerprintOf(options.snapshot) !== options.snapshot.fingerprint) {
      return { state: 'unknown', reason: 'contract-fingerprint-mismatch' }
    }
    const current = await readCurrentWorkItemContract(options)
    if (current.state === 'known') {
      const order = options.compareSourceVersion(current.snapshot.sourceVersion, options.snapshot.sourceVersion)
      if (order === null) return { state: 'unknown', reason: 'source-version-unordered' }
      if (order > 0) return { ...current, status: 'stale' }
      if (order === 0) {
        if (current.captureId === artifact.artifactId) return { ...current, status: 'unchanged' }
        if (current.snapshot.fingerprint !== options.snapshot.fingerprint) {
          return { state: 'unknown', reason: 'source-version-conflict' }
        }
        // Comments, checkbox state and other excluded evidence can change
        // without changing the provider's Issue revision. Publishing the new
        // immutable evidence is safe because both captures authorize the exact
        // same canonical contract.
      }
    } else if (current.reason !== 'missing-current-contract') {
      return current
    }
    await publishCaptureFiles(paths, options.snapshot, options.raw, options.checkpoint)
    const verified = await readCapture(
      paths,
      options.workItem,
      artifact.artifactId,
      options.snapshot.fingerprint,
      options.fingerprintOf,
    )
    if (verified.state !== 'known') return verified
    const pointer = Buffer.from(
      `${JSON.stringify({ schemaVersion: 1, captureId: artifact.artifactId, fingerprint: options.snapshot.fingerprint })}\n`,
      'utf8',
    )
    const temporary = `${paths.current}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
    try {
      await options.checkpoint?.('before-pointer-temp-write')
      await writeSynced(temporary, pointer)
      await options.checkpoint?.('after-pointer-temp-write')
      await options.checkpoint?.('before-pointer-rename')
      await rename(temporary, paths.current)
      await options.checkpoint?.('after-pointer-rename')
      await syncDirectory(paths.contract)
      await options.checkpoint?.('after-contract-fsync')
    } finally {
      await rm(temporary, { force: true })
    }
    const published = await readCurrentWorkItemContract(options)
    return published.state === 'known' ? { ...published, status: 'published' } : published
  } finally {
    await release()
  }
}
