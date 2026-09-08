import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { acquireLinkLock } from '../src/infra/link-lock.ts'
test('failed release is visible and the same process can finish its exact release after disk recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-lock-release-'))
  try {
    const release = await acquireLinkLock(join(root, 'workflow.json'))
    await chmod(root, 0o500)
    await assert.rejects(release(), /EACCES|permission/)
    await chmod(root, 0o700)
    const next = await acquireLinkLock(join(root, 'workflow.json'), 50)
    await next()
  } finally {
    await chmod(root, 0o700)
    await rm(root, { recursive: true, force: true })
  }
})
