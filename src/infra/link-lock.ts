/** Cross-process hard-link lock with dead-owner recovery. */
import { randomBytes } from 'node:crypto'
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const pendingReleases = new Map<string, string>()

async function finishPendingRelease(lockPath: string): Promise<void> {
  const token = pendingReleases.get(lockPath)
  if (!token) return
  try {
    const owner = JSON.parse(await readFile(lockPath, 'utf8')) as { token?: string }
    if (owner.token === token) await unlink(lockPath)
    pendingReleases.delete(lockPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') pendingReleases.delete(lockPath)
    else throw error
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function recoverDeadLock(lockPath: string): Promise<void> {
  try {
    const owner = JSON.parse(await readFile(lockPath, 'utf8')) as { pid: number; token: string }
    if (!owner.token || processAlive(owner.pid)) return
    await link(lockPath, `${lockPath}.stale-${owner.token}`)
    await unlink(lockPath)
  } catch {
    // The owner is alive, another process recovered it, or the lock disappeared.
  }
}

export async function acquireLinkLock(path: string, timeoutMs = 10_000): Promise<() => Promise<void>> {
  const lockPath = `${path}.lock`
  await finishPendingRelease(lockPath)
  const token = `${process.pid}-${randomBytes(8).toString('hex')}`
  const candidate = `${lockPath}.${token}.candidate`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(candidate, JSON.stringify({ pid: process.pid, token }), 'utf8')
  const deadline = Date.now() + timeoutMs
  try {
    while (true) {
      try {
        await link(candidate, lockPath)
        let released = false
        return async () => {
          if (released) return
          released = true
          pendingReleases.set(lockPath, token)
          await finishPendingRelease(lockPath)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        await recoverDeadLock(lockPath)
        if (Date.now() >= deadline) throw new Error(`state link lock timeout: ${path}`)
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
      }
    }
  } finally {
    await unlink(candidate).catch(() => undefined)
  }
}
