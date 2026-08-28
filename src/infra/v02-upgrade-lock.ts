/** Cross-process upgrade lock with conservative stale-owner recovery. */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { link, lstat, readFile, rm, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { durableWriteExclusive, syncDirectory, type V02UpgradeCheckpoint } from './v02-upgrade-durable.ts'

const execFileAsync = promisify(execFile)

export interface V02UpgradeLockOwner {
  schemaVersion: 2
  token: string
  pid: number
  processStart: string
  acquiredAt: string
  planFingerprint: string
}

interface LegacyV02UpgradeLockOwner extends Omit<V02UpgradeLockOwner, 'schemaVersion'> {
  schemaVersion: 1
}

type ReadV02UpgradeLockOwner = V02UpgradeLockOwner | LegacyV02UpgradeLockOwner

export interface V02UpgradeLock {
  owner: V02UpgradeLockOwner
  release(): Promise<void>
}

interface ProcessIdentity {
  start: string
  state: string
}

async function processIdentity(pid: number): Promise<ProcessIdentity | null> {
  try {
    const result = await execFileAsync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'stat='], {
      encoding: 'utf8',
      env: { ...process.env, LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
    })
    const match = result.stdout.trim().match(/^(.*\d{4})\s+(\S+)$/)
    return match ? { start: match[1], state: match[2] } : null
  } catch {
    return null
  }
}

async function readOwner(path: string): Promise<ReadV02UpgradeLockOwner> {
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`upgrade lock is not a regular file: ${path}`)
  const value = JSON.parse(await readFile(path, 'utf8')) as ReadV02UpgradeLockOwner
  if (
    (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
    typeof value.token !== 'string' ||
    !Number.isSafeInteger(value.pid) ||
    typeof value.processStart !== 'string' ||
    typeof value.planFingerprint !== 'string'
  ) {
    throw new Error(`upgrade lock has an invalid owner record: ${path}`)
  }
  return value
}

async function ownerIsStale(owner: ReadV02UpgradeLockOwner): Promise<boolean> {
  try {
    process.kill(owner.pid, 0)
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code === 'ESRCH') return true
    return false
  }
  // v1 stored a locale/timezone-dependent ps string. A live v1 PID is therefore
  // ambiguous and must remain owned; only v2 has a comparable UTC identity.
  if (owner.schemaVersion === 1) return false
  const identity = await processIdentity(owner.pid)
  if (!identity) return false
  if (identity.state.startsWith('Z')) return true
  return identity.start !== owner.processStart
}

async function reclaimStaleLock(
  path: string,
  owner: ReadV02UpgradeLockOwner,
  callback?: V02UpgradeCheckpoint,
): Promise<boolean> {
  const claim = `${path}.stale-${process.pid}-${randomUUID()}`
  try {
    await link(path, claim)
    const [locked, claimed] = await Promise.all([lstat(path), lstat(claim)])
    if (locked.dev !== claimed.dev || locked.ino !== claimed.ino) return false
    const current = await readOwner(claim)
    if (current.token !== owner.token || !(await ownerIsStale(current))) return false
    await unlink(path)
    await syncDirectory(dirname(path), callback)
    return true
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw reason
  } finally {
    await rm(claim, { force: true }).catch(() => undefined)
  }
}

export async function acquireV02UpgradeLock(
  path: string,
  planFingerprint: string,
  callback?: V02UpgradeCheckpoint,
): Promise<V02UpgradeLock> {
  const currentIdentity = await processIdentity(process.pid)
  if (!currentIdentity) throw new Error('cannot determine current process start identity')
  const owner: V02UpgradeLockOwner = {
    schemaVersion: 2,
    token: randomUUID(),
    pid: process.pid,
    processStart: currentIdentity.start,
    acquiredAt: new Date().toISOString(),
    planFingerprint,
  }
  const candidate = `${path}.candidate-${process.pid}-${owner.token}`
  await durableWriteExclusive(candidate, `${JSON.stringify(owner)}\n`, callback)
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await link(candidate, path)
        await syncDirectory(dirname(path), callback)
        let released = false
        return {
          owner,
          async release() {
            if (released) return
            const current = await readOwner(path)
            if (current.token !== owner.token) throw new Error('upgrade lock ownership changed before release')
            await unlink(path)
            await syncDirectory(dirname(path), callback)
            released = true
          },
        }
      } catch (reason) {
        if ((reason as NodeJS.ErrnoException).code !== 'EEXIST') throw reason
        const existing = await readOwner(path)
        if (!(await ownerIsStale(existing))) {
          throw new Error(`upgrade already locked by pid ${existing.pid} (${existing.acquiredAt})`)
        }
        if (!(await reclaimStaleLock(path, existing, callback))) continue
      }
    }
    throw new Error('upgrade lock changed repeatedly while acquiring it')
  } finally {
    await rm(candidate, { force: true }).catch(() => undefined)
  }
}
