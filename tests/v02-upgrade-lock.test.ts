import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { acquireV02UpgradeLock } from '../src/infra/v02-upgrade-lock.ts'

test('a real second Node process cannot acquire the fixed upgrade lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-v02-lock-'))
  const lockPath = join(root, 'upgrade-v0.2.lock')
  const moduleUrl = new URL('../src/infra/v02-upgrade-lock.ts', import.meta.url).href
  const script = `
    import { acquireV02UpgradeLock } from ${JSON.stringify(moduleUrl)};
    const lock = await acquireV02UpgradeLock(${JSON.stringify(lockPath)}, 'child-plan');
    console.log('LOCKED');
    setTimeout(async () => { await lock.release(); process.exit(0) }, 1200);
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    let output = ''
    while (!output.includes('LOCKED')) {
      const [chunk] = (await once(child.stdout, 'data')) as [Buffer]
      output += chunk.toString('utf8')
    }
    await assert.rejects(acquireV02UpgradeLock(lockPath, 'parent-plan'), /already locked/)
    const [exitCode] = (await once(child, 'exit')) as [number]
    assert.equal(exitCode, 0)
    const parent = await acquireV02UpgradeLock(lockPath, 'parent-plan')
    await parent.release()
  } finally {
    if (child.exitCode === null) child.kill()
    await rm(root, { recursive: true, force: true })
  }
})

test('two simultaneous acquirers produce exactly one owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-v02-lock-race-'))
  const lockPath = join(root, 'upgrade-v0.2.lock')
  try {
    const attempts = await Promise.allSettled([
      acquireV02UpgradeLock(lockPath, 'first-plan'),
      acquireV02UpgradeLock(lockPath, 'second-plan'),
    ])
    const winners = attempts.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireV02UpgradeLock>>> =>
        result.status === 'fulfilled',
    )
    const losers = attempts.filter((result) => result.status === 'rejected')
    assert.equal(winners.length, 1)
    assert.equal(losers.length, 1)
    await winners[0].value.release()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
