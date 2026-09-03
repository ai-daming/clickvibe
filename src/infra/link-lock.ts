/** Cross-process hard-link lock with dead-owner recovery. */
import { randomBytes } from 'node:crypto'
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

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
  const token = `${process.pid}-${randomBytes(8).toString('hex')}`
  const candidate = `${lockPath}.${token}.candidate`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(candidate, JSON.stringify({ pid: process.pid, token }), 'utf8')
  const deadline = Date.now() + timeoutMs
  try {
    while (true) {
      try {
        await link(candidate, lockPath)
        return () => unlink(lockPath).catch(() => undefined)
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
