import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
const exec = promisify(execFile)
const runner = resolve('scripts/upgrade-recovery-1.mjs')
test('runner refuses an apply without a host-stop declaration and never creates live state', async () => {
  const home = await mkdtemp(join(tmpdir(), 'clickvibe-recovery-cli-'))
  try {
    const plan = join(home, 'plan.json')
    await writeFile(plan, '{}')
    await assert.rejects(
      exec(process.execPath, [runner, 'apply', '--plan', plan, '--fingerprint', 'not-authorized'], {
        env: { ...process.env, HOME: home },
      }),
      (error: unknown) => {
        assert.match(String((error as { stderr: string }).stderr), /host-stopped|declaration/)
        return true
      },
    )
    assert.deepEqual(await readdir(home), ['plan.json'])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('operator CLI previews privately, checks the echo, applies and rolls back an unused temporary home', async () => {
  const { v02Home } = await import('./helpers/v02-home.ts')
  const { loadConfigFromHome } = await import('../src/infra/runtime.ts')
  const { home } = await v02Home([])
  const planPath = join(home, 'plan.json')
  const env = { ...process.env, HOME: home }
  try {
    const preview = await exec(process.execPath, [runner, 'preview', '--plan', planPath, '--home', home], { env })
    const summary = JSON.parse(preview.stdout)
    assert.equal(summary.phase, 'previewed')
    assert.equal(summary.target, join(home, '.clickvibe', 'state-recovery-1'))
    assert.equal(summary.sourceConfig, undefined)
    const declaration = ['--host-stopped', 'host-stopped-and-restart-disabled']
    await assert.rejects(
      exec(process.execPath, [runner, 'apply', '--plan', planPath, '--fingerprint', 'wrong', ...declaration], { env }),
    )
    await assert.rejects(
      import('node:fs/promises').then(({ readFile }) =>
        readFile(join(home, '.clickvibe', 'recovery-authorization.log')),
      ),
      /ENOENT/,
    )
    const applied = await exec(
      process.execPath,
      [runner, 'apply', '--plan', planPath, '--fingerprint', summary.fingerprint, ...declaration],
      { env },
    )
    assert.equal(JSON.parse(applied.stdout).phase, 'verified')
    assert.equal((await loadConfigFromHome(home)).schemaVersion, 2)
    const rolled = await exec(
      process.execPath,
      [runner, 'rollback', '--plan', planPath, '--fingerprint', summary.fingerprint, ...declaration],
      { env },
    )
    assert.equal(JSON.parse(rolled.stdout).phase, 'rolled-back')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
