/** Durable filesystem primitives for the v0.2 upgrade transaction. */
import { randomUUID } from 'node:crypto'
import { link, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

export type V02UpgradeCheckpoint = (name: string) => Promise<void> | void

async function checkpoint(callback: V02UpgradeCheckpoint | undefined, name: string): Promise<void> {
  await callback?.(name)
}

export async function syncDirectory(path: string, callback?: V02UpgradeCheckpoint): Promise<void> {
  await checkpoint(callback, `before-directory-fsync:${path}`)
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  await checkpoint(callback, `after-directory-fsync:${path}`)
}

export async function ensureDurableDirectory(path: string, callback?: V02UpgradeCheckpoint): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 })
    await syncDirectory(dirname(path), callback)
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code !== 'EEXIST') throw reason
  }
  const metadata = await lstat(path)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`expected real directory: ${path}`)
}

async function prepareTemporary(destination: string, value: string | Buffer, callback?: V02UpgradeCheckpoint) {
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`
  await checkpoint(callback, `before-file-write:${destination}`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(value)
    await checkpoint(callback, `after-file-write:${destination}`)
    await checkpoint(callback, `before-file-fsync:${destination}`)
    await handle.sync()
    await checkpoint(callback, `after-file-fsync:${destination}`)
  } catch (reason) {
    await handle.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
    throw reason
  }
  await handle.close()
  return temporary
}

export async function durableWriteExclusive(
  destination: string,
  value: string | Buffer,
  callback?: V02UpgradeCheckpoint,
): Promise<void> {
  const temporary = await prepareTemporary(destination, value, callback)
  try {
    await checkpoint(callback, `before-publish:${destination}`)
    await link(temporary, destination)
    await checkpoint(callback, `after-publish:${destination}`)
    await syncDirectory(dirname(destination), callback)
  } finally {
    await rm(temporary, { force: true })
  }
}

export async function durableWriteReplace(
  destination: string,
  value: string | Buffer,
  callback?: V02UpgradeCheckpoint,
): Promise<void> {
  const temporary = await prepareTemporary(destination, value, callback)
  try {
    await checkpoint(callback, `before-replace:${destination}`)
    await rename(temporary, destination)
    await checkpoint(callback, `after-replace:${destination}`)
    await syncDirectory(dirname(destination), callback)
  } catch (reason) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw reason
  }
}

export async function durableRename(
  source: string,
  destination: string,
  callback?: V02UpgradeCheckpoint,
): Promise<void> {
  await checkpoint(callback, `before-rename:${source}->${destination}`)
  await rename(source, destination)
  await checkpoint(callback, `after-rename:${source}->${destination}`)
  await syncDirectory(dirname(destination), callback)
  if (dirname(source) !== dirname(destination)) await syncDirectory(dirname(source), callback)
}

export async function readExactFile(path: string): Promise<Buffer> {
  return readFile(path)
}
